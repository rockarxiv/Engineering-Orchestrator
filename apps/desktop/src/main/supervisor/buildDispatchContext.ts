import { assembleContext, assembleFollowUpContext, assembleSeedContext, type AssembledFollowUpContext, type AssembleContextInput, type AttributedComment, type ContextItemInput, type SectionRenderer } from "@eo/engine";
import { acceptanceCriteriaOf, actionOverridesFor, definedActionFor, renderActionDefinitionTask, UNKNOWN_ITEM_TYPE, fullThreadEnabled, parsedResultOf, HUMAN_MESSAGE_EVENT, INTERPRET_ACTION, type Agent, type Comment, type CommentKind, type HumanMessageEvent, type Run, type Item, type Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import { reviewAppendix } from "../packs/developer/forge/reviewAppendix.js";
import { implementAppendix } from "../packs/developer/workspace/commitNaming.js";
import {
  asGitWorkspace,
  projectWorkspaceList,
  currentOutputOf,
  getItem,
  listAgents,
  listCommentsForItem,
  listDependencies,
  listItemAttachments,
  listRunEvents,
  listRunsForItem,
  listStepsForPipeline,
  listMentionsForComment,
  listTransitionsForItem,
  webhookPayloadForItem,
  getItemType,
  stepForItem,
} from "../db/repos/index.js";
import { packMeaningInForce, registryForProject } from "../registry.js";
import { PREVIEW_TASK_NOTE } from "../preview.js";
import { createStepAttribution, humanCommentsSince, lastRunOf, latestCommentPerStep } from "./stepAttribution.js";
import { newestAnswerToLastAsk } from "../roles/answers.js";
import { ASSIST_ACTION, SCENARIO_ACTION } from "../roles/conversationSteps.js";
import { scenarioTaskAppendix } from "../roles/scenario.js";
import { RESPOND_ACTION } from "./manualDispatch.js";
import { resolveItemWorkspace } from "./workspaceResolution.js";

/**
 * The actions whose material *is* the conversation.
 *
 * Intake and refine read a feature's thread to decide what the work is;
 * assist and scenario are chats held in one. `interpret` is the
 * sharpest case of all (EO-184): what it is asked to read is a question
 * and the reply under it, both of which are comments, so a seeded
 * context would hand it everything except the thing it exists to read.
 * None of them can be seeded, so they keep the full assembly whoever
 * runs them — which is what protects an agent a person has just created,
 * whose empty config makes every capability question answer no.
 */
const CONVERSATION_ACTIONS = new Set<string>(["intake", "refine", ASSIST_ACTION, SCENARIO_ACTION, INTERPRET_ACTION]);

/** Matches assembleContext's own default budget rationale — generous, since truncation only kicks in above it. */
export const DEFAULT_CONTEXT_MAX_TOKENS = 24_000;

/**
 * The item as a prompt sees it (KAN-161).
 *
 * One spelling for both shapes, because the full assembly and the seed
 * hand the same value to the same section renderers and a difference
 * between them would be a difference in what an agent is judged
 * against.
 *
 * `actionOverrides` comes off the type rather than off a comparison with
 * the word `feature`: what an action means on this kind of item is what
 * the type says it means (KAN-163), resolved here against the project's
 * registry so that a type overriding nothing carries the default its
 * action's role shipped. A pack's section renderer reads it; nothing the
 * engine itself renders does.
 *
 * An unknown type — a row deleted in another window — resolves as a leaf
 * that overrides nothing, which is what the flag's absence used to mean
 * and the conservative answer for the same reason: a leaf is refined by
 * being checked, not decomposed.
 *
 * Asked of the item's own row rather than by its word (KAN-129). Types
 * are rows scoped to a project now, and two packs may both ship a
 * `case` — so the word is a question with two answers where the id is
 * the type this item actually is.
 */
function itemView(db: Db, item: Item): ContextItemInput {
  const type = getItemType(db, item.typeId);
  return {
    key: item.key,
    title: item.title,
    body: item.body,
    // By the name the item's type declares (KAN-147), so a type that
    // calls its bar something else still has it read into the prompt
    // rather than silently sending an agent nothing to work to.
    acceptanceCriteria: acceptanceCriteriaOf(item, type?.specShape),
    actionOverrides: actionOverridesFor(registryForProject(db, item.projectId), type ?? UNKNOWN_ITEM_TYPE),
    // The resolution the dispatch itself makes (EO-413) — the step's
    // pick before the item's own workspace, and `none` where there is
    // no disk — so a pack's section about a kind of disk is rendered on
    // exactly the runs that are handed one.
    workspaceKind: resolveItemWorkspace(db, item).kind,
    // The item's own files (EO-703), as the metadata a comment's files
    // are rendered with — every one of them, since the engine renders
    // the list among the sections truncation never takes from.
    files: listItemAttachments(db, item.id).map((file) => ({
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      size: file.size,
      origin: file.managed ? ("eo" as const) : ("legacy" as const),
      synchronizationState: "local" as const,
    })),
  };
}

/**
 * Resolves a comment's author to a display name/role. assembleContext is
 * pure and takes attribution pre-resolved (ARCHITECTURE.md, "What an agent is given") — mapping an
 * authorId to
 * an agent name is a DB lookup, so it happens here.
 */
function attribute(comment: Comment, agentsById: Map<string, Agent>): AttributedComment {
  const agent = comment.authorId ? agentsById.get(comment.authorId) : undefined;
  return {
    id: comment.id,
    authorType: comment.authorType,
    // "a module" rather than falling through to "unknown agent" (EO-75).
    // What an agent reads here is the thread, and a note signed by an
    // agent nobody can name is worse than one signed by what wrote it.
    authorName:
      comment.authorType === "human" ? "you" : comment.authorType === "engine" ? "EO" : comment.authorType === "module" ? "a module" : (agent?.name ?? "unknown agent"),
    authorRole: agent?.role ?? null,
    parentId: comment.parentId,
    body: comment.body,
    kind: comment.kind,
    attachments: (comment.attachments ?? []).flatMap((attachment) => attachment.id ? [{
      id: attachment.id,
      name: attachment.name,
      mimeType: attachment.mimeType,
      size: attachment.size,
      origin: attachment.origin ?? "eo",
      synchronizationState: "local" as const,
    }] : []),
    pinned: comment.pinned,
    createdAt: comment.createdAt,
  };
}

/**
 * The item's output as a renderer sees it, or null where it has none
 * (EO-298, ARCHITECTURE.md, "The output is a comment").
 *
 * Asked of the database rather than picked out of a comment list a
 * caller already holds, even where one does. `currentOutputOf` is the
 * one definition of which output is current — latest by `created_at`,
 * id breaking a same-millisecond tie — and a second reading of the same
 * rule beside it is a second reading to keep in step. The query is
 * indexed on `(item_id, created_at)` and runs once per dispatch.
 */
function outputView(db: Db, item: Item, agentsById: Map<string, Agent>): AttributedComment | null {
  const output = currentOutputOf(db, item.id);
  return output === undefined ? null : attribute(output, agentsById);
}

/**
 * "What shipped" for a dependency — the structured result of its last
 * succeeded run, which is the only machine-readable record of what that
 * item actually produced.
 */
function shippedSummary(db: Db, itemId: Uuid): string {
  const succeeded = listRunsForItem(db, itemId)
    // A dry run is excluded, and this is the one place it matters most
    // (KAN-106). Dry-running a module borrows some item's worktree and
    // leaves the newest succeeded-with-result run on it — so without this
    // filter, the next agent working on anything that *depends* on that
    // item is told it shipped `{"result":"deployed"}` instead of what
    // its implementer actually produced.
    .filter((run) => run.status === "succeeded" && run.result !== null && !run.dryRun)
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0) || b.id.localeCompare(a.id))[0];
  if (!succeeded?.result) return "(no recorded result yet)";
  // The validated half — the raw form is kept for forensics (A-02), not for feeding downstream agents.
  return JSON.stringify(parsedResultOf(succeeded.result));
}

/**
 * Reframes the task for a `respond` dispatch.
 *
 * The default task line reads "perform the respond action on this item",
 * which tells an agent nothing about who is waiting or where its answer
 * goes. An implementer reading only that does the work and reports it in
 * the shape its own instructions describe — which is what happened, and
 * what left the mention open.
 */
function mentionAppendix(action: string): string | null {
  if (action !== RESPOND_ACTION) return null;
  return [
    "Somebody `@`-mentioned you in the comment thread below. Answer the most recent thing addressed to you.",
    "Do whatever it actually asks for — this is a real request, not a status check — and then say what you did.",
    // Worth stating, because the alternative reading is "reply and stop".
    "Your `message` is posted to the thread as your own comment, and it is the only part of this run anyone sees.",
    "The ticket does not move; answering a question is not progress through the pipeline.",
  ].join(" ");
}

/**
 * Reframes the task for an `interpret` dispatch (EO-184).
 *
 * The strongest case for an appendix of the three, because the default
 * task line — "perform the interpret action on this item" — describes
 * neither the item nor the job. The item is somebody's work, parked;
 * the job is one sentence somebody typed into it, which the step that
 * asked cannot read.
 *
 * The question and the reply are named rather than left to be found. The
 * thread below carries both, but "the newest thing a person said after
 * EO's last escalation" is a rule this file already applies for the
 * waiting step, and an agent working it out again from the same thread
 * is an agent that can work it out differently.
 */
function interpretAppendix(db: Db, item: Item, action: string): string | null {
  if (action !== INTERPRET_ACTION) return null;

  const answer = newestAnswerToLastAsk(db, item.id);
  const offered =
    answer && answer.offered.length > 0
      ? `It offered these answers, and any one of them is usable verbatim: ${answer.offered.map((option) => `"${option}"`).join(", ")}.`
      : "It offered no set answers, so there is no list to choose from.";
  const said = answer === null ? "" : ` What they said: "${excerptForTask(answer.text)}".`;

  return [
    `A step here stopped and asked a question, and somebody answered it in their own words rather than by picking one of the answers on offer. ${offered}${said}`,
    "The step runs EO's own code and cannot read a sentence — left alone it would ask the identical question again — so you are reading it for the step.",
    "Do one of three things, and the shape you return says which.",
    "**answered**: the reply means one of the answers the step can use, and `answer` is that answer in the step's own words, not a paraphrase of the sentence. It is posted where the step looks for it and the step is run again.",
    "**acted**: the reply asked for something to be done rather than answered. Do it with your tools, say what you did in `summary`, and set `retry` to whether the step should now be run again.",
    "**unusable**: you cannot honestly read it as either. Say what is missing in `problem`; it is quoted back and the person answers again.",
    "The ticket does not move and this run changes nothing about where it stands. Do not answer on the person's behalf: if two of the options fit and nothing chooses between them, that is `unusable` or a question, not a guess.",
  ].join("\n\n");
}

/** A person's reply, kept short enough for a task line. */
function excerptForTask(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > 400 ? `${collapsed.slice(0, 400)}…` : collapsed;
}


/**
 * The extra instructions this dispatch's task line carries, if any.
 *
 * Shared by the full assembly and the follow-up prompt (EO-91) because
 * it is task framing rather than context: it says what this dispatch is
 * for, which is precisely the thing a resumed thread cannot already
 * know. Leaving it off a resumed `respond` turn would put back the bug
 * `mentionAppendix` exists to fix — an implementer that does the work
 * and reports it in its own shape, leaving the mention open — for the
 * one class of agent that has thread reuse switched on.
 *
 * Everything it can render is a sentence about the action. None of it is
 * the item body, the acceptance criteria, the repository listing or
 * the role prompt, which is what a reused thread already holds.
 */
async function taskAppendixFor(db: Db, item: Item, action: string, role: string | null): Promise<string | null> {
  const framing =
    (await reviewAppendix(db, item, action, role)) ??
    implementAppendix(db, item, action, role) ??
    (action === SCENARIO_ACTION ? scenarioTaskAppendix(db, item) : null) ??
    interpretAppendix(db, item, action) ??
    mentionAppendix(action);

  // What this role says the action is, and which results it may answer
  // with (EO-421). The schema holds the answer to those keys; this is
  // what tells the agent which of them is true. Above whatever framing
  // the action name carries, and composed with it for the preview note's
  // reason below — a fact about the *role's* definition, true whichever
  // framing applied.
  //
  // Not on a preview, which is held to no role's definition — see
  // `definingRole` in the supervisor: telling the placeholder which keys
  // to answer with would describe a schema it was not sent.
  const defined = definedActionFor(registryForProject(db, item.projectId), item.previewAt === null ? role : null, action);
  const definition = defined === undefined ? null : renderActionDefinitionTask(defined.definition);
  const forAction = definition === null ? framing : framing === null ? definition : `${definition}\n\n${framing}`;

  // A preview says so, above whatever else this action carries (EO-313,
  // ARCHITECTURE.md, "Preview"). Composed rather than chosen between, unlike everything above
  // it: those five are alternative framings of one action and exactly
  // one can apply, while this is a fact about the *item* that is true
  // whichever of them did. A `??` here would have silently dropped the
  // sentence on precisely the dispatches that already had something to
  // say — a preview reaching the reviewer, say.
  if (item.previewAt === null) return forAction;
  return forAction === null ? PREVIEW_TASK_NOTE : `${PREVIEW_TASK_NOTE}\n\n${forAction}`;
}

/**
 * Assembles the real dispatch context for an item — the DB-facing half
 * of E-06, whose pure half is assembleContext() in packages/engine.
 * The whole thread, for a conversational role (ARCHITECTURE.md, "What an agent is given") — a
 * step-owning agent
 * is seeded instead, by `buildSeedContext` below.
 *
 * It takes no agent, which is worth saying out loud because it used to.
 * The only thing it read off one was `instructions`, and those are the
 * provider's to send — `start({ instructions, context })` — so appending
 * them here put the role prompt in the prompt twice. What is left is a
 * function of the item and the action alone: two dispatches of the same
 * action on the same item assemble the same text whoever is taking it.
 */
export async function buildDispatchContext(
  db: Db,
  item: Item,
  action: string,
  sectionRenderers: readonly SectionRenderer[] = [],
  maxTokens = DEFAULT_CONTEXT_MAX_TOKENS,
  /**
   * The dispatched agent's role, for the one thing here that is the
   * role's rather than the item's: its own definition of this action
   * (EO-421), and with it whether the pack's sections for that action
   * name apply (EO-422). Null where there is no agent in hand, which
   * renders the task as it always was.
   */
  role: string | null = null,
): Promise<string> {
  const agentsById = new Map(listAgents(db).map((candidate) => [candidate.id as string, candidate]));

  const parent = item.parentId ? getItem(db, item.parentId) : undefined;
  const parentFeature: AssembleContextInput["parentFeature"] = parent
    ? {
        key: parent.key,
        title: parent.title,
        body: parent.body,
        pinnedComments: listCommentsForItem(db, parent.id)
          .filter((comment) => comment.pinned)
          .map((comment) => attribute(comment, agentsById)),
      }
    : null;

  const dependencies = listDependencies(db, item.id).flatMap((edge) => {
    const dep = getItem(db, edge.dependsOnId);
    return dep ? [{ key: dep.key, title: dep.title, summary: shippedSummary(db, dep.id) }] : [];
  });

  // The repositories this project spans (KAN-17). `assembleContext`
  // renders nothing for fewer than two, so a single-repo project's prompt
  // is unchanged — and this is the only place the product owner learns
  // which codebases exist, having previously been asked for accurate
  // `touches` paths without being told about any.
  // The repositories among them, because that is what this section
  // says it lists and what its fields are — a path to a checkout and a
  // description of what lives there. A folder workspace has neither,
  // and a section that named one anyway would be describing a drive as
  // though an agent could branch in it (EO-299).
  const repositories = item.projectId === null ? [] : projectWorkspaceList(db, item.projectId).flatMap((workspace) => asGitWorkspace(workspace) ?? []);
  // KAN-18: the project decides whether the implementer proposes first.
  // The step's own setting, not the project's (ARCHITECTURE.md, "A step"). Plan mode asks the
  // step that implements to plan first and write nothing, which is a
  // property of that step — and two pipelines in one project can now
  // differ, which is exactly what putting it on the group prevented.
  const planMode = stepForItem(db, item)?.planMode ?? false;

  return assembleContext({
    action,
    repositories: repositories.map((workspace) => ({ name: workspace.config.name, description: workspace.config.description })),
    planMode,
    packAction: packMeaningInForce(db, item, role, action),
    // What the installed pack says on top of the core's own sections:
    // the acceptance criteria, the plan-mode check, and whether `refine`
    // means "decompose this" or "check this can be worked as written"
    // (KAN-161). Handed in by the composition root, through the
    // supervisor — this file builds what it is told to build.
    sectionRenderers,
    // F-06: only ever set on a review, and only when the repository opens
    // pull requests. Everything else gets exactly the context it did.
    taskAppendix: await taskAppendixFor(db, item, action, role),
    item: itemView(db, item),
    // The event this item was made from, if one made it (EO-334, ARCHITECTURE.md, "What an agent is
    // given").
    // Rendered as a quoted, untrusted block and never as the item's own
    // text: the title and body a job's mapping produced are above, as
    // ordinary fields, and this is the body those were read out of.
    untrustedPayload: webhookPayloadForItem(db, item.id),
    // Derived, never stored (EO-298): the latest output comment on the
    // item. Handed to the pack's renderers and rendered by none of the
    // engine's own — how an output is worth showing is a pack's opinion,
    // and *that* it is the current one is the fact the design turned on.
    currentOutput: outputView(db, item, agentsById),
    parentFeature,
    commentThread: listCommentsForItem(db, item.id).map((comment) => attribute(comment, agentsById)),
    dependencies,
    maxTokens,
  }).fullText;
}

/**
 * The comments an agent has not seen (EO-89).
 *
 * The DB-facing half of the follow-up prompt, whose pure half is
 * `assembleFollowUpContext()` in packages/engine. Two filters, and both
 * of them need something the engine is not allowed to know:
 *
 * **The watermark.** Everything posted after the agent's prior run
 * finished — everything before that was in the context that run was
 * given, or was said inside the thread itself. `endedAt` rather than
 * `startedAt`, so a comment written while the run was still going is
 * carried rather than assumed read: the run may well have ended before
 * it landed.
 *
 * The tie is what makes this more than a `>`. Two rows can share a
 * millisecond, and `deferredReplyItemIds` already breaks that tie on
 * the id — uuidv7 mints monotonically for exactly this — where
 * `resumeItem` used to filter on the timestamp alone and so dropped a
 * reply posted in the same millisecond its run ended: the one comment
 * the agent was most likely woken for. Both paths come through here now
 * (EO-91), which is what stops that being fixed in one of them. There is
 * no natural ordering to fall back on either: `listCommentsForItem`
 * orders by `(createdAt, id)` and a comparison on `createdAt` alone
 * splits that pair in the wrong place.
 *
 * **The agent's own comments.** Already in its thread — it wrote them —
 * and re-sending them is precisely the waste the reused thread exists to
 * remove. Only its own: a module's comment carries a null `authorId` and
 * a human's carries none, so the `authorType === "agent"` half of the
 * test is what keeps `authorId === null` from matching an agent with no
 * id. The reviewer, the engine, a module and a person all come through.
 *
 * A prior run with no `endedAt` — still running, or never finished —
 * falls back to 0, which sends the whole thread rather than nothing. The
 * same fallback `resumeItem` and `deferredReplyItemIds` make: too
 * much context costs tokens, too little costs the agent the reply it was
 * woken for.
 *
 * **And the messages that were queued while the run was still going**
 * (EO-176). Those are older than the watermark by construction — a
 * person wrote them *during* the turn — so the filter above drops every
 * one of them, and the run woken by such a message would arrive holding
 * nothing new to read. The prior run's own log says which they were:
 * a `human_message` row recorded as undelivered is exactly "somebody
 * said this and the turn never got it". Delivered ones are not carried,
 * because the turn did get those and the thread it is resuming already
 * has them in it.
 *
 * **Whether or not the room that took the message wrote that row**
 * (EO-396). The row is written by `steerRun`, which only the composers
 * that can steer ever reach; the scenario chat posts a comment with a
 * mention and nothing else. There
 * the message was older than the watermark *and* unrecorded, so the turn
 * its own mention started was told nothing new had been said. So the
 * rule no longer waits to be told: a person's comment minted after the
 * prior run's row is carried unless that run's log says the turn got it.
 * The log is still what keeps a steered message out; it has stopped
 * being what lets a queued one in, which is what a room added later
 * would otherwise have to remember.
 *
 * The run's *id* is the near edge rather than its `startedAt`, for two
 * reasons. A row is live — and a composer says "this will be queued" —
 * from the moment it is created, seconds before it is marked running,
 * and a message sent in that gap is the same message. And it errs the
 * way everything here errs: a comment that slipped in before the prompt
 * was assembled is read twice, which costs tokens, where the other edge
 * would lose it. It is carried once all the same — the turn that reads
 * it is a newer row than the comment, so the turn after that one starts
 * its count later.
 */
export function followUpComments(db: Db, itemId: Uuid, agentId: Uuid, priorRun: Run): AttributedComment[] {
  const agentsById = new Map(listAgents(db).map((candidate) => [candidate.id as string, candidate]));
  const endedAt = priorRun.endedAt ?? 0;
  const said = saidDuring(db, priorRun);

  return listCommentsForItem(db, itemId)
    // First, and ahead of every way in below: what the turn was handed
    // is in the thread being resumed, whatever the clock says about it.
    // As one more condition on the last branch it held only there — a
    // message steered into a turn that ended in the same millisecond is
    // on the later side of the watermark's tie-break, and came back
    // through that door instead.
    .filter((comment) => !said.delivered.has(comment.id))
    .filter(
      (comment) =>
        comment.createdAt > endedAt ||
        (comment.createdAt === endedAt && comment.id > priorRun.id) ||
        said.queued.has(comment.id) ||
        (comment.authorType === "human" && comment.id > priorRun.id),
    )
    .filter((comment) => !(comment.authorType === "agent" && comment.authorId === agentId))
    .map((comment) => attribute(comment, agentsById));
}

/**
 * What this run's log says became of the messages a person sent at it
 * (EO-176): the comment ids it was handed mid-turn, and the ones recorded
 * as left for the next.
 */
function saidDuring(db: Db, priorRun: Run): { queued: Set<string>; delivered: Set<string> } {
  const queued = new Set<string>();
  const delivered = new Set<string>();
  for (const event of listRunEvents(db, priorRun.id)) {
    if (event.type !== HUMAN_MESSAGE_EVENT) continue;
    const payload = event.payload as HumanMessageEvent | null;
    if (payload) (payload.delivered ? delivered : queued).add(payload.commentId);
  }
  return { queued, delivered };
}

/**
 * The prompt a resumed thread gets (EO-89) — the follow-up counterpart of
 * `buildDispatchContext`.
 *
 * `priorRun` is the agent's last run on this item: the run whose thread
 * is being resumed, and whose end is the watermark. It is passed in
 * rather than looked up because the two callers find it differently — the
 * human-reply path already holds the parked run it is answering, and the
 * dispatch path holds the run whose thread it decided to reuse — and a
 * second, third-party opinion on which run that is would be a way for
 * them to disagree.
 */
export function buildFollowUpContext(
  db: Db,
  item: Item,
  agent: Agent,
  action: string,
  priorRun: Run,
  options: { taskAppendix?: string | null; maxTokens?: number; sectionRenderers?: readonly SectionRenderer[] } = {},
): AssembledFollowUpContext {
  const agentsById = new Map(listAgents(db).map((candidate) => [candidate.id as string, candidate]));
  return assembleFollowUpContext({
    action,
    taskAppendix: options.taskAppendix ?? null,
    newComments: followUpComments(db, item.id, agent.id, priorRun),
    // The caller's own sections, of which this shape renders the
    // volatile ones (EO-298). What that is for is the implementer sent
    // back after review: it resumes its own thread, its previous
    // attempt's diff is filtered out of the delta as a comment it wrote
    // itself, and a correction a person made to that diff before
    // sending it back would arrive as a one-line marker. So the second
    // attempt was the one dispatch on the item that could not see what
    // the item had produced.
    ...(options.sectionRenderers ? { sectionRenderers: options.sectionRenderers } : {}),
    item: itemView(db, item),
    planMode: stepForItem(db, item)?.planMode ?? false,
    packAction: packMeaningInForce(db, item, agent.role, action),
    currentOutput: outputView(db, item, agentsById),
    maxTokens: options.maxTokens ?? DEFAULT_CONTEXT_MAX_TOKENS,
  });
}


/**
 * The comment that woke a `respond` dispatch.
 *
 * An open mention aimed at this agent — the newest one, since a second
 * question supersedes the first. It is carried explicitly because no
 * other rule would: a mention written by *another agent* is neither a
 * human comment nor necessarily the newest word at its step, so the
 * implementer would arrive told to "answer the most recent thing
 * addressed to you" with no idea what that was.
 */
function triggerComment(db: Db, item: Item, agent: Agent, action: string, agentsById: Map<string, Agent>): AttributedComment | null {
  if (action !== RESPOND_ACTION) return null;

  const asking = listCommentsForItem(db, item.id)
    .filter((comment) =>
      listMentionsForComment(db, comment.id).some(
        (mention) => mention.status === "open" && mention.targetType === "agent" && mention.targetId === agent.id,
      ),
    )
    .at(-1);

  return asking ? attribute(asking, agentsById) : null;
}

/**
 * What a step-owning agent is dispatched with.
 *
 * The item, the newest word from every step it has been through, what
 * a person has said since this agent last looked, and an honest census
 * of what that leaves out. Everything else is a tool call away.
 *
 * Unlike `buildDispatchContext` this takes the agent, and has to: "since
 * *this agent's* last run" is agent-scoped by construction, so two
 * agents dispatched for the same action on the same item do not
 * receive the same text. That is a real difference from the full
 * assembly and worth stating rather than discovering.
 */
export async function buildSeedContext(db: Db, item: Item, agent: Agent, action: string, sectionRenderers: readonly SectionRenderer[] = []): Promise<string> {
  const agentsById = new Map(listAgents(db).map((candidate) => [candidate.id as string, candidate]));
  const comments = listCommentsForItem(db, item.id);
  const runs = listRunsForItem(db, item.id);
  const attribution = createStepAttribution(item, listTransitionsForItem(db, item.id), runs);

  const stepNames = new Map(
    (item.pipelineId === null ? [] : listStepsForPipeline(db, item.pipelineId)).map((step) => [step.id as string, step.name]),
  );
  // An output is a deliverable rather than a remark, so it is neither
  // what a step *said* nor what a person *said* (EO-298). Left among
  // them it would take the newest word's place at the step that produced
  // it — the implementer's handover note displaced by the diff — or
  // arrive under "what the person said" as a line saying a diff exists,
  // while the prompt already carries the whole of it in a section of its
  // own.
  //
  // Nothing is lost either way. The current output is that section, and
  // the ones it superseded fall to the census below like anything else,
  // which is what keeps the bargain honest: every comment is rendered or
  // counted.
  const said = comments.filter((comment) => comment.kind !== "output");
  const stepComments = latestCommentPerStep(said, attribution).map((entry) => ({
    // The id where a step has been renamed out from under an old run, or
    // where the item has changed pipeline: a name nobody can look up
    // is worse than the id it stands for.
    stepName: stepNames.get(entry.stepId) ?? entry.stepId,
    comment: attribute(entry.comment, agentsById),
  }));

  const humanComments = humanCommentsSince(said, lastRunOf(runs, agent.id)).map((comment) => attribute(comment, agentsById));
  // The repositories among them, because that is what this section
  // says it lists and what its fields are — a path to a checkout and a
  // description of what lives there. A folder workspace has neither,
  // and a section that named one anyway would be describing a drive as
  // though an agent could branch in it (EO-299).
  const repositories = item.projectId === null ? [] : projectWorkspaceList(db, item.projectId).flatMap((workspace) => asGitWorkspace(workspace) ?? []);
  const trigger = triggerComment(db, item, agent, action, agentsById);
  const currentOutput = outputView(db, item, agentsById);

  const shown = new Set([
    ...stepComments.map((entry) => entry.comment.id as string),
    ...humanComments.map((comment) => comment.id as string),
    // Rendered in full by whatever section a pack supplies for it, so it
    // is not among what was left out — the census counts what is gone,
    // and this is the one comment on the ticket that certainly is not
    // (EO-298).
    ...(currentOutput ? [currentOutput.id as string] : []),
    // Pinned comments on this item are rendered in full, so they are
    // not also "left out" — the census must count what is actually gone.
    ...comments.filter((comment) => comment.pinned).map((comment) => comment.id as string),
    ...(trigger ? [trigger.id as string] : []),
  ]);
  const omittedComments = comments.filter((comment) => !shown.has(comment.id)).map((comment) => attribute(comment, agentsById));

  // Counted by who said it and what kind it was, because "44 omitted" is
  // not a fact anyone can act on. Sorted by count so the largest group
  // reads first, and the order is stable rather than whatever the map
  // happened to iterate.
  const tally = new Map<string, { authorName: string; kind: CommentKind; count: number }>();
  for (const comment of omittedComments) {
    const key = `${comment.authorName}\u0000${comment.kind}`;
    const held = tally.get(key);
    if (held) held.count += 1;
    else tally.set(key, { authorName: comment.authorName, kind: comment.kind, count: 1 });
  }

  return assembleSeedContext({
    action,
    taskAppendix: await taskAppendixFor(db, item, action, agent.role),
    planMode: stepForItem(db, item)?.planMode ?? false,
    // The engine is handed the answer rather than a registry to ask
    // (EO-422): whether `action` is the pack's or this role's own.
    packAction: packMeaningInForce(db, item, agent.role, action),
    // The same sections the full assembly renders, in the same places
    // (KAN-161) — an agent reads the same words whichever shape it was
    // dispatched with.
    sectionRenderers,
    item: itemView(db, item),
    // The event this item was made from, if one made it (EO-334, ARCHITECTURE.md, "What an agent is
    // given").
    // Rendered as a quoted, untrusted block and never as the item's own
    // text: the title and body a job's mapping produced are above, as
    // ordinary fields, and this is the body those were read out of.
    untrustedPayload: webhookPayloadForItem(db, item.id),
    // The same derivation the full assembly makes, so a step-owning
    // agent and a conversational one are told the same thing about what
    // the ticket has produced (EO-298).
    currentOutput,
    repositories: repositories.map((workspace) => ({ name: workspace.config.name, description: workspace.config.description })),
    // Which of them the agent is standing in. It has the worktree either
    // way; what it lacks is the name of the thing it is working on.
    repositoryName: repositories.find((workspace) => workspace.id === item.workspaceId)?.config.name ?? null,
    // The feature this hangs off, by key. The intent behind a story lives
    // in its parent's body, and an agent that wants it can read it with
    // one call rather than being handed it on every dispatch.
    parentKey: item.parentId === null ? null : (getItem(db, item.parentId)?.key ?? null),
    // Pinned comments, wherever they sit and whatever has been said
    // since — including the parent's, which is where the intake summary
    // lands for every story decomposed out of a feature (KAN-32).
    pinnedComments: [
      ...(item.parentId === null ? [] : listCommentsForItem(db, item.parentId).filter((comment) => comment.pinned)),
      ...comments.filter((comment) => comment.pinned),
    ].map((comment) => attribute(comment, agentsById)),
    dependencyKeys: listDependencies(db, item.id).flatMap((edge) => {
      const dependency = getItem(db, edge.dependsOnId);
      return dependency ? [dependency.key] : [];
    }),
    triggerComment: trigger,
    stepComments,
    humanComments,
    omitted: {
      total: omittedComments.length,
      byAuthorAndKind: [...tally.values()].sort((a, b) => b.count - a.count || a.authorName.localeCompare(b.authorName)),
      attachments: omittedComments.flatMap((comment) => comment.attachments),
    },
  }).fullText;
}

/**
 * What a dispatch sends the provider: the full context assembly, or the
 * follow-up prompt when it is carrying on a thread the agent already has
 * (EO-91).
 *
 * The default behind the supervisor's `buildContext` seam, and the one
 * place that chooses between the two. It is a choice and not a branch in
 * the supervisor because the two halves are both context assembly — the
 * supervisor's business is which provider call to make, and asking it to
 * also know that a follow-up renders a task line and a comment delta
 * would put the shape of a prompt in a file that otherwise never
 * describes one.
 *
 * `resumingRun` is the agent's own prior run on this item, as decided
 * by `findReusableThread` — null for a fresh thread, which is every
 * dispatch before EO-86 and every one an agent has not opted into.
 */
export async function buildTurnContext(
  db: Db,
  item: Item,
  agent: Agent,
  action: string,
  resumingRun: Run | null,
  sectionRenderers: readonly SectionRenderer[] = [],
): Promise<string> {
  if (resumingRun !== null) {
    return buildFollowUpContext(db, item, agent, action, resumingRun, {
      taskAppendix: await taskAppendixFor(db, item, action, agent.role),
      // The same renderers a fresh dispatch is given. Which of them a
      // resumed turn is shown again is the renderer's own answer, not
      // this call's (EO-298).
      sectionRenderers,
    }).fullText;
  }

  // Which shape a fresh dispatch gets is decided by one question, asked
  // of the agent's own config: can it read the whole thread with a tool?
  //
  // An agent that can is one whose work *is* the conversation — the
  // system agent in the assistant's chat — and
  // inlining the thread for it is not waste, it is the material. An agent
  // that cannot is working an item, and gets the seed plus the search.
  //
  // Deciding it here on the same predicate the tool list is built from is
  // what stops the two drifting: a prompt that says "search for the rest"
  // to an agent with no search, or 60k of thread for one that could have
  // asked. Not on the role (ARCHITECTURE.md, "An agent is a row": roles are configuration) and not
  // on the
  // action either — `entry_action` is a user-editable column, so a
  // denylist of action names is the same mistake one layer down.
  // The conversation actions are named here as well, and not as a
  // duplicate of the capability question. `fullThreadEnabled` fails
  // *closed* — an agent with no allowlist answers false — and an agent
  // somebody creates in the Agents screen starts with an empty config.
  // So a second system agent would be seeded on the one job it was
  // created for: no thread, where for these actions the thread is not
  // context about the work but the work itself.
  return fullThreadEnabled(agent) || CONVERSATION_ACTIONS.has(action)
    ? buildDispatchContext(db, item, action, sectionRenderers, undefined, agent.role)
    : buildSeedContext(db, item, agent, action, sectionRenderers);
}
