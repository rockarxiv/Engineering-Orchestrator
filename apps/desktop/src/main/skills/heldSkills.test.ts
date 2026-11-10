import type { Skill, Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { listCommentsForItem, openMentionsForHuman } from "../db/repos/commentsRepo.js";
import { createProject } from "../db/repos/projectsRepo.js";
import { holdSkillCopy, listHeldSkillCopies, saveSkill, setSkillLocked, upsertReplicaSkill } from "../db/repos/skillsRepo.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { findProjectThread } from "../projects/projectThread.js";
import { tellHeldSkillCopies } from "./heldSkills.js";

/**
 * A copy a person's lock kept out, told to them (EO-714): an escalation
 * mentioning the person, on a project thread, once.
 */
let handle: DbHandle;

beforeEach(() => {
  handle = openMigratedTestDb();
});

afterEach(() => {
  handle.close();
});

function published(overrides: Partial<Skill> = {}): Skill {
  return {
    id: "019fb8c6-0000-7000-8000-00000000c0de",
    slug: "house-style",
    name: "House style",
    description: "The organisation's.",
    body: "Theirs.",
    files: [],
    disableModelInvocation: false,
    enabled: true,
    scope: { kind: "global" },
    createdAt: 1,
    updatedAt: 1,
    archivedAt: null,
    createdBy: "person",
    locked: false,
    ...overrides,
  };
}

/** A person's own skill holding the published one's slug, locked, and the published copy it kept out, held. */
function heldBehind(scope: Skill["scope"] = { kind: "global" }): string {
  const mine = saveSkill(handle.db, { slug: "house-style", name: "House style", description: "Ours.", body: "Ours.", files: [], scope });
  if (!mine.ok) throw new Error(mine.problems.join(" "));
  setSkillLocked(handle.db, mine.skill.id, true);
  const taken = upsertReplicaSkill(handle.db, published());
  if (taken.ok) throw new Error("not refused");
  holdSkillCopy(handle.db, published(), undefined, taken.problem);
  return taken.problem;
}

function threadComments(projectId: string) {
  const thread = findProjectThread(handle.db, projectId as Uuid);
  return thread === undefined ? [] : listCommentsForItem(handle.db, thread.id as Uuid);
}

describe("telling a person what their lock kept out", () => {
  it("posts one escalation that mentions the person on every project's thread for a global skill, and only once", () => {
    const shop = createProject(handle.db, { name: "Shop", keyPrefix: "SHOP" });
    const api = createProject(handle.db, { name: "API", keyPrefix: "API" });
    const problem = heldBehind();

    expect(tellHeldSkillCopies(handle.db, 50)).toBe(1);
    expect(tellHeldSkillCopies(handle.db, 60)).toBe(0);

    for (const project of [shop, api]) {
      const comments = threadComments(project.id);
      expect(comments).toHaveLength(1);
      expect(comments[0]).toMatchObject({ kind: "escalation", body: problem, authorType: "engine" });
      expect(comments[0]?.body).toContain("a person locked");
      expect(comments[0]?.body).toContain("unlock or rename");
    }
    expect(listHeldSkillCopies(handle.db)[0]?.toldAt).toBe(50);
    // In the person's inbox: an open mention on each thread.
    expect(openMentionsForHuman(handle.db, "anybody")).toHaveLength(2);
  });

  it("tells only the project a locked project skill belongs to", () => {
    const shop = createProject(handle.db, { name: "Shop", keyPrefix: "SHOP" });
    const api = createProject(handle.db, { name: "API", keyPrefix: "API" });
    heldBehind({ kind: "project", projectId: shop.id });

    tellHeldSkillCopies(handle.db);

    expect(threadComments(shop.id)).toHaveLength(1);
    expect(threadComments(api.id)).toEqual([]);
  });

  it("keeps a copy untold while there is no thread to tell it on, and tells it once there is", () => {
    heldBehind();

    expect(tellHeldSkillCopies(handle.db)).toBe(0);
    expect(listHeldSkillCopies(handle.db)[0]?.toldAt).toBeNull();

    const shop = createProject(handle.db, { name: "Shop", keyPrefix: "SHOP" });
    expect(tellHeldSkillCopies(handle.db)).toBe(1);
    expect(threadComments(shop.id)).toHaveLength(1);
  });
});
