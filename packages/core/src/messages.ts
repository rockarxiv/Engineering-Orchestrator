import { z } from "zod";
import { CommentOptionSchema } from "./schemas/commentOptions.js";

/**
 * What EO asks a person outside any item (EO-725, ARCHITECTURE.md §7.1).
 *
 * Comments are an item's conversation (invariant 4): anything an agent
 * says, or is told, about an item. A message is the one other channel, for
 * exactly one case — EO needs a person to answer or act on something that
 * belongs to no item: a template update it could not apply, a job guard.
 * Its recipient answers or dismisses it — in the Inbox, or through an
 * outside MCP client or EO's assistant acting for them (EO-918). A
 * step-owning agent never sends, reads or handles one, so an item's thread
 * stays the whole context the next agent gets.
 *
 * Open until handled — answered with one of its options, dismissed, or
 * resolved by EO when what it asked about was settled some other way —
 * and deleted 7 days after that, with at most 100 handled kept per person.
 */

/** How a message stopped being open. */
export const MESSAGE_HANDLED_HOW = ["answered", "dismissed", "resolved"] as const;
export const MessageHandledHowSchema = z.enum(MESSAGE_HANDLED_HOW);
export type MessageHandledHow = z.infer<typeof MessageHandledHowSchema>;

/**
 * Who answered or dismissed a message (EO-918): its recipient in the
 * Inbox, EO's assistant acting for them (a system agent, by id, over
 * `eo_admin`), or an outside client of EO's MCP server acting on the
 * credential the person gave it. All three act with the person's
 * authority; this says only which of them pressed.
 */
export const MessageHandledBySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("person") }),
  z.object({ kind: z.literal("assistant"), agentId: z.string() }),
  z.object({ kind: z.literal("mcp_client") }),
]);
export type MessageHandledBy = z.infer<typeof MessageHandledBySchema>;

/** The person pressing in the Inbox: what a handled message with no recorded handler reads as. */
export const HANDLED_BY_PERSON: MessageHandledBy = { kind: "person" };

/**
 * Who handled it, as EO's MCP tools say it — "the person", "the
 * assistant", "an outside MCP client" — or as the Inbox says it to that
 * person (`toThePerson`), where they are "you".
 */
export function handledByWords(by: MessageHandledBy, toThePerson = false): string {
  switch (by.kind) {
    case "person":
      return toThePerson ? "you" : "the person";
    case "assistant":
      return "the assistant";
    case "mcp_client":
      return "an outside MCP client";
  }
}

/** One message, as it is stored and as it crosses IPC. */
export const MessageSchema = z.object({
  id: z.string(),
  /** The person who must answer or act. */
  recipientId: z.string(),
  /** The project it concerns, or null. */
  projectId: z.string().nullable(),
  /** The job it concerns, or null. */
  jobId: z.string().nullable(),
  /** A stable string naming what sent it, e.g. `template_conflict`. */
  source: z.string(),
  /** Markdown. */
  body: z.string(),
  /** The same answers and actions a comment offers (`CommentOption`). */
  options: z.array(CommentOptionSchema).nullable(),
  createdAt: z.number(),
  /** When it was answered, dismissed or resolved; null while open. */
  handledAt: z.number().nullable(),
  handledHow: MessageHandledHowSchema.nullable(),
  /** The option an answer chose; null otherwise. */
  answer: z.string().nullable(),
  /**
   * Who answered or dismissed it (EO-918); null while open and on one EO
   * resolved. Null on one answered or dismissed is not known: a
   * desktop's copy of the record's message pulled before who handled it
   * was kept, until its next pull reads it again. Defaulted so a message
   * from a record built before it still parses.
   */
  handledBy: MessageHandledBySchema.nullable().default(null),
});
export type Message = z.infer<typeof MessageSchema>;

/**
 * How a handled message ended and who ended it, as the Inbox and EO's MCP
 * tools say it (EO-918): "Answered Carry on now · by the assistant",
 * "Dismissed · by the person" ("by you" `toThePerson`), "Resolved by EO".
 * Nobody named where who is not known ("Answered Carry on now"). Null
 * while it is open.
 */
export function messageHandledWords(message: Pick<Message, "handledHow" | "answer" | "handledBy">, toThePerson = false): string | null {
  switch (message.handledHow) {
    case null:
      return null;
    case "resolved":
      return "Resolved by EO";
    case "answered":
    case "dismissed": {
      const how = message.handledHow === "answered" ? `Answered ${message.answer ?? ""}`.trimEnd() : "Dismissed";
      return message.handledBy === null ? how : `${how} · by ${handledByWords(message.handledBy, toThePerson)}`;
    }
  }
}

/** What EO code hands the sender (`sendMessage` in main). */
export const MessageSendSchema = z.object({
  recipientId: z.string().min(1),
  projectId: z.string().nullable().optional(),
  jobId: z.string().nullable().optional(),
  source: z.string().min(1),
  body: z.string().min(1),
  options: z.array(CommentOptionSchema).nullable().optional(),
  /**
   * What it is about within its source — a conflict's id, a memory
   * scope's key — so EO can resolve it once that is settled some other
   * way (`resolveMessagesAbout` in main, EO-727). Absent for a message
   * nothing resolves.
   */
  subject: z.string().min(1).nullable().optional(),
});
export type MessageSend = z.input<typeof MessageSendSchema>;

/** How many recently handled messages the Inbox and `inbox_list` show beside the open ones (EO-918). */
export const INBOX_HANDLED_MESSAGES_SHOWN = 10;

/** How long a handled message is kept. */
export const HANDLED_MESSAGE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** How many handled messages each person keeps; the oldest handled go first. */
export const HANDLED_MESSAGES_KEPT_PER_PERSON = 100;
