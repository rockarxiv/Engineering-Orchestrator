import { classifyDesignChange, resolvedGraphChanges, uuidv7, type Item, type ResolvedGraph, type PipelineStep, type TrialItemVerdict, type TrialPublishCard, type TrialStepOutcome, type Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import {
  boundGraphForItem,
  getComment,
  getItem,
  getModule,
  getPipeline,
  getRun,
  getStep,
  latestTrialGrant,
  listCommentsForItem,
  listRunsForItem,
  listTransitionsForItem,
  listTrialItemIds,
  listTrialOutcomes,
  listTrialStops,
  moduleForkedFrom,
  newestTrialRound,
  openTrialStop,
  readTrialPlan,
  trialGrantNeedsOf,
  type TrialGrantNeeds,
} from "../db/repos/index.js";
import { listPipelineStepViews } from "../ipc/domainQueries.js";
import { assistDraftForPublish, type AssistPublishableGraph } from "../roles/assist.js";
import { designOfCard, liveTrialOf, type LiveTrial } from "./designCard.js";
import { isStandInReply, standInAgentIds, withoutOnYourBehalfNote } from "./onBehalf.js";
import { moduleCodeDigest } from "./trialModules.js";

/**
 * The publish card after a draft's trials (EO-588, ARCHITECTURE.md,
 * "Trial pipelines"), read for the card and for the press.
 *
 * Every line on it is EO's reading of the trial, not the assistant's
 * report of it (invariant #5): the graph the trial ran, translated back
 * into the pipeline's own terms; what changed since the design the person
 * approved; how each step ran — and a mocked step is never called tested;
 * where each test item of the newest round ended against where it was
 * expected to; and what the assistant did in the person's place, which on
 * the live pipeline will be the person's to do.
 *
 * Its own module, apart from publishing (`assist:publishTrial`), because
 * the card is read long before anything is pressed and the press reads it
 * again inside its transaction.
 */

/** The card as drawn, and what publishing it would write. */
export type TrialPublishRead =
  | {
      ok: true;
      view: TrialPublishCard;
      live: LiveTrial;
      /** The graph to publish: the draft the trial runs, every module step running what the trial ran. */
      graph: Extract<AssistPublishableGraph, { ok: true }>;
    }
  | { ok: false; problem: string };

/**
 * Reads the publish card of the trial this conversation is testing.
 * `ok: false` where there is nothing to publish at all — no trial, or a
 * draft that no longer reads; a card that reads but cannot be pressed now
 * answers `ok: true` with its `problem` said.
 */
export function readTrialPublish(db: Db, conversation: Item): TrialPublishRead {
  const live = liveTrialOf(db, conversation.id);
  if (live === undefined) {
    return { ok: false, problem: "This conversation has no draft under test, so there is nothing to publish from a trial. A draft that was not tested is published from its own card." };
  }
  const { trial, design } = live;

  // The draft the trial runs: the newest one the loop applied to it, else
  // the design the person approved. Read the way Publish reads a draft
  // card, for what it says about the pipeline itself — which one, its name
  // and icon — and never for the graph.
  const sourceId = (design.applied ?? design.commentId) as Uuid;
  const read = assistDraftForPublish(db, conversation, sourceId);
  if (!read.ok) return { ok: false, problem: `The draft under test can no longer be read, so nothing can be published from it: ${read.reason}` };
  const graph: Extract<AssistPublishableGraph, { ok: true }> = { ...read, ...testedGraph(db, live, read.pipelineId) };

  // What changed since approval, measured on the graph itself: the one the
  // trial was materialised with then against the one it runs now. A
  // design approved before that graph was kept is compared draft to draft.
  const source = getComment(db, sourceId);
  const current = source === undefined ? null : designOfCard(db, conversation, source);
  const changes =
    design.approvedGraph !== null
      ? resolvedGraphChanges(design.approvedGraph, resolvedTrialGraph(db, trial.id))
      : current === null
        ? []
        : (({ design: asked, within }) => [...asked, ...within])(classifyDesignChange(design, { draft: current.draft, plan: design.plan }));

  const plan = readTrialPlan(db, trial.id) ?? { steps: [], expected: [] };
  const trialStep = (draftStepId: string): string => design.stepIds[draftStepId] ?? draftStepId;
  const itemIds = listTrialItemIds(db, trial.id);
  const items = itemIds.map((id) => getItem(db, id)).filter((item): item is Item => item !== undefined);
  const reached = reachedSteps(db, items, getPipeline(db, trial.id)?.entryStepId ?? null);
  const ran = ranSteps(db, items);

  const ordered = [...graph.steps].sort((a, b) => a.position - b.position);
  const stepOutcomes = ordered.map((step) => {
    const at = trialStep(step.id);
    const mode = plan.steps.find((entry) => entry.stepId === at)?.mode ?? "real";
    // Terminal steps run nothing: reaching one is all there is to it.
    const didRun = step.isTerminal ? reached.has(at) : ran.has(at);
    const outcome: TrialStepOutcome =
      mode === "mocked" ? "mocked" : !reached.has(at) ? "not_reached" : !didRun ? "not_run" : mode === "redirected" ? "redirected" : "tested";
    return { stepId: step.id, name: step.name, outcome, reason: design.plan.steps.find((entry) => entry.stepId === step.id)?.reason ?? null };
  });

  const round = newestTrialRound(db, trial.id);
  const outcomes = listTrialOutcomes(db, trial.id);
  const roundItems = round === undefined ? [] : items.filter((item) => design.rounds[item.id] === round.number);
  const judged = roundItems.map((item) => {
    const test = design.plan.items.find((candidate) => candidate.key === design.filed[item.id]);
    const expected = plan.expected.find((entry) => entry.itemId === item.id);
    const newest = outcomes.filter((outcome) => outcome.itemId === item.id).at(-1);
    const expectedStepId = expected?.stepId ?? (test === undefined ? null : trialStep(test.expected.stepId));
    const verdict: TrialItemVerdict =
      newest === undefined ? "unfinished" : newest.failed ? "failed" : newest.event === "person_step" && newest.stepId !== expectedStepId ? "unfinished" : "passed";
    return {
      itemKey: item.key,
      title: item.title,
      expectedStepName: expectedStepId === null ? "no step was named" : stepName(db, item, expectedStepId),
      criteria: expected?.criteria ?? test?.expected.criteria ?? null,
      endedStepName: newest === undefined || verdict === "unfinished" ? null : stepName(db, item, newest.stepId),
      result: newest === undefined || verdict === "unfinished" ? null : newest.result,
      verdict,
    };
  });

  const publishAnyway = round !== undefined && listTrialStops(db, trial.id).some((stop) => stop.choice === "Publish anyway" && (stop.answeredAfterRound ?? 0) >= round.number);
  const notPassed = judged.filter((item) => item.verdict !== "passed");

  const problem =
    design.pending !== null
      ? "A change to the design is waiting for you on a design card, so this draft is not what is under test. Approve that design and test it, or ask the assistant to go back to the one under test."
      : openTrialStop(db, trial.id) !== undefined
        ? "Testing has stopped and waits for your answer — keep going, publish anyway or discard. Answer it first."
        : round === undefined || judged.length === 0
          ? "No round of the test items has run, so nothing about this draft has been shown to work."
          : notPassed.length > 0 && !publishAnyway
            ? `Not every test item of round ${round.number} has ended where it was expected to (${notPassed.map((item) => `${item.itemKey} "${item.title}"`).join(", ")}). ` +
              "A trial is published once every one has, or when you choose Publish anyway at a guardrail stop."
            : null;

  const target = graph.pipelineId === null ? undefined : getPipeline(db, graph.pipelineId);
  return {
    ok: true,
    live,
    graph,
    view: {
      trialPipelineId: trial.id,
      targetPipelineId: graph.pipelineId,
      pipelineName: graph.newPipelineName ?? graph.rename ?? target?.name ?? "Pipeline",
      round: round?.number ?? null,
      steps: graph.steps,
      routes: graph.routes,
      entryStepId: graph.entryStepId,
      changes,
      modules: modulesOf(db, live, graph),
      stepOutcomes,
      items: judged,
      onBehalf: onBehalfOf(db, items),
      publishAnyway,
      problem,
    },
  };
}

/** The trial steps any of these items arrived on, or was filed on. */
function reachedSteps(db: Db, items: readonly Item[], entryStepId: string | null): Set<string> {
  const reached = new Set<string>();
  if (items.length > 0 && entryStepId !== null) reached.add(entryStepId);
  for (const item of items) for (const transition of listTransitionsForItem(db, item.id)) reached.add(transition.toStepId);
  return reached;
}

/**
 * The trial steps that ran on any of these items, by evidence that work
 * was done there and not that an item arrived: a run on the step that
 * succeeded, a move off it on a run's result, or a press of a person's
 * step (a move off it with no run, which only a decision makes — every
 * other step moves on a run). An item that parked before a module's code
 * started — a missing credential, a withdrawn grant — leaves a run that
 * did not succeed and no move, so its step has not run.
 */
function ranSteps(db: Db, items: readonly Item[]): Set<string> {
  const ran = new Set<string>();
  for (const item of items) {
    for (const run of listRunsForItem(db, item.id)) if (run.stepId !== null && run.status === "succeeded") ran.add(run.stepId);
    for (const transition of listTransitionsForItem(db, item.id)) {
      if (transition.fromStepId === null) continue;
      const from = stepOf(db, item, transition.fromStepId);
      if (transition.runId !== null || (from?.type === "user" && /^decided "/.test(transition.reason ?? ""))) ran.add(transition.fromStepId);
    }
  }
  return ran;
}

/**
 * The graph the trial ran, in the pipeline's own terms (EO-588): the trial
 * pipeline's steps and routes as they stand — every setting each step was
 * materialised and tested with, and the module each module step ran —
 * under the draft's step ids, which for a step the pipeline already has
 * are its own. Not the draft read again: that settles what a draft leaves
 * out against the target's rows as they are now, and a target edited
 * since the trial was made would be published with values nobody tested.
 */
function testedGraph(db: Db, live: LiveTrial, pipelineId: string | null): Pick<Extract<AssistPublishableGraph, { ok: true }>, "steps" | "routes" | "entryStepId" | "entryRules"> {
  const draftIdOf = new Map(Object.entries(live.design.stepIds).map(([draftId, trialId]) => [trialId, draftId]));
  const back = (id: string): string => draftIdOf.get(id) ?? id;
  const into = pipelineId ?? "";
  const trialGraph = resolvedTrialGraph(db, live.trial.id);
  return {
    steps: trialGraph.steps.map((step) => ({ ...step, id: back(step.id), pipelineId: into })),
    routes: trialGraph.routes.map((route) => ({ ...route, id: uuidv7(), pipelineId: into, fromStepId: back(route.fromStepId), target: back(route.target) })),
    entryStepId: back(trialGraph.entryStepId ?? ""),
    // What the approved design says of them (EO-610), and not the trial's
    // copy: a draft that said nothing keeps what the target has when this
    // is published, rules set since the trial was made among them. A
    // revision cannot have changed them without a new design.
    entryRules: live.design.draft.entryRules,
  };
}

/** A trial pipeline's graph as it stands, in its own step ids: what its next item runs. */
export function resolvedTrialGraph(db: Db, trialPipelineId: string): ResolvedGraph {
  const { steps, routes, entryStepId } = listPipelineStepViews(db, { pipelineId: trialPipelineId });
  return { steps, routes, entryStepId };
}

/** A step's name as the item's own version has it, else as it stands, else its id. */
function stepOf(db: Db, item: Item, stepId: string): PipelineStep | undefined {
  return boundGraphForItem(db, item)?.steps.find((step) => step.id === stepId) ?? getStep(db, stepId);
}

function stepName(db: Db, item: Item, stepId: string): string {
  return stepOf(db, item, stepId)?.name ?? stepId;
}

/**
 * Every module the published graph runs, with whether its code or its
 * needs moved since the design was approved: code against the digest the
 * design kept, needs against the trial grant — which records what the
 * person granted. Needs are what the person is granting, so a card marks
 * them apart from code.
 */
function modulesOf(db: Db, live: LiveTrial, graph: Extract<AssistPublishableGraph, { ok: true }>): TrialPublishCard["modules"] {
  const ids = [...new Set(graph.steps.flatMap((step) => (step.type === "module" && step.entryAction !== null ? [step.entryAction] : [])))];
  return ids.flatMap((id) => {
    const module = getModule(db, id);
    if (module === undefined) return [];
    const kept = live.design.moduleCode[id];
    const grant = latestTrialGrant(db, id, live.trial.id);
    const forkedFrom = moduleForkedFrom(db, id);
    const original = forkedFrom !== null && live.design.moduleIds[forkedFrom] === id ? getModule(db, forkedFrom) : undefined;
    return [
      {
        id: module.id,
        slug: module.slug,
        name: module.name,
        codeChanged: kept !== undefined && kept !== moduleCodeDigest(db, id),
        needsChanged: grant !== undefined && !sameNeeds(grant.needs, trialGrantNeedsOf(module.manifest)),
        replaces: original === undefined ? null : { id: original.id, name: original.name },
      },
    ];
  });
}

function sameNeeds(a: TrialGrantNeeds, b: TrialGrantNeeds): boolean {
  const sorted = (needs: TrialGrantNeeds) => JSON.stringify([[...needs.bin].sort(), [...needs.env].sort(), needs.network, needs.sideEffects, needs.create]);
  return sorted(a) === sorted(b);
}

/** A press the system agent made on a person's step in their place (EO-585), as the move records it. */
const PRESSED_ON_BEHALF = /^decided "(.*)" on the person's behalf$/;

/**
 * What the assistant did in the person's place on these trial items, in
 * the order it happened: every result it pressed on a person's step — read
 * from the move, which records the press as the agent's — and every
 * question an agent asked that it answered, read by `isStandInReply`, the
 * one predicate for a reply in the person's place.
 */
function onBehalfOf(db: Db, items: readonly Item[]): TrialPublishCard["onBehalf"] {
  const acts: (TrialPublishCard["onBehalf"][number] & { at: number })[] = [];
  for (const item of items) {
    const standIns = standInAgentIds(db, item.id);
    for (const transition of listTransitionsForItem(db, item.id)) {
      const pressed = PRESSED_ON_BEHALF.exec(transition.reason ?? "");
      if (pressed === null || transition.fromStepId === null || !standIns.has(transition.actor)) continue;
      const step = stepOf(db, item, transition.fromStepId);
      acts.push({
        kind: "pressed",
        itemKey: item.key,
        stepName: step?.name ?? transition.fromStepId,
        asked: null,
        answer: pressed[1]!,
        choices: (step?.results ?? []).map((result) => result.label),
        at: transition.ts,
      });
    }
    for (const comment of listCommentsForItem(db, item.id)) {
      if (comment.parentId === null || !isStandInReply(comment, standIns)) continue;
      const question = getComment(db, comment.parentId);
      if (question === undefined) continue;
      const run = question.runId === null ? undefined : getRun(db, question.runId);
      acts.push({
        kind: "answered",
        itemKey: item.key,
        stepName: run?.stepId == null ? "a step" : stepName(db, item, run.stepId),
        asked: question.body,
        answer: withoutOnYourBehalfNote(comment.body),
        choices: [],
        at: comment.createdAt,
      });
    }
  }
  return acts.sort((a, b) => a.at - b.at).map(({ at: _at, ...act }) => act);
}
