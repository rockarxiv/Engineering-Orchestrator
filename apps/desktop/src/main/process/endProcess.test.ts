import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { endProcess } from "./endProcess.js";

/** A real Node child; `stubborn` ignores SIGTERM, as a CLI busy on its own terms might. */
function child(stubborn: boolean): Promise<ChildProcessWithoutNullStreams> {
  const source = `${stubborn ? 'process.on("SIGTERM", () => {});' : ""} setInterval(() => {}, 1000); process.stdout.write("up\\n");`;
  const started = spawn(process.execPath, ["-e", source], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  spawned.push(started);
  // Running, and its SIGTERM handler installed, before anything is sent.
  return new Promise((resolve) => started.stdout.once("data", () => resolve(started)));
}

const spawned: ChildProcessWithoutNullStreams[] = [];
afterEach(() => {
  for (const started of spawned.splice(0)) if (started.exitCode === null && started.signalCode === null) started.kill("SIGKILL");
});

const alive = (pid: number | undefined) => {
  try {
    process.kill(pid!, 0);
    return true;
  } catch {
    return false;
  }
};

describe("endProcess (EO-493)", () => {
  it("ends a process on SIGTERM and settles once it has exited", async () => {
    const running = await child(false);

    expect(await endProcess(running, 2_000)).toBe(true);

    expect(running.signalCode).toBe("SIGTERM");
    expect(alive(running.pid)).toBe(false);
  });

  // Windows has no SIGTERM for a process to refuse: Node ends the process
  // outright for any signal but 0, so the first one is always enough.
  it.skipIf(process.platform === "win32")("escalates to SIGKILL after the grace when SIGTERM is not enough", async () => {
    const running = await child(true);
    const began = Date.now();

    expect(await endProcess(running, 150)).toBe(true);

    expect(running.signalCode).toBe("SIGKILL");
    expect(Date.now() - began).toBeGreaterThanOrEqual(140);
    expect(alive(running.pid)).toBe(false);
  });

  it("settles at once for a process already gone, and for one that never started", async () => {
    const running = await child(false);
    running.kill("SIGKILL");
    await new Promise((resolve) => running.once("exit", resolve));

    expect(await endProcess(running, 10_000)).toBe(true);
    expect(await endProcess({ pid: undefined, exitCode: null, kill: () => false, once: () => undefined }, 10_000)).toBe(true);
  });

  it("answers false for a process no signal moves, after SIGTERM, its grace, SIGKILL and a second grace", async () => {
    // What a process in uninterruptible sleep looks like from here.
    const sent: string[] = [];
    const unmoved = { pid: 4242, exitCode: null, signalCode: null, kill: (signal: NodeJS.Signals) => (sent.push(signal), true), once: () => undefined };

    expect(await endProcess(unmoved, 20)).toBe(false);
    expect(sent).toEqual(["SIGTERM", "SIGKILL"]);
  });
});
