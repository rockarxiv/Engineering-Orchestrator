import { z } from "zod";

/**
 * What a comment offers the person reading it (EO-533).
 *
 * Until EO-533 an option was always an *answer*: a string that pressing
 * posts as the reply, so a choice is one click rather than an essay. That
 * stays the common case and keeps its spelling — a plain string.
 *
 * The other kind is an **action**: a button that opens something rather
 * than saying something. Pressing it posts nothing and answers nothing;
 * the chat layout draws it apart from the offered answers, and EO decides
 * what it opens from the target it names, never from the label. The first
 * is the conflict notice's Fix with assistant, which opens an assistant
 * chat about one held template update.
 *
 * A closed union of targets, like every other thing the renderer
 * branches on: a target a build does not know is not drawn as a button
 * that would do nothing.
 */

/** What an action opens. */
export const CommentOpenTargetSchema = z.discriminatedUnion("type", [
  /** The assistant chat about one held template update (`pipeline_update_conflicts.id`). */
  z.object({ type: z.literal("updateConflictChat"), conflictId: z.string().min(1) }),
]);
export type CommentOpenTarget = z.infer<typeof CommentOpenTargetSchema>;

/** A button on a comment that opens something, rather than a reply. */
export const CommentActionOptionSchema = z.object({
  kind: z.literal("open"),
  label: z.string().min(1),
  opens: CommentOpenTargetSchema,
});
export type CommentActionOption = z.infer<typeof CommentActionOptionSchema>;

/** One offered option: an answer (a string) or an action. */
export const CommentOptionSchema = z.union([z.string(), CommentActionOptionSchema]);
export type CommentOption = z.infer<typeof CommentOptionSchema>;

/** Whether an option is an action rather than an answer. */
export function isCommentAction(option: CommentOption): option is CommentActionOption {
  return typeof option !== "string";
}

/** The answers among a comment's options: what pressing posts as a reply. Actions are left out. */
export function answerOptions(options: readonly CommentOption[] | null | undefined): string[] {
  return (options ?? []).filter((option): option is string => typeof option === "string");
}

/** The actions among a comment's options. */
export function actionOptions(options: readonly CommentOption[] | null | undefined): CommentActionOption[] {
  return (options ?? []).filter(isCommentAction);
}

/**
 * Options as a column holds them, read back without trusting them.
 *
 * A row written by an older build holds strings only; a row written by a
 * newer one may hold a target this build does not know. Each entry that
 * is not a valid option is dropped rather than failing the comment.
 */
export function parseStoredCommentOptions(stored: unknown): CommentOption[] | null {
  if (!Array.isArray(stored)) return null;
  return stored.flatMap((entry) => {
    const parsed = CommentOptionSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}
