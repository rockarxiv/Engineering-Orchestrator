import { and, asc, desc, eq, sql } from "drizzle-orm";
import { JobEventOutcomeSchema, uuidv7, type JobEvent, type JobEventOutcome, type Uuid } from "@eo/core";
import type { Db } from "../client.js";
import { jobEvents } from "../schema.js";

/**
 * The `job_events` table (EO-332, `ARCHITECTURE.md`, "What a job records",
 * "Webhooks").
 *
 * Table access only, exactly as `jobsRepo` is. What a delivery *means* —
 * that a verified one creates an item, that one over the cap waits, that
 * one that produced nothing is said out loud on the job's thread — lives
 * in `main/jobs/webhook.ts`, because none of it is a question about this
 * table.
 *
 * **Append-only.** There is deliberately no update and no delete here,
 * the way `runEventsRepo` and the occurrence half of `jobsRepo` have
 * none, and `db/architecturalInvariants.test.ts` holds the whole tree to
 * it. A held event that is released writes a second row saying so; the
 * first goes on saying what happened when it arrived.
 */

/**
 * "…and nothing has created it since."
 *
 * The correlated half of every "what is waiting" question below. A
 * release cannot mark the held row — the table is append-only — so what
 * tells a waiting event from a released one is whether a `created` row
 * carries its key. Written as SQL rather than built with drizzle's
 * `notExists`, because it is a *correlated* subquery over the same
 * table under a second name, which is the one shape the builder has no
 * vocabulary for.
 */
const NOT_RELEASED = sql`not exists (
  select 1 from job_events as released
  where released.job_id = ${jobEvents.jobId}
    and released.event_key = ${jobEvents.eventKey}
    and released.outcome in ('created', 'refused')
)`;

function toEvent(row: typeof jobEvents.$inferSelect): JobEvent {
  return {
    id: row.id,
    jobId: row.jobId,
    receivedAt: row.receivedAt,
    eventKey: row.eventKey,
    payload: row.payload,
    // Parsed rather than cast, for `jobs.trigger`'s reason: a row
    // holding a word this version does not have is a database something
    // else wrote to, and `malformed` is the honest reading of a receipt
    // EO cannot read — it is the outcome that says "this arrived and EO
    // could not make an event of it".
    outcome: JobEventOutcomeSchema.safeParse(row.outcome).data ?? "malformed",
    reason: row.reason,
    itemId: row.itemId,
  };
}

export interface RecordJobEventInput {
  jobId: Uuid;
  /** When the door read it. A released event keeps the moment it arrived, not the moment it was let through. */
  receivedAt: number;
  eventKey: string;
  /** The raw body. Empty for an outcome that never verified it — see the column. */
  payload: string;
  outcome: JobEventOutcome;
  reason?: string | null;
  itemId?: Uuid | null;
}

/**
 * Appends one delivery. The only write this table has.
 *
 * Throws on the partial unique index when a second `created` row is
 * attempted for one event key, and that throw is the dedup: the caller
 * records a `deduplicated` row instead. A read-then-write here would be
 * a window two simultaneous deliveries fit inside.
 */
export function recordJobEvent(db: Db, input: RecordJobEventInput): JobEvent {
  const row = db
    .insert(jobEvents)
    .values({
      id: uuidv7(),
      jobId: input.jobId,
      receivedAt: input.receivedAt,
      eventKey: input.eventKey,
      payload: input.payload,
      outcome: input.outcome,
      reason: input.reason ?? null,
      itemId: input.itemId ?? null,
    })
    .returning()
    .get();
  return toEvent(row);
}

/**
 * Whether this job has already accepted this event.
 *
 * `created` or `held`: one is an item that exists and the other is an
 * item that is going to, and a sender retrying either of them is sending
 * the same event twice. A `rejected_*` or `malformed` row is not an
 * acceptance and does not stop a later, correct delivery of the same
 * event from landing.
 */
export function eventAccepted(db: Db, jobId: Uuid, eventKey: string): boolean {
  return (
    db
      .select({ id: jobEvents.id })
      .from(jobEvents)
      .where(
        and(
          eq(jobEvents.jobId, jobId),
          eq(jobEvents.eventKey, eventKey),
          sql`${jobEvents.outcome} in ('created', 'held')`,
        ),
      )
      .get() !== undefined
  );
}

/**
 * The events this job is holding, oldest first — the queue the tick
 * walks (ARCHITECTURE.md, "Controls", "The inbox, the archive and jobs").
 *
 * "Oldest first" is the whole of what "released in order" means: a burst
 * that arrived at 09:00:01 through 09:00:40 files its items in that
 * order however many hours it takes, so the tenth event is never
 * overtaken by the fortieth.
 *
 * A held row whose key has since been created is not here: that is a
 * released event, and the `created` row beside it is the record of the
 * release.
 */
export function heldEvents(db: Db, jobId: Uuid, limit?: number): JobEvent[] {
  const query = db
    .select()
    .from(jobEvents)
    .where(and(eq(jobEvents.jobId, jobId), eq(jobEvents.outcome, "held"), NOT_RELEASED))
    .orderBy(asc(jobEvents.receivedAt), asc(jobEvents.id));
  return (limit === undefined ? query.all() : query.limit(limit).all()).map(toEvent);
}

/** How many are waiting — the original design's "N waiting" beside a burst. */
export function heldEventCount(db: Db, jobId: Uuid): number {
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(jobEvents)
    .where(and(eq(jobEvents.jobId, jobId), eq(jobEvents.outcome, "held"), NOT_RELEASED))
    .get();
  return row?.n ?? 0;
}

/** Every job holding at least one event — what the tick sweeps, rather than every job there is. */
export function jobsHoldingEvents(db: Db): string[] {
  return db
    .selectDistinct({ jobId: jobEvents.jobId })
    .from(jobEvents)
    .where(and(eq(jobEvents.outcome, "held"), NOT_RELEASED))
    .all()
    .map((row) => row.jobId);
}

/** One job's deliveries, newest first — what the Events tab lists (ARCHITECTURE.md, "The inbox, the archive and jobs"). */
export function listJobEvents(db: Db, jobId: Uuid, limit?: number): JobEvent[] {
  const query = db
    .select()
    .from(jobEvents)
    .where(eq(jobEvents.jobId, jobId))
    .orderBy(desc(jobEvents.receivedAt), desc(jobEvents.id));
  return (limit === undefined ? query.all() : query.limit(limit).all()).map(toEvent);
}

/**
 * The event that created this item, as it arrived (EO-334, ARCHITECTURE.md, "What an agent is
 * given").
 *
 * What the dispatch context renders as a quoted, untrusted block. Read
 * from the record rather than from the attachment beside the item,
 * because the attachment is a file — reading it is asynchronous, it may
 * have failed to store, and a person may have removed it — while the
 * row is the delivery's own durable account and is never rewritten
 * (invariant #3). The two hold the same bytes by construction; this is
 * the one that is still there.
 *
 * Null for every item nobody sent, which is almost all of them: made by
 * a person, by an agent, or by a job on a schedule. `created` is the
 * only outcome that names an item, and the partial unique index makes
 * it at most one row — so this answers with the event or with nothing.
 */
export function webhookPayloadForItem(db: Db, itemId: Uuid): string | null {
  const row = db
    .select({ payload: jobEvents.payload })
    .from(jobEvents)
    .where(and(eq(jobEvents.itemId, itemId), eq(jobEvents.outcome, "created")))
    .get();
  return row?.payload ?? null;
}

/**
 * The newest body this job has actually received (EO-333, ARCHITECTURE.md, "The inbox, the archive
 * and jobs").
 *
 * What the Job page's field-mapping table previews against: a person
 * writing `/issue/fields/summary` reads what that pointer finds in the
 * last real delivery, rather than checking it by sending another one.
 *
 * Asked as its own query rather than read off the Events tab's rows,
 * because that list is a page and this is the newest of *all* of them —
 * a mapping table that stopped previewing once a job had a hundred
 * refused deliveries would be a table that failed exactly where it was
 * needed. The empty payload is passed over for the same reason: a row
 * whose signature was refused keeps no body, and a blank one is not a
 * document to point into.
 */
export function lastJobEventPayload(db: Db, jobId: Uuid): string | null {
  const row = db
    .select({ payload: jobEvents.payload })
    .from(jobEvents)
    .where(and(eq(jobEvents.jobId, jobId), sql`${jobEvents.payload} <> ''`))
    .orderBy(desc(jobEvents.receivedAt), desc(jobEvents.id))
    .get();
  return row?.payload ?? null;
}
