import {
  AssistOutputSchema,
  classifyDesignChange,
  trialPlanProblems,
  type AssistDraft,
  type AssistTrialCard,
  type AssistTrialPlan,
  type Comment,
  type IpcResponse,
  type Item,
  type TrialDesign,
  type Uuid,
} from "@eo/core";
import type { Db } from "../db/client.js";
import { getModule, listTrialPipelinesForConversation, newestTrialRound, readTrialDesign, type TrialPipeline } from "../db/repos/index.js";
import { validatePipelineCommand } from "../ipc/configCommands.js";
import { assistDraftSlot } from "../roles/assist.js";
import { outputOf, threadOf } from "../roles/conversationThread.js";
import { moduleShownFor, trialModuleFor } from "./trialModules.js";

/**
 * The design card (EO-587, ARCHITECTURE.md, "Trial pipelines"): a draft
 * card whose turn planned a test with real runs, read for the card.
 *
 * Its own module, apart from approving one (`design.ts`), because the
 * draft card's read (`assist:draft`) asks it, and that read must not
 * depend on what makes a trial.
 */

/** A trial under test from this conversation, and the design the person approved for it. */
export interface LiveTrial {
  trial: TrialPipeline;
  design: TrialDesign;
}

/**
 * The trial this conversation is testing, with its approved design: the
 * newest one made from a design card (EO-587). Undefined where the
 * conversation has none — no design was approved, or it was discarded or
 * published.
 */
export function liveTrialOf(db: Db, conversationId: string): LiveTrial | undefined {
  const trials = listTrialPipelinesForConversation(db, conversationId);
  for (const trial of [...trials].reverse()) {
    const design = readTrialDesign(db, trial.id);
    if (design !== undefined) return { trial, design };
  }
  return undefined;
}

/**
 * The trial a design card was approved for, by the card itself, whichever
 * of the conversation's trials that is (EO-587). Undefined for a card
 * nobody approved.
 */
export function trialOfDesignCard(db: Db, conversationId: string, commentId: Uuid | string): LiveTrial | undefined {
  for (const trial of listTrialPipelinesForConversation(db, conversationId)) {
    const design = readTrialDesign(db, trial.id);
    if (design?.commentId === commentId) return { trial, design };
  }
  return undefined;
}

/**
 * The trial plan a draft card is a design of, or null for a publish card
 * (EO-587).
 *
 * The plan its own turn returned. Failing that, the plan approved for the
 * card itself, where a trial was made from it — asked first, because
 * approving a card posted mid-loop makes a new trial *after* the card, so
 * the card no longer reads as posted during that trial. Failing that,
 * where the card was posted while a design of this conversation was under
 * test, the plan the person approved for it. A draft revised mid-loop is
 * a draft *of the design under test* whether or not the turn restated its
 * plan, and must never come back as a publish card that skips the trial.
 */
export function designPlanOf(db: Db, conversation: Item, comment: Pick<Comment, "id" | "createdAt">, output: { trial: AssistTrialPlan | null }): AssistTrialPlan | null {
  if (output.trial !== null) return output.trial;
  const own = trialOfDesignCard(db, conversation.id, comment.id);
  if (own !== undefined) return own.design.plan;
  const live = liveTrialOf(db, conversation.id);
  return live !== undefined && comment.createdAt >= live.trial.trialAt ? live.design.plan : null;
}

/** The draft copies a design's trial runs, by the module each copies: what a design replacing it carries (`TrialStart.carriedCopies`). */
export function copiesOf(design: TrialDesign): Record<string, string> {
  return Object.fromEntries(Object.entries(design.moduleIds).filter(([named, runs]) => named !== runs));
}

/** The draft and trial plan behind a design card, or null for a comment that is not one. */
export function designOfCard(db: Db, conversation: Item, comment: Comment): { draft: AssistDraft; plan: AssistTrialPlan; output: ReturnType<typeof AssistOutputSchema.parse> } | null {
  const thread = threadOf(db, conversation.id);
  const slot = assistDraftSlot(db, conversation, comment, thread);
  if (slot === null) return null;
  const output = outputOf(db, comment.runId, AssistOutputSchema, thread) ?? slot.output;
  const plan = designPlanOf(db, conversation, comment, output);
  return plan === null ? null : { draft: slot.draft, plan, output };
}

/**
 * What a design card shows of its trial (EO-587), or null for a draft
 * card that is not one — `assist:draft`'s `trial`.
 *
 * `read` is the graph that read answered with, so each step's mode is
 * shown beside the step as it would be saved, and what it reaches outside
 * EO is classified from it by `pipeline:validate`'s own reading (EO-584).
 */
export function designCardView(db: Db, conversation: Item, comment: Comment, read: Pick<IpcResponse<"assist:draft">, "pipelineId" | "steps" | "routes" | "entryStepId" | "problem">): AssistTrialCard | null {
  const shown = designOfCard(db, conversation, comment);
  if (shown === null) return null;
  const { draft, plan } = shown;

  const stepName = (id: string): string => draft.steps.find((step) => step.id === id)?.name ?? id;
  const titleOf = (key: string): string => plan.items.find((item) => item.key === key)?.title ?? key;

  const own = trialOfDesignCard(db, conversation.id, comment.id);
  const live = liveTrialOf(db, conversation.id);
  const approvedHere = own !== undefined && live !== undefined && own.trial.id === live.trial.id;
  const underTest = live !== undefined && !approvedHere && comment.createdAt >= live.trial.trialAt ? live : undefined;

  // The modules this card grants, as approving it would choose them
  // (`trialModuleFor`): the ones its trial runs once approved; before
  // that, the copies the design under test has been fixing where it would
  // carry them, so the needs, code and cases on each row — and what each
  // step reaches outside EO — are what the person is granting.
  const carried = underTest === undefined ? {} : copiesOf(underTest.design);
  const granted = (moduleId: string): string => (own !== undefined ? (own.design.moduleIds[moduleId] ?? moduleId) : moduleShownFor(trialModuleFor(db, moduleId, carried)));
  const steps = read.steps.map((step) => (step.type === "module" && step.entryAction !== null ? { ...step, entryAction: granted(step.entryAction) } : step));
  const reach = read.problem === null && steps.length > 0 ? outsideReachOf(db, { ...read, steps }) : {};

  const modules = new Map<string, { slug: string; name: string }>();
  for (const step of steps) {
    if (step.type !== "module" || step.entryAction === null) continue;
    const module = getModule(db, step.entryAction);
    if (module !== undefined) modules.set(module.slug, { slug: module.slug, name: module.name });
  }

  // A design posted while another is under test: what it changes is why it
  // is a card — and, where a change is already waiting for the person, a
  // draft back to the approved shape is a card too.
  // The loop recorded why the card it left waiting is one — a module whose
  // grant was withdrawn included, which the graph alone does not say.
  const pending = underTest?.design.pending ?? null;
  const classified = pending?.commentId === comment.id ? pending.reasons : underTest === undefined ? [] : classifyDesignChange(underTest.design, { draft, plan }).design;
  const changes =
    classified.length > 0 || pending === null ? classified : ["nothing you approved, but it follows a change to the design that is waiting for you, so testing waits until you approve a design"];
  const unfit = trialPlanProblems(draft, plan);

  return {
    items: plan.items.map((item) => ({
      key: item.key,
      title: item.title,
      body: item.body,
      expectedStepId: item.expected.stepId,
      expectedStepName: stepName(item.expected.stepId),
      criteria: item.expected.criteria,
    })),
    steps: [...draft.steps]
      .sort((a, b) => a.position - b.position)
      .map((step) => {
        const entry = plan.steps.find((candidate) => candidate.stepId === step.id);
        return {
          stepId: step.id,
          name: step.name,
          mode: entry?.mode ?? "real",
          reason: entry?.reason ?? null,
          reaches: reach[step.id] ?? null,
          mocks: (entry?.mocks ?? []).map((mock) => ({ item: titleOf(mock.item), resultKey: mock.resultKey, output: mock.output })),
        };
      }),
    modules: [...modules.values()],
    changes,
    problem: unfit.length === 0 ? null : `The trial plan does not fit this draft, so this design cannot be approved: ${unfit.join(" ")} Ask for the draft again with its trial plan.`,
    approved: approvedHere ? { trialPipelineId: own.trial.id, round: newestTrialRound(db, own.trial.id)?.number ?? null } : null,
  };
}

/** Per step of the graph read, whether it sends or creates outside EO — `pipeline:validate`'s classification (EO-584). */
function outsideReachOf(db: Db, read: Pick<IpcResponse<"assist:draft">, "pipelineId" | "steps" | "routes" | "entryStepId">): Record<string, "sends" | "creates"> {
  return validatePipelineCommand(db, { pipelineId: read.pipelineId ?? "", steps: read.steps, routes: read.routes, entryStepId: read.entryStepId }).outsideReach;
}

