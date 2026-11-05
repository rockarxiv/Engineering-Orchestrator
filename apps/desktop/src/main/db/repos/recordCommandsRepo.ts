import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { RecordCommandSchema, type RecordCommand, type Uuid } from "@eo/core";
import type { Db } from "../client.js";
import { recordCommands } from "../schema.js";

/**
 * The queue of commands this device has made and the record has not
 * confirmed (EO-324, `ARCHITECTURE.md`, "The record").
 *
 * The rows of `record_commands` and nothing else. What a queued command
 * *means* — that the move it carries is provisional, that the card
 * wears the word *queued*, that the record may refuse it and the person
 * be told — is the record's, in `record/remoteRecord.ts` and
 * `record/drain.ts`.
 *
 * Every read here is ordered by id, which is a UUIDv7 and so is the
 * moment the command was made. That is load-bearing rather than tidy:
 * the original design says "on reconnect the queue replays in order", and a comment
 * that arrives after the move it was correcting is a different history
 * from the one the person wrote.
 */

export interface QueuedCommand {
  id: Uuid;
  kind: RecordCommand["kind"];
  itemId: Uuid;
  command: RecordCommand;
  createdAt: number;
  attempts: number;
  lastError: string | null;
}

/**
 * A row, back as the command it holds.
 *
 * Parsed rather than cast, because the column is JSON this process
 * wrote and a process of a *different version* may have written: a
 * desktop that queued commands offline and was then updated comes back
 * to a queue written by the version before it. A row that no longer
 * parses is not silently sent as whatever shape it happens to have; the
 * drain drops it and says so, which is the only honest answer to "this
 * is a command I cannot read".
 */
function toDomain(row: typeof recordCommands.$inferSelect): QueuedCommand | null {
  const parsed = RecordCommandSchema.safeParse(row.payload);
  if (!parsed.success) return null;
  return {
    id: row.id as Uuid,
    kind: parsed.data.kind,
    itemId: row.itemId as Uuid,
    command: parsed.data,
    createdAt: row.createdAt,
    attempts: row.attempts,
    lastError: row.lastError,
  };
}

/**
 * Writes a command down, durably, the moment it is made.
 *
 * Before anything is sent and whether or not anything can be: that
 * ordering is the whole of "offline never stops a person from working".
 * The command is a fact about what this device did, and it survives the
 * process that made it.
 *
 * The id is the command's own — `RecordCommand.id` — so that the row,
 * the thing on the wire and the record's acknowledgement are all one
 * identity. Re-queuing the same command is a no-op rather than a second
 * row, which is what makes a retry that raced an acknowledgement safe.
 */
export function enqueueCommand(db: Db, command: RecordCommand, itemId: Uuid, now: number): void {
  db.insert(recordCommands)
    .values({ id: command.id, kind: command.kind, itemId, payload: command, createdAt: now, attempts: 0 })
    .onConflictDoNothing()
    .run();
}

/**
 * Queues where a watch now stands, in place of any earlier report about
 * the same item that has not gone yet (EO-456).
 *
 * A watch command is a whole row rather than a change to one, so only
 * the latest says anything: a desktop offline for a day of five-minute
 * checks owes the record one watch, not three hundred.
 */
export function enqueueWatchCommand(db: Db, command: Extract<RecordCommand, { kind: "watch" }>, itemId: Uuid, now: number): void {
  db.transaction((tx) => {
    for (const row of tx.select().from(recordCommands).where(and(eq(recordCommands.itemId, itemId), eq(recordCommands.kind, "watch"))).all()) {
      const queued = RecordCommandSchema.safeParse(row.payload);
      if (queued.success && queued.data.kind === "watch" && queued.data.stepId === command.stepId) tx.delete(recordCommands).where(eq(recordCommands.id, row.id)).run();
    }
    tx.insert(recordCommands).values({ id: command.id, kind: command.kind, itemId, payload: command, createdAt: now, attempts: 0 }).onConflictDoNothing().run();
  });
}

/**
 * Whether this device has a report about this watch it has not handed to
 * the record yet (EO-456).
 *
 * What a replica asks before taking the record's copy of a watch over
 * its own: until the record has heard the latest check, its row is the
 * older of the two, and writing it over this one would undo a check
 * this machine ran. Once the report has gone, the record's row is the
 * truth — whichever device's clock is ahead.
 */
export function hasQueuedWatch(db: Db, itemId: Uuid, stepId: string): boolean {
  return db
    .select()
    .from(recordCommands)
    .where(and(eq(recordCommands.itemId, itemId), eq(recordCommands.kind, "watch")))
    .all()
    .some((row) => {
      const queued = RecordCommandSchema.safeParse(row.payload);
      return queued.success && queued.data.kind === "watch" && queued.data.stepId === stepId;
    });
}

/** The next commands to replay, oldest first. */
export function pendingCommands(db: Db, limit = 200): QueuedCommand[] {
  return db
    .select()
    .from(recordCommands)
    .orderBy(asc(recordCommands.id))
    .limit(limit)
    .all()
    .map(toDomain)
    .filter((entry): entry is QueuedCommand => entry !== null);
}

/**
 * The commands the drain could not read at all.
 *
 * Separated from `pendingCommands` rather than mixed into it, because
 * they need opposite treatment: a readable command is replayed, and an
 * unreadable one can only be dropped with a sentence. Keeping them in
 * one list would mean either sending garbage or silently stalling the
 * queue behind it — and a queue that stops draining because of one bad
 * row is every later command lost too.
 */
export function unreadableCommandIds(db: Db, limit = 200): string[] {
  return db
    .select()
    .from(recordCommands)
    .orderBy(asc(recordCommands.id))
    .limit(limit)
    .all()
    .filter((row) => !RecordCommandSchema.safeParse(row.payload).success)
    .map((row) => row.id);
}

/**
 * The item a command is about, even when the command itself is
 * unreadable.
 *
 * The one field of a row that survives a payload this version cannot
 * parse, which is exactly why it is a column rather than something dug
 * out of the JSON: a command that has to be dropped still has to be
 * *said* somewhere (invariant #8), and saying it needs a thread.
 */
export function itemOfCommand(db: Db, id: string): Uuid | null {
  const row = db.select({ itemId: recordCommands.itemId }).from(recordCommands).where(eq(recordCommands.id, id)).get();
  return row === undefined ? null : (row.itemId as Uuid);
}

/**
 * Takes commands off the queue, because the record has answered them.
 *
 * Answered, not accepted: a move the record refused as superseded is as
 * finished as one it applied. What is left behind is only what nobody
 * has heard about yet.
 */
export function forgetCommands(db: Db, ids: readonly string[]): void {
  if (ids.length === 0) return;
  db.delete(recordCommands).where(inArray(recordCommands.id, [...ids])).run();
}

/**
 * Records that a send failed, so the count and the reason are visible.
 *
 * Nothing is dropped on a failure. A command that cannot be delivered
 * is the ordinary state of an offline desktop, and giving up on it
 * would be throwing away the work the design promises to keep. The attempt
 * count is what lets the sync line say how long this has been going on;
 * see `outbox/drain.ts` for the other queue in this app, which *does*
 * give up, and why the trade is different there — a Jira that is behind
 * inconveniences somebody, where a dropped transition loses work.
 */
export function recordSendFailure(db: Db, ids: readonly string[], error: string): void {
  if (ids.length === 0) return;
  db.update(recordCommands)
    .set({ attempts: sql`${recordCommands.attempts} + 1`, lastError: error })
    .where(inArray(recordCommands.id, [...ids]))
    .run();
}

/** How many commands are waiting. */
export function queuedCommandCount(db: Db): number {
  return db.select({ n: sql<number>`count(*)` }).from(recordCommands).get()?.n ?? 0;
}

/**
 * The items with a *move* still waiting.
 *
 * Only transitions, which is the point: a comment in the queue is
 * something that has been said and will reach the record, and drawing a
 * card as provisional for it would be saying the item might not be
 * where it looks. A queued transition is precisely the thing that might
 * not survive, so it is precisely the thing the dashed card is about
 * (the original design: "an offline Approve is provisional —
 * dashed card, queued · offline since 09:12").
 *
 * …and claims and assignments, since EO-367, for the same reason: the
 * name on the card is shown before the record has answered, a claim may
 * lose to somebody else's, and either may be refused — so it is a guess
 * until the record says otherwise.
 */
export function itemsWithQueuedMoves(db: Db): string[] {
  return db
    .selectDistinct({ itemId: recordCommands.itemId })
    .from(recordCommands)
    .where(inArray(recordCommands.kind, ["transition", "claim", "assign", "takeover"]))
    .all()
    .map((row) => row.itemId);
}

/**
 * Whether who holds this item is still a question waiting on the record
 * (EO-368): a claim, an assignment or a takeover queued here and not yet
 * answered.
 *
 * The holder shown meanwhile is what this machine *asked for*, and it may
 * be refused. So it authorises nothing the record will not see — an edit
 * to the item's own text is the case, because that never travels and a
 * refusal of the claim could not undo it.
 */
export function holdingIsProvisional(db: Db, itemId: string): boolean {
  return (
    db
      .select({ id: recordCommands.id })
      .from(recordCommands)
      .where(and(eq(recordCommands.itemId, itemId), inArray(recordCommands.kind, ["claim", "assign", "takeover"])))
      .get() !== undefined
  );
}
