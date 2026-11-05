import { and, asc, count, desc, eq, gt, gte, isNull, sql } from "drizzle-orm";
import { onProject } from "./projectScope.js";
import {
  REVIEW_VERDICT_EVENT,
  SEARCH_INTERCEPTION_EVENT,
  type RecordEventCursor,
  type RunEvent,
  type ReviewVerdictEvent,
  type Uuid,
} from "@eo/core";
import type { Db } from "../client.js";
import { runEvents, runs, items } from "../schema.js";

function toDomain(row: typeof runEvents.$inferSelect): RunEvent {
  return {
    runId: row.runId as Uuid,
    seq: row.seq,
    ts: row.ts,
    type: row.type,
    payload: row.payload,
  };
}

/** Append-only (ARCHITECTURE.md, "`run_events` is the durability substrate") — there is deliberately no update/delete here. */
export function listRunEvents(db: Db, runId: Uuid): RunEvent[] {
  return db.select().from(runEvents).where(eq(runEvents.runId, runId)).orderBy(asc(runEvents.seq)).all().map(toDomain);
}

/**
 * One row, appended without a buffer (EO-176).
 *
 * `createRunEventBuffer` is how a *stream* writes: it allocates `seq` in
 * memory, one counter per run, because a chatty agent produces thousands
 * of events and a query per row would thrash the disk. This is for the
 * one writer that is not a stream — a person's message, arriving from
 * the IPC side against a run whose stream does not exist yet or does not
 * exist any more.
 *
 * **Safe only when nothing is buffering that run, and the caller has to
 * know that.** Two allocators over one run hand out the same number
 * twice: this one reads `max(seq)` from what is *persisted*, and a
 * buffer's unflushed rows are not. `steerRun` is the only caller and
 * chooses between the two by asking whether the run has a live buffer —
 * the check and the write are in the same synchronous breath, which is
 * what makes the choice sound.
 *
 * The read and the insert are one transaction so that two of these
 * cannot both read the same maximum.
 */
export function appendRunEvent(db: Db, runId: Uuid, type: string, payload: unknown): void {
  db.transaction((tx) => {
    const row = tx
      .select({ maxSeq: sql<number | null>`max(${runEvents.seq})` })
      .from(runEvents)
      .where(eq(runEvents.runId, runId))
      .get();
    tx.insert(runEvents).values({ runId, seq: (row?.maxSeq ?? -1) + 1, ts: Date.now(), type, payload }).run();
  });
}

/**
 * One line on a run more than one device can write (EO-618), given the
 * number to start from.
 *
 * `appendRunEvent` counts on from the local maximum, which is only safe on
 * a run one device writes. A watch's quiet run is carried on by whichever
 * device the record leases the item to next, and that device may hold
 * only part of what the last one wrote. Counting on would hand out a
 * number already taken, and on the record `appendSyncedRunEvents` keeps
 * the row that got there first, so this line would be gone with nothing
 * to say so.
 *
 * So the caller names `seq`: the time of the lease (`recordQuietCheck`),
 * which the record's clock gives, so it depends on no device's clock or
 * history and is new with every grant. It goes past the local maximum all
 * the same, for a second line under one lease, and because the sync
 * bookmark only moves forward and a line behind it would never be sent.
 * So `seq` has gaps here, which every reader allows: they page on the last
 * `seq` they saw.
 */
export function appendRunEventAt(db: Db, runId: Uuid, at: { seq: number; ts: number }, type: string, payload: unknown): void {
  db.transaction((tx) => {
    const row = tx
      .select({ maxSeq: sql<number | null>`max(${runEvents.seq})` })
      .from(runEvents)
      .where(eq(runEvents.runId, runId))
      .get();
    tx.insert(runEvents).values({ runId, seq: Math.max(at.seq, (row?.maxSeq ?? -1) + 1), ts: at.ts, type, payload }).run();
  });
}

/** Where a line stands in the record's feed. The expression `idx_run_events_feed` is over, so it is written once. */
const feedPosition = sql<number>`coalesce(${runEvents.arrival}, ${runEvents.ts})`;

/**
 * Run events as they arrive from another machine (EO-324,
 * the original design: "run_events sync append-only by
 * run and sequence with the device as author").
 *
 * The one writer of this table that does **not** allocate `seq`. It is
 * given one, and that is the whole design: the device that ran the
 * agent numbered its own events as it wrote them, and a record that
 * renumbered them would be inventing an order — two devices reporting
 * into one record would interleave, and the transcript of a run would
 * no longer be the transcript of that run.
 *
 * `(runId, seq)` is already the primary key, so idempotence costs
 * nothing: `onConflictDoNothing` means a batch that half landed before
 * the socket dropped can simply be sent again. That is what makes
 * "every run event in order" survive a reconnect — the device keeps
 * sending from where it believes it got to, and anything it repeats is
 * ignored rather than doubled.
 *
 * An insert only. Invariant #3 is not bent here and cannot be: a row
 * that is already there wins, so nothing this function does can change
 * what the record says happened.
 *
 * Each batch takes one `arrival`, past every position already taken,
 * whatever the clocks say: that is what puts a line behind a reader's
 * cursor when it arrives late, and so what gets it delivered
 * (`listRunEventsSince`). Stamped by the insert and never again.
 *
 * Returns how many rows were new, so a caller can say what it added
 * without asking a second question.
 */
export function appendSyncedRunEvents(
  db: Db,
  runId: Uuid,
  deviceId: string,
  events: readonly { seq: number; ts: number; type: string; payload: unknown }[],
): number {
  if (events.length === 0) return 0;
  return db.transaction((tx) => {
    const head = tx.select({ position: feedPosition }).from(runEvents).orderBy(desc(feedPosition)).limit(1).get()?.position ?? -1;
    const arrival = Math.max(Date.now(), head + 1);
    let appended = 0;
    for (const event of events) {
      const row = tx
        .insert(runEvents)
        .values({ runId, seq: event.seq, ts: event.ts, type: event.type, payload: event.payload, deviceId, arrival })
        .onConflictDoNothing()
        .returning()
        .get();
      if (row !== undefined) appended += 1;
    }
    return appended;
  });
}

/**
 * This run's events from a sequence on, for shipping them to the record.
 *
 * `fromSeq` is inclusive, matching `runs:listEvents` — the contract
 * already argued that case, and two cursors over one table that
 * disagreed about their own boundary would be a bug nobody could see
 * in either one alone.
 *
 * Ordered by `seq` rather than by `ts`, because `ts` is a clock and
 * `seq` is the order: a chatty agent writes several events inside one
 * millisecond, and what the record has to reproduce is the sequence the
 * device wrote, not the resolution of its clock.
 */
export function listRunEventsFrom(db: Db, runId: Uuid, fromSeq: number, limit: number): RunEvent[] {
  return db
    .select()
    .from(runEvents)
    .where(and(eq(runEvents.runId, runId), gte(runEvents.seq, fromSeq)))
    .orderBy(asc(runEvents.seq))
    .limit(limit)
    .all()
    .map(toDomain);
}

/**
 * The record's transcripts after a point, oldest first (EO-324,
 * invariant #3).
 *
 * The run-events half of `record:changes`, and the reason a second
 * desktop can read what an agent on somebody else's machine actually
 * did rather than only that it finished.
 *
 * Across every run at once, ordered by `(position, runId, seq)`, because a
 * device reads *time* forwards rather than run by run: a laptop that
 * has been shut for an hour wants the hour, not the first run's
 * thousand lines before it hears about the second run at all.
 *
 * The position is when the line got here rather than when it was written
 * (EO-618): `arrival` where it came from another machine, or its `ts`. A
 * line that reaches the record after a reader's cursor passed the moment it
 * was written still lands past that cursor, so nothing is skipped however
 * late it comes or however the clocks disagree. `ts` is still handed back
 * as the line's own.
 *
 * The cursor carries all three, and `seq` as a number — see
 * `RecordEventCursorSchema` for what happened when it did not.
 */
/**
 * `within` scopes the page to one project — see `onProject` (EO-325).
 */
export function listRunEventsSince(
  db: Db,
  cursor: RecordEventCursor,
  limit: number,
  within?: string,
): { runId: Uuid; deviceId: string | null; seq: number; ts: number; position: number; type: string; payload: unknown }[] {
  return db
    .select({ runId: runEvents.runId, deviceId: runEvents.deviceId, seq: runEvents.seq, ts: runEvents.ts, position: feedPosition, type: runEvents.type, payload: runEvents.payload })
    .from(runEvents)
    // Strictly after `(position, runId, seq)`, compared exactly as the
    // `ORDER BY` below orders them — which is the whole requirement of
    // a keyset cursor and the one thing that was wrong here. `seq` is a
    // number and is compared as one; folding it into a string made
    // `"…:10" > "…:9"` false, and a page that ended at sequence 9
    // inside one millisecond skipped ten to nineteen for ever.
    .where(
      and(
        sql`(${feedPosition} > ${cursor.ts}
           or (${feedPosition} = ${cursor.ts}
               and (${runEvents.runId} > ${cursor.runId}
                    or (${runEvents.runId} = ${cursor.runId} and ${runEvents.seq} > ${cursor.seq}))))`,
        within === undefined
          ? undefined
          : sql`${runEvents.runId} in (select ${runs.id} from ${runs} where ${onProject(runs.itemId, within)})`,
      ),
    )
    .orderBy(asc(feedPosition), asc(runEvents.runId), asc(runEvents.seq))
    .limit(limit)
    .all()
    .map((row) => ({ ...row, runId: row.runId as Uuid }));
}

/**
 * This run's events after a sequence, oldest first (EO-552).
 *
 * Exclusive, unlike `listRunEventsFrom`: what a reader that already
 * holds every event up to `afterSeq` asks for, so a chat drawn on every
 * push while its turn streams reads what arrived since rather than the
 * whole run again. `-1` is the whole run.
 */
export function listRunEventsAfter(db: Db, runId: Uuid, afterSeq: number): RunEvent[] {
  return db
    .select()
    .from(runEvents)
    .where(and(eq(runEvents.runId, runId), gt(runEvents.seq, afterSeq)))
    .orderBy(asc(runEvents.seq))
    .all()
    .map(toDomain);
}

/**
 * Whether this device wrote a line of this run past a bookmark: one the
 * record has not had (EO-618). A device's own lines carry no device id;
 * `appendSyncedRunEvents` always gives a mirrored line one.
 */
export function hasOwnRunEventsAfter(db: Db, runId: Uuid, afterSeq: number): boolean {
  return (
    db
      .select({ seq: runEvents.seq })
      .from(runEvents)
      .where(and(eq(runEvents.runId, runId), gt(runEvents.seq, afterSeq), isNull(runEvents.deviceId)))
      .limit(1)
      .get() !== undefined
  );
}

/** How far this run's log goes, or -1 when it has none. The cursor a sender starts from. */
export function highestRunEventSeq(db: Db, runId: Uuid): number {
  const row = db
    .select({ maxSeq: sql<number | null>`max(${runEvents.seq})` })
    .from(runEvents)
    .where(eq(runEvents.runId, runId))
    .get();
  return row?.maxSeq ?? -1;
}

/**
 * How many times this run's agent was redirected (EO-168).
 *
 * One query over the log EO already keeps, and written down here rather
 * than reconstructed at each call site, because the measurement it
 * serves is a comparison across runs and a count assembled two slightly
 * different ways is not one.
 *
 * The number it returns is the distinction the log could not previously
 * draw. Zero means the interception never fired on this run — the
 * matcher missed, the vocabulary was absent, the feature was off, the
 * backend has no hook to carry it — which is a wiring problem. A
 * positive count beside a run that went on searching the tree is a
 * persuasion problem. Before this the evidence for both was the same
 * pile of shell calls.
 *
 * It counts rather than reads: a run that intercepted forty times is
 * forty rows, and nothing here needs their payloads to say how many.
 * `listRunEvents` is the way to read what was actually suggested.
 *
 * SQL for whoever is measuring outside the app — the same count, and
 * `scripts/interception-audit.mts` runs exactly this:
 *
 *     SELECT COUNT(*) FROM run_events
 *      WHERE run_id = ? AND type = 'search_interception'
 */
export function countSearchInterceptions(db: Db, runId: Uuid): number {
  const row = db
    .select({ interceptions: count() })
    .from(runEvents)
    .where(and(eq(runEvents.runId, runId), eq(runEvents.type, SEARCH_INTERCEPTION_EVENT)))
    .get();
  return row?.interceptions ?? 0;
}

/** A JSON column is `unknown` until something narrows it. Nothing is cast here. */
function asReviewVerdict(payload: unknown): ReviewVerdictEvent | null {
  if (typeof payload !== "object" || payload === null) return null;
  const row = payload as Record<string, unknown>;
  const verdict = row["verdict"];
  if (verdict !== "approve" && verdict !== "reject" && verdict !== "needs_user_input") return null;
  const number = (key: string): number => (typeof row[key] === "number" ? (row[key] as number) : 0);
  return {
    verdict,
    blockingIssues: number("blockingIssues"),
    declaredCriteria: number("declaredCriteria"),
    met: number("met"),
    notMet: number("notMet"),
    notAssessed: number("notAssessed"),
    notReported: number("notReported"),
    unexamined: number("unexamined"),
  };
}

/**
 * Every review verdict this item has collected, oldest first (EO-200).
 *
 * The reading half of `REVIEW_VERDICT_EVENT`, and the reason that row
 * exists: issues-per-rejection is `blockingIssues` across what this
 * returns, and rounds-per-item is its length. `reviewer.md` quoted a
 * share of single-issue rejections that nothing could recompute, so the
 * prompt went on asserting it long after anyone could say whether it was
 * still true — this is what makes the next such claim checkable.
 *
 * Joined through `runs` rather than filtered on an item column, because
 * `run_events` has no item: it belongs to a run, and the run belongs
 * to the item. Ordered by `ts` and then `seq` so two verdicts written
 * in the same millisecond still come back in the order they happened.
 *
 * Rows written before this event existed are simply absent, which is
 * what an append-only log does with history it never recorded (invariant
 * #3 — nothing is backfilled by rewriting it). `scripts/review-census.mts`
 * is the tool that reads those older reviews, out of the raw `result`
 * rows, and it says so where it does.
 *
 * SQL for whoever is measuring from outside the app:
 *
 *     SELECT e.payload FROM run_events e
 *       JOIN runs r ON r.id = e.run_id
 *      WHERE r.item_id = ? AND e.type = 'review_verdict'
 *      ORDER BY e.ts, e.seq
 */
export function listReviewVerdicts(db: Db, itemId: Uuid): ReviewVerdictEvent[] {
  return db
    .select({ payload: runEvents.payload })
    .from(runEvents)
    .innerJoin(runs, eq(runs.id, runEvents.runId))
    .where(and(eq(runs.itemId, itemId), eq(runEvents.type, REVIEW_VERDICT_EVENT)))
    .orderBy(asc(runEvents.ts), asc(runEvents.seq))
    .all()
    .map((row) => asReviewVerdict(row.payload))
    .filter((verdict): verdict is ReviewVerdictEvent => verdict !== null);
}

/**
 * Every review verdict this installation has recorded, grouped by item
 * (EO-200).
 *
 * The installation-wide half of `listReviewVerdicts`, and what makes the
 * last of EO-200's acceptance criteria answerable without a person
 * remembering to run anything: the share of rejections carrying exactly
 * one blocking issue is a population statistic, so it needs the
 * population.
 *
 * Grouped here rather than by the caller because the grouping *is* the
 * measurement — rounds-per-item cannot be recovered from a flat list —
 * and `reviewCensus` takes the shape this returns.
 *
 * Only items with at least one recorded verdict appear, which is the
 * same thing as "only reviews that happened after this shipped". Older
 * reviews left no such row and are not invented here; the census script
 * is where they are replayed out of raw provider payloads, and it says
 * so.
 *
 * SQL for whoever is measuring from outside the app:
 *
 *     SELECT t.key, e.payload FROM run_events e
 *       JOIN runs r ON r.id = e.run_id
 *       JOIN items t ON t.id = r.item_id
 *      WHERE e.type = 'review_verdict'
 *      ORDER BY e.ts, e.seq
 */
export function listReviewVerdictsByItem(db: Db): { item: string; reviews: ReviewVerdictEvent[] }[] {
  const rows = db
    .select({ key: items.key, itemId: runs.itemId, payload: runEvents.payload })
    .from(runEvents)
    .innerJoin(runs, eq(runs.id, runEvents.runId))
    .innerJoin(items, eq(items.id, runs.itemId))
    .where(eq(runEvents.type, REVIEW_VERDICT_EVENT))
    .orderBy(asc(runEvents.ts), asc(runEvents.seq))
    .all();

  const grouped = new Map<string, { item: string; reviews: ReviewVerdictEvent[] }>();
  for (const row of rows) {
    const verdict = asReviewVerdict(row.payload);
    if (!verdict) continue;
    // Grouped on the id rather than the key. `items.key` is unique
    // today, so the two agree — but the id is the identity and the key
    // is a label, and a census that grouped on the label would silently
    // merge two items into one with twice the rounds if that ever
    // stopped being true.
    const entry = grouped.get(row.itemId) ?? { item: row.key, reviews: [] };
    entry.reviews.push(verdict);
    grouped.set(row.itemId, entry);
  }
  return [...grouped.values()];
}

/** What one run did, counted, for the line a chat folds a finished turn behind. */
export interface RunActivityCount {
  toolCalls: number;
  filesEdited: number;
  reasoned: boolean;
}

/**
 * Counts, per run, of what a person scans a finished turn for: tool calls,
 * the files it edited (distinct), and whether it reasoned (EO's chat fold,
 * ARCHITECTURE.md, "The transcript").
 *
 * One grouped query for every run a conversation holds, rather than a read
 * of each run's whole transcript: a long chat is many runs of many events,
 * and the line needs three numbers from each. The answer tool is not a
 * tool call a person made the agent do, so it is not counted — the same
 * rule `turnStepsOf` applies.
 */
export function countRunActivity(db: Db, runIds: readonly Uuid[]): Map<string, RunActivityCount> {
  const counts = new Map<string, RunActivityCount>();
  if (runIds.length === 0) return counts;
  const rows = db
    .select({
      runId: runEvents.runId,
      toolCalls: sql<number>`sum(case when ${runEvents.type} = 'tool_call' and coalesce(json_extract(${runEvents.payload}, '$.name'), '') <> 'StructuredOutput' then 1 else 0 end)`,
      filesEdited: sql<number>`count(distinct case when ${runEvents.type} = 'file_edit' then json_extract(${runEvents.payload}, '$.path') end)`,
      reasoned: sql<number>`sum(case when ${runEvents.type} = 'reasoning' then 1 else 0 end)`,
    })
    .from(runEvents)
    .where(sql`${runEvents.runId} in (${sql.join(runIds.map((id) => sql`${id}`), sql`, `)})`)
    .groupBy(runEvents.runId)
    .all();
  for (const row of rows) {
    counts.set(row.runId, { toolCalls: Number(row.toolCalls ?? 0), filesEdited: Number(row.filesEdited ?? 0), reasoned: Number(row.reasoned ?? 0) > 0 });
  }
  return counts;
}


/**
 * Which devices wrote a run's transcript, as the record holds it
 * (EO-482): the record's account of which machine a run happened on,
 * since a run row carries no device of its own. Read only.
 */
export function runEventDevices(db: Db, runId: Uuid): Set<string> {
  return new Set(
    db
      .selectDistinct({ deviceId: runEvents.deviceId })
      .from(runEvents)
      .where(eq(runEvents.runId, runId))
      .all()
      .flatMap((row) => (row.deviceId === null ? [] : [row.deviceId])),
  );
}
