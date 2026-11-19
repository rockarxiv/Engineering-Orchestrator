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
import { isJobCard, jobCardBody, jobCardRefusal } from "./jobCards.js";
import { cliToolCardBody, cliToolCardRefusal, isCliToolCard } from "./cliToolCards.js";
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
 * adding one, changing one, removing one (see `itemTypeCards.ts`) — and
 * jobs (EO-786): making, changing and deleting one, and a webhook job's
 * new secret and test event (see `jobCards.ts`) — and command-line tools
 * (EO-822): adding one to the catalogue and giving one to an agent (see
 * `cliToolCards.ts`).
 *
 * The draft's arrangement, for things that are not a graph. The agent
 * names the thing (`AssistCardSchema`) and EO posts a card for it; the
 * person presses the card's button, and `assist:applyCard` carries it out
 * through the channel the pipeline editor used. Nothing here applies
 * anything — this file says what a card is, posts one, and reads back
 * what came of it.
 *
 * Cards are found the way a draft is: they are the last thing their run
 * said. `postAssistReply` posts them after the message, as one comment,
 * and the schema lets nothing else that would be a card arrive beside
 * them — no draft, modules, change or work proposals — so the last agent
 * comment of a run whose result carries `cards` is those cards, and every
 * other comment of it is not. One reply may carry several (EO-862): each
 * is addressed by that comment and its index in the run's `cards`.
 *
 * What came of pressing one is the comment filed under the reply for it:
 * an approval when it was carried out and a rejection when it was
 * refused, each with the sentence the card shows, headed with the card it
 * is about when the reply carries several. That comment is also what
 * stops the card being pressed again, and the reply stays live while any
 * card on it has nothing filed — `approvableIds` — so "cannot be applied
 * twice" holds across windows, and the outcome survives the chat being
 * closed and opened.
 */

/** One card of a reply, with the index in its reply's `cards` it is pressed by (EO-862). */
export interface ReplyCard {
  index: number;
  card: AssistCard;
}

/**
 * What heads each card's part of a reply carrying several, and each
 * outcome filed under one (EO-862): "**Card 2 of 3.** ", counted from 1.
 *
 * It is how a comment records which card it is about — the drawn cards
 * of a reply are the parts of its body, and an outcome is about the card
 * its heading names — and it is what a later turn reads it by. A reply
 * with one card, and every reply from before EO-862, has no heading:
 * there is only card 0 to be about.
 */
function cardHeading(index: number, count: number): string {
  return `**Card ${index + 1} of ${count}.** `;
}

const CARD_HEADING = /^\*\*Card (\d+) of (\d+)\.\*\* /;

/**
 * Text set under a heading — what a card says about itself, why it was
 * refused, what came of pressing it — with anything in it that reads as
 * a heading escaped, so the headings of a comment are only ever the ones
 * written here. A card's own words (a CLI tool's description, a job's
 * name) are the assistant's, and a heading inside them would otherwise
 * make a refused card look drawn, or one card's outcome look like
 * another's.
 */
function unheaded(text: string): string {
  return text.replace(/\*\*Card(?= \d+ of \d+\.\*\*)/g, "\\*\\*Card");
}

/**
 * The card a body is headed with, and the rest of it, or null where it is
 * not headed as a card of a reply carrying `count`. A heading naming
 * another count, or an index past it, is not one this reply wrote.
 */
function headedIndex(body: string, count: number): { index: number; rest: string } | null {
  const heading = CARD_HEADING.exec(body);
  if (heading === null || Number(heading[2]) !== count) return null;
  const index = Number(heading[1]) - 1;
  return index >= 0 && index < count ? { index, rest: body.slice(heading[0].length) } : null;
}

/** The cards a reply's run returned, or none for a comment that is not an agent's card comment of an `assist` run. */
function cardsReturned(db: Db, comment: Comment, thread?: ConversationThread): AssistCard[] {
  if (comment.kind !== PROPOSAL_KIND || comment.runId === null || comment.authorType !== "agent") return [];
  if (runOf(db, comment.runId, thread)?.action !== ASSIST_ACTION) return [];
  return outputOf(db, comment.runId, AssistOutputSchema, thread)?.cards ?? [];
}

/**
 * The cards a comment draws, as its run wrote them, in order — none when
 * the comment is not a card comment (EO-862).
 *
 * The cards of a reply are one comment, the last thing its run said;
 * which of them it draws is the headings of its body, since a card
 * refused when the reply was posted is left out (`postAssistCards`). A
 * reply with one card draws it, as every reply from before EO-862 did.
 */
export function assistCardsOf(db: Db, conversation: Item, comment: Comment, thread?: ConversationThread): ReplyCard[] {
  const cards = cardsReturned(db, comment, thread);
  if (cards.length === 0) return [];

  // Agent comments only, so an engine note filed against the run — a
  // guard's sentence, "Turn stopped." — cannot displace the cards from
  // the end of their own turn.
  const last = (thread ?? threadOf(db, conversation.id)).agentCommentsOf(comment.runId!).at(-1);
  if (last?.id !== comment.id) return [];
  if (cards.length === 1) return [{ index: 0, card: cards[0]! }];

  const drawn: ReplyCard[] = [];
  for (const part of comment.body.split("\n\n")) {
    const heading = headedIndex(part, cards.length);
    if (heading === null) continue;
    const card = cards[heading.index];
    if (card !== undefined && !drawn.some((entry) => entry.index === heading.index)) drawn.push({ index: heading.index, card });
  }
  return drawn;
}

/** One card a comment draws, by its index in the reply's `cards`, or null when the comment draws no such card. */
export function assistCardOf(db: Db, conversation: Item, comment: Comment, index: number, thread?: ConversationThread): AssistCard | null {
  return assistCardsOf(db, conversation, comment, thread).find((entry) => entry.index === index)?.card ?? null;
}

/**
 * What each card on a comment says about itself to the conversation
 * drawing it, in order, or null for a comment that draws none — see
 * `DiscussionMessage.cards`.
 */
export function assistCardView(db: Db, conversation: Item, comment: Comment, thread?: ConversationThread): AssistCardView[] | null {
  const cards = assistCardsOf(db, conversation, comment, thread);
  if (cards.length === 0) return null;
  return cards.map(({ index, card }) => ({ index, kind: card.kind, outcome: cardOutcome(db, conversation, comment.id, index, thread) }));
}

/**
 * What was filed under one card of a reply when its button was pressed,
 * or null while nothing has been (EO-862): the approval or rejection
 * under the reply whose heading names that card. One with no heading is
 * card 0's, which is every outcome filed before EO-862.
 */
export function cardOutcome(db: Db, conversation: Item, commentId: string, index: number, thread?: ConversationThread): AssistCardView["outcome"] {
  const read = thread ?? threadOf(db, conversation.id);
  const reply = read.find(commentId);
  const count = reply === undefined ? 0 : cardsReturned(db, reply, read).length;
  for (const entry of read.under(commentId)) {
    if (entry.kind !== "approval" && entry.kind !== "rejection") continue;
    // A reply with one card has no headings to read: whatever was filed
    // is that card's, as it was before EO-862.
    const filed = count > 1 ? headedIndex(entry.body, count) : { index: 0, rest: entry.body };
    if (filed?.index === index) return { done: entry.kind === "approval", said: filed.rest };
  }
  return null;
}

/**
 * Files what came of pressing one card of a reply under the reply, which
 * spends that card and no other (EO-862).
 *
 * Headed with the card it is about when the reply carries several, so it
 * is read back for that card only and a later turn reads which card it
 * was. A reply with one card gets the outcome as it always did.
 *
 * As the person, since it was their press: the same author an applied
 * module change files its note as (EO-418).
 */
export function fileCardOutcome(db: Db, conversation: Item, comment: Comment, index: number, outcome: { done: boolean; said: string }): void {
  const count = cardsReturned(db, comment).length;
  postComment(db, {
    itemId: conversation.id,
    author: { type: "human" },
    kind: outcome.done ? "approval" : "rejection",
    parentId: comment.id,
    body: count > 1 ? `${cardHeading(index, count)}${unheaded(outcome.said)}` : outcome.said,
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
  if (isJobCard(card)) return jobCardRefusal(db, card);
  if (isCliToolCard(card)) return cliToolCardRefusal(db, card);
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
  if (isJobCard(card)) return jobCardBody(db, card);
  if (isCliToolCard(card)) return cliToolCardBody(db, card);
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
 * Posts the cards a turn returned, and the reason for each that cannot
 * be offered (EO-521, EO-862). Last, after the message — the place
 * `assistCardsOf` reads them from.
 *
 * Each card is asked `assistCardRefusal` on its own. A refused card is
 * not drawn; it is a rejection carrying the reason, naming the card by
 * its place and kind so the next turn knows which one to put right
 * (invariant #8). Every reason of the reply goes in one rejection, posted
 * before the cards that can be offered, which are one comment: each
 * card's prose in order, headed with its place, so a later turn reads
 * every card the reply offered. With every card refused there is only the
 * rejection, and nothing to press.
 *
 * A reply with one card posts it, or its reason, as it always did.
 */
export function postAssistCards(db: Db, conversation: Item, agentId: Uuid, runId: Uuid, initiationId: Uuid | null, cards: readonly AssistCard[]): void {
  if (cards.length === 0) return;
  const post = (kind: typeof PROPOSAL_KIND | "rejection", body: string) =>
    postComment(db, {
      itemId: conversation.id,
      runId,
      author: { type: "agent", agentId },
      kind,
      body,
      parentId: initiationId,
      parseBodyMentions: false,
    });

  const judged = cards.map((card, index) => ({ index, card, refusal: assistCardRefusal(db, conversation, card) }));
  if (cards.length === 1) {
    const [only] = judged;
    // A card that cannot be offered is a rejection carrying the reason,
    // as an unpublishable draft is: nothing with a button on it.
    post(only!.refusal === null ? PROPOSAL_KIND : "rejection", only!.refusal ?? assistCardBody(db, only!.card));
    return;
  }

  const refused = judged.filter((entry) => entry.refusal !== null);
  if (refused.length > 0) {
    post(
      "rejection",
      refused
        .map(({ index, card, refusal }) => `${cardHeading(index, cards.length)}The \`${card.kind}\` card was not offered: ${unheaded(refusal!.replace(/^No card was offered: /, ""))}`)
        .join("\n\n"),
    );
  }
  const offered = judged.filter((entry) => entry.refusal === null);
  if (offered.length > 0) post(PROPOSAL_KIND, offered.map(({ index, card }) => `${cardHeading(index, cards.length)}${unheaded(assistCardBody(db, card))}`).join("\n\n"));
}
