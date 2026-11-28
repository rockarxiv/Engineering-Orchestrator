import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentSandbox } from "@eo/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RUNTIMES } from "../runtimes/catalog.js";
import { runtimeRoot } from "../runtimes/install.js";
import { resolveRuntime } from "../runtimes/resolve.js";
import { agentSandboxFor } from "../supervisor/agentSandbox.js";
import { codexClientOptions, createCodexProvider } from "./codex.js";
import { CodexClient } from "./codexClient.js";
import { personCodexHome } from "./codexHome.js";

/**
 * What a sandboxed Codex agent's commands really get in their
 * environment, when a Codex configuration EO does not write sets
 * variables for them (EO-934 review).
 *
 * An agent that uses the person's own Codex setup (`inheritAmbientConfig`)
 * runs in their Codex home, whose `config.toml` can carry a
 * `[shell_environment_policy]` with a `set` table. Codex lays that over
 * every command's environment after EO has built the app-server's, so
 * withholding `GH_TOKEN` from the app-server did not keep it from the
 * command, and a `GH_CONFIG_DIR` there moved the `gh` config out of what
 * the sandbox hides. EO now reads the effective table from the turn's own
 * app-server (`config/read`) before any thread opens, and refuses the
 * turn where it sets a withheld name or moves a credential location out
 * of what is hidden (`codexSandboxConfigProblem`).
 *
 * Read off what a command printed, not off the launch: a local server
 * stands in for the model (no credit) and has code mode's `exec` run one
 * `exec_command`, inside the sandbox, and its output is the one the
 * app-server reports for that command. An unsandboxed turn with the same configuration is the
 * control: the table still applies there, as it always did.
 *
 * **Established on Linux (bubblewrap 0.13.1) against Codex 0.171.0, on
 * 2026-11-28.** A `-c shell_environment_policy.set={}` override merges
 * into the file's table rather than replacing it, so overriding is no
 * defence; `config/read` answers the merged table, overrides included;
 * and a profile cannot carry one (`profiles.<name>.shell_environment_policy`
 * is an unknown field under `--strict-config`). Re-run on every bump of
 * the Codex pin:
 *
 *     EO_LIVE_CODEX=1 pnpm exec vitest run --root apps/desktop \
 *       src/main/providers/codexSandboxEnvironment.live.test.ts
 *
 * Opt-in because it runs the real CLI; it spends no credit. Runs EO's
 * Codex at its pin (`RUNTIMES.codex`), or `EO_CODEX_BIN`.
 */
const OPTED_IN = process.env["EO_LIVE_CODEX"] === "1";
const TOKEN = "SYNTHETIC_POLICY_TOKEN";
const MOVED = "/alternate-policy-gh";

function pinnedCodex(): string {
  const named = process.env["EO_CODEX_BIN"];
  if (named) return named;
  const root = process.env["EO_RUNTIME_ROOT"] ?? runtimeRoot(join(homedir(), ".config", "EO"));
  const path = resolveRuntime({ spec: RUNTIMES.codex, root }).path;
  if (path === null) throw new Error(`Codex is not installed at EO's pin (codex@${RUNTIMES.codex.version}) under ${root}; name one with EO_CODEX_BIN.`);
  return path;
}

const cleanup: string[] = [];
let server: Server | null = null;

afterEach(() => {
  vi.unstubAllEnvs();
  server?.close();
  server = null;
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

/** A model that has code mode run one command printing the variables, then ends the turn. Every request body is kept. */
async function scriptedModel(): Promise<{ port: number; bodies: string[] }> {
  const bodies: string[] = [];
  let calls = 0;
  const command = `printf 'TOKEN=[%s] CONFIG=[%s] KEPT=[%s]' "$GH_TOKEN" "$GH_CONFIG_DIR" "$EO934_KEPT"`;
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
        ? { type: "custom_tool_call", id: `ctc_${String(calls)}`, call_id: `call_${String(calls)}`, name: "exec", input: `const r = await tools.exec_command({ cmd: ${JSON.stringify(command)} });\ntext(JSON.stringify(r));` }
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

/** The person's own Codex home, its `config.toml` setting `set` for every command, and a checkout to work in. */
function personSetup(set: string): { home: string; cwd: string } {
  const root = realpathSync(mkdtempSync(join(homedir(), ".eo934-policy-")));
  cleanup.push(root);
  const home = join(root, "codex-home");
  mkdirSync(join(home, "sessions"), { recursive: true });
  writeFileSync(join(home, "config.toml"), `[shell_environment_policy]\nset = { ${set} }\n`);
  const cache = join(personCodexHome(), "models_cache.json");
  if (existsSync(cache)) copyFileSync(cache, join(home, "models_cache.json"));
  const cwd = join(root, "checkout");
  mkdirSync(cwd);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd, stdio: "pipe", windowsHide: true });
  return { home, cwd };
}

const EVERYTHING = `GH_TOKEN = "${TOKEN}", GH_CONFIG_DIR = "${MOVED}", EO934_KEPT = "kept"`;

/** One turn on the person's own setup, sandboxed or not: what its command printed, or why EO refused it, and every request the model got. */
async function printed(sandbox: AgentSandbox | undefined, set: string): Promise<{ output: string | null; refused: string | null; events: AgentEvent[]; requests: number }> {
  const { home, cwd } = personSetup(set);
  // The person's own home, as an agent using their setup finds it.
  vi.stubEnv("CODEX_HOME", home);
  const model = await scriptedModel();
  const options = { executablePath: pinnedCodex(), config: { inheritAmbientConfig: true } };
  const provider = createCodexProvider({
    ...options,
    createCodex: (...args) => {
      const built = codexClientOptions(options, ...args);
      return new CodexClient({
        ...built,
        config: {
          ...built.config,
          model_provider: "capture",
          model_providers: { capture: { name: "capture", base_url: `http://127.0.0.1:${String(model.port)}/v1`, wire_api: "responses", request_max_retries: 0, stream_max_retries: 0 } },
        },
      });
    },
  });
  const events: AgentEvent[] = [];
  const opts = { instructions: "You are a probe.", context: "Run the command.", cwd, signal: new AbortController().signal, ...(sandbox ? { sandbox: { ...sandbox, writable: [cwd] } } : {}) };
  let refused: string | null = null;
  try {
    for await (const event of provider.start(opts)) events.push(event);
  } catch (error) {
    refused = error instanceof Error ? error.message : String(error);
  }
  // What the command printed, as the app-server reported its completed
  // `commandExecution`; null where no command ran.
  const ran = events.find((event): event is Extract<AgentEvent, { type: "tool_result" }> => event.type === "tool_result" && event.name === "command_execution");
  return { output: ran?.output ?? null, refused, events, requests: model.bodies.length };
}

describe.skipIf(!OPTED_IN)("a sandboxed Codex agent's command environment, on the person's own setup (live, no credit)", () => {
  it("is what the person's config.toml sets for commands, on an unsandboxed turn as it always was", { timeout: 240_000 }, async () => {
    const open = await printed(undefined, EVERYTHING);
    expect(open.output, JSON.stringify(open.events).slice(0, 2000)).toBe(`TOKEN=[${TOKEN}] CONFIG=[${MOVED}] KEPT=[kept]`);
  });

  it("refuses a sandboxed turn whose configuration hands its commands a withheld name, before the model or any command is asked", { timeout: 240_000 }, async () => {
    const turn = await printed(agentSandboxFor([]), EVERYTHING);
    expect(turn.refused, JSON.stringify(turn.events).slice(0, 2000)).toContain("Codex's configuration sets GH_TOKEN for every command");
    expect(turn.refused).not.toContain(TOKEN);
    expect(turn.output).toBeNull();
    expect(turn.requests).toBe(0);
  });

  it("refuses one whose configuration moves the gh config out of what the sandbox hides", { timeout: 240_000 }, async () => {
    const turn = await printed(agentSandboxFor([]), `GH_CONFIG_DIR = "${MOVED}"`);
    expect(turn.refused, JSON.stringify(turn.events).slice(0, 2000)).toContain(`${MOVED}/hosts.yml`);
    expect(turn.output).toBeNull();
    expect(turn.requests).toBe(0);
  });

  it("runs one whose configuration sets nothing it guards, and its command sees that and no token", { timeout: 240_000 }, async () => {
    vi.stubEnv("GH_TOKEN", TOKEN);
    const turn = await printed(agentSandboxFor([]), `EO934_KEPT = "kept"`);
    expect(turn.refused, JSON.stringify(turn.events).slice(0, 2000)).toBeNull();
    expect(turn.output).toBe("TOKEN=[] CONFIG=[] KEPT=[kept]");
  });
});
