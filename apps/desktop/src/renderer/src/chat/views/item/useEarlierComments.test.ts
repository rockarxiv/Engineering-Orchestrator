import { describe, expect, it } from "vitest";
import type { CommentView, TransitionView } from "@eo/core";
import { mergedComments, transitionsShown } from "./useEarlierComments";

function comment(id: string, createdAt: number, overrides: Partial<CommentView> = {}): CommentView {
  return {
    id,
    authorType: "human",
    authorName: "you",
    authorRole: null,
    runId: null,
    parentId: null,
    canApprove: false,
    body: id,
    kind: "note",
    options: null,
    pinned: false,
    createdAt,
    awaitingHuman: false,
    mirroredInJira: false,
    ...overrides,
  };
}

describe("what has been read back, merged with the page (EO-559)", () => {
  it("lets the page's copy win wherever both hold one", () => {
    const stale = comment("c2", 2);
    const fresh = comment("c2", 2, { pinned: true });

    expect(mergedComments([comment("c1", 1), stale], [fresh, comment("c3", 3)])).toEqual([comment("c1", 1), fresh, comment("c3", 3)]);
  });
});

describe("the moves drawn beside the comments", () => {
  const move = (id: string, ts: number): TransitionView => ({ id, fromStepId: "a", toStepId: "b", actor: "human", reason: null, ts });

  it("start at the oldest comment on screen while older ones are unread, and are all drawn once none are", () => {
    const transitions = [move("early", 5), move("late", 15)];
    const comments = [comment("c1", 10), comment("c2", 20)];

    expect(transitionsShown(transitions, comments, 3).map((entry) => entry.id)).toEqual(["late"]);
    expect(transitionsShown(transitions, comments, 0).map((entry) => entry.id)).toEqual(["early", "late"]);
    expect(transitionsShown(transitions, [], 0).map((entry) => entry.id)).toEqual(["early", "late"]);
  });
});
