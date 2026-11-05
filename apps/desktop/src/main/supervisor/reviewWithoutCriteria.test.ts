import type { Item } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import {
  getItem,
  listCommentsForItem,
  listMentionsForComment,
  listRunsForItem,
  needsAttention,
  openMentionsForHuman,
  postComment,
} from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { holdItem, resumeHeldItem, updateItemText } from "../ipc/domainCommands.js";
import { createScriptedProvider } from "../providers/scripted.js";
import { createRoleWiring } from "../packs/developer/wiring.js";
import { createDispatchGate } from "../packs/developer/scheduling.js";
import { createRunSupervisor, type RunSupervisor } from "./runSupervisor.js";

/**
 * A review EO refuses to start (EO-213).
 *
 * EO-204 reached a merge request on its thirteenth implementation run.
 * Eleven of its twelve rejections opened with the same sentence — the
 * item declared no acceptance criteria and the reviewer reported on
 * something anyway — and nine of the twelve carried exactly one blocking
 * issue, which is the shape EO-200 exists to prevent. EO-200's coverage
 * check had nothing to close over, so the reviewer read a pinned comment,
 * treated its bullets as criteria, and spent ten rounds on the one that
 * was not falsifiable.
 *
 * So the dispatch does not happen. Refused before the run rather than
 * inside it: a review that starts and then finds it has nothing to judge
 * against has already spent the dispatch, and improvising is what it does
 * next.
 */

const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };
const CRITERION = "Returns 429 after 100 requests in a minute.";

const APPROVE = { verdict: "approve", feedback: "Clean.", blocking_issues: [] };
const IMPLEMENTED = { branch: "eo/EO-1", summary: "done", handoff: "Nothing to flag." };

let handle: DbHandle;

beforeEach(() => {
  handle = openMigratedTestDb();
});

afterEach(() => {
  handle.close();
});

function supervisor(): RunSupervisor {
  return createRunSupervisor({
    db: handle.db,
    limits: LIMITS,
    provider: createScriptedProvider([
      { when: (context) => context.includes(`"implement" action`), script: { result: IMPLEMENTED } },
      { when: (context) => context.includes(`"review" action`), script: { result: APPROVE } },
    ]),
    // The rule this file is about is the developer pack's now (KAN-161),
    // so the supervisor is built with it — the shape `createEngine`
    // composes. Without it the scheduler offers the review and the
    // dispatch boundary turns it back, which is the same sentence by a
    // longer road and not the road production takes.
    dispatchGate: createDispatchGate(handle.db),
    ...createRoleWiring(handle.db),
  });
}

/** An item sitting on the seeded pipeline's review step, declaring whatever it is given. */
function atReview(overrides: Partial<Parameters<typeof createTestItem>[1]> = {}): Item {
  return createTestItem(handle.db, { type: "story", title: "Rate limit the API", stepId: "review", ...overrides });
}

function reviewRuns(itemId: string) {
  return listRunsForItem(handle.db, itemId as Item["id"]).filter((run) => run.action === "review");
}

function escalations(itemId: string): string[] {
  return listCommentsForItem(handle.db, itemId as Item["id"])
    .filter((comment) => comment.kind === "escalation")
    .map((comment) => comment.body);
}

describe("an item that declares nothing to review it against", () => {
  it("is refused at the dispatch boundary, with the reason on a run and in the thread", async () => {
    const item = atReview();

    await supervisor().runOnce();

    // The dispatch never reached a provider: the only `review` row is the
    // placeholder the refusal wrote, and a placeholder has no thread
    // because nothing ever started one.
    const runs = reviewRuns(item.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "awaiting_input", threadId: null });
    expect(runs[0]?.error).toContain("declares no acceptance criteria");

    // What is missing, and how to supply it (invariant #8).
    const [escalation] = escalations(item.id);
    expect(escalation).toContain("declares no acceptance criteria");
    expect(escalation).toContain("ticket_update");
    expect(escalation).toContain("the ticket screen");
    expect(escalations(item.id)).toHaveLength(1);

    // And `!` for the person, which is what an open human mention is.
    expect(needsAttention(handle.db, item.id)).toBe(true);
    expect(openMentionsForHuman(handle.db).map((row) => row.comment.body)).toEqual([escalation]);

    // The item has not moved. A refusal decides nothing about the work.
    expect(getItem(handle.db, item.id)?.stepId).toBe("review");
  });

  it("says it once, not once a tick", async () => {
    const item = atReview();

    const engine = supervisor();
    await engine.runOnce();
    await engine.runOnce();
    await engine.runOnce();

    expect(escalations(item.id)).toHaveLength(1);
    expect(reviewRuns(item.id)).toHaveLength(1);
  });

  it("dispatches the review on the very next tick once a criterion is added, and asks for nothing else", async () => {
    // The whole shape of the fix. Every other refusal in EO parks a
    // item until somebody replies, because a signed-out backend is not
    // something EO can watch. Criteria are — so adding one is the entire
    // remedy: no reply, no resume, no dragging the item anywhere.
    const item = atReview();
    const engine = supervisor();
    await engine.runOnce();
    expect(reviewRuns(item.id).every((run) => run.threadId === null)).toBe(true);

    // Through the door the escalation points at: `ticket_update` and the
    // item screen are the same call.
    expect(updateItemText(handle.db, { itemId: item.id, acceptanceCriteria: [CRITERION] })).toEqual({
      updated: true,
      problem: null,
    });

    await engine.runOnce();

    const ran = reviewRuns(item.id).find((run) => run.threadId !== null);
    expect(ran?.status).toBe("succeeded");
    expect(getItem(handle.db, item.id)?.stepId).toBe("merge_request");
    // One refusal, from before the criterion existed — not a second one
    // alongside the review that then ran.
    expect(escalations(item.id)).toHaveLength(1);

    // And EO is no longer asking. `!` is derived from an open human
    // mention (invariant #6), so an ask nothing closes would leave this
    // item in the inbox after its review had run and been approved —
    // asking a person for the criterion it was just reviewed against.
    expect(needsAttention(handle.db, item.id)).toBe(false);
    expect(openMentionsForHuman(handle.db)).toEqual([]);
  });

  it("takes the ask down on the tick that sees the criteria, before the review it releases", async () => {
    // Raised and lowered from the item's own state, so the order is
    // not an accident of which ran first: the mention is closed in the
    // same pass that stops refusing, ahead of the dispatch.
    const item = atReview();
    const engine = supervisor();
    await engine.runOnce();
    expect(needsAttention(handle.db, item.id)).toBe(true);

    updateItemText(handle.db, { itemId: item.id, acceptanceCriteria: [CRITERION] });
    // Paused, so the tick settles the ask and dispatches nothing. The
    // `!` has to come off on its own account rather than as a side
    // effect of the review having succeeded.
    engine.pause();
    await engine.runOnce();

    expect(needsAttention(handle.db, item.id)).toBe(false);
    expect(reviewRuns(item.id).every((run) => run.threadId === null)).toBe(true);
  });

  it("keeps asking while the criteria are still missing", async () => {
    // The other side of the withdrawal: nothing lowers the ask until the
    // thing it asked for exists, however many ticks pass.
    const item = atReview();
    const engine = supervisor();
    await engine.runOnce();
    await engine.runOnce();
    await engine.runOnce();

    expect(needsAttention(handle.db, item.id)).toBe(true);
    expect(openMentionsForHuman(handle.db)).toHaveLength(1);
  });

  it("refuses a bug the same way, and makes no criterion out of its `expected`", async () => {
    // A bug's four reproduction fields are its intake bar and criteria
    // are accepted rather than demanded (EO-205), so a bug can honestly
    // arrive here declaring none. Treating `expected` as an implicit
    // criterion would be EO declaring one nobody wrote — which is the
    // thing EO-200's design refuses to do — so it is offered as wording
    // for a person to accept, and nothing is declared on their behalf.
    const expected = "The 101st request in a minute is refused with a 429.";
    const bug = atReview({
      type: "bug",
      title: "The limiter lets everything through",
      spec: {
        steps_to_reproduce: "Send 101 requests inside a minute.",
        expected,
        actual: "All 101 succeed.",
        environment: "0.4.1, linux",
      },
    });

    await supervisor().runOnce();

    expect(reviewRuns(bug.id).every((run) => run.threadId === null)).toBe(true);
    const [escalation] = escalations(bug.id);
    expect(escalation).toContain("declares no acceptance criteria");
    // Offered, in the bug's own words, so accepting it costs one line.
    expect(escalation).toContain(expected);
    // Offered and not taken: nothing was written to the item, and the
    // next tick refuses it again rather than reviewing against a
    // criterion EO invented.
    expect(getItem(handle.db, bug.id)?.spec).toEqual(bug.spec);
  });

  it("summons nobody out of the words it quotes back", async () => {
    // The offer quotes a bug's `expected`, which is a person's free
    // text, and `postComment` turns an `@token` in a body into a mention
    // by default. A mention is a dispatch trigger — so an `@` somebody
    // typed into a bug report would start a run against the very item
    // EO has just refused to dispatch, out of text EO only meant to
    // repeat back.
    const bug = atReview({
      type: "bug",
      title: "The limiter lets everything through",
      spec: {
        steps_to_reproduce: "Send 101 requests.",
        expected: "@Reviewer and @Implementer agreed the 101st is refused with a 429.",
        actual: "All 101 succeed.",
        environment: "0.4.1, linux",
      },
    });

    await supervisor().runOnce();

    // Quoted in full — a person is meant to be able to copy it — and
    // addressed to nobody but the human the escalation names.
    expect(escalations(bug.id)[0]).toContain("@Reviewer and @Implementer");
    const [escalation] = listCommentsForItem(handle.db, bug.id).filter((comment) => comment.kind === "escalation");
    expect(listMentionsForComment(handle.db, escalation!.id).map((mention) => mention.targetType)).toEqual(["human"]);
    expect(reviewRuns(bug.id).every((run) => run.threadId === null)).toBe(true);
  });

  it("dispatches an item that declares criteria exactly as before", async () => {
    const item = atReview({ spec: { acceptance_criteria: [CRITERION] } });

    await supervisor().runOnce();

    expect(reviewRuns(item.id).map((run) => run.status)).toEqual(["succeeded"]);
    expect(escalations(item.id)).toEqual([]);
    expect(needsAttention(handle.db, item.id)).toBe(false);
  });

  it("turns the review away when a reply asks for it too, not only when a tick does", async () => {
    // The scheduler is not the only door onto a dispatch: a reply resumes
    // a parked run, and a refusal has nothing to resume, so it starts a
    // fresh one. Without the check at the dispatch itself, answering the
    // escalation with anything at all would start the very review it is
    // asking about.
    const item = atReview();
    const engine = supervisor();
    await engine.runOnce();

    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Go on then." });
    await engine.resumeItem(item.id);

    expect(reviewRuns(item.id).every((run) => run.threadId === null)).toBe(true);
    expect(getItem(handle.db, item.id)?.stepId).toBe("review");
  });

  it("lets the criteria be written while the item sits on the review step, and only then holds the edit", async () => {
    // `refuseIfUntouchable` refuses a content edit on an item in review,
    // because moving the target invalidates the review being written
    // against it. There is no review here and there will be none until a
    // criterion arrives, so the rule has nothing to protect — and if it
    // applied, the escalation would be asking for an edit EO refuses.
    const item = atReview();
    await supervisor().runOnce();

    expect(updateItemText(handle.db, { itemId: item.id, acceptanceCriteria: [CRITERION] })).toEqual({
      updated: true,
      problem: null,
    });

    // And the moment there is a review to invalidate, the rule is back.
    const second = updateItemText(handle.db, { itemId: item.id, acceptanceCriteria: ["Something else entirely."] });
    expect(second.updated).toBe(false);
    expect(second.problem).toContain("is in review");
  });

  it("counts an item that was refused and then supplied criteria like any other", async () => {
    // EO-200's census is posted on approval and measures rounds and
    // blocking issues. A refusal is neither: it starts no review, so the
    // item's first round is the one that ran after the criterion
    // arrived.
    const item = atReview();
    const engine = supervisor();
    await engine.runOnce();
    updateItemText(handle.db, { itemId: item.id, acceptanceCriteria: [CRITERION] });
    await engine.runOnce();

    const census = listCommentsForItem(handle.db, item.id).find((comment) => comment.body.includes("Review census."));
    expect(census?.body).toContain("This ticket took 1 review round.");
  });
});

/**
 * What a person is told when they resume it (EO-135, #142, KAN-161).
 *
 * Resuming is a person handing the item back to the scheduler, and EO
 * acknowledges it by saying what happens next. #142 is what that
 * sentence cost when it was unconditional: an item reported as live
 * that nothing was ever going to pick up. So the acknowledgement asks
 * the scheduler — and since the rule that turns this particular item
 * away is the installed pack's rather than the engine's, it has to ask
 * the engine that holds the pack rather than assemble the question for
 * itself. Built locally it would answer "nothing is stopping it" about an
 * item the very next tick refuses.
 */
describe("resuming a held one", () => {
  /** The newest thing EO said on the item. */
  const newestEngineNote = (itemId: Item["id"]): string =>
    listCommentsForItem(handle.db, itemId)
      .filter((comment) => comment.authorType === "engine")
      .map((comment) => comment.body)
      .at(-1) ?? "";

  it("does not promise a pickup that the next tick refuses", async () => {
    const item = atReview();
    const engine = supervisor();
    holdItem(handle.db, engine, { itemId: item.id, comment: "", cancelActiveRun: false });

    resumeHeldItem(handle.db, engine, { itemId: item.id, cancelActiveRun: false });

    const note = newestEngineNote(item.id);
    expect(note).toContain(`Ticket resumed at "Review"`);
    expect(note).not.toContain("It can be picked up again");
    // The reason and the remedy, in the words every other refusal of
    // this uses — one mapping, one sentence (invariant #8).
    expect(note).toContain("declares no acceptance criteria");
    expect(note).toContain("ticket_update");

    // And the acknowledgement was telling the truth, which is the whole
    // of what it is for: no review ran.
    await engine.runOnce();
    expect(reviewRuns(item.id).every((run) => run.threadId === null)).toBe(true);
  });

  it("promises one once there is a criterion, so the refusal is not unconditional", async () => {
    // The other half. A resume that always said "nothing will pick this
    // up" would be as useless as one that always promised a pickup.
    const item = atReview({ spec: { acceptance_criteria: [CRITERION] } });
    const engine = supervisor();
    holdItem(handle.db, engine, { itemId: item.id, comment: "", cancelActiveRun: false });

    resumeHeldItem(handle.db, engine, { itemId: item.id, cancelActiveRun: false });

    expect(newestEngineNote(item.id)).toContain("It can be picked up again");

    await engine.runOnce();
    expect(reviewRuns(item.id).some((run) => run.threadId !== null)).toBe(true);
  });
});
