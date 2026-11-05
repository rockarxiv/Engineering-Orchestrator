import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { containmentAvailable } from "../process/cgroupContainment.js";
import { allGone, sweepUp } from "../testing/escapingDescendants.js";
import { AppServerConnection } from "./codexAppServer.js";

/**
 * The Codex app-server, spawned the way EO really spawns it — no spawn
 * seam — is inside its cgroup before it can fork (EO-494).
 *
 * The "app-server" is a shell script, which forks in its first
 * millisecond: it orphans an `env -i … setsid sleep 600` at once, from a
 * subshell that exits, and then becomes a long sleep. EO's own move into
 * the cgroup, once spawn returns, is held back 300ms (`onSpawn`), so the
 * orphan is inside only if the app-server was put there before it ran.
 */

const directories: string[] = [];
const leftovers: number[] = [];
afterEach(() => {
  sweepUp(leftovers.splice(0));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function holdFor(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

async function pidIn(file: string): Promise<number> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      const pid = Number(readFileSync(file, "utf8").trim());
      if (pid > 1) return pid;
    } catch {
      // Not yet.
    }
    if (Date.now() > deadline) throw new Error(`no pid in ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe.runIf(process.platform === "linux" && containmentAvailable())("the Codex app-server's tree, contained from the start (EO-494)", () => {
  it("ends an env -i setsid orphan the app-server made in its first instant, however late EO moves it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "eo-codex-early-"));
    directories.push(directory);
    const pidFile = join(directory, "orphan");
    const executable = join(directory, "codex");
    writeFileSync(executable, `#!/bin/sh\n(env -i PATH=/usr/bin:/bin setsid sleep 600 >/dev/null 2>&1 </dev/null & echo $! > ${JSON.stringify(pidFile)})\nexec sleep 600\n`);
    chmodSync(executable, 0o755);

    const connection = new AppServerConnection({ executablePath: executable, onSpawn: () => holdFor(300) });
    const orphan = await pidIn(pidFile);
    leftovers.push(orphan);

    await connection.terminate(200);

    expect(await allGone([orphan], 1_000)).toBe(true);
  });

  it("still reports an app-server that is not there as the spawn failure Node gives", async () => {
    const connection = new AppServerConnection({ executablePath: "/nonexistent/eo/codex" });

    const exit = await connection.exited();

    expect(exit.stderr).toContain("ENOENT");
    await connection.terminate(100);
  });
});
