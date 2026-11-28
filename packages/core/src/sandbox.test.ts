import { describe, expect, it } from "vitest";
import { agentSandboxed, type Agent } from "./domain.js";
import { ipcContract } from "./ipc.js";
import { RepositoryViewSchema, UpdateRepositoryInputSchema } from "./ipc-schemas.js";
import { GitWorkspaceConfigSchema, isAbsoluteHostPath } from "./schemas/workspaces.js";

/**
 * The two settings a sandboxed agent is configured by (EO-934): the
 * agent's own, off by default, and its repository's extra writable
 * paths, empty by default and absolute only.
 */
describe("an agent's sandbox setting", () => {
  const save = ipcContract["agents:save"].request;
  const base = { name: "Implementer", role: "implementer", provider: "claude", instructions: "Do it." };

  it("is off for every agent until a person turns it on, and on only for a literal true", () => {
    for (const config of [{}, { sandboxed: false }, { sandboxed: null }, { sandboxed: "true" }]) expect(agentSandboxed({ config } as Pick<Agent, "config">)).toBe(false);
    expect(agentSandboxed({ config: { sandboxed: true } })).toBe(true);
  });

  it("crosses agents:save as a boolean, beside every other key of the open config", () => {
    expect(save.parse({ ...base, config: { sandboxed: true, allowedTools: ["Bash"] } }).config).toEqual({ sandboxed: true, allowedTools: ["Bash"] });
    // Null is how agent_save removes a key.
    expect(save.safeParse({ ...base, config: { sandboxed: null } }).success).toBe(true);
    expect(save.safeParse({ ...base, config: {} }).success).toBe(true);
  });

  it("refuses a value that is not a boolean, rather than reading it as off", () => {
    const parsed = save.safeParse({ ...base, config: { sandboxed: "yes" } });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(["config", "sandboxed"]);
  });
});

describe("a repository's extra writable paths", () => {
  it("are empty by default, for a repository saved before the setting existed", () => {
    expect(GitWorkspaceConfigSchema.parse({ name: "eo", repoPath: "/code/eo" }).extraWritablePaths).toEqual([]);
    expect(RepositoryViewSchema.shape.extraWritablePaths.parse(undefined)).toEqual([]);
  });

  it("take absolute paths on every platform, trimmed", () => {
    expect(UpdateRepositoryInputSchema.parse({ id: "r", extraWritablePaths: [" /home/me/.npm ", "C:\\Users\\me\\pnpm", "D:/cache", "\\\\server\\share"] }).extraWritablePaths).toEqual([
      "/home/me/.npm",
      "C:\\Users\\me\\pnpm",
      "D:/cache",
      "\\\\server\\share",
    ]);
  });

  it.each(["node_modules/.cache", "./store", "~/.npm", "C:relative", ""])("refuses %j, saying why", (path) => {
    const parsed = UpdateRepositoryInputSchema.safeParse({ id: "r", extraWritablePaths: [path] });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toMatch(/must be absolute|cannot be empty/);
    expect(GitWorkspaceConfigSchema.safeParse({ name: "eo", repoPath: "/code/eo", extraWritablePaths: [path] }).success).toBe(false);
  });

  it("says what is absolute the way each platform does", () => {
    expect(["/", "/a", "C:\\a", "c:/a", "\\\\host\\share"].every(isAbsoluteHostPath)).toBe(true);
    expect(["a", "./a", "~/a", "C:a", "\\a"].some(isAbsoluteHostPath)).toBe(false);
  });
});
