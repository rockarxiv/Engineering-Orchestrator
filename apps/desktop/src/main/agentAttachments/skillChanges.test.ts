import { SKILLS_DELIVERED_EVENT, SkillDraftSchema, type Skill, type Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../db/client.js";
import { appendRunEvent, archiveSkill, createRun, getSkill, saveSkill, skillsDeliveredTo } from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { hasSkillChanges, skillChangesSection, skillChangesSince, skillChangeSlugs, withSkillChanges } from "./skillChanges.js";

/**
 * What a resumed turn is told about its skills (EO-919): worked out from
 * the previous run's `skills_delivered` and the skills' versions, never
 * stored.
 */
describe("skillChangesSince", () => {
  let handle: DbHandle;
  let runId: Uuid;

  beforeEach(() => {
    handle = openMigratedTestDb();
    vi.useFakeTimers({ toFake: ["Date"] });
    const item = createTestItem(handle.db, { type: "story", title: "T", stepId: "todo" });
    runId = createRun(handle.db, { itemId: item.id, agentId: null, action: "implement", status: "succeeded" }).id;
  });
  afterEach(() => {
    vi.useRealTimers();
    handle.close();
  });

  const skill = (name: string, at: number, body = "Read the diff."): Skill => {
    const saved = saveSkill(handle.db, SkillDraftSchema.parse({ name, description: `How to ${name}.`, body }), at);
    if (!saved.ok) throw new Error(saved.problems.join("\n"));
    return saved.skill;
  };
  const edit = (target: Skill, at: number, changes: Partial<Pick<Skill, "body" | "description" | "files" | "name">>): Skill => {
    const saved = saveSkill(handle.db, SkillDraftSchema.parse({ id: target.id, name: target.name, description: target.description, body: target.body, files: target.files, ...changes }), at);
    if (!saved.ok) throw new Error(saved.problems.join("\n"));
    return saved.skill;
  };
  /** The previous run is handed these skills at `at`, as `recordSkillUsage` writes it. */
  const deliveredAt = (at: number, skills: readonly Skill[]) => {
    vi.setSystemTime(at);
    appendRunEvent(handle.db, runId, SKILLS_DELIVERED_EVENT, { type: SKILLS_DELIVERED_EVENT, skillIds: skills.map((s) => s.id), slugs: skills.map((s) => s.slug) });
  };

  it("reads what the previous run was given, and when", () => {
    const style = skill("house-style", 1_000);
    deliveredAt(2_000, [style]);
    expect(skillsDeliveredTo(handle.db, runId)).toEqual({ skillIds: [style.id], slugs: ["house-style"], at: 2_000 });
  });

  it("is nothing when the skills are the ones the previous run was given", () => {
    const style = skill("house-style", 1_000);
    deliveredAt(2_000, [style]);
    const changes = skillChangesSince(handle.db, runId, [style]);
    expect(hasSkillChanges(changes)).toBe(false);
    expect(skillChangesSection(changes)).toBe("");
    expect(withSkillChanges("carry on", changes)).toBe("carry on");
  });

  it("lists a skill whose body was edited after the previous run was given it as changed", () => {
    const style = skill("house-style", 1_000);
    deliveredAt(2_000, [style]);
    const edited = edit(style, 3_000, { body: "Read the diff twice." });
    expect(skillChangesSince(handle.db, runId, [edited])).toEqual({ added: [], changed: [{ slug: "house-style", name: "house-style", description: "How to house-style." }], removed: [] });
  });

  it("lists an edited description or supporting file as a change, with the description as it is now", () => {
    const style = skill("house-style", 1_000);
    const review = skill("review", 1_000);
    deliveredAt(2_000, [style, review]);
    const described = edit(style, 3_000, { description: "The new way." });
    const filed = edit(review, 3_000, { files: [{ path: "checklist.md", content: "- one" }] });
    const changes = skillChangesSince(handle.db, runId, [described, filed]);
    expect(changes.changed).toEqual([
      { slug: "house-style", name: "house-style", description: "The new way." },
      { slug: "review", name: "review", description: "How to review." },
    ]);
  });

  it("does not list a save that wrote the same words again, or an edit made before the previous run was given it", () => {
    const style = skill("house-style", 1_000);
    const earlier = edit(style, 1_500, { body: "Read the diff twice." });
    deliveredAt(2_000, [earlier]);
    const same = edit(earlier, 3_000, {});
    expect(hasSkillChanges(skillChangesSince(handle.db, runId, [same]))).toBe(false);
  });

  it("lists a skill created since as added", () => {
    const style = skill("house-style", 1_000);
    deliveredAt(2_000, [style]);
    const fresh = skill("e2e", 3_000);
    expect(skillChangesSince(handle.db, runId, [fresh, style])).toEqual({ added: [{ slug: "e2e", name: "e2e", description: "How to e2e." }], changed: [], removed: [] });
  });

  it("lists a skill archived since as removed, by the name and description it had", () => {
    const style = skill("house-style", 1_000);
    const review = skill("review", 1_000);
    deliveredAt(2_000, [style, review]);
    archiveSkill(handle.db, review.id, 3_000);
    expect(getSkill(handle.db, review.id)?.archivedAt).toBe(3_000);
    expect(skillChangesSince(handle.db, runId, [style])).toEqual({ added: [], changed: [], removed: [{ slug: "review", name: "review", description: "How to review." }] });
  });

  it("lists everything as added after a run that was given none", () => {
    const style = skill("house-style", 1_000);
    expect(skillChangesSince(handle.db, runId, [style]).added.map((s) => s.slug)).toEqual(["house-style"]);
  });

  it("gives the slugs the run's skills_delivered records", () => {
    const style = skill("house-style", 1_000);
    const review = skill("review", 1_000);
    deliveredAt(2_000, [style, review]);
    const edited = edit(style, 3_000, { body: "New." });
    const fresh = skill("e2e", 3_000);
    expect(skillChangeSlugs(skillChangesSince(handle.db, runId, [fresh, edited]))).toEqual({ added: ["e2e"], changed: ["house-style"], removed: ["review"] });
  });
});

describe("skillChangesSection", () => {
  const changes = {
    added: [{ slug: "e2e", name: "End to end", description: "How to run\nthe e2e suite." }],
    changed: [{ slug: "house-style", name: "House style", description: "The house style." }],
    removed: [{ slug: "review", name: "Review", description: "" }],
  };

  it("lists the skills added, changed and removed, each by slug, name and description", () => {
    const section = skillChangesSection(changes);
    expect(section).toContain("## Your skills have changed");
    expect(section).toContain("- `e2e` (End to end) — How to run the e2e suite.");
    expect(section).toContain("- `house-style` (House style) — The house style.");
    expect(section).toContain("- `review` (Review)");
  });

  it("says a changed skill must be loaded again and a removed one is no longer available", () => {
    const section = skillChangesSection(changes);
    expect(section).toMatch(/Changed — .*Load a changed skill again to see its current text/);
    expect(section).toMatch(/Removed — these are no longer available/);
  });

  it("leaves out a heading with nothing under it", () => {
    const section = skillChangesSection({ added: [], changed: changes.changed, removed: [] });
    expect(section).not.toContain("Added —");
    expect(section).not.toContain("Removed —");
  });

  it("names no backend's tool, so one wording serves both (invariant 12)", () => {
    const section = skillChangesSection(changes);
    expect(section).not.toMatch(/skill_read|Skill tool|eo-attachments|SKILL\.md/);
  });

  it("comes after the message it is added to", () => {
    expect(withSkillChanges("carry on", changes).startsWith("carry on\n\n## Your skills have changed")).toBe(true);
  });
});
