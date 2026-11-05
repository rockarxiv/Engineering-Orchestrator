import { describe, expect, it } from "vitest";
import type { Comment, Run, Item, Transition, Uuid } from "@eo/core";
import { createStepAttribution, humanCommentsSince, lastRunOf, latestCommentPerStep } from "./stepAttribution.js";

const item = { id: "t1" as Uuid, stepId: "todo" } as Item;

let seq = 0;
/** Ids ascend with creation, as uuidv7's do — the tie-breaks depend on it. */
const nextId = () => `id-${String(++seq).padStart(4, "0")}`;

function comment(overrides: Partial<Comment> & { createdAt: number }): Comment {
  return {
    id: nextId() as Uuid,
    itemId: item.id,
    authorType: "agent",
    authorId: "a1" as Uuid,
    runId: null,
    parentId: null,
    body: "…",
    kind: "note",
    options: null,
    attachments: [],
    pinned: false,
    ...overrides,
  } as Comment;
}

function transition(overrides: Partial<Transition> & { ts: number; toStepId: string }): Transition {
  return { id: nextId() as Uuid, itemId: item.id, fromStepId: null, actor: "human", runId: null, reason: null, ...overrides } as Transition;
}

function run(overrides: Partial<Run> & { id: Uuid }): Run {
  return { itemId: item.id, agentId: "a1" as Uuid, action: "implement", stepId: null, endedAt: null, threadLost: false, threadId: "session-1", dryRun: false, ...overrides } as Run;
}

describe("createStepAttribution", () => {
  it("places a comment at the step its run was dispatched from", () => {
    // The exact route, and it wins over the history: a run that started at
    // `todo` and posted as the item was already moving still belongs to
    // the step it was working at.
    const runs = [run({ id: "r1" as Uuid, stepId: "todo" })];
    const history = [transition({ ts: 100, fromStepId: "todo", toStepId: "review" })];
    const attribution = createStepAttribution(item, history, runs);

    expect(attribution.stepOf(comment({ createdAt: 200, runId: "r1" as Uuid }))).toBe("todo");
  });

  it("falls back to the history for a run recorded before the step was stored", () => {
    // Every run row written before 0046 has no step. They must not all
    // collapse into one bucket.
    const runs = [run({ id: "r1" as Uuid, stepId: null })];
    const history = [transition({ ts: 100, fromStepId: "todo", toStepId: "review" })];
    const attribution = createStepAttribution(item, history, runs);

    expect(attribution.stepOf(comment({ createdAt: 200, runId: "r1" as Uuid }))).toBe("review");
  });

  it("places a comment written before the first move at the step the item started on", () => {
    // `createItem` writes the first step in the INSERT, so the original
    // placement has no transition of its own — it survives as the first
    // transition's `fromStepId`.
    const history = [transition({ ts: 500, fromStepId: "todo", toStepId: "review" })];
    const attribution = createStepAttribution({ ...item, stepId: "review" } as Item, history, []);

    expect(attribution.stepOf(comment({ createdAt: 100, authorType: "human" }))).toBe("todo");
  });

  it("places everything on the item's own step when it has never moved", () => {
    const attribution = createStepAttribution(item, [], []);

    expect(attribution.stepOf(comment({ createdAt: 100, authorType: "human" }))).toBe("todo");
  });

  it("reads a tie between a comment and a move as belonging to the step being left", () => {
    // A person drags an item and says why; the note is posted before the
    // move, deliberately. Filed under the destination it would explain
    // nothing.
    const note = comment({ createdAt: 100, authorType: "human" });
    const move = transition({ ts: 100, fromStepId: "todo", toStepId: "review" });
    const attribution = createStepAttribution(item, [move], []);

    expect(attribution.stepOf(note)).toBe(note.id < move.id ? "todo" : "review");
    // …and the order the two were written in is what decides it, not luck:
    expect(note.id < move.id).toBe(true);
  });

  it("reads a comment written just after a move, in the same millisecond, as belonging to the step it moved to", () => {
    // The direction the id comparison exists for, and the one a
    // `return false` would silently break: without it every same-
    // millisecond comment falls to the old step, including the ones
    // written after the move.
    const move = transition({ ts: 100, fromStepId: "todo", toStepId: "review" });
    const after = comment({ createdAt: 100, authorType: "human" }); // minted after the move, so its id sorts later
    const attribution = createStepAttribution(item, [move], []);

    expect(move.id < after.id).toBe(true);
    expect(attribution.stepOf(after)).toBe("review");
  });

  it("is unmoved by a self-transition", () => {
    // Reconciliation writes one per orphaned run, from a step to itself.
    const history = [
      transition({ ts: 100, fromStepId: "todo", toStepId: "review" }),
      transition({ ts: 200, fromStepId: "review", toStepId: "review" }),
    ];
    const attribution = createStepAttribution(item, history, []);

    expect(attribution.stepOf(comment({ createdAt: 300, authorType: "human" }))).toBe("review");
  });
});

describe("latestCommentPerStep", () => {
  it("keeps the newest word from each step across an item that looped three times", () => {
    // todo → review → todo → review → todo → review. The reviewer being
    // dispatched now needs the objection it last made and the answer to
    // it, not all six rounds.
    const runs = [
      run({ id: "i1" as Uuid, stepId: "todo" }), run({ id: "v1" as Uuid, stepId: "review" }),
      run({ id: "i2" as Uuid, stepId: "todo" }), run({ id: "v2" as Uuid, stepId: "review" }),
      run({ id: "i3" as Uuid, stepId: "todo" }),
    ];
    const comments = [
      comment({ createdAt: 10, runId: "i1" as Uuid, body: "first attempt" }),
      comment({ createdAt: 20, runId: "v1" as Uuid, body: "first rejection", kind: "rejection" }),
      comment({ createdAt: 30, runId: "i2" as Uuid, body: "second attempt" }),
      comment({ createdAt: 40, runId: "v2" as Uuid, body: "second rejection", kind: "rejection" }),
      comment({ createdAt: 50, runId: "i3" as Uuid, body: "third attempt" }),
    ];

    const kept = latestCommentPerStep(comments, createStepAttribution(item, [], runs));

    expect(kept.map((entry) => [entry.stepId, entry.comment.body])).toEqual([
      // Time order, so the objection reads before the answer to it.
      ["review", "second rejection"],
      ["todo", "third attempt"],
    ]);
  });

  it("leaves human comments to their own rule", () => {
    // A "yes, do that" must not displace the handoff it approved.
    const runs = [run({ id: "i1" as Uuid, stepId: "todo" })];
    const comments = [
      comment({ createdAt: 10, runId: "i1" as Uuid, body: "the handoff" }),
      comment({ createdAt: 20, authorType: "human", body: "yes, do that" }),
    ];

    const kept = latestCommentPerStep(comments, createStepAttribution(item, [], runs));

    expect(kept.map((entry) => entry.comment.body)).toEqual(["the handoff"]);
  });

  it("keeps a blocking engine comment even where the step has spoken", () => {
    // The expensive one to get wrong. A verification failure posted after
    // the second attempt must not lose to the first attempt's handoff:
    // the seed would show a claim of success, say nothing about why the
    // work came back, and the implementer would resubmit it.
    const runs = [run({ id: "i1" as Uuid, stepId: "todo" }), run({ id: "i2" as Uuid, stepId: "todo" })];
    const comments = [
      comment({ createdAt: 10, runId: "i1" as Uuid, body: "shipped it" }),
      comment({ createdAt: 20, runId: "i2" as Uuid, authorType: "engine", authorId: null, kind: "rejection", body: "verification failed: the tests do not pass" }),
    ];

    const kept = latestCommentPerStep(comments, createStepAttribution(item, [], runs));

    expect(kept.map((entry) => entry.comment.body)).toEqual(["verification failed: the tests do not pass"]);
  });

  it("keeps a guard escalation the same way", () => {
    const runs = [run({ id: "i1" as Uuid, stepId: "todo" })];
    const comments = [
      comment({ createdAt: 10, runId: "i1" as Uuid, body: "shipped it" }),
      comment({ createdAt: 20, runId: "i1" as Uuid, authorType: "engine", authorId: null, kind: "escalation", body: "the daily budget is spent" }),
    ];

    expect(latestCommentPerStep(comments, createStepAttribution(item, [], runs)).map((e) => e.comment.body)).toEqual(["the daily budget is spent"]);
  });

  it("does not let a dry run speak for the step whose worktree it borrowed", () => {
    // A module dry-run borrows an item's worktree so somebody can watch
    // it work. Its note is not that step's account of itself.
    const runs = [run({ id: "i1" as Uuid, stepId: "review", dryRun: true })];
    const comments = [comment({ createdAt: 10, runId: "i1" as Uuid, authorType: "module", authorId: null, body: "deployed to staging" })];

    const kept = latestCommentPerStep(comments, createStepAttribution({ ...item, stepId: "todo" } as Item, [], runs));

    // Placed by where the item actually sat, not by the borrowed step.
    expect(kept.map((entry) => entry.stepId)).toEqual(["todo"]);
  });

  it("leaves a comment older than any step this item has been at unplaced", () => {
    // `fromStepId` is nullable. Falling back to where the item sits now
    // would render something said before it was ever placed as though it
    // had been said at the step it is on today.
    const history = [transition({ ts: 500, fromStepId: null, toStepId: "todo" })];
    const attribution = createStepAttribution({ ...item, stepId: "review" } as Item, history, []);

    expect(attribution.stepOf(comment({ createdAt: 100, authorType: "human" }))).toBeNull();
  });

  it("carries an engine note only where the step produced nothing else", () => {
    const runs = [run({ id: "i1" as Uuid, stepId: "todo" }), run({ id: "v1" as Uuid, stepId: "review" })];
    const comments = [
      comment({ createdAt: 10, runId: "i1" as Uuid, body: "the handoff" }),
      comment({ createdAt: 15, runId: "i1" as Uuid, authorType: "engine", authorId: null, body: "verification failed" }),
      comment({ createdAt: 20, runId: "v1" as Uuid, authorType: "engine", authorId: null, body: "the reviewer never started" }),
    ];

    const kept = latestCommentPerStep(comments, createStepAttribution(item, [], runs));

    expect(kept.map((entry) => entry.comment.body)).toEqual([
      "the handoff", // an engine note about the run does not displace the run's own account
      "the reviewer never started", // …but where there is nothing else, it is the whole account
    ]);
  });
});

describe("humanCommentsSince", () => {
  // The id is minted from the same sequence the comments use, because the
  // watermark's tie-break compares the two directly — in production both
  // are uuidv7 from one monotonic source, and a fixture that ignores that
  // tests a comparison the real ids would never make.
  const prior = run({ id: nextId() as Uuid, endedAt: 100 });

  it("carries what a person said after this agent last finished", () => {
    const comments = [
      comment({ createdAt: 50, authorType: "human", body: "before" }),
      comment({ createdAt: 150, authorType: "human", body: "after" }),
      comment({ createdAt: 160, body: "another agent" }),
    ];

    expect(humanCommentsSince(comments, prior).map((c) => c.body)).toEqual(["after"]);
  });

  it("carries every human comment when the agent has never run here", () => {
    const comments = [comment({ createdAt: 50, authorType: "human", body: "before" })];

    expect(humanCommentsSince(comments, undefined).map((c) => c.body)).toEqual(["before"]);
  });

  it("carries a reply posted in the same millisecond the run ended", () => {
    // The tie the watermark exists to get right: an answer written as the
    // run closed is the one thing the agent was most likely woken for.
    const answer = comment({ createdAt: 100, authorType: "human", body: "answered" });

    expect(humanCommentsSince([answer], prior).map((c) => c.body)).toEqual(["answered"]);
  });
});

describe("lastRunOf", () => {
  it("ignores a run that never opened a thread", () => {
    // The attempt-limit guard writes a run row with an `endedAt` before
    // any backend is reached, and a dispatch that dies at the provider
    // looks the same. Neither delivered a prompt to anyone, so neither is
    // evidence about what the agent has seen.
    const runs = [run({ id: "r1" as Uuid, endedAt: 100, threadId: "session-1" }), run({ id: "r2" as Uuid, endedAt: 200, threadId: null })];

    expect(lastRunOf(runs, "a1" as Uuid)?.id).toBe("r1");
  });

  it("ignores a run whose thread the backend had lost", () => {
    // That run showed the agent nothing — the session was gone — but it
    // ended after the reply that woke it. Counting it would put the
    // watermark past the one comment the next run exists to answer.
    const runs = [run({ id: "r1" as Uuid, endedAt: 100 }), run({ id: "r2" as Uuid, endedAt: 200, threadLost: true })];

    expect(lastRunOf(runs, "a1" as Uuid)?.id).toBe("r1");
  });

  it("takes this agent's own newest finished run, ignoring everyone else's", () => {
    const runs = [
      run({ id: "r1" as Uuid, endedAt: 100 }),
      run({ id: "r2" as Uuid, agentId: "other" as Uuid, endedAt: 200 }),
      run({ id: "r3" as Uuid, endedAt: 150 }),
      run({ id: "r4" as Uuid, endedAt: null }), // still going: not a watermark
    ];

    expect(lastRunOf(runs, "a1" as Uuid)?.id).toBe("r3");
  });
});
