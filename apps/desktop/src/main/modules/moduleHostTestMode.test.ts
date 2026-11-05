import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `ctx.exec` under test spawns nothing (EO-352).
 *
 * `node:child_process` is replaced before the host is imported, so any
 * route from the scripted exec to a real process would show up here as
 * a call on the mock. `runModuleTests.test.ts` covers the same promise
 * end to end; this is the one that can see a spawn that never happened.
 */

const spawned = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn(), exec: vi.fn(), fork: vi.fn() }));
vi.mock("node:child_process", () => spawned);

// @ts-expect-error — the host is plain JavaScript, deliberately: it ships
// unbundled because another process executes it by path.
const { makeScriptedExec } = (await import("./moduleHost.mjs")) as {
  makeScriptedExec: (options: {
    needs: { bin: string[] };
    script: Array<{ bin: string; args?: string[]; code?: number; stdout?: string; stderr?: string }>;
    onCall?: (call: { bin: string; args: string[] }) => void;
    onUnscripted?: (message: string) => void;
    say?: (event: unknown) => void;
  }) => (bin: string, args?: string[]) => Promise<{ code: number; stdout: string; stderr: string; tail: string }>;
};

describe("makeScriptedExec", () => {
  beforeEach(() => {
    for (const fn of Object.values(spawned)) fn.mockClear();
  });

  it("runs against the mocked child_process, so a spawn would be seen", async () => {
    // Without this, a mock that silently failed to apply would make every
    // "not called" below pass for the wrong reason.
    const childProcess = await import("node:child_process");
    expect(childProcess.spawn).toBe(spawned.spawn);
  });

  it("refuses a call the case did not script, naming the binary and its arguments, and spawns nothing", async () => {
    const unscripted: string[] = [];
    const exec = makeScriptedExec({ needs: { bin: ["gh"] }, script: [], onUnscripted: (message) => unscripted.push(message) });

    await expect(exec("gh", ["pr", "merge", "12", "--squash"])).rejects.toThrow(`ctx.exec("gh", ["pr","merge","12","--squash"]) was not scripted by this test case`);
    expect(unscripted).toHaveLength(1);
    expect(unscripted[0]).toContain('"gh"');
    expect(unscripted[0]).toContain('["pr","merge","12","--squash"]');
    for (const fn of Object.values(spawned)) expect(fn).not.toHaveBeenCalled();
  });

  it("answers a scripted call from the script, and spawns nothing for it either", async () => {
    const exec = makeScriptedExec({ needs: { bin: ["gh"] }, script: [{ bin: "gh", args: ["pr", "checks", "12"], code: 8, stdout: "pending" }] });

    expect(await exec("gh", ["pr", "checks", "12"])).toEqual({ code: 8, stdout: "pending", stderr: "", tail: "pending" });
    for (const fn of Object.values(spawned)) expect(fn).not.toHaveBeenCalled();
  });

  it("gives repeated identical calls their answers in the order they were written, each once", async () => {
    const exec = makeScriptedExec({
      needs: { bin: ["gh"] },
      script: [
        { bin: "gh", args: ["pr", "checks", "12"], code: 8 },
        { bin: "gh", args: ["pr", "checks", "12"], code: 0 },
      ],
    });

    expect((await exec("gh", ["pr", "checks", "12"])).code).toBe(8);
    expect((await exec("gh", ["pr", "checks", "12"])).code).toBe(0);
    await expect(exec("gh", ["pr", "checks", "12"])).rejects.toThrow("was not scripted");
  });

  it("matches an entry without args to any arguments, and an entry with args only to those", async () => {
    const exec = makeScriptedExec({
      needs: { bin: ["gh", "git"] },
      script: [
        { bin: "git", args: ["push"], code: 1 },
        { bin: "gh", stdout: "anything" },
      ],
    });

    expect((await exec("gh", ["api", "repos/o/r"])).stdout).toBe("anything");
    await expect(exec("git", ["push", "--force"])).rejects.toThrow('ctx.exec("git", ["push","--force"]) was not scripted');
    expect((await exec("git", ["push"])).code).toBe(1);
  });

  it("still holds a module to needs.bin, before the script is consulted, and fails the case for it", async () => {
    const unscripted: string[] = [];
    const calls: Array<{ bin: string; args: string[] }> = [];
    const exec = makeScriptedExec({
      needs: { bin: [] },
      script: [{ bin: "gh" }],
      onUnscripted: (message) => unscripted.push(message),
      onCall: (call) => calls.push(call),
    });

    // The rejection is the one a real run gives, word for word…
    await expect(exec("gh", ["pr", "merge", "12"])).rejects.toThrow('This module did not declare "gh" in needs.bin');
    // …and the case is told as well, naming the binary and its
    // arguments, so a module that catches the rejection cannot pass.
    expect(unscripted).toHaveLength(1);
    expect(unscripted[0]).toContain('ctx.exec("gh", ["pr","merge","12"])');
    expect(unscripted[0]).toContain("did not declare in needs.bin");
    expect(calls).toEqual([{ bin: "gh", args: ["pr", "merge", "12"] }]);
    for (const fn of Object.values(spawned)) expect(fn).not.toHaveBeenCalled();
  });

  it("records every call, scripted or not, for the case to assert on", async () => {
    const calls: Array<{ bin: string; args: string[] }> = [];
    const exec = makeScriptedExec({ needs: { bin: ["gh"] }, script: [{ bin: "gh", args: ["auth", "status"] }], onCall: (call) => calls.push(call) });

    await exec("gh", ["auth", "status"]);
    await exec("gh", ["pr", "list"]).catch(() => undefined);
    expect(calls).toEqual([
      { bin: "gh", args: ["auth", "status"] },
      { bin: "gh", args: ["pr", "list"] },
    ]);
  });
});
