import { asksToRerun, INTERPRET_ACTION, projectHasOwnAgent, staffsItem, type PipelineStep, type Run, type Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import {
  getAgent,
  listAgents,
  stepForItem,
  getItem,
  listActiveRuns,
  listAwaitingInputItemIds,
  listOpenAgentMentions,
  listRunsForItem,
  offBoardStepIds,
  type OpenAgentMention,
} from "../db/repos/index.js";
import { unansweredQuestions } from "../roles/clarificationQuestions.js";
import { ASSIST_ACTION, ASSIST_STEP, SCENARIO_ACTION, SCENARIO_STEP } from "../roles/conversationSteps.js";
import { pendingInterpretation } from "../roles/interpretation.js";

/** The action for a manually dispatched run — deliberately outside any workflow state's entry_action (ARCHITECTURE.md, "Agent to agent"). */
export const RESPOND_ACTION = "respond";

/**
 * Which action an off-board step's conversation runs.
 *
 * A map rather than "off-board means one conversation action": the rooms
 * are answered with different output schemas, and the step is what
 * distinguishes them — dispatching a scenario turn as `assist` would hand
 * it the assistant's schema and nothing could be done with the answer.
 *
 * Keyed on the step rather than on who was mentioned, deliberately: the
 * step is already how this function decides everything else, and an
 * agent's role is a thing a person can edit in Settings.
 *
 * Discussions' `discuss` and the Architecture panel's `configure` were
 * here until EO-526. Their rooms are gone and their conversations are
 * deleted at startup, so an off-board step that is neither of the two
 * below answers a mention as `respond`.
 */
const CONVERSATION_ACTIONS: Record<string, string> = {
  // The assistant's room (EO-188). One line, and it is the whole of
  // that room's dispatch wiring: an assist conversation is an item on an
  // off-board step whose turns are driven by an @-mention, so everything
  // below this map is already the machinery it needs.
  [ASSIST_STEP]: ASSIST_ACTION,
  // A module's scenario chat (EO-356), wired the same one line.
  [SCENARIO_STEP]: SCENARIO_ACTION,
};

/** The action a conversation's turns run, by its step; undefined off a conversation. */
export function conversationActionFor(stepId: string | null): string | undefined {
  return stepId === null ? undefined : CONVERSATION_ACTIONS[stepId];
}

export interface PendingResponse {
  itemId: Uuid;
  agentId: Uuid;
  /** The comment that asked for the agent's attention; it is already in the thread the agent will read. */
  commentId: Uuid;
  /**
   * What the agent is being asked to do.
   *
   * `respond` for an ordinary @-mention, and the room's own action when
   * the item is a conversation. The distinction matters because it
   * selects the output schema: a conversation turn dispatched as
   * `respond` would come back in the wrong shape and nothing could be
   * done with it.
   */
  action: string;
  /**
   * The step this mention asked to be run again (EO-135).
   *
   * Set only when the comment reads as a request to rerun *and* the
   * agent it names is the one that step is owned by — a person handing
   * the step back to whoever was working it. `action` is then the step's
   * own entry action rather than `respond`, and the run routes on its
   * result like any other run of that step.
   *
   * Absent is the ordinary case: an @-mention is a question, and a
   * question is answered in the thread without the pipeline moving.
   */
  rerunStepId?: string;
}

/**
 * Everything a rerun request stands on, apart from its words (EO-135):
 * this item, on this step, handed to this agent.
 *
 * - the item is on the step in question, and that step belongs to the
 *   item's own pipeline — `tick()`'s rule, and it has to hold here or
 *   a rerun could run another pipeline's action against the wrong role;
 * - the step is one an agent is dispatched at — not a `user` step, not
 *   a terminal one, and not a `builtin` or `module`, which run EO's own
 *   code and have no agent to hand anything back to;
 * - the agent named is the one that step is owned by. `@implementer
 *   rerun` while the item is at Review is not a request this can
 *   honour — the implementer does not own Review;
 * - and it is one the scheduler would staff this item with (EO-474):
 *   its scope reaches the item's project, and it is not a global agent
 *   on an item whose project has an agent of its own in the role. The
 *   same rule `staffingAgents` applies, asked without the named agent's
 *   own switch — that half is availability, below.
 *
 * Exported because it is asked twice, and the two answers must agree.
 * The mention is classified against it, and then several awaits later
 * the supervisor asks it again before admitting the run: a step is data
 * a person can edit (invariant #7), so the pipeline the request was
 * classified against is not necessarily the pipeline it would run in.
 * A second copy of these rules living in the supervisor is exactly the
 * drift this whole item has been about.
 *
 * What it deliberately does not ask is whether the agent is *available*
 * — switched on, or, since EO-186, not archived. Those live one layer
 * up, in `stepAuthorisationBlocker`, and they belong there because this
 * function only decides what the request *is*. A rerun asked of a
 * retired agent is still a rerun request, and answering it as one is
 * what lets EO say "EO did not run Review again as you asked: Reviewer
 * has been archived" instead of the vaguer thing it would say about a
 * mention it had reclassified as an ordinary question.
 */
export function rerunContract(db: Db, itemId: Uuid, agentId: Uuid, stepId: string): { step: PipelineStep; action: string } | null {
  const item = getItem(db, itemId);
  if (!item || item.stepId !== stepId) return null;

  // By the item's own version (EO-327, ARCHITECTURE.md, "Publish, lock and versions"). The guard
  // above has
  // established that this is the step the item is standing on, and what
  // is read from it here is executable — the role that may run, the
  // action it runs, and whether the step is terminal at all — so a save
  // that retyped or retired the step under an item mid-flight must not
  // decide what a rerun of that item does.
  const step = stepForItem(db, item);
  if (!step || step.isTerminal || step.type !== "agent") return null;
  if (step.entryAction === null || step.ownerRole === null) return null;
  // An item only ever resolves against a step of its own pipeline —
  // `tick()`'s rule, and it has to hold here too, or a rerun could run
  // another pipeline's action against the wrong role.
  if (step.pipelineId !== item.pipelineId) return null;

  const agent = getAgent(db, agentId);
  if (!agent || agent.role !== step.ownerRole) return null;
  // Whom the scheduler would staff this item with (EO-474). Without it a
  // mention would be a way round the scope: another project's agent
  // asked by name, or the global agent on a project that has stepped out
  // from under it, would run where tick() never sends either.
  if (!staffsItem(agent, item)) return null;
  if (agent.projectId === null && projectHasOwnAgent(listAgents(db), step.ownerRole, item)) return null;
  return { step, action: step.entryAction };
}

function rerunStepFor(db: Db, itemId: Uuid, agentId: Uuid, body: string): { step: PipelineStep; action: string } | null {
  if (!asksToRerun(body)) return null;
  const stepId = getItem(db, itemId)?.stepId;
  return stepId == null ? null : rerunContract(db, itemId, agentId, stepId);
}

/**
 * The scheduler's second entry point (ARCHITECTURE.md, "Agent to agent").
 *
 * The normal one is `workflow_states.owner_role`: an item sitting in a
 * state dispatches to whoever owns it. But an agent `@`-mentioned in a
 * comment has to run regardless of what state the item is in — that's
 * a human (or another agent) asking a question, and the item may well
 * be somewhere nobody owns, like the approval gate or ready_to_merge.
 *
 * Deliberately not folded into `tick()`: that function is pure and
 * decides work from item state, whereas this decides work from the
 * comment thread. Keeping them separate is what stops the pure
 * scheduler from needing to know about mentions at all.
 *
 * An open mention naming an agent that has since been archived is still
 * offered here, on purpose (EO-186). Filtering it out would be the
 * silent version of the right answer: the mention would stay open, this
 * would skip it on every tick from now until the end of time, and the
 * thread would never say why. The supervisor turns it down instead —
 * with a sentence, and by closing the mention — which is the shape
 * invariant #8 asks for and the one `agent_disabled` already has.
 */
export function findPendingResponses(db: Db, itemIds: Uuid[]): PendingResponse[] {
  // One read for the whole board (EO-554): the open agent mentions,
  // found through `idx_mentions_open`, rather than every comment of
  // every live item and a mention query per comment — which was the
  // scheduler reading the whole of every thread on every tick to find
  // the handful of rows still waiting. Grouped by item here so the
  // walk below keeps the order it always had: the caller's items in
  // the caller's order, each thread top to bottom.
  const openByItem = new Map<string, OpenAgentMention[]>();
  for (const mention of listOpenAgentMentions(db)) {
    const onItem = openByItem.get(mention.itemId);
    if (onItem) onItem.push(mention);
    else openByItem.set(mention.itemId, [mention]);
  }
  if (openByItem.size === 0) return [];

  const activeByItem = new Set(listActiveRuns(db).map((run) => run.itemId));
  const offBoard = offBoardStepIds(db);
  const pending: PendingResponse[] = [];

  for (const itemId of itemIds) {
    const mentions = openByItem.get(itemId);
    if (!mentions) continue;

    // A conversation is an item in an off-project state, and sending a
    // chat message posts a human comment mentioning the agent — so no
    // room needs dispatch machinery of its own beyond naming the action.
    //
    // An off-board step this map has never heard of falls back to
    // `respond` rather than to a conversation action: an unrecognised
    // step is not evidence about which schema an answer should take, and
    // `respond` is the one that assumes least.
    const stepId = mentions[0]?.stepId ?? "";
    const action = (offBoard.has(stepId) ? CONVERSATION_ACTIONS[stepId] : undefined) ?? RESPOND_ACTION;

    for (const mention of mentions) {
      // An agent must not be dispatched to answer its own comment —
      // that is the A→B→A loop with only one participant.
      if (mention.authorType === "agent" && mention.authorId === mention.agentId) continue;

      const rerunStep = rerunStepFor(db, itemId, mention.agentId, mention.body);
      if (rerunStep) {
        pending.push({
          itemId,
          agentId: mention.agentId,
          commentId: mention.commentId,
          action: rerunStep.action,
          rerunStepId: rerunStep.step.id,
        });
        continue;
      }

      // Only now does an active run matter. A question waits for the
      // run to end and is still open on the next tick, which is what
      // this skip has always meant. A rerun request does not wait: it
      // is answered above and refused by the caller if the item
      // turns out to be busy, because somebody asking for a rerun
      // wants to know it is not happening now, not to have one start
      // half an hour later (EO-135).
      if (activeByItem.has(itemId)) continue;

      pending.push({ itemId, agentId: mention.agentId, commentId: mention.commentId, action });
    }
  }

  return dedupeByItemAndAgent(pending);
}

/**
 * One run per (item, agent) per tick, even if several comments mention
 * the same agent — its prompt carries the thread either way (ARCHITECTURE.md, "What an agent is
 * given"), so a second
 * run would re-read the same context and answer twice.
 */
function dedupeByItemAndAgent(pending: PendingResponse[]): PendingResponse[] {
  const seen = new Set<string>();
  // Walk newest-first: an older open mention may be the exhausted
  // initiation the human is replacing with this new request.
  return [...pending].reverse().filter((entry) => {
    const key = `${entry.itemId}:${entry.agentId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).reverse();
}

/** A reply to a parked non-agent step that the system agent is to read (EO-184). */
export interface PendingInterpretationDispatch {
  itemId: Uuid;
  agentId: Uuid;
  /** The person's comment. The run's initiation id, so one reply can only ever start one interpretation. */
  commentId: Uuid;
  /** Always `interpret`. Carried like `PendingResponse.action` so the caller dispatches from the row rather than from a literal. */
  action: string;
}

/**
 * The newest run parked on this item.
 *
 * The same order `resumeItemHeld`, `deferredReplyItemIds` and
 * `listAwaitingInputItemIds` use, and it has to be the same: those
 * decide *that* an item has a reply waiting, this decides *which run*
 * the reply belongs to, and `startedAt` alone does not settle it.
 * `listRunsForItem` has no ORDER BY, so a tie falls back to whatever
 * SQLite returned and two runs sharing a millisecond is exactly what ids
 * are minted monotonically to resolve.
 */
export function newestParkedRun(db: Db, itemId: Uuid): Run | undefined {
  return listRunsForItem(db, itemId)
    .filter((run) => run.status === "awaiting_input")
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0) || b.id.localeCompare(a.id))[0];
}

/**
 * The scheduler's third entry point (EO-184): a reply nobody can match,
 * waiting to be read.
 *
 * A sibling of `findPendingResponses` above, and deliberately not folded
 * into it — that one decides work from open mentions, this from a parked
 * run and the thread under it. What they share is the reason they are
 * both here rather than in `tick()`: the pure scheduler decides work
 * from item state, and neither of these is item state.
 *
 * Why it is a scheduled dispatch at all, rather than being run where the
 * decision is taken: `resumeItemHeld` holds the item lock, and a
 * model call inside it would serialise the whole board behind one
 * person's sentence. So the reply parks the item exactly as it found
 * it, and the interpretation comes back a tick later and claims the
 * item in its own right, like every other run.
 */
export function findPendingInterpretations(db: Db, itemIds: Uuid[], enabled: boolean): PendingInterpretationDispatch[] {
  if (!enabled) return [];
  const activeByItem = new Set(listActiveRuns(db).map((run) => run.itemId));
  // Only a parked item can have a reply waiting to be read, and this
  // is one query rather than one per item on the board — the same
  // reason the scheduler asks it once per tick.
  const parkedItems = listAwaitingInputItemIds(db);
  const pending: PendingInterpretationDispatch[] = [];

  for (const itemId of itemIds) {
    if (!parkedItems.has(itemId)) continue;
    // Something is already working this item. The reply is not going
    // anywhere — `pendingInterpretation` answers the same on the next
    // tick — and the dispatch below would only lose the claim anyway.
    if (activeByItem.has(itemId)) continue;
    // An agent that asked a question of its own is owed its answer
    // first (KAN-29), which is the same gate `postHumanComment` and
    // `deferredReplyItemIds` apply before resuming at all.
    if (unansweredQuestions(db, itemId).length > 0) continue;

    const item = getItem(db, itemId);
    const parked = newestParkedRun(db, itemId);
    if (!item || !parked) continue;

    const found = pendingInterpretation(db, item, parked, enabled);
    if (found) pending.push({ itemId, agentId: found.agentId, commentId: found.commentId, action: INTERPRET_ACTION });
  }

  return pending;
}
