import type { CommentView, ItemDetail, TransitionView } from "@eo/core";

export type TimelineEntry =
  | { kind: "comment"; at: number; comment: CommentView; replies: CommentView[] }
  | { kind: "transition"; at: number; transition: TransitionView };

/**
 * Whether a comment's `parentId` means "answers this" (D-05).
 *
 * It does for every kind but one. An output's parent is the output it
 * **supersedes** (EO-298) — a chain rather than a conversation — so
 * nesting one under another would say the wrong thing twice over: a
 * correction is not a reply to the draft it replaces, and threading here
 * is one level deep, so the third output in a chain would hang off a
 * reply and be drawn nowhere at all. Every output is a line of the
 * timeline in its own right, in the order they were written, which is
 * what makes the earlier ones reachable from the thread (EO-311).
 */
function nests(comment: CommentView): boolean {
  return comment.kind !== "output";
}

/**
 * Merges the two histories into one chronological list (U-03).
 *
 * `comments` and `transitions` are separate tables on purpose — a state
 * change is not a message, and writing system events into `comments`
 * would corrupt the thread every agent reads as context (ARCHITECTURE.md, "The timeline is two
 * tables"). They are
 * joined here, at render time, and nowhere else.
 *
 * Ties break toward the transition: a run that finishes posts its
 * comment and moves the item in the same millisecond, and "moved to
 * review" reads better after the comment explaining why than before it.
 */
export function buildTimeline(detail: Pick<ItemDetail, "comments" | "transitions">): TimelineEntry[] {
  // Replies are not entries of their own: they hang off the comment they
  // answer (D-05), which is the whole point of threading them. A reply
  // whose parent isn't here — it was on another item, or the parent
  // predates this — is shown at the top level rather than dropped.
  const byId = new Map(detail.comments.map((comment) => [comment.id, comment]));
  const repliesByParent = new Map<string, CommentView[]>();
  for (const comment of detail.comments) {
    if (!nests(comment)) continue;
    if (comment.parentId === null || !byId.has(comment.parentId)) continue;
    const siblings = repliesByParent.get(comment.parentId);
    if (siblings) siblings.push(comment);
    else repliesByParent.set(comment.parentId, [comment]);
  }
  for (const replies of repliesByParent.values()) replies.sort((a, b) => a.createdAt - b.createdAt);

  const entries: TimelineEntry[] = [
    ...detail.comments
      .filter((comment) => !nests(comment) || comment.parentId === null || !byId.has(comment.parentId))
      .map((comment) => ({ kind: "comment" as const, at: comment.createdAt, comment, replies: repliesByParent.get(comment.id) ?? [] })),
    ...detail.transitions.map((transition) => ({ kind: "transition" as const, at: transition.ts, transition })),
  ];

  return entries.sort((a, b) => a.at - b.at || (a.kind === b.kind ? 0 : a.kind === "comment" ? -1 : 1));
}

/** Resolves a transition's actor id to something readable — agents are ids on the row, names in the UI. */
export function describeActor(actor: string, agentNames: Map<string, string>): string {
  if (actor === "human") return "you";
  return agentNames.get(actor) ?? "an agent";
}
