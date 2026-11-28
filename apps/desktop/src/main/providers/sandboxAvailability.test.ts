import { describe, expect, it } from "vitest";
import { sandboxAvailability, type SandboxAvailabilityDeps } from "./sandboxAvailability.js";

/**
 * Whether a backend's sandbox can start on this machine (EO-935), over a
 * machine the test describes: what is on the PATH, and whether starting
 * the sandbox works.
 */
interface Machine {
  platform?: NodeJS.Platform;
  onPath?: Record<string, string>;
  executables?: string[];
  starts?: boolean;
  output?: string;
}

function machine({ platform = "linux", onPath = {}, executables = [], starts = true, output = "" }: Machine = {}) {
  const runs: { command: string; args: readonly string[]; env: NodeJS.ProcessEnv; cwd: string }[] = [];
  let removed = 0;
  const deps: SandboxAvailabilityDeps = {
    platform,
    findOnPath: (name) => onPath[name] ?? null,
    executable: (path) => executables.includes(path),
    run: async (command, args, { cwd, env }) => {
      runs.push({ command, args, env, cwd });
      return { ok: starts, output };
    },
    scratch: () => ({ path: "/scratch/eo-sandbox-check", remove: () => void (removed += 1) }),
  };
  return { deps, runs, removed: () => removed };
}

const BOTH = { bwrap: "/usr/bin/bwrap", socat: "/usr/bin/socat" };
const CODEX = "/home/me/.config/EO/runtimes/codex/bin/codex";

describe("Claude on Linux", () => {
  it("is available where bubblewrap and socat are on the PATH and bubblewrap starts a sandbox", async () => {
    const { deps, runs, removed } = machine({ onPath: BOTH });

    expect(await sandboxAvailability("claude", null, deps)).toEqual({ available: true, how: "bubblewrap (/usr/bin/bwrap) and socat (/usr/bin/socat)" });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.command).toBe("/usr/bin/bwrap");
    expect(runs[0]?.args).toEqual(expect.arrayContaining(["--unshare-all", "--", "true"]));
    expect(removed()).toBe(1);
  });

  it("is unavailable without bubblewrap, says so and names the package, and starts nothing", async () => {
    const { deps, runs } = machine({ onPath: { socat: BOTH.socat } });
    const answer = await sandboxAvailability("claude", null, deps);

    expect(answer).toMatchObject({ available: false });
    if (answer?.available !== false) throw new Error("expected unavailable");
    expect(answer.reason).toBe("Claude's sandbox on Linux needs bubblewrap and socat, and bubblewrap (bwrap) is not installed on this machine.");
    expect(answer.fix).toContain("sudo apt install bubblewrap");
    expect(runs).toEqual([]);
  });

  it("names both when both are missing", async () => {
    const answer = await sandboxAvailability("claude", null, machine().deps);

    if (answer?.available !== false) throw new Error("expected unavailable");
    expect(answer.reason).toContain("bubblewrap (bwrap) and socat are not installed");
    expect(answer.fix).toContain("sudo apt install bubblewrap socat");
  });

  it("is unavailable where bubblewrap is installed and cannot start a sandbox, with what it said", async () => {
    const answer = await sandboxAvailability("claude", null, machine({ onPath: BOTH, starts: false, output: "bwrap: setting up uid map: Permission denied\n" }).deps);

    if (answer?.available !== false) throw new Error("expected unavailable");
    expect(answer.reason).toBe("bubblewrap is installed but could not start a sandbox on this machine: bwrap: setting up uid map: Permission denied");
    expect(answer.fix).toContain("unprivileged user namespaces");
  });
});

describe("Codex on Linux", () => {
  it("is available where `codex sandbox` starts, run in a home of its own and needing no bubblewrap on the PATH", async () => {
    const { deps, runs, removed } = machine({ executables: [CODEX] });

    expect(await sandboxAvailability("codex", CODEX, deps)).toEqual({ available: true, how: "Codex's bubblewrap, which it carries with it" });
    expect(runs[0]?.command).toBe(CODEX);
    expect(runs[0]?.args).toEqual(["sandbox", "--", "true"]);
    expect(runs[0]?.env["CODEX_HOME"]).toBe("/scratch/eo-sandbox-check");
    expect(removed()).toBe(1);
  });

  it("is unavailable where its sandbox cannot start, without the warning Codex prints first", async () => {
    const output = "WARNING: proceeding, even though we could not create PATH aliases\nbwrap: No permissions to create a new namespace\n";
    const answer = await sandboxAvailability("codex", CODEX, machine({ executables: [CODEX], starts: false, output }).deps);

    if (answer?.available !== false) throw new Error("expected unavailable");
    expect(answer.reason).toBe("Codex could not start its sandbox on this machine: bwrap: No permissions to create a new namespace");
  });

  it("is unavailable, and starts nothing, where Codex is not installed", async () => {
    for (const path of [null, CODEX]) {
      const { deps, runs } = machine();
      const answer = await sandboxAvailability("codex", path, deps);
      if (answer?.available !== false) throw new Error("expected unavailable");
      expect(answer.reason).toMatch(/^Codex is not installed/);
      expect(answer.fix).toContain("Runtimes");
      expect(runs).toEqual([]);
    }
  });
});

describe("other platforms", () => {
  it.each(["claude", "codex"] as const)("offers %s's sandbox on macOS through Seatbelt", async (provider) => {
    const { deps, runs } = machine({ platform: "darwin", executables: ["/usr/bin/sandbox-exec", CODEX] });

    expect(await sandboxAvailability(provider, CODEX, deps)).toEqual({ available: true, how: "macOS's Seatbelt (sandbox-exec)" });
    expect(runs).toEqual([]);
  });

  it.each(["claude", "codex"] as const)("refuses %s's sandbox on Windows, where it has not been established", async (provider) => {
    const answer = await sandboxAvailability(provider, CODEX, machine({ platform: "win32", onPath: BOTH, executables: [CODEX] }).deps);

    if (answer?.available !== false) throw new Error("expected unavailable");
    expect(answer.reason).toContain("on Windows");
    expect(answer.fix).toContain("unsandboxed");
  });

  it("has nothing to say of a backend with no sandbox", async () => {
    expect(await sandboxAvailability("fake", null, machine().deps)).toBeNull();
    expect(await sandboxAvailability("scripted", null, machine().deps)).toBeNull();
  });
});
