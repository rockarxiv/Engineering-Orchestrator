import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SKILLS_DELIVERED_EVENT, SkillDraftSchema, type Skill, type SkillGivenBefore, type Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { appendRunEvent, archiveSkill, createRun, saveSkill, skillsGivenBefore } from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { toolDirectorySkills, writeToolDirectory } from "./pluginDirectory.js";
import { hasSkillChanges, skillChangesBetween, skillChangesSection, skillChangeSlugs, type DeliveredSkill } from "./skillChanges.js";
import { deliveredSkillOf } from "./worktreeSkills.js";

/**
 * What a resumed turn is told about its skills (EO-919): worked out by the
 * adapter from what the run before was given — the hash of what each
 * skill said as it was delivered — and what it delivers now. Never from
 * when anything was written, so an edit that lands between a delivery
 * and its record, or in the same millisecond, cannot be missed.
 */
describe("skillChangesBetween", () => {
  let handle: DbHandle;

  beforeEach(() => {
    handle = openMigratedTestDb();
  });
  afterEach(() => handle.close());

  const skill = (name: string, body = "Read the diff."): Skill => {
    const saved = saveSkill(handle.db, SkillDraftSchema.parse({ name, description: `How to ${name}.`, body }), 1_000);
    if (!saved.ok) throw new Error(saved.problems.join("\n"));
    return saved.skill;
  };
  const edit = (target: Skill, changes: Partial<Pick<Skill, "body" | "description" | "files" | "name">>): Skill => {
    const saved = saveSkill(handle.db, SkillDraftSchema.parse({ id: target.id, name: target.name, description: target.description, body: target.body, files: target.files, ...changes }), 1_000);
    if (!saved.ok) throw new Error(saved.problems.join("\n"));
    return saved.skill;
  };
  /** What the run before recorded, as `skillsGivenBefore` reads it back. */
  const given = (...skills: Skill[]): SkillGivenBefore[] => skills.map((one) => ({ ...deliveredSkillOf(one) }));
  const now = (...skills: Skill[]): DeliveredSkill[] => skills.map(deliveredSkillOf);

  it("is nothing when the skills say what they said", () => {
    const style = skill("house-style");
    const changes = skillChangesBetween(given(style), now(style));
    expect(hasSkillChanges(changes)).toBe(false);
    expect(skillChangesSection(changes)).toBe("");
  });

  it("lists a skill as changed when its body, description, name or files differ from what was delivered", () => {
    const style = skill("house-style");
    for (const change of [{ body: "Read it twice." }, { description: "Else." }, { name: "House Style" }, { files: [{ path: "checklist.md", content: "- one" }] }]) {
      expect(skillChangesBetween(given(style), now(edit(style, change))).changed.map((one) => one.slug)).toEqual(["house-style"]);
    }
  });

  it("is no change when a save wrote the same words again", () => {
    const style = skill("house-style");
    expect(hasSkillChanges(skillChangesBetween(given(style), now(edit(style, {}))))).toBe(false);
  });

  it("lists a skill as changed after a delivery that recorded no hash, as one from before EO-919 did not", () => {
    const style = skill("house-style");
    expect(skillChangesBetween([{ ...deliveredSkillOf(style), contentHash: null }], now(style)).changed.map((one) => one.slug)).toEqual(["house-style"]);
  });

  it("lists a skill created since as added and one gone as removed, each by slug, name and description", () => {
    const style = skill("house-style");
    const review = skill("review");
    const e2e = skill("e2e");
    expect(skillChangesBetween(given(style, review), now(e2e, style))).toEqual({
      added: [{ slug: "e2e", name: "e2e", description: "How to e2e." }],
      changed: [],
      removed: [{ slug: "review", name: "review", description: "How to review." }],
    });
    expect(skillChangeSlugs(skillChangesBetween(given(style, review), now(e2e, edit(style, { body: "New." }))))).toEqual({ added: ["e2e"], changed: ["house-style"], removed: ["review"] });
  });

  it("lists everything as added after a run that was given none", () => {
    expect(skillChangesBetween([], now(skill("house-style"))).added.map((one) => one.slug)).toEqual(["house-style"]);
  });

  /**
   * The two deliveries hash one skill alike: Codex from the row, Claude
   * from the directory written from it and read back off disk.
   */
  it("hashes a skill the Claude directory holds as Codex hashes the row it was written from", () => {
    const root = mkdtempSync(join(tmpdir(), "eo-skill-changes-"));
    try {
      const style = edit(skill("house-style"), { files: [{ path: "refs/checklist.md", content: "- one" }] });
      const review = skill("review");
      writeToolDirectory(root, { servers: [], skills: [style, review] });
      expect(toolDirectorySkills(root)).toEqual(now(style, review));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("skillsGivenBefore", () => {
  let handle: DbHandle;
  let runId: Uuid;

  beforeEach(() => {
    handle = openMigratedTestDb();
    const item = createTestItem(handle.db, { type: "story", title: "T", stepId: "todo" });
    runId = createRun(handle.db, { itemId: item.id, agentId: null, action: "implement", status: "succeeded" }).id;
  });
  afterEach(() => handle.close());

  const skill = (name: string): Skill => {
    const saved = saveSkill(handle.db, SkillDraftSchema.parse({ name, description: `How to ${name}.`, body: "Read the diff." }), 1_000);
    if (!saved.ok) throw new Error(saved.problems.join("\n"));
    return saved.skill;
  };

  it("reads each skill the run was given with the hash its delivery recorded, whatever has been written since", () => {
    const style = skill("house-style");
    const delivered = deliveredSkillOf(style);
    appendRunEvent(handle.db, runId, SKILLS_DELIVERED_EVENT, { type: SKILLS_DELIVERED_EVENT, skillIds: [style.id], slugs: [style.slug], contentHashes: [delivered.contentHash] });
    // An edit after the backend was handed the skill but before, or in
    // the same millisecond as, the event that records it.
    const edited = saveSkill(handle.db, SkillDraftSchema.parse({ id: style.id, name: style.name, description: style.description, body: "New." }), 1_000);
    if (!edited.ok) throw new Error(edited.problems.join("\n"));
    const before = skillsGivenBefore(handle.db, runId);
    expect(before).toEqual([{ slug: "house-style", name: "house-style", description: "How to house-style.", contentHash: delivered.contentHash }]);
    expect(skillChangesBetween(before, [deliveredSkillOf(edited.skill)]).changed.map((one) => one.slug)).toEqual(["house-style"]);
  });

  it("names a skill archived or deleted since by what its row says, or by its slug", () => {
    const review = skill("review");
    // A slug whose row is gone: an id no skill has.
    appendRunEvent(handle.db, runId, SKILLS_DELIVERED_EVENT, { type: SKILLS_DELIVERED_EVENT, skillIds: [review.id, "01900000-0000-7000-8000-000000000000"], slugs: ["review", "gone"] });
    archiveSkill(handle.db, review.id, 2_000);
    expect(skillsGivenBefore(handle.db, runId)).toEqual([
      { slug: "review", name: "review", description: "How to review.", contentHash: null },
      { slug: "gone", name: "gone", description: "", contentHash: null },
    ]);
  });

  it("is nothing for a run given none", () => {
    expect(skillsGivenBefore(handle.db, runId)).toEqual([]);
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
});
