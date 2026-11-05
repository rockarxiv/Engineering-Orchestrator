import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HUMAN_MESSAGE_EVENT, type Item, type Uuid } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import { createRoute, createStep, getItem, listRunEvents, listRunsForItem, transitionItem } from "../db/repos/index.js";
import { comments, stepRoutes } from "../db/schema.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { listInbox } from "../ipc/domainQueries.js";
import { createRoleWiring } from "../packs/developer/wiring.js";
import { createRunSupervisor } from "./runSupervisor.js";
import type { BuiltinRunner } from "./builtins.js";

/**
 * A `builtin` step running (ARCHITECTURE.md, "A step").
 *
 * The point of the kind is that cutting a worktree and opening a pull
 * request stop being invisible side effects and become steps: with a run
 * apiece they have an elapsed time, a status, and a declared result that
 * routes — including somewhere to go when they fail.
 */

const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };

let handle: DbHandle;
let item: Item;

function supervisorWith(builtins: Record<string, BuiltinRunner>) {
  return createRunSupervisor({
    db: handle.db,
    provider: { start: () => { throw new Error("a builtin must not reach a provider"); } } as never,
    ...createRoleWiring(handle.db),
    limits: LIMITS,
    builtins,
  });
}

beforeEach(() => {
  handle = openMigratedTestDb();
  // The seeded pipeline enters at `worktree`, which is a builtin.
  item = createTestItem(handle.db, { type: "story", title: "Rate limit the API", stepId: "worktree" });
});

afterEach(() => {
  handle.close();
});

describe("a built-in step", () => {
  it("runs its function and routes on the result it reports", async () => {
    const ready: BuiltinRunner = async () => ({ ok: true, result: "ready", detail: "Worktree ready at /tmp/x" });

    await supervisorWith({ create_worktree: ready }).runOnce();

    // `worktree --ready--> repository_index` in the seeded pipeline.
    // Where it goes is a row, not something the function decided — which
    // is why inserting a step in front of the implementer (EO-149)
    // changed this line and nothing in `builtins.ts`.
    expect(getItem(handle.db, item.id)?.stepId).toBe("repository_index");
  });

  it("records a run with no agent, because EO is the one that acted", async () => {
    const ready: BuiltinRunner = async () => ({ ok: true, result: "ready", detail: "done" });

    await supervisorWith({ create_worktree: ready }).runOnce();

    const [run] = listRunsForItem(handle.db, item.id);
    expect(run).toMatchObject({ agentId: null, action: "create_worktree", status: "succeeded", provider: "builtin" });
    // It took time, which is the thing a side effect could never show.
    expect(run?.startedAt).not.toBeNull();
    expect(run?.endedAt).not.toBeNull();
  });

  it("says nothing in the thread when it simply worked", async () => {
    const ready: BuiltinRunner = async () => ({ ok: true, result: "ready", detail: "Worktree ready" });

    await supervisorWith({ create_worktree: ready }).runOnce();

    // A builtin succeeds on nearly every item. "The worktree is ready"
    // in every thread would bury the comments agents actually read; the
    // run row is where a run's story belongs.
    expect(handle.db.select().from(comments).all()).toEqual([]);
  });

  it("parks the item and asks a human when the function cannot finish", async () => {
    const refuses: BuiltinRunner = async () => ({ ok: false, reason: "the base repository has uncommitted changes" });

    await supervisorWith({ create_worktree: refuses }).runOnce();

    const [run] = listRunsForItem(handle.db, item.id);
    // Parked, not failed: `failed` matches no skip condition in the
    // scheduler, so the item would be offered again on the next tick.
    expect(run?.status).toBe("awaiting_input");
    expect(run?.error).toContain("the base repository has uncommitted changes");
    // Nothing silently drops work on the floor (invariant #8), and the
    // item has not moved.
    const posted = handle.db.select().from(comments).all();
    expect(posted[0]?.body).toContain("the base repository has uncommitted changes");
    expect(getItem(handle.db, item.id)?.stepId).toBe("worktree");
  });

  it("stops re-running a function whose refusal will never change", async () => {
    // The loop this exists to catch: a story with no repository refuses
    // `create_worktree` identically every time, and nothing about a
    // *failed* run stops the scheduler offering the item again. Left
    // alone it minted a run and an inbox item every tick — 395 runs in
    // under an hour — none of which a person could have acted on twice.
    const refuses = vi.fn<BuiltinRunner>(async () => ({
      ok: false,
      reason: "EO-1 is a story with no repository assigned.",
    }));
    const supervisor = supervisorWith({ create_worktree: refuses });

    await supervisor.runOnce();
    await supervisor.runOnce();
    await supervisor.runOnce();

    expect(refuses).toHaveBeenCalledTimes(1);
    expect(listRunsForItem(handle.db, item.id)).toHaveLength(1);
    // One escalation, so the inbox holds one item rather than one per tick.
    expect(handle.db.select().from(comments).all()).toHaveLength(1);
  });

  it("offers the answers on the escalation when the function stopped to ask something", async () => {
    // A refusal that is a *question* — which of two equally close
    // dependencies to stack on (KAN-42) — names what it will accept, so
    // the person answering picks rather than types. A refusal that is
    // merely reporting a fact still offers nothing, as above.
    const asks: BuiltinRunner = async () => ({
      ok: false,
      reason: "EO-31 and EO-32 are both still open.",
      options: ["EO-31", "EO-32"],
    });

    await supervisorWith({ create_worktree: asks }).runOnce();

    const [posted] = handle.db.select().from(comments).all();
    expect(posted?.kind).toBe("escalation");
    expect(posted?.options).toEqual(["EO-31", "EO-32"]);
  });

  it("files the retry against the step it ran on, same as the first attempt", async () => {
    // `runs.step_id` is what `stepAttribution` reads to decide which
    // column a run and its comments belong to, so a turn missing one
    // would drop out of that reckoning. `resumeItem` names no step when
    // it re-runs the function, which looks like an omission and is not:
    // `createRun` reads the item's current step when a caller does not,
    // and the resume path has just checked that the item is still on
    // the step that parked. This holds that chain in place — it is two
    // separate pieces of code agreeing, and nothing else would notice
    // them stopping.
    let assigned = false;
    const runner: BuiltinRunner = async () =>
      assigned ? { ok: true, result: "ready", detail: "" } : { ok: false, reason: "no repository assigned" };
    const supervisor = supervisorWith({ create_worktree: runner });

    await supervisor.runOnce();
    assigned = true;
    await supervisor.resumeItem(item.id);

    const runs = listRunsForItem(handle.db, item.id);
    expect(runs).toHaveLength(2);
    expect(runs.map((each) => each.stepId)).toEqual(["worktree", "worktree"]);
  });

  it("runs the function again when a person replies to the escalation", async () => {
    // Parking is only half of it: the scheduler will never offer this
    // item again, so a reply has to be what picks it back up. There is
    // no agent and no thread on a builtin run, which is the case that
    // used to fall through `resumeItem` and strand the item for good.
    let assigned = false;
    const runner: BuiltinRunner = async () =>
      assigned
        ? { ok: true, result: "ready", detail: "Worktree ready" }
        : { ok: false, reason: "EO-1 is a story with no repository assigned." };
    const supervisor = supervisorWith({ create_worktree: runner });

    await supervisor.runOnce();
    expect(getItem(handle.db, item.id)?.stepId).toBe("worktree");

    assigned = true; // the person does what the escalation asked
    await supervisor.resumeItem(item.id);

    expect(getItem(handle.db, item.id)?.stepId).toBe("repository_index");
    expect(listRunsForItem(handle.db, item.id)).toHaveLength(2);
  });

  it("asks for a human in a way the inbox treats as blocking", async () => {
    // While these runs were `failed`, the inbox derived `blocking` from
    // "some run is awaiting input" and found none — so an item that
    // could not move at all rendered as an FYI, hundreds of times over.
    const refuses: BuiltinRunner = async () => ({ ok: false, reason: "no repository assigned" });

    await supervisorWith({ create_worktree: refuses }).runOnce();

    const inbox = listInbox(handle.db, null);
    expect(inbox.items).toHaveLength(1);
    expect(inbox.items[0]?.blocking).toBe(true);
    expect(inbox.summary.blockingCount).toBe(1);
  });

  it("parks rather than loops when a reply does not fix the cause", async () => {
    const refuses = vi.fn<BuiltinRunner>(async () => ({ ok: false, reason: "still no repository" }));
    const supervisor = supervisorWith({ create_worktree: refuses });

    await supervisor.runOnce();
    await supervisor.resumeItem(item.id);
    await supervisor.runOnce(); // a tick after the retry must still decline

    // One run per reply — a person's pace, not the tick interval's.
    expect(refuses).toHaveBeenCalledTimes(2);
    expect(getItem(handle.db, item.id)?.stepId).toBe("worktree");
  });

  it("survives a function that throws rather than returning a refusal", async () => {
    const explodes: BuiltinRunner = async () => {
      throw new Error("ENOENT: git is not installed");
    };

    await supervisorWith({ create_worktree: explodes }).runOnce();

    expect(listRunsForItem(handle.db, item.id)[0]?.status).toBe("awaiting_input");
    expect(handle.db.select().from(comments).all()[0]?.body).toContain("git is not installed");
  });

  it("refuses a function EO does not ship, instead of moving the item anyway", async () => {
    // The validator rejects an unknown function at save time, so getting
    // here means the row was edited around that check.
    await supervisorWith({}).runOnce();

    expect(listRunsForItem(handle.db, item.id)[0]?.status).toBe("awaiting_input");
    expect(getItem(handle.db, item.id)?.stepId).toBe("worktree");
  });

  it("parks the item when the result it reports has no route", async () => {
    const surprising = vi.fn<BuiltinRunner>(async () => ({ ok: true, result: "who_knows", detail: "" }));
    const supervisor = supervisorWith({ create_worktree: surprising });

    await supervisor.runOnce();
    await supervisor.runOnce();

    expect(getItem(handle.db, item.id)?.stepId).toBe("worktree");
    const posted = handle.db.select().from(comments).all();
    expect(posted.some((comment) => comment.body.includes("who_knows"))).toBe(true);
    // Succeeding without moving is the same loop failing without moving
    // was: the item stays exactly where the scheduler looks for it. The
    // run has to park for the name of this test to be true.
    expect(surprising).toHaveBeenCalledTimes(1);
    expect(listRunsForItem(handle.db, item.id)[0]?.status).toBe("awaiting_input");
  });

  it("does not run again once the item has moved on", async () => {
    const ready = vi.fn<BuiltinRunner>(async () => ({ ok: true, result: "ready", detail: "" }));
    const supervisor = supervisorWith({ create_worktree: ready });

    await supervisor.runOnce();
    await supervisor.runOnce();

    // The second tick finds the item on `todo`, which no builtin owns.
    expect(ready).toHaveBeenCalledTimes(1);
  });
});

/**
 * Where a failure goes (EO-77).
 *
 * `failed` is a declared result now, so the answer is a row rather than
 * a rule. Before it was declared there was no answer at all: every way a
 * builtin could not finish ended parked with a question, which is a fine
 * default and was a poor only-option — a project with a triage column
 * had no way to say so.
 */
describe("a built-in step that fails", () => {
  const refuses: BuiltinRunner = async () => ({ ok: false, reason: `The branch "eo/EO-1" already exists.` });

  /** Points the shipped `worktree --failed-->` route at a step that handles it. */
  function routeFailureToTriage(): void {
    createStep(handle.db, { id: "triage", pipelineId: "default" as Uuid, position: 16, name: "Triage", type: "user" });
    handle.db.update(stepRoutes).set({ target: "triage" }).where(eq(stepRoutes.id, "r_worktree_failed")).run();
  }

  it("sends the item where the pipeline sends it, rather than always stopping", async () => {
    routeFailureToTriage();

    await supervisorWith({ create_worktree: refuses }).runOnce();

    expect(getItem(handle.db, item.id)?.stepId).toBe("triage");
  });

  it("records the run as failed and says why, without holding the item still", async () => {
    routeFailureToTriage();

    await supervisorWith({ create_worktree: refuses }).runOnce();

    const [run] = listRunsForItem(handle.db, item.id);
    // `failed`, not `awaiting_input`: parking keeps the scheduler away
    // from the item entirely, which is the opposite of what a route to
    // another step is asking for.
    expect(run?.status).toBe("failed");
    expect(run?.error).toContain("already exists");

    // Invariant #8 — a guard ends in a comment. A note rather than an
    // escalation: the pipeline named who handles this, so raising `!` as
    // well would ask a person for something already in hand.
    const [posted] = handle.db.select().from(comments).all();
    expect(posted?.kind).toBe("note");
    expect(posted?.body).toContain("already exists");
  });

  it("parks, carrying the reason and the answers, when the route asks for a person", async () => {
    // What the shipped pipeline does, and what every pipeline did before
    // the result had a name. `user_attention` is the route saying "ask" —
    // and the park is the only version of asking that can carry what the
    // function actually said, and the answers it would take.
    const asks: BuiltinRunner = async () => ({ ok: false, reason: "EO-31 and EO-32 are both still open.", options: ["EO-31", "EO-32"] });

    await supervisorWith({ create_worktree: asks }).runOnce();

    expect(listRunsForItem(handle.db, item.id)[0]?.status).toBe("awaiting_input");
    expect(getItem(handle.db, item.id)?.stepId).toBe("worktree");
    const [posted] = handle.db.select().from(comments).all();
    expect(posted?.kind).toBe("escalation");
    expect(posted?.options).toEqual(["EO-31", "EO-32"]);
  });

  it("parks rather than moving when the route points at a step that is not there", async () => {
    // The graph was edited around the validator, which refuses this at
    // save time. Stopping beats moving an item somewhere nothing can
    // dispatch it from.
    handle.db.update(stepRoutes).set({ target: "a_step_that_was_deleted" }).where(eq(stepRoutes.id, "r_worktree_failed")).run();

    await supervisorWith({ create_worktree: refuses }).runOnce();

    expect(getItem(handle.db, item.id)?.stepId).toBe("worktree");
    expect(listRunsForItem(handle.db, item.id)[0]?.status).toBe("awaiting_input");
  });

  it("asks its question when it routes, so a refusal that needed an answer still gets one", async () => {
    // The regression this exists for. A tied stack target refuses with
    // the keys it would accept, and the only thing that resolves it is a
    // person replying with one of them, read back out of this thread.
    // Routing the item does not answer that — so a routed failure that
    // dropped the options asked a question nobody could hear, and the
    // shipped pipeline hid it because `user_attention` parks instead.
    routeFailureToTriage();
    const asks: BuiltinRunner = async () => ({
      ok: false,
      reason: "EO-31 and EO-32 are both still open.",
      options: ["EO-31", "EO-32"],
    });

    await supervisorWith({ create_worktree: asks }).runOnce();

    const [posted] = handle.db.select().from(comments).all();
    expect(posted?.options).toEqual(["EO-31", "EO-32"]);
    // And loudly: an unanswered question that raises no `!` is one
    // nobody finds. A refusal merely *reporting* something stays a note —
    // proved by the routed-failure test above.
    expect(posted?.kind).toBe("escalation");
    expect(getItem(handle.db, item.id)?.stepId).toBe("triage");
  });

  it("parks rather than looping when a step routes its own failure back to itself", async () => {
    // A builtin has no attempt cap, so a step that sends `failed` to
    // itself re-runs the same refusal on every tick forever — the exact
    // loop the park exists to prevent, reopened by configuration. The
    // validator will not catch it: a cycle is legitimate in a pipeline,
    // and it only asks whether a terminal is still reachable, which it is
    // by the success route.
    handle.db.update(stepRoutes).set({ target: "worktree" }).where(eq(stepRoutes.id, "r_worktree_failed")).run();
    const refusing = vi.fn<BuiltinRunner>(async () => ({ ok: false, reason: `The branch "eo/EO-1" already exists.` }));
    const supervisor = supervisorWith({ create_worktree: refusing });

    await supervisor.runOnce();
    await supervisor.runOnce();
    await supervisor.runOnce();

    expect(refusing).toHaveBeenCalledTimes(1);
    expect(getItem(handle.db, item.id)?.stepId).toBe("worktree");
    expect(listRunsForItem(handle.db, item.id)[0]?.status).toBe("awaiting_input");
    expect(handle.db.select().from(comments).all()[0]?.body).toContain("routes its own failures back to itself");
  });

  it("leaves a module's refusal to park, however the step routes `failed`", async () => {
    // The point of restricting this to builtins. `failed` is a result
    // `BUILTIN_RESULTS` declares for EO's own functions; a module
    // declares its own and can already return one meaning "it did not
    // work", so `{ ok: false }` from a module keeps its narrower meaning —
    // it could not run at all, which is a question for whoever configured
    // it rather than a branch in the graph.
    createStep(handle.db, { id: "deploy", pipelineId: "default" as Uuid, position: 17, name: "Deploy", type: "module", entryAction: "mod-1" });
    createRoute(handle.db, { pipelineId: "default" as Uuid, fromStepId: "deploy", resultKey: "failed", label: "Failed", target: "todo" });
    const onDeploy = createTestItem(handle.db, { type: "story", title: "Deploy me", stepId: "deploy" });

    await createRunSupervisor({
      db: handle.db,
      provider: { start: () => { throw new Error("a module must not reach a provider"); } } as never,
      ...createRoleWiring(handle.db),
      limits: LIMITS,
      builtins: {},
      moduleRunner: () => async () => ({ ok: false, reason: "FLY_API_TOKEN is not set" }),
    }).runOnce();

    expect(getItem(handle.db, onDeploy.id)?.stepId).toBe("deploy");
    expect(listRunsForItem(handle.db, onDeploy.id)[0]?.status).toBe("awaiting_input");
  });

  it("says so without freezing the item when a failure lands after someone moved it", async () => {
    // `awaiting_input` keeps the scheduler away from the item entirely,
    // so parking here would freeze it on a step a person has just chosen.
    // The failure still has to be said — a pull request that did not open
    // is not something anything else will mention.
    const refusesLate: BuiltinRunner = async () => {
      transitionItem(handle.db, { itemId: item.id, toStepId: "todo", actor: "human" });
      return { ok: false, reason: "`gh` is not on PATH." };
    };

    await supervisorWith({ create_worktree: refusesLate }).runOnce();

    expect(getItem(handle.db, item.id)?.stepId).toBe("todo");
    const [run] = listRunsForItem(handle.db, item.id);
    expect(run?.status).toBe("failed");
    expect(handle.db.select().from(comments).all()[0]?.body).toContain("had moved on by the time it stopped");
  });

  it("routes a failed pull request too, not only a failed worktree", async () => {
    // Every other routing test here drives `create_worktree`. The merge
    // step is the one where a failure is least likely to be noticed
    // otherwise — the work is finished, the board says so, and a person
    // believes their change is up for review.
    const onMerge = createTestItem(handle.db, { type: "story", title: "Merge me", stepId: "merge_request" });
    handle.db.update(stepRoutes).set({ target: "todo" }).where(eq(stepRoutes.id, "r_merge_failed")).run();

    await supervisorWith({ open_pull_request: async () => ({ ok: false, reason: "`gh` is not on PATH." }) }).runOnce();

    expect(getItem(handle.db, onMerge.id)?.stepId).toBe("todo");
    expect(listRunsForItem(handle.db, onMerge.id)[0]?.status).toBe("failed");
  });

  it("never walks a failure to the next step when the step declares no routes at all", async () => {
    // The trap this was written against. A step with no routes walks to
    // the next by position — an unconditional step, which is what the
    // worktree was before it could report anything. Reading a failure
    // through that walk would advance an item whose branch does not
    // exist exactly as if it did, and nothing anywhere would say so.
    createStep(handle.db, { id: "prep", pipelineId: "default" as Uuid, position: 15, name: "Prep", type: "builtin", entryAction: "create_worktree" });
    const unrouted = createTestItem(handle.db, { type: "story", title: "A second story", stepId: "prep" });

    await supervisorWith({ create_worktree: refuses }).runOnce();

    expect(getItem(handle.db, unrouted.id)?.stepId).toBe("prep");
    expect(listRunsForItem(handle.db, unrouted.id)[0]?.status).toBe("awaiting_input");
  });
});

/**
 * A builtin run's transcript (EO-77).
 *
 * Every builtin run's panel used to read "No events recorded for this
 * run", because builtins wrote no `run_events` at all: the detail was
 * kept on the run row, where nothing rendered it, and the reason a
 * failure failed lived only in a comment. A step that can take time and
 * go wrong needs the same log an agent gets, for the same reason.
 */
describe("what a built-in step leaves behind to read", () => {
  it("files what it narrated, and its result, against the run", async () => {
    const narrates: BuiltinRunner = async ({ report }) => {
      report("Working out where to cut \"eo/EO-1\" from.");
      report("Nothing to stack on, so this comes off main.");
      return { ok: true, result: "ready", detail: "Worktree ready at /tmp/eo/worktrees/EO-1" };
    };

    await supervisorWith({ create_worktree: narrates }).runOnce();

    const [run] = listRunsForItem(handle.db, item.id);
    const text = listRunEvents(handle.db, run!.id).map((entry) => JSON.stringify(entry.payload));
    expect(text.join("\n")).toContain("where to cut");
    expect(text.join("\n")).toContain("comes off main");
    // The detail too, so the log ends with what the step actually
    // reported rather than trailing off after the last narrated step.
    expect(text.join("\n")).toContain("Worktree ready at");
  });

  it("writes a refusal into the log as an error, not only into a comment", async () => {
    // A transcript that shows a green-to-nothing log next to a red badge
    // makes you leave it to find out what happened. The reason belongs in
    // all three places it can be looked for.
    const refuses: BuiltinRunner = async () => ({ ok: false, reason: `The branch "eo/EO-1" already exists.` });

    await supervisorWith({ create_worktree: refuses }).runOnce();

    const [run] = listRunsForItem(handle.db, item.id);
    const events = listRunEvents(handle.db, run!.id);
    expect(events.map((entry) => entry.type)).toContain("error");
    expect(JSON.stringify(events)).toContain("already exists");
    // And still on the run row, which is what the panel's own header reads.
    expect(run?.error).toContain("already exists");
  });

  it("keeps a killed module's last words, which arrive after the log was closed", async () => {
    // A module that is killed keeps writing while its tree dies, so its
    // final output lands after the run has finished. The push guard used
    // to be a cleared-but-truthy timer handle, so every one of those
    // lines was appended to a buffer with no timer left to flush it and
    // sat in memory for the life of the process. `run_events` is the
    // durable substrate; what a dying process said last is exactly what
    // it is for.
    let late: ((text: string) => void) | undefined;
    const runner: BuiltinRunner = async ({ report }) => {
      late = report;
      report("starting");
      return { ok: true, result: "ready", detail: "" };
    };

    await supervisorWith({ create_worktree: runner }).runOnce();
    late!("killed, but this is what went wrong");

    const [run] = listRunsForItem(handle.db, item.id);
    expect(JSON.stringify(listRunEvents(handle.db, run!.id))).toContain("what went wrong");
  });
});

describe("a message said to a built-in step while it runs (EO-176)", () => {
  it("lands in the run's transcript through the run's own buffer, numbered after what the step already said", async () => {
    // The run has no agent conversation behind it, so there is no turn
    // to push the message into and `steerRun` records it against the
    // run for the next turn to read. The property under test is *how*
    // it is recorded: through the buffer the step is writing its own
    // lines into. The step's first line is buffered and not yet on disk
    // when the message arrives, so a writer that read `max(seq)` off
    // the disk would hand the message the number that line already
    // holds — and the buffer's next flush would die on the unique index,
    // an uncaught throw in the main process on the run the person was
    // watching.
    let letGo!: () => void;
    const held = new Promise<void>((resolve) => {
      letGo = resolve;
    });
    let reached!: () => void;
    const started = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const slow: BuiltinRunner = async ({ report }) => {
      report("Cutting the worktree…");
      reached();
      await held;
      return { ok: true, result: "ready", detail: "Worktree ready" };
    };
    const supervisor = supervisorWith({ create_worktree: slow });

    const running = supervisor.runOnce();
    await started;
    const [run] = listRunsForItem(handle.db, item.id);
    expect(run?.status).toBe("running");

    expect(await supervisor.steerRun(run!.id, { commentId: "comment-1" as Uuid, body: "Use main, not develop.", delivery: "now" })).toBe(
      "no-live-run",
    );

    letGo();
    await running;

    const events = listRunEvents(handle.db, run!.id);
    expect(events.map((event) => event.seq)).toEqual([0, 1, 2]);
    expect(events[1]).toMatchObject({ type: HUMAN_MESSAGE_EVENT, seq: 1 });
    expect(events[1]?.payload).toMatchObject({ commentId: "comment-1", delivered: false });
    // And the step still finished and routed; the message cost it nothing.
    expect(getItem(handle.db, item.id)?.stepId).toBe("repository_index");
  });
});
