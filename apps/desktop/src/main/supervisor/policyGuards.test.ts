import { NO_POLICY, NOT_ALLOWED_BY_YOUR_ORGANISATION, type Item, type Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import {
  createRun,
  listAgents,
  personCostCentsSince,
  listCommentsForItem,
  listMentionsForComment,
  listRunsForItem,
  needsAttention,
  openMentionsForHuman,
  updateAgent,
  updateRun,
} from "../db/repos/index.js";
import { createPerson } from "../db/repos/peopleRepo.js";
import { createProject, markProjectOnTheRecord } from "../db/repos/projectsRepo.js";
import { setSetting } from "../db/repos/settingsRepo.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { MANAGED_PERSON_ID_KEY } from "../identity/viewer.js";
import { writePolicy } from "../policy/policy.js";
import { createLocalRecord } from "../record/localRecord.js";
import type { ItemRecord } from "../record/record.js";
import { createFakeProvider } from "../providers/fake.js";
import { validImplementResult } from "../providers/fixtures.js";
import { createRunSupervisor } from "./runSupervisor.js";

/**
 * What an organisation allows, at the moment of dispatch (EO-328,
 * `ARCHITECTURE.md`, "Policy").
 *
 * Two guards, both before the run rather than during it, and both the
 * ordinary refusal every other guard in `dispatchHeld` is: a placeholder
 * run carrying the reason, an escalation mentioning the person, `!` on
 * the item. Nothing is routed, because nothing ran.
 *
 * The first acceptance criterion of the story is that a device bound to
 * a disallowed backend *cannot dispatch* — the Agents screen greys the
 * options so nobody binds one, and this is what makes that a rule rather
 * than a hint: a row written before the policy was published, or through
 * the admin MCP server, still cannot run.
 */

const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };

let handle: DbHandle;

beforeEach(() => {
  handle = openMigratedTestDb();
});

afterEach(() => {
  handle.close();
});

function supervisor() {
  return createRunSupervisor({ db: handle.db, limits: LIMITS, provider: createFakeProvider({ result: validImplementResult }) });
}

/**
 * A desktop whose record is somebody else's — the second of a person's
 * two machines (EO-328, review).
 *
 * The record is stood in for rather than networked because what is under
 * test is *which* figure the dispatch guard believes: a local record
 * would answer out of the same database the replica reads, and the two
 * numbers would be one number. `personSpendToday` is overridden and
 * everything else is the ordinary local record, so the item is still
 * offered and leased the way a real one would offer and lease it — which
 * is the state a device that already holds a claim is in.
 */
function secondDesktop(overrides: Partial<ItemRecord>) {
  const record: ItemRecord = { ...createLocalRecord(handle.db), ...overrides };
  return createRunSupervisor({
    db: handle.db,
    limits: LIMITS,
    provider: createFakeProvider({ result: validImplementResult }),
    record,
  });
}

/** An item sitting where the implementer picks it up. */
function waiting(projectId: Uuid | null = null): Item {
  return createTestItem(handle.db, {
    type: "story",
    title: "A story",
    stepId: "todo",
    spec: { acceptance_criteria: ["It works."] },
    projectId,
  });
}

/** What every agent on this installation runs on. */
function bindEveryAgentTo(provider: string): void {
  for (const agent of listAgents(handle.db)) updateAgent(handle.db, agent.id, { provider });
}

/** The one run row a refused dispatch leaves behind, and the escalation under it. */
function refusal(item: Item): { error: string; escalationBody: string } {
  const runs = listRunsForItem(handle.db, item.id);
  const guardRun = runs.find((run) => run.status === "awaiting_input");
  expect(guardRun, "the dispatch was not refused").toBeDefined();
  // Nothing was dispatched: the placeholder never opened a thread.
  expect(guardRun?.threadId).toBeNull();
  const escalation = listCommentsForItem(handle.db, item.id).find((comment) => comment.kind === "escalation");
  expect(escalation?.runId).toBe(guardRun?.id);
  return { error: guardRun?.error ?? "", escalationBody: escalation?.body ?? "" };
}

describe("a device bound to a disallowed backend", () => {
  it("cannot dispatch, and the thread says why", async () => {
    bindEveryAgentTo("codex");
    writePolicy(handle.db, { ...NO_POLICY, allowedBackends: ["claude"], publishedAt: 1 });
    const item = waiting();

    await supervisor().runOnce();

    const { error } = refusal(item);
    expect(error).toContain(NOT_ALLOWED_BY_YOUR_ORGANISATION);
    expect(error).toContain("codex");
    expect(error).toContain('"claude"');

    // Parked, not routed — and the person is asked, which is what makes
    // it reachable from the inbox.
    expect(needsAttention(handle.db, item.id)).toBe(true);
  });

  it("dispatches as usual once the organisation allows that backend", async () => {
    bindEveryAgentTo("fake");
    writePolicy(handle.db, { ...NO_POLICY, allowedBackends: ["fake"], publishedAt: 1 });
    const item = waiting();

    await supervisor().runOnce();

    expect(listRunsForItem(handle.db, item.id).every((run) => run.status !== "awaiting_input")).toBe(true);
  });

  it("is untouched on an installation nobody has published to", async () => {
    // The whole of solo mode's experience of this story: no policy, no
    // opinion, and the run goes ahead.
    bindEveryAgentTo("fake");
    const item = waiting();

    await supervisor().runOnce();

    expect(listRunsForItem(handle.db, item.id).every((run) => run.status !== "awaiting_input")).toBe(true);
  });
});

describe("a person over their daily budget", () => {
  /** A signed-in machine whose projects belong to the person it signed in as. */
  function signedIn(): { projectId: Uuid; personId: Uuid } {
    const anna = createPerson(handle.db, { name: "Anna", email: "anna@example.com" });
    setSetting(handle.db, MANAGED_PERSON_ID_KEY, anna.id);
    const project = createProject(handle.db, { name: "Support", keyPrefix: "SUP" });
    markProjectOnTheRecord(handle.db, project.id, anna.id);
    return { projectId: project.id, personId: anna.id };
  }

  /** A turn that spent money on this person's work earlier today. */
  function spend(item: Item, costCents: number): void {
    const run = createRun(handle.db, { itemId: item.id, agentId: null, action: "implement" });
    updateRun(handle.db, run.id, { status: "failed", costCents, error: "it fell over", startedAt: Date.now(), endedAt: Date.now() });
  }

  it("has their next item parked with a mention naming the budget", async () => {
    bindEveryAgentTo("fake");
    const { projectId, personId } = signedIn();
    writePolicy(handle.db, { ...NO_POLICY, perPersonDailyBudgetCents: 1_000, publishedAt: 1 });

    const spent = waiting(projectId);
    spend(spent, 1_000);
    const next = waiting(projectId);

    await supervisor().runOnce();

    // The record does not lease out work it knows must not run, so
    // nothing was dispatched and no run was opened for it (review).
    expect(listRunsForItem(handle.db, next.id)).toEqual([]);

    // …and it says so, because a guard that silently withheld would be
    // work dropped on the floor (invariant #8). The acceptance criterion
    // in one line: the budget is named.
    const escalation = listCommentsForItem(handle.db, next.id).find((comment) => comment.kind === "escalation")!;
    expect(escalation.body).toContain("$10");
    expect(escalation.body).toContain("Your organisation");

    // A mention, so it lands in the inbox rather than sitting on a board
    // nobody is looking at. Anna, not the implicit local person: the
    // project is on the record, so `viewerFor` resolves "you" to whoever
    // this machine signed in as (EO-325). The budget and the mention are
    // about the same person, which is the whole of ARCHITECTURE.md, "Policy"'s "per person".
    expect(listMentionsForComment(handle.db, escalation.id).map((mention) => [mention.targetType, mention.targetId])).toEqual([
      ["human", personId],
    ]);
    expect(openMentionsForHuman(handle.db).map((entry) => entry.comment.itemId)).toContain(next.id);
    expect(needsAttention(handle.db, next.id)).toBe(true);
  });

  it("refuses a second device on the record's figure, which its own replica does not have", async () => {
    // The defect the review caught, in one case. Anna has two desktops;
    // the first spent the day and has not synced yet, so the second's
    // replica shows nothing at all. A guard that summed local rows would
    // give her the whole ceiling twice.
    //
    // The record is stood in for rather than networked, because what is
    // under test is which of the two numbers the guard believes — and a
    // fake that answers a figure this database cannot produce is the
    // only way to tell them apart. `record/sync.test.ts` is where the
    // channel carrying it is exercised end to end.
    bindEveryAgentTo("fake");
    const { projectId, personId } = signedIn();
    writePolicy(handle.db, { ...NO_POLICY, perPersonDailyBudgetCents: 1_000, publishedAt: 1 });
    const next = waiting(projectId);

    // Nothing has been spent *here*.
    expect(personCostCentsSince(handle.db, personId, 0)).toBe(0);

    const asked: { personId: string; since: number }[] = [];
    await secondDesktop({
      personSpendToday: (who, since) => {
        asked.push({ personId: who, since });
        return Promise.resolve(1_000);
      },
    }).runOnce();

    // It asked about Anna, and it believed the answer.
    expect(asked.map((one) => one.personId)).toContain(personId);
    const escalation = listCommentsForItem(handle.db, next.id).find((comment) => comment.kind === "escalation");
    expect(escalation?.body).toContain("$10");
    // Parked the way every other pre-dispatch guard parks: a placeholder
    // run carrying the reason, since this device *was* offered the work.
    expect(listRunsForItem(handle.db, next.id).find((run) => run.status === "awaiting_input")?.error).toContain("Your organisation");
  });

  it("runs as usual when the record says the day is clear", async () => {
    bindEveryAgentTo("fake");
    const { projectId } = signedIn();
    writePolicy(handle.db, { ...NO_POLICY, perPersonDailyBudgetCents: 1_000, publishedAt: 1 });
    const next = waiting(projectId);

    await secondDesktop({ personSpendToday: () => Promise.resolve(0) }).runOnce();

    expect(listRunsForItem(handle.db, next.id).every((run) => run.status !== "awaiting_input")).toBe(true);
  });

  it("keeps the higher of the two readings, because each is short in a different way", async () => {
    // The record has not heard about the run this device finished a
    // second ago; this device has never heard about the other desktop's.
    // Whichever is higher is closer to the truth, and closer to the
    // truth on a ceiling means erring towards enforcing it.
    bindEveryAgentTo("fake");
    const { projectId } = signedIn();
    writePolicy(handle.db, { ...NO_POLICY, perPersonDailyBudgetCents: 1_000, publishedAt: 1 });
    const spent = waiting(projectId);
    spend(spent, 1_000);
    const next = waiting(projectId);

    // The record is behind — it answers nought — and the local rows are
    // what know the ceiling has been reached.
    await secondDesktop({ personSpendToday: () => Promise.resolve(0) }).runOnce();

    expect(listCommentsForItem(handle.db, next.id).some((comment) => comment.body.includes("Your organisation"))).toBe(true);
  });

  it("is not stopped a cent under it", async () => {
    bindEveryAgentTo("fake");
    const { projectId } = signedIn();
    writePolicy(handle.db, { ...NO_POLICY, perPersonDailyBudgetCents: 1_000, publishedAt: 1 });

    const spent = waiting(projectId);
    spend(spent, 999);
    const next = waiting(projectId);

    await supervisor().runOnce();

    expect(listRunsForItem(handle.db, next.id).every((run) => run.status !== "awaiting_input")).toBe(true);
  });

  it("says it once, however many ticks pass", async () => {
    // Two things could say it — the record withholding and a device
    // refusing — and `parkForPersonBudget` is the one owner of the
    // sentence, idempotent while the mention it wrote is unanswered.
    bindEveryAgentTo("fake");
    const { projectId } = signedIn();
    writePolicy(handle.db, { ...NO_POLICY, perPersonDailyBudgetCents: 1_000, publishedAt: 1 });
    const spent = waiting(projectId);
    spend(spent, 1_000);
    const next = waiting(projectId);

    await supervisor().runOnce();
    await supervisor().runOnce();
    await supervisor().runOnce();

    expect(listCommentsForItem(handle.db, next.id).filter((comment) => comment.kind === "escalation")).toHaveLength(1);
  });
});
