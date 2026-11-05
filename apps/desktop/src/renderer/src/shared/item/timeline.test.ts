import type { CommentView, TransitionView } from "@eo/core";
import { describe, expect, it } from "vitest";
import { buildTimeline, describeActor } from "./timeline";

function comment(overrides: Partial<CommentView> = {}): CommentView {
  return {
    id: "c1",
    authorType: "agent",
    authorName: "Implementer",
    authorRole: "implementer",
    runId: null,
    parentId: null,
    canApprove: false,
    body: "Working on it.",
    kind: "note",
    options: null,
    pinned: false,
    createdAt: 100,
    awaitingHuman: false,
    mirroredInJira: false,
    ...overrides,
  };
}

function transition(overrides: Partial<TransitionView> = {}): TransitionView {
  return { id: "x1", fromStepId: "todo", toStepId: "review", actor: "human", reason: null, ts: 200, ...overrides };
}

describe("buildTimeline", () => {
  it("interleaves comments and transitions by timestamp", () => {
    const merged = buildTimeline({
      comments: [comment({ id: "c1", createdAt: 100 }), comment({ id: "c2", createdAt: 300 })],
      transitions: [transition({ id: "x1", ts: 200 }), transition({ id: "x2", ts: 50 })],
    });

    expect(merged.map((entry) => (entry.kind === "comment" ? entry.comment.id : entry.transition.id))).toEqual(["x2", "c1", "x1", "c2"]);
  });

  it("puts a comment before a transition that shares its timestamp", () => {
    // A finishing run posts and moves in the same millisecond; "moved to
    // review" reads better after the comment explaining why.
    const merged = buildTimeline({ comments: [comment({ createdAt: 100 })], transitions: [transition({ ts: 100 })] });
    expect(merged.map((entry) => entry.kind)).toEqual(["comment", "transition"]);
  });

  it("handles either side being empty", () => {
    expect(buildTimeline({ comments: [], transitions: [] })).toEqual([]);
    expect(buildTimeline({ comments: [comment()], transitions: [] })).toHaveLength(1);
  });
});

/**
 * An output's `parentId` is not a reply (EO-311, EO-298).
 *
 * It names the output this one **supersedes**, which is a chain rather
 * than a conversation. Threading here is one level deep, so nesting the
 * chain would draw the second correction under the first and the third
 * nowhere at all — and "older outputs are reachable from the thread" is
 * the whole of what this story asks of the timeline.
 */
describe("buildTimeline and the output chain", () => {
  const output = (id: string, parentId: string | null, at: number) =>
    comment({ id, parentId, kind: "output", createdAt: at, body: `version ${id}` });

  it("keeps every output on the line, however long the chain", () => {
    const merged = buildTimeline({
      comments: [output("o1", null, 100), output("o2", "o1", 200), output("o3", "o2", 300)],
      transitions: [],
    });

    expect(merged.map((entry) => (entry.kind === "comment" ? entry.comment.id : ""))).toEqual(["o1", "o2", "o3"]);
    expect(merged.every((entry) => entry.kind === "comment" && entry.replies.length === 0)).toBe(true);
  });

  it("still nests what actually answers one", () => {
    // A person replying to an output is replying, and belongs under it.
    const merged = buildTimeline({
      comments: [output("o1", null, 100), comment({ id: "c1", parentId: "o1", createdAt: 150 })],
      transitions: [],
    });

    expect(merged).toHaveLength(1);
    expect(merged[0]?.kind === "comment" && merged[0].replies.map((reply) => reply.id)).toEqual(["c1"]);
  });
});

describe("describeActor", () => {
  it("names the human and resolves agent ids", () => {
    const names = new Map([["a1", "Implementer"]]);
    expect(describeActor("human", names)).toBe("you");
    expect(describeActor("a1", names)).toBe("Implementer");
    expect(describeActor("gone", names)).toBe("an agent"); // a deleted agent still renders
  });
});
