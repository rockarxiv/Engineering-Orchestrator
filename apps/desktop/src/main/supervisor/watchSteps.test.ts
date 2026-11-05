import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Item, StepWatch, Uuid } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import {
  createRoute,
  createStep,
  getItem,
  getItemWatch,
  getStep,
  listCommentsForItem,
  createRun,
  latestRunForItem,
  listActiveRuns,
  listAwaitingInputItemIds,
  listMentionsForComment,
  listRoutesForPipeline,
  listRunEvents,
  listRunsForItem,
  updateRun,
  listStepsForPipeline,
  listTransitionsForItem,
  postComment,
  replacePipelineGraph,
  transitionItem,
} from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { createRunSupervisor, type RunSupervisorOptions } from "./runSupervisor.js";
import { fakeWorkspaceKind, installedKinds } from "./testWorkspaceKinds.js";
import type { BuiltinOutcome, BuiltinRunner } from "./builtins.js";
import { itemWatchView, WAKE_GRACE_MS, WATCH_ROUTED_REASON, WATCH_VERIFICATION_FAILED_REASON } from "./watches.js";
import { createServerPlatform } from "../platform/server.js";
import { sourceTreeResources } from "../testing/platform.js";

/**
 * Keep checking, end to end (EO-456, ARCHITECTURE.md, "A step",
 * "Guardrails").
 *
 * A builtin step set to keep checking runs a short check on an interval
 * until one comes back with a result key. Everything here runs on a fake
 * clock, because the whole feature is about time: when the next check is
 * due, how long the backoff waits, and when the watch gives up.
 *
 * The function is `create_worktree` only because a builtin step has to
 * name one the installed registry knows; the runner behind it is each
 * test's own, and nothing here is about worktrees.
 */

const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };
const MINUTE = 60_000;
const START = 1_800_000_000_000;

let handle: DbHandle;
let clock: number;
let item: Item;

function seed(watch: StepWatch | null = { everyMinutes: 5, giveUpAfterHours: 168 }, type: "builtin" | "module" = "builtin"): void {
  createStep(handle.db, {
    id: "watch",
    pipelineId: "default" as Uuid,
    position: 15,
    name: "Wait for it",
    type,
    entryAction: type === "builtin" ? "create_worktree" : "mod-check",
    watch,
  });
  createStep(handle.db, { id: "fix", pipelineId: "default" as Uuid, position: 16, name: "Fix it", type: "user" });
  createRoute(handle.db, { pipelineId: "default" as Uuid, fromStepId: "watch", resultKey: "arrived", label: "Arrived", target: "terminal", position: 0 });
  createRoute(handle.db, { pipelineId: "default" as Uuid, fromStepId: "watch", resultKey: "broke", label: "Broke", target: "fix", position: 1 });
  item = createTestItem(handle.db, { type: "story", title: "Wait for the signature", stepId: "watch" });
}

function supervisorWith(
  check: BuiltinRunner,
  options: {
    roundTrips?: number;
    module?: boolean;
    onItemChanged?: (itemId: Uuid) => void;
    limits?: RunSupervisorOptions["limits"];
    pushes?: Pick<RunSupervisorOptions, "onRunChanged" | "onPushEvents">;
    kinds?: RunSupervisorOptions["kinds"];
    platform?: Pick<RunSupervisorOptions, "isOnline" | "onWake" | "sleeps" | "tickIntervalMs" | "watchdogIntervalMs">;
  } = {},
) {
  return createRunSupervisor({
    db: handle.db,
    ...options.platform,
    ...options.pushes,
    ...(options.onItemChanged ? { onItemChanged: options.onItemChanged } : {}),
    ...(options.kinds ? { kinds: options.kinds } : {}),
    provider: { start: () => { throw new Error("a check must not reach a provider"); } } as never,
    limits: options.limits ?? LIMITS,
    now: () => clock,
    ...(options.module ? { moduleRunner: (id: string) => (id === "mod-check" ? check : undefined) } : { builtins: { create_worktree: check } }),
    // A reply is handed straight back to the step rather than read by the
    // system agent first, which is a separate story with its own tests.
    guards: { interpretReplies: false, ...(options.roundTrips === undefined ? {} : { watchRoundTripsPerItem: options.roundTrips }) },
  });
}

const waiting = (news?: { id: string; text: string }[]): BuiltinOutcome => ({ ok: true, result: "waiting", detail: "", ...(news ? { news } : {}) });

/** The item's runs that hold quiet checks: the ones with no start of their own. */
const quietRuns = () => listRunsForItem(handle.db, item.id).filter((run) => run.startedAt === null);

/** What the item's quiet runs say, line by line. */
const quietLines = () => quietRuns().flatMap((run) => listRunEvents(handle.db, run.id).map((event) => (event.payload as { text: string }).text));

beforeEach(() => {
  handle = openMigratedTestDb();
  clock = START;
});

afterEach(() => {
  handle.close();
});

describe("a step that keeps checking", () => {
  it("writes the watch row and one line on a quiet run when a check is still waiting with nothing new", async () => {
    seed();
    const check = vi.fn<BuiltinRunner>(async () => ({ ok: true, result: "waiting", detail: "The envelope is unopened." }));

    await supervisorWith(check).runOnce();

    expect(check).toHaveBeenCalledTimes(1);
    expect(listRunsForItem(handle.db, item.id)).toMatchObject([{ agentId: null, action: "create_worktree", stepId: "watch", status: "succeeded", provider: "builtin", startedAt: null, endedAt: START, result: null }]);
    expect(quietLines()).toEqual(["The envelope is unopened."]);
    expect(listCommentsForItem(handle.db, item.id)).toEqual([]);
    expect(getItemWatch(handle.db, item.id, "watch")).toMatchObject({
      startedAt: START,
      lastCheckedAt: START,
      nextCheckAt: START + 5 * MINUTE,
      checks: 1,
      consecutiveFailures: 0,
    });
    expect(getItem(handle.db, item.id)?.stepId).toBe("watch");
  });

  it("is not checked again until the next check is due, and says when that is", async () => {
    seed();
    const check = vi.fn<BuiltinRunner>(async () => waiting());
    const supervisor = supervisorWith(check);

    await supervisor.runOnce();
    clock = START + 4 * MINUTE;
    await supervisor.runOnce();
    expect(check).toHaveBeenCalledTimes(1);
    expect(supervisor.dispatchBlockerFor(item.id)).toEqual({ kind: "watching", nextCheckAt: START + 5 * MINUTE, giveUpAt: START + 168 * 60 * MINUTE });

    clock = START + 5 * MINUTE;
    await supervisor.runOnce();
    expect(check).toHaveBeenCalledTimes(2);
    expect(getItemWatch(handle.db, item.id, "watch")).toMatchObject({ checks: 2, nextCheckAt: START + 10 * MINUTE });
  });

  it("routes a result key through the step's routes, as a builtin's result does", async () => {
    seed();
    const supervisor = supervisorWith(async () => ({ ok: true, result: "arrived", detail: "Signed" }));

    await supervisor.runOnce();

    const moved = getItem(handle.db, item.id)!;
    expect(getStep(handle.db, moved.stepId!)?.isTerminal).toBe(true);
    const [run] = listRunsForItem(handle.db, item.id);
    expect(run).toMatchObject({ agentId: null, action: "create_worktree", stepId: "watch", status: "succeeded", provider: "builtin" });
    expect(run?.result?.parsed).toEqual({ result: "arrived" });
    const transition = listTransitionsForItem(handle.db, item.id).at(-1);
    expect(transition).toMatchObject({ fromStepId: "watch", runId: run?.id, actor: "engine", reason: WATCH_ROUTED_REASON });
  });

  it("posts news as one comment per check, leaving out ids already posted for this watch", async () => {
    seed();
    const answers = [
      waiting([
        { id: "job-1", text: "Lint failed" },
        { id: "comment-7", text: "Please rename this" },
      ]),
      waiting([
        { id: "comment-7", text: "Please rename this" },
        { id: "job-2", text: "Tests failed" },
      ]),
      waiting([{ id: "job-2", text: "Tests failed" }]),
    ];
    const supervisor = supervisorWith(async () => answers.shift()!);

    await supervisor.runOnce();
    clock += 5 * MINUTE;
    await supervisor.runOnce();
    clock += 5 * MINUTE;
    await supervisor.runOnce();

    const posted = listCommentsForItem(handle.db, item.id);
    expect(posted).toHaveLength(2);
    expect(posted[0]?.body).toContain("> Lint failed");
    expect(posted[0]?.body).toContain("> Please rename this");
    expect(posted[1]?.body).toContain("> Tests failed");
    expect(posted[1]?.body).not.toContain("Please rename this");
    expect(posted.every((comment) => comment.authorType === "engine")).toBe(true);
    // A check with news is a run; the third, with nothing new, is a line
    // on the quiet run.
    expect(listRunsForItem(handle.db, item.id).filter((run) => run.startedAt !== null).map((run) => run.status)).toEqual(["succeeded", "succeeded"]);
    expect(quietRuns()).toHaveLength(1);
    expect(getItemWatch(handle.db, item.id, "watch")?.postedNewsIds).toEqual(["job-1", "comment-7", "job-2"]);
  });

  it("posts the news a result carries before the item routes, leaving out ids this watch already posted", async () => {
    seed();
    const answers: BuiltinOutcome[] = [
      waiting([{ id: "job-1", text: "Lint failed" }]),
      {
        ok: true,
        result: "broke",
        detail: "",
        news: [
          { id: "job-1", text: "Lint failed" },
          { id: "job-2", text: "Tests failed" },
        ],
      },
    ];
    const supervisor = supervisorWith(async () => answers.shift()!);

    await supervisor.runOnce();
    clock += 5 * MINUTE;
    await supervisor.runOnce();

    expect(getItem(handle.db, item.id)?.stepId).toBe("fix");
    const posted = listCommentsForItem(handle.db, item.id);
    expect(posted).toHaveLength(2);
    expect(posted[1]?.body).toContain('"Wait for it" reported "broke", and noticed something new.');
    expect(posted[1]?.body).toContain("> Tests failed");
    expect(posted[1]?.body).not.toContain("Lint failed");
    // Named for the run that routed, so the timeline shows the reason beside the move.
    const routed = listRunsForItem(handle.db, item.id).at(-1);
    expect(posted[1]?.runId).toBe(routed?.id);
    expect(routed?.result?.parsed).toEqual({ result: "broke" });
  });

  it("gives up after its give-up time, parks the item and mentions the owner, saying how long it watched", async () => {
    seed({ everyMinutes: 30, giveUpAfterHours: 2 });
    const check = vi.fn<BuiltinRunner>(async () => waiting());
    const supervisor = supervisorWith(check);

    for (let at = 0; at <= 120; at += 30) {
      clock = START + at * MINUTE;
      await supervisor.runOnce();
    }

    // Checks at 0, 30, 60 and 90 minutes; at 120 it has run out of time.
    expect(check).toHaveBeenCalledTimes(4);
    expect(listRunsForItem(handle.db, item.id).at(-1)?.status).toBe("awaiting_input");
    const [comment] = listCommentsForItem(handle.db, item.id);
    expect(comment?.kind).toBe("escalation");
    expect(comment?.authorType).toBe("engine");
    expect(comment?.body).toContain("watched for 2 hours");
    const mentions = listMentionsForComment(handle.db, comment!.id);
    expect(mentions).toEqual([expect.objectContaining({ targetType: "human", targetId: item.createdBy })]);

    clock += 30 * MINUTE;
    await supervisor.runOnce();
    expect(check).toHaveBeenCalledTimes(4);
  });

  it("retries a failing check after 1, 2, 5, 10 and 30 minutes, and escalates the sixth failure in a row with its error", async () => {
    seed();
    let failures = 0;
    const check = vi.fn<BuiltinRunner>(async () => {
      failures += 1;
      throw new Error(`the service answered 503 (try ${failures})`);
    });
    const supervisor = supervisorWith(check);

    const waits: number[] = [];
    await supervisor.runOnce();
    for (let failure = 1; failure < 6; failure += 1) {
      const watch = getItemWatch(handle.db, item.id, "watch")!;
      waits.push((watch.nextCheckAt - clock) / MINUTE);
      // Not a moment early.
      clock = watch.nextCheckAt - 1;
      await supervisor.runOnce();
      expect(check).toHaveBeenCalledTimes(failure);
      clock = watch.nextCheckAt;
      await supervisor.runOnce();
    }

    expect(waits).toEqual([1, 2, 5, 10, 30]);
    expect(check).toHaveBeenCalledTimes(6);
    const statuses = listRunsForItem(handle.db, item.id).map((run) => run.status);
    expect(statuses).toEqual(["failed", "failed", "failed", "failed", "failed", "awaiting_input"]);
    const comments = listCommentsForItem(handle.db, item.id);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.kind).toBe("escalation");
    expect(comments[0]?.body).toContain("the service answered 503 (try 6)");
    expect(getItemWatch(handle.db, item.id, "watch")).toMatchObject({ consecutiveFailures: 6, lastError: "the service answered 503 (try 6)" });

    clock += 60 * MINUTE;
    await supervisor.runOnce();
    expect(check).toHaveBeenCalledTimes(6);
  });

  it("starts again when a person answers the park, and records that check so the park is closed", async () => {
    seed();
    const answers: BuiltinOutcome[] = Array.from({ length: 6 }, () => ({ ok: false, reason: "down" }));
    answers.push(waiting());
    const supervisor = supervisorWith(async () => answers.shift()!);
    await supervisor.runOnce();
    for (let failure = 1; failure < 6; failure += 1) {
      clock = getItemWatch(handle.db, item.id, "watch")!.nextCheckAt;
      await supervisor.runOnce();
    }
    expect(listRunsForItem(handle.db, item.id).at(-1)?.status).toBe("awaiting_input");

    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "It is back up." });
    await supervisor.resumeItem(item.id);

    expect(answers).toEqual([]);
    expect(listRunsForItem(handle.db, item.id).at(-1)).toMatchObject({ status: "succeeded" });
    expect(getItemWatch(handle.db, item.id, "watch")).toMatchObject({ consecutiveFailures: 0, startedAt: clock, nextCheckAt: clock + 5 * MINUTE });
    expect(supervisor.dispatchBlockerFor(item.id)).toEqual({ kind: "watching", nextCheckAt: clock + 5 * MINUTE, giveUpAt: clock + 168 * 60 * MINUTE });
  });

  it("parks an item watches have sent to another step as many times as the guardrail allows since anybody commented", async () => {
    seed();
    const check = vi.fn<BuiltinRunner>(async () => ({ ok: true, result: "broke", detail: "" }));
    const supervisor = supervisorWith(check, { roundTrips: 2 });

    for (let trip = 1; trip <= 2; trip += 1) {
      await supervisor.runOnce();
      expect(getItem(handle.db, item.id)?.stepId).toBe("fix");
      // Somebody's step sends it back, saying nothing on the thread.
      transitionItem(handle.db, { itemId: item.id, toStepId: "watch", actor: "engine", reason: "fixed" });
      clock += MINUTE;
    }
    await supervisor.runOnce();

    expect(check).toHaveBeenCalledTimes(2);
    expect(getItem(handle.db, item.id)?.stepId).toBe("watch");
    expect(listRunsForItem(handle.db, item.id).at(-1)?.status).toBe("awaiting_input");
    const parked = listCommentsForItem(handle.db, item.id).at(-1);
    expect(parked?.kind).toBe("escalation");
    expect(parked?.body).toContain("sent this ticket to another step 2 times since anybody commented on it, and the limit is 2");

    // A person saying anything starts the count again.
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Try once more." });
    await supervisor.resumeItem(item.id);
    expect(check).toHaveBeenCalledTimes(3);
    expect(getItem(handle.db, item.id)?.stepId).toBe("fix");
  });

  it("allows five round trips by default", async () => {
    seed();
    const check = vi.fn<BuiltinRunner>(async () => ({ ok: true, result: "broke", detail: "" }));
    const supervisor = supervisorWith(check);

    for (let trip = 1; trip <= 6; trip += 1) {
      await supervisor.runOnce();
      if (getItem(handle.db, item.id)?.stepId === "fix") transitionItem(handle.db, { itemId: item.id, toStepId: "watch", actor: "engine", reason: "fixed" });
      clock += MINUTE;
    }

    expect(check).toHaveBeenCalledTimes(5);
    expect(listCommentsForItem(handle.db, item.id).at(-1)?.body).toContain("the limit is 5");
  });

  it("watches afresh when the item comes back to the step, rather than carrying the old watch's clock and news", async () => {
    seed();
    const answers: BuiltinOutcome[] = [waiting([{ id: "a", text: "first" }]), { ok: true, result: "broke", detail: "" }, waiting([{ id: "a", text: "first" }])];
    const supervisor = supervisorWith(async () => answers.shift()!);
    await supervisor.runOnce();
    clock += 5 * MINUTE;
    await supervisor.runOnce();
    transitionItem(handle.db, { itemId: item.id, toStepId: "watch", actor: "engine", reason: "fixed" });
    clock += MINUTE;
    await supervisor.runOnce();

    expect(getItemWatch(handle.db, item.id, "watch")).toMatchObject({ startedAt: clock, checks: 1, postedNewsIds: ["a"] });
    expect(listCommentsForItem(handle.db, item.id).filter((comment) => comment.body.includes("> first"))).toHaveLength(2);
  });

  it("works the same on a module step: waiting with nothing new is a line on the quiet run, and news is the module's comment", async () => {
    seed({ everyMinutes: 1, giveUpAfterHours: 1 }, "module");
    const answers = [waiting(), waiting([{ id: "reply-1", text: "Customer replied" }])];
    const supervisor = supervisorWith(async () => answers.shift()!, { module: true });

    await supervisor.runOnce();
    expect(listRunsForItem(handle.db, item.id)).toMatchObject([{ provider: "module", status: "succeeded", startedAt: null }]);
    clock += MINUTE;
    await supervisor.runOnce();

    const [, run] = listRunsForItem(handle.db, item.id);
    expect(run).toMatchObject({ provider: "module", status: "succeeded", startedAt: clock });
    const [comment] = listCommentsForItem(handle.db, item.id);
    expect(comment).toMatchObject({ authorType: "module", runId: run?.id });
    expect(comment?.body).toContain("> Customer replied");
  });

  it("makes the run before anything that has to name it, when a check writes something while it waits", async () => {
    seed();
    const supervisor = supervisorWith(async (context) => {
      context.ensureRun?.();
      postComment(handle.db, { itemId: context.item.id, runId: context.runId, author: { type: "module" }, body: "Looked." });
      return waiting();
    });

    await supervisor.runOnce();

    const [run] = listRunsForItem(handle.db, item.id);
    expect(run?.status).toBe("succeeded");
    expect(listCommentsForItem(handle.db, item.id)[0]?.runId).toBe(run?.id);
  });

  it("gives up on the hour it was told to, even when its next check is a day away", async () => {
    seed({ everyMinutes: 1440, giveUpAfterHours: 1 });
    const check = vi.fn<BuiltinRunner>(async () => waiting());
    const supervisor = supervisorWith(check);

    await supervisor.runOnce();
    expect(supervisor.dispatchBlockerFor(item.id)).toEqual({ kind: "watching", nextCheckAt: START + 1440 * MINUTE, giveUpAt: START + 60 * MINUTE });

    clock = START + 59 * MINUTE;
    await supervisor.runOnce();
    expect(check).toHaveBeenCalledTimes(1);
    expect(listAwaitingInputItemIds(handle.db).has(item.id)).toBe(false);

    clock = START + 60 * MINUTE;
    await supervisor.runOnce();

    // Parked by the deadline, without a second check being asked.
    expect(check).toHaveBeenCalledTimes(1);
    expect(listRunsForItem(handle.db, item.id).map((run) => run.status)).toEqual(["succeeded", "awaiting_input"]);
    expect(listAwaitingInputItemIds(handle.db).has(item.id)).toBe(true);
    expect(listCommentsForItem(handle.db, item.id).at(-1)?.body).toContain("watched for 1 hour");
  });

  it("gives up on time when the deadline falls inside a failing check's backoff", async () => {
    // Six minutes: failures at 0, 1 and 3 minutes, the next retry due at 8.
    seed({ everyMinutes: 5, giveUpAfterHours: 0.1 });
    const check = vi.fn<BuiltinRunner>(async () => ({ ok: false, reason: "the service answered 503" }));
    const supervisor = supervisorWith(check);

    for (const at of [0, 1, 3]) {
      clock = START + at * MINUTE;
      await supervisor.runOnce();
    }
    expect(check).toHaveBeenCalledTimes(3);
    expect(getItemWatch(handle.db, item.id, "watch")?.nextCheckAt).toBe(START + 8 * MINUTE);

    clock = START + 6 * MINUTE;
    await supervisor.runOnce();

    expect(check).toHaveBeenCalledTimes(3);
    expect(listRunsForItem(handle.db, item.id).at(-1)?.status).toBe("awaiting_input");
    const parked = listCommentsForItem(handle.db, item.id).at(-1);
    expect(parked?.kind).toBe("escalation");
    expect(parked?.body).toContain("watched for 6 minutes");
  });

  it("tells open windows the item changed after a quiet check, so the item page shows the new times", async () => {
    seed();
    const changed: string[] = [];
    await supervisorWith(async () => waiting(), { onItemChanged: (itemId) => changed.push(itemId) }).runOnce();

    expect(changed).toContain(item.id);
  });

  it("counts a move a watch made because its workspace could not confirm the check towards the round-trip guardrail", async () => {
    seed();
    createRoute(handle.db, { pipelineId: "default" as Uuid, fromStepId: "watch", resultKey: "verification_failed", label: "Could not confirm", target: "fix", position: 2 });
    const refusing = installedKinds(
      fakeWorkspaceKind({
        verifiers: {
          create_worktree: async () => [{ key: "confirmed", passed: false, blocks: true, describes: "Nothing on the other end says it arrived." }],
        },
      }),
    );
    const check = vi.fn<BuiltinRunner>(async ({ item: onItem, prepareWorkspace }) => {
      const prepared = await prepareWorkspace(onItem, "create_worktree");
      if (!prepared.ok) return { ok: false, reason: prepared.reason };
      return { ok: true, result: "arrived", detail: "" };
    });
    const supervisor = supervisorWith(check, { roundTrips: 2, kinds: refusing });

    for (let trip = 1; trip <= 2; trip += 1) {
      await supervisor.runOnce();
      expect(getItem(handle.db, item.id)?.stepId).toBe("fix");
      expect(listTransitionsForItem(handle.db, item.id).at(-1)?.reason).toBe(WATCH_VERIFICATION_FAILED_REASON);
      transitionItem(handle.db, { itemId: item.id, toStepId: "watch", actor: "engine", reason: "repaired" });
      clock += MINUTE;
    }
    await supervisor.runOnce();

    expect(check).toHaveBeenCalledTimes(2);
    expect(getItem(handle.db, item.id)?.stepId).toBe("watch");
    expect(listCommentsForItem(handle.db, item.id).at(-1)?.body).toContain("the limit is 2");
  });
});

/**
 * A step that never gives up (EO-571): no deadline at all, however long
 * the watch has run — but the two stops that are not about time still
 * stop it, with the comments they always post.
 */
describe("a quiet check's run (EO-618)", () => {
  const quietCheck = (detail: string): BuiltinOutcome => ({ ok: true, result: "waiting", detail });

  it("puts every quiet check of a stay on one run, one line each, and says it is still waiting when the check gave no detail", async () => {
    seed();
    const answers = [quietCheck("Unopened."), waiting(), quietCheck("   "), quietCheck("Opened, not signed.")];
    const supervisor = supervisorWith(async () => answers.shift()!);

    for (let check = 0; check < 4; check += 1) {
      await supervisor.runOnce();
      clock += 5 * MINUTE;
    }

    const [run, ...others] = listRunsForItem(handle.db, item.id);
    expect(others).toEqual([]);
    expect(run).toMatchObject({ status: "succeeded", startedAt: null, endedAt: START + 15 * MINUTE });
    expect(quietLines()).toEqual(["Unopened.", "Still waiting.", "Still waiting.", "Opened, not signed."]);
    expect(listRunEvents(handle.db, run!.id).map((event) => event.type)).toEqual(["output", "output", "output", "output"]);
    expect(getItemWatch(handle.db, item.id, "watch")?.checks).toBe(4);
  });

  it("makes a new run when the item leaves the step and comes back", async () => {
    seed();
    const supervisor = supervisorWith(async () => quietCheck("Unopened."));
    await supervisor.runOnce();

    transitionItem(handle.db, { itemId: item.id, toStepId: "fix", actor: "engine", reason: "sent back" });
    transitionItem(handle.db, { itemId: item.id, toStepId: "watch", actor: "engine", reason: "fixed" });
    clock += MINUTE;
    await supervisor.runOnce();
    clock += 5 * MINUTE;
    await supervisor.runOnce();

    const [first, second, ...others] = quietRuns();
    expect(others).toEqual([]);
    expect(listRunEvents(handle.db, first!.id)).toHaveLength(1);
    expect(listRunEvents(handle.db, second!.id)).toHaveLength(2);
    // Ordered by id like any other run, so the stay that began later is later.
    expect(first!.id < second!.id).toBe(true);
  });

  it("tells a window of the run when it is made, and of each new line", async () => {
    seed();
    const announced: string[] = [];
    const lines: string[] = [];
    const supervisor = supervisorWith(async () => waiting(), {
      pushes: { onRunChanged: (runId) => announced.push(runId), onPushEvents: (runId) => lines.push(runId) },
    });

    await supervisor.runOnce();
    clock += 5 * MINUTE;
    await supervisor.runOnce();

    const [run] = quietRuns();
    expect(announced).toEqual([run?.id]);
    expect(lines).toEqual([run?.id, run?.id]);
  });

  it("never counts as active: the item is watching, and a second item takes the only slot", async () => {
    seed();
    const other = createTestItem(handle.db, { type: "story", title: "Wait for the other signature", stepId: "watch" });
    const check = vi.fn<BuiltinRunner>(async () => waiting());
    const supervisor = supervisorWith(check, { limits: { ...LIMITS, globalConcurrency: 1 } });

    await supervisor.runOnce();
    await supervisor.runOnce();

    expect(check.mock.calls.map(([context]) => context.item.id).sort()).toEqual([item.id, other.id].sort());
    expect(listActiveRuns(handle.db)).toEqual([]);
    expect(supervisor.dispatchBlockerFor(item.id)).toMatchObject({ kind: "watching" });
  });

  it("gives news, a result and an error their own runs, as they always had, beside it", async () => {
    seed();
    const answers: BuiltinOutcome[] = [quietCheck("Unopened."), waiting([{ id: "a", text: "Opened" }]), quietCheck("Unsigned."), { ok: false, reason: "down" }, { ok: true, result: "arrived", detail: "Signed" }];
    const supervisor = supervisorWith(async () => answers.shift()!);

    for (let check = 0; check < 5; check += 1) {
      clock = getItemWatch(handle.db, item.id, "watch")?.nextCheckAt ?? clock;
      await supervisor.runOnce();
    }

    expect(quietLines()).toEqual(["Unopened.", "Unsigned."]);
    expect(listRunsForItem(handle.db, item.id).filter((run) => run.startedAt !== null).map((run) => run.status)).toEqual(["succeeded", "failed", "succeeded"]);
  });

  it("stays out of the newest run, so a park made while a check ran is still a park, and the card reads what it read", async () => {
    seed();
    const supervisor = supervisorWith(async (context) => {
      const parked = createRun(handle.db, { itemId: context.item.id, agentId: null, action: "create_worktree", stepId: "watch", status: "awaiting_input" });
      updateRun(handle.db, parked.id, { startedAt: clock - MINUTE, endedAt: clock - MINUTE });
      return waiting();
    });

    await supervisor.runOnce();

    expect(quietRuns()).toHaveLength(1);
    expect(listAwaitingInputItemIds(handle.db).has(item.id)).toBe(true);
    expect(latestRunForItem(handle.db, item.id)?.status).toBe("awaiting_input");
  });

  it("carries the reply's check on a run of its own, which closes the park, and says it is still waiting there too", async () => {
    seed();
    const answers: BuiltinOutcome[] = [...Array.from({ length: 6 }, (): BuiltinOutcome => ({ ok: false, reason: "down" })), waiting()];
    const supervisor = supervisorWith(async () => answers.shift()!);
    for (let failure = 0; failure < 6; failure += 1) {
      clock = getItemWatch(handle.db, item.id, "watch")?.nextCheckAt ?? clock;
      await supervisor.runOnce();
    }

    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "It is back up." });
    await supervisor.resumeItem(item.id);

    expect(listAwaitingInputItemIds(handle.db).has(item.id)).toBe(false);
    expect(quietRuns()).toEqual([]);
    const events = listRunEvents(handle.db, listRunsForItem(handle.db, item.id).at(-1)!.id);
    expect(events.map((event) => event.payload)).toEqual([{ type: "output", text: "Still waiting." }]);
  });
});

describe("a step that keeps checking and never gives up", () => {
  const NEVER: StepWatch = { everyMinutes: 5, giveUpAfterHours: 168, neverGivesUp: true };
  const YEAR = 365 * 24 * 60 * MINUTE;

  it("checks a watch that started a year ago instead of parking it, and is held only until its next check", async () => {
    seed(NEVER);
    const check = vi.fn<BuiltinRunner>(async () => waiting());
    const supervisor = supervisorWith(check);

    clock = START - YEAR;
    await supervisor.runOnce();
    expect(getItemWatch(handle.db, item.id, "watch")?.startedAt).toBe(START - YEAR);

    // A year on, far past the week a watch that leaves the time out gets.
    clock = START;
    await supervisor.runOnce();

    expect(check).toHaveBeenCalledTimes(2);
    expect(listRunsForItem(handle.db, item.id).filter((run) => run.startedAt !== null)).toEqual([]);
    expect(listCommentsForItem(handle.db, item.id)).toEqual([]);
    expect(getItem(handle.db, item.id)?.stepId).toBe("watch");
    expect(getItemWatch(handle.db, item.id, "watch")).toMatchObject({ startedAt: START - YEAR, checks: 2, nextCheckAt: START + 5 * MINUTE });

    // Held until the next check, and nothing else: there is no deadline to wake it.
    expect(supervisor.dispatchBlockerFor(item.id)).toEqual({ kind: "watching", nextCheckAt: START + 5 * MINUTE, giveUpAt: null });
    expect(itemWatchView(handle.db, getItem(handle.db, item.id)!, getStep(handle.db, "watch"))).toMatchObject({ startedAt: START - YEAR, giveUpAt: null });
    clock = START + 4 * MINUTE;
    await supervisor.runOnce();
    expect(check).toHaveBeenCalledTimes(2);
    clock = START + 5 * MINUTE;
    await supervisor.runOnce();
    expect(check).toHaveBeenCalledTimes(3);
    expect(listCommentsForItem(handle.db, item.id).some((comment) => comment.body.includes("has stopped checking"))).toBe(false);
  });

  it("is still parked by the round-trip guardrail, with the same comment", async () => {
    seed(NEVER);
    const check = vi.fn<BuiltinRunner>(async () => ({ ok: true, result: "broke", detail: "" }));
    const supervisor = supervisorWith(check, { roundTrips: 2 });

    for (let trip = 1; trip <= 2; trip += 1) {
      await supervisor.runOnce();
      expect(getItem(handle.db, item.id)?.stepId).toBe("fix");
      transitionItem(handle.db, { itemId: item.id, toStepId: "watch", actor: "engine", reason: "fixed" });
      clock += MINUTE;
    }
    await supervisor.runOnce();

    expect(check).toHaveBeenCalledTimes(2);
    expect(listRunsForItem(handle.db, item.id).at(-1)?.status).toBe("awaiting_input");
    const parked = listCommentsForItem(handle.db, item.id).at(-1);
    expect(parked?.kind).toBe("escalation");
    expect(parked?.body).toContain('Stopped before "Wait for it" checked again: steps that keep checking have sent');
    expect(parked?.body).toContain("sent this ticket to another step 2 times since anybody commented on it, and the limit is 2");
  });

  it("is still escalated by the sixth failed check in a row, with its error", async () => {
    seed(NEVER);
    let failures = 0;
    const check = vi.fn<BuiltinRunner>(async () => {
      failures += 1;
      throw new Error(`the service answered 503 (try ${failures})`);
    });
    const supervisor = supervisorWith(check);

    await supervisor.runOnce();
    for (let failure = 1; failure < 6; failure += 1) {
      clock = getItemWatch(handle.db, item.id, "watch")!.nextCheckAt;
      await supervisor.runOnce();
    }

    expect(check).toHaveBeenCalledTimes(6);
    expect(listRunsForItem(handle.db, item.id).map((run) => run.status)).toEqual(["failed", "failed", "failed", "failed", "failed", "awaiting_input"]);
    const comments = listCommentsForItem(handle.db, item.id);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.kind).toBe("escalation");
    expect(comments[0]?.body).toBe(
      '"Wait for it" has stopped checking: its check failed 6 times in a row, and after 6 EO stops retrying and asks. The last error was:\n\nthe service answered 503 (try 6)\n\nReply here once it should try again.',
    );

    clock += 60 * MINUTE;
    await supervisor.runOnce();
    expect(check).toHaveBeenCalledTimes(6);
  });
});

/**
 * Offline and just after a wake (EO-457, ARCHITECTURE.md, "A step").
 *
 * A check that cannot reach what it checks fails, and six failures in a
 * row escalate the item — so a watch checked during an outage, or in
 * the minute after a wake before the network is back, would be
 * escalated for nothing it did wrong. The platform is faked: whether it
 * is online is a variable, and a wake is the listener `onWake` was
 * handed, called by the test.
 */
/**
 * A check on a step that runs once (EO-505): a pipeline published before
 * `validatePipeline` refused it can still run a function that waits with
 * keep checking off. The first `waiting` parks the item asking for keep
 * checking — not for a route, which is what used to loop the item.
 */
describe("a check on a step that runs once", () => {
  /** What `waiting` on such a step says, whoever answered it. */
  function expectParkedForKeepChecking(subject: string): void {
    expect(getItem(handle.db, item.id)?.stepId).toBe("watch");
    const [run] = listRunsForItem(handle.db, item.id);
    expect(run).toMatchObject({ status: "awaiting_input", stepId: "watch" });
    expect(run?.result?.parsed).toEqual({ result: "waiting" });
    expect(run?.error).toBe(`${subject} answered "waiting", but "Wait for it" runs once, so nothing would ask it again.`);
    const [comment] = listCommentsForItem(handle.db, item.id);
    expect(comment).toMatchObject({ kind: "escalation", authorType: "engine", runId: run?.id });
    expect(comment?.body).toBe(
      `${subject} answered "waiting": it checks on something until it has a result, and "Wait for it" runs it once, so nothing will ask it again. ` +
        `"Wait for it" needs keep checking turned on.\n\n` +
        `Turning it on in the pipeline's settings reaches items that enter this pipeline afterwards, not this one: it finishes on the version it entered on, where "Wait for it" runs once. ` +
        `For this one, reply here to check once more — it carries on if what it waits on has happened, and stops here again if not — or move it on by hand.`,
    );
    expect(comment?.body).not.toContain("route");
    expect(listMentionsForComment(handle.db, comment!.id)).toEqual([expect.objectContaining({ targetType: "human" })]);
    // No watch was started for it: the step does not keep checking.
    expect(getItemWatch(handle.db, item.id, "watch")).toBeUndefined();
  }

  it("parks a builtin's waiting with a comment saying the step needs keep checking, and is not dispatched again", async () => {
    seed(null);
    const check = vi.fn<BuiltinRunner>(async () => waiting());
    const supervisor = supervisorWith(check);

    await supervisor.runOnce();
    expectParkedForKeepChecking(`"create_worktree"`);

    clock += 5 * MINUTE;
    await supervisor.runOnce();
    expect(check).toHaveBeenCalledTimes(1);
    expect(listCommentsForItem(handle.db, item.id)).toHaveLength(1);
  });

  it("parks a module's waiting the same way, naming it by its step rather than its id", async () => {
    seed(null, "module");
    const supervisor = supervisorWith(async () => waiting(), { module: true });

    await supervisor.runOnce();
    expectParkedForKeepChecking(`The module on "Wait for it"`);
  });

  /**
   * What the comment promises, held to what versioning does (EO-327):
   * publishing keep checking does not reach the parked item, which stays
   * on the version it entered on — a reply checks once more there, and
   * an item entering afterwards is the one that is watched.
   */
  it("keeps its word after keep checking is published: the parked item checks once per reply on its own version, and a new item is watched", async () => {
    seed(null);
    const answers: BuiltinOutcome[] = [waiting(), waiting(), { ok: true, result: "arrived", detail: "Signed" }, waiting()];
    const check = vi.fn<BuiltinRunner>(async () => answers.shift()!);
    const supervisor = supervisorWith(check);

    await supervisor.runOnce();
    expectParkedForKeepChecking(`"create_worktree"`);
    const enteredOn = getItem(handle.db, item.id)!.pipelineVersionId;
    expect(enteredOn).not.toBeNull();

    // Keep checking turned on and published, as the settings screen
    // would: the live graph rewritten, and a new version filed for it.
    const published = replacePipelineGraph(
      handle.db,
      "default",
      listStepsForPipeline(handle.db, "default").map((candidate) => (candidate.id === "watch" ? { ...candidate, watch: { everyMinutes: 5, giveUpAfterHours: 168 } } : candidate)),
      listRoutesForPipeline(handle.db, "default"),
    );
    expect(published.replaced).toBe(true);
    expect(getStep(handle.db, "watch")?.watch).toEqual({ everyMinutes: 5, giveUpAfterHours: 168 });

    // The parked item is still on the version it entered on, where the
    // step runs once — so a reply checks once more and, still waiting,
    // stops here again with the same sentence rather than starting a watch.
    expect(getItem(handle.db, item.id)?.pipelineVersionId).toBe(enteredOn);
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Keep checking is on now." });
    await supervisor.resumeItem(item.id);
    expect(check).toHaveBeenCalledTimes(2);
    expect(getItemWatch(handle.db, item.id, "watch")).toBeUndefined();
    expect(listRunsForItem(handle.db, item.id).at(-1)).toMatchObject({ status: "awaiting_input" });
    const parks = listCommentsForItem(handle.db, item.id).filter((comment) => comment.kind === "escalation");
    expect(parks).toHaveLength(2);
    expect(parks[1]?.body).toBe(parks[0]?.body);

    // Once what it waits on has happened, a reply carries it on.
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "It has been signed." });
    await supervisor.resumeItem(item.id);
    expect(check).toHaveBeenCalledTimes(3);
    expect(getStep(handle.db, getItem(handle.db, item.id)!.stepId!)?.isTerminal).toBe(true);

    // And an item entering afterwards is on the new version, and watched.
    const later = createTestItem(handle.db, { type: "story", title: "Signed later", stepId: "watch" });
    expect(later.pipelineVersionId).not.toBe(enteredOn);
    await supervisor.runOnce();
    expect(check).toHaveBeenCalledTimes(4);
    expect(getItemWatch(handle.db, later.id, "watch")).toMatchObject({ checks: 1, nextCheckAt: clock + 5 * MINUTE });
    expect(listRunsForItem(handle.db, later.id).filter((run) => run.startedAt !== null)).toEqual([]);
  });

  it("parks rather than taking a waiting route saved before the validator refused one", async () => {
    seed(null);
    // The route the old park told a person to add: it published, and it
    // sent the item round to a check that answered `waiting` again.
    createRoute(handle.db, { pipelineId: "default" as Uuid, fromStepId: "watch", resultKey: "waiting", label: "Waiting", target: "fix", position: 2 });
    const supervisor = supervisorWith(async () => waiting());

    await supervisor.runOnce();
    expectParkedForKeepChecking(`"create_worktree"`);
    expect(listTransitionsForItem(handle.db, item.id).filter((transition) => transition.fromStepId === "watch")).toEqual([]);
  });
});

describe("a step that keeps checking, offline and after a wake", () => {
  it("runs no check and counts no failure while the platform reports offline", async () => {
    seed();
    let online = false;
    const check = vi.fn<BuiltinRunner>(async () => ({ ok: false, reason: "the network is unreachable" }));
    const supervisor = supervisorWith(check, { platform: { isOnline: () => online } });

    // Offline from the start: an item arriving on the step is not checked on arrival either.
    await supervisor.runOnce();
    expect(check).not.toHaveBeenCalled();
    expect(getItemWatch(handle.db, item.id, "watch")).toBeUndefined();
    expect(supervisor.dispatchBlockerFor(item.id)).toEqual({ kind: "watch_held", reason: "offline" });

    online = true;
    await supervisor.runOnce();
    expect(check).toHaveBeenCalledTimes(1);
    expect(getItemWatch(handle.db, item.id, "watch")?.consecutiveFailures).toBe(1);

    // An outage longer than every backoff and the escalation put together.
    online = false;
    for (let minutes = 1; minutes <= 120; minutes += 1) {
      clock = START + minutes * MINUTE;
      await supervisor.runOnce();
    }
    expect(check).toHaveBeenCalledTimes(1);
    expect(getItemWatch(handle.db, item.id, "watch")).toMatchObject({ checks: 1, consecutiveFailures: 1 });
    expect(listCommentsForItem(handle.db, item.id)).toEqual([]);
    expect(supervisor.dispatchBlockerFor(item.id)).toEqual({ kind: "watch_held", reason: "offline" });

    online = true;
    await supervisor.runOnce();
    expect(check).toHaveBeenCalledTimes(2);
    expect(getItemWatch(handle.db, item.id, "watch")?.consecutiveFailures).toBe(2);
  });

  it("runs no check for a minute after a wake, then checks an overdue watch once however many intervals the sleep spanned", async () => {
    seed({ everyMinutes: 5, giveUpAfterHours: 168 });
    const check = vi.fn<BuiltinRunner>(async () => waiting());
    let wake: (() => void) | undefined;
    const supervisor = supervisorWith(check, {
      platform: {
        onWake: (listener) => {
          wake = listener;
          return () => {
            wake = undefined;
          };
        },
        // The real timers stay out of the way: every tick here is the test's.
        tickIntervalMs: 3_600_000,
        watchdogIntervalMs: 3_600_000,
      },
    });
    supervisor.start();
    try {
      await supervisor.runOnce();
      expect(check).toHaveBeenCalledTimes(1);
      expect(getItemWatch(handle.db, item.id, "watch")?.nextCheckAt).toBe(START + 5 * MINUTE);

      // Asleep for 47 minutes — nine checks' worth — and awake again.
      const wokeAt = START + 47 * MINUTE;
      clock = wokeAt;
      wake!();

      for (const after of [0, 1_000, 30_000, WAKE_GRACE_MS - 1]) {
        clock = wokeAt + after;
        await supervisor.runOnce();
      }
      expect(check).toHaveBeenCalledTimes(1);
      expect(supervisor.dispatchBlockerFor(item.id)).toEqual({ kind: "watch_held", reason: "waking", until: wokeAt + WAKE_GRACE_MS });

      clock = wokeAt + WAKE_GRACE_MS;
      await supervisor.runOnce();
      await supervisor.runOnce();
      clock += 4 * MINUTE;
      await supervisor.runOnce();
      // One check for the whole sleep, and the next one an interval after it.
      expect(check).toHaveBeenCalledTimes(2);
      expect(getItemWatch(handle.db, item.id, "watch")).toMatchObject({
        checks: 2,
        consecutiveFailures: 0,
        lastCheckedAt: wokeAt + WAKE_GRACE_MS,
        nextCheckAt: wokeAt + WAKE_GRACE_MS + 5 * MINUTE,
      });
      expect(quietLines()).toEqual(["Still waiting.", "Still waiting."]);

      clock = wokeAt + WAKE_GRACE_MS + 5 * MINUTE;
      await supervisor.runOnce();
      expect(check).toHaveBeenCalledTimes(3);
    } finally {
      supervisor.stop();
    }
  });

  /** Six failed checks in a row, which parks the watch with an escalation waiting for a reply. */
  async function parkAfterSixFailures(supervisor: ReturnType<typeof supervisorWith>): Promise<void> {
    await supervisor.runOnce();
    for (let failure = 1; failure < 6; failure += 1) {
      clock = getItemWatch(handle.db, item.id, "watch")!.nextCheckAt;
      await supervisor.runOnce();
    }
    expect(listRunsForItem(handle.db, item.id).at(-1)?.status).toBe("awaiting_input");
  }

  it("holds a reply to a parked watch while offline, keeping the park, and runs it once the connection is back", async () => {
    seed();
    let online = true;
    const answers: BuiltinOutcome[] = Array.from({ length: 6 }, () => ({ ok: false, reason: "down" }));
    answers.push(waiting());
    const check = vi.fn<BuiltinRunner>(async () => answers.shift()!);
    const supervisor = supervisorWith(check, { platform: { isOnline: () => online } });
    await parkAfterSixFailures(supervisor);
    const parkedRuns = listRunsForItem(handle.db, item.id).map((run) => run.status);
    const parkedWatch = getItemWatch(handle.db, item.id, "watch");
    const commentsBefore = listCommentsForItem(handle.db, item.id).length;

    online = false;
    clock += MINUTE;
    // Stamped on the test's clock, so the recovery pass reads it as written after the park.
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "It is back up.", createdAt: clock });
    await supervisor.resumeItem(item.id);

    expect(check).toHaveBeenCalledTimes(6);
    expect(listRunsForItem(handle.db, item.id).map((run) => run.status)).toEqual(parkedRuns);
    expect(getItemWatch(handle.db, item.id, "watch")).toEqual(parkedWatch);
    // The person who wrote is told why nothing happened, once.
    const notes = listCommentsForItem(handle.db, item.id).filter((comment) => comment.body.includes("EO is offline"));
    expect(notes).toEqual([expect.objectContaining({ authorType: "engine", kind: "note" })]);

    // The scheduler's recovery pass offers the reply on every tick, and holds it as quietly.
    for (let minutes = 1; minutes <= 30; minutes += 1) {
      clock += MINUTE;
      await supervisor.runOnce();
    }
    expect(check).toHaveBeenCalledTimes(6);
    expect(getItemWatch(handle.db, item.id, "watch")?.consecutiveFailures).toBe(6);
    expect(listCommentsForItem(handle.db, item.id)).toHaveLength(commentsBefore + 2);

    online = true;
    await supervisor.runOnce();
    expect(check).toHaveBeenCalledTimes(7);
    expect(listRunsForItem(handle.db, item.id).at(-1)).toMatchObject({ status: "succeeded" });
    expect(getItemWatch(handle.db, item.id, "watch")).toMatchObject({ consecutiveFailures: 0, startedAt: clock, nextCheckAt: clock + 5 * MINUTE });
  });

  it("holds a reply to a parked watch for a minute after a wake, and runs it once when the minute is up", async () => {
    seed();
    const answers: BuiltinOutcome[] = Array.from({ length: 6 }, () => ({ ok: false, reason: "down" }));
    answers.push(waiting());
    const check = vi.fn<BuiltinRunner>(async () => answers.shift()!);
    let wake: (() => void) | undefined;
    const supervisor = supervisorWith(check, {
      platform: {
        onWake: (listener) => {
          wake = listener;
          return () => {
            wake = undefined;
          };
        },
        tickIntervalMs: 3_600_000,
        watchdogIntervalMs: 3_600_000,
      },
    });
    supervisor.start();
    try {
      await parkAfterSixFailures(supervisor);
      const parkedWatch = getItemWatch(handle.db, item.id, "watch");

      const wokeAt = clock + 8 * 60 * MINUTE;
      clock = wokeAt;
      wake!();
      clock = wokeAt + 1_000;
      postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Try again now.", createdAt: clock });
      await supervisor.resumeItem(item.id);

      expect(check).toHaveBeenCalledTimes(6);
      expect(listRunsForItem(handle.db, item.id).at(-1)?.status).toBe("awaiting_input");
      expect(getItemWatch(handle.db, item.id, "watch")).toEqual(parkedWatch);
      expect(listCommentsForItem(handle.db, item.id).filter((comment) => comment.body.includes("has just woken"))).toHaveLength(1);

      clock = wokeAt + WAKE_GRACE_MS - 1;
      await supervisor.runOnce();
      expect(check).toHaveBeenCalledTimes(6);

      clock = wokeAt + WAKE_GRACE_MS;
      await supervisor.runOnce();
      await supervisor.runOnce();
      expect(check).toHaveBeenCalledTimes(7);
      expect(listRunsForItem(handle.db, item.id).at(-1)).toMatchObject({ status: "succeeded" });
      expect(getItemWatch(handle.db, item.id, "watch")).toMatchObject({ consecutiveFailures: 0, startedAt: wokeAt + WAKE_GRACE_MS });
    } finally {
      supervisor.stop();
    }
  });

  it("is never held for being offline on the server platform", async () => {
    const server = serverPlatform();
    expect(server.isOnline()).toBe(true);

    seed();
    const check = vi.fn<BuiltinRunner>(async () => waiting());
    const supervisor = supervisorWith(check, { platform: { isOnline: () => server.isOnline() } });
    for (let minutes = 0; minutes <= 15; minutes += 5) {
      clock = START + minutes * MINUTE;
      await supervisor.runOnce();
    }
    expect(check).toHaveBeenCalledTimes(4);
  });

  /** A server platform, as `startMain` builds one, for the questions a test asks of it. */
  function serverPlatform() {
    return createServerPlatform({
      config: {
        host: "127.0.0.1",
        port: 0,
        token: "operator-token",
        secretKey: Buffer.alloc(32),
        userDataPath: "/nonexistent",
        rendererDirectory: null,
        version: "0.0.0",
      },
      resources: sourceTreeResources(),
      exit: () => {},
    });
  }

  it("is never held after a late watchdog pass on the server platform, which does not sleep (EO-514)", async () => {
    const server = serverPlatform();
    expect(server.sleeps).toBe(false);

    seed();
    const check = vi.fn<BuiltinRunner>(async () => waiting());
    const supervisor = supervisorWith(check, { platform: { isOnline: () => server.isOnline(), sleeps: server.sleeps } });
    await supervisor.runOnce();
    expect(check).toHaveBeenCalledTimes(1);

    // A paused container or a stalled event loop: the next pass comes an
    // hour after it was due, which a desktop would read as a wake.
    supervisor.watchLiveRuns();
    clock += 60 * MINUTE;
    supervisor.watchLiveRuns();

    expect(supervisor.dispatchBlockerFor(item.id)).toBeNull();
    await supervisor.runOnce();
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("is held for a minute after a late watchdog pass on a machine that sleeps", async () => {
    seed();
    const check = vi.fn<BuiltinRunner>(async () => waiting());
    const supervisor = supervisorWith(check);
    await supervisor.runOnce();

    supervisor.watchLiveRuns();
    const wokeAt = clock + 60 * MINUTE;
    clock = wokeAt;
    supervisor.watchLiveRuns();

    await supervisor.runOnce();
    expect(check).toHaveBeenCalledTimes(1);
    expect(supervisor.dispatchBlockerFor(item.id)).toMatchObject({ kind: "watch_held" });

    clock = wokeAt + WAKE_GRACE_MS;
    await supervisor.runOnce();
    expect(check).toHaveBeenCalledTimes(2);
  });
});
