import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCodexProvider } from "./codex.js";

/**
 * Does a real Codex CLI end the MCP servers it started when the run ends
 * (EO-151, EO-342, EO-343)?
 *
 * **This is not the guarantee EO relies on, and the file used to read as
 * though it were.** EO never spawns the query server: it hands the CLI a
 * command line and the CLI starts it over stdio pipes. What ends that
 * process when a run is cancelled is **stdin EOF** — the CLI dies, the
 * kernel closes the write end of the pipe it held, and the process on the
 * other end reads end-of-file and exits. That needs nothing from the CLI
 * but its death, and two binaries provide it:
 *
 * - **EO's own supervisor**, `mcp/superviseStdioServer.mjs`, run by EO's
 *   Electron binary as Node. Production always wraps the query server in
 *   it (`packs/developer/repositoryIntelligence/agentServer.ts`,
 *   `supervised`), so it is the process the CLI actually starts. It ends
 *   the server when its own stdin closes, SIGKILL after a grace period
 *   included. `mcp/superviseStdioServer.test.ts` holds it to that with
 *   real processes.
 * - **The pinned codewiki binary** (0.2.1), whose `serve --mcp` exits on
 *   EOF by itself, wrapper or no wrapper. Pinned on every machine that
 *   has the binary by `codewiki/serveExitsOnEof.test.ts`, which needs no
 *   credit, and watched under both real CLIs — the server delivered bare
 *   through `getAgentMcpConfig`, cancelled mid-turn — by
 *   `codewiki/queryServerLifecycle.live.test.ts`. At codex-cli 0.155.1
 *   and claude 0.3.280 it was gone within about a tenth of a second of
 *   the cancelled turn returning, on every run (EO-343).
 *
 * So what this file measures — whether the CLI *itself* reaps its
 * children — is behaviour EO does not depend on. It is kept because it
 * is the record of an upstream change and costs cents to re-run.
 *
 * **The chain it observes.** Since EO-372 the CLI is `codex app-server
 * --stdio`, spawned by EO's own client (`providers/codexAppServer.ts`),
 * not detached. A cancel there closes the server's stdin and sends it
 * SIGTERM (`AppServerConnection.close`) — the same signal the SDK's
 * `spawn(…, { signal })` sent `codex exec` before it, so the rest is
 * still the CLI's own handling of its children. That the app-server
 * itself is gone after a cancel is EO's promise now, and is asserted
 * with a real child process in `providers/codexClient.test.ts`; EO's
 * half of the signal is asserted in
 * `repositoryIntelligence/agentDelivery.test.ts`.
 *
 * **What changed at 0.155.1 (EO-342).** A turn that ends *normally* still
 * reaps its servers; the first case below asserts that. A SIGTERM'd CLI
 * no longer does: a server that ignores EOF is reparented to init and
 * outlives the run. The second case records which of those the CLI in
 * front of it does, and does not fail on either answer — whichever the
 * CLI does, the real server goes, so a red result here would be a suite
 * that fails when nothing is wrong, and a live suite that always fails
 * teaches people to ignore it. What *would* be wrong — the real server
 * outliving a cancel — fails `queryServerLifecycle.live.test.ts`.
 *
 * **The stand-in.** The server here is `lingeringServer()`, a script that
 * ignores EOF by design. That is what makes it the right probe of the
 * CLI and the wrong probe of EO: a script that exited by itself would be
 * gone whatever the CLI did. It is delivered bare, without the
 * supervisor, because the supervisor would end it and hide the answer.
 *
 * **Codex only.** Whether Claude's CLI reaps a server that ignores EOF is
 * not measured anywhere. The question EO cares about — does the real
 * server outlive a cancelled Claude run — is measured, in
 * `queryServerLifecycle.live.test.ts`, and the answer is no.
 *
 * **Opt-in, because it spends real API credit on a real account.** Two
 * trivial turns, cents rather than dollars, and it needs `codex login`.
 * Skipped otherwise, so `pnpm test` and CI never reach it:
 *
 *     EO_LIVE_CODEX=1 pnpm exec vitest run --root apps/desktop \
 *       src/main/providers/repositoryServerLifecycle.live.test.ts
 *
 * Driven through `createCodexProvider`, because delivering
 * `repositoryMcp` onto the turn is part of what is being exercised.
 */

const OPTED_IN = process.env["EO_LIVE_CODEX"] === "1";

/** The pinned binary if the caller names one, otherwise whatever is on PATH. */
const CODEX = process.env["EO_CODEX_BIN"] ?? "codex";

let workspace: string | null = null;
const lingering: number[] = [];

afterEach(() => {
  // The stand-in ignores EOF by design, so nothing else will ever end one
  // the CLI left behind — and the second case below expects that to
  // happen.
  for (const pid of lingering.splice(0)) if (alive(pid)) process.kill(pid, "SIGKILL");
  if (workspace) rmSync(workspace, { recursive: true, force: true });
  workspace = null;
});

/**
 * The "query server": it never speaks MCP.
 *
 * It records its own pid and then lingers — sitting on its input with
 * nothing to say, and staying put when that input closes, which the real
 * server does not (`codewiki/serveExitsOnEof.test.ts`). Codex reports a
 * server that fails to handshake and carries on with the turn, which is
 * all this needs: the pid is on disk before that matters, and the
 * question here is about the process rather than the protocol.
 *
 * The lingering is the whole point. A script that exited on its own
 * would be "gone" after the run whatever the CLI did, which is the one
 * way this test could pass while proving nothing.
 */
function lingeringServer(directory: string, pidPath: string): string {
  const script = join(directory, "repo-server.mjs");
  writeFileSync(
    script,
    `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
process.stdin.resume();
setInterval(() => {}, 1000);
`,
  );
  return script;
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

/**
 * Wait for the pid to go, then say whether it did.
 *
 * Bounded rather than instant because a CLI is entitled to take a moment
 * over its own shutdown, and because the process may pass briefly
 * through a state its parent has not reaped yet.
 */
async function goneWithin(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !alive(pid);
}

function newWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "eo-repo-server-life-"));
  // Codex refuses to run outside a repository unless told to skip the
  // check; a real one costs nothing here and keeps the flag out of it.
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "# lifecycle\n");
  return dir;
}

function queryServer(script: string): { name: string; command: string; args: string[]; env: Record<string, string> } {
  return { name: "repo", command: process.execPath, args: [script], env: {} };
}

describe.skipIf(!OPTED_IN)("a real backend and the query server it was given", () => {
  it(
    "leaves no query server behind when the turn ends normally",
    async () => {
      workspace = newWorkspace();
      const pidPath = join(workspace, "server.pid");
      const provider = createCodexProvider({ executablePath: CODEX });

      for await (const _event of provider.start({
        instructions: "You are a test fixture.",
        context: "Reply with the single word ok.",
        cwd: workspace,
        repositoryMcp: queryServer(lingeringServer(workspace, pidPath)),
        signal: new AbortController().signal,
      })) {
        void _event;
      }

      // Launched: without this the rest passes for the wrong reason, and
      // a server that was never started is trivially not an orphan.
      expect(existsSync(pidPath), "Codex never launched the query server").toBe(true);
      const pid = Number(readFileSync(pidPath, "utf8"));
      lingering.push(pid);

      expect(await goneWithin(pid, 15_000), `the query server (pid ${pid}) outlived the run`).toBe(true);
    },
    180_000,
  );

  it(
    "records whether a cancelled CLI ends a server that ignores EOF (upstream behaviour, not EO's guarantee)",
    async () => {
      workspace = newWorkspace();
      const pidPath = join(workspace, "server.pid");
      const controller = new AbortController();
      const provider = createCodexProvider({ executablePath: CODEX });

      // Something long enough to still be running when the cancel lands.
      const stream = provider.start({
        instructions: "You are a test fixture.",
        context: "Count slowly from one to two hundred, one number per line.",
        cwd: workspace,
        repositoryMcp: queryServer(lingeringServer(workspace, pidPath)),
        signal: controller.signal,
      });

      let over = false;
      const cancelled = (async () => {
        try {
          for await (const _event of stream) {
            void _event;
          }
        } catch {
          // A cancelled turn ends by throwing out of the SDK. The run
          // being over is the subject here, not how it reported that.
        }
        over = true;
      })();

      // Give the CLI time to start the server before pulling the rug.
      const deadline = Date.now() + 60_000;
      while (!existsSync(pidPath) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      expect(existsSync(pidPath), "Codex never launched the query server").toBe(true);
      const pid = Number(readFileSync(pidPath, "utf8"));
      lingering.push(pid);
      // The preconditions are still asserted: without them the record
      // below would say something about a run that was never cancelled
      // mid-turn at all.
      expect(over, "the turn finished before the cancel could land").toBe(false);
      expect(alive(pid), "the query server was already gone before the cancel").toBe(true);

      // What EO does on a cancel, and the whole of what it does: abort
      // the signal the turn was given.
      controller.abort();
      await cancelled;

      // Recorded, not asserted. At codex-cli 0.155.1 this printed "left
      // running", and it still did at 0.161.0 under `exec` (EO-370). At
      // 0.161.0 over `app-server` (EO-372) it printed "ended by the
      // cancelled CLI": the app-server, sent the same SIGTERM, takes its
      // MCP servers with it. At 0.163.0 (EO-453) and 0.165.0 (EO-599) it
      // printed "ended by the cancelled CLI" again. The afterEach ends it
      // either way.
      const reaped = await goneWithin(pid, 15_000);
      console.info(`[EO-343] codex: a server that ignores EOF was ${reaped ? "ended by the cancelled CLI" : "left running by the cancelled CLI"} (pid ${pid})`);
    },
    180_000,
  );
});
