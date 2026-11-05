import { describe, expect, it } from "vitest";
import { SkillDraftSchema, SkillSchema, readSkillDraft, skillInRunScope, skillsForRun, type SkillDraft, type SkillScope } from "./skills.js";

/**
 * What a skill draft has to be before anything writes it (EO-105).
 *
 * Pure, and applied by the repository as well as by the IPC boundary —
 * these are the sentences a person sees, so they are asserted as
 * sentences.
 */
function draft(overrides: Partial<SkillDraft> = {}): SkillDraft {
  return SkillDraftSchema.parse({ name: "PR review", description: "Reviews a pull request.", body: "Read the whole diff.", ...overrides });
}

describe("readSkillDraft", () => {
  it("reads a well-formed draft and leaves the slug for the caller to decide", () => {
    const read = readSkillDraft(draft());

    expect(read).toEqual({
      ok: true,
      // Null means "decide one" — `saveSkill` asks `allocateSkillSlugs`
      // with the slugs the catalogue has already spent.
      slug: null,
      name: "PR review",
      description: "Reviews a pull request.",
      body: "Read the whole diff.",
      files: [],
      disableModelInvocation: undefined,
      enabled: undefined,
      scope: undefined,
    });
  });

  it("keeps a slug somebody chose", () => {
    expect(readSkillDraft(draft({ slug: "deep-review" }))).toMatchObject({ ok: true, slug: "deep-review" });
    // Whitespace around it is typing, not a choice.
    expect(readSkillDraft(draft({ slug: "  deep-review  " }))).toMatchObject({ ok: true, slug: "deep-review" });
  });

  it("refuses a slug that is not one, and suggests the one it meant", () => {
    const read = readSkillDraft(draft({ slug: "Deep Review" }));

    expect(read.ok).toBe(false);
    if (read.ok) return;
    // Suggested rather than applied: the slug is what a model invokes,
    // so rewriting it under somebody who typed one changes the
    // identifier they are about to put in a prompt.
    expect(read.problems.join(" ")).toContain('"deep-review"');
    expect(read.problems.join(" ")).toContain("only name a model can invoke");
  });

  it("says everything that is wrong at once", () => {
    const read = readSkillDraft(draft({ name: "  ", description: "", body: "\n", slug: "NOPE" }));

    expect(read.ok).toBe(false);
    if (read.ok) return;
    // A person fixing a form one refusal per save is playing a guessing
    // game with a dialog box.
    expect(read.problems).toHaveLength(4);
  });

  it("keeps supporting files and trims their paths", () => {
    const read = readSkillDraft(draft({ files: [{ path: " checklist.md ", content: "- read it" }, { path: "snippets/query.sql", content: "select 1" }] }));

    expect(read).toMatchObject({ ok: true, files: [{ path: "checklist.md", content: "- read it" }, { path: "snippets/query.sql", content: "select 1" }] });
  });

  it("refuses a path that climbs out of the skill's own folder", () => {
    // These are written under a directory EO generates (EO-107). A path
    // that escapes it writes somewhere nobody asked for.
    for (const path of ["../escape.md", "notes/../../escape.md", "/etc/passwd", "C:\\Windows\\system.ini", "./here.md"]) {
      expect(readSkillDraft(draft({ files: [{ path, content: "" }] })).ok).toBe(false);
    }
  });

  it("refuses a supporting file trying to be the skill's own file", () => {
    const read = readSkillDraft(draft({ files: [{ path: "SKILL.md", content: "surprise" }] }));

    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.problems.join(" ")).toContain("its body is what goes there");
  });

  it("refuses the same path twice", () => {
    const read = readSkillDraft(draft({ files: [{ path: "a.md", content: "one" }, { path: "a.md", content: "two" }] }));

    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.problems.join(" ")).toContain("listed twice");
  });

  it("carries the two switches through untouched when they were set", () => {
    expect(readSkillDraft(draft({ disableModelInvocation: true, enabled: false }))).toMatchObject({
      ok: true,
      disableModelInvocation: true,
      enabled: false,
    });
  });

  it("refuses rather than throwing, whatever it is handed", () => {
    expect(() => readSkillDraft(draft({ name: "", slug: "!!!", files: [{ path: "..", content: "" }] }))).not.toThrow();
  });
});

describe("skill scopes (EO-470)", () => {
  const P = "project-p";
  const W = "workspace-w";
  const onPInW = { projectId: P, workspaceId: W };

  it("delivers a global skill to every run, one with no project or workspace included", () => {
    expect(skillInRunScope({ kind: "global" }, onPInW)).toBe(true);
    expect(skillInRunScope({ kind: "global" }, { projectId: null, workspaceId: null })).toBe(true);
  });

  it("delivers a project skill only to runs on that project", () => {
    expect(skillInRunScope({ kind: "project", projectId: P }, onPInW)).toBe(true);
    expect(skillInRunScope({ kind: "project", projectId: "another" }, onPInW)).toBe(false);
    expect(skillInRunScope({ kind: "project", projectId: P }, { projectId: null, workspaceId: W })).toBe(false);
  });

  it("delivers a workspace skill only to runs whose step works in that workspace", () => {
    expect(skillInRunScope({ kind: "workspace", workspaceId: W }, onPInW)).toBe(true);
    expect(skillInRunScope({ kind: "workspace", workspaceId: "another" }, onPInW)).toBe(false);
    expect(skillInRunScope({ kind: "workspace", workspaceId: W }, { projectId: P, workspaceId: null })).toBe(false);
  });

  it("filters a list to the run's scope, and an absent run scope to global skills only", () => {
    const skills: { slug: string; scope: SkillScope }[] = [
      { slug: "everywhere", scope: { kind: "global" } },
      { slug: "for-p", scope: { kind: "project", projectId: P } },
      { slug: "for-q", scope: { kind: "project", projectId: "q" } },
      { slug: "in-w", scope: { kind: "workspace", workspaceId: W } },
      { slug: "in-v", scope: { kind: "workspace", workspaceId: "v" } },
    ];
    expect(skillsForRun(skills, onPInW).map((skill) => skill.slug)).toEqual(["everywhere", "for-p", "in-w"]);
    expect(skillsForRun(skills, undefined).map((skill) => skill.slug)).toEqual(["everywhere"]);
  });

  it("reads a skill published before scopes existed as global", () => {
    const parsed = SkillSchema.parse({
      id: "s",
      slug: "old",
      name: "Old",
      description: "d",
      body: "b",
      files: [],
      disableModelInvocation: false,
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
      archivedAt: null,
    });
    expect(parsed.scope).toEqual({ kind: "global" });
  });

  it("carries a draft's scope through, and leaves an absent one absent", () => {
    expect(readSkillDraft(draft({ scope: { kind: "project", projectId: P } }))).toMatchObject({ ok: true, scope: { kind: "project", projectId: P } });
    expect(readSkillDraft(draft())).toMatchObject({ ok: true, scope: undefined });
  });

  it("refuses a scoped draft that names no project or workspace", () => {
    expect(SkillDraftSchema.safeParse({ name: "a", description: "b", body: "c", scope: { kind: "project", projectId: "" } }).success).toBe(false);
  });
});
