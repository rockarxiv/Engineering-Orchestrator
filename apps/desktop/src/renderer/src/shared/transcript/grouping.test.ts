import { describe, expect, it } from "vitest";
import type { RunView } from "@eo/core";
import { groupElapsedMs, groupModelTurns, groupRatio, groupRuns, groupSum, isQuietRun, isRunActive } from "./grouping";

function run(overrides: Partial<RunView> = {}): RunView {
  return {
    id: "r1",
    agentId: "a1",
    agentName: "Implementer",
    action: "implement",
    actionName: overrides.action ?? "implement",
    status: "succeeded",
    attempt: 1,
    threadId: "th-1",
    error: null,
    tokensIn: null,
    tokensOut: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    turns: null,
    turnsScope: null,
    costCents: null,
    startedAt: 1_000,
    endedAt: 2_000,
    verificationOk: null,
    checks: [],
    steerable: true,
    ...overrides,
  };
}

/** One conversation: rows sharing a thread are one group, which is the unit these aggregate over. */
const groupOf = (...runs: RunView[]) => groupRuns(runs)[0]!;

describe("groupRuns", () => {
  it("places a watch's quiet run, which has no start, by its last check", () => {
    const quiet = (id: string, endedAt: number) => run({ id, threadId: null, startedAt: null, endedAt });
    const groups = groupRuns([quiet("old-stay", 1_500), run({ id: "agent", threadId: null, startedAt: 2_000, endedAt: 3_000 }), quiet("this-stay", 4_000)]);

    expect(groups.map((group) => group.id)).toEqual(["this-stay", "agent", "old-stay"]);
  });

  it("tells a quiet run from a run that has not started and one that has finished", () => {
    expect(isQuietRun(run({ startedAt: null }))).toBe(true);
    expect(isQuietRun(run({ status: "queued", startedAt: null, endedAt: null }))).toBe(false);
    expect(isQuietRun(run())).toBe(false);
  });

  it("still puts a run nobody has dispatched first", () => {
    const groups = groupRuns([run({ id: "agent", threadId: null }), run({ id: "queued", threadId: null, startedAt: null, endedAt: null })]);

    expect(groups.map((group) => group.id)).toEqual(["queued", "agent"]);
  });
});

describe("groupRatio", () => {
  it("takes both sides from the same runs, so a group spanning the upgrade is not divided across it", () => {
    // The failure this exists for: a thread reused across dispatches
    // (EO-90/91) can hold runs recorded before the cache figures existed
    // beside runs recorded after. Summing each side independently divides
    // a new numerator by a denominator that includes tokens nobody
    // claimed were cached — here 900k/1.4M, reported as 64% cached, when
    // what was measured is 900k of 1M.
    const group = groupOf(
      run({ id: "r1", tokensIn: 400_000, cacheReadTokens: null }),
      run({ id: "r2", tokensIn: 1_000_000, cacheReadTokens: 900_000, startedAt: 3_000, endedAt: 4_000 }),
    );

    expect(groupRatio(group, (r) => r.cacheReadTokens, (r) => r.tokensIn)).toEqual({ part: 900_000, whole: 1_000_000 });
  });

  it("is null on both sides when no run reported the part", () => {
    const group = groupOf(run({ tokensIn: 400_000 }));

    expect(groupRatio(group, (r) => r.cacheReadTokens, (r) => r.tokensIn)).toEqual({ part: null, whole: null });
  });
});

describe("groupModelTurns", () => {
  it("adds turn-scoped counts, which are each a run's own", () => {
    const group = groupOf(
      run({ id: "r1", turns: 14, turnsScope: "turn" }),
      run({ id: "r2", turns: 9, turnsScope: "turn", startedAt: 3_000, endedAt: 4_000 }),
    );

    expect(groupModelTurns(group)).toBe(23);
  });

  it("takes the largest session-scoped claim rather than adding them", () => {
    // A group is a set of rows sharing one provider thread — exactly the
    // boundary a session claim may already span. Adding 7 and 11 reports
    // an 18-turn conversation that took 11.
    const group = groupOf(
      run({ id: "r1", turns: 7, turnsScope: "session" }),
      run({ id: "r2", turns: 11, turnsScope: "session", startedAt: 3_000, endedAt: 4_000 }),
    );

    expect(groupModelTurns(group)).toBe(11);
  });

  it("skips a run that reported no count rather than reading it as none", () => {
    const group = groupOf(
      run({ id: "r1", turns: null }),
      run({ id: "r2", turns: 11, turnsScope: "session", startedAt: 3_000, endedAt: 4_000 }),
    );

    expect(groupModelTurns(group)).toBe(11);
  });

  it("is null when nothing in the group reported one", () => {
    expect(groupModelTurns(groupOf(run({ tokensIn: 500 })))).toBeNull();
  });
});

describe("groupSum", () => {
  it("keeps unknown and zero apart after summing", () => {
    expect(groupSum(groupOf(run({ costCents: null })), (r) => r.costCents)).toBeNull();
    expect(groupSum(groupOf(run({ costCents: 0 })), (r) => r.costCents)).toBe(0);
  });
});

describe("groupRuns", () => {
  it("folds a resumed run into the run it continues", () => {
    const groups = groupRuns([
      run({ id: "r2", threadId: "th-1", attempt: 2, startedAt: 2_000 }),
      run({ id: "r1", threadId: "th-1", attempt: 1, startedAt: 1_000 }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.runs.map((entry) => entry.id)).toEqual(["r1", "r2"]); // oldest first: the log reads in order
    expect(groups[0]!.latest.id).toBe("r2");
    expect(groups[0]!.id).toBe("r1"); // stable across the resume that created r2
  });

  it("keeps genuinely separate runs separate", () => {
    // A different action on its own thread, and a run that has not been
    // given a thread yet — neither is the other one continued.
    const groups = groupRuns([
      run({ id: "r1", action: "intake", threadId: "th-1", startedAt: 1_000 }),
      run({ id: "r2", action: "refine", threadId: "th-2", startedAt: 2_000 }),
      run({ id: "r3", action: "implement", threadId: null, startedAt: 3_000 }),
      run({ id: "r4", action: "review", threadId: null, startedAt: 4_000 }),
    ]);

    expect(groups.map((group) => group.id)).toEqual(["r4", "r3", "r2", "r1"]); // newest first
  });

  it("counts working time, not the hours a question waited on a human", () => {
    const group = groupRuns([
      run({ id: "r1", threadId: "th-1", startedAt: 0, endedAt: 5_000 }),
      run({ id: "r2", threadId: "th-1", startedAt: 100_000, endedAt: null, status: "running" }),
    ])[0]!;

    expect(groupElapsedMs(group, 103_000)).toBe(8_000);
  });

  it("says nothing rather than zero for a run that has not started", () => {
    expect(groupElapsedMs(groupRuns([run({ status: "running", startedAt: null, endedAt: null })])[0]!, 5_000)).toBeNull();
  });
});

describe("isRunActive", () => {
  it("knows which statuses are still active", () => {
    expect(isRunActive("running")).toBe(true);
    expect(isRunActive("queued")).toBe(true);
    expect(isRunActive("awaiting_input")).toBe(false); // parked, not working
    expect(isRunActive("succeeded")).toBe(false);
  });
});
