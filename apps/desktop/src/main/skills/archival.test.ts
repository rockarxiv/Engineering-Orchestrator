import { SKILL_LOADED_EVENT, SKILLS_DELIVERED_EVENT, skillState, type SkillAgeing, type Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import {
  appendRunEvent,
  createProject,
  createRun,
  getSkill,
  listCommentsForItem,
  listSkills,
  listSkillVersions,
  restoreSkillVersion,
  saveSkill,
  setSkillLocked,
} from "../db/repos/index.js";
import { skillUsageById, usageOfSkill } from "../db/repos/skillUsageRepo.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { findProjectThread, openProjectThread } from "../projects/projectThread.js";
import { markReplica } from "../db/recordRole.js";
import { publishSection } from "../db/repos/publishedSectionsRepo.js";
import { archiveUnusedSkills } from "./archival.js";

/** Archiving the agent skills nobody loads (EO-720). */
describe("archiving unused agent skills", () => {
  let handle: DbHandle;
  let projectId: Uuid;
  let otherProjectId: Uuid;
  let itemId: Uuid;
  let runId: Uuid;
  const ageing: SkillAgeing = { staleAfterRuns: 3, archiveAfterRuns: 5 };

  beforeEach(() => {
    handle = openMigratedTestDb();
    projectId = createProject(handle.db, { name: "Shop", keyPrefix: "SHOP" }).id as Uuid;
    otherProjectId = createProject(handle.db, { name: "Admin", keyPrefix: "ADM" }).id as Uuid;
    itemId = createTestItem(handle.db, { type: "story", title: "Add CSV export", stepId: "todo", projectId }).id;
    runId = createRun(handle.db, { itemId, agentId: null, action: "implement", status: "succeeded" }).id;
  });
  afterEach(() => handle.close());

  function skill(slug: string, by: "agent" | "person", project: Uuid | null = projectId): string {
    const saved = saveSkill(
      handle.db,
      { slug, name: `Skill ${slug}`, description: `How to ${slug}.`, body: `Do ${slug}.`, files: [], ...(project === null ? {} : { scope: { kind: "project", projectId: project } }) },
      Date.now(),
      by === "agent" ? { kind: "run", runId } : { kind: "person" },
    );
    if (!saved.ok) throw new Error(saved.problems.join(" "));
    return saved.skill.id;
  }

  /** `count` runs, each given these skills; the last of them loading `loads`. */
  function runs(count: number, skillIds: string[], loads: string[] = []): void {
    for (let index = 0; index < count; index++) {
      const id = createRun(handle.db, { itemId, agentId: null, action: "implement", status: "succeeded" }).id;
      appendRunEvent(handle.db, id, SKILLS_DELIVERED_EVENT, { type: SKILLS_DELIVERED_EVENT, skillIds, slugs: skillIds });
      if (index === count - 1) for (const skillId of loads) appendRunEvent(handle.db, id, SKILL_LOADED_EVENT, { type: SKILL_LOADED_EVENT, skillId, slug: skillId });
    }
  }

  const pass = (with_: SkillAgeing = ageing) => archiveUnusedSkills({ db: handle.db, projectId, ageing: with_, projectThread: (id) => Promise.resolve(openProjectThread(handle.db, id)) });
  const stateOf = (id: string, with_: SkillAgeing = ageing) => skillState(getSkill(handle.db, id)!, usageOfSkill(skillUsageById(handle.db), id), with_);
  const notes = () => {
    const thread = findProjectThread(handle.db, projectId);
    return thread === undefined ? [] : listCommentsForItem(handle.db, thread.id);
  };

  it("marks an agent's skill stale at the stale count and archives it at the archive count, after which it is not delivered", async () => {
    const id = skill("release", "agent");
    runs(2, [id]);
    expect(stateOf(id)).toBe("active");
    runs(1, [id]);
    expect(stateOf(id)).toBe("stale");
    expect((await pass()).archived).toEqual([]);

    runs(2, [id]);
    const result = await pass();
    expect(result.archived.map((archived) => archived.id)).toEqual([id]);
    expect(stateOf(id)).toBe("archived");
    expect(listSkills(handle.db).map((live) => live.id)).not.toContain(id);
    const [newest] = listSkillVersions(handle.db, id);
    expect(newest).toMatchObject({ action: "archive", author: { kind: "eo" } });
  });

  it("makes a stale skill active again when a run loads it, and counts from zero", async () => {
    const id = skill("release", "agent");
    runs(4, [id]);
    expect(stateOf(id)).toBe("stale");
    runs(1, [id], [id]);
    expect(stateOf(id)).toBe("active");
    expect(usageOfSkill(skillUsageById(handle.db), id).deliveriesSinceLoad).toBe(0);
    runs(4, [id]);
    expect((await pass()).archived).toEqual([]);
    expect(stateOf(id)).toBe("stale");
  });

  it("never marks a person's skill or a locked skill stale, nor archives it, whatever its counts", async () => {
    const person = skill("deploy", "person");
    const locked = skill("triage", "agent");
    setSkillLocked(handle.db, locked, true);
    runs(20, [person, locked]);
    expect(stateOf(person)).toBe("active");
    expect(stateOf(locked)).toBe("active");
    expect(await pass()).toEqual({ archived: [], noteId: null });
    expect(getSkill(handle.db, person)!.archivedAt).toBeNull();
    expect(getSkill(handle.db, locked)!.archivedAt).toBeNull();
    expect(notes()).toEqual([]);
  });

  it("reads the thresholds on each pass, so a change takes effect on the next one", async () => {
    const id = skill("release", "agent");
    runs(5, [id]);
    expect((await pass({ staleAfterRuns: 10, archiveAfterRuns: 20 })).archived).toEqual([]);
    expect(stateOf(id, { staleAfterRuns: 10, archiveAfterRuns: 20 })).toBe("active");
    expect((await pass({ staleAfterRuns: 2, archiveAfterRuns: 4 })).archived.map((archived) => archived.id)).toEqual([id]);
  });

  it("brings an archived skill back as active with its count reset when it is restored", async () => {
    const id = skill("release", "agent");
    runs(5, [id]);
    await pass();
    const created = listSkillVersions(handle.db, id).find((version) => version.action === "create")!;
    expect(restoreSkillVersion(handle.db, id, created.id).ok).toBe(true);
    expect(stateOf(id)).toBe("active");
    expect(usageOfSkill(skillUsageById(handle.db), id).deliveriesSinceLoad).toBe(0);
    expect((await pass()).archived).toEqual([]);
  });

  it("posts exactly one note naming every skill a pass archived, and nothing for a pass that archives nothing", async () => {
    const first = skill("release", "agent");
    const second = skill("changelog", "agent");
    const global = skill("format", "agent", null);
    const elsewhere = skill("billing", "agent", otherProjectId);
    expect((await pass()).archived).toEqual([]);
    expect(notes()).toEqual([]);

    runs(5, [first, second, global, elsewhere]);
    const result = await pass();
    expect(result.archived.map((archived) => archived.slug).sort()).toEqual(["changelog", "format", "release"]);
    // Another project's skill is that project's pass to archive.
    expect(getSkill(handle.db, elsewhere)!.archivedAt).toBeNull();
    const posted = notes();
    expect(posted).toHaveLength(1);
    expect(posted[0]!.id).toBe(result.noteId);
    for (const slug of ["release", "changelog", "format"]) expect(posted[0]!.body).toContain(`\`${slug}\``);
    expect(posted[0]!.body).toContain("Restore");

    expect((await pass()).archived).toEqual([]);
    expect(notes()).toHaveLength(1);
  });

  it("archives nothing when the note cannot be written, and archives and tells on the next pass", async () => {
    const first = skill("release", "agent");
    const second = skill("changelog", "agent");
    runs(5, [first, second]);
    // A thread item this database has no row for: the note's insert fails
    // after both archives were written, inside the same transaction.
    const nowhere = { id: "019fb8c6-0000-7000-8000-00000000dead" } as never;
    await expect(archiveUnusedSkills({ db: handle.db, projectId, ageing, projectThread: () => Promise.resolve({ ok: true, item: nowhere }) })).rejects.toThrow();
    for (const id of [first, second]) {
      expect(getSkill(handle.db, id)!.archivedAt).toBeNull();
      expect(listSkillVersions(handle.db, id).map((version) => version.action)).toEqual(["create"]);
    }

    const result = await pass();
    expect(result.archived).toHaveLength(2);
    expect(notes()).toHaveLength(1);
  });

  it("says once on the project thread that a published section kept due skills, and again only for a skill newly due", async () => {
    const first = skill("release", "agent");
    const second = skill("changelog", "agent");
    const stop = markReplica(handle.db, () => true);
    try {
      publishSection(handle.db, { section: "packs", publishedAt: Date.now(), publishedBy: null, publishedByName: "Dana" });
      runs(5, [first]);
      runs(2, [second]);
      const told = await pass();
      expect(told).toMatchObject({ archived: [], problem: expect.stringContaining("published the packs section") });
      expect(getSkill(handle.db, first)!.archivedAt).toBeNull();
      expect(notes()).toHaveLength(1);
      expect(notes()[0]!.body).toContain("`release`");
      expect(notes()[0]!.id).toBe(told.noteId);

      // The same refusal is not said after every run.
      runs(1, [first]);
      expect((await pass()).noteId).toBeNull();
      expect(notes()).toHaveLength(1);

      // Another skill falling due is.
      runs(3, [second]);
      await pass();
      expect(notes()).toHaveLength(2);
      expect(notes()[1]!.body).toContain("`changelog`");
    } finally {
      stop();
    }
  });

  it("archives nothing when there is no project thread to say so on", async () => {
    const id = skill("release", "agent");
    runs(5, [id]);
    const result = await archiveUnusedSkills({ db: handle.db, projectId, ageing, projectThread: () => Promise.resolve({ ok: false, problem: "It is moving." }) });
    expect(result).toMatchObject({ archived: [], problem: expect.stringContaining("It is moving.") });
    expect(getSkill(handle.db, id)!.archivedAt).toBeNull();
  });
});
