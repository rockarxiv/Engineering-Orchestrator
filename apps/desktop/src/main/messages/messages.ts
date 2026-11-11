import { answerOptions, LOCAL_PERSON_ID, type IpcPayload, type IpcResponse, type Message, type MessageSend, type Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import { getJob, getMessage, insertMessage, listOpenMessages, listPeople, markMessageHandled, markMessagesAboutResolved, sweepHandledMessages } from "../db/repos/index.js";
import { actingCaller } from "../identity/acting.js";
import { viewerIds } from "../identity/viewer.js";
import { emitPush } from "../ipc/push.js";
import { answerSkipMessage } from "../jobs/answer.js";
import { startInterval } from "../schedule/interval.js";

/**
 * What EO asks a person outside any item (EO-725, ARCHITECTURE.md §7.1).
 *
 * The sender API. EO code that needs a person to answer or act on
 * something no item is about — a template update it could not apply, a
 * job guard — calls `sendMessage`, and `resolveMessage` once what it
 * asked about was settled some other way. Never an agent: agents never
 * send or read messages, so an item's thread stays the whole context the
 * next agent gets (invariant 4).
 *
 * Every change pushes `messages:changed`, which every window's inbox and
 * the dock badge and OS notification (`createInboxNotifier`) listen on.
 */

/** Sends one message to a person. Throws on a malformed one: a sender is EO's own code. */
export function sendMessage(db: Db, input: MessageSend, now: number = Date.now()): Message {
  const message = insertMessage(db, input, now);
  emitPush("messages:changed", {});
  return message;
}

/**
 * What a sender is answered through `ItemRecord.sendMessage` (EO-726):
 * the messages written where this installation can see them — on a
 * desktop asking the organisation's record, only those addressed to its
 * own person — or why none was sent.
 */
export type MessageSendAnswer = { ok: true; messages: Message[] } | { ok: false; problem: string };

/** A person answering or dismissing a message, as `ItemRecord.handleMessage` takes it (EO-726). */
export interface MessageHandling {
  messageId: string;
  how: "answered" | "dismissed";
  /** The option chosen; null for a dismissal. */
  answer: string | null;
  /** Who is pressing, as the `messages:*` channels carry it. */
  actingDeviceId?: string | null | undefined;
}

export type MessageHandlingAnswer = { ok: true; message: Message } | { ok: false; problem: string };

/**
 * A message about a project the organisation's record holds, written on
 * the record (EO-726, ARCHITECTURE.md §7.1): one to each of its admins,
 * who are whom the equivalent mention on the project's thread went to
 * before messages. The recipient the sender named is a
 * desktop's own person, which means nothing here; it is used only by a
 * record with no admin yet, rather than telling nobody.
 *
 * A message about a job this record holds goes to the job's owner
 * instead (EO-729): a job's guards are the owner's to act on, as they
 * are on a desktop, and the owner is a person this record knows.
 */
export function sendMessageToAdmins(db: Db, input: MessageSend, now: number = Date.now(), firstId?: string): Message[] {
  const jobOwner = input.jobId == null ? undefined : getJob(db, input.jobId as Uuid)?.ownerId;
  const people = listPeople(db);
  const admins = people.filter((person) => person.isAdmin);
  const recipients =
    jobOwner !== undefined && people.some((person) => person.id === jobOwner)
      ? [jobOwner]
      : admins.length > 0
        ? admins.map((person) => person.id)
        : [input.recipientId];
  // The first recipient's copy takes the id a queued command minted, so
  // its replay can tell the message was already written (EO-729).
  const sent = db.transaction(() => recipients.map((recipientId, index) => insertMessage(db, { ...input, recipientId }, now, index === 0 ? firstId : undefined)));
  emitPush("messages:changed", {});
  return sent;
}

/**
 * Answers or dismisses a message this database holds (EO-726), as a
 * typed answer rather than the throw the `messages:*` channels make of
 * it: what `ItemRecord.handleMessage` does where this is the record.
 */
export function handleMessageHere(db: Db, request: MessageHandling, now: number = Date.now()): MessageHandlingAnswer {
  try {
    const payload = { messageId: request.messageId, ...(request.actingDeviceId === undefined ? {} : { actingDeviceId: request.actingDeviceId }) };
    const { message } =
      request.how === "answered"
        ? answerMessageCommand(db, { ...payload, answer: request.answer ?? "" }, now)
        : dismissMessageCommand(db, payload, now);
    // What an answer sets going, where the message lives: "Run it now" on
    // a skip fires its occurrence (EO-729). Any other message, nothing.
    if (message.handledHow === "answered") actOnAnswer(db, message);
    return { ok: true, message };
  } catch (error) {
    return { ok: false, problem: error instanceof Error ? error.message : String(error) };
  }
}

/** The answer is recorded whatever its consequence does: a fault in it is logged, not the press refused. */
function actOnAnswer(db: Db, message: Message): void {
  try {
    answerSkipMessage(db, message);
  } catch (error) {
    console.error(`[eo] answering the message ${message.id} did not set off what it offered:`, error);
  }
}

/**
 * Marks an open message resolved by EO: what it asked about was settled
 * some other way, so nobody need answer it any more. Undefined, and
 * nothing pushed, when it was already handled or is gone.
 */
export function resolveMessage(db: Db, messageId: string, now: number = Date.now()): Message | undefined {
  const resolved = markMessageHandled(db, messageId, "resolved", null, now);
  if (resolved) emitPush("messages:changed", {});
  return resolved;
}

/**
 * Marks resolved by EO every open message a source sent about one subject
 * (`MessageSend.subject`, EO-727) — the conflict it asked about resolved,
 * the scope it said was stuck consolidated since. Only those this
 * database wrote: a replica's copy has no subject, and hears of the
 * resolution from the record that sent it. Answers how many it closed.
 */
export function resolveMessagesAbout(db: Db, source: string, subject: string, now: number = Date.now()): number {
  const resolved = markMessagesAboutResolved(db, source, subject, now);
  if (resolved.length > 0) emitPush("messages:changed", {});
  return resolved.length;
}

/**
 * Sends a message from code that runs where the project it is about is
 * held (EO-727) — the organisation's record for one it holds, this
 * desktop for one it keeps — without a round trip: to each admin on the
 * record (`sendMessageToAdmins`), else to this machine's person.
 * `ItemRecord.sendMessage` makes the same choice for a caller that may
 * be on either side.
 */
export function sendMessageHere(db: Db, input: Omit<MessageSend, "recipientId">, isTheRecord: boolean, now: number = Date.now()): Message[] {
  const message = { ...input, recipientId: LOCAL_PERSON_ID };
  return isTheRecord ? sendMessageToAdmins(db, message, now) : [sendMessage(db, message, now)];
}

/**
 * Whose messages a caller reads and handles.
 *
 * A request a door stamped is its person's, or nobody's for an
 * operator's key. Unstamped — a desktop's own window — is both of this
 * machine's identities, as the inbox's item questions are (`viewerIds`).
 */
export function messageRecipientsFor(db: Db, actingDeviceId: string | null | undefined): string[] {
  const caller = actingCaller(db, actingDeviceId);
  if (caller.served) return caller.person ? [caller.person.id] : [];
  return viewerIds(db);
}

/** The open messages the caller is the recipient of, newest first. */
export function openMessagesFor(db: Db, actingDeviceId: string | null | undefined): Message[] {
  return listOpenMessages(db, messageRecipientsFor(db, actingDeviceId));
}

/** The message, if it is open and the caller's to handle. Throws the sentence the person is shown otherwise. */
export function openMessageOf(db: Db, messageId: string, actingDeviceId: string | null | undefined): Message {
  const message = getMessage(db, messageId);
  if (!message || !messageRecipientsFor(db, actingDeviceId).includes(message.recipientId)) {
    throw new Error("That message is not one of yours, or it has been deleted.");
  }
  if (message.handledAt !== null) throw new Error(`That message was already ${message.handledHow ?? "handled"}.`);
  return message;
}

/** `messages:answer`: the recipient answers with one of the message's offered answers. */
export function answerMessageCommand(db: Db, payload: IpcPayload<"messages:answer">, now: number = Date.now()): IpcResponse<"messages:answer"> {
  const message = openMessageOf(db, payload.messageId, payload.actingDeviceId);
  if (!answerOptions(message.options).includes(payload.answer)) {
    throw new Error(`"${payload.answer}" is not one of the answers this message offers.`);
  }
  return { message: handled(db, message.id, "answered", payload.answer, now) };
}

/** `messages:dismiss`: the recipient closes it without answering. */
export function dismissMessageCommand(db: Db, payload: IpcPayload<"messages:dismiss">, now: number = Date.now()): IpcResponse<"messages:dismiss"> {
  const message = openMessageOf(db, payload.messageId, payload.actingDeviceId);
  return { message: handled(db, message.id, "dismissed", null, now) };
}

function handled(db: Db, messageId: string, how: "answered" | "dismissed", answer: string | null, now: number): Message {
  const message = markMessageHandled(db, messageId, how, answer, now);
  // Handled between the read above and this write — by EO resolving it,
  // or a second window. Said, rather than claiming this press did it.
  if (!message) throw new Error("That message was handled in the meantime.");
  emitPush("messages:changed", {});
  return message;
}

/** Once a day: a handled message is kept 7 days, so checking more often buys nothing. */
const DAILY_MS = 24 * 60 * 60 * 1000;

/**
 * The retention sweep, at launch and then daily (`sweepHandledMessages`).
 * Pushes only when it deleted something; nothing open is ever deleted, so
 * no inbox changes, but a window showing a handled one should hear.
 */
export function startMessageSweep(db: Db, options: { intervalMs?: number } = {}): () => void {
  const loop = startInterval({
    name: "message sweep",
    tick: () => {
      if (sweepHandledMessages(db) > 0) emitPush("messages:changed", {});
    },
    readIntervalMs: () => options.intervalMs ?? DAILY_MS,
  });
  return loop.stop;
}
