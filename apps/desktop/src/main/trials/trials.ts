import { NONE_KIND, TERMINAL_TARGET, USER_ATTENTION_TARGET, uuidv7, type IpcPayload, type Item, type Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import {
  createItem,
  createPipeline,
  forkModuleForTrial,
  getItem,
  getModule,
  grantTrial,
  getPipeline,
  getTrialPipeline,
  listStepsForPipeline,
  markTrialPipeline,
  projectWorkspaceList,
  writeTrialStepSources,
  type ItemTypeName,
  type TrialPipeline,
} from "../db/repos/index.js";
import { projectMovedToTheRecord } from "../db/repos/projectsRepo.js";
import { readAssistDraftForPublish } from "../ipc/assistCommands.js";
import { savePipeline } from "../ipc/configCommands.js";
import type { EngineHandle } from "../ipc/domainCommands.js";
import { wakeOnFiling } from "./loop.js";
import { trialModuleFor } from "./trialModules.js";

/**
 * Where a trial is being made or filed on (EO-582): this installation's
 * own database, or the organisation's record. Absent is a desktop.
 *
 * It decides one thing. A project somebody moved to the record is
 * scheduled there and nowhere else — a desktop runs none of its items
 * (`deviceRecord.offerWork`) — so a trial written into a desktop's copy of
 * one would be rows nothing can run and the record never hears of. On a
 * desktop such a project is refused before anything is written; on the
 * record, which owns it, it is the ordinary case.
 */
export interface TrialPlace {
  onTheRecord?: boolean;
}

/**
 * Making a trial (EO-583): where, as `TrialPlace` says, and who is
 * granting the draft's modules permission to run on it.
 */
export interface TrialStart extends TrialPlace {
  /**
   * Who granted the trial grants, in `transitions.actor`'s vocabulary.
   * The person approving the design is what starts a trial, so absent is
   * `"human"`.
   */
  grantedBy?: string;
  /**
   * The draft copies an earlier trial of the same conversation made, by
   * the module each copies (EO-587). A redesign replaces that trial, and
   * the loop may have fixed a copy's code meanwhile: the new trial runs
   * the copy it already has rather than forking the original again, so
   * nothing the loop fixed is lost by the person approving a new shape.
   */
  carriedCopies?: Readonly<Record<string, string>>;
}

/**
 * Trial pipelines (EO-582, ARCHITECTURE.md, "Trial pipelines").
 *
 * A pipeline draft is tested by running real items through it. Items
 * stand on `pipeline_steps` rows and bind to a published version, so a
 * draft cannot carry one: it is materialised as a hidden pipeline of its
 * own — created and saved through `savePipeline`, the function every
 * publish goes through, so its graph is judged and versioned exactly as a
 * published one would be — and marked as a trial, which keeps it out of
 * everything a person browses.
 *
 * Three acts, and no more: make a trial from a draft card, file trial
 * items on it, and discard it (`discard.ts`). The pipeline the draft would replace is
 * read and never written; nothing here can change what a live item runs.
 */

/** What making a trial answers with. */
export type CreateTrialResult =
  | {
      ok: true;
      trial: TrialPipeline;
      /**
       * Which trial step each of the draft's steps became, by the draft's
       * step id. Every step gets a fresh id — a draft that changes a
       * pipeline names that pipeline's own steps, and a row cannot be on
       * two pipelines.
       */
      stepIds: Record<string, string>;
      /**
       * Which module each of the draft's module steps runs on the trial,
       * by the module the draft named (EO-583): itself, or the draft copy
       * made of it where a published pipeline uses it.
       */
      moduleIds: Record<string, string>;
    }
  | { ok: false; problem: string };

/** A refusal raised inside the transaction, so the created pipeline goes back with it. */
class TrialRefused extends Error {}

/**
 * Makes a hidden trial pipeline out of a draft card (EO-582).
 *
 * The card is read the way Publish reads it (`readAssistDraftForPublish`):
 * still the newest draft in an open assistant conversation, still fitting
 * the pipeline it targets, judged by the same validator. Then two things
 * a published draft may do and a trial may not are refused, each because
 * it would reach past the trial into live work:
 *
 *   * action definitions — a role's definitions are shared by every
 *     pipeline that names the role, so writing one changes live work;
 *   * a route handing work to another pipeline's step — a trial item
 *     following it would land on a live board.
 *
 * What is written, in one transaction: a pipeline on the conversation's
 * project (the target's, where the draft changes one), marked as a trial
 * of that conversation and that target, and the draft's graph saved into
 * it under fresh step ids through `savePipeline` — which files its
 * version. A graph the save refuses takes the pipeline back with it.
 *
 * And its modules (EO-583), in the same transaction. Every module the
 * draft runs is granted permission to run on this trial's items, within
 * the needs it declares now, by `grantedBy` — which is what lets a module
 * nobody has approved run here and nowhere else. A module a published
 * pipeline uses is never edited by a trial: the trial is given a draft
 * copy of it, granted instead, and its step runs the copy, so whatever
 * the loop does to the copy leaves the original's code, approval and
 * versions, and every live item running it, as they were.
 */
export function createTrialFromDraft(
  db: Db,
  engine: Pick<EngineHandle, "notifyStateChange"> | undefined,
  input: IpcPayload<"assist:draft">,
  place: TrialStart = {},
): CreateTrialResult {
  const refuse = (problem: string): CreateTrialResult => ({ ok: false, problem: `Nothing was made to test: ${problem}` });
  const conversation = getItem(db, input.conversationId as Uuid);
  const read = readAssistDraftForPublish(db, input, place);
  if (read.problem !== null || conversation === undefined) return refuse(read.problem ?? "That conversation does not exist.");

  if (read.actions.length > 0) {
    return refuse("this draft comes with action definitions, which every pipeline naming that role would use — a trial cannot write them without changing live work.");
  }

  const draftStepIds = new Set(read.steps.map((step) => step.id));
  const handOff = read.routes.find((route) => !draftStepIds.has(route.target) && route.target !== USER_ATTENTION_TARGET && route.target !== TERMINAL_TARGET);
  if (handOff !== undefined) {
    const from = read.steps.find((step) => step.id === handOff.fromStepId)?.name ?? handOff.fromStepId;
    return refuse(`"${from}" hands work to a step of another pipeline, and a trial item following that route would land on live work.`);
  }
  if (read.entryStepId === null || !draftStepIds.has(read.entryStepId)) return refuse("this draft has no step for work to start on.");

  const target = read.pipelineId === null ? undefined : getPipeline(db, read.pipelineId);
  if (read.pipelineId !== null && target === undefined) return refuse("the pipeline this draft changes no longer exists.");
  const baseName = read.newPipelineName ?? read.rename ?? target?.name ?? "Pipeline";
  // Where its test items will work, settled before anything is written:
  // a trial whose items could have no disk would be a trial of nothing.
  const projectId = (target?.projectId ?? conversation.projectId) as Uuid | null;
  const noDisk = noWorkspaceProblem(db, projectId) ?? heldElsewhereProblem(db, projectId, place);
  if (noDisk !== null) return refuse(noDisk);

  const stepIds: Record<string, string> = {};
  for (const step of read.steps) stepIds[step.id] = uuidv7();
  const liveStepIds = new Set(target === undefined ? [] : listStepsForPipeline(db, target.id).map((step) => step.id));
  const mapped = (id: string): string => stepIds[id] ?? id;

  try {
    return db.transaction(() => {
      const pipeline = createPipeline(db, {
        projectId,
        name: `${baseName} (trial)`,
        icon: read.icon ?? target?.icon ?? null,
        position: Date.now(),
      });
      // Before the graph is saved, so there is no moment at which a list
      // could read this pipeline as anything but a trial.
      markTrialPipeline(db, pipeline.id, { conversationId: conversation.id, targetPipelineId: target?.id ?? null });
      // Which live step each trial step is a copy of (EO-584): a draft
      // names the steps it keeps by their own ids, and those are what a
      // real step on the trial reads its own values from.
      writeTrialStepSources(db, pipeline.id, Object.fromEntries(read.steps.filter((step) => liveStepIds.has(step.id)).map((step) => [stepIds[step.id]!, step.id])));
      // Before the graph is saved too, because the save judges it: a
      // module step on a trial is accepted on a grant for that trial.
      const moduleIds = grantModules(db, pipeline.id, read.steps, place.grantedBy ?? "human", place.carriedCopies ?? {});
      const runs = (step: (typeof read.steps)[number]): (typeof read.steps)[number] =>
        step.type === "module" && step.entryAction !== null && moduleIds[step.entryAction] !== undefined ? { ...step, entryAction: moduleIds[step.entryAction]! } : step;
      const saved = savePipeline(db, engine, {
        pipelineId: pipeline.id,
        steps: read.steps.map((step) => ({ ...runs(step), id: mapped(step.id), pipelineId: pipeline.id })),
        routes: read.routes.map((route) => ({ ...route, pipelineId: pipeline.id, fromStepId: mapped(route.fromStepId), target: mapped(route.target) })),
        entryStepId: mapped(read.entryStepId!),
        // The draft's own, where it set any (EO-610). They are not
        // exercised here, because a trial's items are exempt.
        ...(read.entryRules === undefined ? {} : { entryRules: read.entryRules }),
      });
      if (!saved.saved) {
        throw new TrialRefused(
          saved.problems
            .filter((problem) => problem.severity === "error")
            .map((problem) => problem.message)
            .join(" "),
        );
      }
      return { ok: true as const, trial: getTrialPipeline(db, pipeline.id)!, stepIds, moduleIds };
    });
  } catch (error) {
    if (!(error instanceof TrialRefused)) throw error;
    return refuse(error.message);
  }
}

/**
 * Grants every module the draft's steps run permission to run on this
 * trial, copying first any a published pipeline uses (EO-583), and
 * answers with which module each step runs here, by the one it named.
 *
 * A module the draft names that is gone or archived is left to the
 * validator, which refuses the step in its own words.
 */
function grantModules(
  db: Db,
  trialPipelineId: string,
  steps: readonly { type: string; entryAction: string | null }[],
  grantedBy: string,
  carried: Readonly<Record<string, string>>,
): Record<string, string> {
  const moduleIds: Record<string, string> = {};
  for (const step of steps) {
    if (step.type !== "module" || step.entryAction === null || moduleIds[step.entryAction] !== undefined) continue;
    const module = getModule(db, step.entryAction);
    if (module === undefined || module.archivedAt !== null) continue;
    // The same choice the design card showed (`trialModuleFor`): a copy
    // the loop has been fixing, a fresh copy where live work runs what it
    // would copy, or the module itself.
    const choice = trialModuleFor(db, module.id, carried);
    const runs = choice.kind === "fork" ? forkModuleForTrial(db, module.id, Date.now(), { contentsOf: choice.contentsOf }) : choice.moduleId;
    grantTrial(db, { moduleId: runs, trialPipelineId, grantedBy });
    moduleIds[module.id] = runs;
  }
  return moduleIds;
}

/**
 * Why a trial on this project could have no workspace for its items, or
 * null where it has one (EO-582). A trial item runs on a real disk; on no
 * project, or a project with no workspace attached, it would run on none.
 */
function noWorkspaceProblem(db: Db, projectId: Uuid | null): string | null {
  if (projectId === null) return "a trial's test items work on one of a project's workspaces, and this one would be on no project. Open the conversation on a project first.";
  const attached = projectWorkspaceList(db, projectId);
  if (attached.length === 0) return "a trial's test items work on one of the project's workspaces, and it has none attached. Attach a repository or a folder first.";
  // A `none` workspace is a row with no disk behind it — what a run on it
  // is prepared with is what a preview is given. A trial's point is the
  // real disk, so such a workspace does not count.
  if (diskWorkspaces(attached).length === 0) {
    return "a trial's test items work on a real disk, and the only workspace the project has is one with no disk. Attach a repository or a folder first.";
  }
  return null;
}

/** The workspaces of these with a disk behind them: every kind but `none`. */
function diskWorkspaces<W extends { kind: string }>(attached: readonly W[]): W[] {
  return attached.filter((workspace) => workspace.kind !== NONE_KIND);
}

/** Why a trial on this project cannot be written here, or null where it can — see `TrialPlace`. */
function heldElsewhereProblem(db: Db, projectId: Uuid | null, place: TrialPlace): string | null {
  if (projectId === null || place.onTheRecord === true || !projectMovedToTheRecord(db, projectId)) return null;
  return "this project is held by your organisation's record, which schedules its work, and a trial written on this desktop would never run there.";
}

/** One test item to file on a trial. */
export interface FileTrialItemInput {
  trialPipelineId: string;
  /** Which type, by the word or by the pack and the word, as `createItem` takes it. */
  type: ItemTypeName;
  title: string;
  body?: string | null;
  spec?: Record<string, unknown> | null;
  /**
   * Which of the project's workspaces the item works on — one with a
   * disk; a `none` workspace is refused. Optional where the project has
   * exactly one with a disk; with several it has to be told which, and
   * with none it cannot hold a trial item at all.
   */
  workspaceId?: string | null;
}

export type FileTrialItemResult = { ok: true; item: Item } | { ok: false; problem: string };

/**
 * Files a test item on a trial pipeline, with the trial mark (EO-582).
 *
 * A trial item is real work in every way that decides how it runs: it
 * stands on the trial's entry step, binds to the trial's version, runs on
 * its agents' own backends, and has a workspace — the one named, or the
 * project's only one — so its steps work on a real disk. That is what sets
 * it apart from a preview, which is swapped onto the fake backend and
 * given no disk. What the mark changes is what a person browses: it is on
 * no board, in no inbox count, under no `!` and in no archive.
 *
 * It never talks to an issue tracker: an issue opened for a test item
 * would outlive the trial in somebody else's system.
 */
export function fileTrialItem(
  db: Db,
  engine: Pick<EngineHandle, "notifyStateChange"> | undefined,
  input: FileTrialItemInput,
  place: TrialPlace = {},
  options: { wake?: boolean } = {},
): FileTrialItemResult {
  const trial = getTrialPipeline(db, input.trialPipelineId);
  const pipeline = trial === undefined ? undefined : getPipeline(db, trial.id);
  if (trial === undefined || pipeline === undefined) return { ok: false, problem: "That is not a trial pipeline, so nothing was filed on it." };
  if (pipeline.entryStepId === null) return { ok: false, problem: "That trial has no step for work to start on." };

  const projectId = pipeline.projectId;
  // A real workspace, never none (EO-582): a trial item with no workspace
  // would run with no disk, which is a preview's lot and not a trial's.
  const noDisk = noWorkspaceProblem(db, projectId) ?? heldElsewhereProblem(db, projectId, place);
  if (noDisk !== null) return { ok: false, problem: `Nothing was filed: ${noDisk}` };
  const attached = projectWorkspaceList(db, projectId!);
  const disks = diskWorkspaces(attached);
  let workspaceId: Uuid;
  if (input.workspaceId !== undefined && input.workspaceId !== null) {
    const named = attached.find((workspace) => workspace.id === input.workspaceId);
    if (named === undefined) return { ok: false, problem: "That workspace is not on the trial's project." };
    if (named.kind === NONE_KIND) return { ok: false, problem: "Nothing was filed: that workspace has no disk behind it, and a trial's test items work on a real one. Name a repository or a folder." };
    workspaceId = named.id;
  } else if (disks.length > 1) {
    return { ok: false, problem: `The trial's project has ${disks.length} workspaces with a disk, so a test item has to say which one it works on.` };
  } else {
    workspaceId = disks[0]!.id;
  }

  const created = createItem(db, {
    type: input.type,
    projectId,
    workspaceId,
    title: input.title,
    body: input.body ?? null,
    spec: input.spec ?? null,
    pipelineId: trial.id,
    stepId: pipeline.entryStepId,
    trialAt: Date.now(),
    jiraSync: false,
  });
  if (!created.ok) return { ok: false, problem: created.problem };
  // Filed straight onto a person's step, it has arrived there with no move
  // to say so: the assistant is woken as a move there would wake it (EO-586).
  // A caller filing a round's items holds the wake (EO-587) until the
  // round's plan says what each item is expected to come to, and wakes
  // each itself, so the note says what was expected.
  if (options.wake !== false) wakeOnFiling(db, { engine }, created.item.id);
  engine?.notifyStateChange();
  return { ok: true, item: created.item };
}
