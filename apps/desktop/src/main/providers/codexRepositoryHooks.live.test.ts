import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEvent } from "@eo/core";
import { codexClientOptions, createCodexProvider } from "./codex.js";
import { AppServerConnection } from "./codexAppServer.js";
import { CodexClient, configArguments } from "./codexClient.js";
import { personCodexHome, prepareCodexHome } from "./codexHome.js";

/**
 * Whether a hook committed to the repository runs for a locked-down EO
 * Codex agent (EO-929). **It does not.**
 *
 * A Claude agent loads the project's own settings
 * (`settingSources: ["project"]`, `claude.ts`), so a hook committed in
 * `.claude/settings.json` applies to it. Codex reads a project's own
 * configuration — `.codex/config.toml` and `.codex/hooks.json` — only for
 * a folder it trusts, and nobody had shown what that comes to in the
 * home EO locks a Codex agent into (`codexHome.ts`). This turn is the
 * answer, measured on **codex-cli 0.171.0**, EO's pin:
 *
 * 1. **In a locked-down turn, none of them runs.** A repository commits
 *    `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse` and
 *    `Stop` hooks, in `.codex/config.toml` and, in a second repository,
 *    in `.codex/hooks.json`. A turn through EO's real adapter, in a home
 *    `prepareCodexHome` made, runs a shell command — it ran, its output
 *    is in the next request — and not one hook writes its marker. The
 *    app-server's own `hooks/list` for that folder, in that home, lists
 *    no hook at all: the project layer is not loaded, because the folder
 *    is not trusted, and a locked-down home trusts no folder. The home
 *    holds no `config.toml` for a trust entry to be in, and EO's clear
 *    before every turn removes any a turn wrote (`KEPT_IN_HOME`).
 * 2. **Trusting the folder is not enough either.** With the folder
 *    trusted, `hooks/list` lists every one of them — `source: "project"`,
 *    `trustStatus: "untrusted"` — and still none runs: Codex runs a hook
 *    only once a person has reviewed it, recorded as its hash under
 *    `hooks.state.<key>.trusted_hash`.
 * 3. **The control: the hooks are sound.** With the folder trusted and
 *    each hook's hash recorded as `hooks/list` reports it, all five run,
 *    from either file — `PreToolUse` and `PostToolUse` on the command
 *    the model ran through code mode's `exec`, the only route to the
 *    shell the cached models offer. So what stops them in (1) is trust,
 *    and nothing about the hooks or the turn.
 *
 * So hooks committed to the repository apply to Claude agents only. EO
 * says so beside the backend choice in the agent editor
 * (`AgentEditor.tsx`) and in ARCHITECTURE.md §12.4, and
 * `providerParity.test.ts` names it as an absence on Codex. Carrying the
 * repository's hooks into a locked-down home is out of scope (EO-925): it
 * would mean EO deciding on the person's behalf to trust a folder and
 * review its hooks, which is the very thing Codex holds back for a person.
 *
 * Whoever moves the Codex pin re-runs this; a pass that turns into a
 * failure at (1) means the notice and the absence have to go.
 *
 * **No credit is spent and no key is needed**: a server on 127.0.0.1
 * stands in for the model and scripts the one shell call, as in
 * `threadFork.live.test.ts`. Opted in, because it needs the pinned binary:
 *
 *     EO_LIVE_CODEX=1 \
 *       EO_CODEX_BIN=<userData>/runtimes/codex@<pin>-<platform>/…/codex \
 *       pnpm exec vitest run --root apps/desktop src/main/providers/codexRepositoryHooks.live.test.ts
 */
const OPTED_IN = process.env["EO_LIVE_CODEX"] === "1";
const CODEX = process.env["EO_CODEX_BIN"] ?? "codex";

/** What the scripted shell call prints, read back out of the request that follows it. */
const COMMAND_OUTPUT = "eo929-command-ran";
/** Every hook the repositories commit, one marker file each. */
const EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"] as const;

const cleanup: string[] = [];
let server: Server | null = null;

afterEach(() => {
  server?.close();
  server = null;
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

/**
 * A model that, asked to open a turn, runs one shell command through
 * code mode's `exec` — every model in Codex's cached catalogue is
 * `code_mode_only` at 0.171.0 — and otherwise ends the turn.
 */
async function scriptedModel(): Promise<{ port: number; bodies: string[] }> {
  const bodies: string[] = [];
  let calls = 0;
  server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      if (request.url?.includes("/responses") !== true) {
        response.writeHead(404).end();
        return;
      }
      const text = Buffer.concat(chunks).toString("utf8");
      bodies.push(text);
      const last = (JSON.parse(text) as { input?: { type?: string; role?: string }[] }).input?.at(-1);
      const opening = last?.type === "message" && last.role === "user";
      const id = `resp_${String(++calls)}`;
      const item = opening
        ? { type: "custom_tool_call", id: `ctc_${String(calls)}`, call_id: `call_${String(calls)}`, name: "exec", input: `const r = await tools.exec_command({ cmd: "echo ${COMMAND_OUTPUT}" });\ntext(JSON.stringify(r));` }
        : { type: "message", role: "assistant", id: `msg_${String(calls)}`, content: [{ type: "output_text", text: "done", annotations: [] }] };
      const usage = { input_tokens: 11, input_tokens_details: { cached_tokens: 0 }, output_tokens: 3, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 14 };
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const events: [string, unknown][] = [
        ["response.created", { type: "response.created", response: { id } }],
        ["response.output_item.done", { type: "response.output_item.done", output_index: 0, item }],
        ["response.completed", { type: "response.completed", response: { id, usage } }],
      ];
      for (const [event, data] of events) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return { port: typeof address === "object" && address ? address.port : 0, bodies };
}

interface Repository {
  cwd: string;
  /** The hooks whose marker is there, in `EVENTS` order. */
  fired(): string[];
  /** Removes every marker, between turns. */
  reset(): void;
}

/** A repository that commits a hook for every event in `EVENTS`, in the one file named. */
function repository(scratch: string, file: "config.toml" | "hooks.json"): Repository {
  const cwd = join(scratch, `repository-${file}`);
  const markers = join(scratch, `markers-${file}`);
  mkdirSync(join(cwd, ".codex"), { recursive: true });
  mkdirSync(markers, { recursive: true });
  const git = (...args: string[]): void => void execFileSync("git", args, { cwd, stdio: "pipe" });
  git("init", "-b", "main");
  git("config", "user.email", "eo@example.com");
  git("config", "user.name", "EO Repository Hooks");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(cwd, "README.md"), "# probe\n");
  const marker = (event: string) => join(markers, `${event}.json`);
  // A script per event, committed beside the configuration, that keeps
  // what the CLI handed it. Its marker is outside the checkout, so a
  // hook that ran leaves the worktree clean.
  const command = (event: string): string => {
    const script = join(cwd, ".codex", `record-${event}.sh`);
    writeFileSync(script, `#!/bin/sh\ncat > ${JSON.stringify(marker(event))}\n`);
    chmodSync(script, 0o755);
    return script;
  };
  const matcher = (event: string) => (event.endsWith("ToolUse") ? { matcher: "*" } : {});
  if (file === "config.toml") {
    const toml = EVENTS.map(
      (event) =>
        `[[hooks.${event}]]\n${event.endsWith("ToolUse") ? 'matcher = "*"\n' : ""}[[hooks.${event}.hooks]]\ntype = "command"\ncommand = ${JSON.stringify(command(event))}\n`,
    ).join("\n");
    writeFileSync(join(cwd, ".codex", "config.toml"), toml);
  } else {
    const hooks = Object.fromEntries(EVENTS.map((event) => [event, [{ ...matcher(event), hooks: [{ type: "command", command: command(event) }] }]]));
    writeFileSync(join(cwd, ".codex", "hooks.json"), JSON.stringify({ hooks }, null, 2));
  }
  git("add", "-A");
  git("commit", "-m", "Commit the repository's Codex hooks");
  return {
    cwd,
    fired: () => EVENTS.filter((event) => existsSync(marker(event))),
    reset: () => {
      for (const event of EVENTS) rmSync(marker(event), { force: true });
    },
  };
}

/**
 * A locked-down agent's home, made by `prepareCodexHome` exactly as a
 * dispatch makes one, linked into a stand-in for the person's own home
 * so nothing of theirs is touched. Codex's models cache is copied in —
 * a name the home keeps — so the turn runs on the model a real one would.
 */
function lockedDownHome(): string {
  const root = mkdtempSync(join(homedir(), ".eo-repository-hooks-"));
  cleanup.push(root);
  const person = join(root, "person");
  mkdirSync(person, { recursive: true });
  const prepared = prepareCodexHome({ root: join(root, "homes"), agentId: "agent-929", itemId: "item-929", personHome: person });
  if (!prepared.ok) throw new Error(`EO could not make the agent's Codex home: ${JSON.stringify(prepared)}`);
  const cache = join(personCodexHome(), "models_cache.json");
  if (existsSync(cache)) copyFileSync(cache, join(prepared.path, "models_cache.json"));
  return prepared.path;
}

interface ListedHook {
  key: string;
  source: string;
  currentHash: string;
  trustStatus: string;
}

/** The app-server's own account of the hooks it would run for `cwd`, in `home`, under `config`. */
async function hooksListed(home: string, cwd: string, config: Record<string, unknown> = {}): Promise<ListedHook[]> {
  const connection = new AppServerConnection({ executablePath: CODEX, args: configArguments(config), env: { ...(process.env as Record<string, string>), CODEX_HOME: home } });
  try {
    await connection.initialize();
    const answer = (await connection.request("hooks/list", { cwds: [cwd] })) as { data: { hooks: ListedHook[] }[] };
    return answer.data.flatMap((entry) => entry.hooks);
  } finally {
    connection.close();
  }
}

async function drain(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

/**
 * One turn through EO's real adapter, in `home`, with the model swapped
 * for the scripted one and `extra` laid over the configuration EO builds.
 * The bodies the model was sent during it come back with its events.
 */
async function turn(cwd: string, home: string, model: { port: number; bodies: string[] }, extra: Record<string, unknown> = {}): Promise<{ events: AgentEvent[]; sent: string[] }> {
  const options = { executablePath: CODEX, codexHome: () => home };
  const provider = createCodexProvider({
    ...options,
    createCodex: (...args) => {
      const built = codexClientOptions(options, ...args);
      return new CodexClient({
        ...built,
        config: {
          ...built.config,
          ...extra,
          model_provider: "capture",
          model_providers: { capture: { name: "capture", base_url: `http://127.0.0.1:${String(model.port)}/v1`, wire_api: "responses", request_max_retries: 0, stream_max_retries: 0 } },
        },
      });
    },
  });
  const before = model.bodies.length;
  const events = await drain(provider.start({ instructions: "You are a probe.", context: "Run the command.", cwd, signal: new AbortController().signal }));
  return { events, sent: model.bodies.slice(before) };
}

describe.skipIf(!OPTED_IN)("hooks committed to the repository, on a locked-down EO Codex agent (live, no credit)", () => {
  for (const file of ["config.toml", "hooks.json"] as const) {
    it(`runs none committed in .codex/${file}; the same hooks run once the folder is trusted and each hook reviewed`, { timeout: 240_000 }, async () => {
      const scratch = mkdtempSync(join(tmpdir(), "eo-repository-hooks-"));
      cleanup.push(scratch);
      const model = await scriptedModel();
      const repo = repository(scratch, file);

      // (1) Locked down, as EO dispatches it.
      const home = lockedDownHome();
      expect(await hooksListed(home, repo.cwd), "the locked-down home loaded the project's hooks").toEqual([]);
      const locked = await turn(repo.cwd, home, model);
      expect(locked.events.some((event) => event.type === "result"), JSON.stringify(locked.events)).toBe(true);
      // The command a PreToolUse hook would have fired on really ran.
      expect(locked.sent.some((body) => body.includes("custom_tool_call_output") && body.includes(COMMAND_OUTPUT)), "the scripted shell call did not run").toBe(true);
      expect(repo.fired(), "a hook committed to the repository ran in a locked-down turn").toEqual([]);

      // (2) The folder trusted, the hooks not reviewed.
      const trusted = { projects: { [repo.cwd]: { trust_level: "trusted" } } };
      const listed = await hooksListed(lockedDownHome(), repo.cwd, trusted);
      expect(listed.map((hook) => [hook.source, hook.trustStatus])).toEqual(EVENTS.map(() => ["project", "untrusted"]));
      const unreviewed = await turn(repo.cwd, lockedDownHome(), model, trusted);
      expect(unreviewed.events.some((event) => event.type === "result"), JSON.stringify(unreviewed.events)).toBe(true);
      expect(repo.fired(), "an unreviewed hook ran").toEqual([]);

      // (3) The control: trusted and reviewed, every one of them runs.
      const state = Object.fromEntries(listed.map((hook) => [hook.key, { trusted_hash: hook.currentHash }]));
      const control = await turn(repo.cwd, lockedDownHome(), model, { ...trusted, hooks: { state } });
      expect(control.events.some((event) => event.type === "result"), JSON.stringify(control.events)).toBe(true);
      expect(repo.fired()).toEqual([...EVENTS]);
    });
  }
});
