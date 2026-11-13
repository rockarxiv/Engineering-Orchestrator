import { z } from "zod";
import { GitItemStateSchema, ItemReferenceSchema, ItemReviewersSchema } from "./itemExtensions.js";
import { ItemOriginSchema } from "./schemas/jobs.js";
import { AssistCardViewSchema } from "./schemas/assistCard.js";
import { CommentOptionSchema } from "./schemas/commentOptions.js";
import { ModuleChangeCardSchema } from "./schemas/moduleChange.js";
import { StepInputsSchema } from "./schemas/modules.js";
import { StepResultSchema } from "./schemas/pipelines.js";
import { ProposalSummarySchema } from "./schemas/proposalSummary.js";
import { WaitingOnSchema } from "./people.js";
import { SpecShapeSchema } from "./schemas/specShape.js";
import { StepHoldingItemsSchema } from "./stepHolds.js";
import { DEFAULT_WORKSPACE_MODE, WorkspaceModeSchema } from "./schemas/workspaces.js";
import { ItemWatchViewSchema, StepWatchSchema } from "./watch.js";

/*
 * Wire shapes for the domain IPC surface (F-05).
 *
 * Deliberately *not* the domain types from domain.ts and execution.ts.
 * Those describe rows; these describe what a screen needs, which is not
 * the same thing — a project card wants `needsAttention` and an open
 * dependency count, neither of which is a column. Keeping them separate
 * means the renderer never has to re-derive anything the main process
 * already knows, and a schema change here doesn't drag the DB along.
 */

/**
 * Where this item's work happens, as the card says it (EO-296, ARCHITECTURE.md, "The board").
 *
 * Three fields rather than a rendered string, because the badge is not
 * one shape: a branch name in mono, a base branch behind an eye glyph,
 * or the words "no disk". The renderer picks between those, and it can
 * only do that if it is told which kind answered and — for a git
 * workspace — which way round it is being used.
 *
 * Derived at query time from the item, its step and its project, never
 * stored: a step that switches to "Reads only" changes what every card
 * on it says, and a second column holding the old answer would be a
 * second thing to keep in step.
 */
export const WorkspaceBadgeSchema = z.object({
  /** The slug of the kind that prepares this item's runs — `git-worktree`, `none`, or whatever a pack contributed. */
  kind: z.string(),
  /** How a git workspace is used here. Null on a kind that has no modes, which is every other kind. */
  mode: WorkspaceModeSchema.nullable(),
  /**
   * What the badge reads.
   *
   * The item's branch in `isolated` mode — null until its first dispatch
   * cuts one — and the repository's base branch in `read` mode, which is
   * what an agent reading the checkout actually sees. Null for `none`,
   * where the badge is the words rather than a name.
   */
  label: z.string().nullable(),
});
export type WorkspaceBadge = z.infer<typeof WorkspaceBadgeSchema>;

export const ItemSummarySchema = z.object({
  id: z.string(),
  key: z.string(),
  /** The item type's slug, as a person reads it and as the Type filter matches it. */
  type: z.string(),
  /**
   * What that type is *called* — "Story", "Case" (EO-309, ARCHITECTURE.md, "What a pack labels").
   *
   * Beside the slug rather than instead of it, because the two answer
   * different questions: the slug is what the Type filter matches and
   * what a saved view holds, and the label is the word a row shows
   * beside its key on every cross-pipeline surface once a project's
   * work goes by more than one name.
   *
   * Denormalised onto the row rather than looked up in the registry by
   * the renderer, because `type` is a bare slug and two packs may both
   * ship a `case` (ARCHITECTURE.md, "An item type is data") — a lookup by word would answer with
   * whichever
   * pack's the map happened to hold.
   */
  typeLabel: z.string(),
  /**
   * Whether that type holds other items rather than being work itself
   * (KAN-146, ARCHITECTURE.md, "An item type is data").
   *
   * On the wire because the screen branches on it: the rail offers no
   * definition of done to write on a container, the Jira switch says it
   * cascades, and the delete dialog says the children go too. The flag
   * rather than a comparison with the word `feature`, so a project whose container is an
   * Epic gets the same three without the renderer learning the word.
   */
  container: z.boolean(),
  parentId: z.string().nullable(),
  /**
   * The feature this story belongs to, for the tag on its card (ARCHITECTURE.md, "One work
   * entity").
   *
   * A feature is shown as a label on the work it owns rather than as a row
   * spanning the columns — so the card needs its parent's name, and the
   * parent itself is not necessarily in the same result set.
   */
  parentKey: z.string().nullable(),
  parentTitle: z.string().nullable(),
  /** Which repo it belongs to. Null only for items written before any repository existed (D-04). */
  repositoryId: z.string().nullable(),
  /**
   * The repo's name, so a card can say which one without a second
   * lookup. Null when the item has no repository — a feature on a project
   * spanning several, or one written during onboarding (KAN-17).
   */
  repositoryName: z.string().nullable(),
  /** Which project it appears on, so following a link can switch to it (KAN-17). */
  projectId: z.string().nullable(),
  title: z.string(),
  /** Both null for a feature: a container is not on a pipeline (ARCHITECTURE.md, "One work entity"). */
  pipelineId: z.string().nullable(),
  stepId: z.string().nullable(),
  /**
   * The version of that pipeline it entered on, when that is not the
   * one the pipeline is on now (EO-327, ARCHITECTURE.md, "Publish, lock and versions").
   *
   * The number rather than the id, because what the card wears is a
   * mono chip reading "v6". **Null means "the current version"** — not
   * "unknown" — so a board that has never been edited carries nothing
   * extra on any of its cards, which is the ordinary case and should
   * cost nothing to draw.
   *
   * Defaulted, so a client that predates versions still reads a board.
   */
  pipelineVersion: z.number().int().positive().nullable().default(null),
  /**
   * What to call where this item is. The step's name — ids are uuids, so
   * nothing may render `stepId` — or, for a feature, how far its stories
   * have got, which is the only state a container has.
   */
  stepName: z.string(),
  /** How much of a feature's work is done. Null for anything that is work itself. */
  progress: z.object({ done: z.number(), total: z.number() }).nullable(),
  priority: z.number(),
  /**
   * What the git workspace knows about this item — its branch and its
   * pull request (KAN-169, ARCHITECTURE.md, "One work entity").
   *
   * The extension as a nested object, not two more top-level fields.
   * Three of the four workspace kinds the design adds cut no branch and open
   * no pull request, so a view that carried these flat would describe
   * every card in terms of the one kind that does; nested, an item with
   * no git state carries the defaults and a reader asks one question
   * rather than two.
   *
   * Beside `workspace` rather than instead of it: this is what is *true*
   * of the item, which the search box matches, and the badge is what the
   * card *shows*, which for a step that only reads the repository is the
   * base branch instead.
   */
  git: GitItemStateSchema,
  /**
   * Where its work happens, for the badge on its card (ARCHITECTURE.md, "The board", EO-296).
   */
  workspace: WorkspaceBadgeSchema,
  /** The mirrored Jira issue, and a link to it — null unless the repository is connected (J-02). */
  jiraKey: z.string().nullable(),
  jiraUrl: z.string().nullable(),
  updatedAt: z.number(),
  /**
   * When it arrived on the step it stands on, in epoch ms (EO-570).
   *
   * What the card's corner time counts from. Not `updatedAt`, which any
   * edit bumps — an assignee, a workspace, a Jira switch — so a card
   * whose item never moved would say it had just arrived. The latest
   * transition into the current step, or `createdAt` for an item that
   * has never moved, since creating one writes no transition.
   */
  stepEnteredAt: z.number(),
  /** When this item was manually parked; null means it is not held. */
  heldAt: z.number().nullable(),
  /**
   * Which job made it, if a job did (EO-304, EO-308, ARCHITECTURE.md, "What a job records").
   *
   * It began on the detail alone, on the rule that the rail is the only
   * thing that asks. Two readers ask now and both are on the board: a
   * card created by a job names it on hover with what that occurrence
   * cost, and the board filtered by job is exactly the cards whose
   * origin is that job. A filter the renderer cannot evaluate from the
   * rows it already has would have to be a second, differently-scoped
   * query — and the board's narrowing is a predicate over the summaries
   * everywhere else (`matchesBoardQuery`), so this is the field that
   * keeps it one mechanism.
   *
   * Null for an item a person filed themselves, which is most of them —
   * so nothing is drawn rather than "From: nothing".
   */
  origin: ItemOriginSchema.nullable(),
  /** Derived at query time, never stored (ARCHITECTURE.md, "Needs-attention is derived"). */
  needsAttention: z.boolean(),
  /**
   * Whether the step it is standing on is a terminal one (EO-384).
   *
   * Said by the main process, which is the only side that knows: a
   * step's name is a word a person chose and may change, and "terminal"
   * is judged by the version of the pipeline the item entered on
   * (EO-327), which the renderer does not hold. The chat rail adds this
   * up into a pipeline's planned and finished counts.
   *
   * False for a feature, which is on no step — how far a container has
   * got is `progress`.
   *
   * Defaulted, for `pipelineVersion`'s reason.
   */
  atTerminalStep: z.boolean().default(false),
  /** Dependencies not yet in a terminal state — why a ready-looking item isn't moving. */
  openDependencyCount: z.number(),
  /** The status of its most recent run, if it has ever run. */
  latestRunStatus: z.string().nullable(),
  /**
   * The watch on the step it stands on (EO-699): when it last checked,
   * when it checks next, and how many checks have failed in a row — the
   * same `item_watches` row the item page reads (`ItemDetail.watch`).
   *
   * A watching item spends nearly all its time between checks, and every
   * check that comes back `waiting` ends as a succeeded run, so without
   * this the card read `latestRunStatus` and said "Done" on work that is
   * still going on.
   *
   * Null on an item on a step that runs once, and on one whose watch has
   * not started on this stay. Optional as well, because the renderer does
   * not parse what a channel answers and a server older than this field
   * sends a summary without it.
   */
  watch: ItemWatchViewSchema.nullable().optional(),
  /**
   * Who is on it: the specific agent instance, not the role (ARCHITECTURE.md, "Vocabulary").
   *
   * `Orion`, not `Implementer` — two agents can staff one role, and which
   * of them picked an item up is a fact about the item. Null until
   * something has run; "EO" when the step was a built-in.
   */
  assigneeName: z.string().nullable(),
  /**
   * The *person* who has it, where a person has it (EO-305, ARCHITECTURE.md, "The board").
   *
   * Beside `assigneeName` rather than instead of it, because the card's
   * assignee slot says two different things on the two kinds of step: an
   * agent's name on an agent step — which is derived from the newest run
   * and belongs to the run — and a person's avatar on a human step,
   * which is `items.assignee_id` and belongs to the item. One field
   * carrying both would make "Nova" and "Anna" indistinguishable to
   * everything downstream, starting with the avatar.
   *
   * Null in solo mode even when the column holds the local person.
   * There is one person there, every card would wear the same face, and
   * EO-302 settled that solo mode displays no names: "the one person is
   * 'you' and nothing new is displayed". 7b's people list is what makes
   * this worth showing.
   */
  assigneePerson: z.object({ id: z.string(), name: z.string() }).nullable(),
  /**
   * The card offers "Claim" (EO-305, ARCHITECTURE.md, "The board", "Identity").
   *
   * True for an item on a human step that nobody holds, and false in
   * solo mode always — where every human step auto-assigns to the one
   * person there is, so a Claim button would be asking somebody to
   * become themselves. Computed in the main process rather than from
   * the three fields around it, so "is there a Claim here?" has one
   * answer and the test that says solo mode shows none can ask it.
   */
  claimable: z.boolean(),
  /**
   * This item is a preview (EO-313, ARCHITECTURE.md, "Preview").
   *
   * A boolean rather than `previewAt`, unlike `heldAt` beside it,
   * because nothing a person sees is about *when*: every reader draws
   * the same banner — "Preview. Nothing was sent, nothing cost money." —
   * on the card, on the detail and on an inbox row, and none of them has
   * a second thing to say if it knew the timestamp.
   *
   * On the summary rather than only on the detail, because the board is
   * where a preview is most easily mistaken for work: it sits in a
   * column beside real items, and the banner is what stops the green
   * tick on "post to Slack" reading as posted.
   */
  preview: z.boolean(),
});
export type ItemSummary = z.infer<typeof ItemSummarySchema>;

/** An EO-staged file that has not been assigned to a comment yet. */
export const AttachmentDraftSchema = z.object({
  id: z.string(),
  kind: z.enum(["image", "file"]),
  name: z.string(),
  mimeType: z.string(),
  size: z.number().int().nonnegative(),
});
export type AttachmentDraft = z.infer<typeof AttachmentDraftSchema>;

/** Durable attachment metadata safe to expose to the renderer (no local path). */
export const AttachmentViewSchema = AttachmentDraftSchema.extend({
  itemId: z.string(),
  /** Null for one of the item's own files rather than a comment's (EO-702). */
  commentId: z.string().nullable(),
  syncStatus: z.enum(["local", "pending", "synchronized", "error"]).optional(),
  syncError: z.string().nullable().optional(),
});
export type AttachmentView = z.infer<typeof AttachmentViewSchema>;

export const CommentViewSchema = z.object({
  id: z.string(),
  authorType: z.enum(["human", "agent", "engine", "module"]),
  /** Resolved for display — "you", the agent's name, "EO", or "a module" (EO-75). */
  authorName: z.string(),
  authorRole: z.string().nullable(),
  runId: z.string().nullable(),
  /** The comment this answers, if any — the UI nests it under that one (D-05). */
  parentId: z.string().nullable(),
  /** True for the newest decomposition proposal on a feature: the one whose approval creates items (R-04). */
  canApprove: z.boolean(),
  body: z.string(),
  kind: z.string(),
  options: z.array(CommentOptionSchema).nullable(),
  attachments: z.array(AttachmentViewSchema).optional(),
  pinned: z.boolean(),
  createdAt: z.number(),
  /** True while a mention on this comment is still waiting on the human. */
  awaitingHuman: z.boolean(),
  /** True once this comment and a Jira comment are the same comment — so deleting it here can offer to delete it there. */
  mirroredInJira: z.boolean(),
});
export type CommentView = z.infer<typeof CommentViewSchema>;

export const TransitionViewSchema = z.object({
  id: z.string(),
  fromStepId: z.string().nullable(),
  toStepId: z.string(),
  actor: z.string(),
  reason: z.string().nullable(),
  ts: z.number(),
});

/**
 * One check a run's workspace kind ran, as a screen reads it (EO-312).
 *
 * Three fields and no more: the mark, the sentence, and a key to list
 * them by. The evidence a check carried stays on `runs.verification`,
 * where the run detail screen already reads it — a rail row is one line
 * of type, and a git verification's step-by-step output is not.
 */
export const RunCheckSchema = z.object({
  key: z.string(),
  passed: z.boolean(),
  describes: z.string(),
});
export type RunCheckView = z.infer<typeof RunCheckSchema>;

export const RunViewSchema = z.object({
  id: z.string(),
  /** Null on a `builtin` run: EO acted, so there is no agent to name. */
  agentId: z.string().nullable(),
  agentName: z.string(),
  /** What routing and comparisons read: a module run's is the module's id, which is no use to a person. */
  action: z.string(),
  /** `action` as a person reads it: a module's name, and `action` itself on every other run. */
  actionName: z.string(),
  status: z.string(),
  attempt: z.number(),
  /**
   * The provider session this run spoke on, once one exists.
   *
   * Carried forward when a reply resumes a parked run, which is what
   * makes two `runs` rows one conversation on screen. A fresh dispatch
   * always opens its own session, so a shared thread id never means two
   * unrelated runs.
   */
  threadId: z.string().nullable(),
  error: z.string().nullable(),
  /** Total input, cache included, summed over every turn the run took. */
  tokensIn: z.number().nullable(),
  tokensOut: z.number().nullable(),
  /** The share of `tokensIn` that came back out of the prompt cache. */
  cacheReadTokens: z.number().nullable(),
  cacheWriteTokens: z.number().nullable(),
  /** Model turns — what every token of the dispatch prompt was paid over. */
  turns: z.number().nullable(),
  /** Whether `turns` counts this run alone or the whole conversation — they aggregate differently. */
  turnsScope: z.enum(["turn", "session"]).nullable(),
  costCents: z.number().nullable(),
  startedAt: z.number().nullable(),
  endedAt: z.number().nullable(),
  /** G-02's verdict, when the run had one. */
  verificationOk: z.boolean().nullable(),
  /**
   * What the workspace kind checked, with a mark each (EO-312, ARCHITECTURE.md, "The item").
   *
   * The sidebar's step block lists these, which is the other half of
   * invariant 5's "say what you checked": `verificationOk` is the
   * verdict, and a verdict on its own tells a person nothing about what
   * was looked at. Empty on a run nothing checked and on one written
   * before the column — the same answer, because there is nothing to
   * show either way.
   *
   * Defaulted, so a client that predates the field still reads a run.
   */
  checks: z.array(RunCheckSchema).default([]),
  /**
   * Whether this run's backend can be spoken to mid-turn (EO-176).
   *
   * A fact about the provider, answered here rather than derived in the
   * renderer, because the renderer knowing which backends have
   * `InterruptibleStream.steer` would be a second copy of a decision
   * that already lives beside the providers — and the one that goes
   * stale the day a backend gains the capability.
   *
   * Says nothing about whether the run is *live*: that is `status`, and
   * a composer needs both. A run of a backend that cannot be steered is
   * still worth writing to; the message is queued for the next turn, and
   * what this decides is whether a person is offered a choice about it
   * or told a sentence instead.
   */
  steerable: z.boolean(),
});
export type RunView = z.infer<typeof RunViewSchema>;

/**
 * One decision offered on the item detail (EO-310, ARCHITECTURE.md, "The item").
 *
 * `StepResult` plus where it goes. The destination is resolved on this
 * side — by the same `resolveRoute` the engine takes when the decision
 * is made, so the button cannot promise one column and the transition
 * land in another.
 */
export const StepDecisionSchema = StepResultSchema.extend({
  /**
   * What the button says after the arrow: "Approve → Post to Slack".
   *
   * Null where there is nothing to name — a result that parks the item
   * and asks a person, or one whose route is missing, which
   * `validatePipeline` refuses but a hand-edited graph can still hold.
   */
  targetName: z.string().nullable(),
});
export type StepDecision = z.infer<typeof StepDecisionSchema>;

/**
 * What the item has produced, as the editor above the thread draws it
 * (EO-311, ARCHITECTURE.md, "The output is a comment", "The item").
 *
 * The current output comment — derived, never stored (invariant 6) —
 * flattened into the four things a screen needs of it: what it says, who
 * wrote it, what it *is*, and the files it carries. The comment is in
 * `comments` too, and the thread draws it there like any other; this is
 * the same row lifted to the top of the page, because the deliverable is
 * what a person opened the item to read and scrolling a thread for it is
 * how it stayed buried.
 */
export const ItemOutputSchema = z.object({
  /** The comment this is, so an edit can say what it supersedes and the thread can be scrolled to it. */
  commentId: z.string(),
  body: z.string(),
  /**
   * What the panel draws, and what it may offer to edit.
   *
   * `file` where the run produced documents rather than text — they ride
   * on the comment as attachments (EO-299) and the body names them.
   * `diff` where the body is the fenced diff the git workspace posts,
   * which renders as today's diff view and is not edited here (EO-311 is
   * explicit that editing a diff is out of scope). `text` is everything
   * else: the report, the reply, the thing a person corrects.
   */
  format: z.enum(["text", "diff", "file"]),
  /** Who produced it — an agent's name, "you" for a person's correction, "EO" for one of its own functions. */
  authorName: z.string(),
  authorType: z.enum(["human", "agent", "engine", "module"]),
  createdAt: z.number(),
  attachments: z.array(AttachmentViewSchema),
  /** The output this one displaced, if it displaced one — still in the thread, under it. */
  supersedesCommentId: z.string().nullable(),
});
export type ItemOutput = z.infer<typeof ItemOutputSchema>;

export const ItemDetailSchema = z.object({
  item: ItemSummarySchema.extend({
    body: z.string().nullable(),
    acceptanceCriteria: z.array(z.string()),
    /**
     * Which item type this is, by the pack and the word —
     * `qualifiedItemType`, the key `Registry.itemTypes` is keyed by
     * (KAN-147).
     *
     * `type` above is the bare slug, which is what a person reads and
     * what every comparison used to be. It is not an *identity*: two
     * packs may ship a `case` (ARCHITECTURE.md, "An item type is data"), and the detail needs the
     * exact row
     * to draw the right fields — a slug with two answers would either
     * draw nothing or draw somebody else's shape into an editor that
     * then offers to write fields this item does not have.
     *
     * The qualified key rather than the row id, because the renderer's
     * registry is keyed by it: the row id is the database's identity and
     * `registry:get` does not carry it.
     */
    typeKey: z.string(),
    /**
     * The item's structured fields, whatever its type's shape declares
     * (KAN-147).
     *
     * On the detail and not on `ItemSummarySchema`, for the reason
     * `jiraSync` is: the rail is the only thing that asks. A board card
     * shows a title and where the work is, and a customer and a channel
     * on every card would be a form where a card should be.
     *
     * Open JSON rather than a named set of fields, because which fields
     * exist is the type's to say — the renderer draws them from the
     * shape it already holds through `registry:get`, and a field EO
     * knows nothing about has to reach it to be drawn at all.
     */
    spec: z.record(z.string(), z.unknown()).nullable(),
    createdAt: z.number(),
    /**
     * The item's own files (EO-702): a mock it is built against, a spec
     * PDF, a screenshot of the bug — part of what the item is, as its
     * description is. Owned by no comment, so they are not anything
     * anybody said, and no comment's deletion or trimming takes them.
     * Comment files stay on their comments.
     */
    attachments: z.array(AttachmentViewSchema).default([]),
    /**
     * Whether this item talks to Jira at all (EO-122).
     *
     * On the detail and not on `ItemSummarySchema`, because the rail
     * is the only thing that asks. A board card already shows the key
     * when there is one, and a second Jira mark on every card would be
     * decoration; the rail needs it because the rail is where the
     * switch is thrown (EO-125), and a control that cannot show its own
     * state is one you have to guess at.
     */
    jiraSync: z.boolean(),
    /**
     * Whether this item's repository names a Jira site at all (J-01).
     *
     * What decides whether the rail offers a link to attach (EO-126).
     * `jiraUrl` cannot answer it: that is null for every item without
     * a key, connected repository or not, and an item with no key on a
     * connected repository is exactly the one that needs somewhere to
     * type one. With no connection the whole row is absent — an Attach
     * button there would offer an act that could not work.
     */
    jiraConnected: z.boolean(),
    /**
     * The outside issue this item's work is filed under, as it takes
     * effect — its own Reference, or its parent feature's when it has
     * none — and which of the two it is (EO-637). Null when neither
     * names one.
     *
     * On the detail and not on `ItemSummarySchema`, for `jiraSync`'s
     * reason: the rail is where it is read and set. The item's own value
     * alone is `git.reference`.
     */
    reference: ItemReferenceSchema.nullable().default(null),
    /**
     * Who is asked to review this item's pull request, as it takes
     * effect — its own list, its parent feature's, or the repository's
     * default — and which of the three it is (EO-742). Null only from a
     * main process that predates it. The item's own list alone is
     * `git.reviewers`.
     */
    reviewers: ItemReviewersSchema.nullable().default(null),
  }),
  /**
   * What a person may decide right now (EO-310, ARCHITECTURE.md, "The item").
   *
   * The step's declared results, each already resolved through the
   * routes to the name of where it sends the item — which is what makes
   * the button read "Approve → Post to Slack" without the detail screen
   * having to load the pipeline graph and walk it. Empty on every item
   * that is not sitting on a human step with a decision to make, which
   * is what a developer's board is throughout.
   *
   * Derived per request rather than stored: it is the step's data, not
   * the item's, and an item whose step gained a result a moment ago has
   * it on the next read.
   */
  decision: z.array(StepDecisionSchema).default([]),
  /**
   * What this item has produced, where a person may act on it (EO-311,
   * ARCHITECTURE.md, "The output is a comment", "The item").
   *
   * Null on every item that has produced nothing — and on every item on
   * an *agent* step, which is the same gate `decision` above takes and
   * for the same reason: the deliverable is offered where somebody may
   * do something about it. While an agent holds the item the output is
   * its working copy, and an editor over it would be a second writer on
   * a document a run is still producing; the thread still shows every
   * output comment there is, so nothing is hidden by this.
   *
   * Derived per request rather than stored (invariant 6): it is the
   * latest output comment, by the one definition `currentOutputOf`
   * holds, so an item whose agent posted one a moment ago has it on the
   * next read.
   */
  currentOutput: ItemOutputSchema.nullable().default(null),
  comments: z.array(CommentViewSchema),
  transitions: z.array(TransitionViewSchema),
  runs: z.array(RunViewSchema),
  // `stepName` travels with the dependency rather than being looked up by
  // the renderer: a dependency may sit in a different pipeline, whose steps
  // this item's detail never loaded.
  dependsOn: z.array(z.object({ id: z.string(), key: z.string(), title: z.string(), stepId: z.string().nullable(), stepName: z.string() })),
  /**
   * The watch on the step this item stands on, when that step keeps
   * checking (EO-456): when the last check ran, when the next is due and
   * when EO gives up. Null on every other item, and on one whose watch
   * has not run its first check yet.
   */
  watch: ItemWatchViewSchema.nullable().default(null),
  attachmentSync: z.object({ pending: z.number(), error: z.string().nullable() }).optional(),
});
export type ItemDetail = z.infer<typeof ItemDetailSchema>;

/**
 * How many of an item's newest comments the item page is sent (EO-559);
 * older ones are read a page of this size at a time, on demand.
 */
export const ITEM_COMMENTS_PAGE = 100;

/**
 * One item as the screens read it (`items:get`, EO-559): the detail with
 * only the newest `ITEM_COMMENTS_PAGE` comments, and how many came before
 * them. A live thread can be megabytes, and the item page is read again
 * on every push; older pages are read through `items:earlierComments`
 * when somebody asks for them. `item_get` is not this — it reads the
 * whole thread through `items:getSections`.
 */
export const ItemPageSchema = ItemDetailSchema.extend({
  /** How many comments are older than the oldest one in `comments`. */
  earlierComments: z.number().int().nonnegative(),
});
export type ItemPage = z.infer<typeof ItemPageSchema>;

/**
 * Part of one item, as `items:getSections` answers (EO-540).
 *
 * `ItemDetailSchema` with every part optional and no defaults: a part
 * left out is absent, not filled in with an empty list a reader would
 * take for "there are none". The keys are in `ItemDetailSchema`'s order,
 * because a parse answers in its schema's order and a call that names
 * nothing has to be the very answer `items:get` gives. `item`, `watch` and `attachmentSync` are
 * the `ticket` part; `comments` and `currentOutput` the `comments` part;
 * the rest are named as they are asked for.
 */
export const ItemSectionsSchema = z.object({
  item: ItemDetailSchema.shape.item.optional(),
  decision: z.array(StepDecisionSchema).optional(),
  currentOutput: ItemOutputSchema.nullable().optional(),
  comments: ItemDetailSchema.shape.comments.optional(),
  transitions: ItemDetailSchema.shape.transitions.optional(),
  runs: ItemDetailSchema.shape.runs.optional(),
  dependsOn: ItemDetailSchema.shape.dependsOn.optional(),
  watch: ItemWatchViewSchema.nullable().optional(),
  attachmentSync: ItemDetailSchema.shape.attachmentSync,
});
export type ItemSections = z.infer<typeof ItemSectionsSchema>;

export const RunEventViewSchema = z.object({
  seq: z.number(),
  ts: z.number(),
  type: z.string(),
  payload: z.unknown(),
});

/**
 * One run across items, as `runs:list` answers (EO-541) — or one side
 * call, which is spend too and is listed beside the runs under the action
 * `side_call:<purpose>` so the two add up.
 *
 * The figures a person asks "how long did this take, and what did it
 * cost" with, and nothing of the transcript: `run_events` is where a
 * run's log is read, a page at a time.
 */
export const RunRecordSchema = z.object({
  id: z.string(),
  /** `run`, or `side_call` for one of EO's own short model calls (`side_calls`). */
  kind: z.enum(["run", "side_call"]),
  /** Null only on a side call about no item — a memory consolidation. */
  itemId: z.string().nullable(),
  itemKey: z.string().nullable(),
  projectId: z.string().nullable(),
  /** The run's action — `implement`, `review` — or `side_call:<purpose>`. */
  action: z.string(),
  /**
   * The backend that ran it, `claude` or `codex`, as the run recorded when
   * it was dispatched — not its agent's today. Null on a step EO ran
   * itself, and on a run that never named one.
   */
  backend: z.string().nullable(),
  /**
   * The model it was answered by. A run's is what its own log says — the
   * newest `thread_started` or `usage` event naming one — and never its
   * agent's configured model, which may have changed since; null where
   * the log names none, as on a builtin step or a run from before EO-392.
   * A side call's is the model it asked for, null for the backend's default.
   */
  model: z.string().nullable(),
  /** A run's status; a side call's outcome, `succeeded` or `failed`. */
  status: z.string(),
  startedAt: z.number().nullable(),
  endedAt: z.number().nullable(),
  /** `endedAt - startedAt`; null until the run has both. */
  durationMs: z.number().nullable(),
  tokensIn: z.number().nullable(),
  tokensOut: z.number().nullable(),
  cacheReadTokens: z.number().nullable(),
  cacheWriteTokens: z.number().nullable(),
  /** Whole cents. A side call costs a fraction of one, so sum `costMicrocents` rather than this. */
  costCents: z.number().nullable(),
  /** The same cost in millionths of a cent (EO-510), exact for a side call too — what to add up. */
  costMicrocents: z.number().nullable(),
  turns: z.number().nullable(),
  /** Whether `turns` counts this run alone (`turn`) or the whole conversation (`session`). */
  turnsScope: z.enum(["turn", "session"]).nullable(),
  /** Null on a side call, which has no retries. */
  attempt: z.number().nullable(),
  threadId: z.string().nullable(),
  /** What cut the run short without it failing — `quit` or `restart`. */
  interruption: z.string().nullable(),
  /** A review's verdict — `approve`, `reject` or `needs_user_input`. Null on a run that returned none. */
  verdict: z.string().nullable(),
  /**
   * How many memory entries the run was given — the distinct ids of its
   * own `memory_delivered` events — and how many of them its answer said
   * it relied on (EO-597, `memoryUsed`, less what it was not given). Null
   * on a side call, which is given no memory.
   */
  memoryDelivered: z.number().int().nonnegative().nullable(),
  memoryUsed: z.number().int().nonnegative().nullable(),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

/** What `runs:summary` adds up for a group of runs, and for all of them (EO-541). */
export const RunTotalsSchema = z.object({
  count: z.number(),
  /** The sum of the runs' durations, in minutes: time something was working. */
  activeMinutes: z.number(),
  /** From the first start to the last end, in minutes: time the work took. Null until one has ended. */
  elapsedMinutes: z.number().nullable(),
  tokensIn: z.number(),
  tokensOut: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  /** Whole cents, rounded once after the side calls' fractions are summed. */
  costCents: z.number(),
  /** Runs that returned a review verdict, and how many of those rejected. */
  reviews: z.number(),
  rejections: z.number(),
});
export type RunTotals = z.infer<typeof RunTotalsSchema>;

/**
 * One group of `runs:summary` (EO-541). `key` is the item's key, the
 * action, the backend or the local day (`YYYY-MM-DD`) — null for runs
 * that have none: a builtin's backend, a run not yet started's day, a
 * side call about no item.
 */
export const RunGroupSchema = RunTotalsSchema.extend({
  key: z.string().nullable(),
  /** The item, when grouped by item. */
  itemId: z.string().nullable(),
});
export type RunGroup = z.infer<typeof RunGroupSchema>;

export const InboxItemSchema = z.object({
  commentId: z.string(),
  itemId: z.string(),
  itemKey: z.string(),
  itemTitle: z.string(),
  /** What kind of thing the row is about — "Story", "Case" (EO-309). See `ItemSummary.typeLabel`. */
  itemTypeLabel: z.string(),
  itemState: z.string().nullable(),
  authorName: z.string(),
  body: z.string(),
  kind: z.string(),
  options: z.array(CommentOptionSchema).nullable(),
  createdAt: z.number(),
  /**
   * The item's run is parked waiting for this answer, so nothing on it
   * moves until you reply. An FYI mention is worth showing but not worth
   * interrupting anyone over — U-04 notifies on blocking only.
   */
  blocking: z.boolean(),
  /**
   * Which of the design's three sentences this row reads (EO-305).
   *
   * Who holds the *item*, not who the mention names: the inbox lists
   * what was asked of you, so the mention target is you on every row
   * here and would say nothing. "Waiting on Anna" is the row that tells
   * you the work is in somebody's hands while you were copied in, and
   * "Unclaimed" is the one that tells you it is in nobody's.
   */
  waitingOn: WaitingOnSchema,
  /**
   * This row belongs to a preview (EO-313, ARCHITECTURE.md, "Preview").
   *
   * The row is here at all because a preview that walks onto a human
   * step has to be answerable — leaving it out of the list would stop
   * the preview walking, which is the one thing it exists to do. What
   * it is left out of is the *counts* beside the list, and this is what
   * lets the row wear the banner that says so.
   */
  preview: z.boolean(),
});
export type InboxItem = z.infer<typeof InboxItemSchema>;

/**
 * One unaddressed mention, as somebody outside it reads it (EO-326,
 * ARCHITECTURE.md, "Identity").
 *
 * An inbox row plus the two things a reader of *their own* inbox never
 * needs told: which project it is on, and — through `waitingOn`, which
 * an inbox row already carries but resolves against the reader — whose
 * hands the work is in. An admin scanning every project has neither
 * fact to hand, and "SUP-31 · waiting on Anna" is the whole of what the
 * view is for: not a queue to work through, but a list of who to go and
 * talk to.
 *
 * Extended from `InboxItemSchema` rather than written out, so a field
 * the inbox gains is a field this gains. The two lists are the same
 * rows read from two places, and letting them drift would be two
 * answers to "what is unaddressed".
 */
export const OpenMentionViewSchema = InboxItemSchema.extend({
  projectId: z.string().nullable(),
  /** The project's name, or null for an item on no project at all. */
  projectName: z.string().nullable(),
});
export type OpenMentionView = z.infer<typeof OpenMentionViewSchema>;

/** What the inbox needs to say beyond the items themselves (U-04). */
export const InboxSummarySchema = z.object({
  /**
   * How many open mentions are waiting on you.
   *
   * Previews are not among them (EO-313, ARCHITECTURE.md, "Preview"): a badge that counted
   * one would be EO interrupting somebody over an item it had just
   * promised them was not real.
   */
  openCount: z.number(),
  blockingCount: z.number(),
  /**
   * Every item that could be moving is waiting on you — the pipeline
   * is idle, which deserves saying loudly rather than being inferred
   * from an empty project.
   */
  everythingBlocked: z.boolean(),
});
export type InboxSummary = z.infer<typeof InboxSummarySchema>;

export const AgentViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string(),
  provider: z.string(),
  model: z.string().nullable(),
  enabled: z.boolean(),
  /**
   * When this agent was retired, or null (EO-186).
   *
   * On the wire rather than filtered out of the listing, because the
   * listing answers two questions at once: which agents a picker may
   * offer, and what an agent that ran something was called. A retired
   * agent's runs and comments are still there to be read — that is the
   * whole reason the row was kept — so the name has to resolve, and a
   * picker filters on this instead.
   */
  archivedAt: z.number().nullable(),
});

export type AgentView = z.infer<typeof AgentViewSchema>;

/**
 * One step of a pipeline, as the renderer sees it (KAN-59).
 *
 * `type`, `name`, `instructionsSummary` and `opensPullRequest` are on the
 * wire now, unlike the state view this replaced: the configuration screen
 * edits all four, and a field the editor cannot see is a field a save
 * would quietly destroy.
 */
export const PipelineStepViewSchema = z.object({
  id: z.string(),
  pipelineId: z.string(),
  position: z.number(),
  name: z.string(),
  /** Who acts here: a role, a person, EO itself, or a module (`PipelineStepType`). */
  type: z.enum(["agent", "user", "builtin", "module"]),
  ownerRole: z.string().nullable(),
  /** The agent action, the builtin function, or the module's id. Null on a `user` step. */
  entryAction: z.string().nullable(),
  instructionsSummary: z.string().nullable(),
  isTerminal: z.boolean(),
  /** Ask this step to plan before it writes anything (KAN-18, ARCHITECTURE.md, "A step"). */
  planMode: z.boolean(),
  /**
   * Whether this step works on a branch of its own or reads the
   * repository as it stands (EO-296, ARCHITECTURE.md, "The four kinds").
   *
   * Defaulted for the reason `inputs` is — a client that predates the
   * field still saves a graph — and absent therefore means `isolated`,
   * which is what every step did before modes existed.
   */
  workspaceMode: WorkspaceModeSchema.default(DEFAULT_WORKSPACE_MODE),
  /**
   * Which of the project's workspaces this step runs on (EO-301, ARCHITECTURE.md, "A workspace is a
   * kind, attached to the project").
   *
   * An id, `NO_WORKSPACE` for "no disk", or null for "whatever the
   * ticket is on" — `stepWorkspaceChoice` reads the three apart, and
   * nothing else should.
   *
   * Defaulted for the reason `inputs` is: a client that predates the
   * picker still saves a graph, and absent means the step inherits,
   * which is what every step did before it could pick. That is the one
   * default here that is load-bearing rather than polite — a schema
   * that demanded a value would make an older client's save silently
   * move every step onto no disk at all.
   */
  workspaceId: z.string().nullable().default(null),
  /**
   * What this step sets for the inputs its module declares (EO-78).
   *
   * Part of the graph document rather than a channel of its own, unlike
   * a secret: a value here is ordinary configuration, it is edited in
   * the same draft as the module that reads it, and it is published by
   * the same click. That is also what makes changing a step's module
   * discard the values the new one does not declare — both halves of
   * that happen in one save rather than in two writes with a window in
   * between. A secret cannot work this way, because it lives in the
   * keychain and never crosses back.
   *
   * Defaulted, so a client that has never heard of inputs still saves a
   * graph. Absent therefore *clears* rather than preserves — the same
   * wholesale-document rule every other field on this channel follows.
   */
  inputs: StepInputsSchema.default({}),
  /**
   * How long this step's module may run before EO stops it (EO-162).
   *
   * Milliseconds, null for EO's default. Positive rather than
   * non-negative: zero would be a step that cannot run at all, which is a
   * way of disabling a step by mistyping a number rather than a setting
   * anybody means.
   *
   * Defaulted for the reason `inputs` is — a client that predates this
   * field still saves a graph — and absent therefore clears, which is the
   * wholesale-document rule this channel already follows.
   */
  timeoutMs: z.number().int().positive().nullable().default(null),
  /**
   * Keep checking: run a short check every N minutes until it reports a
   * result, giving up after H hours (EO-456, ARCHITECTURE.md, "A step").
   *
   * Null for a step that runs once. Part of the graph rather than local
   * tuning like `timeoutMs`: whether a step waits on something outside
   * EO is what the step *is*, and a template that watches a pull request
   * has to arrive watching.
   *
   * Defaulted *on this view*, which is what EO answers with: a graph
   * read from an older server still parses. A save does not take this
   * schema's reading of absent — see `PipelineStepSaveSchema`, where
   * absent keeps the step's setting rather than clearing it (EO-506).
   */
  watch: StepWatchSchema.nullable().default(null),
  /**
   * What a person may decide on a human step (EO-310, ARCHITECTURE.md, "Results and routes").
   *
   * On the wire because the editor authors them: a result is the button
   * a person presses and the key a route out of this step names, and
   * `validatePipeline` holds the two to each other — so a screen that
   * could draw the route and not the result would be a screen that can
   * only produce pipelines the validator refuses.
   *
   * Defaulted, so a client that has never heard of a decision still
   * saves a graph. Absent therefore clears, which is this channel's
   * wholesale-document rule — and is right here for a reason the other
   * defaults do not have: routes are rewritten wholesale by the same
   * save, so results that survived a save which dropped their routes
   * would be a step offering buttons that go nowhere.
   */
  results: z.array(StepResultSchema).default([]),
  /**
   * Which version of its module a `module` step runs (EO-770): a
   * `module_versions.number`. Null on every other step.
   *
   * On a save, absent or null on a module step pins the module's newest
   * approved version (its newest version where none is approved), so a
   * caller that names only a module gets the code a person approved.
   */
  moduleVersion: z.number().int().positive().nullable().default(null),
});

/**
 * One step of a graph somebody is saving or validating (EO-506).
 *
 * The view, with one field read differently: `watch` left out *keeps*
 * the step's keep-checking settings rather than clearing them, and an
 * explicit `null` is what turns them off.
 *
 * Every other defaulted field on the view clears when absent, and
 * `watch` did too — which is how an agent that read a pipeline over MCP,
 * changed one route and republished it turned "Watching pull request"
 * into a step that runs once and parks every item reaching it. The
 * editor always sends the field, so for the configuration screen nothing
 * changes; what changes is that a caller who never meant to touch it
 * cannot turn it off by not mentioning it. A step the save creates has
 * nothing to keep, and runs once unless the save says otherwise.
 */
export const PipelineStepSaveSchema = PipelineStepViewSchema.extend({
  watch: StepWatchSchema.nullable()
    .optional()
    .describe(
      "Keep checking: { everyMinutes, giveUpAfterHours } runs this builtin or module step's check every N minutes until it reports a result, " +
        "giving up after H hours (a week when left out); neverGivesUp: true keeps checking until it has a result, however long that takes. " +
        "null makes the step run once. Leave the field out to keep the step's current setting.",
    ),
});

/** Where one declared result of a step sends the item. */
export const StepRouteViewSchema = z.object({
  id: z.string(),
  pipelineId: z.string(),
  fromStepId: z.string(),
  resultKey: z.string(),
  label: z.string(),
  tone: z.enum(["success", "warning", "info", "danger"]),
  /**
   * A step id in this pipeline, a step id in another one of the project's
   * pipelines (EO-58's hand-off), or `user_attention` / `terminal`.
   */
  target: z.string(),
  position: z.number(),
});

/**
 * Another pipeline of this project, and the steps of it a route may hand
 * work to (EO-58, EO-69).
 *
 * Grouped by pipeline rather than flattened because the names collide —
 * "Merge" is a step of the Delivery pipeline and the name of the pipeline
 * that merges — and a bare list would make the two indistinguishable at
 * the one moment somebody is choosing between them.
 */
export const HandOffTargetsSchema = z.object({
  pipelineId: z.string(),
  pipelineName: z.string(),
  steps: z.array(PipelineStepViewSchema),
});

/**
 * What one step would take with it if it were removed (EO-167).
 *
 * The three things that make removing a step more than deleting a row,
 * and each of them asks for a different sentence: work sitting on it is
 * moved, a run in flight on it is stopped, and a hand-off from another
 * pipeline is repointed by whoever owns that pipeline. A step with none
 * of the three is simply removable, which is why the editor is given
 * these rather than a boolean — a refusal has to say what it is about.
 */
export const StepHoldSchema = z.object({
  stepId: z.string(),
  /** Every item whose `stepId` is this step, archived ones included — the foreign key does not care. */
  items: z.number().int(),
  /** Of those, the ones an agent is working on right now. */
  running: z.number().int(),
  /**
   * Of those, the ones in the Archive (EO-230). Counted in `items`
   * because the foreign key holds for them too, and separated because
   * the board cannot show them: the refusal offers the Archive for
   * these and the board for the rest, rather than one door that opens
   * onto nothing.
   */
  archived: z.number().int(),
  /** Routes from other pipelines that land here (EO-58); named by the pipeline that declares them. */
  routesIn: z.array(z.object({ pipelineName: z.string(), label: z.string() })),
});

export const PipelineViewSchema = z.object({
  id: z.string(),
  projectId: z.string().nullable(),
  name: z.string(),
  icon: z.string().nullable(),
  /**
   * Where an item assigned to this pipeline lands (ARCHITECTURE.md, "Vocabulary"). Null only while
   * a pipeline has no steps yet; the validator refuses to publish one.
   */
  entryStepId: z.string().nullable(),
  position: z.number(),
  /** Set once deleted. The Archive is where a deleted pipeline remains visible. */
  archivedAt: z.number().nullable(),
});

export type PipelineStepView = z.infer<typeof PipelineStepViewSchema>;
export type PipelineStepSave = z.infer<typeof PipelineStepSaveSchema>;
export type StepRouteView = z.infer<typeof StepRouteViewSchema>;
export type HandOffTargets = z.infer<typeof HandOffTargetsSchema>;
export type StepHold = z.infer<typeof StepHoldSchema>;
export type PipelineView = z.infer<typeof PipelineViewSchema>;
export type RunEventView = z.infer<typeof RunEventViewSchema>;
export type TransitionView = z.infer<typeof TransitionViewSchema>;

/** @see MessageDelivery — the same two words, at the IPC boundary. */
export const MessageDeliverySchema = z.enum(["now", "next"]);

/**
 * What became of a message meant for a live agent (EO-176).
 *
 * Both halves are answered because they can differ, and the difference
 * is the whole point: a turn that ended between Send and the push landed
 * is not a failure, but the person must not be left thinking their
 * message reached an agent that never saw it. `outcome` is what
 * happened; `note` is the sentence saying so when it is not what was
 * asked for, and null when it is (invariant #8 says once, not twice).
 */
export const CommentDeliverySchema = z.object({
  requested: MessageDeliverySchema,
  /**
   * `pending` when the backend had not answered by the time the person
   * was (EO-558): the delivery goes on without them, and its mention
   * stays open until it lands, so a turn that misses it still reads it.
   */
  outcome: z.enum(["now", "next", "pending"]),
  note: z.string().nullable(),
});
export type CommentDelivery = z.infer<typeof CommentDeliverySchema>;

/** Mentions are given as tokens ("user", "reviewer"); the main process resolves them (A-03). */
export const PostCommentInputSchema = z.object({
  itemId: z.string(),
  body: z.string().default(""),
  attachmentIds: z.array(z.string()).max(8).optional(),
  mentions: z.array(z.string()).default([]),
  pinned: z.boolean().default(false),
  /** Files this as a reply to that comment, so an answer stays attached to its question (D-05). */
  parentId: z.string().nullable().default(null),
  /**
   * Say this to the agent that is working on the item right now
   * (EO-176).
   *
   * On the comment path rather than in a channel of its own, the way
   * `assist:send` carries `interrupt`: comments are the only way
   * anything in EO talks to anything else (invariant #4), and a second
   * channel for saying something to an agent would be a side channel by
   * definition. So this does not change what is written — a human
   * comment is posted either way, before anything is delivered — only
   * whether EO then pushes it into the turn that is running.
   *
   * Absent means what it has always meant: post the comment and let the
   * mention decide what happens next.
   */
  delivery: MessageDeliverySchema.optional(),
});

/** Full agent record for the settings screen — includes what the project view omits. */
export const AgentDetailSchema = AgentViewSchema.extend({
  /**
   * How many pipelines have a step this agent's role owns (KAN-67).
   *
   * Meaningful only now that there are several: a role can be referenced
   * from steps across any number of pipelines, and "Pipelines: 2" is how
   * the Agents screen says that disabling this one stops work in two
   * places rather than one.
   */
  pipelineCount: z.number().int().nonnegative(),
  instructions: z.string(),
  /**
   * The prompt this build of EO ships for the role, or null for a role it
   * has no prompt for.
   *
   * EO brings an unedited prompt up to this on launch by itself (R-01).
   * It is carried here for the case it deliberately will not touch: an
   * agent whose instructions somebody edited keeps them (U-06), and the
   * editor offers the new default rather than leaving them stranded on a
   * version they cannot see.
   */
  defaultInstructions: z.string().nullable(),
  /**
   * Whether this is a role EO ships, rather than one somebody invented
   * (EO-178).
   *
   * On the wire because the editor acts on it: the settings EO has
   * already decided for its own roles are not drawn for them, and the
   * editor cannot be the thing that decides which roles those are.
   *
   * Explicit rather than read off `defaultInstructions !== null`, which
   * answers the same question today and answers it by accident — that
   * field says "EO ships a prompt for this role", and the two part
   * company the day a shipped role arrives without one.
   */
  builtin: z.boolean(),
  config: z.record(z.string(), z.unknown()),
  /**
   * The project this agent works for, or null for a global agent
   * (EO-474). Defaulted so a listing from before the column reads as
   * what it was: every agent global.
   */
  projectId: z.string().nullable().default(null),
});
export type AgentDetail = z.infer<typeof AgentDetailSchema>;

/**
 * What archiving or deleting an agent would take away, said before it
 * happens (EO-350).
 *
 * `agents:archive` and `agents:delete` both answer with this until the
 * call confirms, the way `items:delete` answers with a refusal naming
 * the run it would cancel. It replaced archive's outright refusal: being
 * the last agent on a role a step is owned by is something a person is
 * told and decides about, not something EO decides for them.
 */
export const AgentRemovalImpactSchema = z.object({
  agentName: z.string(),
  role: z.string(),
  /** Every agent step, in every live pipeline, owned by this agent's role. */
  steps: z.array(z.object({ stepId: z.string(), stepName: z.string(), pipelineId: z.string(), pipelineName: z.string() })),
  /**
   * Whether `steps` are left with nobody once this agent goes: it is the
   * last enabled, non-preview agent on the role, and the role owns at
   * least one step. Never true of a disabled or preview agent, because
   * neither staffs anything to begin with (EO-316).
   */
  leavesStepsWithNobody: z.boolean(),
  /** The other enabled, non-preview agents on the role — who still covers `steps`. */
  coveredBy: z.array(z.string()),
  /** Runs by this agent in progress now, and the item each is on. Confirming cancels them as `superseded`. */
  activeRuns: z.array(z.object({ runId: z.string(), itemId: z.string(), itemKey: z.string(), itemTitle: z.string() })),
  /** The last enabled system agent: the Assistant and Discussions would have nobody to answer them. */
  lastSystemAgent: z.boolean(),
});
export type AgentRemovalImpact = z.infer<typeof AgentRemovalImpactSchema>;

/** The bounds of `runMemoryMaxMb` (EO-738): below 256 MB no agent CLI starts, and 1 TB is past any desktop. */
export const RUN_MEMORY_MIN_MB = 256;
export const RUN_MEMORY_MAX_MB = 1_048_576;

export const GuardConfigSchema = z.object({
  globalConcurrency: z.number().int().positive().max(16),
  /** Per repo. With one repository this is indistinguishable from the global cap (D-04). */
  perRepositoryConcurrency: z.number().int().positive().max(16),
  perAgentConcurrency: z.number().int().positive().max(16),
  perItemAttemptLimit: z.number().int().positive().max(20),
  /**
   * The longest any single run may take.
   *
   * Also the ceiling a module step's own time limit is bounded by
   * (EO-162) — `timeLimitBoundProblem` is where that relationship is
   * written down, and both writes refuse rather than clamp, so this and
   * `PipelineStepView.timeoutMs` can never be stored contradicting each
   * other.
   */
  wallClockTimeoutMs: z.number().int().positive(),
  /**
   * How long a run's backend may go without a word — no message, no
   * progress, no retry — while no tool is running, before EO ends the run
   * and says so. Zero switches it off.
   *
   * The guard for the run that has hung, which the wall clock above
   * catches only once its whole allowance is spent. Silence that spans
   * the computer sleeping is not counted, and a run whose backend never
   * picked up again after a sleep is carried on in its own thread rather
   * than ended.
   */
  inactivityTimeoutMs: z.number().int().nonnegative(),
  perItemBudgetCents: z.number().int().nonnegative().nullable(),
  dailyBudgetCents: z.number().int().nonnegative().nullable(),
  /**
   * Whether a free-text reply to a parked builtin or module step is read
   * by the system agent before the step is run again (EO-184).
   *
   * A guardrail rather than a preference, and it earns the name: what it
   * governs is whether a dispatch happens at all. `builtins.ts` argues
   * that non-agent steps are deliberately not agents — there is no
   * judgement in `git worktree add`, so paying a model for it adds a way
   * to go wrong and nothing that can go right — and that argument holds
   * for the work while not holding for reading the reply, which is the
   * one part with judgement in it. Somebody who disagrees turns it off
   * and gets exactly the old behaviour: the step runs again and asks
   * again.
   *
   * Defaulted rather than optional, like every other field here.
   * `readGuards` merges over `DEFAULT_GUARD_CONFIG`, so a configuration
   * saved before this existed reads as on.
   */
  interpretReplies: z.boolean(),
  /**
   * How many agent-to-agent mention hops an item may carry since the
   * last human comment (EO-212, ARCHITECTURE.md, "Agent to agent").
   *
   * The design names two guards before agents may mention agents, and this is
   * the one that was missing: A pings B pings A is a real failure mode
   * and an expensive one, and nothing else bounds it — the wall-clock
   * timeout bounds one run, the attempt limit is per initiation and
   * every mention is a fresh initiation, and both cost budgets ship as
   * `null`.
   *
   * Counted since the last *human* comment rather than over the item's
   * whole life, because a person stepping in is the thing that makes a
   * long exchange legitimate. So this is a cap on unattended chains, not
   * on how much two agents may ever say to each other.
   *
   * 3: enough for "ask the reviewer, get an answer, ask a follow-up",
   * and past what any exchange should need without a person in it.
   */
  agentMentionDepth: z.number().int().positive().max(20),
  /**
   * How many times keep-checking steps may send an item to another step
   * since a person last commented on it (EO-456, ARCHITECTURE.md,
   * "Guardrails").
   *
   * A watch that reports a failure routes the item back to whoever fixes
   * it, and the item comes back to be watched again. That is the point,
   * and it is also a loop nobody is in: a check failing the same way
   * every time sends the item round for as long as anybody lets it. So
   * past this many round trips the item is parked with a comment, and a
   * person saying anything on it starts the count again.
   *
   * Required here like every other field, and not defaulted: a default
   * would ride along on `guardrails_set`'s partial patch and reset a
   * stored value on every unrelated change. `readGuards` merges over
   * `DEFAULT_GUARD_CONFIG`, so a configuration saved before this existed
   * reads as 5.
   */
  watchRoundTripsPerItem: z.number().int().positive().max(100),
  /**
   * How many characters of memory a dispatch is given without asking
   * which of it bears on the task (EO-478, ARCHITECTURE.md, "What an
   * agent is given").
   *
   * At or under this, every active entry of the project and of the
   * step's workspaces is delivered and no side call is made. Over it, a
   * small model picks at most eight; and if that fails, the newest
   * entries up to this many characters are delivered instead. 4,000 by
   * default — about a page — and required like every field here, for
   * `watchRoundTripsPerItem`'s reason.
   */
  memoryDeliveryChars: z.number().int().positive().max(40_000),
  /**
   * The most active memory entries one scope — the project, or one
   * workspace — holds (EO-480, ARCHITECTURE.md, "What an agent is given").
   * Reaching it queues a consolidation that brings the scope back to about
   * half. 200 by default, so a step in one workspace draws from at most
   * 400; required for `watchRoundTripsPerItem`'s reason.
   */
  memoryScopeMaxEntries: z.number().int().positive().max(10_000),
  /**
   * The most characters of active memory entries one scope holds
   * (EO-480). Whichever of this and `memoryScopeMaxEntries` is reached
   * first queues the consolidation. 40,000 by default.
   */
  memoryScopeMaxChars: z.number().int().positive().max(1_000_000),
  /**
   * How many runs in a row an agent-written, unlocked skill may be given
   * without one loading it before it is shown as stale (EO-720,
   * ARCHITECTURE.md §13.3). Counted in runs, not days, since its last
   * load or restore. 20 by default; required for
   * `watchRoundTripsPerItem`'s reason.
   */
  skillStaleAfterRuns: z.number().int().positive().max(10_000),
  /**
   * How many such runs before EO archives it, and it is delivered to
   * nobody (EO-720). 50 by default. A person's skill and a locked one are
   * never archived by EO, whatever their counts.
   */
  skillArchiveAfterRuns: z.number().int().positive().max(10_000),
  /**
   * Whether trial items are offered a slot ahead of live work while the
   * conversation testing their draft is open (EO-582, ARCHITECTURE.md,
   * "Trial pipelines").
   *
   * A test-fix loop is a sequence of turns, each waiting on one trial
   * run; behind a queue of live work it would stall for hours. On, the
   * scheduler orders those items first. It changes the order and nothing
   * else: concurrency stays where it is (invariant #10), and nothing
   * already running is stopped. Off, trial items wait by priority and age
   * like everything else. On by default, and one setting, because it was
   * the call least settled with the person and may be reversed. Required
   * for `watchRoundTripsPerItem`'s reason.
   */
  trialsFirst: z.boolean(),
  /**
   * How many rounds of a draft's test items one test-fix loop may start
   * before it stops and asks the person (EO-586, ARCHITECTURE.md, "Trial
   * pipelines"). 8 by default. Counted since the person last chose to
   * keep going, which starts the count again. Required for
   * `watchRoundTripsPerItem`'s reason.
   */
  trialRoundsPerDraft: z.number().int().positive().max(100),
  /**
   * What testing one draft may spend, in cents, before its loop stops and
   * asks the person (EO-586). Unset by default: the daily budget still
   * applies to trial items as to everything else. Counted since the
   * person last chose to keep going.
   */
  trialBudgetCentsPerDraft: z.number().int().nonnegative().nullable(),
  /**
   * Whether a test-fix loop stops when the same step fails with the same
   * result in two rounds in a row (EO-586): the fix between them did not
   * reach what was failing. On by default.
   */
  trialStopOnRepeatedFailure: z.boolean(),
  /**
   * The most memory one run's processes may use together, in megabytes
   * (EO-738, ARCHITECTURE.md, "Guardrails").
   *
   * Where a systemd user manager is reachable on Linux, every agent run
   * and every module run starts its process tree in a transient systemd
   * scope of its own with this as its `MemoryMax`, so a run that runs out
   * of memory is stopped by itself and EO and the other runs carry on.
   * Null is EO's default for the machine it runs on, derived from the
   * machine's memory and the global concurrency cap
   * (`guards:runMemory` answers what that comes to); a number is a
   * person's choice. Elsewhere it is stored and has no effect, which the
   * Guardrails screen says. Required for `watchRoundTripsPerItem`'s
   * reason.
   */
  runMemoryMaxMb: z.number().int().min(RUN_MEMORY_MIN_MB).max(RUN_MEMORY_MAX_MB).nullable(),
});
export type GuardConfigView = z.infer<typeof GuardConfigSchema>;

/**
 * What the run memory limit comes to on this machine (EO-738).
 *
 * `applies` is false on macOS, Windows, and Linux without a reachable
 * systemd user manager, and `reason` says which; runs there start as
 * they always did. `defaultMb` is what a null `runMemoryMaxMb` means
 * here, `effectiveMb` what a run is given now.
 */
export const RunMemoryFactsSchema = z.object({
  applies: z.boolean(),
  reason: z.string().nullable(),
  totalMb: z.number().int().nonnegative(),
  defaultMb: z.number().int().positive(),
  effectiveMb: z.number().int().positive(),
});
export type RunMemoryFacts = z.infer<typeof RunMemoryFactsSchema>;

/**
 * What writing the guardrails answers with (EO-162).
 *
 * A bare `GuardConfigView` said "here is your configuration" whether or
 * not it was the configuration that was asked for, which was fine while
 * every field was independent. Lowering the run timeout under a module
 * step that already asks for longer is the first write EO can refuse, and
 * a refusal a caller cannot see is the thing this story exists to stop.
 *
 * Shaped like `pipeline:save`, which had the same problem first: `saved`
 * plus what is actually stored now plus the sentences saying why. On a
 * refusal `guards` is what remains in the database — unchanged — so a
 * screen that redraws from the answer redraws the truth.
 */
export const GuardSaveResultSchema = z.object({
  saved: z.boolean(),
  /** What the guardrails are now: the write on success, what was already there on a refusal. */
  guards: GuardConfigSchema,
  /** Empty when it saved. One sentence per reason, each naming what to change. */
  problems: z.array(z.string()),
});
export type GuardSaveResult = z.infer<typeof GuardSaveResultSchema>;

/** A repository EO drives (D-04). Replaces the single global workspace. */
/**
 * Fields every create sends from the item itself (J-01).
 *
 * Jira marks these required, and it is right to — but asking a user to
 * configure them would be asking twice, so they are filtered out of the
 * "required fields" a person has to fill in. Shared, because the
 * connection check counts them in the main process and the settings
 * editor hides them in the renderer, and the two disagreeing is exactly
 * the confusion this replaced.
 */
// `project`, spelled Jira's way. EO renamed its own "project" to
// "repository" and the sweep reached in here too — so the one field Jira
// always marks required on a create stopped being recognised as one EO
// already sends. It lands in `mustFill` instead: the connection check
// reports that a field called Project needs configuring, the settings
// editor offers it, and `sender.ts` counts it missing on every push.
export const JIRA_ALWAYS_SENT_FIELDS = new Set(["project", "issuetype", "summary", "description", "parent", "reporter"]);

/**
 * A Jira issue key — `KAN-123` (EO-122).
 *
 * One schema rather than a regex per caller. Attaching a key happens on
 * the submit paths and again on the update path, and each growing its
 * own pattern is how the same string comes to be accepted in one place
 * and refused in the next.
 *
 * It normalises as well as validates: leading and trailing whitespace
 * goes (a key is pasted far more often than it is typed, and a paste
 * carries a space about half the time), and the project part is
 * upper-cased, because Jira's keys are upper-case and `kan-123` is the
 * same issue as `KAN-123` to everyone except a string comparison.
 * `findByJiraKey` and `jira/pull.ts` both match keys exactly, so the one
 * stored has to be the canonical spelling or the mapping back from an
 * issue silently misses.
 *
 * The shape is Jira's own: a project key starting with a letter, then
 * one or more letters, digits or underscores, a hyphen, and the issue
 * number.
 *
 * Two characters is Jira's own floor for a project key — it will not
 * create a one-character one — so `A-1` is refused rather than
 * normalised into something no site could have issued. There is no
 * *upper* bound here, and deliberately: Jira's maximum is a per-site
 * setting, and refusing a key a site actually issued would be a worse
 * failure than accepting one it never could. The issue number is
 * unbounded for the same reason.
 */
export const JiraIssueKeySchema = z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9_]+-\d+$/, "A Jira issue key looks like KAN-123.");

/** What Jira requires to create an issue here, discovered from createmeta (J-01). */
export const JiraFieldSchema = z.object({
  id: z.string(),
  name: z.string(),
  required: z.boolean(),
  schemaType: z.string(),
  allowedValues: z.array(z.object({ id: z.string(), value: z.string() })),
});

export type JiraFieldView = z.infer<typeof JiraFieldSchema>;

/** A Jira issue as the picker shows it (J-02). Enough to recognise one, not a mirror of it. */
export const JiraIssueSchema = z.object({
  id: z.string(),
  key: z.string(),
  summary: z.string(),
  description: z.string(),
  issueType: z.string(),
  status: z.string(),
  parentKey: z.string().nullable(),
});

export type JiraIssueView = z.infer<typeof JiraIssueSchema>;

/**
 * A repository's Jira settings as the renderer sees them (J-01).
 *
 * There is no token here, and there never will be: it lives in the OS
 * keychain and the renderer is told only whether one is stored.
 */
/**
 * A Jira site EO can talk to (KAN-22).
 *
 * Global, and referenced by repositories. `credentialsConfigured` says a
 * token exists without ever carrying one — the renderer is told whether,
 * never what (ARCHITECTURE.md, "Secrets").
 */
export const JiraConnectionViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  baseUrl: z.string(),
  flavour: z.enum(["cloud", "datacenter"]),
  email: z.string().nullable(),
  credentialsConfigured: z.boolean(),
  /** How many repositories would stop mirroring if this went. Shown before removing one. */
  projectCount: z.number(),
});

export type JiraConnectionView = z.infer<typeof JiraConnectionViewSchema>;

export const JiraConfigSchema = z.object({
  /** Which site, since connections became their own thing (KAN-22). Null when not connected. */
  connectionId: z.string().nullable(),
  baseUrl: z.string().nullable(),
  flavour: z.enum(["cloud", "datacenter"]).nullable(),
  projectKey: z.string().nullable(),
  email: z.string().nullable(),
  featureIssueType: z.string().nullable(),
  storyIssueType: z.string().nullable(),
  fields: z.record(z.string(), z.unknown()).nullable(),
  createByDefault: z.boolean(),
  /** EO workflow state id -> Jira status name (J-04). Empty means nothing is mirrored. */
  statusMap: z.record(z.string(), z.string()).nullable(),
  /** What each transition asks for, keyed by the status it leads to (J-05). */
  transitionFields: z
    .record(
      z.string(),
      z.object({ requires: z.array(JiraFieldSchema.omit({ required: true })), values: z.record(z.string(), z.unknown()) }),
    )
    .nullable(),
  /** True when a token is in the keychain for this repository. Never the token itself. */
  credentialsConfigured: z.boolean(),
});

export type JiraConfigView = z.infer<typeof JiraConfigSchema>;

/**
 * Opening pull requests, per repository (F-06).
 *
 * `kind` null means "work it out from the remote"; an explicit value
 * overrides a guess, which self-hosted hostnames make necessary.
 */
export const ForgeConfigSchema = z.object({
  openPr: z.boolean(),
  kind: z.enum(["github", "gitlab"]).nullable(),
  remote: z.string(),
  draft: z.boolean(),
  templatePath: z.string().nullable(),
  /** Asked to review every pull request EO opens here, in order (EO-741). */
  reviewers: z.array(z.string()),
});

export type ForgeConfigView = z.infer<typeof ForgeConfigSchema>;

export const RepositoryViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Prose the product owner reads to decide which repo a story belongs in (KAN-17). */
  description: z.string().nullable(),
  repoPath: z.string(),
  baseBranch: z.string(),
  testCommand: z.string().nullable(),
  lintCommand: z.string().nullable(),
  buildCommand: z.string().nullable(),
  itemCount: z.number(),
  jira: JiraConfigSchema,
  forge: ForgeConfigSchema,
});

export type RepositoryView = z.infer<typeof RepositoryViewSchema>;

/**
 * One workspace of any kind, as Settings → Workspaces reads it (EO-301,
 * ARCHITECTURE.md, "A workspace is a kind, attached to the project").
 *
 * The shape is deliberately *not* four shapes. A screen listing a
 * repository beside a shared drive beside a scratch directory needs one
 * row type or it needs four renderers, and the four would drift — so
 * every kind answers the same three questions and the kind-specific
 * part stays in `config`, unread by anything that only draws the list.
 *
 * - `label` is what to call it: a repository's name, a folder's path,
 *   otherwise the kind. `workspaceLabel` is the one function that
 *   decides, so the board's badge and this list cannot disagree.
 * - `summary` is the kind-specific line under it — the repo path and
 *   base branch, the folder path, "scratch", "none".
 * - `problem` is what is wrong with it *now*, in a sentence, or null.
 *   Read by this screen while a person is looking at it, and by the
 *   needs check (phase 6) for the reason `folderPathProblem` gives: a
 *   drive that was mounted when it was attached is not necessarily
 *   mounted this morning.
 *
 * `config` is the kind's own JSON, passed through untouched. The git
 * form reads its fields; nothing else looks inside, and a kind a pack
 * contributed keeps a configuration this package has never heard of.
 */
export const WorkspaceViewSchema = z.object({
  id: z.string(),
  /** Null for a workspace whose project was deleted — it outlives one, as `Workspace.projectId` explains. */
  projectId: z.string().nullable(),
  kind: z.string(),
  label: z.string(),
  summary: z.string(),
  /** What is wrong with this workspace right now, in a sentence, or null for nothing. */
  problem: z.string().nullable(),
  position: z.number(),
  itemCount: z.number(),
  config: z.record(z.string(), z.unknown()),
});

export type WorkspaceView = z.infer<typeof WorkspaceViewSchema>;

/**
 * Attaching a workspace: the kind first, then that kind's config
 * (EO-301).
 *
 * The kind is asked for first because it decides what else is asked at
 * all — `scratch` and `none` ask nothing, `folder` asks for a path and
 * a checkbox, and the git kind asks for today's repository form. So
 * `config` is `unknown` here and parsed by the kind that named it,
 * exactly as `workspaces.config` is: a union spelled on the wire would
 * have to be extended for every kind a pack contributes, which is the
 * coupling `parseWorkspaceConfig` exists to avoid.
 */
export const CreateWorkspaceInputSchema = z.object({
  kind: z.string().min(1),
  /**
   * The project to attach it to; null means the one the window is
   * showing. Attaching to one never moves the window.
   *
   * The git kind can be the first thing in an installation: with no real
   * project to join — none exists, or this one is the gallery's Preview —
   * `CreateRepositoryInputSchema`'s `projectId` says what happens. A
   * `scratch` or `none` workspace cannot: a project is named after its
   * first workspace and neither has a name to give one.
   */
  projectId: z.string().nullable().default(null),
  /** Only for the git kind when a project is made for it; see `CreateRepositoryInputSchema`'s. */
  keyPrefix: z.string().optional(),
  config: z.unknown().default({}),
});

export const UpdateWorkspaceInputSchema = z.object({
  id: z.string(),
  /** A patch over this kind's config, laid over what is stored rather than replacing it. */
  config: z.unknown().default({}),
});

export const CreateRepositoryInputSchema = z.object({
  name: z.string().min(1),
  /** Prose for the product owner — "the Go payments service", not "backend" (KAN-17). */
  description: z.string().nullable().optional(),
  repoPath: z.string().min(1),
  /**
   * The project it joins, after the workspaces already there, without
   * moving the window; left out, the one the window is showing.
   *
   * With no real project to join — none exists, or this one is the
   * gallery's Preview — a project is made instead, named after the
   * repository, and the window switches to it.
   */
  projectId: z.string().optional(),
  /**
   * The key prefix of the project made for it, when one is (KAN-128).
   *
   * On the project, not the repository: that is what numbers the items,
   * so sending one for a repository joining a project is refused. Blank
   * asks for one derived from the name — a prefix has to be unique, and
   * inventing one is a poor first task.
   */
  keyPrefix: z.string().optional(),
  baseBranch: z.string().default("main"),
  testCommand: z.string().nullable().default(null),
  lintCommand: z.string().nullable().default(null),
  buildCommand: z.string().nullable().default(null),
});

export const UpdateRepositoryInputSchema = z.object({
  id: z.string(),
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  repoPath: z.string().min(1).optional(),
  baseBranch: z.string().optional(),
  testCommand: z.string().nullable().optional(),
  lintCommand: z.string().nullable().optional(),
  buildCommand: z.string().nullable().optional(),
  forgeOpenPr: z.boolean().optional(),
  forgeKind: z.enum(["github", "gitlab"]).nullable().optional(),
  forgeRemote: z.string().min(1).optional(),
  forgeDraft: z.boolean().optional(),
  forgeTemplatePath: z.string().nullable().optional(),
  forgeReviewers: z
    .array(z.string())
    .optional()
    .describe(
      "Who EO asks to review each pull request it opens on this repository, after creating it: forge handles — a GitHub " +
        "login, a GitHub org/team, or a GitLab username. Replaces the whole list; [] asks nobody. Entries are trimmed, " +
        "blanks and repeats dropped, and an entry with a space or comma in it refuses the update.",
    ),
});

/**
 * A project, and the workspaces it spans (KAN-17, KAN-130).
 *
 * One repository is the ordinary case and looks exactly like it always
 * did. Several is the point: one application across a UI and a backend,
 * where a feature produces stories that each name a single repo.
 *
 * Which Jira its features are mirrored into is not here any more. It
 * named a member repository while every repository carried its own Jira
 * columns; the project has one binding now and everything on it mirrors
 * through that (`connector_bindings`).
 */
export const ProjectViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Every item on this project keys from here. Fixed at creation. */
  keyPrefix: z.string(),
  /**
   * The workspaces it spans, in order — `workspaces.id`, which the
   * Repositories screen and `repositories_list` still call a repository
   * (KAN-130).
   */
  repositoryIds: z.array(z.string()),
  itemCount: z.number(),
  /**
   * When the record took this project, or null while it is this
   * machine's (EO-325, ARCHITECTURE.md, "The record", "What a person sees first").
   *
   * What the switcher groups on — a null lands under "Local" — and what
   * the settings screen reads to decide between offering the move and
   * saying it has already happened. On a solo desktop every project is
   * null and no screen says anything at all about it, which is right:
   * there is no record for the word "local" to be in contrast with.
   */
  managedAt: z.number().nullable().default(null),
  /**
   * When the person answered the keep-or-move sheet with "keep".
   *
   * Only ever read beside a null `managedAt`, where it separates a
   * project somebody kept from one nobody has been asked about — which
   * is what decides whether the sheet opens at all.
   */
  keptLocalAt: z.number().nullable().default(null),
  /**
   * When a move of this project started, while it is still in flight
   * (EO-325).
   *
   * The middle of a move, which the screens have to be able to say: its
   * items are out of the scheduler for the duration, so a board that
   * looked ordinary would be one where nothing was starting and nothing
   * said why. Null on every project that is not moving, which is every
   * project almost all of the time.
   */
  adoptingAt: z.number().nullable().default(null),
  /**
   * When somebody archived this project, or null while it is live
   * (EO-347).
   *
   * `projects:list` answers with archived projects too, because
   * Settings lists them behind "Show archived" and `projects_list`
   * says which they are. Everything that picks a project to *look at*
   * — the switcher first — reads this and leaves them out, and
   * `activeProjectId` is never one of them.
   */
  archivedAt: z.number().nullable().default(null),
  /**
   * This is the gallery's Preview project (EO-604, ARCHITECTURE.md,
   * "Preview"). A new repository aimed at it gets a project of its own
   * rather than joining, so Settings offers no Add a repository here.
   */
  preview: z.boolean().default(false),
  /**
   * What this project's work has cost, in cents (EO-326, ARCHITECTURE.md, "Policy").
   *
   * Every run of every item on it, which is the same sum as "its
   * people's costs" — a run belongs to an item, an item to a person who
   * owns it, and both to one project — reached the only way the record
   * can reach it today, from `runs.cost_cents`. The design's per-person
   * *budgets* are 7c's (KAN-158); this is the figure they will be
   * compared against, and it does not wait for them.
   *
   * Previews are excluded, as they are from every other cost EO shows
   * (EO-313 ARCHITECTURE.md, "Preview").
   */
  costCents: z.number(),
  /** The implementer proposes before changing anything (KAN-18). */
});

export type ProjectView = z.infer<typeof ProjectViewSchema>;

/** A model a provider offers, and whether it takes a reasoning effort (U-11). */
export const ProviderModelSchema = z.object({
  value: z.string(),
  label: z.string(),
  description: z.string().optional(),
  supportsEffort: z.boolean(),
  effortLevels: z.array(z.string()),
  /**
   * Whether the backend runs this model when an agent names none — Codex's
   * `model/list` says so of one (EO-578). A Codex side call must name its
   * model, so one on a system agent that names none runs on this. Absent
   * where the backend does not say.
   */
  isDefault: z.boolean().optional(),
});

export type ProviderModel = z.infer<typeof ProviderModelSchema>;

/**
 * What a backend can be configured with. Empty arrays mean "this
 * provider has no such setting" — the editor renders what is offered.
 *
 * It carries what a person may *choose*, which is narrower than what a
 * backend supports (EO-178). `permissionModes`, `sandboxModes` and
 * `approvalPolicies` were here and are gone: each has exactly one
 * correct value under EO, pinned where the process is spawned, so
 * offering the rest was offering ways to break the agent dressed as
 * configuration. A field that is only ever `[]` is a question the editor
 * keeps asking that has no answer.
 *
 * `supportsMaxTurns` went too (EO-375), for a different reason: Claude
 * had max turns and Codex has no equivalent, so it was removed from both
 * rather than offered on one. Runs stay bounded by the attempt,
 * wall-clock and budget guards.
 */
export const ProviderCapabilitiesSchema = z.object({
  provider: z.string(),
  models: z.array(ProviderModelSchema),
  /** True when EO can ask the installed provider runtime instead of maintaining a list. */
  modelsAreLive: z.boolean(),
  reasoningEfforts: z.array(z.string()),
});

export type ProviderCapabilities = z.infer<typeof ProviderCapabilitiesSchema>;

/**
 * Whether the CLI EO resolved is signed in (EO-82).
 *
 * A download makes a runtime *present*; it does not make it usable.
 * Someone whose only copy of these tools came from EO ends up with a
 * runtime that reports "Connected" and cannot run a single turn, so
 * this is a fact `runtime:status` carries rather than something each
 * surface guesses at.
 *
 * `unknown` is a first-class answer and never collapses to
 * `signed_out`: dispatch refuses on `signed_out`, so a probe that could
 * not run must not be allowed to block work on a machine that is
 * perfectly well signed in.
 */
export const RuntimeAuthSchema = z.object({
  state: z.enum(["signed_in", "signed_out", "unknown"]),
  /** How the CLI said it authenticates — "claudeai", "ChatGPT", an API key. Null when it did not say. */
  method: z.string().nullable(),
  /**
   * The same answer, normalised, because a card cannot read the one
   * above (EO-84).
   *
   * `method` is whatever sentence or field the CLI happened to print,
   * and there are at least five spellings of "API key" across the two
   * of them. A surface that wants to distinguish a subscription from a
   * key — which is the whole point of showing it — would otherwise be
   * matching English in the renderer. `unknown` is honest rather than a
   * default: a runtime that is signed in by some means the CLI did not
   * name is not a subscription and not a key, and saying either would
   * be inventing the answer.
   */
  kind: z.enum(["subscription", "api_key", "unknown"]),
  /**
   * Whether the key in use is one **EO** holds.
   *
   * True only for a Claude key typed into EO, which is the single place
   * EO stores a billable secret (see the pinned decision on EO-81):
   * Codex's key goes to `codex login --with-api-key` and is the CLI's
   * from that moment. It is what lets the Runtimes card offer to remove
   * a key EO can actually remove, rather than a button that would have
   * to reach into another product's credential store.
   */
  storedKey: z.boolean(),
  /** Who the CLI said you are: an email, an organisation — whatever it printed. */
  account: z.string().nullable(),
  /** Why the answer is `unknown`. Null whenever the CLI actually answered. */
  problem: z.string().nullable(),
});

export type RuntimeAuthView = z.infer<typeof RuntimeAuthSchema>;

/**
 * The CLI a backend runs, and whether this machine has one (A-08).
 *
 * EO does not ship these — the Claude one is Anthropic's binary and not
 * ours to redistribute — so every backend that shells out to a CLI has
 * to answer "is it here, and where did it come from" before it can run.
 * `source` is that answer, and the UI says it out loud rather than
 * silently working or silently not: someone whose agent is running a
 * `claude` off their PATH should be able to see that that is what is
 * happening.
 */
export const RuntimeStatusSchema = z.object({
  id: z.string(),
  label: z.string(),
  publisher: z.string(),
  termsUrl: z.string(),
  /** Where it was found. `absent` is the only one that offers a download. */
  source: z.enum(["configured", "cache", "absent"]),
  path: z.string().nullable(),
  /** Known only for `cache` — EO named the directory, so it knows what is in it. */
  version: z.string().nullable(),
  /** What EO would fetch. Null where nobody publishes a build for this platform. */
  packageName: z.string().nullable(),
  packageVersion: z.string().nullable(),
  state: z.enum(["needs_consent", "updating", "ready", "disabled", "error"]).optional(),
  /** Whether EO's cached copy may be selected. Agent-specific executable paths are independent. */
  enabled: z.boolean().optional(),
  /**
   * Whether the resolved executable is signed in — asked of the binary,
   * never of $HOME. Required, so no surface can quietly leave it out and
   * go on calling a signed-out runtime "Connected".
   */
  auth: RuntimeAuthSchema,
  automaticUpdates: z.boolean().optional(),
  problem: z.string().nullable().optional(),
  /**
   * Codex only, and only when true (EO-378): the person's Codex is set to
   * keep its sign-in in the operating system's keyring (`keyring`, or
   * `auto`, which reads the keyring first). A Codex home of an
   * agent's own cannot reach a keyring credential, so EO runs Codex
   * agents with the person's own setup instead of locking them down, and
   * an agent's editor says so. EO's memory side calls never fall back to
   * the person's home, so they cannot run at all, and the Codex Runtimes
   * card and agent editor say that too (EO-509).
   */
  codexSignInInKeyring: z.boolean().optional(),
  /** Every agent configured for this provider, whether that agent itself is enabled or disabled. */
  usedBy: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        enabled: z.boolean(),
      }),
    )
    .optional(),
  components: z
    .array(
      z.object({
        id: z.string(),
        label: z.string(),
        version: z.string(),
        installed: z.boolean(),
        packageName: z.string().nullable(),
      }),
    )
    .optional(),
});

export type RuntimeStatusView = z.infer<typeof RuntimeStatusSchema>;

/** An EO-managed git worktree still on disk (G-03). */
export const HeldWorktreeSchema = z.object({
  itemKey: z.string(),
  path: z.string(),
  branch: z.string(),
  sizeBytes: z.number(),
  /** Non-zero means it is never released automatically — the tree is the only copy. */
  uncommittedChanges: z.number(),
  /** Null when the branch outlived its item; the tree is still safe to release. */
  itemState: z.string().nullable(),
  /** A run is using it right now, so releasing would pull the floor out from under an agent. */
  inUse: z.boolean(),
  /** Which repo it belongs to — the listing can span repositories (D-04). */
  repositoryId: z.string(),
  repositoryName: z.string(),
});

export type HeldWorktreeView = z.infer<typeof HeldWorktreeSchema>;

export const WorkflowProblemSchema = z.object({
  severity: z.enum(["error", "warning"]),
  /** The step the problem belongs to, so the editor can show it in place. */
  stateId: z.string().nullable(),
  /** The route, when the problem is about one branch rather than the step. */
  resultKey: z.string().optional(),
  message: z.string(),
  /**
   * The step this save would remove while items sit on it, as data
   * (EO-230). Present only on that one problem: it is what lets the
   * configure screen offer the board narrowed to those items, which a
   * sentence cannot be asked for.
   */
  holdsItems: StepHoldingItemsSchema.optional(),
});

export type WorkflowProblem = z.infer<typeof WorkflowProblemSchema>;

export const EngineStatusSchema = z.object({
  paused: z.boolean(),
  activeRunCount: z.number().int().nonnegative(),
  /** The active runs a pause is waiting out. The system agent's are not among them: they carry on while paused (EO-615). */
  finishingRunCount: z.number().int().nonnegative(),
});

/**
 * EO's MCP server for external clients — whether it is running, where,
 * and with what.
 *
 * `token` comes back in full, deliberately, and it is the only secret in
 * this contract that does. The Jira token is typed in once and never
 * read again, so nothing displays it; this one is typed in *elsewhere* —
 * into another program's configuration file, on the same machine, by the
 * same person — so a screen that cannot show it is a server nobody can
 * connect to. The same trade the licence key makes. Masking it against
 * someone reading over a shoulder is the component's job, not the
 * contract's.
 *
 * `port` is what is configured and `listeningPort` is where it actually
 * is. Two fields rather than one because they disagree in exactly the
 * case a person needs told about: the configured port was taken, and
 * `problem` says so.
 */
export const McpStatusSchema = z.object({
  enabled: z.boolean(),
  dangerousOperations: z.boolean(),
  port: z.number().int().min(1024).max(65535),
  /** Null whenever it is not listening — including when the configured port was taken. */
  listeningPort: z.number().int().positive().nullable(),
  /** Null before one has ever been minted, which is before it is first enabled. */
  token: z.string().nullable(),
  /** Why it is not listening, when it should be. A busy port is ordinary, not a fault. */
  problem: z.string().nullable(),
  /** How many tools the current gate exposes, so the screen can say what the switch costs. */
  toolCount: z.number().int().nonnegative(),
});

export type McpStatusView = z.infer<typeof McpStatusSchema>;

/**
 * An MCP client on this machine, and whether EO is registered with it.
 *
 * `installed` is about the person's own install — the `claude` or
 * `codex` on their PATH, or Claude Desktop's own configuration
 * directory — never EO's managed copy of an agent CLI. Registering a
 * server into a runtime EO downloaded for its own agents would help
 * nobody: nothing reads its configuration but EO.
 */
export const McpClientSchema = z.object({
  id: z.enum(["claude-code", "codex", "claude-desktop"]),
  label: z.string(),
  installed: z.boolean(),
  /** Null when EO could not tell — its own command failed, rather than answered no. */
  registered: z.boolean().nullable(),
  /**
   * Something left for the person to do. Not a failure: the registration
   * worked, and this is what it did not cover — Codex reading its token
   * from an environment variable, Claude Desktop needing a restart.
   */
  caveat: z.string().nullable(),
  problem: z.string().nullable(),
  /**
   * How to do it by hand.
   *
   * Present whenever there is a server to connect to, not only when the
   * button fails — because "EO could not run your CLI" is a dead end
   * otherwise, and because the reason a registration failed is often
   * something only the person can see when they run it themselves.
   *
   * Not always a shell command: Claude Desktop has no CLI, so its
   * `text` is the JSON to paste and `label` names the file to paste it
   * into. The label is what tells them which of the two they are
   * looking at.
   */
  manual: z
    .object({ label: z.string(), text: z.string() })
    .nullable(),
});

export type McpClientView = z.infer<typeof McpClientSchema>;

/**
 * One connected client that is still calling EO's old tool names
 * (KAN-178).
 *
 * Derived from what the MCP host recorded, never from what a client
 * declared: registering EO with an editor says nothing about which of a
 * tool's two names the model inside it will reach for, and a row that
 * guessed would be yellow on an installation that is fine — or silent on
 * one that is about to break.
 *
 * Absent from the list entirely when a client has moved to the `item_*`
 * names, which is the same as never having called an aliased tool: both
 * mean there is nothing to tell this person.
 */
export const McpAliasUseSchema = z.object({
  /** What the client called itself at initialize — its own word, not EO's. */
  client: z.string(),
  /**
   * Which client EO can register with this is, when EO can tell.
   *
   * Null for anything else that connected — a script, `mcp-remote`, an
   * editor EO has never heard of. Shown under its own name rather than
   * dropped: a client EO cannot name is the one nobody thinks to check.
   */
  clientId: McpClientSchema.shape.id.nullable(),
  /** The old names it is still on, each with EO's own name for the same tool. */
  names: z.array(z.object({ deprecated: z.string(), replacement: z.string() })),
  /** When EO last heard from it at all, ISO-8601. */
  lastCalledAt: z.string(),
});

export type McpAliasUse = z.infer<typeof McpAliasUseSchema>;

/**
 * The path segment before `/<KEY>` in a branch name (EO-15).
 *
 * Never empty: an empty prefix would collapse into a bare `/<KEY>`, which
 * is not a name anyone chose. Seeded from git config the first time it is
 * read and editable from Settings after that (EO-14).
 */
export const BranchPrefixSchema = z.string().min(1);

// ── Discussions (the product-owner chat tab) ────────────────────────

/** Kept as a source-compatible name for the Discussions renderer. */
export const DiscussionAttachmentSchema = AttachmentViewSchema;
export type DiscussionAttachment = AttachmentView;

export const DiscussionSettingsSchema = z.object({
  /** Null on a `builtin` run: EO acted, so there is no agent to name. */
  agentId: z.string().nullable(),
  agentName: z.string(),
  provider: z.string(),
  /** Null means the agent/provider default. */
  model: z.string().nullable(),
  defaultModel: z.string().nullable(),
  /** Null means the agent/provider default. */
  reasoningEffort: z.string().nullable(),
  defaultReasoningEffort: z.string().nullable(),
  /**
   * The efforts this agent's backend offers, so a picker lists only real
   * choices (ARCHITECTURE.md, "The parity rule": no control that would
   * do nothing). Optional for the rooms that predate it.
   */
  reasoningEfforts: z.array(z.string()).optional(),
  /**
   * Whether turns in this conversation summarise their reasoning, drawn
   * folded under "Thought". On unless somebody turned it off.
   */
  showReasoning: z.boolean().optional(),
  /**
   * Whether this agent's backend offers anything to choose — a model list
   * or efforts — so a surface offers the picker only where it would do
   * something (ARCHITECTURE.md, "The parity rule"), without naming
   * backends to decide it.
   */
  configurable: z.boolean().optional(),
});
export type DiscussionSettings = z.infer<typeof DiscussionSettingsSchema>;

/**
 * One turn of a conversation, as Discussions renders it.
 *
 * A trimmed `CommentViewSchema`: the chat has no pinning and no Jira
 * mirroring, so carrying those would be booleans that are always false.
 *
 * `parentId` is here for exactly one reason — a question the product
 * owner asked and the answer filed under it are one thing on screen (a
 * card showing what was asked and what you picked), and threading is
 * what says which answer belongs to which question.
 */
export const DiscussionMessageSchema = z.object({
  id: z.string(),
  /**
   * "human" for what you typed, "agent" for the product owner, "engine"
   * for EO's own notes, "module" for a module that commented here
   * (EO-75) — `ctx.commentOn` takes any key, a feature's included, so
   * this enum has to admit one or the view throws on a thread it can
   * otherwise render.
   */
  authorType: z.enum(["human", "agent", "engine", "module"]),
  authorName: z.string(),
  body: z.string(),
  attachments: z.array(DiscussionAttachmentSchema),
  /**
   * `note` for ordinary talk, `question` for something the product owner
   * needs settled, `decision` for a proposal you can approve,
   * `rejection` for one that cannot be applied and says why, `approval`
   * for the record left after you approved one.
   */
  kind: z.string(),
  /** The question this answers, when it is an answer. Null for everything else. */
  parentId: z.string().nullable(),
  /**
   * The run that posted this, and null for anything a person typed or
   * EO wrote outside a run.
   *
   * Here because a question belongs to the turn that asked it (EO-338).
   * The product owner asks a batch in one run, and without the run the
   * renderer has no way to tell one batch from the next: every question
   * the thread ever held folded into a single card, which in the assist
   * room — one global thread that never rotates (EO-193) — grew without
   * bound across unrelated topics. `canAnswer` cannot stand in for it,
   * because it is false for every closed batch alike.
   */
  runId: z.string().nullable(),
  /**
   * Suggested answers on a `question`, so picking one is a click rather
   * than an essay. Null on anything that is not a question, empty when
   * the question is genuinely open.
   */
  options: z.array(CommentOptionSchema).nullable(),
  /**
   * True for a question that is still live: asked by the newest turn,
   * not yet answered, and not left behind by a reply that ignored it.
   * The answer card renders exactly these; the rest are history. And for
   * a comment of EO's own offering answers nobody has given yet — a
   * guardrail stopping a draft's testing (EO-586) — whose options the
   * chat draws as buttons.
   */
  canAnswer: z.boolean(),
  createdAt: z.number(),
  /**
   * True for a proposal that is still the newest thing said and has not
   * been applied — the only one that renders an Approve button.
   */
  canApprove: z.boolean(),
  /**
   * What approving this card would do, and null when there is nothing to
   * approve (EO-190).
   *
   * The assistant is one room where either kind of gated artefact can
   * arrive — "file that as a bug" and "add a QA step after Review" are
   * both ordinary things to say to it — and the two go through different
   * paths, `assist:approve`'s and `pipeline:save`'s.
   *
   * `items` creates work, `changes` amends or reorders work that
   * exists, `pipeline` publishes a graph. Three rather than two because
   * a button is a promise: "Create item" over a proposal that renames
   * an existing one is a lie about what the click does, and the panel
   * cannot tell them apart — the card's body is prose and the proposal
   * behind it lives on the run.
   *
   * So the room answers this, never the panel. The rules it answers from
   * are the posting order `postAssistReply` writes and the proposal
   * `proposalOfComment` reads back; a renderer re-deriving either from
   * the text of a comment would be a second implementation with a button
   * on it.
   *
   * `module` is a module the assistant proposed on its own (EO-398).
   * Nothing is approved through the conversation for one: the card
   * carries the catalog's own Approve, `modules:approve`, and which
   * module it is for is `moduleSlug`.
   *
   * `moduleChange` is a change to a module that exists, raised in the
   * help chat (EO-418): a diff with Apply on it, which goes through
   * `assist:applyChange` and never through `assist:approve`. Its own
   * value rather than `changes`, which in that room already means an
   * amendment to work — the two are applied by different channels, and a
   * button that picked the wrong one would file a rejection under a card
   * that is fine. Which module it is for is `moduleChange`.
   *
   * `card` is something only a person may do, offered by the assistant
   * with the button that does it (EO-521): export, import or delete a
   * pipeline, discard this machine's edits to one, let its webhook items
   * through unread, or set a step's own secret or variable (EO-522), or
   * add, change or remove an item type (EO-523). It goes through
   * `assist:applyCard`, and which card it is is `card`.
   */
  approves: z.enum(["items", "changes", "pipeline", "module", "moduleChange", "card"]).nullable(),
  /**
   * The slug of the module this message is a card for, and null on every
   * message that is not a module card (EO-398).
   *
   * A slug and nothing else about the module, deliberately. Whether it
   * is approved, how many test cases it has and what they cover are read
   * from the catalog by the card, so the card is right however the
   * module came to be approved — on the card, in Settings → Modules, by
   * another window — and says so when the module has since been deleted.
   *
   * Not gated on `canApprove`, unlike `approves`: a newer proposal makes
   * an older card's button go away, and a module does not stop being in
   * the catalog because the conversation moved on.
   */
  moduleSlug: z.string().nullable(),
  /**
   * Set on a module card that no longer describes the module the catalog
   * holds under its slug (EO-401), saying where the one that replaced it
   * is. Null or absent on a card that still does, and on every message
   * that is not a module card.
   *
   * The card draws the catalog, and its Approve approves whatever the
   * catalog holds. After a corrected module has been written over the
   * one this card proposed, that is code the card never described — so
   * a card carrying either value offers no Approve.
   *
   * `below`: a later card in this conversation proposed the same slug
   * with something different, on a card of its own or beside a draft.
   * That card is the one to approve from. `elsewhere`: the catalog's
   * code or manifest is no longer what this card proposed and nothing
   * here replaced it — a correction in another chat, or an edit in
   * Settings → Modules. Also a correction in another chat to its test
   * cases alone, which leaves the code as it was.
   */
  moduleReplaced: z.enum(["below", "elsewhere"]).nullable().optional(),
  /**
   * Set on a card that proposes a change to a module that exists, in
   * the help chat (EO-418). Null or absent on every other message.
   *
   * Not gated on `canApprove`, as `moduleSlug` is not: `canApprove` says
   * whether Apply is still offered, and a card that has been applied
   * goes on to offer Approve — the module lost its approval by being
   * changed, and the person should not have to walk to Settings →
   * Modules to give it back. `applied` and `describesSaved` are what the
   * card decides that from; whether the module is approved now it reads
   * from the catalog, so it is right however the approval came about.
   */
  moduleChange: ModuleChangeCardSchema.nullable().optional(),
  /**
   * Set on a card offering something only a person may do — exporting,
   * importing or deleting a pipeline, or discarding this machine's edits
   * to one (EO-521). Null or absent on every other message.
   *
   * Not gated on `canApprove`, as `moduleChange` is not: a card that has
   * been pressed is no longer approvable and still shows what came of
   * it, which is `outcome`.
   */
  card: AssistCardViewSchema.nullable().optional(),
  /**
   * Set on EO's record, in a module's scenario chat, that a test case the
   * turn wrote withdrew the module's approval (EO-501). Null or absent
   * on every other message.
   *
   * The scenario chat saves cases directly, and any change to an
   * approved module's cases withdraws its approval, so the record is
   * where the person learns of it — and where they are offered Approve,
   * `modules:approve`, without walking to Settings → Modules. Only the
   * module is carried: whether it is approved now the panel reads from
   * the catalog, so the record says "approved" however that came about.
   */
  approvalWithdrawn: z.object({ moduleId: z.string() }).nullable().optional(),
  /**
   * Which type a single-item proposal would file, qualified —
   * `developer:story` (ARCHITECTURE.md, "An item type is data", KAN-164).
   *
   * What the approval gate's type picker opens on, and the only thing
   * that tells the card there is a choice to offer: null for a plan,
   * whose container and children each carry their own, and for an
   * amendment or a reorder, which are about work that already has one.
   *
   * Answered by the room from the proposal behind the card, exactly as
   * `approves` is and for the same reason — the card's body is prose and
   * a renderer guessing a type from it would offer to change something
   * it had misread.
   */
  proposedType: z.string().nullable(),
  /**
   * The work this card proposes, as rows (EO-407), and null or absent on
   * every message that is not a work proposal — a pipeline draft and a
   * module card included, and every card in a room that does not answer
   * this.
   *
   * Read from the proposal on the run behind the card, which is what
   * approving it files, so the rows are what the button would create.
   *
   * Not gated on `canApprove`, unlike `approves`: a card that has been
   * approved or replaced still lists what it proposed, and `closed` on
   * the summary says which of the two happened.
   */
  proposal: ProposalSummarySchema.nullable().optional(),
  /**
   * A human follow-up can be sent while the product owner is working.
   * It is either the prompt behind the current run or waiting for the
   * next turn; completed messages and every agent message carry null.
   */
  status: z.enum(["processing", "queued"]).nullable(),
  /**
   * What the turn that wrote this message did on the way to saying it,
   * folded to one line ("Worked for 2m · 25 tool calls · 1 file") and
   * drawn above the message the way Claude Desktop draws a finished turn.
   *
   * On the first message a run posted and on no other, so a turn with a
   * message, two questions and a card carries one summary, not four.
   * Null on everything a person, the engine or a module wrote, and on a
   * message whose run left nothing worth folding. The steps themselves
   * are read on demand with `runs:steps` — a long chat's every tool
   * output is not something to ship on each refresh.
   */
  turn: z
    .object({
      runId: z.string(),
      /** From the run starting to it finishing; null while either is unknown. */
      durationMs: z.number().nullable(),
      toolCalls: z.number().int(),
      /** Distinct paths, the way the transcript counts them (ARCHITECTURE.md, "The transcript"). */
      filesEdited: z.number().int(),
      /** Whether the turn wrote any reasoning, so the fold can say it thought. */
      reasoned: z.boolean(),
    })
    .nullable()
    .optional(),
});
export type DiscussionMessage = z.infer<typeof DiscussionMessageSchema>;

/**
 * One thing a turn did, in the order it did it — what Claude Desktop draws
 * between a question and its answer.
 *
 * Read from `run_events`, so it is the record and not a second copy of
 * it. `tool` pairs a call with its result by the backend's call id; a call
 * whose result has not arrived is `ok: null`, which is a tool still
 * running. Text and output are bounded on the way out: a step is for
 * reading, and the run's own transcript has the whole of it.
 */
export const TurnStepSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), seq: z.number().int(), text: z.string() }),
  z.object({ kind: z.literal("reasoning"), seq: z.number().int(), text: z.string() }),
  z.object({
    kind: z.literal("tool"),
    seq: z.number().int(),
    callId: z.string().nullable(),
    /** The backend's name for the tool, as recorded. */
    name: z.string(),
    /** What a person reads: "Read apps/desktop/src/main.ts", "Ran pnpm test", "eo_admin · items_list". */
    label: z.string(),
    /** The call's arguments, pretty-printed and bounded; null when it had none. */
    input: z.string().nullable(),
    /** Null while the tool is still running. */
    ok: z.boolean().nullable(),
    output: z.string().nullable(),
  }),
  z.object({ kind: z.literal("edit"), seq: z.number().int(), path: z.string() }),
  z.object({ kind: z.literal("error"), seq: z.number().int(), message: z.string() }),
  /** A person's message steered into the running turn (EO-176), where it landed among the steps. */
  z.object({ kind: z.literal("steer"), seq: z.number().int(), text: z.string() }),
]);
export type TurnStep = z.infer<typeof TurnStepSchema>;

/**
 * A block an agent is writing right now, before it is a step.
 *
 * Kept in memory by the main process and never stored (`OutputDeltaEvent`):
 * it becomes a step when the block finishes, and the renderer appends to
 * it from `runs:delta` in between. A draft stays in the view until the
 * event that finished it has been written to `run_events` — so the words
 * are on screen as a draft until they are on screen as a step, and never
 * twice or not at all. A renderer drops a draft the view stops listing.
 */
export const LiveDraftSchema = z.object({
  /** Increases by one per block in a run, so a delta for a new block starts a new draft. */
  id: z.number().int(),
  stream: z.enum(["text", "reasoning"]),
  text: z.string(),
});
export type LiveDraft = z.infer<typeof LiveDraftSchema>;

/** The turn that is running, step by step, with what is being written now. */
export const LiveTurnSchema = z.object({
  runId: z.string(),
  startedAt: z.number().nullable(),
  steps: z.array(TurnStepSchema),
  /** The blocks still being written, or finished but not yet stored; oldest first and usually one. */
  drafts: z.array(LiveDraftSchema),
  /**
   * The id of the newest draft the run had opened when this was read, 0
   * for none. A draft a window has from `runs:delta` with a higher id is
   * newer than this view and is drawn; one at or below it that the view
   * no longer lists has become a step and is not.
   */
  lastDraftId: z.number().int().nonnegative(),
  /**
   * The answer as far as it has been stored, when the agent writes it as a
   * call to the structured-output tool rather than as text — Claude's
   * case. Empty until that call is stored; while it is being written it
   * is a draft.
   */
  answer: z.string(),
});
export type LiveTurn = z.infer<typeof LiveTurnSchema>;

export const DiscussionSchema = z.object({
  id: z.string(),
  key: z.string(),
  /** Null when the project has never had a conversation — the tab offers to start one. */
  startedAt: z.number(),
  closedAt: z.number().nullable(),
  messages: z.array(DiscussionMessageSchema),
  /** True while a run is in progress, so the tab can say the product owner is thinking. */
  thinking: z.boolean(),
  /** When the active turn began, for the live working timer. */
  thinkingSince: z.number().nullable(),
  /** Persisted output from the active run, shown before its final comment lands. */
  liveOutput: z.string(),
  /** Recent tool/file activity from that same run. */
  liveActivity: z.array(z.string()),
  /**
   * The running turn in full: every step so far, and the block being
   * written. Null when nothing is running. `liveOutput` and
   * `liveActivity` are the older, flatter reading of the same run, kept
   * for the surfaces that draw only those.
   */
  liveTurn: LiveTurnSchema.nullable().optional(),
  /**
   * The run working in this chat now, null when none (EO-550). Set
   * whenever `thinking` is, including when `liveTurn` is not drawn — so a
   * room can tell its own run's `runs:progress` from every other run's
   * and refetch only for its own.
   */
  activeRunId: z.string().nullable().optional(),
  /**
   * How many older messages the thread holds beyond `messages`, in a room
   * that pages its history; read with `assist:earlier`. 0 or absent when
   * the view carries the whole thread.
   */
  earlier: z.number().int().nonnegative().optional(),
  settings: DiscussionSettingsSchema,
  /**
   * The last `assist:delta` this view already includes (EO-553): 0 when
   * none has been sent for the chat yet. A renderer applies the delta
   * numbered one more than this and reads the room again for any other.
   * Absent on views that get no deltas, like a scenario's chat.
   */
  deltaSeq: z.number().int().nonnegative().optional(),
});
export type DiscussionView = z.infer<typeof DiscussionSchema>;

/**
 * One `item_types` row as the configure screen's Types section reads it
 * (ARCHITECTURE.md, "An item type is data", KAN-164).
 *
 * Not `ItemTypeEntry`, which is what the *registry* holds: that one is
 * keyed by `qualifiedItemType` and carries no row id, because the
 * registry answers "what does this project's `story` mean" rather than
 * "which row do I rename". An editor needs the id, and it needs the two
 * things a registry has no reason to know — how many items are of this
 * type, which is what a refusal to delete names, and which project the
 * row is scoped to.
 *
 * `specShape` travels whole rather than as the editor's field list. The
 * shape is the authority (see `schemas/specShape.ts`) and a pack may
 * have written more of it than the form can offer, so the section reads
 * the field count off the document and hands the drafts to the form only
 * where it is allowed to edit them.
 */
export const ItemTypeViewSchema = z.object({
  id: z.string(),
  /** Null for the installation scope — the types an item belonging to no project resolves against. */
  projectId: z.string().nullable(),
  /** `developer` for what EO ships, `local` for a type somebody made here. */
  packSlug: z.string().min(1),
  slug: z.string().min(1),
  label: z.string().min(1),
  plural: z.string().min(1),
  container: z.boolean(),
  specShape: SpecShapeSchema,
  /** Items of this type, archived ones included: an archived item is still an item of it. */
  itemCount: z.number().int(),
});
export type ItemTypeView = z.infer<typeof ItemTypeViewSchema>;
