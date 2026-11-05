import { sql } from "drizzle-orm";
import { SkillDraftSchema, uuidv7, type SkillDraft, type SkillScope } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../client.js";
import { openMigratedTestDb } from "../testHelpers.js";
import { archiveSkill, getSkill, getSkillBySlug, listSkills, readProjectSkills, saveSkill, setSkillEnabled, upsertReplicaSkill, writeMovedSkill } from "./skillsRepo.js";

/**
 * The skill catalogue's rows (EO-105).
 *
 * Against the real migrations in an in-memory database, so a column this
 * repository writes and a column the migration creates cannot drift
 * apart without a test noticing.
 */
function draft(overrides: Partial<SkillDraft> & { name: string }): SkillDraft {
  return SkillDraftSchema.parse({ description: "Reviews a pull request.", body: "Read the whole diff.", ...overrides });
}

let handle: DbHandle;

beforeEach(() => {
  handle = openMigratedTestDb();
});

afterEach(() => {
  handle.close();
});

describe("saveSkill", () => {
  it("creates a skill and reads it back whole", () => {
    const saved = saveSkill(handle.db, draft({ name: "PR review" }));

    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(getSkill(handle.db, saved.skill.id)).toEqual({
      id: saved.skill.id,
      // Allocated from the display name, not copied from it: the slug is
      // the only identifier a model can invoke (MUL-5529).
      slug: "pr-review",
      name: "PR review",
      description: "Reviews a pull request.",
      body: "Read the whole diff.",
      files: [],
      disableModelInvocation: false,
      enabled: true,
      scope: { kind: "global" },
      createdAt: expect.any(Number),
      updatedAt: expect.any(Number),
      archivedAt: null,
    });
  });

  it("round-trips a body and its supporting files", () => {
    const files = [
      { path: "checklist.md", content: "- [ ] read the whole diff\n- [ ] check the tests" },
      { path: "snippets/query.sql", content: "select 1;\n" },
    ];

    const saved = saveSkill(handle.db, draft({ name: "PR review", body: "# How to review\n\nSee `checklist.md`.", files }));

    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    const read = getSkill(handle.db, saved.skill.id);
    expect(read?.body).toBe("# How to review\n\nSee `checklist.md`.");
    expect(read?.files).toEqual(files);
  });

  it("keeps a slug somebody chose, and refuses one another skill has", () => {
    const chosen = saveSkill(handle.db, draft({ name: "PR review", slug: "deep-review" }));
    expect(chosen.ok && chosen.skill.slug).toBe("deep-review");

    const clash = saveSkill(handle.db, draft({ name: "Something else", slug: "deep-review" }));

    expect(clash.ok).toBe(false);
    if (clash.ok) return;
    // Refused rather than resolved. Silently handing back
    // `deep-review-2` gives a person an identifier they will not put in
    // the prompt they were about to write.
    expect(clash.problems.join(" ")).toContain('already uses the slug "deep-review"');
  });

  it("allocates around what the catalogue has already spent, archived rows included", () => {
    const first = saveSkill(handle.db, draft({ name: "PR review" }));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(archiveSkill(handle.db, first.skill.id)).toBe(true);

    const second = saveSkill(handle.db, draft({ name: "PR review" }));

    // The unique index does not care whether a row is archived, so
    // neither may the allocator.
    expect(second.ok && second.skill.slug).toBe("pr-review-2");
  });

  it("edits a skill in place without renaming it", () => {
    const created = saveSkill(handle.db, draft({ name: "PR review" }));
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const edited = saveSkill(handle.db, draft({ id: created.skill.id, name: "Deep PR review", body: "Read it twice." }));

    expect(edited.ok && edited.skill.id).toBe(created.skill.id);
    expect(edited.ok && edited.skill.name).toBe("Deep PR review");
    // The slug is what a model invokes, so a rename is never a side
    // effect of fixing a typo — the display name changed and the
    // identifier did not.
    expect(edited.ok && edited.skill.slug).toBe("pr-review");
    expect(listSkills(handle.db)).toHaveLength(1);
  });

  it("lets a skill keep its own slug across an edit", () => {
    const created = saveSkill(handle.db, draft({ name: "PR review", slug: "deep-review" }));
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(saveSkill(handle.db, draft({ id: created.skill.id, name: "PR review", slug: "deep-review", body: "New body." })).ok).toBe(true);
  });

  it("stores and reports a skill marked disable-model-invocation", () => {
    const saved = saveSkill(handle.db, draft({ name: "Release notes", disableModelInvocation: true }));

    expect(saved.ok && saved.skill.disableModelInvocation).toBe(true);
    expect(saved.ok && getSkill(handle.db, saved.skill.id)?.disableModelInvocation).toBe(true);
    // On disk and not offered to the model is not the same as not
    // delivered: the skill is still enabled.
    expect(saved.ok && saved.skill.enabled).toBe(true);
  });

  it("leaves both switches alone when a save does not mention them", () => {
    const saved = saveSkill(handle.db, draft({ name: "PR review", disableModelInvocation: true }));
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    setSkillEnabled(handle.db, saved.skill.id, false);

    const edited = saveSkill(handle.db, draft({ id: saved.skill.id, name: "PR review", body: "Read it twice." }));

    // Nothing about editing a body says anything about being offered.
    expect(edited.ok && edited.skill.enabled).toBe(false);
    expect(edited.ok && edited.skill.disableModelInvocation).toBe(true);
  });

  /**
   * A refusal, never a throw. Everything here is something a person
   * typed, and throwing is for programmer error — the repository applies
   * the same check the boundary does so a caller that reaches it
   * directly cannot write a row `SkillSchema` would refuse to read back.
   */
  it("refuses a malformed skill without throwing", () => {
    const malformed = draft({ name: "PR review", description: "", files: [{ path: "../escape.md", content: "" }] });

    expect(() => saveSkill(handle.db, malformed)).not.toThrow();
    expect(saveSkill(handle.db, malformed).ok).toBe(false);
    expect(listSkills(handle.db)).toEqual([]);
  });

  it("refuses to edit a skill that is not there", () => {
    const missing = saveSkill(handle.db, draft({ id: "019fb8c6-0000-7000-8000-00000000beef", name: "PR review" }));

    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.problems.join(" ")).toContain("No skill");
  });
});

describe("listing, enabling and archiving", () => {
  it("lists live skills by slug and leaves archived ones out until asked", () => {
    const first = saveSkill(handle.db, draft({ name: "Zed notes" }));
    saveSkill(handle.db, draft({ name: "Atlas notes" }));
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    expect(listSkills(handle.db).map((skill) => skill.slug)).toEqual(["atlas-notes", "zed-notes"]);

    expect(archiveSkill(handle.db, first.skill.id)).toBe(true);

    expect(listSkills(handle.db).map((skill) => skill.slug)).toEqual(["atlas-notes"]);
    // Archived, not deleted: whatever attached it still has something to
    // point at (invariant #3).
    expect(listSkills(handle.db, true).map((skill) => skill.slug)).toEqual(["atlas-notes", "zed-notes"]);
    expect(getSkillBySlug(handle.db, "zed-notes")?.archivedAt).toEqual(expect.any(Number));
  });

  it("turns a skill off and on again without touching what it says", () => {
    const saved = saveSkill(handle.db, draft({ name: "PR review", files: [{ path: "checklist.md", content: "- read it" }] }));
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;

    expect(setSkillEnabled(handle.db, saved.skill.id, false)).toBe(true);
    expect(getSkill(handle.db, saved.skill.id)?.enabled).toBe(false);
    // Disabled is a switch, not an archive: the row is still live.
    expect(listSkills(handle.db)).toHaveLength(1);

    expect(setSkillEnabled(handle.db, saved.skill.id, true)).toBe(true);
    expect(getSkill(handle.db, saved.skill.id)?.files).toEqual([{ path: "checklist.md", content: "- read it" }]);
  });

  it("says no rather than throwing when the skill is gone", () => {
    expect(setSkillEnabled(handle.db, "019fb8c6-0000-7000-8000-00000000beef", false)).toBe(false);
    expect(archiveSkill(handle.db, "019fb8c6-0000-7000-8000-00000000beef")).toBe(false);
  });
});

/**
 * A skill as the organisation published it (EO-329, ARCHITECTURE.md, "Publish, lock and versions").
 *
 * The write a *replica* takes, which is a different job from
 * `saveSkill`: there is no person here for a validation problem to be a
 * sentence for, the row keeps the record's own id because an attachment
 * names it by id, and the one thing in the way is the unique slug.
 */
describe("upsertReplicaSkill", () => {
  function published(overrides: Partial<Parameters<typeof upsertReplicaSkill>[1]> = {}) {
    return {
      id: "019fb8c6-0000-7000-8000-00000000aaaa",
      slug: "release-notes",
      name: "Release notes",
      description: "How this organisation writes them.",
      body: "Lead with what changed.",
      files: [],
      disableModelInvocation: false,
      enabled: true,
      scope: { kind: "global" } as SkillScope,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      archivedAt: null,
      ...overrides,
    };
  }

  it("writes the record's row by the record's id, and writes it again on a later publish", () => {
    upsertReplicaSkill(handle.db, published());
    expect(getSkill(handle.db, "019fb8c6-0000-7000-8000-00000000aaaa")).toMatchObject({ slug: "release-notes", body: "Lead with what changed." });

    upsertReplicaSkill(handle.db, published({ body: "Lead with the fix.", updatedAt: 1_700_000_001_000 }));
    expect(getSkill(handle.db, "019fb8c6-0000-7000-8000-00000000aaaa")?.body).toBe("Lead with the fix.");
    expect(listSkills(handle.db, true)).toHaveLength(1);
  });

  it("keeps the scope the organisation published, and moves it when they do (EO-470)", () => {
    upsertReplicaSkill(handle.db, published({ scope: { kind: "project", projectId: "p-1" } }));
    expect(getSkill(handle.db, "019fb8c6-0000-7000-8000-00000000aaaa")?.scope).toEqual({ kind: "project", projectId: "p-1" });

    upsertReplicaSkill(handle.db, published({ scope: { kind: "global" } }));
    expect(getSkill(handle.db, "019fb8c6-0000-7000-8000-00000000aaaa")?.scope).toEqual({ kind: "global" });
  });

  it("stands a local skill of the same slug aside rather than colliding with it", () => {
    const mine = saveSkill(handle.db, draft({ name: "Release notes", slug: "release-notes" }));
    expect(mine.ok).toBe(true);
    if (!mine.ok) return;

    upsertReplicaSkill(handle.db, published());

    // The organisation's row holds the slug, which is what a model
    // invokes and what the unique index protects.
    expect(getSkillBySlug(handle.db, "release-notes")?.id).toBe("019fb8c6-0000-7000-8000-00000000aaaa");
    // Mine is archived rather than deleted — an attachment, a run and a
    // transcript all still name it — and no longer answers to the slug.
    const stood = getSkill(handle.db, mine.skill.id);
    expect(stood?.archivedAt).not.toBeNull();
    expect(stood?.slug).not.toBe("release-notes");
    expect(stood?.enabled).toBe(false);
  });
});

describe("scopes (EO-470)", () => {
  it("makes a new skill global unless it is told otherwise", () => {
    const saved = saveSkill(handle.db, draft({ name: "PR review" }));
    expect(saved.ok && saved.skill.scope).toEqual({ kind: "global" });
  });

  it("saves a project or a workspace scope and reads it back", () => {
    const forProject = saveSkill(handle.db, draft({ name: "E2E", scope: { kind: "project", projectId: "p-1" } }));
    const forWorkspace = saveSkill(handle.db, draft({ name: "Build", scope: { kind: "workspace", workspaceId: "w-1" } }));
    expect(forProject.ok && getSkill(handle.db, forProject.skill.id)?.scope).toEqual({ kind: "project", projectId: "p-1" });
    expect(forWorkspace.ok && getSkill(handle.db, forWorkspace.skill.id)?.scope).toEqual({ kind: "workspace", workspaceId: "w-1" });
  });

  it("changes a scope on an edit that names one, and keeps it on an edit that does not", () => {
    const saved = saveSkill(handle.db, draft({ name: "E2E", scope: { kind: "project", projectId: "p-1" } }));
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;

    // A form that fixes a typo says nothing about scope, and must not
    // move a project's skill back to global.
    saveSkill(handle.db, draft({ id: saved.skill.id, name: "E2E", body: "Run it with xvfb." }));
    expect(getSkill(handle.db, saved.skill.id)?.scope).toEqual({ kind: "project", projectId: "p-1" });

    saveSkill(handle.db, draft({ id: saved.skill.id, name: "E2E", scope: { kind: "workspace", workspaceId: "w-9" } }));
    expect(getSkill(handle.db, saved.skill.id)?.scope).toEqual({ kind: "workspace", workspaceId: "w-9" });

    saveSkill(handle.db, draft({ id: saved.skill.id, name: "E2E", scope: { kind: "global" } }));
    expect(getSkill(handle.db, saved.skill.id)?.scope).toEqual({ kind: "global" });
  });
});

describe("the project a scoped skill belongs to (EO-513)", () => {
  function projectOf(id: string): string | null {
    return handle.db.get<{ projectId: string | null }>(sql`SELECT project_id AS projectId FROM skills WHERE id = ${id}`)?.projectId ?? null;
  }

  it("keeps a moved workspace's skill on its project when it is edited where the workspace is not", () => {
    // The record: it holds the skill a move wrote, never the workspace.
    const moved = { id: uuidv7(), slug: "fixtures", name: "Fixtures", description: "Where fixtures live.", body: "./fixtures", files: [], disableModelInvocation: false, enabled: true, scope: { kind: "workspace" as const, workspaceId: "ws-elsewhere" }, createdAt: 1, updatedAt: 1, archivedAt: null, projectId: "proj-moved" };
    writeMovedSkill(handle.db, moved, "proj-moved");

    const edited = saveSkill(handle.db, draft({ id: moved.id, name: "Fixtures", body: "./test/fixtures" }));

    expect(edited.ok).toBe(true);
    expect(projectOf(moved.id)).toBe("proj-moved");
    expect(readProjectSkills(handle.db, "proj-moved").map((skill) => skill.body)).toEqual(["./test/fixtures"]);
  });

  it("is nothing for a global skill, which no project's move carries", () => {
    const saved = saveSkill(handle.db, draft({ name: "PR review" }));
    if (!saved.ok) throw new Error(saved.problems.join("\n"));

    expect(projectOf(saved.skill.id)).toBeNull();
  });
});
