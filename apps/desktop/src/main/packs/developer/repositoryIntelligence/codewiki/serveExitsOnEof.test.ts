import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ResolveOptions } from "../binary/resolve.js";
import type { RepositoryIndexQueryServer } from "../port.js";
import { createCodeWikiProvider } from "./provider.js";
import { codeWikiExecutable } from "./run.js";
import { initRepo, run } from "../../../../testing/git.js";

/**
 * The guarantee a cancelled run's query server rests on: the pinned
 * binary's `serve --mcp` exits when its stdin closes (EO-343).
 *
 * **Why this is the guarantee, rather than the backend's cleanup.** EO
 * never spawns the query server. It hands `getAgentMcpConfig`'s command
 * line to the agent's CLI, and the CLI spawns it over stdio pipes. When
 * a run is cancelled EO aborts the turn's signal and the SDK sends the
 * CLI SIGTERM — and from codex-cli 0.155.1 on, a SIGTERM'd CLI no longer
 * ends the MCP servers it started (EO-342). What still ends the server is
 * the kernel: the CLI's death closes the write end of the server's stdin,
 * the server reads EOF, and it exits.
 * `providers/repositoryServerLifecycle.live.test.ts` and
 * `queryServerLifecycle.live.test.ts` beside this one observe that
 * through the real backends, and spend credit or need managed runtimes
 * to do it. This file checks the half that belongs to the pinned binary,
 * on every machine that has it, for free — because codewiki is a
 * third-party binary EO pins, and a version bump that stopped exiting on
 * EOF would bring the leak back with nothing else noticing.
 *
 * **The stand-in parent plays the CLI, and only the CLI.** It is a Node
 * process that starts the server exactly as a backend would — the
 * command, arguments and environment `getAgentMcpConfig` returned, taken
 * verbatim, with stdin, stdout and stderr as pipes — completes the MCP
 * handshake so the server is in its ordinary serving loop, and then does
 * nothing. It installs no signal handler and never ends its child, so
 * when it is SIGTERM'd it dies the way a CLI that does not clean up
 * dies, and whatever ends the server afterwards is the server's own
 * doing.
 *
 * **The handshake is not decoration.** Measured against codewiki 0.2.1:
 * a server that sees EOF *before* `notifications/initialized` exits with
 * "expect initialize notification", which is a different code path from
 * the one a mid-turn cancel reaches. Only a server that has answered
 * `initialize` and been told the client is ready is in the state a
 * running agent leaves it in.
 *
 * **Not a second invocation site** in the sense `importSites.test.ts`
 * guards. This file composes no argument list and resolves no path to
 * spawn: the command line is the provider's, handed out the way it is
 * handed to Claude and Codex, and the process that runs it stands in for
 * their CLIs. Where the binary lives is asked of `codeWikiExecutable`
 * only to say why the test did not run.
 *
 * Skipped rather than failed when the binary is absent, for the reason
 * `version.test.ts` gives: `pnpm test` must not require a 46 MB download
 * and CI must not reach the network. Run it against one with
 *
 *     EO_CODEWIKI_BIN=/path/to/codewiki pnpm exec vitest run --root apps/desktop \
 *       src/main/packs/developer/repositoryIntelligence/codewiki/serveExitsOnEof.test.ts
 *
 * or against a managed install with `EO_CODEWIKI_ROOT=<userData>/repositoryIntelligence`.
 */

const REAL_BINARY: ResolveOptions = {
  configuredPath: process.env["EO_CODEWIKI_BIN"] ?? null,
  // Somewhere that reliably holds nothing, so an unset environment
  // resolves absent instead of picking up a stray directory.
  root: process.env["EO_CODEWIKI_ROOT"] ?? join(tmpdir(), "eo-codewiki-no-such-root"),
};

const executable = codeWikiExecutable(REAL_BINARY);
const present = executable.path !== null && existsSync(executable.path);

const SKIP_REASON: string | null = present
  ? null
  : `${executable.reason ?? `nothing executable at ${executable.path ?? "the configured path"}`} Run this against one with EO_CODEWIKI_BIN=/path/to/codewiki, or against a managed install with EO_CODEWIKI_ROOT=<userData>/repositoryIntelligence.`;

/**
 * How long the server gets to go after its parent does.
 *
 * Measured at about one second after SIGTERM to the parent on
 * 2026-09-23, and well under that on the run that wrote this. Ten is
 * room for a slow machine without being so loose that a server which
 * merely happened to exit eventually would pass.
 */
const EXIT_BOUND_MS = 10_000;

/** How long the stand-in gets to start the server and finish the handshake. */
const READY_BOUND_MS = 30_000;

/**
 * The stand-in for an agent CLI.
 *
 * Reads its child's command line from argv as JSON so nothing is
 * re-quoted on the way. Prints `ready <pid>` once the server has answered
 * `initialize` and been sent `notifications/initialized`, and `failed
 * <why>` if it could not get that far. After that it keeps the pipes open
 * and does nothing at all — no signal handler, no cleanup — so its death
 * is the only thing that happens to the server.
 */
const STAND_IN_PARENT = `import { spawn } from "node:child_process";
const server = JSON.parse(process.argv[2]);
const child = spawn(server.command, server.args, {
  cwd: server.cwd,
  env: { ...process.env, ...server.env },
  stdio: ["pipe", "pipe", "pipe"],
});
child.stderr.resume();
child.on("error", (error) => process.stdout.write("failed " + error.message + "\\n"));
child.on("exit", (code) => process.stdout.write("failed exited " + code + "\\n"));
let buffered = "";
let ready = false;
child.stdout.on("data", (chunk) => {
  if (ready) return;
  buffered += chunk.toString();
  if (!buffered.includes("\\n")) return;
  ready = true;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\\n");
  process.stdout.write("ready " + child.pid + "\\n");
});
child.stdin.write(
  JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "eo-stand-in", version: "0" } },
  }) + "\\n",
);
setInterval(() => {}, 1000);
`;

let scratch: string | null = null;
const started: ChildProcess[] = [];
const servers: number[] = [];

afterEach(() => {
  // A failing run must not become the leak it was looking for.
  for (const pid of servers.splice(0)) if (alive(pid)) process.kill(pid, "SIGKILL");
  for (const child of started.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = null;
});

/** Is there a process behind this pid? Signal 0 asks without delivering one. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Milliseconds until the pid went, or null if it was still there at the bound. */
async function goneAfter(pid: number, boundMs: number): Promise<number | null> {
  const start = Date.now();
  while (Date.now() - start < boundMs) {
    if (!alive(pid)) return Date.now() - start;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return alive(pid) ? null : Date.now() - start;
}

/** A committed checkout with something in it to index, and the server `getAgentMcpConfig` hands out for it. */
async function indexedCheckout(): Promise<{ workspace: string; server: RepositoryIndexQueryServer }> {
  scratch = mkdtempSync(join(tmpdir(), "eo-serve-eof-"));
  const workspace = join(scratch, "checkout");
  await initRepo(workspace);
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(join(workspace, "src", "alpha.ts"), "export function alpha(): number {\n  return 1;\n}\n");
  await run(["add", "-A"], workspace);
  await run(["commit", "-m", "the fixture"], workspace);

  const provider = createCodeWikiProvider({ binary: REAL_BINARY, timeoutMs: 60_000 });
  const target = { workspaceId: "eo-343-workspace", itemId: "eo-343-item", workspacePath: workspace };
  const build = await provider.initialize(target);
  if (!build.ok) throw new Error(`the fixture could not be indexed: ${build.reason}`);
  const server = await provider.getAgentMcpConfig(target);
  if (server === null) throw new Error("an indexed checkout was handed no query server");
  return { workspace, server };
}

/** Starts the stand-in and resolves with the server's pid once the handshake is done. */
function startUnderStandIn(workspace: string, server: RepositoryIndexQueryServer): Promise<{ parent: ChildProcess; serverPid: number }> {
  const script = join(scratch ?? workspace, "stand-in-parent.mjs");
  writeFileSync(script, STAND_IN_PARENT);
  const parent = spawn(process.execPath, [script, JSON.stringify({ command: server.command, args: server.args, env: server.env, cwd: workspace })], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  started.push(parent);
  parent.stderr?.resume();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the stand-in never reported a ready server")), READY_BOUND_MS);
    let buffered = "";
    parent.stdout?.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      const line = buffered.split("\n").find((candidate) => candidate.startsWith("ready ") || candidate.startsWith("failed "));
      if (line === undefined) return;
      clearTimeout(timer);
      if (line.startsWith("failed ")) reject(new Error(`the server did not come up under the stand-in: ${line}`));
      else resolve({ parent, serverPid: Number(line.slice("ready ".length)) });
    });
  });
}

describe("the pinned query server, under a parent that dies without cleaning up", () => {
  it(
    "exits on its own once a SIGTERM'd parent's pipes close",
    { timeout: 120_000 },
    async (ctx) => {
      if (SKIP_REASON !== null) ctx.skip(SKIP_REASON);

      const { workspace, server } = await indexedCheckout();
      // The command line a backend would have been handed, checked
      // rather than assumed: this is a test of `serve --mcp`, not of
      // whatever the provider happens to return one day.
      expect(server.args.slice(0, 2)).toEqual(["serve", "--mcp"]);

      const { parent, serverPid } = await startUnderStandIn(workspace, server);
      servers.push(serverPid);
      expect(alive(serverPid), "the server was gone before its parent was ended").toBe(true);

      const parentGone = new Promise<void>((resolve) => parent.once("exit", () => resolve()));
      parent.kill("SIGTERM");
      await parentGone;

      const elapsed = await goneAfter(serverPid, EXIT_BOUND_MS);
      expect(elapsed, `the query server (pid ${serverPid}) outlived its parent by more than ${EXIT_BOUND_MS} ms`).not.toBeNull();
    },
  );
});
