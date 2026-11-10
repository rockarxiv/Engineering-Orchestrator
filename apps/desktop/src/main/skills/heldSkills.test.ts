import { LOCAL_PERSON_ID, type Skill, type Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { createProject } from "../db/repos/projectsRepo.js";
import { holdSkillCopy, listHeldSkillCopies, saveSkill, setSkillLocked, upsertReplicaSkill } from "../db/repos/skillsRepo.js";
import { messagesFrom, openMigratedTestDb } from "../db/testHelpers.js";
import { listInbox } from "../ipc/domainQueries.js";
import { findProjectThread } from "../projects/projectThread.js";
import { tellHeldSkillCopies } from "./heldSkills.js";

/**
 * A copy a person's lock kept out, told to them (EO-714, EO-727): one
 * message to this machine's person, once, and never on a project thread.
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

function told() {
  return messagesFrom(handle.db, "held_skill_copy");
}

/** No project thread was made for any of these projects. */
function expectNoThread(...projectIds: string[]): void {
  for (const projectId of projectIds) expect(findProjectThread(handle.db, projectId as Uuid)).toBeUndefined();
}

describe("telling a person what their lock kept out", () => {
  it("sends one message to the person for a global skill, about no project, and only once", () => {
    const shop = createProject(handle.db, { name: "Shop", keyPrefix: "SHOP" });
    const api = createProject(handle.db, { name: "API", keyPrefix: "API" });
    const problem = heldBehind();

    expect(tellHeldSkillCopies(handle.db, 50)).toBe(1);
    expect(tellHeldSkillCopies(handle.db, 60)).toBe(0);

    expect(told()).toEqual([expect.objectContaining({ recipientId: LOCAL_PERSON_ID, projectId: null, body: problem, createdAt: 50, handledAt: null })]);
    expect(told()[0]?.body).toContain("a person locked");
    expect(told()[0]?.body).toContain("unlock or rename");
    expect(listHeldSkillCopies(handle.db)[0]?.toldAt).toBe(50);
    // In the person's inbox, as a message.
    expect(listInbox(handle.db).messages.map((message) => message.id)).toEqual([told()[0]!.id]);
    expectNoThread(shop.id, api.id);
  });

  it("is about the project a locked project skill belongs to", () => {
    const shop = createProject(handle.db, { name: "Shop", keyPrefix: "SHOP" });
    const api = createProject(handle.db, { name: "API", keyPrefix: "API" });
    heldBehind({ kind: "project", projectId: shop.id });

    tellHeldSkillCopies(handle.db);

    expect(told()).toEqual([expect.objectContaining({ projectId: shop.id })]);
    expectNoThread(shop.id, api.id);
  });

  it("tells a copy at once on a machine with no project, rather than waiting for a thread", () => {
    heldBehind();

    expect(tellHeldSkillCopies(handle.db)).toBe(1);
    expect(told()).toHaveLength(1);
    expect(listHeldSkillCopies(handle.db)[0]?.toldAt).not.toBeNull();
  });
});
