import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import {
  HANDLED_MESSAGE_RETENTION_MS,
  HANDLED_BY_PERSON,
  HANDLED_MESSAGES_KEPT_PER_PERSON,
  MessageHandledBySchema,
  MessageHandledHowSchema,
  MessageSendSchema,
  parseStoredCommentOptions,
  uuidv7,
  type Message,
  type MessageHandledBy,
  type MessageHandledHow,
  type MessageSend,
} from "@eo/core";
import type { Db } from "../client.js";
import { jobs, messages, projects, queuedMessageReceipts } from "../schema.js";

/**
 * What EO asks a person outside any item (EO-725, ARCHITECTURE.md §7.1).
 *
 * The one module that writes `messages`. Sending, handling and sweeping
 * are here; what a sender says, and telling the windows, is
 * `messages/messages.ts`'s.
 */

type Row = typeof messages.$inferSelect;

/**
 * Who handled it (EO-918). A message answered or dismissed before the
 * column existed, or by a build that does not write it, was the person's:
 * nobody else could. One EO resolved, or still open, has nobody.
 */
function handledByOf(row: Row, handledHow: MessageHandledHow | null): MessageHandledBy | null {
  if (handledHow !== "answered" && handledHow !== "dismissed") return null;
  const recorded = MessageHandledBySchema.safeParse(row.handledBy);
  return recorded.success ? recorded.data : HANDLED_BY_PERSON;
}

function toDomain(row: Row): Message {
  const parsedHow = MessageHandledHowSchema.safeParse(row.handledHow);
  const handledHow = parsedHow.success ? parsedHow.data : null;
  return {
    id: row.id,
    recipientId: row.recipientId,
    projectId: row.projectId,
    jobId: row.jobId,
    source: row.source,
    body: row.body,
    // Read back without trusting it, as a comment's are: an option a later
    // build wrote and this one does not know is dropped, not the message.
    options: parseStoredCommentOptions(row.options),
    createdAt: row.createdAt,
    handledAt: row.handledAt,
    handledHow,
    answer: row.answer,
    handledBy: handledByOf(row, handledHow),
  };
}

/** Writes one open message. Throws on a malformed one — a sender is EO's own code, so that is a programmer error. */
/** `id` is minted here unless the sender minted it — a queued command's message, written once whatever the replays (EO-729). */
export function insertMessage(db: Db, input: MessageSend, now: number = Date.now(), id: string = uuidv7()): Message {
  const parsed = MessageSendSchema.parse(input);
  const row: Row = {
    id,
    recipientId: parsed.recipientId,
    projectId: parsed.projectId ?? null,
    jobId: parsed.jobId ?? null,
    source: parsed.source,
    body: parsed.body,
    options: parsed.options ?? null,
    createdAt: now,
    handledAt: null,
    handledHow: null,
    answer: null,
    handledBy: null,
    subject: parsed.subject ?? null,
    fromRecord: false,
  };
  db.insert(messages).values(row).run();
  return toDomain(row);
}

export function getMessage(db: Db, id: string): Message | undefined {
  const row = db.select().from(messages).where(eq(messages.id, id)).get();
  return row ? toDomain(row) : undefined;
}

/** Every open message addressed to any of these people, newest first. */
export function listOpenMessages(db: Db, recipientIds: readonly string[]): Message[] {
  if (recipientIds.length === 0) return [];
  return db
    .select()
    .from(messages)
    .where(and(inArray(messages.recipientId, [...recipientIds]), isNull(messages.handledAt)))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .all()
    .map(toDomain);
}

/**
 * The most recently handled messages addressed to any of these people,
 * newest handled first (EO-918). Given a project, only those about it and
 * those about none, as the inbox scopes its open ones.
 */
export function listRecentlyHandledMessages(db: Db, recipientIds: readonly string[], limit: number, projectId?: string | null): Message[] {
  if (recipientIds.length === 0) return [];
  const inProject = projectId === undefined ? undefined : projectId === null ? isNull(messages.projectId) : or(isNull(messages.projectId), eq(messages.projectId, projectId));
  return db
    .select()
    .from(messages)
    .where(and(inArray(messages.recipientId, [...recipientIds]), isNotNull(messages.handledAt), inProject))
    .orderBy(desc(messages.handledAt), desc(messages.id))
    .limit(limit)
    .all()
    .map(toDomain);
}

/**
 * Closes an open message: `answered` with the option chosen, `dismissed`,
 * or `resolved` by EO. `by` is who answered or dismissed it (EO-918) —
 * the person unless said otherwise; a resolution is EO's and records
 * nobody.
 *
 * Only an open one. Answers undefined when the message is gone or was
 * already handled, so a second press — or EO resolving what a person has
 * just dismissed — changes nothing and says so.
 */
export function markMessageHandled(
  db: Db,
  id: string,
  how: MessageHandledHow,
  answer: string | null = null,
  now: number = Date.now(),
  by: MessageHandledBy = HANDLED_BY_PERSON,
): Message | undefined {
  const row = db
    .update(messages)
    .set({ handledAt: now, handledHow: how, answer: how === "answered" ? answer : null, handledBy: how === "resolved" ? null : by })
    .where(and(eq(messages.id, id), isNull(messages.handledAt)))
    .returning()
    .get();
  return row ? toDomain(row) : undefined;
}

/**
 * Rewrites what an open message says (EO-798): the thing it is about
 * changed while it was still waiting on somebody, and a second message
 * would say the same thing twice. Only an open one, as handling is.
 *
 * Its sending time moves to `now`. While a message is open that is its
 * change time (`messageChangedAt`), which is what `record:messages` pages
 * on, so a copy anywhere hears of the revision the way it heard of the
 * message, and the inbox shows it as what EO says now. Answers undefined
 * when the message is gone or already handled.
 */
export function reviseOpenMessage(
  db: Db,
  id: string,
  revision: Pick<MessageSend, "body" | "options">,
  now: number = Date.now(),
): Message | undefined {
  const body = MessageSendSchema.shape.body.parse(revision.body);
  // Options left out are options kept; null takes them away.
  const options = revision.options === undefined ? {} : { options: MessageSendSchema.shape.options.parse(revision.options) ?? null };
  const row = db
    .update(messages)
    .set({ body, ...options, createdAt: now })
    .where(and(eq(messages.id, id), isNull(messages.handledAt)))
    .returning()
    .get();
  return row ? toDomain(row) : undefined;
}

/**
 * Whether this database holds any message of a source about one subject,
 * handled or not (EO-735) — what a sender that runs on every launch asks
 * so a person is told once rather than at every start.
 */
export function hasMessageAbout(db: Db, source: string, subject: string): boolean {
  return db.select({ id: messages.id }).from(messages).where(and(eq(messages.source, source), eq(messages.subject, subject))).get() !== undefined;
}

/**
 * The open message of a source about one subject, if there is one
 * (EO-796): what a sender asks so it says a thing once while it is still
 * waiting on somebody, rather than once per occurrence.
 */
export function openMessageAbout(db: Db, source: string, subject: string): Message | undefined {
  const row = db
    .select()
    .from(messages)
    .where(and(eq(messages.source, source), eq(messages.subject, subject), isNull(messages.handledAt)))
    .orderBy(asc(messages.createdAt), asc(messages.id))
    .get();
  return row ? toDomain(row) : undefined;
}

/** What one message is about within its source (`MessageSend.subject`), or null: what an answer's handler reads (EO-877). */
export function messageSubjectOf(db: Db, id: string): string | null {
  return db.select({ subject: messages.subject }).from(messages).where(eq(messages.id, id)).get()?.subject ?? null;
}

/** The subjects of every open message of a source (EO-877): what a sender that settles its own messages walks. */
export function openSubjectsOf(db: Db, source: string): string[] {
  return db
    .selectDistinct({ subject: messages.subject })
    .from(messages)
    .where(and(eq(messages.source, source), isNull(messages.handledAt), isNotNull(messages.subject)))
    .all()
    .flatMap((row) => (row.subject === null ? [] : [row.subject]));
}

/**
 * Resolves every open message of a source about one subject (EO-727):
 * what they asked about was settled some other way. Answers those it
 * closed; one already handled is left as it was.
 */
export function markMessagesAboutResolved(db: Db, source: string, subject: string, now: number = Date.now()): Message[] {
  return db
    .update(messages)
    .set({ handledAt: now, handledHow: "resolved", answer: null, handledBy: null })
    .where(and(eq(messages.source, source), eq(messages.subject, subject), isNull(messages.handledAt)))
    .returning()
    .all()
    .map(toDomain);
}

/**
 * The retention sweep (EO-725): a handled message is deleted 7 days
 * after it was handled, and each person keeps at most 100 handled ones,
 * the oldest handled going first. An open message is never deleted here,
 * however old — it is still waiting on somebody.
 *
 * Answers how many it deleted.
 */
export function sweepHandledMessages(db: Db, now: number = Date.now()): number {
  return db.transaction((tx) => {
    const expired = tx
      .delete(messages)
      .where(and(isNotNull(messages.handledAt), lte(messages.handledAt, now - HANDLED_MESSAGE_RETENTION_MS)))
      .run().changes;
    const overCap = tx.run(sql`
      DELETE FROM ${messages} WHERE ${messages.id} IN (
        SELECT id FROM (
          SELECT ${messages.id} AS id,
                 ROW_NUMBER() OVER (PARTITION BY ${messages.recipientId} ORDER BY ${messages.handledAt} DESC, ${messages.id} DESC) AS kept
          FROM ${messages}
          WHERE ${messages.handledAt} IS NOT NULL
        ) WHERE kept > ${HANDLED_MESSAGES_KEPT_PER_PERSON}
      )`).changes;
    return expired + overCap;
  });
}

/**
 * When a message last changed: when it was handled, or when it was sent
 * while it is open. What `record:messages` pages on (EO-726).
 */
export function messageChangedAt(message: Pick<Message, "createdAt" | "handledAt">): number {
  return message.handledAt ?? message.createdAt;
}

/**
 * One person's messages changed strictly after the cursor, oldest change
 * first — the record's half of `record:messages` (EO-726). Ordered by
 * `(changed, id)` and asked for strictly after the pair, as every list
 * the record pages is.
 */
export function listMessagesChangedSince(db: Db, recipientId: string, cursor: { ts: number; id: string }, limit: number): Message[] {
  const changed = sql`coalesce(${messages.handledAt}, ${messages.createdAt})`;
  return db
    .select()
    .from(messages)
    .where(and(eq(messages.recipientId, recipientId), sql`(${changed} > ${cursor.ts} OR (${changed} = ${cursor.ts} AND ${messages.id} > ${cursor.id}))`))
    .orderBy(changed, messages.id)
    .limit(limit)
    .all()
    .map(toDomain);
}

/**
 * A message as the organisation's record has it, written on a replica
 * (EO-726): inserted, or every field overwritten — the record's copy is
 * the true one, so a press that lost a race on another desktop is
 * undone here rather than kept.
 *
 * `waiting` when its project has not reached this replica yet, which a
 * foreign key would refuse; the drain holds it until it has. A job this
 * replica does not hold is dropped from the row rather than holding it,
 * since jobs do not travel.
 */
export function upsertReplicaMessage(db: Db, message: Message): "written" | "waiting" {
  const has = (table: typeof projects | typeof jobs, id: string): boolean => db.select({ id: table.id }).from(table).where(eq(table.id, id)).get() !== undefined;
  if (message.projectId !== null && !has(projects, message.projectId)) return "waiting";
  const row: Row = {
    id: message.id,
    recipientId: message.recipientId,
    projectId: message.projectId,
    jobId: message.jobId !== null && has(jobs, message.jobId) ? message.jobId : null,
    source: message.source,
    body: message.body,
    options: message.options,
    createdAt: message.createdAt,
    handledAt: message.handledAt,
    handledHow: message.handledHow,
    answer: message.answer,
    handledBy: message.handledBy,
    // The record's to resolve, never a replica's.
    subject: null,
    // And the record's to answer: a press on it goes there (EO-918).
    fromRecord: true,
  };
  db.insert(messages)
    .values(row)
    .onConflictDoUpdate({
      target: messages.id,
      set: {
        recipientId: row.recipientId,
        projectId: row.projectId,
        jobId: row.jobId,
        source: row.source,
        body: row.body,
        options: row.options,
        createdAt: row.createdAt,
        handledAt: row.handledAt,
        handledHow: row.handledHow,
        answer: row.answer,
        handledBy: row.handledBy,
        fromRecord: true,
      },
    })
    .run();
  return "written";
}

/** The ids of every open message addressed to this person — what `record:messages` answers as `open` (EO-726). */
export function listOpenMessageIds(db: Db, recipientId: string): string[] {
  return db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.recipientId, recipientId), isNull(messages.handledAt)))
    .all()
    .map((row) => row.id);
}

/**
 * Whether a message is a replica's copy of one the organisation's record
 * holds (EO-918) — a press on it goes there — rather than one this
 * database wrote. Asked of the row, not its project: a message about a
 * record-held job has none. Undefined for no such message.
 */
export function isRecordCopy(db: Db, id: string): boolean | undefined {
  return db.select({ fromRecord: messages.fromRecord }).from(messages).where(eq(messages.id, id)).get()?.fromRecord;
}

/**
 * Removes a replica's open copies of this person's messages the
 * organisation's record no longer holds open (EO-726): those copied from
 * it and not among `stillOpen`, which is the record's list for this
 * person and says nothing of anybody else's. A message handled elsewhere
 * and then swept by the record's retention never pages again, so this is
 * the only way such a copy stops being open here. Never one this desktop
 * wrote (EO-918): it is not among `stillOpen` either. Answers how many
 * went.
 */
export function forgetMessagesGoneFromTheRecord(db: Db, recipientId: string, stillOpen: ReadonlySet<string>): number {
  const gone = db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.recipientId, recipientId), isNull(messages.handledAt), eq(messages.fromRecord, true)))
    .all()
    .filter((row) => !stillOpen.has(row.id))
    .map((row) => row.id);
  if (gone.length === 0) return 0;
  return db.delete(messages).where(inArray(messages.id, gone)).run().changes;
}

/**
 * Removes a replica's handled copies of this person's messages the
 * organisation's record holds (EO-918), before a pull that reads their
 * messages from the beginning writes back every one the record still
 * keeps. One the record has swept never pages again, and a copy pulled
 * by a build that dropped who handled it would otherwise go on reading as
 * the person's press when the assistant or an outside MCP client made it.
 * Only this person's — the pull reads nobody else's back — and only
 * copies: a message this desktop sent and handled itself is its own
 * history, which no pull brings back. Open copies are left to
 * `forgetMessagesGoneFromTheRecord`. Answers how many went.
 */
export function forgetHandledRecordMessages(db: Db, recipientId: string): number {
  return db
    .delete(messages)
    .where(and(eq(messages.recipientId, recipientId), isNotNull(messages.handledAt), eq(messages.fromRecord, true)))
    .run().changes;
}

/** Deletes one message's row, where the record answered that it no longer has it (EO-726). */
export function forgetMessage(db: Db, id: string): boolean {
  return db.delete(messages).where(eq(messages.id, id)).run().changes > 0;
}

/**
 * Whether a queued `sendMessage` command's message has already been
 * written here (EO-729) — asked of the receipt, which outlives the
 * message's own retention.
 */
export function hasQueuedMessageReceipt(db: Db, messageId: string): boolean {
  return db.select({ id: queuedMessageReceipts.messageId }).from(queuedMessageReceipts).where(eq(queuedMessageReceipts.messageId, messageId)).get() !== undefined;
}

/** Records that a queued command's message was written, so a replay of it writes nothing (EO-729). */
export function recordQueuedMessageReceipt(db: Db, messageId: string, now: number = Date.now()): void {
  db.insert(queuedMessageReceipts).values({ messageId, receivedAt: now }).onConflictDoNothing().run();
}
