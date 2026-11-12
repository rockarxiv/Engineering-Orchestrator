import {
  boardDocument,
  documentSteps,
  sameBoard,
  PipelineStepViewSchema,
  StepRouteViewSchema,
  type IpcPayload,
  type IpcResponse,
  type PipelineGraphSnapshot,
  type PipelineStep,
  type StepRoute,
  type TemplateStepIds,
  type UpdateConflictEdit,
  type UpdateConflictGraph,
  type UpdateConflictDetail,
  type UpdateConflictResolution,
  type UpdateKeyChange,
  type Uuid,
} from "@eo/core";
import type { ComparableGraph, KeyChange } from "@eo/engine";
import type { Db } from "../db/client.js";
import {
  getModuleBySlug,
  getPerson,
  getPipeline,
  getPipelineOrigin,
  getStep,
  getTemplateSnapshot,
  listPipelineVersions,
  listStepsForPipeline,
  listUpdateConflicts,
  openUpdateConflict,
  recordPipelineOrigin,
  resolveUpdateConflict,
  templateUpdateAuthor,
  versionAuthorName,
  versionSnapshot,
  type PipelineUpdateConflict,
} from "../db/repos/index.js";
import { isTemplateDocument, templateBoardHolders, type TemplateDocument } from "../db/repos/pipelineOriginsRepo.js";
import { savePipeline } from "../ipc/configCommands.js";
import type { TemplateVersion } from "./history.js";
import { compareWithTemplate, conflictStepNames, describeConflicts, FIELD_WORDS, heldByTheRecord, pointRoutesWaitingOn, type PipelineComparison } from "./templateUpdates.js";

/**
 * A held template update, read whole for the assistant (EO-534), and
 * the two ways a person resolves one.
 *
 * `describeUpdateConflict` is what `pipeline_update_conflict` answers on
 * EO's administrative server. It writes nothing, and it compares again
 * rather than repeating what the conflict recorded: the pipeline may
 * have been edited since the update was held, and a draft built from a
 * stale picture of it would propose undoing that edit.
 *
 * `resolveHeldUpdate` closes a conflict and moves the pipeline's base to
 * the held template version, so the same comparison is never raised
 * again — whether the person published a draft from the conflict's chat
 * or kept their pipeline as it is. A later template version starts a
 * new comparison from the new base.
 *
 * All of it runs on whichever installation holds the conflict: a
 * desktop for its own pipelines, the organisation's record for the ones
 * it holds. A desktop asks the record for those (`ItemRecord.updateConflict`,
 * `ItemRecord.resolveUpdateConflict`), and the record answers with the
 * same functions.
 */

/** Where this runs: on the organisation's record, a pipeline it holds is its own, never "the record's". */
export interface ConflictPlace {
  onTheRecord?: boolean;
}

/** What a desktop answers about a pipeline whose template updates are its organisation record's, when the record cannot be asked. */
export const UPDATE_CONFLICT_ON_THE_RECORD =
  "This pipeline is held by your organisation's record, and its template updates are compared there, not on this desktop — and this desktop is not signed in to it, so its update cannot be read or resolved from here.";

/** What is answered for a pipeline with no open update conflict here. */
/**
 * Whether a pipeline's template updates are another installation's to
 * hold (EO-534): on a desktop, one its organisation's record holds now —
 * whatever conflict this database recorded before the record took the
 * pipeline over. Such a conflict is not the update: the record compares
 * the pipeline, holds its own, and that is the one read and resolved.
 */
export function updateHeldElsewhere(db: Db, pipelineId: string, place: ConflictPlace = {}): boolean {
  return place.onTheRecord !== true && heldByTheRecord(db, pipelineId);
}

export function noUpdateConflict(db: Db, pipelineId: string, place: ConflictPlace = {}): string {
  if (updateHeldElsewhere(db, pipelineId, place)) return UPDATE_CONFLICT_ON_THE_RECORD;
  const pipeline = getPipeline(db, pipelineId);
  if (pipeline === undefined) return `There is no pipeline with the ID "${pipelineId}".`;
  return `"${pipeline.name}" has no held template update: nothing is waiting to be resolved.`;
}

export function describeUpdateConflict(db: Db, pipelineId: string, place: ConflictPlace = {}): IpcResponse<"pipeline:updateConflict"> {
  // Not this database's to answer, whatever it holds: nobody who could say was asked.
  if (updateHeldElsewhere(db, pipelineId, place)) return { conflict: null, problem: UPDATE_CONFLICT_ON_THE_RECORD, authoritative: false };
  const conflict = openUpdateConflict(db, pipelineId);
  if (conflict === undefined) return { conflict: null, problem: noUpdateConflict(db, pipelineId, place), authoritative: true };

  const read = heldTemplate(db, conflict);
  const origin = getPipelineOrigin(db, pipelineId);
  if (read === null || origin === null) {
    return { conflict: null, problem: `The template version this update holds, or the base it was compared with, can no longer be read for pipeline "${pipelineId}".`, authoritative: true };
  }
  const compared = compareWithTemplate(db, pipelineId, read);
  if (compared === null) return { conflict: null, problem: `Pipeline "${pipelineId}" no longer records the template it came from.`, authoritative: true };
  const { baseBoard, nextBoard } = compared;

  const local = (id: string): string => origin.stepIds[id] ?? id;
  const stepName = conflictStepNames(db, conflict);
  const ordered = [...compared.merge.comparison.changes].sort((a, b) => Number(b.outcome === "conflict") - Number(a.outcome === "conflict"));
  const currentIds = new Set(compared.current.steps.map((step) => step.id));
  const takenStepIds = compared.next.steps
    .filter((step) => !currentIds.has(step.id))
    .filter((step) => {
      const holder = getStep(db, step.id);
      return holder !== undefined && holder.pipelineId !== pipelineId;
    })
    .map((step) => step.id);

  return {
    conflict: {
      conflictId: conflict.id,
      pipelineId,
      pipelineName: getPipeline(db, pipelineId)?.name ?? pipelineId,
      templateSlug: conflict.templateSlug,
      templateTitle: nextBoard.template.title,
      fromVersion: conflict.fromVersion,
      toVersion: conflict.toVersion,
      releaseNotes: conflict.notes,
      base: graphView(compared.base, baseBoard.pipeline.entryStepId === null ? null : local(baseBoard.pipeline.entryStepId)),
      current: graphView(compared.current, getPipeline(db, pipelineId)?.entryStepId ?? null),
      template: graphView(compared.next, nextBoard.pipeline.entryStepId === null ? null : local(nextBoard.pipeline.entryStepId)),
      changes: ordered.map((change) => keyChangeView(change, stepName)),
      problems: conflict.problems,
      takenStepIds,
      linkedSteps: linkedSteps(db, pipelineId, compared),
      chatId: conflict.chatId,
      edits: editsSinceBase(db, pipelineId, conflict),
    },
    problem: null,
    authoritative: true,
  };
}

/**
 * The steps of the template's other boards the held version routes into,
 * as this installation holds them (EO-762): read through the map of the
 * pipeline made from each board, so a step renamed here is named by the
 * id it has here, and only where that pipeline still holds it. A step no
 * board here holds is left out — there is nothing for a draft to route
 * to — even where the comparison read the route as going to the
 * template's id, which may be some unrelated pipeline's step.
 */
function linkedSteps(db: Db, pipelineId: string, compared: PipelineComparison): UpdateConflictDetail["linkedSteps"] {
  const own = new Set(compared.nextBoard.steps.map((step) => step.id));
  const others = documentSteps(compared.template.document).filter((step) => !own.has(step.id));
  const targets = new Set(compared.next.routes.map((route) => route.target));
  const holders = templateBoardHolders(db, compared.origin.slug, getPipeline(db, pipelineId)?.projectId ?? null).filter((holder) => holder.pipelineId !== pipelineId);
  const linked: UpdateConflictDetail["linkedSteps"] = [];
  for (const step of others) {
    for (const holder of holders) {
      const id = holder.stepIds[step.id];
      if (id === undefined || !targets.has(id) || linked.some((entry) => entry.id === id)) continue;
      const held = getStep(db, id);
      if (held === undefined || held.pipelineId !== holder.pipelineId) continue;
      linked.push({ id, name: held.name, templateStepId: step.id, pipelineId: held.pipelineId, pipelineName: getPipeline(db, held.pipelineId)?.name ?? held.pipelineId });
    }
  }
  return linked;
}

/** The held template version, as the comparison takes it, or null where its snapshot can no longer be read. */
function heldTemplate(db: Db, conflict: PipelineUpdateConflict): TemplateVersion | null {
  const document = getTemplateSnapshot(db, conflict.templateId);
  if (document === null || !isTemplateDocument(document)) return null;
  return { slug: conflict.templateSlug, version: conflict.toVersion, notes: conflict.notes, document };
}

function graphView(graph: ComparableGraph<PipelineStep, StepRoute>, entryStepId: string | null): UpdateConflictGraph {
  return {
    steps: graph.steps.map((step) => PipelineStepViewSchema.parse(step)),
    routes: graph.routes.map((route) => StepRouteViewSchema.parse(route)),
    entryStepId,
  };
}

function keyChangeView(change: KeyChange, stepName: (id: string) => string): UpdateKeyChange {
  const { key } = change;
  const description =
    change.outcome === "conflict"
      ? (describeConflicts([change], stepName, "assistant")[0] ?? "")
      : key.kind === "step"
        ? `The **${stepName(key.stepId)}** step: ${changedBy(change)} ${presence(change)}.`
        : key.kind === "setting"
          ? `**${stepName(key.stepId)}**'s ${FIELD_WORDS[key.field]}: ${changedBy(change)} changed it.`
          : `**${stepName(key.fromStepId)}**'s '${key.resultKey}' route: ${changedBy(change)} ${presence(change)}.`;
  return { key, changedBy: change.outcome, base: change.base ?? null, current: change.current ?? null, template: change.template ?? null, description };
}

function changedBy(change: KeyChange): string {
  if (change.outcome === "template") return "only the template";
  if (change.outcome === "person") return "only the person";
  return "the person and the template both, to the same value,";
}

/** Whether the side that changed a step or route added it, removed it or changed it. */
function presence(change: KeyChange): string {
  const after = change.outcome === "template" ? change.template : change.current;
  if (change.base === null) return "added it";
  if (after === null) return "removed it";
  return "changed it";
}

/**
 * The versions the person filed since the base, oldest first, each with
 * what it changed from the version before it.
 *
 * Since the base means after the moment it last moved, which the origin
 * keeps (`baseMovedAt`): an applied update, an update the person had
 * already made, a conflict resolved either way — each moves it, and each
 * writes the moment with it. An origin that kept none is one recorded
 * before the moment was kept, or backfilled for a pipeline made from its
 * base long before; for those the last marker the versions themselves
 * hold is used — the version an applied update to the base's version
 * filed, or an earlier conflict at that version being resolved — and,
 * where there is none, every version counts. Versions a template update
 * filed are not the person's and are left out.
 */
export function editsSinceBase(db: Db, pipelineId: string, conflict: Pick<PipelineUpdateConflict, "id" | "templateSlug" | "fromVersion">): UpdateConflictEdit[] {
  const versions = listPipelineVersions(db, pipelineId);
  const since = baseMovedSince(db, pipelineId, conflict, versions);

  const edits: UpdateConflictEdit[] = [];
  for (const [index, version] of versions.entries()) {
    if (version.createdAt <= since.at || version.number <= since.afterNumber) continue;
    if (version.createdBy?.startsWith("template:") === true) continue;
    const previous = versions[index - 1];
    const before = previous === undefined ? undefined : versionSnapshot(db, previous.id);
    const after = versionSnapshot(db, version.id);
    edits.push({
      version: version.number,
      previousVersion: previous?.number ?? null,
      createdAt: version.createdAt,
      createdBy: version.createdBy,
      createdByName: versionAuthorName(version.createdBy, (personId) => getPerson(db, personId as Uuid)?.name ?? null),
      changes: before === undefined || after === undefined ? [] : snapshotChanges(before, after),
    });
  }
  return edits;
}

/** What the edits since the base are counted from: a moment, and a version number at or below which nothing counts. */
function baseMovedSince(
  db: Db,
  pipelineId: string,
  conflict: Pick<PipelineUpdateConflict, "id" | "templateSlug" | "fromVersion">,
  versions: readonly { number: number; createdBy: string | null }[],
): { at: number; afterNumber: number } {
  const kept = getPipelineOrigin(db, pipelineId)?.baseMovedAt ?? null;
  if (kept !== null) return { at: kept, afterNumber: 0 };
  const moved = templateUpdateAuthor(conflict.templateSlug, conflict.fromVersion);
  const appliedAt = versions.filter((version) => version.createdBy === moved).at(-1)?.number ?? 0;
  const resolvedAt = listUpdateConflicts(db, pipelineId)
    .filter((earlier) => earlier.id !== conflict.id && earlier.toVersion === conflict.fromVersion && earlier.resolvedAt !== null && earlier.resolution !== "superseded")
    .map((earlier) => earlier.resolvedAt ?? 0)
    .reduce((latest, at) => Math.max(latest, at), 0);
  return { at: resolvedAt, afterNumber: appliedAt };
}

/**
 * The step fields an edit is told by, every one a version's document
 * holds that is the person's to set: what the step is and runs, and how
 * it is tuned — inputs, time limit, keep checking, how it uses a
 * repository. Which disk it works on (`workspaceId`) is left out: an id
 * of this machine's means nothing to anybody reading the history.
 */
const EDITED_STEP_FIELDS = [
  "name",
  "type",
  "ownerRole",
  "entryAction",
  "instructionsSummary",
  "isTerminal",
  "planMode",
  "offBoard",
  "position",
  "inputs",
  "timeoutMs",
  "watch",
  "workspaceMode",
  "results",
] as const;
const EDITED_ROUTE_FIELDS = ["target", "label", "tone", "position"] as const;

/** One line per change between two versions' whole documents, each setting with its value before and after. */
function snapshotChanges(before: PipelineGraphSnapshot, after: PipelineGraphSnapshot): string[] {
  const shown = (value: unknown): string => (value === null || value === undefined ? "(none)" : typeof value === "string" ? value : JSON.stringify(value));
  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const names = new Map([...before.steps, ...after.steps].map((step) => [step.id, step.name] as const));
  const lines: string[] = [];

  const was = new Map(before.steps.map((step) => [step.id, step] as const));
  for (const step of after.steps) {
    const old = was.get(step.id);
    if (old === undefined) {
      lines.push(`Added **${step.name}**`);
      continue;
    }
    const fields = EDITED_STEP_FIELDS.filter((field) => !same(old[field], step[field])).map((field) => `${field} ${shown(old[field])} → ${shown(step[field])}`);
    if (fields.length > 0) lines.push(`Changed **${step.name}**: ${fields.join("; ")}`);
  }
  const now = new Set(after.steps.map((step) => step.id));
  for (const step of before.steps) if (!now.has(step.id)) lines.push(`Removed **${step.name}**`);

  const keyOf = (route: { fromStepId: string; resultKey: string }): string => JSON.stringify([route.fromStepId, route.resultKey]);
  const oldRoutes = new Map(before.routes.map((route) => [keyOf(route), route] as const));
  const newRoutes = new Map(after.routes.map((route) => [keyOf(route), route] as const));
  const routeName = (route: { fromStepId: string; resultKey: string }): string => `**${names.get(route.fromStepId) ?? route.fromStepId}**'s '${route.resultKey}' route`;
  for (const [key, route] of newRoutes) {
    const old = oldRoutes.get(key);
    const fields = EDITED_ROUTE_FIELDS.filter((field) => !same(old?.[field], route[field])).map((field) => `${field} ${shown(old?.[field])} → ${shown(route[field])}`);
    if (fields.length > 0) lines.push(`${old === undefined ? "Added" : "Changed"} ${routeName(route)}: ${fields.join("; ")}`);
  }
  for (const [key, route] of oldRoutes) if (!newRoutes.has(key)) lines.push(`Removed ${routeName(route)}`);
  if (!same(before.entryStepId, after.entryStepId)) lines.push(`Work enters at ${shown(names.get(after.entryStepId ?? "") ?? after.entryStepId)} (it entered at ${shown(names.get(before.entryStepId ?? "") ?? before.entryStepId)})`);
  return lines;
}

/**
 * Why a draft's `templateStepIds` cannot be believed, or null where it
 * can (EO-534).
 *
 * Each entry says a step of the published graph is a step of the held
 * template version under a fresh id. Checked against both: the template
 * has the step, the graph has the one it names, the step is not the
 * template's under its own id already, no two template steps are one
 * step, and the two are the same kind of step running the same thing —
 * so a typo cannot tell the next comparison that the person's review is
 * the template's pull-request watch.
 */
export function templateStepIdsProblem(db: Db, conflict: PipelineUpdateConflict, steps: readonly Pick<PipelineStep, "id" | "type" | "entryAction">[], map: TemplateStepIds): string | null {
  const entries = Object.entries(map);
  if (entries.length === 0) return null;
  const snapshot = getTemplateSnapshot(db, conflict.templateId);
  if (snapshot === null) return "The template version this update holds can no longer be read, so the draft's template step ids cannot be checked.";
  const origin = getPipelineOrigin(db, conflict.pipelineId);
  // This pipeline's board of it (EO-762): a draft maps the steps of the board it is.
  const document = boardDocument(snapshot, origin === null ? 0 : (sameBoard(origin.base, Object.keys(origin.stepIds), snapshot) ?? 0));
  const byId = new Map(steps.map((step) => [step.id, step] as const));
  const named = new Set<string>();
  for (const [templateStepId, stepId] of entries) {
    const template = document.steps.find((step) => step.id === templateStepId);
    if (template === undefined) return `\`templateStepIds\` names "${templateStepId}", which is not a step of the template's ${conflict.toVersion}.`;
    const step = byId.get(stepId);
    if (step === undefined) return `\`templateStepIds\` maps the template's "${templateStepId}" to "${stepId}", which is not a step of the draft.`;
    const own = origin?.stepIds[templateStepId] ?? templateStepId;
    if (own !== stepId && byId.has(own)) return `\`templateStepIds\` maps the template's "${templateStepId}" to "${stepId}", but the draft already has it as "${own}".`;
    if (named.has(stepId)) return `\`templateStepIds\` maps two template steps to "${stepId}".`;
    named.add(stepId);
    const runs = template.type === "module" && template.entryAction !== null ? (getModuleBySlug(db, template.entryAction)?.id ?? template.entryAction) : template.entryAction;
    if (template.type !== step.type || runs !== step.entryAction) {
      return `\`templateStepIds\` maps the template's "${templateStepId}" (${template.type} ${template.entryAction ?? ""}) to "${stepId}", which is a different kind of step (${step.type} ${step.entryAction ?? ""}).`;
    }
  }
  return null;
}

/**
 * Resolves a held update and moves the pipeline's base to its template
 * version, in one write (EO-534). The notice's mentions are dismissed by
 * `resolveUpdateConflict`, so the notice closes with it, and the moment
 * the base moved is kept with it — what the next update's edit history
 * counts from.
 *
 * The new base's step map is read against the pipeline as it now
 * stands: each step of the template version that this pipeline has —
 * under the id a published draft gave it (`templateStepIds`), the id the
 * old map gave it, or the template's own — maps to it, so the next
 * comparison reads the person's steps as theirs. A template step the
 * pipeline does not have has no entry, which is what an origin says of
 * a step the person removed.
 */
export function resolveHeldUpdate(
  db: Db,
  conflict: PipelineUpdateConflict,
  resolution: UpdateConflictResolution,
  options: { now?: number; templateStepIds?: TemplateStepIds } = {},
): { ok: true } | { ok: false; problem: string } {
  const document = getTemplateSnapshot(db, conflict.templateId);
  if (document === null || !isTemplateDocument(document)) {
    return { ok: false, problem: "The template version this update holds can no longer be read, so the pipeline's base cannot be moved to it." };
  }
  const now = options.now ?? Date.now();
  const previous = getPipelineOrigin(db, conflict.pipelineId)?.stepIds ?? {};
  const stepIds = stepMapFor(db, conflict.pipelineId, document, options.templateStepIds ?? {});
  db.transaction(() => {
    recordPipelineOrigin(db, { pipelineId: conflict.pipelineId, document, stepIds, baseMovedAt: now });
    // The routes the template's other boards hold for a person until this
    // pipeline had the steps they go to (EO-762): a draft that adds them
    // is where they go now, by the ids the draft gave them.
    pointRoutesWaitingOn(db, conflict.pipelineId, conflict.templateSlug, previous, stepIds, templateUpdateAuthor(conflict.templateSlug, conflict.toVersion));
    resolveUpdateConflict(db, conflict.id, resolution, now);
  });
  return { ok: true };
}

function stepMapFor(db: Db, pipelineId: string, template: TemplateDocument, published: TemplateStepIds): Record<string, string> {
  const origin = getPipelineOrigin(db, pipelineId);
  const previous = origin?.stepIds ?? {};
  // Only this pipeline's board of the template (EO-762): its base and map say which board it is, and its key finds it in this version.
  const document = boardDocument(template, origin === null ? 0 : (sameBoard(origin.base, Object.keys(previous), template) ?? 0));
  const held = new Set(listStepsForPipeline(db, pipelineId).filter((step) => !step.offBoard).map((step) => step.id));
  const map: Record<string, string> = {};
  for (const step of document.steps) {
    const id = published[step.id] ?? previous[step.id] ?? step.id;
    if (held.has(id)) map[step.id] = id;
  }
  return map;
}

/**
 * Keep my pipeline and skip this update (EO-534): what the assistant's
 * card presses. The graph is not touched; the conflict is resolved as
 * `kept` and the base moves.
 */
export function keepOwnVersion(db: Db, pipelineId: string, place: ConflictPlace = {}): IpcResponse<"pipeline:keepOwnVersion"> {
  if (updateHeldElsewhere(db, pipelineId, place)) return { kept: false, toVersion: null, problem: UPDATE_CONFLICT_ON_THE_RECORD };
  const conflict = openUpdateConflict(db, pipelineId);
  if (conflict === undefined) return { kept: false, toVersion: null, problem: noUpdateConflict(db, pipelineId, place) };
  const resolved = resolveHeldUpdate(db, conflict, "kept");
  if (!resolved.ok) return { kept: false, toVersion: null, problem: resolved.problem };
  return { kept: true, toVersion: conflict.toVersion, problem: null };
}

/** A resolution asked of the installation that holds the conflict — `record:resolveUpdateConflict`'s payload, without the device. */
export type ResolveUpdateConflictRequest = Omit<IpcPayload<"record:resolveUpdateConflict">, "deviceId">;
export type ResolveUpdateConflictAnswer = IpcResponse<"record:resolveUpdateConflict">;

/**
 * Resolves a held update on the installation that holds it, as asked
 * (EO-534) — what the organisation's record does when an admin's desktop
 * asks, and what a desktop's own record answers for one of its own.
 *
 * `kept` is `keepOwnVersion`. `published` saves the draft's graph here,
 * through `savePipeline` — so it is judged by this installation's
 * validator, its locks and its definitions, and filed as a version under
 * `createdBy` — then resolves the update with the draft's
 * `templateStepIds`. Checked first, and nothing written when any fails:
 * the update is open and is this pipeline's; the draft was published
 * from the chat Fix with assistant opened for it; its template step ids
 * are believable.
 */
export function resolveUpdateConflictHere(db: Db, request: ResolveUpdateConflictRequest, createdBy: string | null, place: ConflictPlace = {}): ResolveUpdateConflictAnswer {
  const refuse = (problem: string): ResolveUpdateConflictAnswer => ({ resolved: false, toVersion: null, version: null, problem });
  if (request.resolution === "kept") {
    const kept = keepOwnVersion(db, request.pipelineId, place);
    return kept.kept ? { resolved: true, toVersion: kept.toVersion, version: null, problem: null } : refuse(kept.problem ?? "The update could not be kept.");
  }

  if (updateHeldElsewhere(db, request.pipelineId, place)) return refuse(UPDATE_CONFLICT_ON_THE_RECORD);
  const conflict = openUpdateConflict(db, request.pipelineId);
  if (conflict === undefined) return refuse(noUpdateConflict(db, request.pipelineId, place));
  if (request.chatId === null || conflict.chatId !== request.chatId) return refuse("That draft was not raised in the chat about this template update, so publishing it does not resolve the update.");
  const graph = request.graph;
  if (graph === null) return refuse("A published draft comes with its graph, and this one came with none.");
  const unbelieved = templateStepIdsProblem(db, conflict, graph.steps, request.templateStepIds);
  if (unbelieved !== null) return refuse(unbelieved);

  const saved = savePipeline(db, undefined, { pipelineId: request.pipelineId, steps: graph.steps, routes: graph.routes, entryStepId: graph.entryStepId, ...(graph.entryRules === undefined ? {} : { entryRules: graph.entryRules }) }, undefined, { createdBy });
  if (!saved.saved) {
    const reasons = saved.problems.filter((problem) => problem.severity === "error").map((problem) => problem.message);
    return refuse(`The draft was not published: ${reasons.length > 0 ? reasons.join(" ") : "it was refused."}`);
  }
  const resolved = resolveHeldUpdate(db, conflict, "published", { templateStepIds: request.templateStepIds });
  if (!resolved.ok) return { resolved: false, toVersion: null, version: saved.version ?? null, problem: `The draft was published, and the update is still held: ${resolved.problem}` };
  return { resolved: true, toVersion: conflict.toVersion, version: saved.version ?? null, problem: null };
}
