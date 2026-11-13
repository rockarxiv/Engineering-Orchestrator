import { diffVersions, WEBHOOK_UNATTENDED_NO_ENTRY, type IpcPayload, type IpcResponse, type Item, type PipelineVersion, type Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import {
  archivePipeline,
  createPipeline,
  currentVersion,
  divergence,
  getPerson,
  getPipeline,
  getPipelineVersion,
  getStep,
  liveGraph,
  listActiveRuns,
  listPipelineVersions,
  listStepsForPipeline,
  listItemsIncludingArchived,
  pipelineHasWebhookEntry,
  postComment,
  setItemArchived,
  setWebhookUnattended,
  versionHasStep,
  versionGraph,
  versionSnapshot,
  versionAuthorName,
  listModules,
} from "../db/repos/index.js";
import { recordFor } from "../record/localRecord.js";
import { stepClearanceReason } from "../record/stepAuthority.js";
import { pipelines } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { pipelineHome } from "./pipelineHome.js";
import { activeProjectId } from "./repositoryCommands.js";

/**
 * An empty pipeline, on the project named or else the one the window is
 * on (EO-766). Refused, with nothing written, where there is no project
 * to put it on: no pipeline is shared between projects any more.
 */
export function createPipelineCommand(db: Db, input: IpcPayload<"pipelines:create">): IpcResponse<"pipelines:create"> {
  const home = pipelineHome(db, (input.projectId as Uuid | null) ?? activeProjectId(db));
  if (!home.ok) return { pipeline: null, problem: home.problem };
  const pipeline = createPipeline(db, {
    projectId: home.projectId,
    name: input.name,
    icon: input.icon ?? null,
    position: Date.now(),
  });
  return {
    pipeline: {
      id: pipeline.id,
      projectId: pipeline.projectId,
      name: pipeline.name,
      icon: pipeline.icon,
      entryStepId: pipeline.entryStepId,
      position: pipeline.position,
      archivedAt: pipeline.archivedAt,
    },
    problem: null,
  };
}

export function updatePipelineCommand(db: Db, input: IpcPayload<"pipelines:update">): IpcResponse<"pipelines:update"> {
  const existing = getPipeline(db, input.id);
  if (!existing) throw new Error(`no pipeline ${input.id}`);

  const patch: Record<string, unknown> = { updatedAt: Date.now() };
  if (input.name !== undefined) patch.name = input.name;
  if (input.icon !== undefined) patch.icon = input.icon;
  if (input.position !== undefined) patch.position = input.position;
  db.update(pipelines).set(patch).where(eq(pipelines.id, input.id)).run();

  const updated = getPipeline(db, input.id)!;
  return {
    pipeline: {
      id: updated.id,
      projectId: updated.projectId,
      name: updated.name,
      icon: updated.icon,
      entryStepId: updated.entryStepId,
      position: updated.position,
      archivedAt: updated.archivedAt,
    },
  };
}

/**
 * Lets one pipeline send what a webhook delivers without a person
 * reading it first, or stops letting it (EO-405).
 *
 * The lock is not asked here. `pipelines:setWebhookUnattended` is one of
 * the pipelines section's channels, so on a desktop whose organisation
 * manages that section `handleIpcRequest` has refused before this runs,
 * with the same typed refusal `pipeline:save` gets — and with no
 * exception for a diverged copy, which is an edit of a graph and not an
 * acceptance of a risk.
 *
 * Turning it on is refused where no webhook job files onto the
 * pipeline. There is nothing there to accept yet, and a waiver given
 * ahead of the webhook is one nobody read the terms of: the job that
 * arrived later would find the door already open. Turning it off is
 * always allowed, including on a pipeline whose webhook job has since
 * gone.
 *
 * A refusal is an answer rather than a throw, with the sentence to show
 * (invariant #8). An unknown pipeline is a programmer error, as it is
 * for `pipelines:update`.
 */
export function setWebhookUnattendedCommand(
  db: Db,
  input: IpcPayload<"pipelines:setWebhookUnattended">,
): IpcResponse<"pipelines:setWebhookUnattended"> {
  const existing = getPipeline(db, input.pipelineId);
  if (!existing) throw new Error(`no pipeline ${input.pipelineId}`);

  if (input.unattended && !pipelineHasWebhookEntry(db, input.pipelineId)) {
    return { unattended: existing.webhookUnattended, refused: WEBHOOK_UNATTENDED_NO_ENTRY };
  }
  if (existing.webhookUnattended !== input.unattended) setWebhookUnattended(db, input.pipelineId, input.unattended);
  return { unattended: input.unattended, refused: null };
}

/** Every item on one of a pipeline's steps, archived or not. */
function itemsOnPipeline(db: Db, pipelineId: string): Item[] {
  const stepIds = new Set(listStepsForPipeline(db, pipelineId).map((step) => step.id));
  return listItemsIncludingArchived(db).filter((item) => item.stepId !== null && stepIds.has(item.stepId));
}

/**
 * How many items deleting a pipeline would archive with it: the ones on
 * its steps that are not archived already — what `pipelines:delete`
 * answers as `archivedItemCount`, asked before rather than after, for the
 * card that offers the delete (EO-521).
 */
export function itemsArchivedWithPipeline(db: Db, pipelineId: string): number {
  return itemsOnPipeline(db, pipelineId).filter((item) => item.archivedAt === null).length;
}

/**
 * Deletes a pipeline by archiving it, along with the work on it (KAN-59).
 *
 * Archiving rather than dropping, for the reason invariant #3 gives about
 * `run_events`: someone asking for a pipeline to be gone is not asking for
 * the history of everything that flowed through it to be rewritten. The
 * items keep their comments, runs and cost, and the Archive screen is
 * where they remain visible.
 *
 * Refused outright while a run is active on one of those items. Archiving
 * underneath a running agent would leave a subprocess writing events for an
 * item the UI has stopped showing — and killing it is a different
 * decision, which the person should make deliberately.
 */
export function deletePipelineCommand(db: Db, input: IpcPayload<"pipelines:delete">): IpcResponse<"pipelines:delete"> {
  const onPipeline = itemsOnPipeline(db, input.id);

  const activeItemIds = new Set(listActiveRuns(db).map((run) => run.itemId));
  if (onPipeline.some((item) => activeItemIds.has(item.id))) {
    return { deleted: false, archivedItemCount: 0, blockedByActiveRun: true };
  }

  const now = Date.now();
  let archived = 0;
  db.transaction(() => {
    for (const item of onPipeline) {
      if (item.archivedAt !== null) continue;
      setItemArchived(db, item.id, now);
      archived += 1;
    }
    archivePipeline(db, input.id, now);
  });

  return { deleted: true, archivedItemCount: archived, blockedByActiveRun: false };
}

/**
 * Moves what a step holds to another step, so the step can go
 * (EO-327, ARCHITECTURE.md, "Publish, lock and versions").
 *
 * The other half of the strand refusal. "A publish that would strand
 * items… is refused with the count, and the admin is offered a move for
 * them through the ordinary transition path with an engine comment" —
 * so this is not a bulk UPDATE of `items.step_id`, which invariant #1
 * forbids anyway. It is `transitionItem` once per item, with everything
 * that means: a `transitions` row, an assignee on arrival, a Jira push,
 * and a note in each thread saying why the card moved.
 *
 * Three things are left behind rather than forced, and each is counted
 * so the screen can say which:
 *
 * - **Archived items.** They are not on the board; restoring one is a
 *   decision of its own, and the refusal already sends a person to the
 *   Archive for them.
 * - **Items with a run in flight.** Moving one out from under a working
 *   agent discards the run, which is `items:move`'s own rule and not
 *   something to do to several items at once without being asked.
 * - **Nothing at all**, when the step is already empty, which answers
 *   `moved: 0` rather than a problem: the person's goal is met.
 */
export function moveStepItemsCommand(db: Db, input: IpcPayload<"pipeline:moveStepItems">): IpcResponse<"pipeline:moveStepItems"> {
  const from = getStep(db, input.fromStepId);
  const to = getStep(db, input.toStepId);
  const nothing = { moved: 0, archived: 0, running: 0, otherVersion: 0 };
  if (!from) return { ...nothing, problem: `No step "${input.fromStepId}" to move work off.` };
  if (!to) return { ...nothing, problem: `No step "${input.toStepId}" to move work to.` };
  if (to.id === from.id) return { ...nothing, problem: `${from.name} cannot be moved to itself.` };

  const onStep = listItemsIncludingArchived(db).filter((item) => item.stepId === from.id);
  const archived = onStep.filter((item) => item.archivedAt !== null).length;
  const activeItemIds = new Set(listActiveRuns(db).map((run) => run.itemId));
  const live = onStep.filter((item) => item.archivedAt === null && !activeItemIds.has(item.id));
  const running = onStep.filter((item) => item.archivedAt === null && activeItemIds.has(item.id)).length;
  // An item finishing on an older version may only be moved to a step
  // that version has (EO-327, ARCHITECTURE.md, "Publish, lock and versions") — the same rule the
  // drag meets, and
  // it has to hold here or "move them all" would be the way around it.
  // Left where they are and counted, like the archived and the running:
  // a bulk move that silently skipped work would leave a person believing
  // the step was empty.
  const movable = live.filter((item) => versionHasStep(db, item, to.id));
  const otherVersion = live.length - movable.length;

  for (const item of movable) {
    // Before the move, so it sits above it in the thread and in front of
    // whichever agent the arrival dispatches — the arrangement
    // `items:move`'s own comment follows (ARCHITECTURE.md, "Moving an item by hand").
    postComment(db, {
      itemId: item.id,
      author: { type: "engine" },
      kind: "note",
      body: `Moved from **${from.name}** to **${to.name}**: ${from.name} is being removed from the pipeline, and work on a step cannot be left standing on one that no longer exists.`,
    });
    // A command the record applies rather than a write of our own
    // (EO-322, invariant #1): the record is the one writer of where an
    // item sits, and "move them for me" is a person asking for a move
    // like any other.
    recordFor(db).applyTransition({
      itemId: item.id as Uuid,
      toStepId: to.id,
      // Named always, even within one pipeline, for the reason
      // `TransitionItemInput` gives: the check is worth having wherever
      // the two halves could disagree.
      toPipelineId: to.pipelineId,
      actor: "human",
      reason: stepClearanceReason(from.name),
    });
  }

  return { moved: movable.length, archived, running, otherVersion, problem: null };
}

/**
 * A pipeline's versions, and what changed between two of them
 * (EO-327, the original design — "View changes").
 *
 * The diff is computed here rather than in the renderer because the same
 * view is what the design shows an admin for a suggestion, and a diff that
 * lived in one screen would be a diff the other could not show.
 *
 * Defaults to the newest pair, which is what the banner's link means:
 * "Pipeline updated to v7" asks what v7 changed, and the answer is
 * against v6. A pipeline with one version has nothing to compare and
 * says so with a null rather than an empty diff — "nothing changed" and
 * "there is nothing to change from" are different sentences.
 */
export function pipelineVersionsCommand(db: Db, input: IpcPayload<"pipeline:versions">): IpcResponse<"pipeline:versions"> {
  const rows = listPipelineVersions(db, input.pipelineId);
  const versions: PipelineVersion[] = rows.map((version) => ({
    ...version,
    createdByName: versionAuthorName(version.createdBy, (personId) => getPerson(db, personId as Uuid)?.name ?? null),
  }));

  // Asked first, and answered whatever the history says, because it is
  // a different question: "what have *I* changed" has an answer on a
  // diverged pipeline with one version, which is exactly the case the
  // history below has nothing to say about (EO-331).
  const local = localChanges(db, input.pipelineId);
  // Which one History marks as current (EO-359). Read rather than taken
  // to be the newest, because the organisation's rollback points a
  // pipeline back at an older number without filing a new one.
  const current = currentVersion(db, input.pipelineId)?.number ?? null;
  const graph = input.graph === undefined ? null : draftOfVersion(db, rows, input.graph);

  const to = rows.find((version) => version.number === input.to) ?? rows[rows.length - 1];
  const from = rows.find((version) => version.number === input.from) ?? rows.filter((version) => (to ? version.number < to.number : false)).at(-1);
  if (!to || !from) return { versions, current, graph, diff: null, local };

  const before = versionGraph(db, from.id);
  const after = versionGraph(db, to.id);
  if (!before || !after) return { versions, current, graph, diff: null, local };

  return { versions, current, graph, diff: diffVersions({ number: from.number, ...before }, { number: to.number, ...after }, moduleNamesById(db)), local };
}

/**
 * One version's graph as the editor drafts it — what *Restore* loads
 * (EO-359).
 *
 * Read from the version's own document (`versionSnapshot`), whole: its
 * steps with everything they were configured with, its routes and where
 * work entered. A step since removed comes back under its own id, which
 * is what lets the save that publishes it revive the retired row
 * rather than insert a stranger beside it.
 *
 * Off-board steps are left out, for `pipelineSteps:list`'s reason: the
 * editor never shows them and `savePipeline` keeps them whatever a draft
 * says, so a draft carrying them would be submitting them twice.
 *
 * Writes nothing. Null for a number this pipeline does not have, or
 * whose document this build cannot read.
 */
function draftOfVersion(db: Db, rows: readonly { id: string; number: number }[], number: number): IpcResponse<"pipeline:versions">["graph"] {
  const row = rows.find((version) => version.number === number);
  const snapshot = row === undefined ? undefined : versionSnapshot(db, row.id);
  if (row === undefined || snapshot === undefined) return null;

  const steps = snapshot.steps.filter((step) => !step.offBoard);
  return {
    number,
    steps: steps.map((step) => ({
      id: step.id,
      pipelineId: step.pipelineId,
      position: step.position,
      name: step.name,
      type: step.type,
      ownerRole: step.ownerRole,
      entryAction: step.entryAction,
      instructionsSummary: step.instructionsSummary,
      isTerminal: step.isTerminal,
      planMode: step.planMode,
      workspaceMode: step.workspaceMode,
      workspaceId: step.workspaceId,
      inputs: step.inputs,
      timeoutMs: step.timeoutMs,
      watch: step.watch,
      results: step.results,
      // The module version it ran (EO-770): a restore runs that code again.
      moduleVersion: step.moduleVersion,
    })),
    routes: snapshot.routes.map((route) => ({
      id: route.id,
      pipelineId: route.pipelineId,
      fromStepId: route.fromStepId,
      resultKey: route.resultKey,
      label: route.label,
      tone: route.tone,
      target: route.target,
      position: route.position,
    })),
    entryStepId: snapshot.entryStepId,
    entryRules: snapshot.entryRules,
  };
}

/**
 * What this machine has changed and published to nobody (EO-331,
 * the design's *Compare*).
 *
 * "Compare, which opens both sets of changes side by side" is the first
 * of the three actions a diverged pipeline offers, and it is the one a
 * person reaches for *before* deciding between the other two: suggest
 * this, or throw it away. Neither decision can be made from a screen
 * that cannot show the change.
 *
 * The live graph against the version the copy was based on, because
 * those are the two sets: what the organisation published, and what is
 * here now. It is not a version diff and never will be — a diverged
 * copy files no version on purpose, so that the history of a published
 * pipeline stays the history of what was actually published.
 *
 * Both numbers are the base version's. The right-hand side is not a
 * version and has no number of its own, and inventing the next one
 * would put a number on a screen that names a publish nobody has made.
 * What the screen draws over it is "your edits", which is what they
 * are.
 *
 * Null for every pipeline nobody here has diverged, and null where the
 * base version's document has not reached this machine — the sentence
 * for that is *Discard my edits*' own, and a diff of a graph against
 * nothing would be every step reported as added.
 */
function localChanges(db: Db, pipelineId: string): IpcResponse<"pipeline:versions">["local"] {
  const diverged = divergence(db, pipelineId);
  if (diverged === undefined) return null;

  const base = getPipelineVersion(db, diverged.versionId);
  const before = base === undefined ? undefined : versionGraph(db, base.id);
  if (base === undefined || before === undefined) return null;

  const diff = diffVersions({ number: base.number, ...before }, { number: base.number, ...liveGraph(db, pipelineId) }, moduleNamesById(db));
  return { basedOn: base.number, diff };
}

/** Every module's name by id, archived ones included, so a version diff names the module a rule runs (EO-736). */
function moduleNamesById(db: Db): Map<string, string> {
  return new Map(listModules(db, true).map((module) => [module.id as string, module.name]));
}
