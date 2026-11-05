import {
  AssistOutputSchema,
  ENVIRONMENT_VARIABLES_LIST,
  KEEP_PIPELINE_CARD_KIND,
  MODULE_ENV_NAME_PATTERN,
  TRIAL_PUBLISH_CARD_KIND,
  reservedEnvironmentVariableProblem,
  SECRETS_LIST,
  WEBHOOK_UNATTENDED_LABEL,
  WEBHOOK_UNATTENDED_RISK,
  type AssistCard,
  type AssistCardView,
  type Comment,
  type Item,
  type Pipeline,
  type PipelineStep,
  type Uuid,
} from "@eo/core";
import type { Db } from "../db/client.js";
import {
  getAttachment,
  getPipeline,
  getStep,
  isDiverged,
  openUpdateConflict,
  listStepsForPipeline,
  pipelineHasWebhookEntry,
  postComment,
} from "../db/repos/index.js";
import { noUpdateConflict } from "../gallery/updateConflictDetail.js";
import { heldByTheRecord } from "../gallery/templateUpdates.js";
import { ASSIST_ACTION } from "./conversationSteps.js";
import { isItemTypeCard, itemTypeCardBody, itemTypeCardRefusal } from "./itemTypeCards.js";
import { outputOf, runOf, threadOf, type ConversationThread } from "./conversationThread.js";
import { PROPOSAL_KIND } from "./proposal.js";
import { readTrialPublish } from "../trials/publishCard.js";

/**
 * Cards for what only a person may do, raised in the assistant's room
 * (EO-521): export a pipeline to a file, import an attached one, delete
 * one, or discard this machine's edits to one the organisation manages —
 * and the settings that are deliberately a person's (EO-522): letting a
 * webhook pipeline's items reach a sending step unread, and a step's own
 * secrets and environment variables, whose value the person types on the
 * card and nobody else ever sees — and a project's item types (EO-523):
 * adding one, changing one, removing one (see `itemTypeCards.ts`).
 *
 * The draft's arrangement, for things that are not a graph. The agent
 * names the thing (`AssistCardSchema`) and EO posts a card for it; the
 * person presses the card's button, and `assist:applyCard` carries it out
 * through the channel the pipeline editor used. Nothing here applies
 * anything — this file says what a card is, posts one, and reads back
 * what came of it.
 *
 * A card is found the way a draft is: it is the last thing its run said.
 * `postAssistReply` posts it after the message, and the schema lets
 * nothing else that would be a card arrive beside it — no draft, modules,
 * change or work proposals — so the last agent comment of a run whose
 * result carries a `card` is that card, and every other comment of it is
 * not.
 *
 * What came of pressing it is the comment filed under it: an approval
 * when it was carried out and a rejection when it was refused, each with
 * the sentence the card shows. That comment is also what stops the card
 * being pressed again — `approvableIds` offers no card with anything
 * filed under it — so "cannot be applied twice" holds across windows,
 * and the outcome survives the chat being closed and opened.
 */

/** The card a comment is, as its run wrote it, or null when the comment is not one. */
export function assistCardOf(db: Db, conversation: Item, comment: Comment, thread?: ConversationThread): AssistCard | null {
  if (comment.kind !== PROPOSAL_KIND || comment.runId === null || comment.authorType !== "agent") return null;
  if (runOf(db, comment.runId, thread)?.action !== ASSIST_ACTION) return null;
  const card = outputOf(db, comment.runId, AssistOutputSchema, thread)?.card ?? null;
  if (card === null) return null;

  // Agent comments only, so an engine note filed against the run — a
  // guard's sentence, "Turn stopped." — cannot displace the card from
  // the end of its own turn.
  const last = (thread ?? threadOf(db, conversation.id)).agentCommentsOf(comment.runId).at(-1);
  return last?.id === comment.id ? card : null;
}

/**
 * What a card says about itself to the conversation drawing it, or null
 * for a comment that is not one — see `DiscussionMessage.card`.
 */
export function assistCardView(db: Db, conversation: Item, comment: Comment, thread?: ConversationThread): AssistCardView | null {
  const card = assistCardOf(db, conversation, comment, thread);
  if (card === null) return null;
  return { kind: card.kind, outcome: cardOutcome(db, conversation, comment.id, thread) };
}

/** What was filed under a card when its button was pressed, or null while nothing has been. */
export function cardOutcome(db: Db, conversation: Item, commentId: string, thread?: ConversationThread): AssistCardView["outcome"] {
  const filed = (thread ?? threadOf(db, conversation.id)).under(commentId).find((entry) => entry.kind === "approval" || entry.kind === "rejection");
  return filed === undefined ? null : { done: filed.kind === "approval", said: filed.body };
}

/**
 * Files what came of pressing a card under it, which spends the card.
 *
 * As the person, since it was their press: the same author an applied
 * module change files its note as (EO-418).
 */
export function fileCardOutcome(db: Db, conversation: Item, commentId: Uuid, outcome: { done: boolean; said: string }): void {
  postComment(db, {
    itemId: conversation.id,
    author: { type: "human" },
    kind: outcome.done ? "approval" : "rejection",
    parentId: commentId,
    body: outcome.said,
    parseBodyMentions: false,
  });
}

/**
 * Why a card cannot be offered at all, or null when it can.
 *
 * Asked when the reply is posted, so a card naming a pipeline that is
 * not there, a pipeline whose copy is not edited locally, or a file
 * nobody attached to this chat comes back as a sentence the next turn
 * can act on, rather than as a button that could only ever be refused
 * (invariant #8). The card is read again when it is drawn and when it is
 * pressed — this is not the gate, only the courtesy.
 */
export function assistCardRefusal(db: Db, conversation: Item, card: AssistCard): string | null {
  if (card.kind === TRIAL_PUBLISH_CARD_KIND) return trialPublishRefusal(db, conversation);
  if (card.kind === "stepSecret" || card.kind === "stepVariable") return stepCardRefusal(db, card);
  if (isItemTypeCard(card)) return itemTypeCardRefusal(db, card);
  if (card.kind === "pipelineImport") {
    const attachment = getAttachment(db, card.attachmentId as Uuid);
    // Only a file attached to this chat: an attachment id from another
    // item is somebody else's file, and the person pressing Import has
    // not seen it here.
    if (attachment === undefined || attachment.itemId !== conversation.id) {
      return (
        `No card was offered: there is no file with the ID "${card.attachmentId}" attached to this chat. ` +
        "Use the ID the conversation lists beside the file the person attached, or ask them to attach the pipeline file here."
      );
    }
    return null;
  }

  const pipeline = getPipeline(db, card.pipelineId);
  if (pipeline === undefined || pipeline.archivedAt !== null) {
    return (
      `No card was offered: there is no pipeline with the ID "${card.pipelineId}"${pipeline === undefined ? "" : " that has not been deleted"}. ` +
      "Read the pipelines with `pipelines_list` and name one by the ID it gives."
    );
  }
  if (card.kind === KEEP_PIPELINE_CARD_KIND && openUpdateConflict(db, pipeline.id) === undefined && !heldByTheRecord(db, pipeline.id)) {
    // Nothing to keep it from (EO-534): the card would mark resolved an
    // update nobody is holding. One the organisation's record holds is
    // not here to look at, and is the record's to judge when the card is
    // read and pressed.
    return `No card was offered: ${noUpdateConflict(db, pipeline.id)} Offer this card only for a pipeline \`pipeline_update_conflict\` describes.`;
  }
  if (card.kind === "pipelineDiscardEdits" && !isDiverged(db, pipeline.id)) {
    return (
      `No card was offered: ${pipeline.name} has not been edited locally on this machine, so there is nothing to discard. ` +
      "Discarding edits is only for an organisation pipeline whose copy here has been changed."
    );
  }
  if (card.kind === "pipelineWebhookUnattended") {
    // `pipelines:setWebhookUnattended`'s own refusal, said before there is
    // a button: a waiver given ahead of the webhook is one nobody read the
    // terms of (EO-405).
    if (card.unattended && !pipelineHasWebhookEntry(db, pipeline.id)) {
      return (
        `No card was offered: no webhook job files onto ${pipeline.name}, so there is nothing to send on unread. ` +
        "The setting is only offered for a pipeline a webhook job files onto."
      );
    }
    if (card.unattended === pipeline.webhookUnattended) {
      return `No card was offered: ${pipeline.name} ${card.unattended ? "already sends" : "already does not send"} webhook items on unread, so there is nothing to change.`;
    }
  }
  return null;
}

/**
 * Why the publish card after a draft's trials cannot be offered (EO-588),
 * or null when it can: EO's reading of the trial, not the assistant's —
 * a trial item that did not end where it was expected to keeps the card
 * from being offered until the person chooses Publish anyway at a stop.
 */
function trialPublishRefusal(db: Db, conversation: Item): string | null {
  const read = readTrialPublish(db, conversation);
  const problem = read.ok ? read.view.problem : read.problem;
  return problem === null ? null : `No card was offered: ${problem}`;
}

/**
 * A step a card may name: one that exists on a pipeline that has not been
 * deleted, and is part of its current version (EO-327) — a value filed
 * against a retired step is one no run will ever be given.
 */
export function liveStep(db: Db, stepId: string): { step: PipelineStep; pipeline: Pipeline } | null {
  const step = getStep(db, stepId);
  const pipeline = step === undefined ? undefined : getPipeline(db, step.pipelineId);
  if (step === undefined || pipeline === undefined || pipeline.archivedAt !== null) return null;
  return listStepsForPipeline(db, pipeline.id).some((current) => current.id === step.id) ? { step, pipeline } : null;
}

/** Why a card for a step's own secret or variable cannot be offered, or null when it can (EO-522). */
function stepCardRefusal(db: Db, card: Extract<AssistCard, { kind: "stepSecret" | "stepVariable" }>): string | null {
  if (liveStep(db, card.stepId) === null) {
    return (
      `No card was offered: there is no step with the ID "${card.stepId}" on a pipeline that has not been deleted. ` +
      "Read the pipeline with `pipeline_get` and name the step by the ID it gives."
    );
  }
  if (!MODULE_ENV_NAME_PATTERN.test(card.name)) {
    return `No card was offered: "${card.name}" is not an environment-variable name. Use the name a module's \`needs.env\` declares — letters, digits and underscores, not starting with a digit.`;
  }
  if (card.kind === "stepVariable" && card.action === "set") {
    const reserved = reservedEnvironmentVariableProblem(card.name);
    if (reserved !== null) return `No card was offered: ${reserved}`;
  }
  return null;
}

/**
 * What a card says in prose — what a later turn reads back. The chat
 * layout draws the card from
 * `assist:card` instead, so what it says about the pipeline is true when
 * it is read.
 */
export function assistCardBody(db: Db, card: AssistCard): string {
  if (card.kind === TRIAL_PUBLISH_CARD_KIND) {
    return (
      "**Publish** the draft as it was tested. The card shows what changed since you approved the design, how each step ran, where each test item ended and what the assistant answered in your place; " +
      "publishing runs every module's tests, approves them and publishes the pipeline in one step, then deletes the trial. Nothing is published until Publish is pressed on the card."
    );
  }
  if (isItemTypeCard(card)) return itemTypeCardBody(db, card);
  if (card.kind === "stepSecret" || card.kind === "stepVariable") {
    const found = liveStep(db, card.stepId);
    const where = found === null ? "the step" : `the ${found.step.name} step of ${found.pipeline.name}`;
    const what = card.kind === "stepSecret" ? `the secret ${card.name}` : `the environment variable ${card.name}`;
    const list = card.kind === "stepSecret" ? SECRETS_LIST : ENVIRONMENT_VARIABLES_LIST;
    // Never a value: the card has none to say, and a person types theirs
    // on the card, where it goes to the store and nowhere else.
    return card.action === "set"
      ? `**Set** ${what} for ${where} (${list}). Type the value on the card — it is not sent to the assistant, and nothing is set until Set is pressed.`
      : `**Clear** ${what} for ${where} (${list}). The step falls back to the shared value, if there is one; nothing is cleared until Clear is pressed.`;
  }
  if (card.kind === "pipelineImport") {
    const name = getAttachment(db, card.attachmentId as Uuid)?.name ?? "the attached file";
    return `**Import** the pipeline in ${name}. The card shows what it would need here and asks about any module it shares a name with; nothing is imported until Import is pressed.`;
  }
  const name = getPipeline(db, card.pipelineId)?.name ?? "the pipeline";
  switch (card.kind) {
    case "pipelineExport":
      return `**Export** ${name} to a file. Export on the card asks where to save it.`;
    case "pipelineDelete":
      return `**Delete** ${name}. It goes to the Archive with the items on it, and nothing is archived until Delete is pressed on the card.`;
    case "pipelineDiscardEdits":
      return (
        `**Discard my edits** to ${name}. This machine's copy goes back to the version your organisation published, and its updates resume. ` +
        "Only the button on the card discards them."
      );
    case "pipelineKeepMine": {
      // One the organisation's record holds is not this database's to name; the card reads it from there.
      const held = heldByTheRecord(db, card.pipelineId) ? undefined : openUpdateConflict(db, card.pipelineId);
      const update = held === undefined ? "its template update" : `the template's update from ${held.fromVersion} to ${held.toVersion}`;
      return (
        `**Keep my pipeline and skip this update.** ${name} stays exactly as it is, ${update} is marked resolved, and the next template version is compared with ${held === undefined ? "the skipped one" : held.toVersion}. ` +
        "Nothing changes until the button on the card is pressed."
      );
    }
    case "pipelineWebhookUnattended":
      return card.unattended
        ? `**${WEBHOOK_UNATTENDED_LABEL}** on ${name}. ${WEBHOOK_UNATTENDED_RISK} Nothing changes until the button on the card is pressed.`
        : `**Stop** sending webhook items on ${name} on without a person reading them. ${WEBHOOK_UNATTENDED_RISK} Nothing changes until the button on the card is pressed.`;
  }
}

/**
 * Posts the card a turn returned, or the reason it cannot be offered
 * (EO-521). Last, after the message — the place `assistCardOf` reads it
 * from.
 */
export function postAssistCard(db: Db, conversation: Item, agentId: Uuid, runId: Uuid, initiationId: Uuid | null, card: AssistCard): void {
  const refusal = assistCardRefusal(db, conversation, card);
  postComment(db, {
    itemId: conversation.id,
    runId,
    author: { type: "agent", agentId },
    // A card that cannot be offered is a rejection carrying the reason,
    // as an unpublishable draft is: nothing with a button on it.
    kind: refusal === null ? PROPOSAL_KIND : "rejection",
    body: refusal ?? assistCardBody(db, card),
    parentId: initiationId,
    parseBodyMentions: false,
  });
}
