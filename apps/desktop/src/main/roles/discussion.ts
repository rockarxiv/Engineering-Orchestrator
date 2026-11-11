import {
  childrenFromStories,
  branchNameProblem,
  developerType,
  DiscussionOutputSchema,
  JiraIssueKeySchema,
  jiraStateOf,
  formatIssues,
  missingSpecFields,
  parsedResultOf,
  priorityLabel,
  referenceProblem,
  specFields,
  specIssues,
  type AmendProposal,
  type Comment,
  type DiscussionProposal,
  type DiscussionQuestion,
  type NewBugProposal,
  type NewFeatureProposal,
  type SubmittedStory,
  type NewStoryProposal,
  type ProposalRow,
  type ProposalSummary,
  type ProposedAddedField,
  type ReorderProposal,
  type Item,
  type Pipeline,
  type SchemaIssue,
  type SpecField,
  type Uuid,
} from "@eo/core";
import { detectCycle, formatCyclePath } from "@eo/engine";
import type { Db } from "../db/client.js";
import {
  addDependency,
  projectWorkspaceList,
  workspaceLabel,
  createItem,
  getRun,
  getItem,
  getItemByJiraKey,
  getItemByKey,
  listAllDependencies,
  listCommentsForItem,
  listPipelines,
  listStepsForPipeline,
  postComment,
  resolveItemType,
  updateItem,
  type ItemType,
  type ItemTypeName,
  type Workspace,
} from "../db/repos/index.js";
import { isReplica } from "../db/recordRole.js";
import { ASSIST_ACTION } from "./conversationSteps.js";
import { runOf, threadOf, type ConversationThread } from "./conversationThread.js";
import { PROPOSAL_KIND } from "./proposal.js";
import { refuseIfUntouchable } from "./itemGuards.js";
import { changeItemDependencies, circularRefusal } from "./itemDependencies.js";
import {
  applyApprovedProposal,
  baseBranchLine,
  buildProposal,
  existingBranchLine,
  mergeRefineEdges,
  storyBranchRefusal,
  storyGitState,
  typeOf as childTypeOf,
  type StoryJiraLink,
  type StoryPlacement,
} from "./refine.js";

function acceptanceCriteriaOf(item: Item): string[] {
  const raw = item.spec?.["acceptance_criteria"];
  return Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === "string") : [];
}

// ── What the agent said ───────────────────────────────────────

/**
 * The questions a conversation turn asked, one comment each — the
 * assistant's and a scenario chat's alike.
 *
 * One per question rather than one comment listing all of them, exactly
 * as `postClarificationQuestions` does and for the same reason: an
 * answer is a comment filed under the question it answers, and three
 * questions in one comment can only be answered all at once or not at
 * all. The chat renders them as a single card regardless — grouping is
 * a thing the screen does, not a thing the record should lose.
 *
 * They mention nobody. A question here is not an escalation: the person
 * is already looking at the conversation, and a human mention would put
 * every chat question in the Inbox and light the `!` marker on an item
 * nobody can open — which is the same reason a turn's message mentions
 * nobody either.
 */
export function postDiscussionQuestions(
  db: Db,
  conversation: Item,
  agentId: Uuid,
  runId: Uuid,
  questions: DiscussionQuestion[],
): void {
  for (const question of questions) {
    postComment(db, {
      itemId: conversation.id,
      runId,
      author: { type: "agent", agentId },
      kind: "question",
      parseBodyMentions: false,
      // Top-level, never under the turn's message: threading is one
      // level deep (D-05), and an answer has to be able to hang off the
      // question itself.
      parentId: null,
      // `why` on its own line, as in the pipeline's questions: it is
      // what lets someone judge whether they can answer, and the card
      // shows it under the question for exactly that reason.
      body: `${question.question}\n\n_${question.why}_`,
      options: question.options.length > 0 ? question.options : null,
    });
  }
}

/** What a skipped question records. Not silence — the product owner has to know it was declined (invariant 8). */
export const SKIPPED_ANSWER = "_Skipped — no preference; decide it yourself and say what you assumed._";

// ── Applying one ──────────────────────────────────────────────

export type ApplyDiscussionResult =
  | { ok: true; created: Item[]; changed: Item[] }
  /**
   * Not a failure: the proposal is good, but nobody has said which
   * pipeline the work belongs on. The screen asks and re-approves with an
   * answer, rather than EO picking one — every step of the wrong pipeline
   * is the wrong step.
   */
  | { ok: false; reason: string; needsPipeline?: true }
  | { ok: false; reason: string };

/** The pipelines work on this project can be placed on: its own and the shared ones, each with at least one step on the board. */
function placeablePipelines(db: Db, projectId: Uuid | null): Pipeline[] {
  return listPipelines(db, projectId).filter((pipeline) => listStepsForPipeline(db, pipeline.id).some((step) => !step.offBoard));
}

/**
 * The pipeline a proposal's `pipeline` value means, by name and then by
 * id (EO-440).
 *
 * The name is what an agent is told to send and what a person reads, so
 * it is asked first, trimmed and case-insensitively — which is also
 * what decides a value that is one pipeline's name and another's id.
 * The id is accepted after it because agents send one anyway (`default`
 * for Delivery), and a proposal that is right in every other respect
 * should not be sent back over which of the two it used.
 */
function pipelineNamedOrIdentified(available: readonly Pipeline[], value: string): Pipeline | undefined {
  const wanted = value.trim();
  return available.find((pipeline) => pipeline.name.toLowerCase() === wanted.toLowerCase()) ?? available.find((pipeline) => pipeline.id === wanted);
}

/** "Delivery (id: default), Hotfix (id: 0190…)" — both, because either is accepted. */
function pipelinesListed(available: readonly Pipeline[]): string {
  return available.map((pipeline) => `${pipeline.name} (id: ${pipeline.id})`).join(", ");
}

/**
 * Which pipeline this work flows through (ARCHITECTURE.md, "A column is a responsibility, not a
 * status").
 *
 * In order: what the person chose on the approval, then what the product
 * owner proposed by name or id, then the only one there is. Three
 * sources, and the last is not a guess — a project with one pipeline has
 * no ambiguity to resolve.
 *
 * The one resolver for a proposed pipeline: approval, the card's
 * Pipeline row (`describeProposal`) and the check a turn is held to
 * before its cards are posted (`proposedPipelineProblem`) all ask it, so
 * none of the three can accept a value another refuses.
 */
export function resolvePlacement(
  db: Db,
  projectId: Uuid | null,
  chosenId: string | null,
  proposedPipeline?: string,
): StoryPlacement | { problem: string; needsPipeline?: true; unknownPipeline?: true } {
  const available = placeablePipelines(db, projectId);

  if (available.length === 0) return { problem: "This project has no pipeline for work to flow through yet." };

  const byChoice = chosenId !== null ? available.find((pipeline) => pipeline.id === chosenId) : undefined;
  const byProposal = proposedPipeline !== undefined ? pipelineNamedOrIdentified(available, proposedPipeline) : undefined;

  // A name that matches nothing is a mistake, and used to fall through to
  // "there is only one, so it must be that". On a single-pipeline project
  // that silently put work somewhere other than where it was sent, and
  // said it had succeeded — which is the worst shape a failure can take.
  // Naming a pipeline is now either right or refused.
  if (byChoice === undefined && proposedPipeline !== undefined && byProposal === undefined) {
    return {
      problem: `This project has no pipeline called "${proposedPipeline.trim()}". It has: ${pipelinesListed(available)}.`,
      unknownPipeline: true as const,
    };
  }

  const chosen = byChoice ?? byProposal ?? (available.length === 1 ? available[0] : undefined);

  if (!chosen) {
    return { problem: `Which pipeline should this work flow through? ${available.map((pipeline) => pipeline.name).join(", ")}`, needsPipeline: true as const };
  }
  if (chosen.entryStepId === null) {
    return { problem: `"${chosen.name}" does not say where work enters it. Ask the assistant to set that first.` };
  }
  return { pipelineId: chosen.id, entryStepId: chosen.entryStepId };
}

/** The proposals in a turn's reply that create work, and so land on a pipeline — with the one each names, if any. */
function workProposalsOf(reply: unknown): { title: string; pipeline: string | undefined }[] {
  if (typeof reply !== "object" || reply === null || !("proposals" in reply) || !Array.isArray(reply.proposals)) return [];
  const proposals: unknown[] = reply.proposals;
  return proposals.flatMap((proposal) => {
    if (typeof proposal !== "object" || proposal === null) return [];
    const { action, title, pipeline } = proposal as Record<string, unknown>;
    if (action !== "new_feature" && action !== "new_story" && action !== "new_bug") return [];
    return [{ title: typeof title === "string" ? title : "(untitled)", pipeline: typeof pipeline === "string" ? pipeline : undefined }];
  });
}

/**
 * Why a `discuss` or `assist` reply's work cannot be placed from what it
 * says, or null when every proposal's pipeline resolves (EO-440, EO-441).
 *
 * Asked by the supervisor while the turn is still open, so the agent is
 * re-prompted with this text exactly as for a schema failure, and the
 * card is never posted to be refused only once a person presses Create.
 * The question is `resolvePlacement`'s own, with nothing chosen — the one
 * approval and the card's Pipeline row ask — and two of its answers are
 * sent back:
 *
 * - **A pipeline that is neither a name nor an id here** (EO-440).
 * - **No pipeline, on a project with more than one** (EO-441). Approval
 *   would answer `needsPipeline`, and nothing in a chat asks the person
 *   to choose, so such a card could only be refused. With one pipeline
 *   the work lands there and no name is needed.
 *
 * A project with no usable pipeline at all keeps its refusal at
 * approval: nothing the agent sends can fix that.
 */
export function proposedPipelineProblem(db: Db, projectId: Uuid | null, reply: unknown): string | null {
  const problems = workProposalsOf(reply).flatMap((proposal) => {
    const placement = resolvePlacement(db, projectId, null, proposal.pipeline);
    if (!("problem" in placement)) return [];
    if (placement.unknownPipeline === true && proposal.pipeline !== undefined) {
      return [`The proposal "${proposal.title}" names the pipeline "${proposal.pipeline}", which is neither the name nor the id of any pipeline on this project.`];
    }
    if (placement.needsPipeline === true) {
      return [`The proposal "${proposal.title}" names no pipeline, and this project has more than one.`];
    }
    return [];
  });
  if (problems.length === 0) return null;

  const available = placeablePipelines(db, projectId);
  return [
    ...problems,
    "",
    `Work can be placed on: ${pipelinesListed(available)}.`,
    available.length > 1
      ? "Set `pipeline` on each of those proposals to one of those names (an id is accepted too). Nothing was posted from this reply."
      : "Set `pipeline` to that name (an id is accepted too), or leave it out and the work lands there. Nothing was posted from this reply.",
  ].join("\n");
}

/**
 * A card whose approval creates or changes work: a proposal card on an
 * assistant turn.
 *
 * `AssistOutput` composes `DiscussionProposalSchema` rather than restating
 * it (EO-188), so what follows builds from the assistant's answer, and the
 * assistant gets the gate that already existed rather than a second one
 * that agrees with it today (EO-190). Discussions' `discuss` turns were
 * the other room this read until EO-526.
 *
 * The action is read from the run rather than from the step the
 * conversation sits on, which is what keeps the assist room's pipeline
 * draft out: a draft is a card on an `assist` run too, and it is caught
 * one line further down, where the proposal it would index does not
 * exist.
 */
function isWorkProposal(db: Db, comment: Comment, thread?: ConversationThread): boolean {
  if (comment.kind !== PROPOSAL_KIND || comment.runId === null) return false;
  return runOf(db, comment.runId, thread)?.action === ASSIST_ACTION;
}

/**
 * Which of its run's proposals a card is.
 *
 * A turn posts **one comment per proposal, in order**, so the position
 * of this comment among them is the index into the array. Extracted
 * because two things ask it now: applying a card, and saying what
 * approving it would *do* — the label on the assistant's card button
 * (EO-190).
 *
 * The ordering counts *rejections as well as cards*, and that is the
 * whole of this function. A proposal `renderProposal` refuses is posted
 * as a rejection with the reason and no button, which fills its slot in
 * the sequence but not among the approvable cards — so counting only
 * cards shifted every proposal after a refused one onto its neighbour.
 * Two proposals where the first cannot be built, and the story you can
 * see on screen was the amendment behind it: labelled for the wrong
 * thing, refused with a reason about a proposal nobody is looking at,
 * and impossible to create at all.
 *
 * Agent comments only, so the approval or rejection a *person* files
 * under a card — which is what marks it dealt with — cannot shift the
 * sequence that produced it.
 *
 * A card whose slot has no proposal behind it is nothing to approve,
 * which is also what keeps an `assist` turn's pipeline draft out: the
 * draft is posted last, so its slot is one past the end of `proposals`.
 */
export function proposalOfComment(db: Db, conversation: Item, proposalCommentId: Uuid, thread?: ConversationThread): DiscussionProposal | undefined {
  const here = thread ?? threadOf(db, conversation.id);
  const comment = here.find(proposalCommentId);
  if (!comment || !isWorkProposal(db, comment, here)) return undefined;

  const output = here.output(comment.runId, DiscussionOutputSchema);
  if (output === null) return undefined;

  const inOrder = here.agentCommentsOf(comment.runId).filter((entry) => entry.kind === PROPOSAL_KIND || entry.kind === "rejection");
  return output.proposals[inOrder.findIndex((entry) => entry.id === comment.id)];
}

/**
 * Applies the proposal a human just approved.
 *
 * Keyed on the comment, like `approveProposal`, and re-read from the
 * run behind it rather than from anything the renderer produced — so
 * the thing that gets built is the thing that was displayed.
 *
 * Everything happens in one transaction. A proposal that cannot be
 * fully applied applies not at all: a half-created feature or a story
 * with only some of its dependencies is harder to recover from than a
 * refusal, which is the same call `applyApprovedProposal` makes.
 */
export function applyDiscussionProposal(
  db: Db,
  conversation: Item,
  proposalCommentId: Uuid,
  pipelineId: string | null = null,
  /**
   * The type the person chose at the gate, instead of the one the
   * proposal names (ARCHITECTURE.md, "An item type is data", KAN-164).
   *
   * Only a single-item proposal can be reclassified: a plan carries a
   * container and its children with their own types, and an amendment is
   * about work that already has one. Nothing is coerced — the chosen
   * type's shape validates the spec exactly as the proposed type's
   * would, so approving a story-shaped proposal as a `Case` is refused
   * with what a Case is missing rather than filed as a Case without it.
   */
  chosenType?: ItemTypeName,
  /**
   * What a person set, before pressing Create, for fields the project
   * added to a row's type (EO-735) — see `assist:approve`. Merged into
   * the row it names and held to the type's shape with the rest.
   */
  addedValues: AddedFieldValues = [],
): ApplyDiscussionResult {
  const comment = listCommentsForItem(db, conversation.id).find((entry) => entry.id === proposalCommentId);
  if (!comment || !isWorkProposal(db, comment)) {
    return { ok: false, reason: "That is not a proposal, so there is nothing to apply." };
  }

  const run = comment.runId ? getRun(db, comment.runId) : undefined;
  if (!DiscussionOutputSchema.safeParse(parsedResultOf(run?.result ?? null)).success) {
    return { ok: false, reason: "The run behind this proposal no longer has a readable result, so there is nothing to build from it." };
  }

  const proposal = proposalOfComment(db, conversation, proposalCommentId);
  if (!proposal) return { ok: false, reason: "That proposal is no longer readable on the run that produced it." };

  // A refusal has to *throw* to roll the transaction back. Returning
  // `{ ok: false }` from inside the callback commits everything done up
  // to that point, which for a half-applied proposal means a created
  // item surviving the refusal that rejected it — the exact partial
  // state the transaction is here to prevent.
  try {
    return db.transaction(() => {
      const result = applyOne(db, conversation, proposal, pipelineId, chosenType, addedValues);
      if (!result.ok) throw new Refused(result.reason);
      return result;
    });
  } catch (error) {
    if (error instanceof Refused) return { ok: false, reason: error.reason };
    throw error; // a genuine fault, not a guard
  }
}

/** Carries a guard's reason out through the transaction that has to roll back for it. */
class Refused extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "Refused";
  }
}

/** Values for fields a project added to a row's type, by the row's place among a proposal's new items (EO-735). */
export type AddedFieldValues = readonly { row: number; values: Record<string, unknown> }[];

/** The fields this project added to the type a name resolves to here (EO-735), in the type's order. */
function addedFieldsOf(db: Db, projectId: Uuid | null, name: ItemTypeName): ProposedAddedField[] {
  const resolved = resolveItemType(db, projectId, name);
  if (!resolved.ok) return [];
  return specFields(resolved.type.specShape)
    .filter((field) => field.added)
    .map((field) => ({ name: field.name, label: field.label, kind: field.kind }));
}

/**
 * One row's values, as what it files would carry them, or why not
 * (EO-735). Only a field the project added to the row's type may be set
 * this way: anything else is the proposal's to say, and a person who
 * wants it changed asks for a new proposal. Unset values are dropped, so
 * a field left alone stays absent rather than stored empty.
 */
function addedValuesFor(
  db: Db,
  projectId: Uuid | null,
  type: ItemTypeName,
  title: string,
  values: Record<string, unknown>,
): { ok: true; values: Record<string, unknown> } | { ok: false; reason: string } {
  const allowed = new Set(addedFieldsOf(db, projectId, type).map((field) => field.name));
  const set: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(values)) {
    if (!allowed.has(name)) return { ok: false, reason: `“${name}” is not a field this project added to the type of "${title}", so it cannot be set before creating it.` };
    if (value !== undefined && value !== null) set[name] = value;
  }
  return { ok: true, values: set };
}

function applyOne(
  db: Db,
  conversation: Item,
  proposal: DiscussionProposal,
  pipelineId: string | null,
  chosenType?: ItemTypeName,
  addedValues: AddedFieldValues = [],
): ApplyDiscussionResult {
  const projectId = conversation.projectId;
  switch (proposal.action) {
    case "new_feature": {
      if (addedValues.length === 0) return applyNewFeature(db, projectId, proposal, pipelineId);
      const children = childrenFromStories(proposal.stories);
      const stories: SubmittedStory[] = [...proposal.stories];
      for (const { row, values } of addedValues) {
        const story = stories[row];
        const child = children[row];
        if (story === undefined || child === undefined) return { ok: false, reason: `This proposal has no item ${row + 1} to set fields on.` };
        const judged = addedValuesFor(db, projectId, childTypeOf(child), story.title, values);
        if (!judged.ok) return judged;
        stories[row] = { ...story, spec: { ...(stories[row]?.spec ?? {}), ...judged.values } };
      }
      return applyNewFeature(db, projectId, { ...proposal, stories }, pipelineId);
    }
    case "new_story":
    case "new_bug": {
      const proposed = handedOver(proposal);
      const handed = chosenType === undefined ? proposed : { ...proposed, type: chosenType };
      let spec = handed.spec;
      for (const { row, values } of addedValues) {
        if (row !== 0) return { ok: false, reason: `This proposal has no item ${row + 1} to set fields on.` };
        const judged = addedValuesFor(db, projectId, handed.type, handed.title, values);
        if (!judged.ok) return judged;
        spec = { ...spec, ...judged.values };
      }
      return applyNewItem(db, projectId, { ...handed, spec }, pipelineId);
    }
    case "amend":
    case "reorder":
      if (addedValues.length > 0) return { ok: false, reason: "This proposal creates nothing, so there are no fields to set on it." };
      return proposal.action === "amend" ? applyAmendment(db, proposal) : applyReorder(db, proposal);
  }
}

/** A `new_feature` proposal, whose stories may carry their other fields when `work:submitPlan` sent them (EO-735). */
type SubmittedFeature = Omit<NewFeatureProposal, "stories"> & { stories: readonly SubmittedStory[] };

/**
 * A feature and its stories, from a plan somebody has already agreed.
 *
 * Takes a project rather than the conversation it came from, because it
 * no longer only comes from one. The product owner proposes inside the
 * app and a person approves; an agent outside the app submits a plan it
 * agreed with the person it was talking to. Both arrive here, and that
 * is the point — the validation, the cycle check over the merged graph,
 * the placement rules and the pinned understanding are the same for
 * both, so neither route can quietly become the lenient one.
 */
export function applyNewFeature(
  db: Db,
  projectId: Uuid | null,
  proposal: SubmittedFeature,
  pipelineId: string | null,
  jira: PlanJiraSubmission = {},
): ApplyDiscussionResult {
  // The feature's Reference (EO-739), judged before anything is written.
  // A label, so it is not asked where the stories land.
  const reference = namedReference(proposal.reference);
  const unnamed = referenceRefusal(proposal.title, reference);
  if (unnamed !== null) return { ok: false, reason: unnamed };

  // The same validation `refine` runs, on the same shape — the touches
  // merge and the cycle check over the merged graph. A plan that cannot
  // be built must never have been approvable, but re-checking here is
  // what makes that true rather than assumed.
  const plan = buildProposal(db, projectId, childrenFromStories(proposal.stories));
  if (!plan.ok) return { ok: false, reason: plan.reason };

  const placement = resolvePlacement(db, projectId, pipelineId, proposal.pipeline);
  if ("problem" in placement) return { ok: false, reason: placement.problem, ...(placement.needsPipeline ? { needsPipeline: true as const } : {}) };

  // Every key in the plan, before a single row exists (EO-124). A plan
  // is many items, so a key checked as each one is created would
  // refuse the fourth story having already made three items and a
  // feature — and `submitPlan` documents a refusal as nothing created.
  const links = resolvePlanJiraKeys(db, proposal, jira);
  if (!links.ok) return { ok: false, reason: links.reason };

  // Everything from the feature's insert onward is one transaction. The
  // approval door already wraps its whole apply in one, but a submitted
  // plan comes straight here — and a refusal that can only be made once
  // the stories' placement is known (a base branch on a story that would
  // land where no branch is cut, EO-364) would otherwise leave the
  // feature behind it, when `submitPlan` documents a refusal as nothing
  // created. Nested inside the approval door's, this is a savepoint.
  try {
    return db.transaction(() => {
      const result = createPlan(db, projectId, proposal, reference, placement, links, jira);
      if (!result.ok) throw new Refused(result.reason);
      return result;
    });
  } catch (error) {
    if (error instanceof Refused) return { ok: false, reason: error.reason };
    throw error; // a genuine fault, not a guard
  }
}

/** The writing half of `applyNewFeature`, once every check that needs nothing created has passed. */
function createPlan(
  db: Db,
  projectId: Uuid | null,
  proposal: SubmittedFeature,
  reference: string | null,
  placement: StoryPlacement,
  links: { feature: string | null; stories: readonly (string | null)[] },
  jira: PlanJiraSubmission,
): ApplyDiscussionResult {
  const made = createItem(db, {
    type: developerType("feature"),
    title: proposal.title,
    // No pipeline and no step (ARCHITECTURE.md, "One work entity"). A feature is a container: it
    // carries
    // no changes of its own, nothing dispatches against it, and whether it
    // is finished is a question about the stories below it.
    pipelineId: null,
    stepId: null,
    projectId,
    // The feature's own (EO-568). Its stories are not given it: each
    // carries what the plan said of it, and 0 when the plan said nothing.
    ...(proposal.priority === undefined ? {} : { priority: proposal.priority }),
    ...(links.feature === null ? {} : { jiraKey: links.feature }),
    // The plan's setting, and the only place it is written down: a story
    // that says nothing about sync inherits it from this row.
    ...(jira.sync === undefined ? {} : { jiraSync: jira.sync }),
    // On the feature alone (EO-739): its stories read it through
    // `effectiveReference`, so changing it later changes theirs too.
    ...(reference === null ? {} : { git: { reference } }),
  });
  // Before the comments and before the stories, so a project without a
  // container type refuses the plan whole rather than leaving a feature
  // with an empty thread under it.
  if (!made.ok) return { ok: false, reason: made.problem };
  const feature = made.item;

  // Pinned, exactly as `postIntakeSummary` pins them: `understanding`
  // is what anything downstream reads instead of replaying the chat,
  // and the decisions are binding on everything after them.
  postComment(db, { itemId: feature.id, author: { type: "engine" }, kind: "note", pinned: true, body: proposal.understanding });
  for (const settled of proposal.decisions) {
    postComment(db, {
      itemId: feature.id,
      author: { type: "engine" },
      kind: "decision",
      pinned: true,
      body: `**${settled.topic}** — ${settled.decision}`,
    });
  }

  const applied = applyApprovedProposal(
    db,
    feature,
    childrenFromStories(proposal.stories),
    placement,
    proposal.stories.map((_story, index) => storyJiraLink(links.stories[index] ?? null, jira.stories?.[index]?.sync)),
  );
  if (!applied.ok) return { ok: false, reason: applied.reason };

  noteJiraPlan(db, feature, applied.stories);

  return { ok: true, created: [feature, ...applied.stories], changed: [] };
}

/** Builds one story's link without writing an `undefined` switch, which `exactOptionalPropertyTypes` forbids. */
function storyJiraLink(key: string | null, sync: boolean | undefined): StoryJiraLink {
  return { key, ...(sync === undefined ? {} : { sync }) };
}

/**
 * What a submission says about Jira (EO-123).
 *
 * Deliberately a separate argument rather than two more fields on the
 * proposal. A proposal is what the product owner *wrote*, and no agent
 * inside a conversation knows a Jira key — the keys arrive from the
 * caller handing an item over, on a path that has one. Keeping them
 * apart means the in-app route passes nothing and behaves exactly as it
 * did.
 */
export interface JiraSubmission {
  /** The issue this item already is. Absent leaves it unlinked, which is what every submission did before. */
  key?: string;
  /** Absent means inherit — the parent's setting, or on with no parent. `createItem` resolves it. */
  sync?: boolean;
}

/**
 * What a submitted *plan* says about Jira (EO-124).
 *
 * `key` and `sync` are the feature's — and `sync` is the plan's default,
 * which every story under it inherits at creation because the feature
 * carries it. `stories` runs parallel to the proposal's own array, one
 * entry per story in the same order, and an entry that says nothing is
 * a story that said nothing.
 */
export interface PlanJiraSubmission extends JiraSubmission {
  /** Indexed by the story's position in the plan. Empty on the approval path, which has no keys to give. */
  stories?: readonly JiraSubmission[];
}

/**
 * A submitted Jira key, checked before anything is created.
 *
 * Format and uniqueness, locally, with no call to Jira — the pinned
 * decision on EO-121, and the same pair `linkJiraKey` checks on the
 * update path. The sentences are `linkJiraKey`'s own, word for word, so
 * a key refused at submission and the same key refused on an edit do
 * not explain themselves two different ways.
 *
 * Checked *here* rather than left to `createItem` because the insert
 * would otherwise succeed: `items.jira_key` is not unique in the
 * schema, so a second claimant on one issue would land quietly and
 * `jira/pull.ts` would have two items to map one issue back to.
 */
function resolveSubmittedJiraKey(db: Db, key: string): { ok: true; key: string } | { ok: false; reason: string } {
  const read = JiraIssueKeySchema.safeParse(key);
  if (!read.success) return { ok: false, reason: `"${key.trim()}" is not a Jira issue key. They look like KAN-123.` };

  // Archived items count: an archived item is still a claim on that
  // issue, which is why `getItemByJiraKey` finds them.
  const holder = getItemByJiraKey(db, read.data);
  if (holder) return { ok: false, reason: `${holder.key} is already linked to ${read.data}.` };

  return { ok: true, key: read.data };
}

/**
 * Every Jira key a plan gives, resolved in one pass before anything is
 * created (EO-124).
 *
 * Three ways a plan's keys can be wrong, and all three are refused
 * here: the shape, a key some existing item already holds, and the
 * same key given twice *inside the plan itself*. The third is this
 * function's whole reason to exist — a submitter mirroring an epic
 * copies keys down a list, and two stories carrying `KAN-7` would both
 * be created, neither refused by anything else, and `jira/pull.ts` left
 * with two items to map one issue back to. The database will not
 * catch it: `items.jira_key` is not unique in the schema.
 *
 * Positional, because the plan's stories are: the returned array runs
 * parallel to `proposal.stories`, with `null` where a story gave no key.
 */
function resolvePlanJiraKeys(
  db: Db,
  proposal: SubmittedFeature,
  jira: PlanJiraSubmission,
): { ok: true; feature: string | null; stories: readonly (string | null)[] } | { ok: false; reason: string } {
  // Canonical key to what in this plan claimed it, so the refusal can
  // name both claimants rather than saying a key is taken and leaving
  // the submitter to find out it was taken by its own plan.
  const claimed = new Map<string, string>();

  const resolveOne = (key: string | undefined, label: string): { ok: true; key: string | null } | { ok: false; reason: string } => {
    if (key === undefined) return { ok: true, key: null };

    const link = resolveSubmittedJiraKey(db, key);
    if (!link.ok) return link;

    const holder = claimed.get(link.key);
    if (holder !== undefined) {
      return { ok: false, reason: `This plan gives ${link.key} to ${holder} and to ${label}. One Jira issue is one EO ticket.` };
    }

    claimed.set(link.key, label);
    return { ok: true, key: link.key };
  };

  const feature = resolveOne(jira.key, "the feature");
  if (!feature.ok) return feature;

  const stories: (string | null)[] = [];
  for (const [index, story] of proposal.stories.entries()) {
    const resolved = resolveOne(jira.stories?.[index]?.key, `the story "${story.title}"`);
    if (!resolved.ok) return resolved;
    stories.push(resolved.key);
  }

  return { ok: true, feature: feature.key, stories };
}

/**
 * What a submitted plan's feature says about the Jira it arrived with
 * (EO-124).
 *
 * On the feature, and only on the feature: the pinned decision on
 * EO-121 is that something touching a feature and its stories is noted
 * once with a count, rather than a note apiece on items nobody has
 * opened yet. A feature is also where somebody looks to see what the
 * plan became, so it is the one thread that answers "which of these are
 * already in Jira?" without opening each rail.
 *
 * Silence is worth a note of its own for the same reason it is on a
 * single item: nobody watching a story asked for it, and the first
 * sign would otherwise be Jira going quiet.
 *
 * Engine notes, so neither is pushed back to Jira (EO-75), and nothing
 * is said at all when the plan mentioned neither field — which is every
 * plan submitted before this existed.
 */
function noteJiraPlan(db: Db, feature: Item, stories: readonly Item[]): void {
  const created = [feature, ...stories];
  const linked = created.filter((item) => jiraStateOf(item).key !== null);
  const silenced = created.filter((item) => !jiraStateOf(item).sync);
  // The linked items that are actually going to read their issue
  // (EO-127) — a linked item with sync off has no marker and nothing
  // coming, which is the point of submitting it that way.
  const pulling = linked.filter((item) => jiraStateOf(item).sync);

  if (linked.length > 0) {
    postComment(db, {
      itemId: feature.id,
      author: { type: "engine" },
      kind: "note",
      body: [
        linked.length === 1
          ? `1 of the ${created.length} tickets this plan created mirrors an issue that already exists in Jira:`
          : `${linked.length} of the ${created.length} tickets this plan created mirror issues that already exist in Jira:`,
        "",
        ...linked.map((item) => `- ${item.key} — ${jiraStateOf(item).key}`),
        // What is about to happen to them, not what was skipped
        // (EO-127). Each marked item reads its issue in on the pull
        // schedule's next tick, so its comments and attachments arrive
        // and Jira's summary, description and acceptance criteria
        // replace what the plan said — with a note on each item
        // recording what they replaced. A plan whose wording is about
        // to be overwritten is worth knowing about before it happens.
        //
        // Nothing at all when none of them will read anything, which is
        // a plan submitted with sync off: the note below is already
        // about exactly that, and saying it twice on one feature is the
        // repetition the pinned decision on EO-121 is against.
        ...(pulling.length === 0
          ? []
          : [
              "",
              `${pulling.length === linked.length ? "Each of those is" : "Each of those whose Jira sync is on is"} being read in from Jira now: the issues' ` +
                "comments and attachments arrive on the tickets, and their summaries, descriptions and acceptance criteria replace what this plan said, " +
                "with a note on each ticket recording what they replaced.",
            ]),
      ].join("\n"),
    });
  }

  if (silenced.length > 0) {
    postComment(db, {
      itemId: feature.id,
      author: { type: "engine" },
      kind: "note",
      body:
        `Jira sync is off for ${silenced.length} of the ${created.length} tickets this plan created: ` +
        `${silenced.map((item) => item.key).join(", ")}. Nothing on them reaches Jira and nothing comes back from it. ` +
        `Any key stays attached, so switching sync on resumes against the same issue.`,
    });
  }
}

/**
 * What an item's thread says about the Jira it arrived with (EO-123).
 *
 * Both halves are invariant 8: a person reading the item should not
 * have to open the rail to find out that it mirrors an issue, or that
 * it is silent. The second note matters most for a story that inherited
 * the switch from its feature — nobody asked for it on this item, and
 * without saying so the first sign is Jira going quiet.
 *
 * The first half also says what is about to arrive (EO-127). An item
 * created with a key is marked for a pull, so the title and body the
 * submitter just sent may be replaced by the issue's within the minute
 * — which reads as EO losing the submission unless the thread said it
 * was coming.
 *
 * Engine notes, so neither is mirrored back to the issue (EO-75) — a
 * link note pushed to Jira would be EO telling Jira what Jira already
 * knows.
 */
function noteJiraSubmission(db: Db, item: Item): void {
  const jira = jiraStateOf(item);
  if (jira.key !== null) {
    postComment(db, {
      itemId: item.id,
      author: { type: "engine" },
      kind: "note",
      // Nothing about a backfill when sync is off: no marker was set,
      // and the second note below is already about exactly that.
      body: jira.sync
        ? `This ticket mirrors ${jira.key}. The issue's comments and attachments are being brought in now, and its ` +
          `summary, description and acceptance criteria replace what this ticket was created with — a note will record ` +
          `whatever they replaced.`
        : `This ticket mirrors ${jira.key}.`,
    });
  }

  if (!jira.sync) {
    postComment(db, {
      itemId: item.id,
      author: { type: "engine" },
      kind: "note",
      body: jira.key
        ? `Jira sync is off, so nothing here reaches ${jira.key} and nothing comes back from it. The key stays attached: switching sync on resumes against the same issue.`
        : `Jira sync is off, so this ticket will not be pushed to Jira or pulled from it.`,
    });
  }
}

/**
 * Why nothing can be filed under this item (KAN-146).
 *
 * One sentence, in one place, because the two callers are the same
 * refusal at two moments — a proposal being checked in the chat and one
 * being applied — and a person who reads it in the thread and again on
 * the card should not be told two different things.
 *
 * Names the type it *is* rather than the type it should have been: which
 * types hold work is the container flag's answer and a project may have
 * several, so "not a container" is the fact, and the item's own word is
 * what makes the sentence about something the reader can see.
 */
function notAContainer(parent: Item): string {
  return `${parent.key} is a ${parent.type}, which is not a container, so nothing can be filed under it.`;
}

/**
 * The other way round: a container handed over as if it were one item
 * (KAN-164).
 *
 * Written for whoever is reading it here — a person at the approval
 * gate, who has just picked a type from a list — so it names the two
 * things they can do about it rather than an MCP tool they do not have.
 * `work_submit_ticket`'s caller gets its own sentence naming the tool
 * that *does* take a container, before this one is ever reached.
 */
export function containerFiledAlone(type: Pick<ItemType, "label">): string {
  return `A ${type.label} holds work rather than being work, so there is nothing to file on its own. Ask for a plan — a ${type.label} with the work under it — or file this as one of the work types.`;
}

/**
 * One item handed to EO complete, whatever type it is (KAN-147).
 *
 * `applyNewItem` used to take one of the two proposal shapes this pack
 * writes — `new_story` or `new_bug` — which made the *shape of the
 * proposal* the thing that decided an item's type, its spec and whether
 * its dependencies were honoured. Three facts on one discriminator, and
 * a pack's own type could be none of them.
 *
 * So the two doors say what they mean instead: which type, and the spec
 * that type's shape asked for. What each door does with what it was
 * given — a conversation mapping its proposal, a tool call mapping its
 * flat payload — stays that door's business, and the guards here (a
 * parent that holds work, dependencies that exist, which project and
 * repository it lands in, a Jira key nobody else holds) guard both.
 */
export interface HandedOverItem {
  /** Which type, by the pack and the word, or by the word alone. */
  type: ItemTypeName;
  title: string;
  body: string;
  /**
   * The structured fields, under the names this type's shape declares.
   *
   * `touches` rides in here too, for the reason it always has: the paths
   * EO serialises work against have no column of their own, and a spec is
   * the bag an item's own facts live in. No shape declares it — it is a
   * property of work rather than of a type — so nothing demands it and
   * nothing renders it.
   */
  spec: Record<string, unknown>;
  /** Existing items' keys this waits for. */
  depends_on: string[];
  /** An existing container's key to file this under. Absent means standalone. */
  parent?: string;
  pipeline?: string;
  repository?: string;
  /**
   * Where this lands when nothing above says (EO-433).
   *
   * A module's creation that names no repository, under no parent that
   * has one, belongs where the item it was created from is — on a
   * project spanning several, that is an answer rather than a refusal.
   * An id rather than a name, because the caller holds the row and two
   * repositories may share a label. Read only when it is one of this
   * project's; anything else is ignored and the refusal stands.
   */
  fallbackWorkspaceId?: Uuid | null;
  /**
   * The branch to cut this item's branch from and open its pull request
   * against, when it is not the repository's base branch (EO-364).
   * Written onto the item's `git` extension in the same insert that
   * creates it, and refused — with nothing created — when the item would
   * land somewhere no branch is cut.
   */
  baseBranch?: string;
  /**
   * An existing branch to work on instead of cutting one (EO-365).
   * Written as the item's `git` branch, marked as the person's, in the
   * same insert, and refused the way `baseBranch` is.
   */
  existingBranch?: string;
  /**
   * The outside issue this item belongs to, as a plain label (EO-739).
   * Trimmed and judged by `applyNewItem`, which reads a blank one as
   * none and refuses one `referenceProblem` refuses, with nothing
   * created. Written onto the `git` extension in the same insert, on any
   * pipeline: unlike a branch it asks nothing of where the item lands.
   */
  reference?: string;
  /**
   * Who handed it over (EO-326, ARCHITECTURE.md, "Identity").
   *
   * Absent everywhere there is only one person it could be, where
   * `createItem` fills in the local one as it always has. On a server
   * there is more than one, and "who filed it" is a fact the record can
   * know and was discarding — an item submitted through the door came
   * out belonging to the record's own local-person row, whoever had
   * actually asked for it.
   */
  createdBy?: Uuid | null;
  /**
   * How soon it should be picked up (EO-568). Written in the same insert
   * that creates the item; absent, `createItem` writes 0, as it always
   * has. Never read off the parent — a story under an urgent feature is
   * not urgent by being there.
   */
  priority?: number;
}

/**
 * A proposal approved in a conversation, as a hand-over.
 *
 * The pack's own two shapes, named as its own types (KAN-129): the
 * proposal came from `DiscussionProposalSchema`, which is this pack's
 * shape answering about this pack's types, so a second pack shipping the
 * same word cannot make the answer ambiguous.
 */
export function handedOver(proposal: NewStoryProposal | NewBugProposal): HandedOverItem {
  const baseBranch = proposalBaseBranch(proposal);
  const existingBranch = proposalExistingBranch(proposal);
  const reference = namedReference(proposal.reference);
  return {
    type: developerType(proposal.action === "new_story" ? "story" : "bug"),
    title: proposal.title,
    body: proposal.body,
    spec: specFor(proposal),
    depends_on: proposal.action === "new_story" ? [...proposal.depends_on] : [],
    ...(proposal.parent === undefined ? {} : { parent: proposal.parent }),
    ...(proposal.pipeline === undefined ? {} : { pipeline: proposal.pipeline }),
    ...(proposal.repository === undefined ? {} : { repository: proposal.repository }),
    ...(baseBranch === null ? {} : { baseBranch }),
    ...(existingBranch === null ? {} : { existingBranch }),
    ...(reference === null ? {} : { reference }),
    ...(proposal.priority === undefined ? {} : { priority: proposal.priority }),
  };
}

/**
 * The base branch a single-item proposal names, trimmed, or null (EO-364).
 *
 * Only a story's: a bug proposal has no such field, and a blank one is a
 * story that named nothing — the same reading `childrenFromStories` takes
 * of a plan's.
 */
function proposalBaseBranch(proposal: NewStoryProposal | NewBugProposal): string | null {
  if (proposal.action !== "new_story" || proposal.base_branch === undefined) return null;
  const named = proposal.base_branch.trim();
  return named === "" ? null : named;
}

/**
 * A Reference as it was sent (EO-739), trimmed, and null when it names
 * nothing — the reading `judgeReferenceEdit` takes of an edit, so a blank
 * one is no Reference rather than a problem.
 */
function namedReference(value: string | undefined): string | null {
  if (value === undefined) return null;
  const named = value.trim();
  return named === "" ? null : named;
}

/**
 * Why `title` cannot be created with this Reference, in
 * `referenceProblem`'s words, or null when it can (EO-739).
 */
function referenceRefusal(title: string, reference: string | null): string | null {
  const problem = reference === null ? null : referenceProblem(reference);
  return problem === null ? null : `"${title}" names a Reference EO cannot use. ${problem}`;
}

/** The line a card's body names a proposed item's Reference with, or nothing when it names none (EO-739). */
function referenceLines(reference: string | null): string[] {
  return reference === null ? [] : [`_Reference: \`${reference}\`_`];
}

/** The existing branch a single-item proposal names, read as `proposalBaseBranch` reads a base (EO-365). */
function proposalExistingBranch(proposal: NewStoryProposal | NewBugProposal): string | null {
  if (proposal.action !== "new_story" || proposal.existing_branch === undefined) return null;
  const named = proposal.existing_branch.trim();
  return named === "" ? null : named;
}

/**
 * Why an item cannot be filed as incomplete (KAN-147).
 *
 * Two sentences, because the two cases read differently and both were
 * written by hand before the shape could say them. A type with one
 * required field has a *reason* for it, which the field carries as its
 * description — so the refusal is that sentence, and the field's own
 * phrase is what names it. A type with several has one bar and a list of
 * what is missing from it.
 *
 * Which means the words a person reads when a story arrives without
 * acceptance criteria are the story type's words, and a pack's `Case`
 * gets the same two sentences without writing either.
 */
/**
 * What a spec its type will not accept is refused with, when the
 * trouble is not a missing field (KAN-147).
 *
 * `incomplete` names things to supply; this names the rule that was
 * broken, in the validator's own words and at the path it reported — a
 * field nobody declared on a closed shape, a number outside its bounds,
 * a string that does not match a pattern. Those are a type's rules and
 * EO has no better sentence for them than the one the shape's author
 * effectively wrote; inventing prose per keyword would be EO guessing
 * what a pack meant.
 */
function malformed(type: ItemType, issues: readonly SchemaIssue[]): string {
  return `A ${type.slug} does not accept this:\n${formatIssues(issues)}`;
}

function incomplete(type: ItemType, missing: readonly SpecField[]): string {
  const [only] = missing;
  if (missing.length === 1 && only?.description !== undefined) return `A ${type.slug} needs ${only.phrase} — ${only.description}.`;
  return (
    `A ${type.slug} filed this way reaches the board without going through intake, so it has to arrive complete. ` +
    `Missing: ${missing.map((field) => field.name).join(", ")}.`
  );
}

/**
 * One bug or story, standalone or filed under a feature that exists.
 *
 * Takes a project for the same reason `applyNewFeature` does: it is
 * reached both from a proposal approved in the app and from an agent
 * outside it handing over a single item. Everything it guards — the
 * parent being a feature and on this project, dependencies that exist,
 * which repository it lands in — guards both.
 */
export function applyNewItem(
  db: Db,
  projectId: Uuid | null,
  handed: HandedOverItem,
  pipelineId: string | null,
  jira: JiraSubmission = {},
): ApplyDiscussionResult {
  // A label, judged before anything else is read (EO-739), and on any
  // pipeline: it names the work, and asks nothing of where it lands.
  const reference = namedReference(handed.reference);
  const unnamed = referenceRefusal(handed.title, reference);
  if (unnamed !== null) return { ok: false, reason: unnamed };

  const parent = handed.parent === undefined ? null : getItemByKey(db, handed.parent);
  if (handed.parent !== undefined) {
    if (!parent) return { ok: false, reason: `There is no ticket ${handed.parent} to put this under.` };
    // Work cannot hang off work: `parentId` means "work → the container
    // holding it" everywhere else, and a container's progress walks
    // exactly one level. Asked of the parent type's container flag rather
    // than of the word `feature` (KAN-146), so a project whose container
    // is an Epic can hold work under it.
    if (!parent.container) return { ok: false, reason: notAContainer(parent) };
    if (parent.projectId !== projectId) return { ok: false, reason: `${parent.key} is on a different project.` };
  }

  // Whatever this item waits for, whatever type it is (KAN-147). It used
  // to be read only from a story-shaped proposal, because that was the
  // only shape with the field — so a bug handed over with dependencies
  // had them recorded in a note and dropped. Dependencies are a property
  // of work rather than of a type, and a hand-over says what it waits
  // for.
  const waitedFor = resolveDependsOn(db, projectId, handed.depends_on);
  if (!waitedFor.ok) return waitedFor;
  const dependsOn = waitedFor.items;

  // The type, and what it demands of the spec (KAN-147).
  //
  // Resolved here rather than left to `createItem` because the *shape* is
  // what validates the spec, and the shape is on the row: a story arriving
  // without acceptance criteria, a bug without its four reproduction
  // fields, a `Case` without its customer are one check now instead of
  // three hand-written ones, and a pack's own type is held to its own
  // fields without this file knowing any of them.
  //
  // Both doors that reach here demand a complete item — an agent handing
  // one over through `work_submit_ticket`, and a person approving a
  // proposal in a conversation — which is why the check is here and not in
  // `createItem`. Creating an item is also how a Jira issue arrives and
  // how a decomposition writes its children, and neither of those is a
  // claim that everything the type asks for is known yet.
  const type = resolveItemType(db, projectId, handed.type);
  if (!type.ok) return { ok: false, reason: type.problem };

  // A container is not one item (KAN-164). Every path through here files
  // exactly one thing onto a pipeline step, and a container is neither —
  // it holds work rather than being work, and the design keeps it off a
  // pipeline entirely, so one filed on its own would be an empty
  // container sitting on a step nothing can advance.
  //
  // At the door rather than at each caller, because the callers have
  // grown: `submitItem` checked its own input and said so in its own
  // words, but the approval gate (ARCHITECTURE.md, "An item type is data") offers a person the
  // project's
  // types and a mis-picked Feature would have gone straight through.
  // `applyNewFeature` is the path a container *does* arrive by, with the
  // work under it, and it does not come through here.
  //
  // Asked of the type's flag rather than of a word, so a project whose
  // container is an Epic is refused for the same reason a feature is.
  if (type.type.container) return { ok: false, reason: containerFiledAlone(type.type) };

  // Every issue the shape has with this spec, not only the fields it
  // asked for and did not get (KAN-147). A shape is a JSON Schema and the
  // validator is the whole authority on what a valid spec is: a type
  // closing its shape with `additionalProperties: false`, or bounding a
  // number, says something ajv reports at the root or at a key the shape
  // never declared, and reading only the declared-property issues would
  // let exactly those through — a hand-over creating an item its own type
  // refuses. The wording splits, because the two readings are different
  // to act on: what is missing is a list of things to supply, and
  // anything else is the rule that was broken.
  const issues = specIssues(type.type.specShape, handed.spec);
  if (issues.length > 0) {
    const missing = missingSpecFields(type.type.specShape, handed.spec);
    return { ok: false, reason: missing.length > 0 ? incomplete(type.type, missing) : malformed(type.type, issues) };
  }

  const routed = routeToProject(db, projectId, parent ?? null, handed.repository, handed.fallbackWorkspaceId ?? null);
  if (!routed.ok) return routed;

  const placement = resolvePlacement(db, projectId, pipelineId, handed.pipeline);
  if ("problem" in placement) return { ok: false, reason: placement.problem, ...(placement.needsPipeline ? { needsPipeline: true as const } : {}) };

  // A base branch only where a branch is cut (EO-364), which is only
  // known once the placement and the repository are — and still before
  // the insert, so a refusal leaves nothing behind.
  // An existing branch to work on is judged the same way (EO-365).
  if (handed.baseBranch !== undefined || handed.existingBranch !== undefined) {
    const refusal = storyBranchRefusal(db, handed.title, handed, {
      container: type.type.container,
      workspaceId: routed.workspaceId,
      projectId,
      pipelineId: placement.pipelineId,
      stepId: placement.entryStepId,
      pipelineVersionId: null,
    });
    if (refusal !== null) return { ok: false, reason: refusal };
  }

  // Before the insert, with the rest of the guards. A key refused after
  // the item exists would leave somebody an item they did not ask
  // for alongside a refusal saying nothing was created.
  const link = jira.key === undefined ? null : resolveSubmittedJiraKey(db, jira.key);
  if (link !== null && !link.ok) return { ok: false, reason: link.reason };

  const git = storyGitState({ ...handed, reference });
  const created = createItem(db, {
    // The row resolved above, by the pack and the word it came back with
    // — not the name again, so that what was validated and what is
    // written cannot be two different types.
    type: { packSlug: type.type.packSlug, slug: type.type.slug },
    parentId: parent?.id ?? null,
    workspaceId: routed.workspaceId,
    projectId,
    title: handed.title,
    body: handed.body,
    spec: handed.spec,
    ...(handed.createdBy === undefined ? {} : { createdBy: handed.createdBy }),
    ...(handed.priority === undefined ? {} : { priority: handed.priority }),
    // Approving in the chat *is* the gate (ARCHITECTURE.md, "A column is a responsibility, not a
    // status"), so the item goes
    // straight to where its pipeline says work enters.
    pipelineId: placement.pipelineId,
    stepId: placement.entryStepId,
    ...(link === null ? {} : { jiraKey: link.key }),
    // Omitted rather than defaulted: `createItem` reads the parent's
    // setting when nothing is said, so a story under a silenced feature
    // arrives silenced (EO-122).
    ...(jira.sync === undefined ? {} : { jiraSync: jira.sync }),
    // With the row, not after it: the entry step of a git pipeline cuts
    // the branch as soon as the item lands (EO-364).
    // An existing branch too (EO-365): it is the branch that step
    // checks out instead of cutting one.
    ...(git === undefined ? {} : { git }),
  });

  // An installation without the developer pack's types — or a project
  // whose editor removed one (ARCHITECTURE.md, "An item type is data") — is answered in the thread,
  // naming
  // the slug, the same way a parent that is not a feature is. Nothing
  // has been written by this point, so there is nothing to undo.
  if (!created.ok) return { ok: false, reason: created.problem };
  const item = created.item;

  noteJiraSubmission(db, item);

  for (const dependency of dependsOn) {
    const problem = addEdge(db, item, dependency);
    if (problem) return { ok: false, reason: problem };
  }

  return { ok: true, created: [item], changed: [] };
}

/**
 * The items a new item is to wait for, by key, or the sentence saying
 * which one it cannot wait for: no such item, or one on another project.
 *
 * Apart from `applyNewItem` because a module's creation (EO-434) has to
 * know them before the item exists — it asks whether the edges would be
 * circular first — and must refuse in the same words.
 */
export function resolveDependsOn(db: Db, projectId: Uuid | null, keys: readonly string[]): { ok: true; items: Item[] } | { ok: false; reason: string } {
  const items: Item[] = [];
  for (const key of keys) {
    const dependency = getItemByKey(db, key);
    if (!dependency) return { ok: false, reason: `There is no ticket ${key} for this to depend on.` };
    if (dependency.projectId !== projectId) return { ok: false, reason: `${dependency.key} is on a different project.` };
    items.push(dependency);
  }
  return { ok: true, items };
}

function applyAmendment(db: Db, proposal: AmendProposal): ApplyDiscussionResult {
  const item = getItemByKey(db, proposal.item);
  if (!item) return { ok: false, reason: `There is no ticket ${proposal.item}.` };

  const refusal = refuseIfUntouchable(db, item, proposal.priority !== undefined && onlyChangesPriority(proposal) ? "priority" : "content");
  if (refusal) return { ok: false, reason: refusal };

  const before = describeFields(item);
  updateItem(db, item.id, {
    ...(proposal.title !== undefined ? { title: proposal.title } : {}),
    ...(proposal.body !== undefined ? { body: proposal.body } : {}),
    ...(proposal.priority !== undefined ? { priority: proposal.priority } : {}),
    ...(proposal.acceptance_criteria !== undefined
      ? { spec: { ...(item.spec ?? {}), acceptance_criteria: proposal.acceptance_criteria } }
      : {}),
  });

  const after = getItem(db, item.id)!;

  // On the amended item, not only in the chat. Whoever implements
  // this reads its thread and nothing else, and an acceptance criterion
  // that changed without explanation is worse than one that never did.
  postComment(db, {
    itemId: item.id,
    author: { type: "engine" },
    kind: "decision",
    body: [`Changed from a conversation: ${proposal.why}`, "", ...diffLines(before, describeFields(after))].join("\n"),
  });

  return { ok: true, created: [], changed: [after] };
}

/**
 * A reorder card a person approved: the shared change to what an item
 * waits for (EO-600, `itemDependencies.ts`), the same one `items:update`
 * makes, so the card and `item_update` cannot disagree. Judged whole
 * before anything is written, so a refused addition leaves every removal
 * the card asked for unapplied too.
 */
function applyReorder(db: Db, proposal: ReorderProposal): ApplyDiscussionResult {
  const item = getItemByKey(db, proposal.item);
  if (!item) return { ok: false, reason: `There is no ticket ${proposal.item}.` };
  // On a project the organisation's record holds the record makes the
  // change (`reorderOnTheRecord`, which the approval door sends it
  // through). One arriving here anyway is refused rather than written to
  // a replica whose edges the record's scheduler never reads.
  if (isReplica(db, item.id)) return { ok: false, reason: reorderOnTheRecordLine(item.key) };

  const changed = changeItemDependencies(
    db,
    item,
    { add: proposal.add_depends_on, remove: proposal.remove_depends_on },
    `Reordered from a conversation: ${proposal.why}`,
  );
  if (!changed.ok) return { ok: false, reason: changed.reason };

  return { ok: true, created: [], changed: [getItem(db, item.id)!] };
}

/**
 * A reorder card on an item the organisation's record holds, or null for
 * any other card (EO-600).
 *
 * The edges of such an item are the record's — its scheduler reads them,
 * and a cycle is a question about its whole graph — so approving the
 * card asks the record, through `ItemRecord.changeDependencies`, rather
 * than applying it here. Read through `proposalOfComment`, the reader
 * `applyDiscussionProposal` builds from, so what the record is asked to
 * do is what the card shows.
 */
export function reorderOnTheRecord(db: Db, conversation: Item, proposalCommentId: Uuid): { item: Item; proposal: ReorderProposal } | null {
  const proposal = proposalOfComment(db, conversation, proposalCommentId);
  if (proposal?.action !== "reorder") return null;
  const item = getItemByKey(db, proposal.item);
  if (!item || !isReplica(db, item.id)) return null;
  return { item, proposal };
}

/** Why a reorder card was not applied on this desktop. */
function reorderOnTheRecordLine(itemKey: string): string {
  return `${itemKey} is on a project your organisation's record holds, so what it waits for is changed there, and this desktop did not change it.`;
}

// ── Guards ────────────────────────────────────────────────────

/**
 * The content guard now lives in `itemGuards.ts`, because a person
 * editing acceptance criteria on the item screen (EO-166) has to be
 * refused by the same rule an amendment proposed in here is.
 */
/** True when the only thing an amendment changes is `priority`. */
function onlyChangesPriority(proposal: AmendProposal): boolean {
  return proposal.title === undefined && proposal.body === undefined && proposal.acceptance_criteria === undefined;
}

/**
 * Adds one edge, or says why it cannot be added.
 *
 * `addDependency` is the authority on this — it checks the candidate
 * against every existing edge before inserting, so a cycle can never be
 * persisted (E-01) — but it signals refusal by throwing, with item
 * *ids* in the message. That is right for the refine path, where
 * `buildProposal` has already proved the graph acyclic and a throw
 * really would mean a bug. Here the product owner can propose an edge
 * against a live graph it only partly knows, so a cycle is an ordinary
 * outcome that needs an ordinary answer, in keys a person can read.
 */
export function addEdge(db: Db, item: Item, dependsOn: Item): string | null {
  try {
    addDependency(db, item.id, dependsOn.id);
    return null;
  } catch {
    const cycle = detectCycle([...listAllDependencies(db), { itemId: item.id, dependsOnId: dependsOn.id }]);
    const readable = cycle ? formatCyclePath(cycle.map((id) => getItem(db, id)?.key ?? id) as Uuid[]) : `${item.key} and ${dependsOn.key}`;
    return circularRefusal(item.key, dependsOn.key, readable);
  }
}

/** Lives with the rest of the dependency rule now (EO-600); still answered here for the creation doors that ask this file. */
export { circularRefusal };

/**
 * Which workspace a new item lands in.
 *
 * The parent's, when there is one and it has one. Otherwise the
 * project's, when the project leaves no doubt. On a project spanning
 * several the product owner names one, and a name that is not on the
 * project is refused rather than guessed at — a story in the wrong
 * repository produces a branch and a pull request in the wrong place,
 * which is `routeStory`'s reasoning in `refine.ts` and holds here
 * identically.
 */
function routeToProject(
  db: Db,
  projectId: Uuid | null,
  parent: Item | null,
  named: string | undefined,
  fallbackWorkspaceId: Uuid | null = null,
): { ok: true; workspaceId: Uuid | null } | { ok: false; reason: string } {
  if (parent?.workspaceId) return { ok: true, workspaceId: parent.workspaceId };

  const members: Workspace[] = projectId === null ? [] : projectWorkspaceList(db, projectId);
  if (members.length < 2) return { ok: true, workspaceId: members[0]?.id ?? null };

  const names = members.map(workspaceLabel).join(", ");
  const wanted = named?.trim();
  // Nothing named, and the caller knows where it came from (EO-433).
  if (!wanted && fallbackWorkspaceId !== null && members.some((workspace) => workspace.id === fallbackWorkspaceId)) {
    return { ok: true, workspaceId: fallbackWorkspaceId };
  }
  if (!wanted) return { ok: false, reason: `This project spans ${members.length} repositories (${names}), and the proposal does not say which one this belongs in.` };

  const match = members.find((workspace) => workspaceLabel(workspace).toLowerCase() === wanted.toLowerCase());
  if (!match) return { ok: false, reason: `"${wanted}" is not a repository on this project. It spans: ${names}.` };
  return { ok: true, workspaceId: match.id };
}

function specFor(proposal: NewStoryProposal | NewBugProposal): Record<string, unknown> {
  if (proposal.action === "new_story") {
    return { acceptance_criteria: proposal.acceptance_criteria, touches: proposal.touches };
  }
  // A bug's criteria go in the same key a story's do, deliberately
  // (EO-205). Nothing downstream — the reviewer, EO-200's coverage
  // check, the census, the Jira description — asks what type an item
  // is before reading `spec.acceptance_criteria`, so a bug that carries
  // them is checked exactly as a story is, and the empty list a bug
  // filed without them lands with reads back the same as it always did.
  return {
    steps_to_reproduce: proposal.steps_to_reproduce,
    expected: proposal.expected,
    actual: proposal.actual,
    environment: proposal.environment,
    acceptance_criteria: proposal.acceptance_criteria,
  };
}

// ── Rendering ─────────────────────────────────────────────────

type RenderedProposal = { ok: true; body: string } | { ok: false; reason: string };

/**
 * The card a person reads before approving one proposal.
 *
 * Exported for the assist room (EO-188), which posts the same proposals
 * from a different conversation. A second renderer there would be a
 * second answer to "is this buildable" — the cycle check and the
 * reference checks below are what stop an unbuildable plan reaching
 * somebody as approvable, and two of them would drift.
 */
export function renderProposal(db: Db, conversation: Item, proposal: DiscussionProposal): RenderedProposal {
  switch (proposal.action) {
    case "new_feature": {
      // The cycle check runs here as well as at apply time, so an
      // unbuildable plan never reaches the human as approvable.
      const plan = buildProposal(db, conversation.projectId, childrenFromStories(proposal.stories));
      if (!plan.ok) return plan;
      // The feature's Reference, judged here as well as at apply time
      // (EO-739), so a value git would not take is never approvable.
      const reference = namedReference(proposal.reference);
      const unnamed = referenceRefusal(proposal.title, reference);
      if (unnamed !== null) return { ok: false, reason: unnamed };
      return {
        ok: true,
        body: [
          `**${proposal.title}** — a new feature.`,
          ...priorityLines(proposal.priority),
          ...referenceLines(reference),
          "",
          proposal.understanding,
          "",
          plan.body,
        ].join("\n"),
      };
    }

    case "new_story": {
      const under = proposal.parent ? ` under ${proposal.parent}` : "";
      const after = proposal.depends_on.length > 0 ? `\n\n_Waits for ${proposal.depends_on.join(", ")}._` : "";
      const missing = missingReference(db, conversation, proposal);
      if (missing) return { ok: false, reason: missing };
      // The name is judged here, before the card is approvable; where the
      // story lands is judged at approval, once the pipeline is known
      // (EO-364).
      const base = proposalBaseBranch(proposal);
      const unusable = base === null ? null : branchNameProblem(base);
      if (unusable !== null) return { ok: false, reason: `"${proposal.title}" names a base branch EO cannot use. ${unusable}` };
      const existing = proposalExistingBranch(proposal);
      const unworkable = existing === null ? null : branchNameProblem(existing);
      if (unworkable !== null) return { ok: false, reason: `"${proposal.title}" names an existing branch EO cannot use. ${unworkable}` };
      const reference = namedReference(proposal.reference);
      const unnamed = referenceRefusal(proposal.title, reference);
      if (unnamed !== null) return { ok: false, reason: unnamed };
      return {
        ok: true,
        body: [
          `A new story${under}.`,
          "",
          `**${proposal.title}**`,
          ...priorityLines(proposal.priority),
          ...referenceLines(reference),
          "",
          proposal.body,
          "",
          ...proposal.acceptance_criteria.map((criterion) => `- ${criterion}`),
          after,
          ...(base === null ? [] : ["", baseBranchLine(base)]),
          ...(existing === null ? [] : ["", existingBranchLine(existing)]),
        ].join("\n"),
      };
    }

    case "new_bug": {
      const under = proposal.parent ? ` under ${proposal.parent}` : "";
      const missing = missingReference(db, conversation, proposal);
      if (missing) return { ok: false, reason: missing };
      const reference = namedReference(proposal.reference);
      const unnamed = referenceRefusal(proposal.title, reference);
      if (unnamed !== null) return { ok: false, reason: unnamed };
      return {
        ok: true,
        body: [
          `A new bug${under}.`,
          "",
          `**${proposal.title}**`,
          ...priorityLines(proposal.priority),
          ...referenceLines(reference),
          "",
          proposal.body,
          "",
          `**Steps to reproduce:** ${proposal.steps_to_reproduce}`,
          "",
          `**Expected:** ${proposal.expected}`,
          "",
          `**Actual:** ${proposal.actual}`,
          "",
          `**Environment:** ${proposal.environment}`,
          // Only when there are any (EO-205). A bug is not required to
          // carry criteria, and a card that headed an empty list would
          // read as a bug missing something it was never asked for.
          ...(proposal.acceptance_criteria.length > 0
            ? ["", "**Acceptance criteria:**", "", ...proposal.acceptance_criteria.map((criterion) => `- ${criterion}`)]
            : []),
        ].join("\n"),
      };
    }

    case "amend": {
      const item = getItemByKey(db, proposal.item);
      if (!item) return { ok: false, reason: `There is no ticket ${proposal.item}, so there is nothing to change.` };
      const refusal = refuseIfUntouchable(db, item, onlyChangesPriority(proposal) ? "priority" : "content");
      if (refusal) return { ok: false, reason: refusal };

      const lines = [`A change to **${item.key} — ${item.title}**.`, "", `_${proposal.why}_`, ""];
      if (proposal.title !== undefined) lines.push(`**Title:** ${item.title} → ${proposal.title}`, "");
      if (proposal.body !== undefined) lines.push(`**Description →**`, "", proposal.body, "");
      if (proposal.acceptance_criteria !== undefined) {
        lines.push("**Acceptance criteria →**", "", ...proposal.acceptance_criteria.map((criterion) => `- ${criterion}`), "");
      }
      if (proposal.priority !== undefined) lines.push(`**Priority:** ${item.priority} → ${proposal.priority}`, "");
      return { ok: true, body: lines.join("\n") };
    }

    case "reorder": {
      const item = getItemByKey(db, proposal.item);
      if (!item) return { ok: false, reason: `There is no ticket ${proposal.item}, so there is nothing to reorder.` };
      const refusal = refuseIfUntouchable(db, item, "content");
      if (refusal) return { ok: false, reason: refusal };

      const lines = [`A change to what **${item.key}** waits for.`, "", `_${proposal.why}_`, ""];
      if (proposal.add_depends_on.length > 0) lines.push(`Now waits for: ${proposal.add_depends_on.join(", ")}`);
      if (proposal.remove_depends_on.length > 0) lines.push(`No longer waits for: ${proposal.remove_depends_on.join(", ")}`);
      return { ok: true, body: lines.join("\n") };
    }
  }
}

/**
 * One proposal as the rows of its card (EO-407): what approving it would
 * create or change, without the prose.
 *
 * `renderProposal`'s sibling, reading the same proposal through the same
 * functions the apply path does — `childrenFromStories` and
 * `mergeRefineEdges` for a plan, `handedOver` for a single item — so a
 * row is an item `applyDiscussionProposal` would file and a dependency is
 * an edge it would add, the ones derived from overlapping `touches`
 * included. Nothing is read from the card's body.
 *
 * It refuses nothing. Whether a proposal can be built was judged when it
 * was posted and is judged again when it is approved; this only says what
 * it holds, so an item deleted since reads as a key with no title rather
 * than as a card that cannot be drawn.
 *
 * `closed` is left to whoever knows the thread: it is a fact about the
 * card's place in the conversation, not about the proposal.
 */
export function summariseProposal(db: Db, conversation: Item, proposal: DiscussionProposal): Omit<ProposalSummary, "closed"> {
  const projectId = conversation.projectId;
  const labelOf = (name: ItemTypeName): string => {
    const resolved = resolveItemType(db, projectId, name);
    return resolved.ok ? resolved.type.label : typeof name === "string" ? name : name.slug;
  };
  const existing = (key: string): { key: string; title: string } => ({ key, title: getItemByKey(db, key)?.title ?? key });

  switch (proposal.action) {
    case "new_feature": {
      const children = childrenFromStories(proposal.stories);
      const { edges } = mergeRefineEdges(children);
      const reference = namedReference(proposal.reference);
      return {
        container: {
          title: proposal.title,
          typeLabel: labelOf(developerType("feature")),
          ...(proposal.priority === undefined ? {} : { priority: proposal.priority }),
          ...(reference === null ? {} : { reference }),
        },
        rows: children.map((child, index) => ({
          kind: "new" as const,
          title: child.title,
          typeLabel: labelOf(childTypeOf(child)),
          acceptanceCriteria: [...(proposal.stories[index]?.acceptance_criteria ?? [])],
          waitsOn: edges
            .filter((edge) => edge.from === index)
            .flatMap((edge) => {
              const other = children[edge.to];
              return other === undefined ? [] : [{ key: null, title: other.title }];
            }),
          under: null,
          ...(child.priority === undefined ? {} : { priority: child.priority }),
        })),
      };
    }

    case "new_story":
    case "new_bug": {
      const handed = handedOver(proposal);
      const criteria = handed.spec["acceptance_criteria"];
      const row: ProposalRow = {
        kind: "new",
        title: handed.title,
        typeLabel: labelOf(handed.type),
        acceptanceCriteria: Array.isArray(criteria) ? criteria.filter((entry): entry is string => typeof entry === "string") : [],
        waitsOn: handed.depends_on.map(existing),
        under: handed.parent === undefined ? null : existing(handed.parent),
        ...(handed.priority === undefined ? {} : { priority: handed.priority }),
        ...(handed.reference === undefined ? {} : { reference: handed.reference }),
      };
      return { container: null, rows: [row] };
    }

    case "amend": {
      const item = getItemByKey(db, proposal.item);
      const parts: string[] = [];
      if (proposal.title !== undefined) parts.push(`the title, to “${proposal.title}”`);
      if (proposal.body !== undefined) parts.push("the description");
      if (proposal.acceptance_criteria !== undefined) parts.push(`the acceptance criteria (${proposal.acceptance_criteria.length})`);
      if (proposal.priority !== undefined) parts.push(`the priority, to ${proposal.priority}`);
      return {
        container: null,
        rows: [{ kind: "change", itemId: item?.id ?? null, itemKey: proposal.item, itemTitle: item?.title ?? null, change: `Changes ${listOf(parts)}.` }],
      };
    }

    case "reorder": {
      const item = getItemByKey(db, proposal.item);
      const parts: string[] = [];
      if (proposal.add_depends_on.length > 0) parts.push(`Now waits for ${proposal.add_depends_on.join(", ")}.`);
      if (proposal.remove_depends_on.length > 0) parts.push(`No longer waits for ${proposal.remove_depends_on.join(", ")}.`);
      return {
        container: null,
        rows: [{ kind: "change", itemId: item?.id ?? null, itemKey: proposal.item, itemTitle: item?.title ?? null, change: parts.join(" ") }],
      };
    }
  }
}

/** What a card's rows leave out: each new item's description, and where the work would land. */
export interface ProposalAtLength {
  /** One per row of `summariseProposal`, in its order. Empty for a proposal that creates nothing. */
  descriptions: string[];
  /** The fields the project added to each new row's type (EO-735), parallel to `descriptions`. */
  addedFields: ProposedAddedField[][];
  /** The pipeline and the step work enters it at, or null when approval could not say either. */
  landsOn: { pipelineName: string; stepName: string } | null;
}

/**
 * One proposal at full length (EO-408): `summariseProposal`'s other half,
 * for the view that draws a proposed item as an unfiled item.
 *
 * The descriptions are the bodies the apply path files — a plan's through
 * `childrenFromStories`, a single item's through `handedOver`. Where the
 * work lands is `resolvePlacement`'s answer with nothing chosen, which is
 * how `assist:approve` asks it: so the view names the pipeline approval
 * would use, and names none where approval would refuse or have to ask.
 */
export function describeProposal(db: Db, conversation: Item, proposal: DiscussionProposal): ProposalAtLength {
  if (proposal.action === "amend" || proposal.action === "reorder") return { descriptions: [], addedFields: [], landsOn: null };

  const placement = resolvePlacement(db, conversation.projectId, null, proposal.pipeline);
  const pipeline = "problem" in placement ? undefined : listPipelines(db, conversation.projectId).find((entry) => entry.id === placement.pipelineId);
  const step = "problem" in placement ? undefined : listStepsForPipeline(db, placement.pipelineId).find((entry) => entry.id === placement.entryStepId);
  const landsOn = pipeline && step ? { pipelineName: pipeline.name, stepName: step.name } : null;

  const projectId = conversation.projectId;
  if (proposal.action === "new_feature") {
    const children = childrenFromStories(proposal.stories);
    return {
      descriptions: children.map((child) => child.body),
      addedFields: children.map((child) => addedFieldsOf(db, projectId, childTypeOf(child))),
      landsOn,
    };
  }
  const handed = handedOver(proposal);
  return { descriptions: [handed.body], addedFields: [addedFieldsOf(db, projectId, handed.type)], landsOn };
}

/**
 * The line a card's body names a proposed item's priority with, or
 * nothing at 0 (EO-568): Normal is the absence of a priority and says
 * nothing worth a line, as it says nothing worth a badge on the board.
 */
function priorityLines(priority: number | undefined): string[] {
  return priority === undefined || priority === 0 ? [] : [`_Priority: ${priorityLabel(priority)}_`];
}

/** "a", "a and b", "a; b and c" — a semicolon, because a part may carry a comma of its own. */
function listOf(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join("; ")} and ${parts.at(-1)!}`;
}

/**
 * Catches a proposal naming an item that does not exist before it is
 * shown as approvable, rather than at apply time.
 *
 * The apply path checks the same things — it has to, since the project
 * can change between reading a proposal and approving it — but a card
 * that was never going to work should not be offered with a button on
 * it.
 */
function missingReference(db: Db, conversation: Item, proposal: NewStoryProposal | NewBugProposal): string | null {
  const keys = [...(proposal.parent === undefined ? [] : [proposal.parent]), ...(proposal.action === "new_story" ? proposal.depends_on : [])];

  for (const key of keys) {
    const item = getItemByKey(db, key);
    if (!item) return `This proposal refers to ${key}, which does not exist on this project.`;
    if (item.projectId !== conversation.projectId) return `${key} is on a different project.`;
  }

  if (proposal.parent !== undefined) {
    const parent = getItemByKey(db, proposal.parent)!;
    if (!parent.container) return notAContainer(parent);
  }

  return null;
}

/** The fields an amendment can touch, for a before/after the amended item can carry. */
function describeFields(item: Item): Record<string, string> {
  return {
    Title: item.title,
    Description: item.body ?? "",
    "Acceptance criteria": acceptanceCriteriaOf(item).join("\n"),
    Priority: String(item.priority),
  };
}

function diffLines(before: Record<string, string>, after: Record<string, string>): string[] {
  return Object.keys(before)
    .filter((field) => before[field] !== after[field])
    .map((field) => `- **${field}:** ${before[field] || "_(empty)_"} → ${after[field] || "_(empty)_"}`);
}
