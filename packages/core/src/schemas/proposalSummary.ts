import { z } from "zod";

/**
 * A work proposal as rows, for a card that lists what approving it would
 * create or change (EO-407).
 *
 * Built in the main process from the structured proposal on the run that
 * posted the card — the same data the approval path files — and never
 * from the card's prose body. A card that drew one thing and created
 * another would be worse than the wall of text it replaces, so the
 * renderer is handed the answer rather than asked to work it out.
 *
 * A summary, deliberately: titles, type labels, criteria and what waits
 * on what. No descriptions.
 */

/** Something a proposed item waits on: another item in the same proposal, which has no key yet, or one that exists. */
export const ProposalDependencySchema = z.object({
  /** The existing item's key, and null for an item this proposal would itself create. */
  key: z.string().nullable(),
  title: z.string(),
});

/** An item the proposal would create. It has no key: one is allocated when it is filed. */
export const ProposedItemRowSchema = z.object({
  kind: z.literal("new"),
  title: z.string(),
  /** The item type's label from the pack that ships it — "Story", "Case". */
  typeLabel: z.string(),
  /** Every criterion, in order. Empty for a type that was not asked for any. */
  acceptanceCriteria: z.array(z.string()),
  waitsOn: z.array(ProposalDependencySchema),
  /** The existing container a single item would be filed under, and null for one filed alone or under the proposal's own container. */
  under: z.object({ key: z.string(), title: z.string() }).nullable(),
  /** The priority it would be created with (EO-568). Absent when the proposal gave none, which is 0. */
  priority: z.number().int().optional(),
  /**
   * The Reference a single item would be created with (EO-739), trimmed.
   * Absent when it names none — and on a plan's rows, which read their
   * feature's from the container.
   */
  reference: z.string().optional(),
  /**
   * The reviewers a single item would be created with (EO-743),
   * normalised; `[]` is "nobody". Absent when it names none of its own —
   * and on a plan's rows, which read their feature's from the container.
   */
  reviewers: z.array(z.string()).optional(),
  /**
   * The item this row became, once the proposal was approved (EO-408),
   * and null or absent until then — and for a created item deleted since.
   *
   * What turns a row into a link and an open proposed-item tab into the
   * item's own view. Read from the approval filed under the card, so it
   * names what that approval created.
   */
  created: z.object({ itemId: z.string(), key: z.string() }).nullable().optional(),
});

/** A change to an item that already exists. */
export const AmendedItemRowSchema = z.object({
  kind: z.literal("change"),
  /** Null when the item has been deleted since the card was posted, which leaves nothing to link to. */
  itemId: z.string().nullable(),
  itemKey: z.string(),
  itemTitle: z.string().nullable(),
  /** What changes, in one line. */
  change: z.string(),
});

export const ProposalRowSchema = z.discriminatedUnion("kind", [ProposedItemRowSchema, AmendedItemRowSchema]);

export const ProposalSummarySchema = z.object({
  /** The container the proposal creates with its items under it, and null for a proposal that creates none. */
  container: z.object({
    title: z.string(),
    typeLabel: z.string(),
    /** The container's own priority (EO-568), absent when the proposal gave none. Its items carry theirs on their rows. */
    priority: z.number().int().optional(),
    /** The container's Reference (EO-739), trimmed, which its items inherit. Absent when the proposal gave none. */
    reference: z.string().optional(),
    /** The container's reviewers (EO-743), normalised, which its items inherit. Absent when the proposal gave none; `[]` is "nobody". */
    reviewers: z.array(z.string()).optional(),
  }).nullable(),
  rows: z.array(ProposalRowSchema),
  /**
   * Why the card offers no approve button, and null while it still does
   * — or when the conversation itself was closed, which is no fact about
   * this card.
   *
   * `applied`: approved, and the work exists. `refused`: approved, and
   * the approval path turned it away with a reason in the thread.
   * `superseded`: something newer replaced it.
   */
  closed: z.enum(["applied", "refused", "superseded"]).nullable(),
});

/**
 * One proposed item at full length (EO-408): its row, and the description
 * the row leaves out.
 */
/**
 * A field the project added to the row's type (EO-735), as the proposed
 * item's view offers it before the item exists: its name, the label a
 * person reads, and its kind.
 */
export const ProposedAddedFieldSchema = z.object({
  name: z.string(),
  label: z.string(),
  kind: z.enum(["string", "number", "boolean", "string list"]),
});

export const ProposedItemDetailSchema = ProposedItemRowSchema.extend({
  /** The item's body as it would be filed, Markdown. Empty when it has none. */
  description: z.string(),
  /**
   * The fields this project added to the row's type (EO-735), in the
   * type's order: what the view offers a person to fill in before
   * pressing Create, each left unset unless they do. Empty for a type
   * nobody added to.
   */
  addedFields: z.array(ProposedAddedFieldSchema).default([]),
});

/**
 * A work proposal at full length, for the canvas view that draws one of
 * its items as an unfiled item (EO-408).
 *
 * The card's summary and this are the same proposal read by the same
 * readers; this adds what a row has no room for — each item's
 * description and where the work would land — and what the view needs in
 * order to approve from where it stands: which conversation the card is
 * in, and whether it may still be approved.
 *
 * Asked for by message id (`assist:proposal`) rather than carried on
 * every message, so the conversation is not re-sent with every story's
 * body on each streamed event of a turn.
 */
export const ProposalDetailSchema = z.object({
  /** The conversation the card is in: what `assist:approve` takes beside the message id. */
  conversationId: z.string(),
  /** The card's own `canApprove`. False once approved, replaced, or its conversation closed. */
  canApprove: z.boolean(),
  container: ProposalSummarySchema.shape.container,
  rows: z.array(z.discriminatedUnion("kind", [ProposedItemDetailSchema, AmendedItemRowSchema])),
  closed: ProposalSummarySchema.shape.closed,
  /**
   * The pipeline the items would be created on and the step they would
   * enter at, and null when that cannot be said yet — a project with
   * several pipelines and a proposal naming none, or no pipeline at all.
   * Approval refuses those with the reason; this only declines to guess.
   */
  landsOn: z.object({ pipelineName: z.string(), stepName: z.string() }).nullable(),
});

export type ProposedItemDetail = z.infer<typeof ProposedItemDetailSchema>;
export type ProposedAddedField = z.infer<typeof ProposedAddedFieldSchema>;
export type ProposalDetail = z.infer<typeof ProposalDetailSchema>;
export type ProposalDependency = z.infer<typeof ProposalDependencySchema>;
export type ProposedItemRow = z.infer<typeof ProposedItemRowSchema>;
export type AmendedItemRow = z.infer<typeof AmendedItemRowSchema>;
export type ProposalRow = z.infer<typeof ProposalRowSchema>;
export type ProposalSummary = z.infer<typeof ProposalSummarySchema>;
