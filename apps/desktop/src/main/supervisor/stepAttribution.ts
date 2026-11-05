import type { Comment, Run, Item, Transition, Uuid } from "@eo/core";

/**
 * Which step a comment was written at.
 *
 * A seeded dispatch carries the newest word from every step an item has
 * passed through, so every comment has to be placed at one. Nothing
 * records that directly — a comment knows its run, a run knows its step
 * (0046), and a comment written by a person knows neither.
 *
 * Two routes, in this order:
 *
 * 1. **The run.** A comment written during a run belongs to the step that
 *    run was dispatched from. Exact, and it covers everything an agent or
 *    the engine writes while working.
 * 2. **The transition history.** Everything else — every human comment,
 *    the engine notes written outside a run, and every row recorded
 *    before 0046 — is placed by asking where the item sat at that
 *    moment. Exact for a different reason: `transitionItem` is the only
 *    writer of both `transitions` and `items.step_id`, and it writes
 *    them in one transaction, so the history cannot disagree with itself.
 */
export interface StepAttribution {
  stepOf(comment: Comment): string | null;
}

/**
 * Ties between a comment and a move are broken toward the **old** step.
 *
 * A human drags an item and leaves a note explaining why; `moveItem`
 * posts that note *before* the transition, deliberately. Reading the note
 * as belonging to the destination would file somebody's reason for moving
 * work under the place they moved it to, which is where it explains
 * nothing.
 *
 * The id comparison is what makes "before" mean anything inside a
 * millisecond: both ids are UUIDv7 from one monotonic source, so within a
 * process they compare in insertion order. Across a restart the two
 * cannot share a millisecond, so a reseeded counter is harmless.
 */
function precedes(transition: Transition, comment: Comment): boolean {
  if (transition.ts !== comment.createdAt) return transition.ts < comment.createdAt;
  return transition.id < comment.id;
}

export function createStepAttribution(item: Item, transitions: Transition[], runs: Run[]): StepAttribution {
  const runsById = new Map(runs.map((run) => [run.id as string, run]));
  // Oldest first, as `listTransitionsForItem` returns them.
  const history = [...transitions].sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));

  /**
   * Where the item sat before it ever moved.
   *
   * `createItem` writes the first step in the INSERT rather than through
   * `transitionItem`, so an item's original placement has no transition
   * of its own. The first transition's `fromStepId` is that placement,
   * recorded by the move that left it. With no transitions at all the
   * item has never moved and still sits where it started.
   */
  // With no history the item has never moved and still sits where it
  // started. With history, the first move records where it came from —
  // and where that is null, the comment predates any step this item can
  // be said to have been at, so it stays unplaced and falls to the census
  // rather than being filed under wherever the item happens to be now.
  const original = history.length === 0 ? item.stepId : history[0]!.fromStepId;

  return {
    stepOf(comment) {
      const run = comment.runId === null ? undefined : runsById.get(comment.runId);
      // A dry run borrows some item's worktree so a person can watch a
      // module work (KAN-106). Its comments are not that step's account of
      // itself, and letting one become "the newest word at review" is the
      // same mistake `shippedSummary` already excludes dry runs to avoid.
      if (run?.stepId && !run.dryRun) return run.stepId;

      let step = original;
      for (const transition of history) {
        if (!precedes(transition, comment)) break;
        // A self-transition — reconciliation writes one per orphaned run —
        // moves nothing, and assigning `toStepId` over the same value
        // costs nothing either.
        step = transition.toStepId;
      }
      return step;
    },
  };
}

/** One step's most recent word, as a seeded dispatch renders it. */
export interface StepComment {
  stepId: string;
  comment: Comment;
}

/**
 * The newest comment from each step the item has passed through.
 *
 * What a step "said" is what somebody acting there wrote: an agent's
 * result, a module's note. An engine note is a fact *about* a run — "the
 * result failed validation after 2 corrections" — and stands in only
 * where the step produced nothing else, because then it is the whole
 * account of what happened there.
 *
 * Human comments are excluded and carried separately. They answer
 * questions rather than reporting work, and letting one displace an
 * implementer's handoff would lose the handoff to a "yes, do that".
 *
 * Ordered by when the surviving comments were written, not by where their
 * steps sit in the pipeline. An item that has been round the review loop
 * three times gives the reviewer its newest rejection and the handoff
 * that answers it; in time order those read as the objection and then the
 * reply, which is the exchange. In pipeline order they read as a fresh
 * verdict on work that came after it.
 */
export function latestCommentPerStep(comments: Comment[], attribution: StepAttribution): StepComment[] {
  const spoken = new Map<string, Comment>();
  const heard = new Map<string, Comment>();

  const newer = (held: Comment | undefined, candidate: Comment) =>
    !held || held.createdAt < candidate.createdAt || (held.createdAt === candidate.createdAt && held.id < candidate.id);

  for (const comment of comments) {
    if (comment.authorType === "human") continue;
    const stepId = attribution.stepOf(comment);
    if (stepId === null) continue;
    // An engine comment that *stops work* is not chatter about a run — it
    // is the reason the next attempt exists, and it competes on recency
    // like anything else. Only a plain engine note defers to the step's
    // own account of itself.
    //
    // Getting this wrong is expensive and quiet: a verification failure
    // posted after attempt 2 would lose to attempt 1's handoff, so the
    // seed would show a claim of success, say nothing about why the work
    // came back, and the implementer would resubmit the same thing until
    // the attempt cap stopped it.
    const blocking = comment.kind === "rejection" || comment.kind === "escalation";
    const into = comment.authorType === "engine" && !blocking ? heard : spoken;
    if (newer(into.get(stepId), comment)) into.set(stepId, comment);
  }

  for (const [stepId, note] of heard) if (!spoken.has(stepId)) spoken.set(stepId, note);

  return [...spoken.entries()]
    .map(([stepId, comment]) => ({ stepId, comment }))
    .sort((a, b) => a.comment.createdAt - b.comment.createdAt || (a.comment.id < b.comment.id ? -1 : 1));
}

/**
 * The human comments this agent has not been shown.
 *
 * Everything a person has said since the agent's own last run on this
 * item ended — and everything, when it has never run here. The
 * watermark is `followUpComments`' (EO-89/91), including its tie-break on
 * the id: two rows can share a millisecond, and uuidv7 mints monotonically
 * for exactly this.
 *
 * The residual risk is worth naming rather than hiding: an agent that
 * opens a *fresh* conversation still counts its previous run, so an
 * answer given two runs ago is not carried here. What carries it instead
 * is the census — omitted comments are counted by author, so "3 human
 * notes omitted" is visible and `comment_search` reaches them.
 */
export function humanCommentsSince(comments: Comment[], priorRun: Run | undefined): Comment[] {
  const endedAt = priorRun?.endedAt ?? null;
  return comments.filter((comment) => {
    if (comment.authorType !== "human") return false;
    if (endedAt === null || priorRun === undefined) return true;
    return comment.createdAt > endedAt || (comment.createdAt === endedAt && comment.id > priorRun.id);
  });
}

/**
 * The agent's own last finished run on this item — the watermark above.
 *
 * A run whose thread the backend had lost does not count, and that
 * exclusion is load-bearing rather than tidy. When a parked conversation
 * is gone, EO resumes it, is told the session does not exist, marks the
 * run `threadLost` and dispatches a fresh one (EO-93). That failed
 * attempt showed the agent nothing — but it ended *after* the reply that
 * woke it, so counting it would put the watermark past the one comment
 * the new run exists to answer, and the agent would open a brand-new
 * conversation with no idea why.
 *
 * A run that never opened a thread at all is excluded for the same
 * reason, and it is not a rare shape: the attempt-limit guard writes a
 * run row with an `endedAt` before any backend is reached
 * (`refuseDispatch`), and so does a dispatch that fails at the provider.
 * Neither delivered a prompt to anyone.
 */
export function lastRunOf(runs: Run[], agentId: Uuid): Run | undefined {
  return runs
    .filter((run) => run.agentId === agentId && run.endedAt !== null && !run.threadLost && run.threadId !== null)
    .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0) || (a.id < b.id ? -1 : 1))
    .at(-1);
}
