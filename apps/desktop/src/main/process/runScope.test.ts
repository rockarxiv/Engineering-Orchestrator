import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { RUN_MEMORY_MAX_MB, RUN_MEMORY_MIN_MB, type RunProcessScope } from "@eo/core";
import { afterEach, describe, expect, it } from "vitest";
import { nodeScript } from "../testing/nodeScript.js";
import { defaultRunMemoryMaxMb, effectiveRunMemoryMaxMb, launchTree, runMemoryFacts, setRunScopes, systemdRunScopes, type RunScopes } from "./runScope.js";

/**
 * A run's process tree in a systemd scope of its own (EO-738).
 *
 * The first half is what holds everywhere: the default, and that a run's
 * tree is planned through the run scopes and nothing else is. The second
 * half runs only where a systemd user manager is reachable, and runs the
 * real thing: a process that eats memory inside a scope with a small
 * `MemoryMax`, and what EO is told about it.
 */

const SCOPE: RunProcessScope = { runId: "019a0000-0000-7000-8000-000000000738", memoryMaxMb: 2_048 };

describe("the run memory limit's default (EO-738)", () => {
  it("is three quarters of the machine's memory, shared across the global concurrency cap", () => {
    // The machine the story was found on: 14.9 GB, and three at once.
    expect(defaultRunMemoryMaxMb(15_217, 3)).toBe(3_804);
    expect(defaultRunMemoryMaxMb(15_217, 1)).toBe(11_412);
    expect(defaultRunMemoryMaxMb(16_384, 4)).toBe(3_072);
  });

  it("is held to the guardrail's own range", () => {
    expect(defaultRunMemoryMaxMb(1_024, 16)).toBe(RUN_MEMORY_MIN_MB);
    expect(defaultRunMemoryMaxMb(4 * RUN_MEMORY_MAX_MB, 1)).toBe(RUN_MEMORY_MAX_MB);
  });

  it("gives way to a limit a person set", () => {
    expect(effectiveRunMemoryMaxMb({ runMemoryMaxMb: null, globalConcurrency: 2 }, 8_192)).toBe(3_072);
    expect(effectiveRunMemoryMaxMb({ runMemoryMaxMb: 6_000, globalConcurrency: 2 }, 8_192)).toBe(6_000);
  });

  it("is said, with whether it applies, the way the Guardrails screen reads it", () => {
    const nowhere: RunScopes = { availability: () => ({ applies: false, reason: "macOS has no systemd" }), plan: () => null, outOfMemory: async () => null, handOver: () => undefined };
    expect(runMemoryFacts({ runMemoryMaxMb: null, globalConcurrency: 2 }, nowhere, 8_192)).toEqual({
      applies: false,
      reason: "macOS has no systemd",
      totalMb: 8_192,
      defaultMb: 3_072,
      effectiveMb: 3_072,
    });
  });
});

describe("a run's tree is planned through the run scopes (EO-738)", () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
  });

  const recording = (answer: "scope" | "none") => {
    const asked: { scope: RunProcessScope; command: string; args: readonly string[] }[] = [];
    const scopes: RunScopes = {
      availability: () => ({ applies: true }),
      plan: (scope, _name, command, args) => {
        asked.push({ scope, command, args });
        return answer === "none" ? null : { command: "/usr/bin/systemd-run", args: ["--user", "--scope", "--", command, ...args], adopt: () => null };
      },
      outOfMemory: async () => null,
      handOver: () => undefined,
    };
    restore = setRunScopes(scopes);
    return asked;
  };

  it("starts a run's tree as the scopes plan it", () => {
    const asked = recording("scope");
    const launch = launchTree("eo-tree-x", "/opt/agent", ["--go"], {}, undefined, SCOPE);
    expect(asked).toEqual([{ scope: SCOPE, command: "/opt/agent", args: ["--go"] }]);
    expect(launch.command).toBe("/usr/bin/systemd-run");
    expect(launch.args.slice(-2)).toEqual(["/opt/agent", "--go"]);
  });

  it("starts it as before where the scopes can make none", () => {
    const asked = recording("none");
    // A path with nothing at it is never wrapped (EO-494's rule), so the plan is the command itself.
    const launch = launchTree("eo-tree-y", "/nowhere/agent", ["--go"], {}, undefined, SCOPE);
    expect(asked).toHaveLength(1);
    expect(launch).toMatchObject({ command: "/nowhere/agent", args: ["--go"] });
  });

  it("asks nothing for a tree that is no run's", () => {
    const asked = recording("scope");
    launchTree("eo-tree-z", "/nowhere/agent", [], {}, undefined, undefined);
    expect(asked).toEqual([]);
  });
});

// ───────────────────────── the real thing ─────────────────────────

/**
 * Whether this machine can run the live half. Asked of a scopes object
 * of its own, so nothing here decides what the rest of the suite uses.
 */
const live = process.platform === "linux" && systemdRunScopes().availability().applies;

/** Swap off in the scope: a limit reached is then an OOM kill at once, not a crawl through swap. */
const scopes = () => systemdRunScopes({ properties: ["MemorySwapMax=0"] });

/** A Node program that allocates until something stops it. */
const GREEDY = nodeScript('const kept = []; for (;;) kept.push(Buffer.alloc(4 * 1024 * 1024, 1));');

/** Starts `plan` and resolves with how it ended. */
function runToEnd(command: string, args: readonly string[]): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve({ code, signal, stdout }));
  });
}

const ownCgroup = () => readFileSync("/proc/self/cgroup", "utf8");

describe.runIf(live)("a run's scope on this machine's systemd user manager (EO-738)", () => {
  it("is a unit of its own beside EO's, never inside it, with the run's MemoryMax", async () => {
    const runScopes = scopes();
    const plan = runScopes.plan({ ...SCOPE, memoryMaxMb: 300 }, `eo-tree-probe-${process.pid}`, "/bin/sh", ["-c", "cat /proc/self/cgroup; cat /sys/fs/cgroup$(cut -d: -f3 /proc/self/cgroup)/memory.max"], process.env, undefined);
    expect(plan).not.toBeNull();
    const ended = await runToEnd(plan!.command, plan!.args);
    const [cgroupLine, memoryMax] = ended.stdout.trim().split("\n");
    const theirs = cgroupLine!.slice(3);
    const ours = ownCgroup().trim().slice(3);
    expect(theirs).toMatch(/\/app\.slice\/eo-run-probe-\d+\.scope$/);
    expect(theirs.startsWith(`${ours}/`)).toBe(false);
    expect(Number(memoryMax)).toBe(300 * 1024 * 1024);
    expect(ended.code).toBe(0);
  }, 30_000);

  it("ends alone when the run runs out of memory, and says so: the limit and the process killed", async () => {
    const before = ownCgroup();
    const runScopes = scopes();
    const scope = { ...SCOPE, runId: `oom-${process.pid}`, memoryMaxMb: 128 };
    const plan = runScopes.plan(scope, `eo-tree-oom-${process.pid}`, process.execPath, [GREEDY], process.env, undefined);
    expect(plan).not.toBeNull();
    const child = spawn(plan!.command, plan!.args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let said = "";
    child.stderr.on("data", (chunk: Buffer) => (said += chunk.toString()));
    plan!.adopt(child.pid);
    const ended = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
    // Killed, not finished: the program never stops on its own.
    expect(ended.code === 0, said).toBe(false);

    const report = await runScopes.outOfMemory(scope.runId);
    expect(report).toMatchObject({ runId: scope.runId, memoryMaxMb: 128 });
    expect(report!.unit).toMatch(/^eo-run-oom-\d+\.scope$/);
    // The kernel's own words where this user may read them; the likeliest
    // process otherwise. Either way, a Node process.
    expect(report!.killed).not.toBeNull();
    expect(report!.killed!.name).toMatch(/node|MainThread/);
    if (report!.killed!.how === "kernel") {
      expect(report!.killed!.pid).toBe(child.pid);
      expect(report!.limitReached).toBe(true);
    }
    // And this process — standing for EO — is where it was, untouched.
    expect(ownCgroup()).toBe(before);
    // EO resets the failed unit once it has gone; this process may be
    // gone first.
    try {
      execFileSync("systemctl", ["--user", "reset-failed", report!.unit], { stdio: "ignore", windowsHide: true });
    } catch {
      // Already reset.
    }
  }, 60_000);

  it("still names a process when the run runs out within its first second and the kernel log cannot be read", async () => {
    // A limit node cannot even start inside, so the scope is gone before
    // the regular look at it would ever have come; and no kernel log, as
    // for a user it is closed to. What EO saw first, or what the run
    // started as, is still a name.
    const runScopes = systemdRunScopes({ properties: ["MemorySwapMax=0"], kernelLog: false });
    const scope = { ...SCOPE, runId: `fast-${process.pid}`, memoryMaxMb: 32 };
    const plan = runScopes.plan(scope, `eo-tree-fast-${process.pid}`, process.execPath, [GREEDY], process.env, undefined);
    expect(plan).not.toBeNull();
    const started = Date.now();
    const child = spawn(plan!.command, plan!.args, { stdio: "ignore", windowsHide: true });
    plan!.adopt(child.pid);
    await new Promise((resolve) => child.on("exit", resolve));
    expect(Date.now() - started).toBeLessThan(2_000);

    const report = await runScopes.outOfMemory(scope.runId);
    expect(report).toMatchObject({ runId: scope.runId, memoryMaxMb: 32 });
    expect(report!.killed).not.toBeNull();
    expect(report!.killed!.how).not.toBe("kernel");
    expect(report!.killed!.name).toMatch(/node|MainThread/);
    expect(report!.killed!.pid).toBeGreaterThan(0);
    try {
      execFileSync("systemctl", ["--user", "reset-failed", report!.unit], { stdio: "ignore", windowsHide: true });
    } catch {
      // Already reset.
    }
  }, 60_000);

  it("is the adopting run's to hear of, once a warm process's scope is handed over", async () => {
    const runScopes = scopes();
    const warm = { ...SCOPE, runId: `warm:handover-${process.pid}`, memoryMaxMb: 128 };
    const plan = runScopes.plan(warm, `eo-tree-handover-${process.pid}`, process.execPath, [GREEDY], process.env, undefined)!;
    const child = spawn(plan.command, plan.args, { stdio: "ignore", windowsHide: true });
    plan.adopt(child.pid);
    runScopes.handOver(warm.runId, `run-${process.pid}`);
    await new Promise((resolve) => child.on("exit", resolve));
    expect(await runScopes.outOfMemory(warm.runId)).toBeNull();
    const report = await runScopes.outOfMemory(`run-${process.pid}`);
    expect(report).toMatchObject({ runId: `run-${process.pid}`, memoryMaxMb: 128 });
    try {
      execFileSync("systemctl", ["--user", "reset-failed", report!.unit], { stdio: "ignore", windowsHide: true });
    } catch {
      // Already reset.
    }
  }, 60_000);

  it("says nothing about a run that ended without running out", async () => {
    const runScopes = scopes();
    const scope = { ...SCOPE, runId: `fine-${process.pid}` };
    const plan = runScopes.plan(scope, `eo-tree-fine-${process.pid}`, "/bin/true", [], process.env, undefined);
    const child = spawn(plan!.command, plan!.args, { stdio: "ignore", windowsHide: true });
    plan!.adopt(child.pid);
    await new Promise((resolve) => child.on("exit", resolve));
    expect(await runScopes.outOfMemory(scope.runId)).toBeNull();
  }, 30_000);

  it("leaves EO running under a launcher whose OOMPolicy is the default, stop", async () => {
    // EO as the desktop launcher starts it: a scope of its own whose
    // OOMPolicy is systemd's default, `stop` — the unit that took EO
    // down on 2026-11-11. A shell stands in for EO; it starts a run the
    // way EO does, waits for it to die, and says it is still here.
    const runScopes = scopes();
    const scope = { ...SCOPE, runId: `launcher-${process.pid}`, memoryMaxMb: 128 };
    const plan = runScopes.plan(scope, `eo-tree-launcher-${process.pid}`, process.execPath, [GREEDY], process.env, undefined)!;
    const launcher = `eo-launcher-test-${process.pid}.scope`;
    const quoted = [plan.command, ...plan.args].map((word) => `'${word.replace(/'/g, `'\\''`)}'`).join(" ");
    const ended = await runToEnd("systemd-run", [
      "--user",
      "--scope",
      "--quiet",
      "--collect",
      `--unit=${launcher}`,
      "-p",
      "OOMPolicy=stop",
      "--",
      "/bin/sh",
      "-c",
      `${quoted}; echo "run ended $?"; sleep 1; echo "EO still running"`,
    ]);
    expect(ended.stdout).toContain("run ended");
    expect(ended.stdout).toContain("EO still running");
    expect(ended.code).toBe(0);
    expect(ended.signal).toBeNull();
    // The run's own unit is the one that ended out of memory.
    const unit = plan.args.find((arg) => arg.startsWith("--unit="))!.slice("--unit=".length);
    expect(execFileSync("systemctl", ["--user", "show", "--property=Result", "--value", unit], { encoding: "utf8", windowsHide: true }).trim()).toBe("oom-kill");
    execFileSync("systemctl", ["--user", "reset-failed", unit], { windowsHide: true });
  }, 60_000);
});
