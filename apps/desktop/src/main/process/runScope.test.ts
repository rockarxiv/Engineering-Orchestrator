import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { RUN_MEMORY_MAX_MB, RUN_MEMORY_MIN_MB, type RunProcessScope } from "@eo/core";
import { afterEach, describe, expect, it } from "vitest";
import { defaultRunMemoryMaxMb, effectiveRunMemoryMaxMb, launchTree, runMemoryFacts, setRunScopes, systemdRunScopes, type RunScopes } from "./runScope.js";

/**
 * A run's process tree in a systemd scope of its own (EO-738).
 *
 * The first half is what holds everywhere: the default, and that a run's
 * tree is planned through the run scopes and nothing else is. The second
 * half runs only where a systemd user manager is reachable: a real scope
 * gets the run's `MemoryMax`, and a run that ends normally reports nothing.
 * Nothing here runs a scope out of memory on purpose — that set off the
 * desktop's "Memory Shortage Avoided" notifications on every test run.
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

/** Swap off in the scope, as EO's own runs would be. */
const scopes = () => systemdRunScopes({ properties: ["MemorySwapMax=0"] });

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

  it("says nothing about a run that ended without running out", async () => {
    const runScopes = scopes();
    const scope = { ...SCOPE, runId: `fine-${process.pid}` };
    const plan = runScopes.plan(scope, `eo-tree-fine-${process.pid}`, "/bin/true", [], process.env, undefined);
    const child = spawn(plan!.command, plan!.args, { stdio: "ignore", windowsHide: true });
    plan!.adopt(child.pid);
    await new Promise((resolve) => child.on("exit", resolve));
    expect(await runScopes.outOfMemory(scope.runId)).toBeNull();
  }, 30_000);
});
