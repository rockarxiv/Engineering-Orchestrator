import type { SectionRenderer } from "@eo/engine";
import { ReviewOutputSchema, type Agent, type Item } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { comments } from "../db/schema.js";
import { onTransitionApplied, type AppliedTransition } from "../db/transitionEvents.js";
import { createRun, getStep, getItem, listAgents, listPipelineSteps, listReviewVerdicts, listReviewVerdictsByItem, listRunsForItem } from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { createScriptedProvider } from "../providers/scripted.js";
import { createRunSupervisor } from "../supervisor/runSupervisor.js";
import type { NextStep } from "../supervisor/runSupervisor.js";
import { postReviewFeedback } from "./reviewVerdict.js";
import { BUILTIN_RUNNERS } from "../packs/developer/builtins.js";
import { createRoleWiring } from "../packs/developer/wiring.js";

/**
 * Standing in for the developer pack's acceptance-criteria section
 * (KAN-161).
 *
 * The sections a prompt carries beyond the core's own come from the
 * installed pack, and a core-side test must not reach into one
 * (`packs/boundary.test.ts`). So it supplies the section itself: what is
 * asserted below is that what the caller supplies reaches the agent,
 * which is true of whoever wrote the renderer.
 */
const CRITERIA_SECTION: SectionRenderer = {
  id: "acceptanceCriteria",
  after: "item",
  render: ({ item }) =>
    item.acceptanceCriteria.length === 0 ? null : ["## Acceptance Criteria", ...item.acceptanceCriteria.map((item) => `- ${item}`)].join("\n"),
};


let handle: DbHandle;
let story: Item;
let reviewer: Agent;

const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };

const APPROVE = { verdict: "approve", feedback: "Clean, criteria met.", blocking_issues: [] };
const REJECT = {
  verdict: "reject",
  feedback: "The retry path is untested.",
  criteria_coverage: [{ criterion: "429 over budget", result: "not_met", note: "nothing drives the 101st request" }],
  blocking_issues: ["No test covers a 429 response", "Retry-After header is never set"],
};

/** What the story under test declares. Every fixture here has them: EO does not dispatch a review without (EO-213). */
const CRITERIA = ["429 over budget", "Retry-After names when to retry", "The counter is per key"];

function supervisorWith(reviewResult: unknown, implementResult: unknown = { branch: "eo/EO-1", summary: "done", handoff: "Straightforward; nothing to flag." }) {
  return createRunSupervisor({
    db: handle.db,
    limits: LIMITS,
    provider: createScriptedProvider([
      { when: (context) => context.includes(`"implement" action`), script: { result: implementResult } },
      { when: (context) => context.includes(`"review" action`), script: { result: reviewResult } },
    ]),
    builtins: BUILTIN_RUNNERS,
    ...createRoleWiring(handle.db),
  });
}

beforeEach(() => {
  handle = openMigratedTestDb();
  story = createTestItem(handle.db, { type: "story", title: "Rate limit the API", stepId: "todo", spec: { acceptance_criteria: CRITERIA } });
  reviewer = listAgents(handle.db).find((agent) => agent.role === "reviewer")!;
});

afterEach(() => {
  handle.close();
});

function commentBodies() {
  return handle.db
    .select()
    .from(comments)
    .all()
    .map((comment) => comment.body);
}

describe("where a review verdict sends the item", () => {
  // These used to be constants in reviewVerdict.ts. They are rows in
  // `step_routes` now, so the assertions go through the routing path that
  // actually runs — which is the point: a second pipeline can send
  // `approved` somewhere else entirely without touching this code.
  function routeFor(verdict: unknown): NextStep {
    const review = getStep(handle.db, "review")!;
    const next = createRoleWiring(handle.db).resolveNextState(review, listPipelineSteps(handle.db), verdict, "review", story);
    // `undefined` would mean the pack declined the action, which for
    // `review` would be a bug in `claimedActions` rather than an answer
    // — and it is not what any assertion below is about (KAN-144).
    if (next === undefined) throw new Error("the developer pack declined to route a review verdict");
    return next;
  }

  it("approve follows the route to the merge step", () => {
    // The merge step, not the terminal one: opening the pull request is
    // work, and work that can take time and fail needs a step of its own.
    //
    // The pipeline comes back with the step (EO-59) even though this route
    // stays inside one — the destination says where it is either way.
    expect(routeFor(APPROVE)).toEqual({ stepId: "merge_request", pipelineId: "default", resultKey: "approved" });
  });

  it("reject follows the route back to the implementer step", () => {
    expect(routeFor(REJECT)).toEqual({ stepId: "todo", pipelineId: "default", resultKey: "changes_requested" });
  });

  it("refuses to move the item on a verdict it cannot read", () => {
    // A-02 validates before this point, so an unreadable result means
    // something upstream is wrong — better parked than moved wrongly.
    expect(routeFor({ verdict: "maybe" })).toBeNull();
    expect(routeFor("looks fine to me")).toBeNull();
  });
});

describe("the review loop", () => {
  it("approve carries the item through the merge step to terminal, and it stops being dispatched", async () => {
    const supervisor = supervisorWith(APPROVE);

    await supervisor.runOnce(); // implement
    await supervisor.runOnce(); // review
    expect(getItem(handle.db, story.id)?.stepId).toBe("merge_request");

    // The built-in runs like any other step. No forge is configured here,
    // so it reports `skipped` and routes onward rather than stalling.
    await supervisor.runOnce(); // merge request
    expect(getItem(handle.db, story.id)?.stepId).toBe("ready_to_merge");

    const before = listRunsForItem(handle.db, story.id).length;
    await supervisor.runOnce();
    expect(listRunsForItem(handle.db, story.id)).toHaveLength(before); // terminal; nothing more to do
  });

  it("reject returns the item to todo and posts substantive feedback", async () => {
    const supervisor = supervisorWith(REJECT);

    await supervisor.runOnce(); // implement
    await supervisor.runOnce(); // review

    expect(getItem(handle.db, story.id)?.stepId).toBe("todo");

    const feedback = commentBodies().find((body) => body.includes("Changes requested"))!;
    expect(feedback).toContain("The retry path is untested.");
    expect(feedback).toContain("No test covers a 429 response"); // blocking issues, itemised
  });

  it("the move a verdict makes says which result it was sent on, though the answer only says reject (EO-586)", async () => {
    // A verdict is "approve" or "reject"; the key it routes on is the
    // pack's mapping of it. Whatever listens to moves cannot read the
    // key back from the answer, so the move carries it.
    const moves: AppliedTransition[] = [];
    const stop = onTransitionApplied(handle.db, (transition) => moves.push(transition));
    const supervisor = supervisorWith(REJECT);

    await supervisor.runOnce(); // implement
    await supervisor.runOnce(); // review
    stop();

    expect(moves.map((move) => [move.toStepId, move.resultKey])).toEqual([
      ["review", "done"],
      ["todo", "changes_requested"],
    ]);
  });

  it("the rejection feedback reaches the next implementer attempt through its context", async () => {
    const supervisor = supervisorWith(REJECT);
    await supervisor.runOnce();
    await supervisor.runOnce();

    // What the implementer would be handed on its next attempt.
    const { buildDispatchContext } = await import("../supervisor/buildDispatchContext.js");
    const context = await buildDispatchContext(handle.db, getItem(handle.db, story.id)!, "implement");

    expect(context).toContain("The retry path is untested."); // ARCHITECTURE.md, "One channel": comments are the channel
    expect(context).toContain("No test covers a 429 response");
  });

  it("each review rejection starts a fresh implement initiation", async () => {
    const supervisor = supervisorWith(REJECT);

    for (let i = 0; i < 12; i++) await supervisor.runOnce();

    const runs = listRunsForItem(handle.db, story.id);
    const implementRuns = runs.filter((run) => run.action === "implement");
    expect(implementRuns.filter((run) => run.status === "succeeded")).toHaveLength(6);
    expect(implementRuns.every((run) => run.attempt === 1)).toBe(true);
    expect(new Set(implementRuns.map((run) => run.initiationId)).size).toBe(6);
    expect(implementRuns.some((run) => run.status === "awaiting_input" && run.threadId === null)).toBe(false);
  });

  it("an approval is recorded as an approval comment, not a rejection", async () => {
    const supervisor = supervisorWith(APPROVE);
    await supervisor.runOnce();
    await supervisor.runOnce();

    const posted = handle.db.select().from(comments).all();
    const verdict = posted.find((comment) => comment.authorId === reviewer.id)!;
    expect(verdict.kind).toBe("approval");
    expect(verdict.body).toContain("Clean, criteria met.");
  });

  it("the reviewer's context carries the acceptance criteria and the prior discussion", async () => {
    const spec = createTestItem(handle.db, {
      type: "story",
      title: "With criteria",
      stepId: "review",
      spec: { acceptance_criteria: ["429 after 100 req/min"] },
    });
    const { postComment } = await import("../db/repos/index.js");
    postComment(handle.db, { itemId: spec.id, author: { type: "human" }, body: "We settled on a token bucket." });

    const { buildDispatchContext } = await import("../supervisor/buildDispatchContext.js");
    const context = await buildDispatchContext(handle.db, spec, "review", [CRITERIA_SECTION]);

    expect(context).toContain("429 after 100 req/min");
    expect(context).toContain("We settled on a token bucket."); // so it can tell what was already agreed
  });
});

/**
 * A review's acceptance-criteria coverage (EO-200).
 *
 * EO-194 went five implementer rounds on three faults in two files, one
 * rejection at a time, against a `reviewer.md` that already said in bold
 * to report every blocking issue in one verdict. Prose had been tried
 * and measured, so the verdict now has to carry the worksheet — and
 * these are the tests that a review which stopped early *looks*
 * different from one that did not.
 */
describe("what a rejection says it covered", () => {
  async function review(reviewResult: unknown): Promise<void> {
    const supervisor = supervisorWith(reviewResult);
    await supervisor.runOnce(); // implement
    await supervisor.runOnce(); // review
  }

  const verdictComment = (): string => commentBodies().find((body) => body.includes("Changes requested") || body.includes("Approved."))!;

  const rejection = (coverage: unknown[]) => ({
    verdict: "reject",
    feedback: "The retry path is untested.",
    criteria_coverage: coverage,
    blocking_issues: ["No test covers a 429 response"],
  });

  it("renders a result for every criterion when the review examined all of them", async () => {
    await review(
      rejection([
        { criterion: "429 over budget", result: "not_met", note: "nothing drives the 101st request" },
        { criterion: "Retry-After names when to retry", result: "met" },
        { criterion: "The counter is per key", result: "met" },
      ]),
    );

    const body = verdictComment();
    expect(body).toContain("**Acceptance-criteria coverage: all 3 examined.**");
    for (const criterion of CRITERIA) expect(body).toContain(criterion);
    expect(body).toContain("nothing drives the 101st request");
    expect(body).not.toContain("left unexamined");
  });

  it("says so, and says which, when the review stopped at the first blocker", async () => {
    // One blocking issue and one criterion looked at — the EO-194 shape.
    await review(rejection([{ criterion: "429 over budget", result: "not_met" }]));

    const body = verdictComment();
    expect(body).toContain("1 of 3 examined");
    expect(body).toContain("2 left unexamined");
    // The next attempt is told this rejection does not establish that
    // its one issue is the only one — which is the whole point.
    expect(body).toContain("does not establish that the blocking issues it lists are all of them");
    expect(body).toContain("Retry-After names when to retry — **not reported**");
    expect(body).toContain("The counter is per key — **not reported**");
  });

  it("counts a criterion the reviewer declined to assess, not only one it left out", async () => {
    await review(
      rejection([
        { criterion: "429 over budget", result: "not_met" },
        { criterion: "Retry-After names when to retry", result: "not_assessed", note: "ran out of budget" },
        { criterion: "The counter is per key", result: "met" },
      ]),
    );

    const body = verdictComment();
    expect(body).toContain("2 of 3 examined");
    expect(body).toContain("Retry-After names when to retry — **not assessed**");
    expect(body).toContain("ran out of budget");
  });

  it("keeps a reported result that matches no declared criterion rather than dropping the work", async () => {
    await review(
      rejection([
        { criterion: "429 over budget", result: "not_met" },
        { criterion: "Retry-After names when to retry", result: "met" },
        { criterion: "The counter is per key", result: "met" },
        { criterion: "The limiter is documented", result: "not_met" },
      ]),
    );

    const body = verdictComment();
    expect(body).toContain("Reported, but matching no criterion this ticket declares:");
    expect(body).toContain("The limiter is documented");
  });

  it("carries the coverage to the next implementation attempt alongside the blocking issues", async () => {
    await review(rejection([{ criterion: "429 over budget", result: "not_met" }]));

    // ARCHITECTURE.md, "One channel": the comment is the channel, so the coverage reaches the next
    // attempt for exactly the reason the feedback does.
    const { buildDispatchContext } = await import("../supervisor/buildDispatchContext.js");
    const context = await buildDispatchContext(handle.db, getItem(handle.db, story.id)!, "implement");

    expect(context).toContain("No test covers a 429 response");
    expect(context).toContain("2 left unexamined");
    expect(context).toContain("The counter is per key — **not reported**");
  });

  it("distinguishes a thorough one-issue rejection from an early stop, from stored data alone", async () => {
    await review(rejection([{ criterion: "429 over budget", result: "not_met" }]));
    const stoppedEarly = listReviewVerdicts(handle.db, story.id).at(-1)!;

    // A second story, same verdict and the same single blocking issue,
    // differing only in how much of the item the review accounted for.
    handle.close();
    handle = openMigratedTestDb();
    story = createTestItem(handle.db, { type: "story", title: "Rate limit the API", stepId: "todo", spec: { acceptance_criteria: CRITERIA } });
    await review(
      rejection([
        { criterion: "429 over budget", result: "not_met" },
        { criterion: "Retry-After names when to retry", result: "met" },
        { criterion: "The counter is per key", result: "met" },
      ]),
    );
    const thorough = listReviewVerdicts(handle.db, story.id).at(-1)!;

    expect(stoppedEarly.blockingIssues).toBe(thorough.blockingIssues); // indistinguishable before EO-200
    expect(stoppedEarly).toMatchObject({ verdict: "reject", declaredCriteria: 3, notReported: 2, unexamined: 2 });
    expect(thorough).toMatchObject({ verdict: "reject", declaredCriteria: 3, met: 2, notMet: 1, unexamined: 0 });
  });

  it("records issues-per-rejection and rounds-per-item in run_events, for any item", async () => {
    const supervisor = supervisorWith(REJECT);
    for (let i = 0; i < 6; i++) await supervisor.runOnce();

    const verdicts = listReviewVerdicts(handle.db, story.id);

    expect(verdicts.length).toBe(3); // rounds-per-item: one row per review
    // issues-per-rejection: REJECT lists two, so nothing here has to
    // read a raw provider payload to find that out.
    expect(verdicts.map((verdict) => verdict.blockingIssues)).toEqual([2, 2, 2]);
    expect(verdicts.every((verdict) => verdict.verdict === "reject")).toBe(true);
  });

  it("leaves an approval alone: no coverage asked for, none rendered", async () => {
    await review(APPROVE);

    const body = verdictComment();
    expect(body).toContain("Approved.");
    expect(body).not.toContain("Acceptance-criteria coverage");
    expect(body).not.toContain("not reported");

    // Still measured — an approval is a round like any other, and the
    // census needs it — but with no coverage obligation recorded
    // against it.
    const approval = listReviewVerdicts(handle.db, story.id).at(-1)!;
    expect(approval).toMatchObject({ verdict: "approve", blockingIssues: 0, declaredCriteria: 3, unexamined: 0, notReported: 0 });
  });

  it("says nothing about coverage for an item that declares no criteria", () => {
    // Posted directly rather than driven through a tick, because a tick
    // can no longer produce it: EO refuses to dispatch a review of a
    // item that declares nothing to judge it against (EO-213). What
    // still can is an item that loses its criteria *during* a review —
    // Jira owns the description they live in and wins on every pull — and
    // the answer is the one it always was, because failing the reviewer
    // for the item's omission would be the wrong party.
    const bare = createTestItem(handle.db, { type: "story", title: "Declares nothing", stepId: "review" });
    const run = createRun(handle.db, { itemId: bare.id, agentId: reviewer.id, action: "review", status: "succeeded" });

    postReviewFeedback(handle.db, bare, reviewer.id, run.id, ReviewOutputSchema.parse(rejection([])));

    expect(verdictComment()).not.toContain("Acceptance-criteria coverage");
    expect(listReviewVerdicts(handle.db, bare.id).at(-1)).toMatchObject({ declaredCriteria: 0, unexamined: 0 });
  });
});

/**
 * Reporting the measurement without anyone remembering to (EO-200).
 *
 * The first attempt at EO-200's last acceptance criterion shipped
 * `scripts/review-census.mts` and a note saying to run it once enough
 * reviews had happened. That is the same mistake the item exists to
 * correct: the 83% in `reviewer.md` was also a number somebody meant to
 * keep checking. So EO does the remembering.
 */
describe("the census EO posts when an item leaves the review loop", () => {
  const census = (): string | undefined => commentBodies().find((body) => body.includes("Review census."));

  async function run(times: number, reviewResult: unknown): Promise<void> {
    const supervisor = supervisorWith(reviewResult);
    for (let i = 0; i < times; i++) await supervisor.runOnce();
  }

  it("says nothing while the item is still going round", async () => {
    // A rejection comment has to stay a list of things to fix.
    await run(2, REJECT);

    expect(census()).toBeUndefined();
  });

  it("posts once, on the approval, with this item's round count", async () => {
    await run(2, APPROVE); // implement, review

    const body = census()!;
    expect(body).toContain("This ticket took 1 review round.");
    expect(commentBodies().filter((candidate) => candidate.includes("Review census."))).toHaveLength(1);
  });

  it("sets the re-measured single-issue share against the recomputed baseline", async () => {
    // Two rejections then an approval: three verdicts, two of them
    // rejections carrying two blocking issues each — so nothing here
    // carries exactly one, and the share is 0%.
    //
    // One supervisor throughout, with the verdict switched by a route
    // that only matches once the flag is set. A second supervisor would
    // carry a second provider, whose thread table is empty — and the
    // implementer reuses its thread, so its resume would find nothing
    // and the run would end without a result.
    let approveNow = false;
    const supervisor = createRunSupervisor({
      db: handle.db,
      limits: LIMITS,
      provider: createScriptedProvider([
        { when: (context) => context.includes(`"implement" action`), script: { result: { branch: "eo/EO-1", summary: "done", handoff: "Nothing to flag." } } },
        { when: (context) => context.includes(`"review" action`) && approveNow, script: { result: APPROVE } },
        { when: (context) => context.includes(`"review" action`), script: { result: REJECT } },
      ]),
      builtins: BUILTIN_RUNNERS,
      ...createRoleWiring(handle.db),
    });

    for (let i = 0; i < 4; i++) await supervisor.runOnce(); // implement, reject, implement, reject
    approveNow = true;
    for (let i = 0; i < 2; i++) await supervisor.runOnce(); // implement, approve

    const body = census()!;
    expect(body).toContain("**0%** of rejections since acceptance-criteria coverage shipped carried exactly one blocking issue (0 of 2)");
    // Against 73% — the recomputed baseline, not the 83% the prompt used
    // to assert. Both appear, so the correction stays legible.
    expect(body).toContain("**73%** baseline before it (99 of 136)");
    expect(body).toContain("83%");
    expect(body).toContain("did not survive being recomputed");
    expect(body).toContain("Issues per rejection: 2.00, against 1.40.");
  });

  it("says so plainly when there is nothing yet to compare", async () => {
    // The state EO-200 itself ships in: coverage is recorded, and no
    // rejection has happened under it yet. A silent report would be
    // indistinguishable from one that never ran.
    await run(2, APPROVE);

    expect(census()).toContain("No rejection has been recorded since acceptance-criteria coverage shipped");
    expect(census()).toContain("73% baseline");
  });

  it("counts the population across every item, not only this one", async () => {
    // The single-issue share is a population statistic, so a per-item
    // reading of it would be a different and much noisier number.
    const other = createTestItem(handle.db, { type: "story", title: "Something else", stepId: "todo", spec: { acceptance_criteria: CRITERIA } });
    const supervisor = supervisorWith(REJECT);
    for (let i = 0; i < 4; i++) await supervisor.runOnce(); // both items implement, both reviewed

    const population = listReviewVerdictsByItem(handle.db);
    expect(population.map((entry) => entry.item).sort()).toEqual([other.key, story.key].sort());
    expect(population.every((entry) => entry.reviews.length > 0)).toBe(true);
  });

  it("is the engine's word, not the reviewer's", async () => {
    // Invariant #4 keeps this in the thread; posting it as the engine
    // keeps it honest about who measured. The reviewer never asserted
    // any of it and was never asked to.
    await run(2, APPROVE);

    const posted = handle.db.select().from(comments).all().find((comment) => comment.body.includes("Review census."))!;
    expect(posted.authorType).toBe("engine");
    expect(posted.authorId).toBeNull();
    expect(posted.kind).toBe("note");
  });
});
