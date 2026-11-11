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
