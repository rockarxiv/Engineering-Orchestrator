import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UNCHANGED_SINCE_APPROVAL_RESULT, type AgentEvent, type AgentProvider, type Item } from "@eo/core";
import type { DbHandle } from "../../db/client.js";
import { appendRunEvent, getItem, listCommentsForItem, listRouteTraversals, listRoutesForPipeline, listRunsForItem, listTransitionsForItem } from "../../db/repos/index.js";
import { attachWorkspace, createTestItem, openMigratedTestDb, REVIEWABLE_SPEC } from "../../db/testHelpers.js";
import { loadTemplateHistory } from "../../gallery/history.js";
import { backfillPipelineOrigins } from "../../gallery/origins.js";
import { applyTemplateUpdates } from "../../gallery/templateUpdates.js";
import { validImplementResult } from "../../providers/fixtures.js";
import type { BuiltinRunner } from "../../supervisor/builtins.js";
import { createRunSupervisor } from "../../supervisor/runSupervisor.js";
import { fakeWorkspaceKind, installedKinds } from "../../supervisor/testWorkspaceKinds.js";
import { watchRoundTrips } from "../../supervisor/watches.js";
import type { Check, VerifiableRun } from "../../supervisor/workspaceKind.js";
import { createBuiltinRunners } from "./builtins.js";
import { checkRun, fakeGh, gitHubState } from "./forge/testForges.js";
import { BRANCH_HEAD_EVENT } from "./workspace/branchHead.js";
import { createRoleWiring } from "./wiring.js";

/**
 * A To Do run after failed checks that leaves the approved commit as it
 * was skips Review (EO-930), end to end on the shipped Delivery brought
 * up to date as the first launch does, with the real supervisor, the
 * developer pack's wiring and the real `watch_pull_request` over a
 * scripted `gh`.
 *
 * The workspace kind is the one stand-in: it records, on each implement
 * and review run, the commit the test says the branch is on — what the
 * git kind reads from the repository (`gitKind.test.ts` holds that half to
 * a real one). Merge Request and Reply on pull request are stood in for
 * by their answers on a pull request already open.
 */

const MINUTE = 60_000;
const URL = "https://github.com/acme/api/pull/7";
const GALLERY_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "resources", "gallery");
const APPROVED = "a".repeat(40);
const FIXED = "b".repeat(40);

let handle: DbHandle;
let clock: number;
/** The commit the stand-in kind reads the branch as being on. */
let head: string;
/** What the reviewer answers, in order; the last one repeats. */
let verdicts: ("approve" | "reject")[];

beforeEach(() => {
  handle = openMigratedTestDb();
  // The shipped Delivery as a first launch leaves it: 1.6, with To Do's route past Review.
  const history = loadTemplateHistory(GALLERY_DIRECTORY);
  backfillPipelineOrigins(handle.db, history);
  applyTemplateUpdates(handle.db, history, { isTheRecord: false });
  expect(listRoutesForPipeline(handle.db, "default").find((route) => route.fromStepId === "todo" && route.resultKey === UNCHANGED_SINCE_APPROVAL_RESULT)?.target).toBe("merge_request");
  clock = 1_800_000_000_000;
  head = APPROVED;
  verdicts = ["approve"];
});

afterEach(() => {
  handle.close();
});

function itemOnTodo(): Item {
  const repository = attachWorkspace(handle.db, { name: "acme-api", keyPrefix: "API", repoPath: "/nonexistent/acme-api" });
  return createTestItem(handle.db, {
    type: "story",
    title: "Rate limit the API",
    stepId: "todo",
    workspaceId: repository.id,
    spec: REVIEWABLE_SPEC,
    git: { branch: "eo/API-1", pullRequest: URL },
  });
}

/** Answers as an implementer or a reviewer, by which the turn was opened as. */
function scriptedProvider(): AgentProvider {
  let reviews = 0;
  const answer = (threadId: string, data: unknown): AsyncIterable<AgentEvent> =>
    (async function* (): AsyncIterable<AgentEvent> {
      yield { type: "thread_started", threadId };
      yield { type: "result", data };
    })();
  const review = (threadId: string): AsyncIterable<AgentEvent> => {
    const verdict = verdicts[Math.min(reviews, verdicts.length - 1)];
    reviews += 1;
    return answer(
      threadId,
      verdict === "approve"
        ? { verdict: "approve", feedback: "Checked against the criteria." }
        : { verdict: "reject", feedback: "Not yet.", criteria_coverage: [{ criterion: REVIEWABLE_SPEC.acceptance_criteria[0], result: "not_met" }], blocking_issues: ["No test for the 429."] },
    );
  };
  return {
    start: (opts) => (opts.context.includes('"review" action') ? review("review-thread") : answer("implement-thread", validImplementResult)),
    resume: (threadId) => (threadId === "review-thread" ? review(threadId) : answer(threadId, validImplementResult)),
  };
}

/** Records the commit the branch is on, as the git kind does at the end of an implement or review run. */
const recordsHead = async (_item: Item, run: VerifiableRun): Promise<readonly Check[]> => {
  appendRunEvent(handle.db, run.id, BRANCH_HEAD_EVENT, { commit: head, branch: "eo/API-1" });
  return [];
};

const alreadyOpen: BuiltinRunner = async () => ({ ok: true, result: "opened", detail: `Already open: ${URL}` });
const nothingToReply: BuiltinRunner = async () => ({ ok: true, result: "nothing_to_reply", detail: "Nothing to reply to." });

function supervisor() {
  // Lint failed on the commit; nothing else is pending, so the watch answers `checks_failed`.
  const gh = fakeGh(() => gitHubState({ checkRuns: [checkRun(12, "lint", "completed", "failure")] }));
  return createRunSupervisor({
    db: handle.db,
    provider: scriptedProvider(),
    ...createRoleWiring(handle.db),
    limits: { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 },
    now: () => clock,
    kinds: installedKinds(fakeWorkspaceKind({ verifiers: { implement: recordsHead, review: recordsHead } })),
    builtins: {
      open_pull_request: alreadyOpen,
      reply_on_pull_request: nothingToReply,
      watch_pull_request: createBuiltinRunners(undefined, undefined, undefined, gh.run).watch_pull_request,
    },
    guards: { interpretReplies: false },
  });
}

const stepOf = (item: Item): string | null => getItem(handle.db, item.id)?.stepId ?? null;
const runsOf = (item: Item, action: string) => listRunsForItem(handle.db, item.id).filter((run) => run.action === action);

/** Ticks until the item is on `step`, a watch interval apart, or fails saying where it got stuck. */
async function until(engine: ReturnType<typeof supervisor>, item: Item, step: string): Promise<void> {
  for (let tick = 0; tick < 20; tick += 1) {
    if (stepOf(item) === step) return;
    await engine.runOnce();
    clock += 5 * MINUTE;
  }
  expect(stepOf(item)).toBe(step);
}

/** Implemented, approved at `APPROVED`, opened, and sent back to To Do by the failed check. */
async function approvedThenSentBack(engine: ReturnType<typeof supervisor>, item: Item): Promise<void> {
  await until(engine, item, "review");
  await until(engine, item, "pull_request_watch");
  expect(runsOf(item, "review")).toHaveLength(1);
  await until(engine, item, "todo");
  expect(listTransitionsForItem(handle.db, item.id).at(-1)).toMatchObject({ fromStepId: "pull_request_watch", toStepId: "todo" });
}

const skipNotes = (item: Item) => listCommentsForItem(handle.db, item.id).filter((comment) => comment.body.includes("was skipped because the approved commit was unchanged"));

describe("a To Do run after failed checks", () => {
  it("skips Review when the branch is still the commit Review approved, and the item goes back to being watched", async () => {
    const item = itemOnTodo();
    const engine = supervisor();
    await approvedThenSentBack(engine, item);
    const tripsBefore = watchRoundTrips(handle.db, item.id);
    expect(tripsBefore).toBe(1);

    // The implementer re-runs the flaky job and commits nothing: the branch is on APPROVED still.
    await engine.runOnce();
    expect(runsOf(item, "implement")).toHaveLength(2);
    expect(stepOf(item)).not.toBe("review");
    await until(engine, item, "pull_request_watch");

    expect(runsOf(item, "review")).toHaveLength(1);
    const moves = listTransitionsForItem(handle.db, item.id).map((move) => [move.fromStepId, move.toStepId]);
    expect(moves.slice(-4)).toEqual([
      ["pull_request_watch", "todo"],
      ["todo", "merge_request"],
      ["merge_request", "pull_request_reply"],
      ["pull_request_reply", "pull_request_watch"],
    ]);
    expect(listRouteTraversals(handle.db, item.id, "todo", UNCHANGED_SINCE_APPROVAL_RESULT, null)).toHaveLength(1);

    const [note] = skipNotes(item);
    expect(skipNotes(item)).toHaveLength(1);
    expect(note).toMatchObject({ authorType: "engine", kind: "note" });
    expect(note!.body).toContain("Review was skipped because the approved commit was unchanged");
    expect(note!.body).toContain(APPROVED.slice(0, 12));
    expect(note!.body).toContain("`eo/API-1`");

    // The pass back to the watch still counts towards its round trips:
    // the skip took nothing away, and the next send-back adds one more.
    expect(watchRoundTrips(handle.db, item.id)).toBe(tripsBefore);
    await until(engine, item, "todo");
    expect(watchRoundTrips(handle.db, item.id)).toBe(tripsBefore + 1);
  });

  it("goes to Review as before when the run moved the branch off the approved commit", async () => {
    const item = itemOnTodo();
    const engine = supervisor();
    await approvedThenSentBack(engine, item);

    // The implementer fixed something and committed it.
    head = FIXED;
    await engine.runOnce();

    expect(stepOf(item)).toBe("review");
    expect(listTransitionsForItem(handle.db, item.id).at(-1)).toMatchObject({ fromStepId: "todo", toStepId: "review" });
    expect(listRouteTraversals(handle.db, item.id, "todo", UNCHANGED_SINCE_APPROVAL_RESULT, null)).toEqual([]);
    expect(skipNotes(item)).toEqual([]);
    await engine.runOnce();
    expect(runsOf(item, "review")).toHaveLength(2);
  });

  it("goes to Review as before when Review has never approved the item, whatever commit it last saw", async () => {
    const item = itemOnTodo();
    // The first review rejects the work on APPROVED, and the implementer
    // then leaves the branch where it was.
    verdicts = ["reject", "approve"];
    const engine = supervisor();
    await until(engine, item, "review");
    await engine.runOnce();
    expect(stepOf(item)).toBe("todo");
    expect(runsOf(item, "review")).toHaveLength(1);

    await engine.runOnce();

    expect(runsOf(item, "implement")).toHaveLength(2);
    expect(stepOf(item)).toBe("review");
    expect(listTransitionsForItem(handle.db, item.id).at(-1)).toMatchObject({ fromStepId: "todo", toStepId: "review" });
    expect(listRouteTraversals(handle.db, item.id, "todo", UNCHANGED_SINCE_APPROVAL_RESULT, null)).toEqual([]);
    expect(skipNotes(item)).toEqual([]);
  });

  it("goes to Review as before on a Delivery that does not route the result, even on the approved commit", async () => {
    handle.db.run(sql`DELETE FROM step_routes WHERE from_step_id = 'todo' AND result_key = ${UNCHANGED_SINCE_APPROVAL_RESULT}`);
    const item = itemOnTodo();
    const engine = supervisor();
    await approvedThenSentBack(engine, item);

    await engine.runOnce();

    expect(stepOf(item)).toBe("review");
    expect(listTransitionsForItem(handle.db, item.id).at(-1)).toMatchObject({ fromStepId: "todo", toStepId: "review" });
    expect(listRouteTraversals(handle.db, item.id, "todo", UNCHANGED_SINCE_APPROVAL_RESULT, null)).toEqual([]);
    expect(skipNotes(item)).toEqual([]);
  });
});
