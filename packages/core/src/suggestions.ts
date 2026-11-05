import { z } from "zod";
import { diffVersions, VersionDiffSchema, type VersionDiff, type VersionRoute, type VersionStep } from "./pipelineVersions.js";
import { GalleryNeedSchema } from "./schemas/gallery.js";
import type { IpcChannel } from "./ipc.js";
import type { EntryRule } from "./entryRules.js";
import type { PipelineExport } from "./schemas/pipelineExport.js";
import type { StepResult } from "./schemas/pipelines.js";

/**
 * A change somebody wants made to a pipeline their organisation
 * manages, and the state a desktop is in while they are making it
 * (EO-331, `ARCHITECTURE.md`, "Divergence and suggestions").
 *
 * Two halves of one story, in one file because they are one sentence:
 * a locked pipeline somebody edits is **diverged**, and the only way
 * their edit ever reaches anybody else is as a **suggestion** — an item
 * on an internal pipeline, with a diff and a thread, that an admin
 * approves or sends back.
 *
 * Everything here is pure. The words are here rather than in the
 * screens for `SECTION_LOCK_TEXT`'s reason: the admin reads the
 * suggestion in a browser the server serves, the author reads the
 * diverged line on their own desktop, and the assistant says the same
 * thing in a chat — three readers of one sentence, and three copies of
 * it would be three sentences within a release.
 */

/**
 * The internal pipeline a suggestion is an item on (the original design).
 *
 * "A suggestion is an item on an internal 'pipeline changes' pipeline
 * with one human step, so it has a thread: the admin can ask 'why did
 * you drop the review step?' in the one channel there is."
 *
 * An ordinary pipeline, made by the record the first time anybody
 * suggests anything, rather than a table of suggestions with a
 * conversation bolted to it. That is the whole of the design decision:
 * a suggestion gets a thread, an assignee, an inbox entry, a history
 * and an archive because it is an item, and every one of those would
 * otherwise have had to be built again for one screen.
 */
export const SUGGESTIONS_PIPELINE_NAME = "Pipeline changes";

/** The one human step on it — where a suggestion waits for an admin. */
export const SUGGESTION_STEP_NAME = "Review the change";

/** Where an approved or sent-back suggestion comes to rest. */
export const SUGGESTION_DONE_STEP_NAME = "Settled";

/**
 * The group a suggestion is offered to (the original design: "until an admin approves
 * it").
 *
 * A group rather than a person, because which admin picks it up is not
 * EO's to decide — `assigneeOnArrival` leaves a group-owned step
 * unclaimed and anybody in the group may claim it, which is exactly
 * what "the admins" means.
 */
export const ADMINS_GROUP_NAME = "Admins";

/** The pack a suggestion's item type is filed under — EO's own, not a person's. */
export const SUGGESTION_PACK_SLUG = "eo";

/** The item type a suggestion is. */
export const SUGGESTION_ITEM_TYPE_SLUG = "pipeline_change";

/** The two answers the one human step offers (ARCHITECTURE.md, "Divergence and suggestions"). */
export const SUGGESTION_APPROVED = "approved";
export const SUGGESTION_SENT_BACK = "changes";

/**
 * Approve and Send back, as the step declares them.
 *
 * `requiresComment` on the send-back and not on the approval, which is
 * the design's rule for every human step and doubly true here: a suggestion
 * that comes back with no reason is an author told "no" by a screen,
 * and the whole argument for a suggestion being an item is that there
 * is somewhere for the reason to go.
 */
export const SUGGESTION_RESULTS: StepResult[] = [
  { key: SUGGESTION_APPROVED, label: "Approve", tone: "success", requiresComment: false },
  { key: SUGGESTION_SENT_BACK, label: "Send back", tone: "warning", requiresComment: true },
];

/** What the item is called on the admin's board. */
export function suggestionTitle(pipelineName: string): string {
  return `Suggested change to "${pipelineName}"`;
}

/** The item's body — what it is, in one line, for whoever opens it cold. */
export function suggestionBody(input: { pipelineName: string; basedOn: number | null; author: string | null }): string {
  const by = input.author === null ? "" : ` by ${input.author}`;
  const from = input.basedOn === null ? "" : `, based on v${input.basedOn}`;
  return `A change to "${input.pipelineName}" suggested${by} from a desktop${from}. Approve it to publish it as the next version, or send it back with what you want different.`;
}

/**
 * The line a diverged pipeline draws where its lock used to be (the original design).
 *
 * "Edited locally · based on v6 · v7 available." The third clause is
 * absent when there is nothing newer — a person who diverged from the
 * version still published is not waiting for anything, and a line
 * telling them "v6 available" would be EO inventing news.
 */
export function divergedLine(input: { basedOn: number | null; available: number | null }): string {
  const parts = ["Edited locally"];
  if (input.basedOn !== null) parts.push(`based on v${input.basedOn}`);
  if (input.available !== null && (input.basedOn === null || input.available > input.basedOn)) parts.push(`v${input.available} available`);
  return parts.join(" · ");
}

/** The chip on the board's pipeline header — "a fact rather than a warning" (ARCHITECTURE.md, "Divergence and suggestions"). */
export const DIVERGED_CHIP = "diverged";

/** What the chip says when somebody hovers it. */
export const DIVERGED_CHIP_TITLE =
  "This pipeline was edited on this machine, so your organisation's updates no longer apply to it. Ask the assistant to suggest your change or discard your edits.";

/**
 * What a person is offered where the lock would have been (ARCHITECTURE.md, "Divergence and
 * suggestions").
 *
 * Named here so the desktop's three buttons and whatever the assistant
 * says about them cannot drift apart.
 */
export const DIVERGED_ACTIONS = { compare: "Compare", suggest: "Suggest my change", discard: "Discard my edits" } as const;

/** What the lock itself offers, on a section that is published and not yet diverged (ARCHITECTURE.md, "Divergence and suggestions"). */
export const SUGGEST_A_CHANGE = "Suggest a change";

/**
 * The channels a **diverged** pipeline is editable through, despite the
 * section being published (EO-331, ARCHITECTURE.md, "Divergence and suggestions").
 *
 * The lock is per section and never per field (ARCHITECTURE.md, "Publish, lock and versions"), and
 * this does not
 * make it finer. It says something else: a pipeline somebody has
 * already diverged is no longer the organisation's copy of that
 * pipeline on this machine — it is the editable local copy the design says
 * *Suggest a change* creates, and an editable copy that could not be
 * edited would be a button that lies.
 *
 * Written as a list of channels rather than decided inside each
 * handler, for `SECTION_LOCKED_CHANNELS`' reason: what a command can
 * forget, a list cannot. And it is one channel, deliberately — saving
 * the graph. Creating, deleting and importing pipelines, approving
 * modules and installing packs stay locked on a machine whose
 * organisation manages them, because none of those is "the copy I
 * diverged".
 */
export const DIVERGED_EDITABLE_CHANNELS: readonly IpcChannel[] = ["pipeline:save"];

/** Whether a locked channel is one a diverged pipeline may still be written through. */
export function editableWhenDiverged(channel: string): boolean {
  return (DIVERGED_EDITABLE_CHANNELS as readonly string[]).includes(channel);
}

/**
 * An export document, read as a version's step and route set.
 *
 * The adapter that lets the design's diff be the original design's diff rather than a second
 * one: "the export document is the diffable unit" (the original design), and
 * `diffVersions` already compares steps, routes and prompts in the
 * words the read-only diff screen draws. Two shapes for one graph would
 * have been two diffs, and the admin comparing a suggestion would have
 * been reading a different report from the admin comparing two
 * versions.
 *
 * `offBoard` is false for every step, and that is a fact about the
 * document rather than a default chosen here: `exportPipeline` filters
 * off-board steps out, because a conversation's host step is not
 * something a second machine should acquire by importing a pipeline. So
 * a document never carries one, and the honest reading of what it does
 * carry is "on the board".
 */
export function documentGraph(document: PipelineExport): { steps: VersionStep[]; routes: VersionRoute[]; entryRules: EntryRule[] } {
  return {
    steps: document.steps.map((step) => ({
      id: step.id,
      position: step.position,
      name: step.name,
      type: step.type,
      ownerRole: step.ownerRole,
      entryAction: step.entryAction,
      instructionsSummary: step.instructionsSummary,
      isTerminal: step.isTerminal,
      planMode: step.planMode,
      offBoard: false,
      watch: step.watch,
      results: step.results.map((result) => ({
        key: result.key,
        label: result.label,
        tone: result.tone,
        requiresComment: result.requiresComment,
      })),
    })),
    routes: document.routes.map((route) => ({
      fromStepId: route.fromStepId,
      resultKey: route.resultKey,
      label: route.label,
      target: route.target,
      tone: route.tone,
      position: route.position,
    })),
    entryRules: document.pipeline.entryRules,
  };
}

/**
 * What the admin is shown: the published version against the document
 * somebody is suggesting (ARCHITECTURE.md, "Divergence and suggestions").
 *
 * The "to" side is numbered as the version it *would* be, because that
 * is what approving it does — "Approve publishes it as the next
 * version" — and a diff headed v6 → v6 would be a diff of a document
 * against itself as far as anybody reading the heading is concerned.
 */
export function suggestionDiff(input: {
  published: { number: number; steps: VersionStep[]; routes: VersionRoute[]; entryRules?: readonly EntryRule[] };
  document: PipelineExport;
}): VersionDiff {
  return diffVersions({ ...input.published, ...onBoard(input.published) }, { number: input.published.number + 1, ...documentGraph(input.document) });
}

/**
 * A version's graph with the steps a document could not have carried
 * taken out.
 *
 * Both sides of a comparison have to be able to say the same things, or
 * the difference between them is partly a difference between the two
 * shapes. A version freezes every step including the off-board ones —
 * the host step a conversation's runs hang from — and an export
 * document carries none of them, on purpose. Diffed as they come, every
 * off-board step a published pipeline has reads as **removed** by
 * whoever suggested the change.
 *
 * Which would be a diff that lies about what approving does: applying a
 * suggestion merges the document over the rows that are here and passes
 * the off-board steps through untouched, precisely because they never
 * travelled. So the published side is read the way the document is —
 * what is on the board — and the routes into and out of what is left
 * with it, since a route to a step neither side lists is not a route
 * either of them has.
 */
function onBoard(graph: { steps: VersionStep[]; routes: VersionRoute[] }): { steps: VersionStep[]; routes: VersionRoute[] } {
  const steps = graph.steps.filter((step) => !step.offBoard);
  const kept = new Set(steps.map((step) => step.id));
  return { steps, routes: graph.routes.filter((route) => kept.has(route.fromStepId)) };
}

/**
 * The whole of what an admin's screen draws for a suggestion (the original design).
 *
 * "The admin sees the suggestion as a diff of steps, routes, prompts
 * and modules against the current published version, plus the same
 * needs list and unapproved modules the author saw." Three things and
 * their context, in one read, because they are one screen and three
 * round trips would be three moments at which the item could be a
 * different item.
 */
export const SuggestionViewSchema = z.object({
  itemId: z.string(),
  /** The pipeline this is a change to, as the author's machine knows it. */
  pipelineId: z.string(),
  pipelineName: z.string(),
  /** The version the author started from, where the document says. */
  basedOn: z.number().int().positive().nullable().default(null),
  /**
   * What the record is on now — what the diff is against, and what
   * Approve adds one to.
   *
   * The published version where there is one, which is the design's own
   * wording, and the version the record is running where that pipeline
   * has not been published yet: on a server with nothing published,
   * that is the same fact under a different name, and a review screen
   * with no diff on it would be a decision made blind.
   */
  publishedVersion: z.number().int().positive().nullable().default(null),
  /** Null where the record has no version of that pipeline to compare against. */
  diff: VersionDiffSchema.nullable().default(null),
  /** The same lines the author's own needs check drew (ARCHITECTURE.md, "The needs check"). */
  needs: z.array(GalleryNeedSchema).default([]),
  /** By name, as `importPipeline` reports them: code from somebody else's machine that nobody here has read. */
  unapprovedModules: z.array(z.string()).default([]),
  /** Who suggested it. */
  author: z.string().nullable().default(null),
  /**
   * Why this cannot be approved as it stands, where something is wrong
   * with it — a module the record does not have, a document that will
   * not parse, a pipeline that has since been deleted.
   *
   * Read rather than discovered at the moment of approving, so that an
   * admin is told before they press the button rather than by it.
   */
  problem: z.string().nullable().default(null),
});
export type SuggestionView = z.infer<typeof SuggestionViewSchema>;
