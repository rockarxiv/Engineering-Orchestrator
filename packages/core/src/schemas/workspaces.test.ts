import { describe, expect, it } from "vitest";
import { GitWorkspaceConfigSchema, normaliseReviewers } from "./workspaces.js";

describe("normaliseReviewers (EO-741)", () => {
  it("trims, drops blanks and keeps the first of each repeat, in order", () => {
    expect(normaliseReviewers([" alice ", "", "bob", "alice", "  ", "acme/backend"])).toEqual({ ok: true, reviewers: ["alice", "bob", "acme/backend"] });
  });

  it("refuses the whole list for an entry with whitespace or a comma inside it, naming that entry", () => {
    for (const bad of ["alice smith", "alice,bob", "alice\tbob"]) {
      const result = normaliseReviewers(["carol", ` ${bad} `]);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.problem).toContain(`"${bad}"`);
    }
  });

  it("reads a workspace written before the field as having no reviewers", () => {
    expect(GitWorkspaceConfigSchema.parse({ name: "api", repoPath: "/code/api" }).forgeReviewers).toEqual([]);
  });
});

describe("a repository's check timeout (EO-928)", () => {
  it("is ten minutes on a repository that names none", () => {
    expect(GitWorkspaceConfigSchema.parse({ name: "api", repoPath: "/code/api" }).checkTimeoutMinutes).toBe(10);
  });

  it("keeps any whole number of minutes from 1 to 120", () => {
    for (const minutes of [1, 45, 120]) {
      expect(GitWorkspaceConfigSchema.parse({ name: "api", repoPath: "/code/api", checkTimeoutMinutes: minutes }).checkTimeoutMinutes).toBe(minutes);
    }
  });

  it("refuses anything else, with the bounds in the message", () => {
    for (const minutes of [0, 121, 1.5, "10"]) {
      const parsed = GitWorkspaceConfigSchema.safeParse({ name: "api", repoPath: "/code/api", checkTimeoutMinutes: minutes });
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues.map((issue) => issue.message)).toEqual(["A check timeout is a whole number of minutes from 1 to 120."]);
    }
  });
});
