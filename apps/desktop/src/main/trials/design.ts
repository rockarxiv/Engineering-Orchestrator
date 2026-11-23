import {
  AssistOutputSchema,
  classifyDesignChange,
  EMPTY_TRIAL_PLAN,
  proposedActionDraft,
  remapStepReferences,
  trialPlanProblems,
  type ActionDefinitionDraft,
  type AssistDraft,
  type AssistTrialPlan,
  type IpcPayload,
  type IpcResponse,
  type Item,
  type TrialDesign,
  type TrialPlan,
  type Uuid,
  uuidv7,
} from "@eo/core";
import { trialTeams } from "../db/repos/teamsRepo.js";
import type { AttachmentStorage } from "../attachments/storage.js";
import type { Db } from "../db/client.js";
import { withEventsHeld } from "../db/heldEvents.js";
import {
  getComment,
  getItem,
  getModule,
  getPipeline,
  latestTrialGrant,
  listItemTypes,
  postComment,
  readTrialActions,
  readTrialDesign,
  readTrialPlan,
  writeTrialActions,
  writeTrialDesign,
  type ItemTypeName,
  type TrialRound,
  newestModuleVersion,
} from "../db/repos/index.js";
import { savePipeline } from "../ipc/configCommands.js";
import type { EngineHandle } from "../ipc/domainCommands.js";
import { assistDraftForPublish, assistTurnDraftAsPosted } from "../roles/assist.js";
import { ASSIST_STEP } from "../roles/conversationSteps.js";
import { copiesOf, designOfCard, liveTrialOf, type LiveTrial } from "./designCard.js";
import { discardTrial } from "./discard.js";
import { startTrialRound, trialLoopDeps, wakeOnFiling } from "./loop.js";
import { saveTrialPlan } from "./stepModes.js";
import { moduleCodeDigest } from "./trialModules.js";
import { resolvedTrialGraph } from "./publishCard.js";
import { createTrialFromDraft, createTrialFromRead, fileTrialItem, type CreateTrialResult, type TrialDraft, type TrialPlace, type TrialStart } from "./trials.js";

/**
 * Approving a design and running its rounds (EO-587, ARCHITECTURE.md,
 * "Trial pipelines").
 *
 * The person plans a test with the assistant; the assistant hands the
 * plan back beside its draft, and the reply is a design card. Approving
 * it is the one act that starts testing: the trial pipeline is made, the
 * draft's modules are granted trial-only permission within the needs they
 * declare, the test items are filed as trial items, and the first round
 * is started. Nothing is published.
 *
 * Then the loop. Each later draft the assistant returns in that
 * conversation is classified against the approved design by EO
 * (`classifyDesignChange`), not by the assistant: one that changes what
 * the person approved — a step, a route, a declared result, a test item
 * or where it must end, a step's mode, a module's needs — stays a design
 * card, and no round starts until the person approves it. Anything else
 * — a step's instructions, its settings, a module's code within its
 * grant — is applied to the trial without a card, and starts the next
 * round.
 */

/** What approving a design needs beyond the database: the engine to tell, and what discarding the trial it replaces takes. */
export interface DesignDeps {
  engine?: Pick<EngineHandle, "notifyStateChange"> | undefined;
  attachmentStorage?: AttachmentStorage;
  worktreeRoot?: string;
}

type ApproveDesignAnswer = IpcResponse<"assist:approveDesign">;

/** A refusal raised inside the transaction, so everything made goes back with it. */
class DesignRefused extends Error {}

/**
 * Approve design (EO-587): the person's word that this is the shape they
 * want tested, and nothing more — the pipeline it would replace, and the
 * module catalogue's approvals, are untouched.
 *
 * Refused before anything is written for a card that is not a design
 * card, one already approved, or one whose plan no longer fits its draft;
 * and, by `createTrialFromDraft`, for a card that is superseded or whose
 * draft no longer fits. Then one transaction: the trial, its grants, its
 * design, the first round, its test items and its plan — any refusal on
 * the way takes all of it back.
 *
 * A design approved while an earlier one of this conversation is under
 * test replaces it: the new trial is given the draft copies the loop has
 * been fixing, and once it is made the earlier trial is discarded through
 * the item-delete path.
 */
export async function approveTrialDesign(db: Db, deps: DesignDeps, input: IpcPayload<"assist:approveDesign">, place: TrialPlace = {}): Promise<ApproveDesignAnswer> {
  const refuse = (problem: string): ApproveDesignAnswer => ({ approved: false, trialPipelineId: null, round: null, items: [], problem });
  const conversation = getItem(db, input.conversationId as Uuid);
  if (conversation === undefined || conversation.stepId !== ASSIST_STEP) return refuse("That conversation does not exist, so there is no design to approve.");
  const comment = getComment(db, input.messageId as Uuid);
  if (comment === undefined || comment.itemId !== conversation.id) return refuse("That message is not a design card.");
  const shown = designOfCard(db, conversation, comment);
  if (shown === null) return refuse("That card has no trial plan, so there is no design to approve. A draft that is not tested is published with Approve and publish.");
  const unfit = trialPlanProblems(shown.draft, shown.plan);
  if (unfit.length > 0) return refuse(`The trial plan does not fit this draft, so nothing was made: ${unfit.join(" ")}`);
  const earlier = liveTrialOf(db, conversation.id);
  if (earlier?.design.commentId === comment.id) return refuse("This design is already approved, and its trial is under way.");

  let made: MadeDesign;
  try {
    made = db.transaction(() =>
      makeDesignTrial(db, deps, { commentId: comment.id, draft: shown.draft, plan: shown.plan }, earlier, place, (start) =>
        createTrialFromDraft(db, deps.engine, { conversationId: conversation.id, messageId: comment.id }, start),
      ),
    );
  } catch (error) {
    if (!(error instanceof DesignRefused)) throw error;
    return refuse(error.message);
  }

  const problems: string[] = [];
  if (earlier !== undefined) {
    if (deps.attachmentStorage === undefined) {
      problems.push("The design it replaces is still under test, and could not be discarded here. Discard it from the conversation.");
    } else {
      const discarded = await discardTrial(db, deps.engine as EngineHandle | undefined, deps.attachmentStorage, { trialPipelineId: earlier.trial.id }, deps.worktreeRoot);
      if (!discarded.ok) problems.push(`The design it replaces could not be discarded: ${discarded.problem}`);
    }
  }

  const name = getPipeline(db, made.trialPipelineId)?.name ?? "the draft";
  postComment(db, {
    itemId: conversation.id,
    author: { type: "engine" },
    kind: "note",
    body: [
      `**Design approved** — testing ${name} with real runs${earlier === undefined ? "" : ", in place of the design approved before it"}. Nothing is published.`,
      "",
      `Round ${made.round.number} has started with ${made.items.length === 1 ? "1 test item" : `${made.items.length} test items`}:`,
      ...made.items.map((item) => `- ${item.itemKey} "${item.title}"`),
      "",
      "The draft's modules may run on these test items only, within the needs each declares now.",
      ...problems.map((problem) => `\n${problem}`),
    ].join("\n"),
    parseBodyMentions: false,
  });
  deps.engine?.notifyStateChange();
  return {
    approved: true,
    trialPipelineId: made.trialPipelineId,
    round: made.round.number,
    items: made.items.map(({ id, key, title }) => ({ id, key, title })),
    problem: problems.length === 0 ? null : problems.join(" "),
  };
}


/** What approving a design made: its trial, and the first round with its test items. */
type MadeDesign = { trialPipelineId: string; round: TrialRound; items: { id: string; key: string; title: string; itemKey: string }[] };

/** A design as a card offers it for approval: the card, its draft and its trial plan. */
export interface DesignToMake {
  commentId: string;
  draft: AssistDraft;
  plan: AssistTrialPlan;
}

/**
 * Everything Approve design writes, in the caller's transaction (EO-587):
 * the trial, made by `create` — which reaches `createTrialFromRead`
 * whoever calls — its design, and its first round, with its test items
 * and plan. Throws `DesignRefused` with the sentence the person is shown,
 * and the caller's transaction takes back whatever was written.
 *
 * One function for the press and for the checks that a press would
 * succeed (EO-833, `designTrialProblem`), so the two cannot drift apart.
 */
function makeDesignTrial(
  db: Db,
  deps: DesignDeps,
  card: DesignToMake,
  earlier: LiveTrial | undefined,
  place: TrialPlace,
  create: (start: TrialStart) => CreateTrialResult,
): MadeDesign {
  const created = create({ ...place, grantedBy: "human", carriedCopies: earlier === undefined ? {} : copiesOf(earlier.design) });
  if (!created.ok) throw new DesignRefused(created.problem);
  const design: TrialDesign = {
    commentId: card.commentId,
    draft: card.draft,
    plan: card.plan,
    stepIds: created.stepIds,
    moduleIds: created.moduleIds,
    filed: {},
    rounds: {},
    applied: null,
    // What each module's code was as the person approved the design
    // (EO-588): the publish card marks every one that has moved since.
    moduleCode: Object.fromEntries(Object.values(created.moduleIds).map((moduleId) => [moduleId, moduleCodeDigest(db, moduleId)])),
    // And the graph as it was materialised (EO-588): what the publish
    // card says changed is measured against what was approved here.
    approvedGraph: resolvedTrialGraph(db, created.trial.id),
    pending: null,
  };
  writeTrialDesign(db, created.trial.id, design);
  const round = runDesignRound(db, deps, created.trial.id, "human", place);
  // A fresh trial has run no round and spent nothing, so a guardrail
  // refusing its first is a setting that allows none: said on the card.
  if (!round.ok) throw new DesignRefused(round.problem);
  return { trialPipelineId: created.trial.id, round: round.round, items: round.items };
}

/** Thrown to take back a transaction that only asked what it would do. */
class Undone extends Error {}

/**
 * Why approving this design would be refused, or null where Approve
 * design would make its trial and start its first round (EO-833).
 *
 * Asked by doing it: `makeDesignTrial`, the function Approve design runs,
 * with the trial made from `read` by `createTrialFromRead`, inside a
 * transaction that is always rolled back — and with no engine, and every
 * write announcement held (`withEventsHeld`), so nobody is told of a row
 * that never comes to exist. `prepare` runs first in the same
 * transaction, for a caller that has to write what posting a card would
 * (the reply's modules) before the draft can be read; it answers with
 * the draft, or null where there is nothing to check.
 *
 * The answer is a reading of now: the state can change before the press,
 * which is why Approve design refuses again on its own.
 */
export function designTrialProblem(
  db: Db,
  conversation: Item,
  card: DesignToMake,
  prepare: () => TrialDraft | null,
  place: TrialPlace = {},
): string | null {
  const earlier = liveTrialOf(db, conversation.id);
  let problem: string | null = null;
  try {
    // Nobody is told of a row that is about to be taken back: not the
    // engine's comment subscription, the trial loop or the record's queue.
    withEventsHeld(db, () => db.transaction(() => {
      const read = prepare();
      if (read !== null) {
        try {
          makeDesignTrial(db, {}, card, earlier, place, (start) => createTrialFromRead(db, undefined, conversation, read, start));
        } catch (error) {
          if (!(error instanceof DesignRefused)) throw error;
          problem = error.message;
        }
      }
      throw new Undone();
    }));
  } catch (error) {
    if (!(error instanceof Undone)) throw error;
  }
  return problem;
}

/**
 * Why the trial an `assist` reply plans could not be made, or null where
 * it could or the reply plans none (EO-833).
 *
 * Asked by the supervisor while the turn is still open, beside the
 * EO-440/441 checks, so the agent is re-prompted with the reason and can
 * fix its draft in the same turn rather than posting a design card whose
 * Approve design is refused once a person presses it. The answer is
 * `designTrialProblem`'s — Approve design's own work, done and taken
 * back — on the draft as its card would be read once posted: posting's
 * own drawing of the card and saving of the reply's modules come first,
 * in the transaction that is rolled back. A draft posting would refuse
 * is not this check's: that refusal is posted in its place, as it always
 * was.
 */
export function proposedTrialProblem(db: Db, conversation: Item, runId: Uuid, reply: unknown): string | null {
  const parsed = AssistOutputSchema.safeParse(reply);
  if (!parsed.success) return null;
  const output = parsed.data;
  if (output.trial === null || output.draft === undefined) return null;
  // No card exists yet, so the design is made under an id no comment has.
  const card = { commentId: uuidv7(), draft: output.draft, plan: output.trial };
  const problem = designTrialProblem(db, conversation, card, () => {
    const graph = assistTurnDraftAsPosted(db, conversation, runId, output);
    return graph === null || !graph.ok ? null : graph;
  });
  if (problem === null) return null;
  return [
    `This draft's trial could not be made, so the person pressing Approve design on its card would be told: ${problem}`,
    "",
    "Change the draft or its trial plan so that its trial can be made, and return it again — or, where nothing in the draft can fix it, say so to the person without a trial plan. Nothing was posted from this reply.",
  ].join("\n");
}

type RoundAnswer = { ok: true; round: TrialRound; items: { id: string; key: string; title: string; itemKey: string }[] } | { ok: false; problem: string };

/** A test item that could not be filed or planned, raised inside the round's transaction. */
class RoundRefused extends Error {}

/**
 * Starts a round of a design's test items (EO-587): through
 * `startTrialRound`, so the guardrails hold, then every test item of the
 * approved design filed afresh as a trial item, and the trial's plan
 * extended to say, for each, where it must end and what each mocked step
 * reports for it — in the trial's own step and item ids.
 *
 * One transaction. A guardrail refusing the round is answered, its stop
 * comment kept; a test item that cannot be filed, or a plan the trial
 * refuses, takes the round and every item back with it. Each item wakes
 * the assistant for its first step only once the plan says what it is
 * expected to come to.
 */
function runDesignRound(db: Db, deps: DesignDeps, trialPipelineId: string, startedBy: string, place: TrialPlace): RoundAnswer {
  const design = readTrialDesign(db, trialPipelineId);
  if (design === undefined) return { ok: false, problem: "That trial has no approved design to test." };
  // The round door holds the wait, not only the caller: a change to the
  // design is the person's, and only their approving a design ends it.
  if (design.pending !== null) return { ok: false, problem: "No round was started: a change to the design is waiting for the person to approve it." };
  const projectId = getPipeline(db, trialPipelineId)?.projectId ?? null;
  try {
    return db.transaction((): RoundAnswer => {
      const started = startTrialRound(db, { trialPipelineId, startedBy });
      if (!started.ok) return { ok: false, problem: started.problem };

      const filed: { key: string; item: Item }[] = [];
      for (const test of design.plan.items) {
        const type = test.type ?? defaultTestItemType(db, projectId);
        if (type === null) throw new RoundRefused(`the test item "${test.title}" names no type, and the project has none to file it as.`);
        const created = fileTrialItem(db, deps.engine, { trialPipelineId, type, title: test.title, body: test.body, workspaceId: test.workspaceId }, place, { wake: false });
        if (!created.ok) throw new RoundRefused(`the test item "${test.title}" could not be filed: ${created.problem}`);
        filed.push({ key: test.key, item: created.item });
      }

      const saved = saveTrialPlan(db, trialPipelineId, extendedPlan(readTrialPlan(db, trialPipelineId) ?? EMPTY_TRIAL_PLAN, design, filed));
      if (!saved.ok) throw new RoundRefused(saved.problem);
      writeTrialDesign(db, trialPipelineId, {
        ...design,
        filed: { ...design.filed, ...Object.fromEntries(filed.map(({ key, item }) => [item.id, key])) },
        rounds: { ...design.rounds, ...Object.fromEntries(filed.map(({ item }) => [item.id, started.round.number])) },
      });
      for (const { item } of filed) wakeOnFiling(db, { engine: deps.engine }, item.id);
      return { ok: true, round: started.round, items: filed.map(({ key, item }) => ({ id: item.id, key, title: item.title, itemKey: item.key })) };
    });
  } catch (error) {
    if (!(error instanceof RoundRefused)) throw error;
    return { ok: false, problem: `No round was started: ${error.message}` };
  }
}

/**
 * The trial's plan with one round's items added (EO-587): the approved
 * design's modes, in the trial's step ids, each mocked step's result for
 * every new item, and where each new item must end. What earlier rounds'
 * items were planned to do is kept, so their outcomes are still judged
 * against what was approved for them.
 */
function extendedPlan(current: TrialPlan, design: TrialDesign, filed: readonly { key: string; item: Item }[]): TrialPlan {
  const trialStep = (draftStepId: string): string => design.stepIds[draftStepId] ?? draftStepId;
  const steps = design.plan.steps.map((entry) => {
    const stepId = trialStep(entry.stepId);
    const before = current.steps.find((existing) => existing.stepId === stepId)?.mocks ?? [];
    const added =
      entry.mode !== "mocked"
        ? []
        : filed.flatMap(({ key, item }) => {
            const mock = entry.mocks.find((candidate) => candidate.item === key);
            return mock === undefined ? [] : [{ itemId: item.id, resultKey: mock.resultKey, output: mock.output }];
          });
    return { stepId, mode: entry.mode, mocks: entry.mode === "mocked" ? [...before, ...added] : [] };
  });
  const expected = [
    ...current.expected,
    ...filed.flatMap(({ key, item }) => {
      const test = design.plan.items.find((candidate) => candidate.key === key);
      return test === undefined ? [] : [{ itemId: item.id, stepId: trialStep(test.expected.stepId), criteria: test.expected.criteria }];
    }),
  ];
  return { steps, expected };
}

/** The type a test item that names none is filed as: the project's first that is not a container, else the installation's. */
function defaultTestItemType(db: Db, projectId: string | null): ItemTypeName | null {
  const leaf = [...listItemTypes(db, projectId as Uuid | null), ...listItemTypes(db, null)].find((type) => !type.container);
  return leaf === undefined ? null : { packSlug: leaf.packSlug, slug: leaf.slug };
}

/**
 * A draft the assistant returned in a conversation testing a design
 * (EO-587), just posted as a card — the test-fix loop's next step.
 * Called once the reply is posted, with the draft cards it posted.
 *
 * Classified against the approved design by EO. A change to what the
 * person approved leaves the card as it was posted, a new design card,
 * and says why in the conversation, mentioning the person: no round
 * starts until they approve it. Anything else is applied to the trial —
 * its graph saved into the trial pipeline under the trial's own ids, so
 * new test items run it and items already running finish on the version
 * they entered on — and the next round is started. The card is answered
 * with what was done, so it is never offered to approve or publish.
 *
 * The wait is recorded on the design under test (`TrialDesign.pending`)
 * and held across turns: while a design card waits for the person, every
 * later draft is a design card too — one going back to the approved shape
 * included, since the assistant changing its mind is not the person
 * deciding — and no round starts until the person approves one, which
 * replaces the trial and the wait with it.
 *
 * A turn with no draft, with alternatives, or in a conversation testing
 * nothing is not this function's.
 */
export function continueTrialLoop(db: Db, conversation: Item, draftCardIds: readonly Uuid[], place: TrialPlace = {}): void {
  if (draftCardIds.length !== 1) return;
  const live = liveTrialOf(db, conversation.id);
  if (live === undefined) return;
  const comment = getComment(db, draftCardIds[0]!);
  if (comment === undefined || comment.createdAt < live.trial.trialAt) return;
  const shown = designOfCard(db, conversation, comment);
  if (shown === null) return;
  const deps = trialLoopDeps(db);

  const change = classifyDesignChange(live.design, { draft: shown.draft, plan: shown.plan });
  const actionChange = actionDefinitionChanges(readTrialActions(db, live.trial.id), (shown.output.actions ?? []).map(proposedActionDraft));
  const asks = [...change.design, ...moduleChangesBeyond(db, live, shown.output.modules ?? []), ...actionChange.design];
  const waiting = live.design.pending;
  if (asks.length > 0 || waiting !== null) {
    // This card is now the one waiting: newest wins, as for every card.
    writeTrialDesign(db, live.trial.id, { ...live.design, pending: { commentId: comment.id, reasons: asks } });
    postComment(db, {
      itemId: conversation.id,
      author: { type: "engine" },
      kind: "note",
      body:
        asks.length > 0
          ? [
              "**This draft changes the design you approved**, so it is a new design card, and testing waits for it:",
              ...asks.map((reason) => `- ${reason}`),
              "",
              "Approve the design on the card to test it. Until then no round starts.",
            ].join("\n")
          : [
              "**A change to the design is still waiting for you**, so this draft is a design card too, and testing still waits.",
              "It changes nothing you approved; approve it to go on testing that design, or approve a design with the change. Until you approve one, no round starts.",
            ].join("\n"),
      mentions: [{ type: "human" }],
      parseBodyMentions: false,
    });
    deps.engine?.notifyStateChange();
    return;
  }

  const answer = (body: string): void => {
    postComment(db, { itemId: conversation.id, parentId: comment.id, author: { type: "engine" }, kind: "note", body, parseBodyMentions: false });
    deps.engine?.notifyStateChange();
  };
  const applied = applyToTrial(db, deps, live, conversation, comment.id);
  if (applied !== null) {
    answer(`This draft changes nothing you approved, and it could not be applied to the trial: ${applied} No round was started.`);
    return;
  }
  // What the trial runs now (EO-588): the graph the publish card publishes.
  writeTrialDesign(db, live.trial.id, { ...live.design, applied: comment.id });
  const within = [...change.within, ...actionChange.within];
  const changed = within.length === 0 ? "Nothing about the steps changed, so this is the same design tested again." : `Changed since the design you approved: ${within.join("; ")}.`;
  const round = runDesignRound(db, deps, live.trial.id, comment.authorId ?? "human", place);
  answer(
    round.ok
      ? [
          `**Applied to the trial without a new design card** — it changes nothing you approved. ${changed}`,
          "",
          `Round ${round.round.number} has started with ${round.items.length === 1 ? "1 test item" : `${round.items.length} test items`}:`,
          ...round.items.map((item) => `- ${item.itemKey} "${item.title}"`),
        ].join("\n")
      : `**Applied to the trial without a new design card** — it changes nothing you approved. ${changed} ${round.problem}`,
  );
}

/**
 * How a revised draft's action definitions differ from the ones the trial
 * runs on (EO-832), sorted as `classifyDesignChange` sorts a draft's
 * routes: a definition added or dropped, or one that declares a result it
 * did not or no longer declares one, changes what a step may answer — a
 * declared result added or removed, which is the person's — while its
 * description, its fields and the words on its results are applied
 * without a card, as a step's instructions and a result's words are.
 */
function actionDefinitionChanges(running: readonly ActionDefinitionDraft[], proposed: readonly ActionDefinitionDraft[]): { design: string[]; within: string[] } {
  const design: string[] = [];
  const within: string[] = [];
  const key = (definition: ActionDefinitionDraft): string => `${definition.role}\u0000${definition.action}`;
  const named = (definition: ActionDefinitionDraft): string => `${definition.role}'s "${definition.action}"`;
  const wordsOf = (definition: ActionDefinitionDraft): string =>
    JSON.stringify([definition.description ?? "", definition.results.map((result) => [result.key, result.label ?? "", result.meaning ?? ""]), definition.fields ?? {}]);
  const before = new Map(running.map((definition) => [key(definition), definition]));
  const after = new Map(proposed.map((definition) => [key(definition), definition]));
  for (const [id, definition] of after) {
    const was = before.get(id);
    if (was === undefined) {
      design.push(`it brings the action definition ${named(definition)}`);
      continue;
    }
    const keysBefore = new Set(was.results.map((result) => result.key));
    const keysAfter = new Set(definition.results.map((result) => result.key));
    for (const result of keysAfter) if (!keysBefore.has(result)) design.push(`${named(definition)} declares the result "${result}"`);
    for (const result of keysBefore) if (!keysAfter.has(result)) design.push(`${named(definition)} no longer declares the result "${result}"`);
    if (wordsOf(was) !== wordsOf(definition)) within.push(`the action definition ${named(definition)}`);
  }
  for (const [id, definition] of before) if (!after.has(id)) design.push(`it no longer brings the action definition ${named(definition)}`);
  return { design, within };
}

/**
 * Modules a revised draft brings that the trial was not granted (EO-587),
 * and modules of the trial whose grant a widened manifest withdrew
 * (EO-583): each needs the person, on a design card. A module restated
 * exactly as the trial runs it is no change.
 */
function moduleChangesBeyond(db: Db, live: LiveTrial, proposed: readonly { slug: string; name: string }[]): string[] {
  const asks: string[] = [];
  const runs = new Set(Object.values(live.design.moduleIds));
  const named = new Set(Object.keys(live.design.moduleIds));
  const catalogued = (slug: string) => [...named, ...runs].map((id) => getModule(db, id)).find((module) => module?.slug === slug);
  for (const module of proposed) if (catalogued(module.slug) === undefined) asks.push(`it proposes the module "${module.name}"`);
  for (const moduleId of runs) {
    const grant = latestTrialGrant(db, moduleId, live.trial.id);
    if (grant === undefined || grant.withdrawnAt !== null) asks.push(`"${getModule(db, moduleId)?.name ?? moduleId}" now needs more than its trial grant covers`);
  }
  return asks;
}

/**
 * Saves a revised draft's graph into the trial (EO-587), under the
 * trial's own step ids and running the modules the trial was granted, or
 * answers why it could not. Only ever for a draft that changes nothing
 * the person approved, so the trial's steps, routes and modules are the
 * same set, and only what is inside them moves.
 */
function applyToTrial(db: Db, deps: DesignDeps, live: LiveTrial, conversation: Item, commentId: Uuid): string | null {
  const graph = assistDraftForPublish(db, conversation, commentId);
  if (!graph.ok) return graph.reason;
  const { stepIds, moduleIds } = live.design;
  const mapped = (id: string): string => stepIds[id] ?? id;
  // The revised draft's teams as the trial's own (EO-881), the same ones each round.
  const teams = trialTeams(db, { id: live.trial.id, name: getPipeline(db, live.trial.id)?.name ?? "trial" }, graph.teams);
  const saved = savePipeline(
    db,
    deps.engine as EngineHandle | undefined,
    {
      pipelineId: live.trial.id,
      ...(teams.teams.length === 0 ? {} : { teams: teams.teams }),
      steps: graph.steps.map((step) => ({
        // A brief naming a draft step names that step's trial id (EO-831).
        ...remapStepReferences(step, mapped),
        id: mapped(step.id),
        pipelineId: live.trial.id,
        teamId: teams.teamIdOf(step.teamId),
        entryAction: step.type === "module" && step.entryAction !== null ? (moduleIds[step.entryAction] ?? step.entryAction) : step.entryAction,
        // The newest version of what it runs here (EO-770): a round tests the
        // module as the draft has just saved it.
        moduleVersion: step.type === "module" && step.entryAction !== null ? newestModuleVersion(db, moduleIds[step.entryAction] ?? step.entryAction) : null,
      })),
      routes: graph.routes.map((route) => ({ ...route, pipelineId: live.trial.id, fromStepId: mapped(route.fromStepId), target: mapped(route.target) })),
      entryStepId: mapped(graph.entryStepId),
      // Judged with the revised draft's definitions, none written (EO-832).
      ...(graph.actions.length === 0 ? {} : { actions: graph.actions }),
    },
    undefined,
    { judgeActionsOnly: true, trialTeams: teams.sources },
  );
  if (saved.saved) {
    // What the trial's items are held to from now on (EO-832).
    writeTrialActions(db, live.trial.id, graph.actions);
    return null;
  }
  return saved.problems
    .filter((problem) => problem.severity === "error")
    .map((problem) => problem.message)
    .join(" ");
}
