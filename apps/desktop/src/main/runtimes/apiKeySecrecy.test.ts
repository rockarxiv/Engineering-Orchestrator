import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent, Uuid } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { createRunEventBuffer, listAgents, listRunEvents, postComment } from "../db/repos/index.js";
import { createRun } from "../db/repos/runsRepo.js";
import type { SecretStore } from "../secrets/store.js";
import { createClaudeProvider } from "../providers/claude.js";
import { removeRuntimeApiKey, runtimeStatusWithAuth, signInWithRuntimeApiKey, type RuntimeContext } from "../ipc/runtimeCommands.js";
import { checkRuntimeAuth, invalidateRuntimeAuth, type AuthProbeRunner } from "./auth.js";
import { readApiKey } from "./apiKey.js";
import { signInWithApiKey, type SignInProcess, type SignInSpawner } from "./signIn.js";

/**
 * The key goes to the child's environment and nowhere else (EO-84).
 *
 * This is the acceptance criterion that says "asserted by a test, not by
 * inspection", and it is the one worth having: a Claude API key is the
 * single billable secret EO holds, and the ways it could escape are all
 * ordinary, useful code paths — a status crossing IPC, an event
 * persisted to `run_events`, a comment written on an item, a
 * `console.log` while somebody was debugging something else.
 *
 * So the whole journey runs here — store, report, preflight, spawn,
 * persist, comment — with every console method spied on and every table
 * in the database read back afterwards. The key is a distinctive string,
 * and the assertion is that it appears in none of them.
 *
 * The Codex half is here too, for the opposite reason: EO must be able
 * to show that it *kept* nothing. Its key is piped to a CLI that stores
 * it, and a hostile fake is used — one that echoes stdin back — because
 * "the real CLI does not echo" is not something EO can assert about
 * somebody else's binary.
 */
const CLAUDE_KEY = "sk-ant-api03-SECRETVALUEDONOTPERSIST";
const CODEX_KEY = "sk-codex-SECRETVALUEDONOTPERSIST";

let scratch: string;
let handle: DbHandle;
let context: RuntimeContext;
let logged: string[];

function keychain(): SecretStore {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => Buffer.from(`v1:${Buffer.from(plain).toString("base64")}`),
    decryptString: (encrypted) => {
      const text = encrypted.toString();
      if (!text.startsWith("v1:")) throw new Error("not encrypted by this keychain");
      return Buffer.from(text.slice(3), "base64").toString();
    },
  };
}

/** Everything written to a console, whichever method wrote it. */
function captureConsole(): string[] {
  const lines: string[] = [];
  const record = (...args: unknown[]): void => void lines.push(args.map((arg) => String(arg)).join(" "));
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation(record);
  }
  return lines;
}

/** Every row of every table, as text. What "it never reached the database" has to mean. */
function everythingStored(): string {
  const tables = handle.db.all<{ name: string }>(
    sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
  );
  return tables
    .map(({ name }) => JSON.stringify(handle.db.all(sql.raw(`SELECT * FROM "${name}"`))))
    .join("\n");
}

const init = (): SDKMessage => ({ type: "system", subtype: "init", session_id: "sess_1" }) as unknown as SDKMessage;
const said = (text: string): SDKMessage =>
  ({ type: "assistant", message: { content: [{ type: "text", text }] } }) as unknown as SDKMessage;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "eo secrecy "));
  handle = openMigratedTestDb();
  context = {
    root: join(scratch, "runtimes"),
    fetchImpl: async () => new Response("", { status: 500 }),
    db: handle.db,
    apiKeys: { directory: join(scratch, "credentials"), store: keychain() },
  };
  logged = captureConsole();
});

afterEach(() => {
  vi.restoreAllMocks();
  invalidateRuntimeAuth();
  handle.close();
  rmSync(scratch, { recursive: true, force: true });
});

describe("a Claude key EO is holding", () => {
  it("reaches the spawned CLI and nothing else — not the DB, run_events, a comment or a log", async () => {
    // 1. Stored, the way the dialog stores it.
    expect(await signInWithRuntimeApiKey(context, { provider: "claude", apiKey: CLAUDE_KEY })).toMatchObject({ ok: true, heldBy: "eo" });

    // 2. Reported, the way every card and rail renders it. This answer
    //    crosses IPC to a renderer, so it is the shortest path out.
    const status = await runtimeStatusWithAuth(context, { provider: "claude" });
    expect(status.runtime?.auth).toMatchObject({ state: "signed_in", kind: "api_key", storedKey: true });
    expect(JSON.stringify(status)).not.toContain(CLAUDE_KEY);

    // 3. The dispatch preflight, which writes its refusal as a comment
    //    when it refuses — so its reason string is a persisted one.
    const preflight = await checkRuntimeAuth({
      provider: "claude",
      agentName: "Implementer",
      executablePath: null,
      storedKey: true,
    });
    expect(preflight).toEqual({ ok: true });

    // 4. Spent: the one place it is supposed to go.
    const calls: { options: Record<string, unknown> }[] = [];
    const runQuery = ((params: { options?: Record<string, unknown> }) => {
      calls.push({ options: params.options ?? {} });
      return (async function* () {
        yield init();
        yield said("done — I used the key EO gave me");
      })();
    }) as never;

    const events: AgentEvent[] = [];
    const stream = createClaudeProvider({
      runQuery,
      enableCommentTool: false,
      apiKey: () => readApiKey(context.apiKeys!, "claude"),
    }).start({
      instructions: "You are the implementer.",
      context: "EO-84: do the thing",
      cwd: join(scratch, "wt"),
      signal: new AbortController().signal,
    });
    for await (const event of stream) events.push(event);

    expect((calls[0]?.options["env"] as Record<string, string>)["ANTHROPIC_API_KEY"]).toBe(CLAUDE_KEY);
    // Not in what the turn produced, which is what becomes run_events.
    expect(JSON.stringify(events)).not.toContain(CLAUDE_KEY);

    // 5. Persisted, through the real writers: the run's events, and a
    //    comment carrying what the agent said.
    const item = createTestItem(handle.db, { type: "story", title: "Sign in with an API key", stepId: "todo" });
    const agent = listAgents(handle.db)[0]!;
    const run = createRun(handle.db, { itemId: item.id, agentId: agent.id, action: "implement", provider: "claude" });
    const buffer = createRunEventBuffer(handle.db, { flushIntervalMs: 10_000 });
    for (const event of events) buffer.append(run.id as Uuid, event.type, event);
    buffer.flush();
    buffer.dispose();
    postComment(handle.db, {
      itemId: item.id,
      author: { type: "agent", agentId: agent.id },
      body: events.map((event) => ("text" in event ? event.text : event.type)).join("\n"),
      runId: run.id as Uuid,
    });

    expect(listRunEvents(handle.db, run.id as Uuid).length).toBeGreaterThan(0); // the assertion below means something
    expect(everythingStored()).not.toContain(CLAUDE_KEY);
    expect(everythingStored()).not.toContain("sk-ant"); // nor a truncated or prefixed version of it
    expect(logged.join("\n")).not.toContain(CLAUDE_KEY);
  });

  it("is gone from disk once it is removed", async () => {
    await signInWithRuntimeApiKey(context, { provider: "claude", apiKey: CLAUDE_KEY });

    expect(removeRuntimeApiKey(context, { provider: "claude" })).toMatchObject({ removed: true });

    expect(readApiKey(context.apiKeys!, "claude")).toBeNull();
    // With nothing stored, the question goes back to the binary — which
    // here is a stubbed probe standing in for a `claude` that says
    // nobody is signed in.
    const probe: AuthProbeRunner = async () => ({ ok: true, stdout: JSON.stringify({ loggedIn: false }), error: "", notFound: false });
    const status = await runtimeStatusWithAuth(
      { ...context, authProbe: probe },
      { provider: "claude", executablePath: join(scratch, "claude") },
    );
    expect(status.runtime?.auth).toMatchObject({ state: "signed_out", storedKey: false });
  });
});

describe("a Codex key EO only passes on", () => {
  it("is written to the child and to nothing EO owns, even when the CLI echoes it back", async () => {
    // A hostile stand-in: it prints what it was handed. The real CLI
    // does not, but EO cannot assert that about somebody else's binary,
    // and this transcript is shown on screen and crosses IPC.
    let output: (chunk: string) => void = () => {};
    const spawn: SignInSpawner = () => {
      const child: SignInProcess = {
        onOutput: (listener) => {
          output = listener;
        },
        write: (text) => output(`echoing stdin: ${text}`),
        closeStdin: () => {},
        kill: () => {},
        exit: Promise.resolve({ code: 1, signal: null, error: null }),
      };
      return child;
    };

    const result = await signInWithApiKey({ provider: "codex", executablePath: "/opt/eo/codex", apiKey: CODEX_KEY, spawn });

    expect(result.ok).toBe(false);
    expect(result.transcript).not.toContain(CODEX_KEY);
    expect(result.problem).not.toContain(CODEX_KEY);
    expect(JSON.stringify(result)).not.toContain("sk-codex");
    // And EO stored nothing of its own: a Codex key belongs to the
    // Codex CLI from the moment it is piped in.
    expect(readApiKey(context.apiKeys!, "claude")).toBeNull();
    expect(everythingStored()).not.toContain(CODEX_KEY);
    expect(logged.join("\n")).not.toContain(CODEX_KEY);
  });
});
