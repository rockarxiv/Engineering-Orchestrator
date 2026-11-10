import { LOCAL_PERSON_ID, SKILL_LOADED_EVENT, SKILLS_DELIVERED_EVENT, SKILLS_SETTLED_EVENT, skillState, type SkillAgeing, type Uuid } from "@eo/core";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import {
  appendRunEventAt,
  createProject,
  createRun,
  getSkill,
  listCommentsForItem,
  listSkills,
  listSkillVersions,
  restoreSkillVersion,
  saveSkill,
  setSkillLocked,
  skillArchiveOf,
} from "../db/repos/index.js";
import { skillUsageById, usageOfSkill } from "../db/repos/skillUsageRepo.js";
import { createTestItem, messagesFrom, openMigratedTestDb } from "../db/testHelpers.js";
import { findProjectThread } from "../projects/projectThread.js";
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

  /**
   * One line of a run, on a clock that moves a millisecond with every line:
   * a delivery written in the same millisecond as a load is not after it,
   * so on a fast machine it would not count.
   */
  let clock = Date.now() - 1_000_000;
  const line = (runId: Uuid, type: string, payload: unknown) => appendRunEventAt(handle.db, runId, { seq: 0, ts: (clock += 1) }, type, payload);

  /** `count` finished runs, each given these skills and settled; the last of them loading `loads`. */
  function runs(count: number, skillIds: string[], loads: string[] = []): void {
    for (let index = 0; index < count; index++) {
      const id = createRun(handle.db, { itemId, agentId: null, action: "implement", status: "succeeded" }).id;
      line(id, SKILLS_DELIVERED_EVENT, { type: SKILLS_DELIVERED_EVENT, skillIds, slugs: skillIds });
      if (index === count - 1) for (const skillId of loads) line(id, SKILL_LOADED_EVENT, { type: SKILL_LOADED_EVENT, skillId, slug: skillId });
      line(id, SKILLS_SETTLED_EVENT, { type: SKILLS_SETTLED_EVENT });
    }
  }

  /** One run given these skills that has not settled: `running`, or finished with its transcript cut short. */
  function unsettled(skillIds: string[], status: "running" | "succeeded"): Uuid {
    const id = createRun(handle.db, { itemId, agentId: null, action: "implement", status }).id;
    if (status === "succeeded") handle.db.run(sql`update runs set ended_at = ${Date.now()} where id = ${id}`);
    line(id, SKILLS_DELIVERED_EVENT, { type: SKILLS_DELIVERED_EVENT, skillIds, slugs: skillIds });
    return id;
  }

  const pass = (with_: SkillAgeing = ageing) => archiveUnusedSkills({ db: handle.db, projectId, reach: "all", ageing: with_ });
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

  it("counts only runs that have settled, and archives nothing a run still going was given", async () => {
    const id = skill("release", "agent");
    runs(4, [id]);
    // Finished, but its transcript is not all here: it may yet hold a load.
    unsettled([id], "succeeded");
    expect(usageOfSkill(skillUsageById(handle.db), id)).toMatchObject({ runsDelivered: 5, deliveriesSinceLoad: 4 });
    expect((await pass()).archived).toEqual([]);

    runs(1, [id]);
    // A run still going was given it, and may load it before it ends.
    const going = unsettled([id], "running");
    expect(usageOfSkill(skillUsageById(handle.db), id).deliveriesSinceLoad).toBe(5);
    expect((await pass()).archived).toEqual([]);
    expect(notes()).toEqual([]);

    // It did load it, and settled: the stretch starts again.
    line(going, SKILL_LOADED_EVENT, { type: SKILL_LOADED_EVENT, skillId: id, slug: id });
    line(going, SKILLS_SETTLED_EVENT, { type: SKILLS_SETTLED_EVENT });
    handle.db.run(sql`update runs set status = 'succeeded' where id = ${going}`);
    expect(usageOfSkill(skillUsageById(handle.db), id).deliveriesSinceLoad).toBe(0);
    expect((await pass()).archived).toEqual([]);
  });

  it("waits on a finished run that never settled however long ago it ended, until it settles", async () => {
    const id = skill("release", "agent");
    runs(5, [id]);
    const late = unsettled([id], "succeeded");
    handle.db.run(sql`update runs set ended_at = 1 where id = ${late}`);
    expect((await pass()).archived).toEqual([]);
    line(late, SKILLS_SETTLED_EVENT, { type: SKILLS_SETTLED_EVENT });
    expect((await pass()).archived.map((archived) => archived.id)).toEqual([id]);
  });

  it("archives only the global skills where the project's are another installation's to archive", async () => {
    const own = skill("release", "agent");
    const global = skill("format", "agent", null);
    runs(5, [own, global]);
    const result = await archiveUnusedSkills({ db: handle.db, projectId, reach: "global", ageing });
    expect(result.archived.map((archived) => archived.id)).toEqual([global]);
    expect(getSkill(handle.db, own)!.archivedAt).toBeNull();
    expect(notes()).toEqual([]);
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
    expect(await pass()).toEqual({ archived: [] });
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

  it("posts nothing for what a pass archives, and keeps on each archive that EO archived it after how many runs without a load (EO-728)", async () => {
    const first = skill("release", "agent");
    const second = skill("changelog", "agent");
    const global = skill("format", "agent", null);
    const elsewhere = skill("billing", "agent", otherProjectId);
    expect((await pass()).archived).toEqual([]);

    runs(5, [first, second, global, elsewhere]);
    runs(2, [first]);
    const result = await pass();
    expect(result.archived.map((archived) => archived.slug).sort()).toEqual(["changelog", "format", "release"]);
    // Another project's skill is that project's pass to archive.
    expect(getSkill(handle.db, elsewhere)!.archivedAt).toBeNull();

    // No project thread was opened, nor any comment written anywhere.
    expect(findProjectThread(handle.db, projectId)).toBeUndefined();
    expect(handle.db.all(sql`select id from comments`)).toEqual([]);

    const [archive] = listSkillVersions(handle.db, first);
    expect(archive).toMatchObject({ action: "archive", author: { kind: "eo" }, report: { kind: "unused", runsWithoutLoad: 7 } });
    expect(listSkillVersions(handle.db, second)[0]!.report).toEqual({ kind: "unused", runsWithoutLoad: 5 });
    // What the Skills screen shows on the archived skill, beside Restore.
    expect(skillArchiveOf(handle.db, getSkill(handle.db, first)!)).toEqual({ versionId: archive!.id, author: { kind: "eo" }, runsWithoutLoad: 7 });

    // Restoring the archive version brings it back, live, with its count started again.
    expect(restoreSkillVersion(handle.db, first, archive!.id).ok).toBe(true);
    expect(stateOf(first)).toBe("active");
    expect(skillArchiveOf(handle.db, getSkill(handle.db, first)!)).toBeNull();

    expect((await pass()).archived).toEqual([]);
  });

  it("sends one message about the project when a published section kept due skills, again only for a skill newly due, and never asks for the thread", async () => {
    const first = skill("release", "agent");
    const second = skill("changelog", "agent");
    const stop = markReplica(handle.db, () => true);
    const held = () => messagesFrom(handle.db, "skill_archival_held");
    const refused = (with_: SkillAgeing = ageing) => archiveUnusedSkills({ db: handle.db, projectId, reach: "all", ageing: with_ });
    try {
      publishSection(handle.db, { section: "packs", publishedAt: Date.now(), publishedBy: null, publishedByName: "Dana" });
      runs(5, [first]);
      runs(2, [second]);
      const told = await refused();
      expect(told).toMatchObject({ archived: [], told: true, problem: expect.stringContaining("published the packs section") });
      expect(getSkill(handle.db, first)!.archivedAt).toBeNull();
      expect(held()).toHaveLength(1);
      expect(held()[0]).toMatchObject({ recipientId: LOCAL_PERSON_ID, projectId, handledAt: null });
      expect(held()[0]!.body).toContain("`release`");

      // The same refusal is not said after every run.
      runs(1, [first]);
      expect(await refused()).toMatchObject({ told: false });
      expect(held()).toHaveLength(1);

      // Another skill falling due is.
      runs(3, [second]);
      await refused();
      expect(held()).toHaveLength(2);
      expect(held()[1]!.body).toContain("`changelog`");
      expect(findProjectThread(handle.db, projectId)).toBeUndefined();
    } finally {
      stop();
    }
  });

  it("says a held archive again on the next pass when its message could not be sent", async () => {
    const id = skill("release", "agent");
    const stop = markReplica(handle.db, () => true);
    try {
      publishSection(handle.db, { section: "packs", publishedAt: Date.now(), publishedBy: null, publishedByName: "Dana" });
      runs(5, [id]);
      const sent: string[] = [];
      let reachable = false;
      const passWith = () =>
        archiveUnusedSkills({
          db: handle.db,
          projectId,
          reach: "all",
          ageing,
          sendMessage: async (message) => {
            if (!reachable) return { ok: false, problem: "Your organisation's record could not be reached." };
            sent.push(message.body);
            return { ok: true, messages: [] };
          },
        });

      expect(await passWith()).toMatchObject({ told: false, problem: expect.stringContaining("could not be reached") });
      reachable = true;
      expect(await passWith()).toMatchObject({ told: true });
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain("`release`");
    } finally {
      stop();
    }
  });
});
