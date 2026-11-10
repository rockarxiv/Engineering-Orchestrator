import { z } from "zod";
import { CommentOptionSchema } from "./schemas/commentOptions.js";

/**
 * What EO asks a person outside any item (EO-725, ARCHITECTURE.md §7.1).
 *
 * Comments are an item's conversation (invariant 4): anything an agent
 * says, or is told, about an item. A message is the one other channel, for
 * exactly one case — EO needs a person to answer or act on something that
 * belongs to no item: a template update it could not apply, a job guard.
 * Agents never send or read one, so an item's thread stays the whole
 * context the next agent gets.
 *
 * Open until handled — answered with one of its options, dismissed, or
 * resolved by EO when what it asked about was settled some other way —
 * and deleted 7 days after that, with at most 100 handled kept per person.
 */

/** How a message stopped being open. */
export const MESSAGE_HANDLED_HOW = ["answered", "dismissed", "resolved"] as const;
export const MessageHandledHowSchema = z.enum(MESSAGE_HANDLED_HOW);
export type MessageHandledHow = z.infer<typeof MessageHandledHowSchema>;

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
});
export type Message = z.infer<typeof MessageSchema>;

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

/** How long a handled message is kept. */
export const HANDLED_MESSAGE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** How many handled messages each person keeps; the oldest handled go first. */
export const HANDLED_MESSAGES_KEPT_PER_PERSON = 100;
