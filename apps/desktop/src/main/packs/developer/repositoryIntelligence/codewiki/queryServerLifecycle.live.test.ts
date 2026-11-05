import { execFileSync } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentProvider } from "@eo/core";
import { afterEach, describe, expect, it } from "vitest";
import { createClaudeProvider } from "../../../../providers/claude.js";
import { createCodexProvider } from "../../../../providers/codex.js";
import { runtimeRoot } from "../../../../runtimes/install.js";
import { RUNTIMES } from "../../../../runtimes/catalog.js";
import { resolveRuntime } from "../../../../runtimes/resolve.js";
import { CLAUDE_SDK, resolvePackageSet } from "../../../../runtimes/packages.js";
import { initRepo, run } from "../../../../testing/git.js";
import type { ResolveOptions } from "../binary/resolve.js";
import type { RepositoryIndexQueryServer } from "../port.js";
import { createCodeWikiProvider } from "./provider.js";
import { codeWikiExecutable } from "./run.js";

/**
 * Does a cancelled run leave the *real* query server running (EO-343)?
 *
 * `providers/repositoryServerLifecycle.live.test.ts` asks whether a
 * backend CLI ends the MCP servers it started, with a stand-in that
 * ignores stdin EOF on purpose — and at codex-cli 0.155.1 the answer on
 * a cancel is no (EO-342). That is the right question about the CLI and
 * the wrong one about EO, whose server is `codewiki serve --mcp`. This
 * file asks EO's question: the server `getAgentMcpConfig` hands out, for
 * a checkout that was really indexed, delivered to a real backend, the
 * turn cancelled mid-flight the way EO cancels one — by aborting the
 * signal — and the process table read afterwards.
 *
 * **The server is delivered bare, which is the harder case.** Production
 * wraps it in `mcp/superviseStdioServer.mjs` (`agentServer.ts`,
 * `supervised`), EO's own process that ends the server when its stdin
 * closes. Leaving the wrapper out means nothing of EO's is in the way:
 * whatever ends the server here is the server itself, reading EOF once
 * the CLI that held its pipe is gone. That is the guarantee
 * `serveExitsOnEof.test.ts` pins for free on every bump of the binary;
 * this is where it is watched happening under the real backends.
 *
 * **The server is identified by its own command line.** The checkout is
 * a fresh `mkdtemp` directory and appears in the server's `--path`
 * argument, so a `ps` line naming `serve --mcp --path <checkout>` is this
 * run's server and nobody else's. Nothing here asks the CLI for a pid it
 * does not report.
 *
 * **Two backends, because invariant 12 says so.** The query server
 * reaches Claude agents too, so the same check runs against both.
 *
 * - Codex spends real credit — one short turn — and needs `codex login`:
 *
 *       EO_LIVE_CODEX=1 EO_CODEWIKI_ROOT=<userData>/repositoryIntelligence \
 *         pnpm exec vitest run --root apps/desktop \
 *         src/main/packs/developer/repositoryIntelligence/codewiki/queryServerLifecycle.live.test.ts
 *
 * - Claude spends nothing. `toolLoading.live.test.ts`'s recipe: the real
 *   CLI with EO's real options, pointed by `ANTHROPIC_BASE_URL` at a local
 *   server that answers the first request with the start of a stream and
 *   then holds it open, so the turn is mid-flight for as long as this
 *   file wants. It needs the managed runtimes on disk, which is why it
 *   has its own switch:
 *
 *       EO_LIVE_CLAUDE_WIRE=1 EO_CODEWIKI_ROOT=<userData>/repositoryIntelligence \
 *         pnpm exec vitest run --root apps/desktop \
 *         src/main/packs/developer/repositoryIntelligence/codewiki/queryServerLifecycle.live.test.ts
 *
 * Either case is skipped with the reason when there is no binary to
 * resolve (`EO_CODEWIKI_BIN` or `EO_CODEWIKI_ROOT`, as everywhere else in
 * this directory), and on Windows, which has no `ps` to read.
 *
 * **What it measured at codex-cli 0.155.1, claude 0.3.280 and codewiki
 * 0.2.1** is recorded on EO-343. Each case prints the time the server
 * took to go, so a later run can be compared against it.
 */

const CODEX_OPTED_IN = process.env["EO_LIVE_CODEX"] === "1";

/** The pinned Codex binary if the caller names one, otherwise whatever is on PATH. */
const CODEX = process.env["EO_CODEX_BIN"] ?? "codex";
const CLAUDE_OPTED_IN = process.env["EO_LIVE_CLAUDE_WIRE"] === "1";

const REAL_BINARY: ResolveOptions = {
  configuredPath: process.env["EO_CODEWIKI_BIN"] ?? null,
  root: process.env["EO_CODEWIKI_ROOT"] ?? join(tmpdir(), "eo-codewiki-no-such-root"),
};

const executable = codeWikiExecutable(REAL_BINARY);
const present = executable.path !== null && existsSync(executable.path);

const SKIP_REASON: string | null =
  process.platform === "win32"
    ? "The server is found by reading `ps`, which Windows does not have."
    : present
      ? null
      : `${executable.reason ?? `nothing executable at ${executable.path ?? "the configured path"}`} Run this against one with EO_CODEWIKI_BIN=/path/to/codewiki, or against a managed install with EO_CODEWIKI_ROOT=<userData>/repositoryIntelligence.`;

/**
 * How long the server gets to go once the cancelled turn has returned.
 *
 * The same fifteen seconds `repositoryServerLifecycle.live.test.ts`
 * gives, which is generous: a server reading EOF from a dead parent
 * measured about a second under a Node parent, and a CLI is entitled to
 * a moment over its own shutdown before the pipe closes.
 */
const EXIT_BOUND_MS = 15_000;

/** How long the backend gets to start the server before the test gives up on it. */
const LAUNCH_BOUND_MS = 60_000;

let scratch: string | null = null;
let capture: Server | null = null;
const held: ServerResponse[] = [];
const restore: { key: string; value: string | undefined }[] = [];
const leftovers: number[] = [];

afterEach(() => {
  // A failed run must not become the orphan it was looking for.
  for (const pid of leftovers.splice(0)) if (alive(pid)) process.kill(pid, "SIGKILL");
  for (const response of held.splice(0)) response.destroy();
  capture?.close();
  capture = null;
  for (const { key, value } of restore.splice(0)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = null;
});

function setEnv(key: string, value: string): void {
  restore.push({ key, value: process.env[key] });
  process.env[key] = value;
}

/** Is there a process behind this pid? Signal 0 asks without delivering one. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Every running `serve --mcp` pointed at this checkout, by pid. */
function serversFor(checkout: string): number[] {
  return processesMatching((line) => line.includes(`serve --mcp --path ${checkout} `));
}

/**
 * Every Codex app-server launched for this checkout, by pid (EO-372).
 *
 * Found the way the server is: the checkout's path is on the app-server's
 * own command line, inside the `-c mcp_servers.repo.args=[…]` override
 * that names the query server — so no other app-server on the machine
 * (an editor's, say) can be mistaken for this run's.
 */
function appServersFor(checkout: string): number[] {
  return processesMatching((line) => line.includes("app-server --stdio") && line.includes(checkout));
}

function processesMatching(match: (line: string) => boolean): number[] {
  const listing = execFileSync("ps", ["-A", "-ww", "-o", "pid=,args="], { encoding: "utf8" });
  return listing
    .split("\n")
    .filter(match)
    .map((line) => Number(line.trim().split(/\s+/, 1)[0]))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

async function until<T>(boundMs: number, probe: () => T | null): Promise<T | null> {
  const deadline = Date.now() + boundMs;
  while (Date.now() < deadline) {
    const found = probe();
    if (found !== null) return found;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return probe();
}

/** A committed checkout, indexed for real, and the server `getAgentMcpConfig` hands out for it. */
async function indexedCheckout(): Promise<{ checkout: string; server: RepositoryIndexQueryServer }> {
  scratch = mkdtempSync(join(tmpdir(), "eo-query-server-life-"));
  const checkout = join(scratch, "checkout");
  await initRepo(checkout);
  mkdirSync(join(checkout, "src"), { recursive: true });
  writeFileSync(join(checkout, "src", "alpha.ts"), "export function alpha(): number {\n  return 1;\n}\n");
  await run(["add", "-A"], checkout);
  await run(["commit", "-m", "the fixture"], checkout);

  const provider = createCodeWikiProvider({ binary: REAL_BINARY, timeoutMs: 60_000 });
  const target = { workspaceId: "eo-343-workspace", itemId: "eo-343-item", workspacePath: checkout };
  const build = await provider.initialize(target);
  if (!build.ok) throw new Error(`the fixture could not be indexed: ${build.reason}`);
  // Null without an index, which is why the build above is not optional.
  const server = await provider.getAgentMcpConfig(target);
  if (server === null) throw new Error("an indexed checkout was handed no query server");
  return { checkout, server };
}

/**
 * Starts a turn, cancels it once the server is up and `midTurn` says the
 * turn is under way, and answers how long the server took to go — or
 * null if it was still there at the bound.
 */
async function cancelAndWatch(
  provider: AgentProvider,
  checkout: string,
  server: RepositoryIndexQueryServer,
  context: string,
  midTurn: () => Promise<void>,
): Promise<{ pid: number; goneAfterMs: number | null }> {
  const controller = new AbortController();
  const stream = provider.start({
    instructions: "You are a test fixture.",
    context,
    cwd: checkout,
    repositoryMcp: server,
    signal: controller.signal,
  });
  let over = false;
  const drained = (async () => {
    try {
      for await (const _event of stream) void _event;
    } catch {
      // A cancelled turn ends by throwing an AbortError. The run being
      // over is the subject here, not how it reported that.
    }
    over = true;
  })();

  const pids = await until(LAUNCH_BOUND_MS, () => {
    const found = serversFor(checkout);
    return found.length > 0 ? found : null;
  });
  expect(pids, "the backend never launched the query server").not.toBeNull();
  const pid = (pids as number[])[0] as number;
  leftovers.push(pid);
  expect(pids, "one server per checkout").toHaveLength(1);

  await midTurn();
  // Both, because either would make the rest pass for the wrong reason:
  // a turn that had already finished ends its servers the ordinary way,
  // and a server already gone is trivially not an orphan.
  expect(over, "the turn finished before the cancel could land").toBe(false);
  expect(alive(pid), "the query server was already gone before the cancel").toBe(true);

  // What EO does on a cancel, and the whole of what it does.
  controller.abort();
  await drained;

  const start = Date.now();
  const gone = await until(EXIT_BOUND_MS, () => (alive(pid) ? null : Date.now() - start));
  return { pid, goneAfterMs: gone };
}

describe.skipIf(!CODEX_OPTED_IN)("Codex, cancelled mid-turn, with the real query server", () => {
  it(
    "leaves no `serve --mcp` process running",
    { timeout: 240_000 },
    async (ctx) => {
      if (SKIP_REASON !== null) ctx.skip(SKIP_REASON);
      const { checkout, server } = await indexedCheckout();
      const provider = createCodexProvider({ executablePath: CODEX });
      let backends: number[] = [];

      const { pid, goneAfterMs } = await cancelAndWatch(
        provider,
        checkout,
        server,
        // Long enough to still be running when the cancel lands.
        "Count slowly from one to two hundred, one number per line.",
        // Codex starts its MCP servers before the model is asked
        // anything, so a server on the process table is already a turn
        // under way; the pause is for it to finish the handshake.
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 2_000));
          backends = appServersFor(checkout);
          leftovers.push(...backends);
        },
      );

      // And the backend itself (EO-372): the app-server is EO's own child
      // now, and EO ends it on a cancel rather than leaving it to anyone.
      expect(backends, "no Codex app-server was found for this checkout mid-turn").toHaveLength(1);
      const backendGone = await until(EXIT_BOUND_MS, () => (appServersFor(checkout).length === 0 ? true : null));
      expect(backendGone, `the Codex app-server (pid ${backends.join(", ")}) outlived its cancelled run`).toBe(true);

      console.info(`[EO-343] codex: query server pid ${pid} ${goneAfterMs === null ? `still running ${EXIT_BOUND_MS} ms after the cancelled turn returned` : `gone ${goneAfterMs} ms after the cancelled turn returned`}`);
      expect(goneAfterMs, `the query server (pid ${pid}) outlived a cancelled Codex run by more than ${EXIT_BOUND_MS} ms`).not.toBeNull();
    },
  );
});

describe.skipIf(!CLAUDE_OPTED_IN)("Claude, cancelled mid-turn, with the real query server", () => {
  it(
    "leaves no `serve --mcp` process running",
    { timeout: 240_000 },
    async (ctx) => {
      if (SKIP_REASON !== null) ctx.skip(SKIP_REASON);
      const root = runtimeRoot(join(homedir(), ".config", "EO"));
      const executablePath = resolveRuntime({ spec: RUNTIMES.claude, root }).path;
      const sdkEntryPath = resolvePackageSet(root, CLAUDE_SDK);
      expect(executablePath, "the managed claude runtime must be installed").not.toBeNull();
      expect(sdkEntryPath, "the managed Claude Agent SDK must be installed").not.toBeNull();

      const { checkout, server } = await indexedCheckout();

      // The turn: every request to the model gets the head of a stream
      // and then nothing, so the CLI is waiting on an answer that never
      // comes — mid-turn, for as long as this test likes.
      let asked: () => void = () => {};
      const firstRequest = new Promise<void>((resolve) => (asked = resolve));
      capture = createServer((request: IncomingMessage, response: ServerResponse) => {
        request.resume();
        request.on("end", () => {
          if (request.url?.includes("/v1/messages") !== true) {
            response.writeHead(200, { "content-type": "application/json" });
            response.end("{}");
            return;
          }
          const message = { id: "msg_hold", type: "message", role: "assistant", model: "hold", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
          response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
          response.write(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message })}\n\n`);
          held.push(response);
          asked();
        });
      });
      await new Promise<void>((resolve) => capture?.listen(0, "127.0.0.1", resolve));
      const { port } = capture.address() as { port: number };

      setEnv("ANTHROPIC_BASE_URL", `http://127.0.0.1:${port}`);
      setEnv("ANTHROPIC_API_KEY", "sk-ant-capture-not-a-real-key");
      setEnv("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1");

      const provider = createClaudeProvider({ sdkEntryPath, executablePath });

      const { pid, goneAfterMs } = await cancelAndWatch(provider, checkout, server, "Say ok.", async () => {
        // The CLI connects its servers before it builds the request, so
        // a request arriving means the server was up and the turn is
        // waiting on the model.
        const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), LAUNCH_BOUND_MS));
        expect(await Promise.race([firstRequest.then(() => "asked" as const), timeout]), "the CLI never asked the model anything").toBe("asked");
      });

      console.info(`[EO-343] claude: query server pid ${pid} ${goneAfterMs === null ? `still running ${EXIT_BOUND_MS} ms after the cancelled turn returned` : `gone ${goneAfterMs} ms after the cancelled turn returned`}`);
      expect(goneAfterMs, `the query server (pid ${pid}) outlived a cancelled Claude run by more than ${EXIT_BOUND_MS} ms`).not.toBeNull();
    },
  );
});
