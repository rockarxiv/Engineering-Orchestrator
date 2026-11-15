import type { LearningReviewKind, Run, Uuid } from "@eo/core";

/**
 * When an assistant chat is reviewed (EO-788).
 *
 * An `assist` run is not reviewed when it ends: a review that edits a
 * skill changes what the chat's agent is given, and the chat's next
 * message would then start a new thread rather than resume its own. A
 * chat is reviewed once it has gone quiet instead — `CHAT_IDLE_BEFORE_REVIEW_MS`
 * after its last `assist` run ended, with nothing since.
 *
 * Which chats are due is worked out from runs and `run_events`, not
 * stored: a chat is due when it has a run to review newer than the newest
 * of its runs carrying a `learning_review` event. So a chat that went
 * quiet before EO quit is still reviewed after it starts again, and a
 * review that was cancelled, having appended no event, leaves the chat
 * due.
 */

/** One review a quiet chat is owed: of the newest run on one of its threads. */
export interface QuietThreadReview {
  runId: Uuid;
  threadId: string;
  review: LearningReviewKind;
}

export type QuietChat =
  /** Nothing since its last review is reviewable, so nothing is owed until it runs again. */
  | { kind: "settled" }
  /** Owed a review, and not quiet yet: due at `dueAt`, or, with a run in flight, once it ends (null). */
  | { kind: "waiting"; dueAt: number | null }
  /** Owed a review on each of these threads now, oldest first. */
  | { kind: "due"; threads: QuietThreadReview[] };

/**
 * Whether a chat is owed a review now, and of what. Pure.
 *
 * `runs` are the chat's `assist` runs, oldest first; `reviewedThrough` the
 * newest of its runs that carries a `learning_review` event. A run past
 * it is reviewable where `reviewFor` says which review it gets — a run
 * cancelled, interrupted, on a preview or with no memory scope gets none,
 * as after a run — and where it has a thread to fork. Each thread among
 * them gets its own review, of its newest run: a full one unless every
 * run on it wrote its own notes (EO-731).
 */
export function quietChatReview(input: {
  runs: readonly Run[];
  reviewedThrough: string | null;
  now: number;
  idleMs: number;
  reviewFor: (run: Run) => LearningReviewKind | null;
}): QuietChat {
  const { runs, reviewedThrough } = input;
  const threads = new Map<string, QuietThreadReview>();
  for (const run of runs) {
    if (reviewedThrough !== null && run.id <= reviewedThrough) continue;
    if (run.threadId === null) continue;
    const review = input.reviewFor(run);
    if (review === null) continue;
    const earlier = threads.get(run.threadId);
    // Deleted and set again, so the map's order is by each thread's newest run.
    threads.delete(run.threadId);
    threads.set(run.threadId, { runId: run.id, threadId: run.threadId, review: earlier?.review === "full" ? "full" : review });
  }
  if (threads.size === 0) return { kind: "settled" };
  if (runs.some((run) => run.status === "queued" || run.status === "running")) return { kind: "waiting", dueAt: null };
  const dueAt = Math.max(0, ...runs.map((run) => run.endedAt ?? run.startedAt ?? 0)) + input.idleMs;
  if (input.now < dueAt) return { kind: "waiting", dueAt };
  return { kind: "due", threads: [...threads.values()] };
}
