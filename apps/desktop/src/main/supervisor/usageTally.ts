import { MICROCENTS_PER_CENT, type UsageEvent } from "@eo/core";

/**
 * What one run's row records, once the tally has read every reading.
 *
 * The optional three are `null` for "the backend never said", which is a
 * different fact from zero and has to survive as one: a run whose
 * backend reports no cache figures is not a run with a cold cache, and a
 * `0% cached` on screen is a claim nobody made.
 */
export interface UsageTotals {
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  turns: number | null;
  /**
   * Which rule `turns` follows, so that nothing downstream has to guess.
   *
   * `"turn"` is a count of this run's own turns and adds up with its
   * neighbours'. `"session"` is what the backend claimed for the
   * conversation, which may already include the turns of every earlier
   * run on the same thread — so those must not be added together.
   *
   * The distinction is invisible in the number, and the two aggregate
   * differently one level up: a run group is a set of rows sharing a
   * provider thread, which is exactly the boundary the claim may span.
   * Null when nothing reported a count.
   */
  turnsScope: "turn" | "session" | null;
  costCents: number;
}

export interface UsageTally {
  /**
   * Takes one reading. False when there was nothing in it — the caller
   * should not persist totals it did not change, or a run whose only
   * reading was an empty crash result records `0 in / 0 out` where the
   * truth is that nothing was ever reported.
   */
  record(event: UsageEvent): boolean;
  /** The run's totals as they stand — safe to persist after every reading. */
  totals(): UsageTotals;
  /**
   * `totals().costCents` before it was rounded, in micro-cents (EO-510):
   * what a side call records, since one costs a fraction of a cent and
   * whole cents record it as nothing. Summed and superseded by the same
   * rules as `costCents`, from each reading's `costMicrocents` — or its
   * `costCents`, where a backend gave nothing finer.
   *
   * Beside `totals()` rather than in it: a run's row keeps whole cents,
   * and `totals()` is what is written to it.
   */
  costMicrocents(): number;
  /**
   * Ends the current provider stream and banks what it reported.
   *
   * Call before starting another one on the same run — a corrective turn
   * or a re-prompt after failed validation. Both are a fresh `resume()`
   * of the same session, whose running total may carry on from what this
   * stream reported or may start again from zero (`createUsageTally`
   * says which, and how the two are told apart). Banking is what makes
   * either right: what this stream spent is kept as the run's own, and it
   * joins what the next stream's readings are measured against.
   */
  commit(): void;
  /**
   * The session's running total as the run last read it (EO-504): the
   * backend's figure for the whole conversation, not the run's share of
   * it — what the next run on the same thread starts from. Null until a
   * session reading has said anything about tokens or money, and for
   * ever on a backend that reports turn by turn, which has no running
   * total to report.
   *
   * Persisted beside `totals()` so the next run's starting point is a
   * figure the backend gave, rather than a sum of shares that is only
   * the session's total while every one of them is right.
   */
  sessionTotal(): ThreadUsage | null;
}

/**
 * Where a resumed session's running total stood when the run began, as
 * the figure it may already contain (EO-490, `sessionTotalBefore`). Only
 * what a session reading carries: the turn count restarts with every
 * query and is never carried.
 */
export interface ThreadUsage {
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  costCents: number;
}

/** One earlier run on a thread, as its row holds it (`usageHistoryOnThread`). */
export interface ThreadRunUsage {
  /** The run's spend as recorded — its share since EO-490, the whole conversation before it. Null where it recorded nothing. */
  recorded: ThreadUsage | null;
  /** The session's running total as the run last read it (`UsageTally.sessionTotal`). Null on every row written before EO-504. */
  sessionEndedOn: ThreadUsage | null;
}

export interface UsageTallyOptions {
  /**
   * Where the session this run resumes stood when it began
   * (`sessionTotalBefore`) — null or absent for a run that starts its
   * own. A session reading that includes it has it taken off, so a
   * resumed run records only what it spent itself.
   */
  earlierOnThread?: ThreadUsage | null;
}

/** What the tally keeps: the totals, and the cost unrounded beside them (`UsageTally.costMicrocents`). */
interface Tallied extends UsageTotals {
  costMicrocents: number;
}

const ZERO: Tallied = { tokensIn: 0, tokensOut: 0, cacheReadTokens: null, cacheWriteTokens: null, turns: null, turnsScope: null, costCents: 0, costMicrocents: 0 };

/** Absent stays absent; the larger of two answers wins. */
function maxOptional(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

/** Absent stays absent; anything else adds. Two unknowns do not make a zero. */
function addOptional(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return a + b;
}

/** Absent stays absent; a figure with nothing known to take off it is kept whole. */
function subtractOptional(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return a;
  return Math.max(0, a - b);
}

/** Every figure both report is at least the carried one's — the shape of a running total that went on from it. */
function includes(reading: ThreadUsage, carried: ThreadUsage): boolean {
  const atLeast = (a: number | null, b: number | null): boolean => a === null || b === null || a >= b;
  return (
    reading.tokensIn >= carried.tokensIn &&
    reading.tokensOut >= carried.tokensOut &&
    reading.costCents >= carried.costCents &&
    atLeast(reading.cacheReadTokens, carried.cacheReadTokens) &&
    atLeast(reading.cacheWriteTokens, carried.cacheWriteTokens)
  );
}

/**
 * A session reading with what the session carried in taken off, turn
 * count untouched.
 *
 * What was carried in is known only in whole cents — a run's row keeps
 * no finer figure — so the micro-cents have whole cents taken off them.
 * Only a run resumes a thread, and a run's cost is its whole cents.
 */
function less(reading: Tallied, carried: ThreadUsage): Tallied {
  return {
    ...reading,
    tokensIn: Math.max(0, reading.tokensIn - carried.tokensIn),
    tokensOut: Math.max(0, reading.tokensOut - carried.tokensOut),
    cacheReadTokens: subtractOptional(reading.cacheReadTokens, carried.cacheReadTokens),
    cacheWriteTokens: subtractOptional(reading.cacheWriteTokens, carried.cacheWriteTokens),
    costCents: Math.max(0, reading.costCents - carried.costCents),
    costMicrocents: Math.max(0, reading.costMicrocents - carried.costCents * MICROCENTS_PER_CENT),
  };
}

function carriedPlus(carried: ThreadUsage, own: ThreadUsage): ThreadUsage {
  return {
    tokensIn: carried.tokensIn + own.tokensIn,
    tokensOut: carried.tokensOut + own.tokensOut,
    cacheReadTokens: addOptional(carried.cacheReadTokens, own.cacheReadTokens),
    cacheWriteTokens: addOptional(carried.cacheWriteTokens, own.cacheWriteTokens),
    costCents: carried.costCents + own.costCents,
  };
}

const NOTHING_CARRIED: ThreadUsage = { tokensIn: 0, tokensOut: 0, cacheReadTokens: null, cacheWriteTokens: null, costCents: 0 };

/**
 * Where a thread's session stood when its earlier runs were done with
 * it (EO-504): the figure the next run's first reading is measured
 * against. Null for a thread with nothing recorded on it.
 *
 * The newest run that recorded the session's running total itself
 * (`sessionEndedOn`) answers outright. That is a figure the backend
 * gave, so it is right however the shares beside it came out.
 *
 * Rows written before EO-504 hold no such figure, only what the run
 * recorded, and those are of two kinds that look alike. A row from
 * before EO-490 recorded the whole conversation's total; a row from
 * between the two recorded the run's share — or, where the bug this
 * fixes caught it, the whole total again. Summing them, as EO-490 did,
 * is right only for shares: one whole-total row and the sum overshoots
 * the session, every later reading looks like a restart and is
 * recorded whole, and the overshoot grows with every run.
 *
 * So the rows are walked oldest first and each is read by the test the
 * tally reads a stream by. A row at or above the total so far in every
 * figure is a running total that went on from it, and becomes the
 * total; a row below it in any figure is a share, and adds to it. The
 * first row of a thread is the whole of the session either way.
 *
 * Two kinds of row fool the test, because the figures alone cannot tell
 * them from the other kind:
 *
 * - a share that outspent everything before it on the thread in every
 *   figure is taken for the whole total, which is then too small, and
 *   the next run records the earlier runs' spend again on top of its own;
 * - a whole total from a session that had restarted before EO-490 is
 *   below the total so far, so it is taken for a share and added, which
 *   leaves the total too large. The next run's reading is then below it,
 *   is read as a restart, and is recorded whole.
 *
 * Either way it is the next run alone that is wrong. It records the
 * session's total as it read it (`sessionEndedOn`), and every run on the
 * thread after it starts from that.
 */
export function sessionTotalBefore(history: readonly ThreadRunUsage[]): ThreadUsage | null {
  let total: ThreadUsage | null = null;
  for (const run of history) {
    if (run.sessionEndedOn) total = run.sessionEndedOn;
    else if (run.recorded === null) continue;
    else if (total === null || includes(run.recorded, total)) total = run.recorded;
    else total = carriedPlus(total, run.recorded);
  }
  return total;
}

function readingOf(event: UsageEvent): Tallied {
  return {
    tokensIn: event.tokensIn,
    tokensOut: event.tokensOut,
    cacheReadTokens: event.cacheReadTokens ?? null,
    cacheWriteTokens: event.cacheWriteTokens ?? null,
    // A turn-scoped reading with no count is the one turn it describes —
    // that is a fact, not a guess. A session-scoped one that does not say
    // has nothing to infer from, and says so.
    turns: event.turns ?? (event.scope === "turn" ? 1 : null),
    turnsScope: event.scope,
    costCents: event.costCents ?? 0,
    costMicrocents: event.costMicrocents ?? (event.costCents ?? 0) * MICROCENTS_PER_CENT,
  };
}

function add(a: Tallied, b: Tallied): Tallied {
  return {
    tokensIn: a.tokensIn + b.tokensIn,
    tokensOut: a.tokensOut + b.tokensOut,
    cacheReadTokens: addOptional(a.cacheReadTokens, b.cacheReadTokens),
    cacheWriteTokens: addOptional(a.cacheWriteTokens, b.cacheWriteTokens),
    turns: addOptional(a.turns, b.turns),
    // A run talks to one backend, so these never disagree in practice;
    // the later one wins rather than the sum inventing a third answer.
    turnsScope: b.turnsScope ?? a.turnsScope,
    costCents: a.costCents + b.costCents,
    costMicrocents: a.costMicrocents + b.costMicrocents,
  };
}

/**
 * Adds up what a run consumed, by the rule each backend reports under.
 *
 * The two disagree, and a tally that treats them alike is wrong for one
 * of them without ever looking wrong:
 *
 * - **Codex** reports each turn as it completes. Ten turns are ten
 *   readings and the run's figure is their sum.
 * - **The Claude SDK** re-reports a running total for the whole query on
 *   every result message, and its own types say to "read the latest
 *   result rather than summing across results". Adding those up counts
 *   the first turn once for every turn that follows it.
 *
 * So `scope` decides: a turn is added, a session replaces. What EO used
 * to do — add both — was right for Codex and inflating for Claude, on a
 * number nobody could sanity-check because the plausible answer and the
 * wrong one look the same.
 *
 * **A resumed session's running total is not the run's (EO-490).** The
 * Claude CLI writes its cost state into the session transcript and
 * restores it when the session is resumed, so the first reading of a
 * resumed stream — a rework round, a reply after escalation, a rerun, a
 * corrective turn — already contains everything earlier on the thread
 * spent. Its tokens and cost carry over; `num_turns` does not, and
 * counts the query alone. Recorded as it stands, every resumed run
 * charged all the runs before it again.
 *
 * So each stream is measured against what it may have carried in: the
 * session's total as the stream before it left it. For a run's first
 * stream that is where earlier runs on the thread left the session
 * (`earlierOnThread`, read by `sessionTotalBefore`); for a later one it is that plus the run's own
 * earlier streams, or — once a stream has shown the session restarted —
 * that stream's reading alone. The stream's first session reading
 * decides which kind of total it is reading:
 *
 * - every figure at or above what was carried in — the total went on
 *   from it, and what was carried in is taken off every reading of the
 *   stream;
 * - any figure below it — a running total that included it could not
 *   be smaller, so the session started again from zero and the reading
 *   is the stream's own, whole. Never a negative and never a zero.
 *
 * The test can be fooled one way: a session that genuinely restarted and
 * then outspent, in every figure, all that came before it on the thread
 * is read as one that went on, and records the difference. That needs a
 * restart, which this CLI does not do on a resume, and costs an
 * undercount rather than another doubling.
 */
export function createUsageTally(options: UsageTallyOptions = {}): UsageTally {
  let banked: Tallied = ZERO;
  /**
   * What the current stream's running total may already include: the
   * session's total as the previous stream left it (`commit`).
   */
  let carried: ThreadUsage = options.earlierOnThread ?? NOTHING_CARRIED;
  /**
   * Whether the current stream's running total went on from `carried` —
   * decided on its first session reading and held for the rest of the
   * stream, since one stream is one running total. Null until then.
   */
  let goesOn: boolean | null = null;
  /** The current stream's latest session reading, which the next one supersedes — as the backend reported it, before anything carried is taken off. */
  let session: Tallied = ZERO;
  /** Turn-scoped readings from the current stream, which accumulate. */
  let turnScoped: Tallied = ZERO;
  /**
   * The highest turn count any session reading has claimed, across every
   * stream of this run.
   *
   * Session *tokens* are banked and added when a run opens a second
   * stream, each stream's own share of them (`carried`, above). The SDK
   * documents that a resumed session's cost starts fresh; `num_turns`
   * carries no such note — the fields around it say "resumed sessions
   * start fresh" and it pointedly does not — so it may well be counting
   * the whole conversation rather than this query. Adding those together
   * would report a 15-turn run that took 8. (The CLI EO pins does the
   * reverse of both notes across runs — cost carries over and the turn
   * count restarts, EO-490 — which this mark undercounts by the
   * corrective turn rather than doubling.)
   *
   * A high-water mark is exactly right if the count is conversation-wide,
   * and short by the corrective turn if it resets. Undercounting a
   * multiplier by one on an uncommon path beats doubling it, and this is
   * the arithmetic to revisit once a resumed run has been observed.
   *
   * Turn-scoped counts are unaffected: those are one reading per turn and
   * genuinely add up.
   */
  let sessionTurnsHighWater: number | null = null;
  /**
   * The current stream's newest reading that said anything about tokens
   * or money, exactly as the backend reported it. Not `session`, which
   * keeps each figure's high-water mark for this run's spend: a running
   * total the SDK says a mid-session `/clear` resets arrives as a
   * smaller reading, and from then on the session stands at that
   * smaller figure — which is what the next stream, or the next run on
   * the thread, carries on from (EO-504).
   */
  let lastReading: Tallied | null = null;
  /** The session's total as the last stream that read one left it — what `sessionTotal` answers between streams. */
  let endedOn: ThreadUsage | null = null;

  /**
   * Everything the three accumulators hold, with `turns` blanked.
   *
   * The count is the one field the two scopes disagree about, so it is
   * never `add()`'s to compute here: every caller decides it explicitly
   * below. Returning a summed one and trusting callers to overwrite it
   * would leave a plausible, wrong number for the next caller to keep.
   */
  const ownSession = (): Tallied => (goesOn ? less(session, carried) : session);
  const combined = (): Tallied => ({ ...add(banked, add(ownSession(), turnScoped)), turns: null });
  const scope = (): UsageTotals["turnsScope"] => session.turnsScope ?? turnScoped.turnsScope ?? banked.turnsScope;
  const countedTurns = (): number | null =>
    addOptional(addOptional(banked.turns, turnScoped.turns), sessionTurnsHighWater);
  /**
   * The session's total as the current stream leaves it, or as the last
   * one that read anything did: the newest reading itself, since every
   * one is the backend's running total for the whole session. A cache
   * figure the reading did not report is the one carried in, where the
   * stream went on from it — the session holds at least that — and
   * unknown where it restarted.
   */
  const sessionNow = (): ThreadUsage | null => {
    if (lastReading === null) return endedOn;
    const known = goesOn === true ? carried : NOTHING_CARRIED;
    return {
      tokensIn: lastReading.tokensIn,
      tokensOut: lastReading.tokensOut,
      cacheReadTokens: lastReading.cacheReadTokens ?? known.cacheReadTokens,
      cacheWriteTokens: lastReading.cacheWriteTokens ?? known.cacheWriteTokens,
      costCents: lastReading.costCents,
    };
  };

  return {
    record(event) {
      const reading = readingOf(event);
      if (event.scope === "turn") {
        turnScoped = add(turnScoped, reading);
        return true;
      }
      // A session reading supersedes the last one — but only a real one.
      // The SDK documents that a crash or startup-error result "may carry
      // zeroed values", and since this replaces rather than adds, an
      // empty one would wipe out the account of everything the stream had
      // already reported.
      //
      // "Empty" means the whole reading, not its token counters. Keying
      // this on tokens alone dropped the cost and the turn count that
      // came with them — and cost is what E-05's budget guards are
      // denominated in, from the one backend that reports any. A reading
      // carrying money is a reading that happened, whatever its token
      // counters say.
      //
      // Money to the micro-cent (EO-510): a side call's half a cent is
      // nought in whole cents, and is still money.
      if (reading.tokensIn === 0 && reading.tokensOut === 0 && reading.costCents === 0 && reading.costMicrocents === 0 && reading.turns === null) return false;
      // The first real reading of the stream says whether its running
      // total carried on from the thread's earlier spend (EO-490). A
      // reading with no tokens and no money says nothing about that, and
      // waits for one that does.
      const saysSomething = reading.tokensIn > 0 || reading.tokensOut > 0 || reading.costCents > 0 || reading.costMicrocents > 0;
      if (goesOn === null && saysSomething) {
        goesOn = includes(reading, carried);
      }
      if (saysSomething) lastReading = reading;
      // Field-wise forwards only. A running total is meant to grow, and
      // the SDK names two ways it may not: a crash result "may carry
      // zeroed values" (caught above), and a mid-session `/clear` "resets
      // the running total" — which arrives as a smaller reading, not an
      // empty one, and would otherwise write a number backwards or a
      // figure the earlier reading had back to null.
      session = {
        tokensIn: Math.max(session.tokensIn, reading.tokensIn),
        tokensOut: Math.max(session.tokensOut, reading.tokensOut),
        cacheReadTokens: maxOptional(session.cacheReadTokens, reading.cacheReadTokens),
        cacheWriteTokens: maxOptional(session.cacheWriteTokens, reading.cacheWriteTokens),
        turns: maxOptional(session.turns, reading.turns),
        turnsScope: reading.turnsScope,
        costCents: Math.max(session.costCents, reading.costCents),
        costMicrocents: Math.max(session.costMicrocents, reading.costMicrocents),
      };
      if (reading.turns !== null) sessionTurnsHighWater = Math.max(sessionTurnsHighWater ?? 0, reading.turns);
      return true;
    },
    totals() {
      // Whole cents only: this is what a run's row is written from.
      const { tokensIn, tokensOut, cacheReadTokens, cacheWriteTokens, costCents } = combined();
      return { tokensIn, tokensOut, cacheReadTokens, cacheWriteTokens, costCents, turns: countedTurns(), turnsScope: scope() };
    },
    costMicrocents() {
      return combined().costMicrocents;
    },
    commit() {
      // The session's turn claim is deliberately not banked — the next
      // stream's claim may already contain it. Everything else, including
      // the turn-scoped counts, is this stream's own and is kept.
      banked = { ...combined(), turns: addOptional(banked.turns, turnScoped.turns), turnsScope: scope() };
      // Where the next stream's running total may carry on from — which,
      // with this CLI, it will: the session's total as this stream left
      // it. After the banking, which reads this stream against what it
      // carried in.
      //
      // That is the stream's newest reading, whichever way it was read
      // (`sessionNow`). One that restarted proved `carried` absent from
      // the session, and one that was reset part-way by a `/clear` left
      // the session at the smaller figure — keeping an older, larger one
      // under either would have the next stream's carried-over reading
      // look restarted and be counted whole, this stream's spend a
      // second time. A stream that reported nothing to decide by leaves
      // the session where it was.
      const leftAt = sessionNow();
      if (lastReading !== null && leftAt !== null) {
        carried = leftAt;
        endedOn = leftAt;
      }
      lastReading = null;
      session = ZERO;
      turnScoped = ZERO;
      goesOn = null;
    },
    sessionTotal() {
      return sessionNow();
    },
  };
}
