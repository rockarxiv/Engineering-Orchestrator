import { z } from "zod";
import { COMMENT_KINDS, type CommentKind } from "./comments.js";

/**
 * What a person's decision is about: the brief behind "Show details" on
 * the item page's decision bar (EO-827, ARCHITECTURE.md, "The decision's
 * brief").
 *
 * With nothing declared, a step's brief is the default: its instructions
 * summary, the item's current output, and the newest verdict from the step
 * the item came from. A `user` step may declare what its brief shows
 * instead — data on the step (invariant 7), versioned, exported and
 * validated with the graph, and set through the assistant's draft as entry
 * rules are. Each part is one of three:
 *
 * - `output`: the newest output a named step produced, by the step's id;
 * - `comment`: the newest comment of a kind (`approval`, `rejection`, …),
 *   by an author role (an agent's role, or `human`, `engine`, `module`),
 *   or both at once;
 * - `field`: one of the item's fields, by the name its type declares.
 *
 * Shown in the order declared. Resolved in the main process, which is the
 * only place that can read the thread (`items:brief`); `validatePipeline`
 * judges the names against the pipeline and the project.
 */
export const StepBriefPartSchema = z.discriminatedUnion("show", [
  z.object({
    show: z.literal("output"),
    /** The step whose newest output is shown, by id. */
    step: z.string().min(1),
  }),
  z.object({
    show: z.literal("comment"),
    /** The comment kind (`approval`, `rejection`, `note`, …). Absent is any kind. */
    kind: z.string().min(1).optional(),
    /** Whose: an agent's role, or `human`, `engine` or `module`. Absent is anybody. */
    role: z.string().min(1).optional(),
  }),
  z.object({
    show: z.literal("field"),
    /** The item field, by the name its type declares. */
    field: z.string().min(1),
  }),
]);
export type StepBriefPart = z.infer<typeof StepBriefPartSchema>;

/**
 * A step's declared brief: its parts, in the order they are shown. A step
 * declaring none stores null and shows the default; an empty list is read
 * as none, since a brief that shows nothing is not one anybody means.
 */
export const StepBriefSchema = z.array(StepBriefPartSchema);
export type StepBrief = z.infer<typeof StepBriefPartSchema>[];

/** A stored brief as the step carries it: null for none, and for an empty or unreadable list. */
export function storedBrief(value: unknown): StepBrief | null {
  const parsed = StepBriefSchema.safeParse(value).data;
  return parsed === undefined || parsed.length === 0 ? null : parsed;
}

/** The author roles a comment part may name that are not an agent's role. */
export const NON_AGENT_AUTHOR_ROLES: readonly string[] = ["human", "engine", "module"];

/** The comment kinds that carry a step's verdict, which the default brief shows from the step before. */
export const VERDICT_COMMENT_KINDS: readonly CommentKind[] = ["approval", "rejection", "decision"];

export function isCommentKind(kind: string): kind is CommentKind {
  return (COMMENT_KINDS as readonly string[]).includes(kind);
}

/**
 * One part of a brief in words, for a version diff, a draft card and a
 * refusal: "the newest output of Implement", "the newest approval by
 * reviewer", "the field Customer".
 */
export function briefPartWords(part: StepBriefPart, stepNames?: ReadonlyMap<string, string>): string {
  if (part.show === "output") return `the newest output of ${stepNames?.get(part.step) ?? part.step}`;
  if (part.show === "field") return `the field "${part.field}"`;
  const what = part.kind ?? "comment";
  return part.role === undefined ? `the newest ${what}` : `the newest ${what} by ${part.role}`;
}

/** A whole brief in words, or "the default" where none is declared — absent included, as a document from before briefs is. */
export function briefWords(brief: StepBrief | null | undefined, stepNames?: ReadonlyMap<string, string>): string {
  return brief === null || brief === undefined || brief.length === 0 ? "the default" : brief.map((part) => briefPartWords(part, stepNames)).join(", then ");
}

/**
 * One part of a brief as the item page draws it (`items:brief`).
 *
 * `body` is markdown, or null where there is nothing to show yet — an
 * output the step has not produced, a field nobody filled in — which the
 * page says rather than leaving the heading over nothing.
 */
export const ItemBriefPartSchema = z.object({
  /** `summary`, the step's instructions, is the default brief's alone. */
  show: z.enum(["summary", "output", "comment", "field"]),
  /** "Current output", "Verdict from Review", "Output of Implement", "Customer". */
  heading: z.string(),
  body: z.string().nullable(),
  /** Who wrote it, on an output or a comment. */
  author: z.string().nullable().default(null),
  createdAt: z.number().nullable().default(null),
});
export type ItemBriefPart = z.infer<typeof ItemBriefPartSchema>;

/** The resolved brief of the step an item stands on. Null where the item is gone. */
export const ItemBriefSchema = z.object({
  /** Whether the step declares its brief, rather than showing the default. */
  declared: z.boolean(),
  parts: z.array(ItemBriefPartSchema),
});
export type ItemBrief = z.infer<typeof ItemBriefSchema>;
