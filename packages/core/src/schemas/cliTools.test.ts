import { describe, expect, it } from "vitest";
import { CliToolDraftSchema, cliToolCommandProblem, readCliToolDraft } from "./cliTools.js";

describe("cliToolCommandProblem (EO-819)", () => {
  it("accepts a bare program name and an absolute path on either platform", () => {
    for (const command of ["gh", "kubectl", "terraform-1.9", "/usr/local/bin/gh", "C:\\Tools\\acme.exe", "C:/Tools/acme.exe"]) {
      expect(cliToolCommandProblem(command), command).toBeNull();
    }
  });

  it("refuses an empty command, arguments, a relative path and a control character", () => {
    expect(cliToolCommandProblem("")).toContain("needs the command");
    expect(cliToolCommandProblem("gh pr list")).toContain("has a space in it");
    expect(cliToolCommandProblem("./gh")).toContain("relative path");
    expect(cliToolCommandProblem("bin\\gh")).toContain("relative path");
    expect(cliToolCommandProblem("gh\u0000")).toContain("control character");
  });
});

describe("readCliToolDraft", () => {
  it("trims what it keeps, and defaults the description to empty", () => {
    expect(readCliToolDraft(CliToolDraftSchema.parse({ name: " GitHub CLI ", command: " gh " }))).toEqual({
      ok: true,
      name: "GitHub CLI",
      command: "gh",
      description: "",
    });
  });

  it("gathers every problem rather than stopping at the first", () => {
    const read = readCliToolDraft({ name: "", command: "gh pr", description: "x".repeat(501) });
    expect(read.ok).toBe(false);
    expect(read.ok ? [] : read.problems).toHaveLength(3);
  });
});
