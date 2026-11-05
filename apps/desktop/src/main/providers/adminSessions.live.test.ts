import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ADMIN_MCP_SERVER_NAME, type Agent, type AgentEvent, type AgentProvider } from "@eo/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminDeliveryFor, adminDispatchFor, type AdminMcpDispatch } from "../agentAttachments/adminDelivery.js";
import { writeToolDirectory } from "../agentAttachments/pluginDirectory.js";
import type { DbHandle } from "../db/client.js";
import { listAgents } from "../db/repos/agentsRepo.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { createAdminMcpHost, type AdminMcpHost } from "../mcpHost/admin.js";
import { attachedServersMissing } from "../supervisor/runSupervisor.js";
import { createClaudeProvider, type ClaudeAgentConfig } from "./claude.js";
import { createCodexProvider } from "./codex.js";

/**
 * Twenty system-agent turns in a row, against the real CLIs (EO-444).
 *
 * Every system-agent turn is a fresh CLI process that opens a session on
 * EO's admin MCP host, and neither CLI was trusted to close it on exit.
 * The host caps sessions at eight and used to drop one only after thirty
 * idle minutes, so the ninth turn inside half an hour was refused at
 * initialize: the backend reported `eo_admin` as `failed`, the supervisor
 * posted "was given an MCP server that did not start", and the turn ran
 * without the admin surface.
 *
 * This drives the real adapter — `createClaudeProvider` with the Claude
 * Code binary EO manages, `createCodexProvider` with its Codex — against
 * the real admin host, delivered the way `engine.ts` delivers it: the
 * system agent out of a migrated database, `adminDeliveryFor` for the
 * generated `.mcp.json`, `adminDispatchFor` per turn for the bearer. Each
 * turn's startup report is read and judged by the supervisor's own
 * `attachedServersMissing`, which is what decides whether that note is
 * posted. And the host's open sessions are counted after every turn.
 *
 * Before any of that, one control turn per backend whose bearer is *not*
 * let go of until it is over. What the host holds then is what the CLI
 * left behind on its own — the evidence of whether that backend closes
 * its session when it exits, which is the question EO-444 left open for
 * Codex.
 *
 * **Opt-in, because it spends real credit**: twenty-one trivial turns per
 * backend. Skipped otherwise, so `pnpm test` and CI never reach it:
 *
 *     EO_LIVE_CLAUDE=1 EO_LIVE_CODEX=1 pnpm exec vitest run --root apps/desktop \
 *       src/main/providers/adminSessions.live.test.ts
 *
 * `EO_LIVE_REPORT=<file>` appends one JSON line per turn to that file.
 * `EO_CLAUDE_BIN`, `EO_CODEX_BIN` and `EO_RUNTIME_ROOT` override where the
 * binaries are found; `EO_LIVE_CLAUDE_MODEL` the model (default `haiku`).
 */

const CLAUDE_OPTED_IN = process.env["EO_LIVE_CLAUDE"] === "1";
const CODEX_OPTED_IN = process.env["EO_LIVE_CODEX"] === "1";
const REPORT = process.env["EO_LIVE_REPORT"];

const TURNS = 20;
const HALF_AN_HOUR_MS = 30 * 60 * 1000;

/** The runtimes the app dispatches with, laid out the way `runtimes/resolve.ts` lays them out. */
const RUNTIME_ROOT = process.env["EO_RUNTIME_ROOT"] ?? join(homedir(), ".config", "EO", "runtimes");

function newest(prefix: string): string {
  const chosen = readdirSync(RUNTIME_ROOT)
    .filter((name) => name.startsWith(`${prefix}@`))
    .sort()
    .at(-1);
  if (chosen === undefined) throw new Error(`No ${prefix} runtime under ${RUNTIME_ROOT}.`);
  return join(RUNTIME_ROOT, chosen);
}

const claudeBinary = () => process.env["EO_CLAUDE_BIN"] ?? join(newest("claude"), "claude");
const claudeSdk = () => join(newest("claude-sdk"), "node_modules", "@anthropic-ai", "claude-agent-sdk", "sdk.mjs");
const codexBinary = () => process.env["EO_CODEX_BIN"] ?? join(newest("codex"), "vendor", "x86_64-unknown-linux-musl", "bin", "codex");

let handle: DbHandle;
let host: AdminMcpHost;
let system: Agent;
const scratch: string[] = [];

beforeAll(async () => {
  if (!CLAUDE_OPTED_IN && !CODEX_OPTED_IN) return;
  handle = openMigratedTestDb();
  host = createAdminMcpHost({ db: handle.db, version: "0.0.0-live" });
  const status = await host.start();
  if (status.problem !== null) throw new Error(status.problem);
  const found = listAgents(handle.db).find((agent) => agent.role === "system");
  if (!found) throw new Error("the migrated database has no system agent");
  system = found;
});

afterAll(async () => {
  if (!CLAUDE_OPTED_IN && !CODEX_OPTED_IN) return;
  await host.stop();
  handle.close();
  for (const directory of scratch) rmSync(directory, { recursive: true, force: true });
});

/** A throwaway repository: Codex is happiest in one, and Claude does not mind. */
function workspace(): string {
  const directory = mkdtempSync(join(tmpdir(), "eo444-admin-sessions-"));
  scratch.push(directory);
  execFileSync("git", ["init", "-b", "main"], { cwd: directory, stdio: "pipe" });
  writeFileSync(join(directory, "README.md"), "# admin sessions\n");
  return directory;
}

const lookup = () => host.endpoint();

/** Let the closes a release starts in the background finish. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 500));

interface TurnRecord {
  backend: string;
  turn: number | "control";
  at: string;
  /** What the backend's startup report said about `eo_admin`, or null if it said nothing. */
  eoAdmin: string | null;
  /** Whether the supervisor would have posted "did not start" for this turn. */
  didNotStartNote: boolean;
  /** Sessions the admin host held once the turn was over. */
  openSessionsAfter: number;
  outcome: string;
}

function record(entry: TurnRecord): void {
  console.log(`[EO-444] ${JSON.stringify(entry)}`);
  if (REPORT) appendFileSync(REPORT, `${JSON.stringify(entry)}\n`);
}

async function drain(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

/** One turn, judged the way the supervisor judges it. */
async function turn(backend: string, label: number | "control", run: () => AsyncIterable<AgentEvent>): Promise<TurnRecord> {
  const events = await drain(run());
  await settled();
  const reports = events.flatMap((event) => (event.type === "server_status" ? [event] : []));
  const servers = reports.flatMap((report) => report.servers);
  const admin = servers.find((server) => server.name === ADMIN_MCP_SERVER_NAME || server.name.endsWith(`:${ADMIN_MCP_SERVER_NAME}`));
  // Every startup report this turn produced, as `processStream` reads
  // them: one note per report with anything missing. A turn that sent no
  // report at all would have no note — and no evidence either, which is
  // why `eoAdmin` is asserted separately.
  const noted = reports.some((report) => attachedServersMissing([ADMIN_MCP_SERVER_NAME], report.servers).length > 0);
  const result = events.find((event) => event.type === "result");
  const error = events.find((event) => event.type === "error" && event.fatal !== false);
  const entry: TurnRecord = {
    backend,
    turn: label,
    at: new Date().toISOString(),
    eoAdmin: admin?.status ?? null,
    didNotStartNote: noted,
    openSessionsAfter: host.status().openSessions,
    outcome: result ? "result" : error && error.type === "error" ? `error: ${error.message}` : "none",
  };
  record(entry);
  return entry;
}

/** `adminDispatchFor` per turn, with its release withheld until `letGo` — the state every turn was in before EO-444. */
function heldAdmin(): { admin: () => AdminMcpDispatch | null; letGo: () => void } {
  const held: (() => void)[] = [];
  return {
    admin: () => {
      const dispatch = adminDispatchFor(system, lookup);
      if (dispatch === null) return null;
      return { ...dispatch, release: () => held.push(dispatch.release) };
    },
    letGo: () => {
      for (const release of held.splice(0)) release();
    },
  };
}

const TURN = {
  instructions: "You are a test fixture. Do not call any tools.",
  context: "Reply with the single word ok.",
};

/**
 * The control, then twenty turns, against one backend.
 *
 * `provider(admin)` builds the adapter the way `engine.ts` does, with
 * the `admin` it is handed in place of `adminDispatchFor`.
 */
async function twentyTurns(backend: string, provider: (admin: () => AdminMcpDispatch | null) => AgentProvider, start: () => Parameters<AgentProvider["start"]>[0]): Promise<void> {
  expect(host.status().openSessions).toBe(0);

  // The control: is anything left behind when EO does not let go?
  const control = heldAdmin();
  const before = await turn(backend, "control", () => provider(control.admin).start(start()));
  expect(before.eoAdmin, "the control turn's eo_admin").toBe("connected");
  control.letGo();
  await settled();
  expect(host.status().openSessions, "after letting the control turn go").toBe(0);

  const adapter = provider(() => adminDispatchFor(system, lookup));
  const began = Date.now();
  const turns: TurnRecord[] = [];
  for (let index = 1; index <= TURNS; index += 1) {
    turns.push(await turn(backend, index, () => adapter.start(start())));
  }
  const elapsed = Date.now() - began;
  console.log(`[EO-444] ${backend}: ${TURNS} turns in ${Math.round(elapsed / 1000)}s; control turn left ${before.openSessionsAfter} session(s) open before it was let go`);

  expect(elapsed).toBeLessThan(HALF_AN_HOUR_MS);
  for (const entry of turns) {
    expect(entry.eoAdmin, `${backend} turn ${String(entry.turn)}: eo_admin`).toBe("connected");
    expect(entry.didNotStartNote, `${backend} turn ${String(entry.turn)}: "did not start" note`).toBe(false);
    expect(entry.openSessionsAfter, `${backend} turn ${String(entry.turn)}: sessions left open`).toBe(0);
  }
}

describe.skipIf(!CLAUDE_OPTED_IN)("twenty system-agent turns on Claude", () => {
  it(
    "each report eo_admin connected, none would post the note, and none leaves a session behind",
    async () => {
      const cwd = workspace();
      // Written once, as `prepareToolDirectory` writes it per dispatch:
      // the URL and the variable's name, never a bearer.
      const toolDirectory = join(cwd, "..", `${cwd.split("/").at(-1)}-plugin`);
      scratch.push(toolDirectory);
      const written = writeToolDirectory(toolDirectory, { servers: [], skills: [] }, adminDeliveryFor(system, lookup));
      expect(written?.serverNames).toEqual([ADMIN_MCP_SERVER_NAME]);

      const sdkEntryPath = claudeSdk();
      const executablePath = claudeBinary();
      const model = process.env["EO_LIVE_CLAUDE_MODEL"] ?? "haiku";
      await twentyTurns(
        "claude",
        (admin) =>
          createClaudeProvider({
            executablePath,
            sdkEntryPath,
            enableCommentTool: false,
            admin,
            config: { ...(system.config as ClaudeAgentConfig), model },
          }),
        () => ({ ...TURN, cwd, toolDirectory, signal: new AbortController().signal }),
      );
    },
    HALF_AN_HOUR_MS + 5 * 60 * 1000,
  );
});

describe.skipIf(!CODEX_OPTED_IN)("twenty system-agent turns on Codex", () => {
  it(
    "each report eo_admin connected, none would post the note, and none leaves a session behind",
    async () => {
      const cwd = workspace();
      const executablePath = codexBinary();
      await twentyTurns(
        "codex",
        (admin) => createCodexProvider({ executablePath, admin }),
        () => ({ ...TURN, cwd, signal: new AbortController().signal }),
      );
    },
    HALF_AN_HOUR_MS + 5 * 60 * 1000,
  );
});
