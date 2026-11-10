import { and, desc, eq, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import {
  HANDLED_MESSAGE_RETENTION_MS,
  HANDLED_MESSAGES_KEPT_PER_PERSON,
  MessageHandledHowSchema,
  MessageSendSchema,
  parseStoredCommentOptions,
  uuidv7,
  type Message,
  type MessageHandledHow,
  type MessageSend,
} from "@eo/core";
import type { Db } from "../client.js";
import { messages } from "../schema.js";

/**
 * What EO asks a person outside any item (EO-725, ARCHITECTURE.md §7.1).
 *
 * The one module that writes `messages`. Sending, handling and sweeping
 * are here; what a sender says, and telling the windows, is
 * `messages/messages.ts`'s.
 */

type Row = typeof messages.$inferSelect;

function toDomain(row: Row): Message {
  const handledHow = MessageHandledHowSchema.safeParse(row.handledHow);
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
    handledHow: handledHow.success ? handledHow.data : null,
    answer: row.answer,
  };
}

/** Writes one open message. Throws on a malformed one — a sender is EO's own code, so that is a programmer error. */
export function insertMessage(db: Db, input: MessageSend, now: number = Date.now()): Message {
  const parsed = MessageSendSchema.parse(input);
  const row: Row = {
    id: uuidv7(),
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
 * Closes an open message: `answered` with the option chosen, `dismissed`,
 * or `resolved` by EO.
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
): Message | undefined {
  const row = db
    .update(messages)
    .set({ handledAt: now, handledHow: how, answer: how === "answered" ? answer : null })
    .where(and(eq(messages.id, id), isNull(messages.handledAt)))
    .returning()
    .get();
  return row ? toDomain(row) : undefined;
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
