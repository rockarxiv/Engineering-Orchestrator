import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isTurnNotEnded } from "@eo/core";
import { describe, expect, it, vi } from "vitest";
import { containmentAvailable } from "../process/cgroupContainment.js";
import { windowsTreeKill } from "../process/processTree.js";
import { allGone, descendantPids, DESCENDANTS_SNIPPET, owed, running, sweepUp } from "../testing/escapingDescendants.js";
import { nodeScript } from "../testing/nodeScript.js";
import { claudeProcesses, withStderr } from "./claudeProcess.js";

/** A Node script run where the SDK would have run the CLI, from a file (`testing/nodeScript.ts` says why). */
const node = (source: string) => ({ command: process.execPath, args: [nodeScript(source)], env: { ...process.env }, signal: new AbortController().signal });

const alive = (pid: number | undefined) => {
  try {
    process.kill(pid!, 0);
    return true;
  } catch {
    return false;
  }
};

describe("the Claude CLI as EO spawns it (EO-493)", () => {
  it("ends every process the turn spawned, one that ignores SIGTERM included, and settles once they have exited", async () => {
    const processes = claudeProcesses();
    const spawned = processes.spawn(node('process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); process.stdout.write("up\\n");'));
    await new Promise((resolve) => spawned.stdout.once("data", resolve));

    await processes.end(150);

    expect(spawned.exitCode !== null || spawned.signalCode !== null).toBe(true);
    // Windows has no SIGTERM to ignore: there `taskkill /T /F` ends the
    // tree outright, and the CLI exits with taskkill's code, not a signal.
    if (process.platform !== "win32") expect(spawned.signalCode).toBe("SIGKILL");
  });

  it("rejects, naming it, when a process is still there after SIGKILL — never reports it ended", async () => {
    // No real child survives SIGKILL on demand, so the signals are what
    // is taken away: a process nothing EO sends reaches — taskkill
    // included, which on Windows reaches it whatever its handle does.
    const taskkill = vi.spyOn(windowsTreeKill, "run").mockResolvedValue(false);
    const processes = claudeProcesses({ onSpawn: (child) => (child.kill = () => true) });
    const spawned = processes.spawn(node('setInterval(() => {}, 1000); process.stdout.write("up\\n");'));
    await new Promise((resolve) => spawned.stdout.once("data", resolve));
    const pid = (spawned as unknown as { pid: number }).pid;

    try {
      const ending = await processes.end(20).then(
        () => null,
        (error: unknown) => error,
      );

      expect(isTurnNotEnded(ending)).toBe(true);
      expect((ending as { pids: number[] }).pids).toEqual([pid]);
      expect(alive(pid)).toBe(true);
    } finally {
      taskkill.mockRestore();
      process.kill(pid, "SIGKILL");
    }
  });

  it("tells the SDK of an exit only once stderr has been read, and keeps its tail", async () => {
    const processes = claudeProcesses();
    const spawned = processes.spawn(node('process.stderr.write("No conversation found with session ID: gone\\n"); process.exit(1);'));

    const exit = await new Promise<{ code: number | null; tail: string }>((resolve) => {
      spawned.once("exit", (code) => resolve({ code, tail: processes.stderr() }));
    });

    expect(exit.code).toBe(1);
    expect(exit.tail).toContain("No conversation found with session ID: gone");
    // Nothing left to end.
    await processes.end(10_000);
  });

  it("passes on the spawn failure of an executable that is not there, and has nothing to end", async () => {
    const processes = claudeProcesses();
    const spawned = processes.spawn({ ...node(""), command: "/nonexistent/eo/claude" });

    const error = await new Promise<Error>((resolve) => spawned.once("error", resolve));

    expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
    await processes.end(10_000);
  });

  it("is not left running when the SDK's abort fires", async () => {
    const processes = claudeProcesses();
    const controller = new AbortController();
    const spawned = processes.spawn({ ...node('setInterval(() => {}, 1000); process.stdout.write("up\\n");'), signal: controller.signal });
    await new Promise((resolve) => spawned.stdout.once("data", resolve));
    const pid = (spawned as unknown as { pid?: number }).pid;

    controller.abort();
    await new Promise((resolve) => spawned.once("exit", resolve));

    expect(alive(pid)).toBe(false);
  });
});

/** Blocks this thread for `ms` — EO busy between a spawn and what follows it. */
function holdFor(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

async function orphanPid(file: string): Promise<number> {
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

const contained = process.platform === "linux" && containmentAvailable();

describe.runIf(process.platform !== "win32")("everything the Claude CLI started (EO-494)", () => {
  it("is ended with the turn, a CLI that exits as soon as the SDK closes its stdin included", async () => {
    // The CLI starts the two descendants a pid-kill misses, and goes the
    // moment its input closes — which the SDK does before EO ends the
    // turn. The bare one carries no mark, so it is found only because it
    // was looked at while the CLI was still its parent.
    const directory = mkdtempSync(join(tmpdir(), "eo-claude-tree-"));
    const pidFile = join(directory, "pids");
    const processes = claudeProcesses();
    const source = `const pidFile = ${JSON.stringify(pidFile)}; ${DESCENDANTS_SNIPPET} process.stdin.on("end", () => process.exit(0)); process.stdin.resume();`;
    const spawned = processes.spawn(node(source));
    const descendants = await descendantPids(pidFile);
    const pids = [...descendants.values()];
    try {
      expect(pids.every(running)).toBe(true);

      spawned.stdin.end();
      await new Promise((resolve) => spawned.once("exit", resolve));
      await processes.end(500);

      expect(await allGone(owed(descendants), 1_000)).toBe(true);
    } finally {
      sweepUp(pids);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.runIf(contained)("is contained before the CLI can fork: a launcher that orphans an env -i setsid child at once is ended with it, however late EO moves it", async () => {
    // A shell, which forks in its first millisecond, standing in for a
    // CLI. EO's own move into the cgroup, once spawn returns, is held
    // back here for 300ms — so the orphan is inside only if the CLI was
    // put there before it ran.
    const directory = mkdtempSync(join(tmpdir(), "eo-claude-early-"));
    const pidFile = join(directory, "orphan");
    const processes = claudeProcesses({ onSpawn: () => holdFor(300) });
    processes.spawn({
      ...node(""),
      command: "/bin/sh",
      // In a subshell that exits, so the orphan is pid 1's at once.
      args: ["-c", `(env -i PATH=/usr/bin:/bin setsid sleep 600 >/dev/null 2>&1 </dev/null & echo $! > ${JSON.stringify(pidFile)}); exec sleep 600`],
    });
    const orphan = await orphanPid(pidFile);
    try {
      await processes.end(200);

      expect(await allGone([orphan], 1_000)).toBe(true);
    } finally {
      sweepUp([orphan]);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("still reports a CLI that is not there as the spawn failure Node gives, not as a shell's exit", async () => {
    const processes = claudeProcesses();
    const spawned = processes.spawn({ ...node(""), command: "/nonexistent/eo/claude" });

    const error = await new Promise<Error>((resolve) => spawned.once("error", resolve));

    expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
    await processes.end(1_000);
  });

  it("starts the CLI with the tree's mark in its environment, over what the SDK gave it", async () => {
    const processes = claudeProcesses();
    const spawned = processes.spawn(node('process.stdout.write(String(process.env.EO_PROCESS_TREE) + "|" + String(process.env.PATH));'));
    const written = await new Promise<string>((resolve) => spawned.stdout.once("data", (chunk: Buffer) => resolve(String(chunk))));
    await processes.end(1_000);

    const [marker, path] = written.split("|");
    expect(marker).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(path).toBe(process.env["PATH"]);
  });
});

describe("withStderr (EO-93 under EO's own spawn)", () => {
  it("appends the tail to a failed exit, as the SDK's own spawn would have", () => {
    const error = new Error("Claude Code process exited with code 1");
    const same = withStderr(error, "No conversation found with session ID: abc\n");

    expect(same).toBe(error);
    expect(error.message).toBe("Claude Code process exited with code 1. stderr: No conversation found with session ID: abc");
  });

  it("leaves every other error, an error that already has a tail, and an empty tail alone", () => {
    const other = new Error("the backend is overloaded");
    const tailed = new Error("Claude Code process exited with code 1. stderr: already here");
    const quiet = new Error("Claude Code process exited with code 1");

    withStderr(other, "noise");
    withStderr(tailed, "noise");
    withStderr(quiet, "  \n");

    expect(other.message).toBe("the backend is overloaded");
    expect(tailed.message).toBe("Claude Code process exited with code 1. stderr: already here");
    expect(quiet.message).toBe("Claude Code process exited with code 1");
    expect(withStderr("not an error", "noise")).toBe("not an error");
  });
});
