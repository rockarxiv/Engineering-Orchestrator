import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LOCAL_PERSON_ID, NO_POLICY, type Uuid } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { listAgents } from "../db/repos/agentsRepo.js";
import { createPerson } from "../db/repos/peopleRepo.js";
import { createProject, markProjectOnTheRecord } from "../db/repos/projectsRepo.js";
import { createRun, updateRun } from "../db/repos/runsRepo.js";
import { listCommentsForItem, listMentionsForComment, postComment, settleMention } from "../db/repos/commentsRepo.js";
import { setSetting } from "../db/repos/settingsRepo.js";
import { MANAGED_PERSON_ID_KEY } from "../identity/viewer.js";
import { forgetPolicy, overPersonBudgetForItem, personBudgetFor, personOverBudget, POLICY_KEY, readPolicy, writePolicy } from "./policy.js";
import { ownerOfItem, parkForPersonBudget } from "./personBudget.js";

/**
 * The policy in force on this process, and the budget it sets for one
 * person (EO-328, `ARCHITECTURE.md`, "Policy").
 *
 * The behaviour these hold on to is the one every installation without
 * an organisation depends on: with nothing published, nothing here has
 * an opinion.
 */

let handle: DbHandle;

beforeEach(() => {
  handle = openMigratedTestDb();
});

afterEach(() => {
  handle.close();
});

/** A run of `costCents`, on an item of `projectId`, that started at `startedAt`. */
function spend(projectId: Uuid | null, costCents: number, startedAt: number, preview = false): void {
  const item = createTestItem(handle.db, {
    type: "story",
    title: `An item costing ${costCents}`,
    stepId: "todo",
    projectId,
    ...(preview ? { previewAt: startedAt } : {}),
  });
  const run = createRun(handle.db, { itemId: item.id, agentId: listAgents(handle.db)[0]!.id, action: "implement" });
  updateRun(handle.db, run.id, { status: "succeeded", costCents, startedAt });
}

describe("the published policy", () => {
  it("reads as 'the organisation has not said' when nothing was ever written", () => {
    expect(readPolicy(handle.db)).toEqual(NO_POLICY);
  });

  it("round-trips what an admin published", () => {
    writePolicy(handle.db, { ...NO_POLICY, allowedBackends: ["claude"], perPersonDailyBudgetCents: 1_000, publishedAt: 5 });

    const read = readPolicy(handle.db);
    expect(read.allowedBackends).toEqual(["claude"]);
    expect(read.perPersonDailyBudgetCents).toBe(1_000);
    expect(read.publishedAt).toBe(5);
  });

  it("falls back to no policy rather than throwing on a copy it cannot read", () => {
    // A desktop pulls this from a server that may be a release ahead of
    // it, and a parse failure inside a dispatch would stop every run on
    // the machine. The safe direction is "the organisation has not said".
    setSetting(handle.db, POLICY_KEY, { allowedBackends: "claude-only-please" });

    expect(readPolicy(handle.db)).toEqual(NO_POLICY);
  });
});

describe("a person's day", () => {
  it("is nothing to report where no ceiling is published", () => {
    expect(personBudgetFor(handle.db, NO_POLICY, LOCAL_PERSON_ID)).toBeNull();
    expect(personOverBudget(handle.db, NO_POLICY)).toBeNull();
  });

  it("sums what this person's projects cost today, and nobody else's", () => {
    const anna = createPerson(handle.db, { name: "Anna", email: "anna@example.com" });
    const dana = createPerson(handle.db, { name: "Dana", email: "dana@example.com" });
    const hers = createProject(handle.db, { name: "Support", keyPrefix: "SUP" });
    const his = createProject(handle.db, { name: "Marketing", keyPrefix: "MKT" });
    markProjectOnTheRecord(handle.db, hers.id, anna.id);
    markProjectOnTheRecord(handle.db, his.id, dana.id);

    const now = Date.now();
    spend(hers.id, 120, now);
    spend(hers.id, 30, now);
    spend(his.id, 900, now);

    const policy = { ...NO_POLICY, perPersonDailyBudgetCents: 1_000 };
    expect(personBudgetFor(handle.db, policy, anna.id, now)).toEqual({ spentCents: 150, budgetCents: 1_000 });
    expect(personBudgetFor(handle.db, policy, dana.id, now)).toEqual({ spentCents: 900, budgetCents: 1_000 });
  });

  it("counts today and not yesterday", () => {
    const anna = createPerson(handle.db, { name: "Anna", email: "anna@example.com" });
    const hers = createProject(handle.db, { name: "Support", keyPrefix: "SUP" });
    markProjectOnTheRecord(handle.db, hers.id, anna.id);

    const now = Date.now();
    spend(hers.id, 500, now - 36 * 60 * 60 * 1000);
    spend(hers.id, 40, now);

    expect(personBudgetFor(handle.db, { ...NO_POLICY, perPersonDailyBudgetCents: 1_000 }, anna.id, now)?.spentCents).toBe(40);
  });

  it("leaves a preview's runs out, as every other cost does", () => {
    // EO-313 ARCHITECTURE.md, "Preview": a rehearsal must never be the thing that spends
    // somebody's day.
    const anna = createPerson(handle.db, { name: "Anna", email: "anna@example.com" });
    const hers = createProject(handle.db, { name: "Support", keyPrefix: "SUP" });
    markProjectOnTheRecord(handle.db, hers.id, anna.id);

    const now = Date.now();
    spend(hers.id, 999, now, true);

    expect(personBudgetFor(handle.db, { ...NO_POLICY, perPersonDailyBudgetCents: 1_000 }, anna.id, now)?.spentCents).toBe(0);
  });

  it("answers about whoever this machine signed in as", () => {
    const anna = createPerson(handle.db, { name: "Anna", email: "anna@example.com" });
    const hers = createProject(handle.db, { name: "Support", keyPrefix: "SUP" });
    markProjectOnTheRecord(handle.db, hers.id, anna.id);
    setSetting(handle.db, MANAGED_PERSON_ID_KEY, anna.id);

    const now = Date.now();
    spend(hers.id, 1_000, now);

    const policy = { ...NO_POLICY, perPersonDailyBudgetCents: 1_000 };
    // Reaching the ceiling is spending it — the same boundary the
    // per-item and daily guards use.
    expect(personOverBudget(handle.db, policy, now)).toEqual({ spentCents: 1_000, budgetCents: 1_000 });
    expect(personOverBudget(handle.db, { ...policy, perPersonDailyBudgetCents: 1_001 }, now)).toBeNull();
  });

  it("has nothing to say about a machine signed in to nothing", () => {
    // The implicit local person owns no project on the record, so the
    // sum is nought and a solo desktop is never stopped by a ceiling it
    // has no way to have been given.
    const project = createProject(handle.db, { name: "Support", keyPrefix: "SUP" });
    const now = Date.now();
    spend(project.id, 5_000, now);

    expect(personOverBudget(handle.db, { ...NO_POLICY, perPersonDailyBudgetCents: 100 }, now)).toBeNull();
  });
});

describe("leaving an organisation", () => {
  it("forgets the copy this machine was keeping", () => {
    // A sign-out is the relationship ending rather than an outage: a
    // machine that kept the allowed-backends list would refuse its own
    // owner's dispatches on the authority of a record it has left.
    writePolicy(handle.db, { ...NO_POLICY, allowedBackends: ["claude"], publishedAt: 5 });

    forgetPolicy(handle.db);

    expect(readPolicy(handle.db)).toEqual(NO_POLICY);
  });
});

describe("the record's own gate on a person's day", () => {
  /**
   * What the record refuses to lease out (EO-328, ARCHITECTURE.md, "Policy", review).
   *
   * The half that makes the ceiling a *person's* rather than a
   * machine's: the record sees every device's runs, so a second desktop
   * asking for work after the first has spent the day is refused here —
   * before a lease is granted and whatever its own replica believes.
   */
  function anna(): { projectId: Uuid; personId: Uuid } {
    const person = createPerson(handle.db, { name: "Anna", email: "anna@example.com" });
    const project = createProject(handle.db, { name: "Support", keyPrefix: "SUP" });
    markProjectOnTheRecord(handle.db, project.id, person.id);
    return { projectId: project.id, personId: person.id };
  }

  it("answers about whoever owns the item, not about whoever asked", () => {
    // A server has no "you". Anna's item is Anna's whichever desktop
    // asked the record for it.
    const { projectId, personId } = anna();
    const item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo", projectId });
    const now = Date.now();
    spend(projectId, 1_000, now);

    const policy = { ...NO_POLICY, perPersonDailyBudgetCents: 1_000 };
    expect(overPersonBudgetForItem(handle.db, policy, item.id, now)).toEqual({ spentCents: 1_000, budgetCents: 1_000 });
    expect(ownerOfItem(handle.db, item.id)).toBe(personId);
  });

  it("has no opinion about an item on a project nobody on the record owns", () => {
    // Every item of a solo installation, and every item of a project
    // somebody kept local at first sign-in. The design's budget is a thing an
    // organisation publishes, and a kept project is not theirs.
    const project = createProject(handle.db, { name: "Mine", keyPrefix: "MIN" });
    const item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo", projectId: project.id });
    const now = Date.now();
    spend(project.id, 5_000, now);

    expect(ownerOfItem(handle.db, item.id)).toBeNull();
    expect(overPersonBudgetForItem(handle.db, { ...NO_POLICY, perPersonDailyBudgetCents: 100 }, item.id, now)).toBeNull();
  });

  it("says the day is spent once, and again once a person has answered", () => {
    // Idempotent on the unanswered mention rather than on a stored flag
    // (invariant #6): a hundred ticks under the ceiling produce one
    // comment, and the question becomes worth asking again once somebody
    // has replied to the last one.
    const { projectId } = anna();
    const item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo", projectId });
    const budget = { spentCents: 1_000, budgetCents: 1_000 };

    expect(parkForPersonBudget(handle.db, item.id, budget)).toBe(true);
    expect(parkForPersonBudget(handle.db, item.id, budget)).toBe(false);
    expect(parkForPersonBudget(handle.db, item.id, budget)).toBe(false);

    const escalations = listCommentsForItem(handle.db, item.id).filter((comment) => comment.kind === "escalation");
    expect(escalations).toHaveLength(1);
    expect(escalations[0]?.body).toContain("$10");

    // Answered, so tomorrow's ceiling is worth a fresh word.
    for (const mention of listMentionsForComment(handle.db, escalations[0]!.id)) {
      settleMention(handle.db, {
        commentId: escalations[0]!.id,
        targetType: mention.targetType,
        targetId: mention.targetId,
        status: "addressed",
        addressedBy: null,
      });
    }
    expect(parkForPersonBudget(handle.db, item.id, budget)).toBe(true);
  });

  it("is not silenced by another guard's escalation on the same item", () => {
    // `escalation` is what every guard writes, so recognising one by
    // kind would let an attempt-limit park hide this.
    const { projectId } = anna();
    const item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo", projectId });
    postComment(handle.db, {
      itemId: item.id,
      author: { type: "engine" },
      kind: "escalation",
      mentions: [{ type: "human" }],
      parseBodyMentions: false,
      body: "Stopped after 3 attempt(s) in this \"implement\" initiation.",
    });

    expect(parkForPersonBudget(handle.db, item.id, { spentCents: 1_000, budgetCents: 1_000 })).toBe(true);
  });
});
