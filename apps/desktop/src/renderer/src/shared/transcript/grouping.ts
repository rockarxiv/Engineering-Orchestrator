import type { RunView } from "@eo/core";

/**
 * One conversation, however many `runs` rows it took.
 *
 * Replying to a parked run does not restart it: `resumeItem` writes a
 * new row that carries the same provider thread forward. That is right
 * in the database — each turn has its own cost, its own events, its own
 * outcome — and wrong on screen, where it read as two separate intakes
 * when only one ever happened.
 *
 * The thread id is what makes two rows the same run. It comes from the
 * provider session; a fresh dispatch always opens a new one, and a
 * resume is exactly the case that carries it over. A row with no thread
 * yet (queued, or the attempt-limit guard's placeholder) stands alone,
 * so two runs waiting on their first event never collapse together.
 */
export interface RunGroup {
  /** Stable across a resume — the group keeps its identity when a turn is added. */
  id: string;
  /** Every turn, oldest first. */
  runs: RunView[];
  /** The newest turn: whose status the group reports and whose run the controls act on. */
  latest: RunView;
}

function startOrder(run: RunView): number {
  // A run with no start time hasn't been dispatched yet, so it belongs
  // after everything that has — not at the beginning of time. Unless it
  // has ended: a watch's quiet run has no start (`recordQuietCheck`), and
  // its place is its last check.
  return run.startedAt ?? run.endedAt ?? Number.MAX_SAFE_INTEGER;
}

/** Runs folded into conversations, newest first. */
export function groupRuns(runs: readonly RunView[]): RunGroup[] {
  const byThread = new Map<string, RunView[]>();
  for (const run of runs) {
    const key = run.threadId ?? `run:${run.id}`;
    const existing = byThread.get(key);
    if (existing) existing.push(run);
    else byThread.set(key, [run]);
  }

  const groups = [...byThread.values()].map((members) => {
    const ordered = [...members].sort((a, b) => startOrder(a) - startOrder(b) || a.attempt - b.attempt);
    return { id: ordered[0]!.id, runs: ordered, latest: ordered.at(-1)! };
  });

  return groups.sort((a, b) => startOrder(b.latest) - startOrder(a.latest));
}

/**
 * How long the agent has actually been working, across every turn.
 *
 * Each turn's own span, summed — so the hours a question sat waiting for
 * a human are not counted as the agent thinking. Null when nothing in
 * the group has started, which is not the same as zero.
 */
export function groupElapsedMs(group: RunGroup, now: number): number | null {
  let total = 0;
  let started = false;
  for (const run of group.runs) {
    if (run.startedAt === null) continue;
    started = true;
    total += Math.max(0, (run.endedAt ?? now) - run.startedAt);
  }
  return started ? total : null;
}

/**
 * A group's total for a per-run number.
 *
 * Null only when no turn reported one: the SDK gives tokens but not
 * money, so an unknown cost and a cost of zero stay different things
 * after summing (A-04).
 */
export function groupSum(group: RunGroup, pick: (run: RunView) => number | null): number | null {
  return sumOver(group.runs, pick);
}

/**
 * Two totals over exactly the runs that reported both — a ratio's pair.
 *
 * A plain `groupSum` of each side is a trap here: a group spans a whole
 * conversation and can therefore span an upgrade, so the numerator can
 * come from runs the denominator does not describe. A thread reused
 * across dispatches (EO-90/91) with cache figures on its newer runs and
 * none on its older ones would report a cached share computed against
 * tokens nobody claimed were cached.
 *
 * Returned together rather than as two calls sharing a filter, so the
 * pairing is the function's job instead of an invariant each call site
 * has to remember: one run counted on one side only is how a share
 * exceeds 100%.
 */
export function groupRatio(
  group: RunGroup,
  part: (run: RunView) => number | null,
  whole: (run: RunView) => number | null,
): { part: number | null; whole: number | null } {
  const both = group.runs.filter((run) => part(run) !== null && whole(run) !== null);
  return { part: sumOver(both, part), whole: sumOver(both, whole) };
}

function sumOver(runs: RunView[], pick: (run: RunView) => number | null): number | null {
  let total = 0;
  let known = false;
  for (const run of runs) {
    const value = pick(run);
    if (value === null) continue;
    known = true;
    total += value;
  }
  return known ? total : null;
}

/**
 * The group's model turns, by the rule the rows themselves declare.
 *
 * A group is a set of runs sharing one provider thread, which is exactly
 * the boundary a `session` count may already span: the backend's claim on
 * the second run may include the first run's turns, so adding them
 * reports a conversation longer than it was. A `turn` count is this run's
 * own and adds up with its neighbours'.
 *
 * Rows that declare nothing are skipped rather than assumed either way.
 * Mixed groups cannot occur — a thread belongs to one backend — and if
 * one ever does, the additive rule wins for the rows that claim it and
 * the largest session claim joins them, which is the same hedge the
 * tally makes inside a single run.
 */
export function groupModelTurns(group: RunGroup): number | null {
  let added: number | null = null;
  let claimed: number | null = null;
  for (const run of group.runs) {
    if (run.turns === null) continue;
    if (run.turnsScope === "session") claimed = Math.max(claimed ?? 0, run.turns);
    else added = (added ?? 0) + run.turns;
  }
  if (added === null) return claimed;
  return claimed === null ? added : added + claimed;
}

/**
 * Is this run working right now?
 *
 * `queued` counts: the row exists and EO is bringing a backend up
 * against it, which is not the same as idle. `awaiting_input` does not —
 * that one is parked on a question and nothing is running.
 *
 * Here rather than in `Transcript.tsx`, where it used to live, because
 * the composer on the item page asks it too (EO-176) and a second copy
 * of the answer is a second thing to keep right.
 */
export function isRunActive(status: string): boolean {
  return status === "running" || status === "queued";
}

/**
 * A watch's quiet run (`recordQuietCheck`): the one run that succeeds without
 * having started. A record of checks rather than work, so it is listed with
 * the runs but is never "the latest run" of an item.
 */
export function isQuietRun(run: RunView): boolean {
  return run.status === "succeeded" && run.startedAt === null;
}

/** The run a person could say something to, and what it would cost them to know. */
export interface LiveRun {
  runId: string;
  /** Who is working — the sentence about where a message is going has to name them. */
  agentName: string;
  /**
   * Whether this run's backend can be spoken to mid-turn.
   *
   * False is not "no message allowed": it is "this one can only be
   * queued", which is a sentence rather than a choice. A control
   * offering a mode the backend does not have would be a button that
   * does nothing.
   */
  steerable: boolean;
}

/** That run, or null when nothing is going — the same question both composers ask (EO-176). */
export function liveRunOf(run: RunView | undefined): LiveRun | null {
  if (!run || !isRunActive(run.status)) return null;
  return { runId: run.id, agentName: run.agentName, steerable: run.steerable };
}
