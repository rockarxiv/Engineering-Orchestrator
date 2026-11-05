import { DEFAULT_WORKSPACE_MODE, uuidv7, type CommentOption, type MentionTarget, type PipelineExport, type PipelineStep, type StepRoute, type Uuid } from "@eo/core";
import { hasBlockingProblem, mergeThreeWay, type ComparableGraph, type ComparedStepField, type KeyChange } from "@eo/engine";
import type { Db } from "../db/client.js";
import {
  getModuleBySlug,
  getPipeline,
  getPipelineOrigin,
  getStep,
  getTemplateSnapshot,
  listPeople,
  listPipelines,
  listRoutesForPipeline,
  listStepsForPipeline,
  openUpdateConflict,
  postComment,
  projectsWithWorkOnPipeline,
  publishedSectionRow,
  recordAppliedTemplateUpdate,
  recordPipelineOrigin,
  recordUpdateConflict,
  replacePipelineGraph,
  resolveUpdateConflict,
  setUpdateConflictNotices,
  storeTemplateSnapshot,
  templateUpdateAuthor,
  updateConflictNoticed,
  type PipelineOrigin,
  type PipelineUpdateConflict,
} from "../db/repos/index.js";
import { projectMovedToTheRecord } from "../db/repos/projectsRepo.js";
import { storedGraphProblems } from "../ipc/configCommands.js";
import { openProjectThread } from "../projects/projectThread.js";
import { compareTemplateVersions, type TemplateHistory, type TemplateVersion } from "./history.js";

/**
 * Template updates reach the pipelines made from them (EO-532,
 * ARCHITECTURE.md, "Template versions and origins").
 *
 * When EO starts on a release that ships a newer version of a template,
 * every pipeline whose origin is an older version of it is compared
 * three ways — its base, the pipeline as it is now, the new version —
 * by `mergeThreeWay` in the engine. Then exactly one of:
 *
 * - **Applied.** No key conflicts and the merged graph validates: the
 *   merge is filed as a new pipeline version, its author the template
 *   update, and the pipeline's base moves to the new version. Items in
 *   flight finish on the version they entered on, as after any publish.
 *   A comment on the project thread says what changed, with the release
 *   notes, and mentions nobody — nothing is asked of anyone.
 * - **Held.** A key conflicts, or the merge does not validate: nothing
 *   is applied, not even the parts that do not conflict, and an open
 *   update conflict records the version and each conflicting key with
 *   its three values. The pipeline keeps working as it is.
 *
 * This replaces the guarded SQL migration (0114, 0123) as the way a
 * template's improvement reaches an installed pipeline. A migration
 * changed a pipeline nobody had touched without saying so, and skipped
 * one somebody had customised without saying so either.
 */

/** Where this runs, which decides which pipelines are this installation's to compare. */
export interface TemplateUpdateOptions {
  /**
   * Whether this installation is the organisation's record (the server)
   * rather than a desktop.
   *
   * A pipeline the record holds is compared on the record, once, and
   * reaches its replicas the way any publish does. A desktop never
   * compares one it follows: two desktops each filing their own merge
   * of the organisation's pipeline would be two different v7s.
   */
  isTheRecord: boolean;
  now?: number;
}

export type TemplateUpdateResult =
  | { pipelineId: string; outcome: "applied"; slug: string; from: string; to: string; version: number; changes: KeyChange[] }
  /** Nothing the template changed was left to apply — the person had made every change already — so only the base moved. */
  | { pipelineId: string; outcome: "caught-up"; slug: string; from: string; to: string }
  | { pipelineId: string; outcome: "conflict"; slug: string; from: string; to: string; conflictId: string }
  /**
   * Nothing written, and asked again on the next launch: the project
   * thread the notice goes to could not be secured — a project moving
   * to the organisation's record, say. An update applied without its
   * notice would never be announced, since the base it moves is what
   * says there is nothing left to do.
   */
  | { pipelineId: string; outcome: "deferred"; slug: string; from: string; to: string; reason: string };

/**
 * Compares and updates every pipeline this installation holds whose
 * template has shipped a newer version than its base.
 *
 * Not one pipeline's failure for another's: each is its own
 * transaction, and an update that throws is logged and left for the
 * next launch rather than stopping the rest or the app.
 */
export function applyTemplateUpdates(db: Db, history: TemplateHistory, options: TemplateUpdateOptions): TemplateUpdateResult[] {
  const results: TemplateUpdateResult[] = [];
  for (const pipeline of listPipelines(db)) {
    if (!options.isTheRecord && heldByTheRecord(db, pipeline.id)) {
      retireObsoleteHold(db, pipeline.id, options.now ?? Date.now());
      continue;
    }
    try {
      const result = updatePipeline(db, pipeline.id, history, options.now ?? Date.now(), options.isTheRecord);
      if (result !== null) results.push(result);
    } catch (error) {
      console.warn(`[eo] the template update for pipeline ${pipeline.id} could not be compared and was left for the next launch: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return results;
}

/** How a desktop's conflict is closed once its organisation's record holds the pipeline (EO-534). */
export const HELD_BY_THE_RECORD_RESOLUTION = "held by the record";

/**
 * Closes the update conflict a desktop recorded for a pipeline before its
 * organisation's record took the pipeline over (EO-534).
 *
 * Obsolete rather than open: the record compares the pipeline now, holds
 * its own conflict and posts its own notice, and that is the update the
 * assistant reads and a person resolves. Left open, the desktop's would
 * keep its own notice in the person's inbox — with a Fix with assistant
 * opening a chat about an update nobody may resolve here — and nothing
 * could ever close it. Resolving it dismisses that notice's mentions
 * (`resolveUpdateConflict`), and says why in the resolution it records.
 * The base it held is left alone: the pipeline's base is the record's.
 */
export function retireObsoleteHold(db: Db, pipelineId: string, now: number = Date.now()): boolean {
  const obsolete = openUpdateConflict(db, pipelineId);
  if (obsolete === undefined) return false;
  resolveUpdateConflict(db, obsolete.id, HELD_BY_THE_RECORD_RESOLUTION, now);
  console.log(`[eo] the ${obsolete.templateSlug} ${obsolete.toVersion} update held here for pipeline ${pipelineId} was closed: your organisation's record holds that pipeline now, and holds its updates.`);
  return true;
}

/**
 * Whether a desktop follows this pipeline from its organisation's
 * record rather than holding it.
 *
 * Two ways: the pipeline belongs to a project that was moved to the
 * record — a fact no sign-out undoes (`projectMovedToTheRecord`) — or the
 * organisation publishes the pipelines section, in which case the
 * record's graph is every desktop's graph (`upsertReplicaPipeline`).
 */
export function heldByTheRecord(db: Db, pipelineId: string): boolean {
  const projectId = getPipeline(db, pipelineId)?.projectId ?? null;
  if (projectId !== null && projectMovedToTheRecord(db, projectId)) return true;
  return publishedSectionRow(db, "pipelines") !== undefined;
}

/** The newest shipped version of a template, where it is newer than this origin's. */
export function newerTemplateVersion(origin: PipelineOrigin, history: TemplateHistory): TemplateVersion | null {
  const newest = history.get(origin.slug)?.at(-1);
  if (newest === undefined || compareTemplateVersions(newest.version, origin.version) <= 0) return null;
  return newest;
}

/** The three graphs, in this pipeline's own step ids, and how they compare. */
export interface PipelineComparison {
  origin: PipelineOrigin;
  template: TemplateVersion;
  base: ComparableGraph<PipelineStep, StepRoute>;
  current: ComparableGraph<PipelineStep, StepRoute>;
  next: ComparableGraph<PipelineStep, StepRoute>;
  merge: ReturnType<typeof mergeThreeWay<PipelineStep, StepRoute>>;
}

/**
 * Compares one pipeline with a template version, or null where it has
 * no origin.
 *
 * Both template documents are read through the origin's step map, so
 * the comparison is in this pipeline's ids: an imported pipeline's
 * `review` is a uuid, and it is that uuid the person's graph has.
 * A template step with no entry in the map keeps the template's id —
 * either a step the person removed, or one the template adds.
 */
export function compareWithTemplate(db: Db, pipelineId: string, template: TemplateVersion): PipelineComparison | null {
  const origin = getPipelineOrigin(db, pipelineId);
  if (origin === null) return null;
  const local = (id: string): string => origin.stepIds[id] ?? id;
  const base = graphOfDocument(db, pipelineId, origin.base, local);
  const next = graphOfDocument(db, pipelineId, template.document, local);
  const current: ComparableGraph<PipelineStep, StepRoute> = {
    // Off-board steps are not the graph a template describes, and a
    // publish never sees them either (`savePipeline`).
    steps: listStepsForPipeline(db, pipelineId).filter((step) => !step.offBoard),
    routes: listRoutesForPipeline(db, pipelineId),
  };
  return { origin, template, base, current, next, merge: mergeThreeWay(base, current, next) };
}

function updatePipeline(db: Db, pipelineId: string, history: TemplateHistory, now: number, isTheRecord: boolean): TemplateUpdateResult | null {
  const origin = getPipelineOrigin(db, pipelineId);
  if (origin === null) return null;
  const template = newerTemplateVersion(origin, history);
  if (template === null) return null;

  // Already held at this version: the same comparison raised again on
  // every launch would be noise. Only its notice may still be owed — a
  // conflict held before there were notices, or while nobody could be
  // told (EO-533).
  const open = openUpdateConflict(db, pipelineId);
  if (open !== undefined && open.toVersion === template.version) {
    return announceHeldUpdate(db, open, isTheRecord, { pipelineId, slug: origin.slug, from: open.fromVersion, to: open.toVersion });
  }

  const compared = compareWithTemplate(db, pipelineId, template);
  if (compared === null) return null;
  const notes = releaseNotes(history, origin, template);
  const summary = { pipelineId, slug: origin.slug, from: origin.version, to: template.version };
  const held = (outcome: HoldOutcome): TemplateUpdateResult =>
    outcome.ok ? { ...summary, outcome: "conflict", conflictId: outcome.conflictId } : { ...summary, outcome: "deferred", reason: outcome.problem };

  if (!compared.merge.ok) return held(holdUpdate(db, compared, notes, compared.merge.comparison.conflicts, [], now, isTheRecord));

  const taken = compared.merge.comparison.changes.filter((change) => change.outcome === "template");
  const { steps, routes, stepIds } = placeMerge(db, compared, compared.merge.merged);

  if (taken.length === 0) {
    db.transaction(() => {
      recordPipelineOrigin(db, { pipelineId, document: template.document, stepIds });
      if (open !== undefined) resolveUpdateConflict(db, open.id, "superseded", now);
    });
    return { ...summary, outcome: "caught-up" };
  }

  const entryStepId = getPipeline(db, pipelineId)?.entryStepId ?? null;
  const problems = storedGraphProblems(db, pipelineId, steps, routes, entryStepId);
  if (hasBlockingProblem(problems)) {
    const messages = problems.filter((problem) => problem.severity === "error").map((problem) => problem.message);
    return held(holdUpdate(db, compared, notes, [], messages, now, isTheRecord));
  }

  // Where the notice goes, secured before anything is written. A thread
  // that cannot be opened now defers the whole update rather than
  // applying it unannounced: the base it moves is what tells the next
  // launch there is nothing to do, so a notice missed here is missed
  // for good.
  const threads = noticeThreads(db, pipelineId, isTheRecord);
  if (!threads.ok) return { ...summary, outcome: "deferred", reason: threads.problem };

  const preserved = listStepsForPipeline(db, pipelineId).filter((step) => step.offBoard);
  const kept = compared.merge.comparison.changes.some((change) => change.outcome === "person");
  // The graph, the origin and the notice in one transaction: an update
  // is never applied without being announced, nor announced without
  // being applied.
  const written = db.transaction(() => {
    const replaced = replacePipelineGraph(
      db,
      pipelineId,
      [...steps, ...preserved].map(({ ownerPersonId: _person, ownerGroupId: _group, ...step }) => step),
      routes.map(({ id: _id, ...route }) => route),
      { createdBy: templateUpdateAuthor(origin.slug, template.version) },
    );
    if (!replaced.replaced) return replaced;
    recordPipelineOrigin(db, { pipelineId, document: template.document, stepIds });
    // What the pipeline's head says for a few days (EO-536), kept here
    // rather than read from the version just filed, which a save may prune.
    recordAppliedTemplateUpdate(db, pipelineId, { version: template.version, pipelineVersion: replaced.version, at: now });
    if (open !== undefined) resolveUpdateConflict(db, open.id, "superseded", now);
    const body = updateNoticeBody(db, pipelineId, { compared, taken, kept, version: replaced.version, notes });
    // Nothing is asked of anyone, so nobody is summoned.
    for (const thread of threads.itemIds) postComment(db, { itemId: thread, author: { type: "engine" }, kind: "note", body, mentions: [], parseBodyMentions: false });
    return replaced;
  });
  if (!written.replaced) {
    // The validator refuses removing a step that holds items; this is
    // the repository's guard under it, answering the same thing.
    const messages = written.holding.map((hold) => `"${hold.stepName}" still holds ${hold.count} item(s), and the update removes it.`);
    return held(holdUpdate(db, compared, notes, [], messages, now, isTheRecord));
  }

  if (threads.itemIds.length === 0) {
    console.log(`[eo] pipeline ${pipelineId} was updated to ${origin.slug} ${template.version} (v${written.version}); no project has work on it, so no project thread was told.`);
  }
  return { ...summary, outcome: "applied", version: written.version, changes: taken };
}

type HoldOutcome = { ok: true; conflictId: string } | { ok: false; problem: string };

/**
 * Records the held update, closing an older one it supersedes, and tells
 * the person (EO-533). Answers the new row's id.
 *
 * The notice is one comment on each project thread the update concerns
 * (`noticeThreads`): it mentions the person — on the organisation's
 * record, its admins — so it is in their inbox, names the pipeline, the
 * template and both versions, lists what conflicts in plain words, and
 * has exactly one button, Fix with assistant (`conflictNoticeOptions`).
 *
 * Secured before anything is written, and written in one transaction
 * with the row, for the reason an applied update's notice is: an open
 * conflict at this version is what tells the next launch there is
 * nothing to compare, so a conflict recorded without its notice would
 * never be announced. A thread that cannot be opened now defers the
 * whole hold to the next launch instead.
 *
 * Never twice for one version: where this pipeline's update to this
 * version was already announced (`updateConflictNoticed`), the row is
 * recorded and nobody is told again.
 */
function holdUpdate(
  db: Db,
  compared: PipelineComparison,
  notes: string,
  conflicts: KeyChange[],
  problems: string[],
  now: number,
  isTheRecord: boolean,
): HoldOutcome {
  const pipelineId = compared.origin.pipelineId;
  const noticed = updateConflictNoticed(db, pipelineId, compared.template.version);
  const threads = noticed ? ({ ok: true, itemIds: [] } as const) : noticeThreads(db, pipelineId, isTheRecord);
  if (!threads.ok) return { ok: false, problem: threads.problem };

  const conflictId = db.transaction(() => {
    const older = openUpdateConflict(db, pipelineId);
    if (older !== undefined) resolveUpdateConflict(db, older.id, "superseded", now);
    const templateId = storeTemplateSnapshot(db, compared.template.document);
    const id = uuidv7() as string;
    const noticeCommentIds = postConflictNotices(db, threads.itemIds, id, isTheRecord, {
      pipelineId,
      title: compared.template.document.template.title,
      fromVersion: compared.origin.version,
      toVersion: compared.template.version,
      notes,
      conflicts,
      problems,
      stepName: comparisonStepNames(db, compared),
    });
    return recordUpdateConflict(
      db,
      {
        pipelineId,
        templateSlug: compared.origin.slug,
        fromVersion: compared.origin.version,
        toVersion: compared.template.version,
        baseId: compared.origin.baseId,
        templateId,
        notes,
        conflicts,
        problems,
        noticeCommentIds,
      },
      now,
      id,
    ).id;
  });
  if (!noticed && threads.itemIds.length === 0) {
    console.log(`[eo] the ${compared.origin.slug} ${compared.template.version} update to pipeline ${pipelineId} is held; no project has work on it, so no project thread was told.`);
  }
  return { ok: true, conflictId };
}

/** The notice on each thread, one comment apiece, each mentioning the person (`conflictNoticeMentions`). Answers their ids. */
function postConflictNotices(db: Db, itemIds: readonly Uuid[], conflictId: string, isTheRecord: boolean, facts: ConflictNoticeFacts): string[] {
  const body = conflictNoticeBody(db, facts);
  const options = conflictNoticeOptions(conflictId);
  const mentions = conflictNoticeMentions(db, isTheRecord);
  return itemIds.map((itemId) => postComment(db, { itemId, author: { type: "engine" }, kind: "note", body, options, mentions, parseBodyMentions: false }).id as string);
}

/**
 * Tells the person about a held update nobody was told about yet
 * (EO-533), on a launch that finds it still open.
 *
 * Two ways a conflict is held unannounced. It was recorded before
 * notices existed — every conflict EO-532 held, which migration 0136
 * gave an empty notice list — or, when it was held, its pipeline had no
 * project and no work on any, so there was no thread to tell. Either
 * way the notice is posted now, once a thread is there, built from what
 * the conflict recorded; a thread that cannot be opened now leaves it
 * for the next launch, as a fresh hold would be.
 *
 * Never a second notice: a conflict that has one, or whose pipeline was
 * already told about this version, is left alone.
 */
function announceHeldUpdate(db: Db, conflict: PipelineUpdateConflict, isTheRecord: boolean, summary: Omit<Extract<TemplateUpdateResult, { outcome: "conflict" }>, "outcome" | "conflictId">): TemplateUpdateResult | null {
  if (conflict.noticeCommentIds.length > 0 || updateConflictNoticed(db, conflict.pipelineId, conflict.toVersion)) return null;
  const threads = noticeThreads(db, conflict.pipelineId, isTheRecord);
  if (!threads.ok) return { ...summary, outcome: "deferred", reason: threads.problem };
  if (threads.itemIds.length === 0) return null;
  db.transaction(() => {
    const ids = postConflictNotices(db, threads.itemIds, conflict.id, isTheRecord, {
      pipelineId: conflict.pipelineId,
      title: getTemplateSnapshot(db, conflict.templateId)?.template?.title ?? conflict.templateSlug,
      fromVersion: conflict.fromVersion,
      toVersion: conflict.toVersion,
      notes: conflict.notes,
      conflicts: conflict.conflicts,
      problems: conflict.problems,
      stepName: conflictStepNames(db, conflict),
    });
    setUpdateConflictNotices(db, conflict.id, ids);
  });
  return { ...summary, outcome: "conflict", conflictId: conflict.id };
}

/** The label of the conflict notice's one button. */
export const FIX_WITH_ASSISTANT = "Fix with assistant";

/** The conflict notice's options: exactly one, an action that opens the conflict's assistant chat, never an answer. */
export function conflictNoticeOptions(conflictId: string): CommentOption[] {
  return [{ kind: "open", label: FIX_WITH_ASSISTANT, opens: { type: "updateConflictChat", conflictId } }];
}

/**
 * Who the conflict notice asks (EO-533).
 *
 * On a desktop, the person: `{ type: "human" }`, which `postComment`
 * resolves to whoever this machine is. On the organisation's record —
 * where a pipeline the record holds is compared — the organisation's
 * admins, each by name, since a server has no person of its own to put
 * it in front of. A record with no admin yet falls back to the same
 * unnamed person rather than telling nobody.
 */
function conflictNoticeMentions(db: Db, isTheRecord: boolean): MentionTarget[] {
  if (!isTheRecord) return [{ type: "human" }];
  const admins = listPeople(db).filter((person) => person.isAdmin);
  return admins.length > 0 ? admins.map((person) => ({ type: "human", personId: person.id })) : [{ type: "human" }];
}

/** Who a conflict is described to: the person it is about, or the assistant asked to resolve it for them. */
export type ConflictReader = "person" | "assistant";

/**
 * What conflicts, one plain sentence per key — "Merge Request's 'opened'
 * route: …" — with the three values in the pipeline's own step names.
 *
 * Told to the person ("you have it going to …") in the notice, and about
 * them ("the person has it going to …") in the assistant's brief.
 */
export function describeConflicts(conflicts: readonly KeyChange[], stepName: (id: string) => string, reader: ConflictReader): string[] {
  const they = reader === "person" ? "you" : "the person";
  const targetName = (target: unknown): string => {
    if (target === "user_attention") return "a person";
    if (target === "terminal") return "the end";
    if (typeof target !== "string") return "nowhere";
    return `**${stepName(target)}**`;
  };
  const routeSide = (value: unknown): string => (value === null || value === undefined ? "nowhere (no such route)" : targetName(fieldOf(value, "target")));
  const removedOr = (value: unknown, removed: string, changed: string): string => (value === null || value === undefined ? removed : changed);
  return conflicts.map((change) => {
    const { key } = change;
    if (key.kind === "route") {
      return (
        `**${stepName(key.fromStepId)}**'s '${key.resultKey}' route: it went to ${routeSide(change.base)}; ` +
        `${they} ${reader === "person" ? "have" : "has"} it going to ${routeSide(change.current)}; the template sends it to ${routeSide(change.template)}.`
      );
    }
    if (key.kind === "setting") return `**${stepName(key.stepId)}**'s ${FIELD_WORDS[key.field]}: ${they} and the template both changed it, differently.`;
    return `The **${stepName(key.stepId)}** step: ${they} ${removedOr(change.current, "removed it", "changed it")}, and the template ${removedOr(change.template, "removes it", "changes it")}.`;
  });
}

/** Step names for a comparison's three graphs, the person's own names first. */
function comparisonStepNames(db: Db, compared: PipelineComparison): (id: string) => string {
  const names = new Map<string, string>();
  for (const step of [...compared.current.steps, ...compared.base.steps, ...compared.next.steps]) if (!names.has(step.id)) names.set(step.id, step.name);
  return (id) => names.get(id) ?? getStep(db, id)?.name ?? id;
}

/**
 * Step names for a recorded conflict, read back after the fact: the
 * pipeline's steps as they are now, then the held template version's,
 * read through the origin's step map into this pipeline's ids.
 */
export function conflictStepNames(db: Db, conflict: PipelineUpdateConflict): (id: string) => string {
  const names = new Map<string, string>();
  for (const step of listStepsForPipeline(db, conflict.pipelineId)) names.set(step.id, step.name);
  const stepIds = getPipelineOrigin(db, conflict.pipelineId)?.stepIds ?? {};
  for (const step of getTemplateSnapshot(db, conflict.templateId)?.steps ?? []) {
    const id = stepIds[step.id] ?? step.id;
    if (!names.has(id)) names.set(id, step.name);
  }
  return (id) => names.get(id) ?? getStep(db, id)?.name ?? id;
}

/** The conflict notice's text. */
interface ConflictNoticeFacts {
  pipelineId: string;
  /** The template's title, as the gallery shows it. */
  title: string;
  fromVersion: string;
  toVersion: string;
  notes: string;
  conflicts: readonly KeyChange[];
  problems: readonly string[];
  stepName: (id: string) => string;
}

function conflictNoticeBody(db: Db, facts: ConflictNoticeFacts): string {
  const { conflicts, problems, notes } = facts;
  const name = getPipeline(db, facts.pipelineId)?.name ?? "A pipeline";
  const lines = [
    `**${name}** could not take the *${facts.title}* template's update from ${facts.fromVersion} to ${facts.toVersion}. ` +
      `Nothing from it was applied, and the pipeline keeps working exactly as it is.`,
  ];
  if (conflicts.length > 0) {
    lines.push("", "You and the template both changed the same things:", ...describeConflicts(conflicts, facts.stepName, "person").map((line) => `- ${line}`));
  }
  if (problems.length > 0) lines.push("", "The merged pipeline would not be valid:", ...problems.map((problem) => `- ${problem}`));
  if (notes !== "") lines.push("", "Release notes:", ...notes.split("\n").map((line) => `- ${line}`));
  lines.push("", `**${FIX_WITH_ASSISTANT}** opens a chat in which the assistant compares the versions and proposes drafts. Nothing changes until you publish one or keep your own.`);
  return lines.join("\n");
}

/**
 * The merged graph as rows to write: step ids this installation can
 * hold, positions in board order, and the new step map.
 *
 * A step the template adds keeps the template's id where nothing here
 * has it — EO's own Delivery is the template by id, and its new step
 * should be `pull_request_watch` like everybody else's. Where another
 * pipeline already has that id (step ids are global), it gets a fresh
 * one, and the routes are re-pointed with it.
 */
function placeMerge(db: Db, compared: PipelineComparison, merged: { steps: PipelineStep[]; routes: StepRoute[] }): { steps: PipelineStep[]; routes: StepRoute[]; stepIds: Record<string, string> } {
  const pipelineId = compared.origin.pipelineId;
  const before = new Set(compared.current.steps.map((step) => step.id));
  const renamed = new Map<string, string>();
  for (const step of merged.steps) {
    if (before.has(step.id)) continue;
    const holder = getStep(db, step.id);
    if (holder !== undefined && holder.pipelineId !== pipelineId) renamed.set(step.id, uuidv7());
  }
  const placed = (id: string): string => renamed.get(id) ?? id;
  const added = merged.steps.some((step) => !before.has(step.id)) || merged.steps.length !== compared.current.steps.length;

  const steps = merged.steps.map((step, index) => ({ ...step, id: placed(step.id), pipelineId: pipelineId as Uuid, position: added ? index : step.position }));
  // A route's source is always a step here. Its target is re-pointed
  // only where the template supplied it: a route of the person's that
  // hands work to another pipeline's step of the same id must still go
  // there.
  const theirs = new Map(compared.current.routes.map((route) => [JSON.stringify([route.fromStepId, route.resultKey]), route.target]));
  const routes = merged.routes.map((route) => {
    const kept = theirs.get(JSON.stringify([route.fromStepId, route.resultKey])) === route.target;
    return { ...route, pipelineId: pipelineId as Uuid, fromStepId: placed(route.fromStepId), target: kept ? route.target : placed(route.target) };
  });

  // Every template step this pipeline now has, mapped to its id here.
  const local = (id: string): string => placed(compared.origin.stepIds[id] ?? id);
  const held = new Set(steps.map((step) => step.id));
  const stepIds: Record<string, string> = {};
  for (const step of compared.template.document.steps) {
    const id = local(step.id);
    if (held.has(id)) stepIds[step.id] = id;
  }
  return { steps, routes, stepIds };
}

/**
 * A template document's graph, as this pipeline's rows would hold it.
 *
 * What a document leaves out is filled in as an import fills it in — no
 * inputs, EO's time limit, the default workspace mode — so the base and
 * the template agree with each other on it, and a value the person set
 * reads as theirs. A module step names its module by slug in a
 * document, and by id here.
 */
function graphOfDocument(db: Db, pipelineId: string, document: PipelineExport, local: (id: string) => string): ComparableGraph<PipelineStep, StepRoute> {
  const steps: PipelineStep[] = [...document.steps]
    .sort((a, b) => a.position - b.position)
    .map((step) => ({
      ...step,
      id: local(step.id),
      pipelineId: pipelineId as Uuid,
      entryAction: step.type === "module" && step.entryAction !== null ? (getModuleBySlug(db, step.entryAction)?.id ?? step.entryAction) : step.entryAction,
      inputs: {},
      timeoutMs: null,
      workspaceMode: DEFAULT_WORKSPACE_MODE,
      workspaceId: null,
      offBoard: false,
      ownerPersonId: null,
      ownerGroupId: null,
    }));
  const routes: StepRoute[] = document.routes.map((route) => ({
    ...route,
    id: uuidv7(),
    pipelineId: pipelineId as Uuid,
    fromStepId: local(route.fromStepId),
    target: local(route.target),
  }));
  return { steps, routes };
}

/** The release notes of every version after the base, up to and including the new one. */
function releaseNotes(history: TemplateHistory, origin: PipelineOrigin, template: TemplateVersion): string {
  const versions = (history.get(origin.slug) ?? []).filter(
    (version) => compareTemplateVersions(version.version, origin.version) > 0 && compareTemplateVersions(version.version, template.version) <= 0,
  );
  return versions.map((version) => `${version.version}: ${version.notes}`).join("\n");
}

export const FIELD_WORDS: Record<ComparedStepField, string> = {
  type: "kind of step",
  entryAction: "what it runs",
  ownerRole: "owner",
  watch: "keep checking",
  inputs: "inputs",
  timeoutMs: "time limit",
  results: "results",
};

interface UpdateNotice {
  compared: PipelineComparison;
  taken: KeyChange[];
  kept: boolean;
  version: number;
  notes: string;
}

/** The sentences a notice lists, one per change the template made. */
export function describeTemplateChanges(db: Db, compared: PipelineComparison, taken: readonly KeyChange[]): string[] {
  const names = new Map<string, string>();
  for (const step of [...compared.current.steps, ...compared.next.steps]) if (!names.has(step.id)) names.set(step.id, step.name);
  const stepName = (id: string): string => names.get(id) ?? id;
  const targetName = (target: unknown): string => {
    if (target === "user_attention") return "a person";
    if (target === "terminal") return "the end";
    if (typeof target !== "string") return "nowhere";
    return names.has(target) ? `**${stepName(target)}**` : (`**${getStep(db, target)?.name ?? target}**`);
  };
  return taken.map((change) => {
    const { key } = change;
    if (key.kind === "step") return change.template === null ? `Removed **${stepName(key.stepId)}**.` : `Added **${stepName(key.stepId)}**.`;
    if (key.kind === "setting") return `**${stepName(key.stepId)}**: ${FIELD_WORDS[key.field]} changed.`;
    const label = routeLabel(change);
    const from = `**${stepName(key.fromStepId)}** → *${label}*`;
    if (change.template === null) return `${from} no longer routes anywhere.`;
    const to = targetName(fieldOf(change.template, "target"));
    if (change.current === null) return `${from} goes to ${to}.`;
    const was = fieldOf(change.current, "target");
    return was === fieldOf(change.template, "target") ? `${from} is relabelled.` : `${from} now goes to ${to} (it went to ${targetName(was)}).`;
  });
}

/** The notice's text: what changed, whether the person's own changes were kept, and the release notes. */
function updateNoticeBody(db: Db, pipelineId: string, notice: UpdateNotice): string {
  const { compared } = notice;
  const name = getPipeline(db, pipelineId)?.name ?? "A pipeline";
  const title = compared.template.document.template.title;
  const lines = [
    `**${name}** was updated from the *${title}* template ${compared.origin.version} to ${compared.template.version}, as v${notice.version}. ` +
      `Items already on it finish on the version they entered on.`,
    "",
    "What changed:",
    ...describeTemplateChanges(db, compared, notice.taken).map((line) => `- ${line}`),
  ];
  if (notice.kept) lines.push("", "Your own changes to this pipeline were kept.");
  if (notice.notes !== "") lines.push("", "Release notes:", ...notice.notes.split("\n").map((line) => `- ${line}`));
  return lines.join("\n");
}

/**
 * The project threads an applied update is announced on, each opened
 * (made, if it has none yet) — or why one could not be.
 *
 * The thread of the project that owns the pipeline; for one no project
 * has adopted, of each project with work on it. On a desktop, a project
 * moved to the organisation's record is the record's to post on, and is
 * left out. Every one must open: an update announced on some of its
 * threads and not others would leave a project never told.
 */
function noticeThreads(db: Db, pipelineId: string, isTheRecord: boolean): { ok: true; itemIds: Uuid[] } | { ok: false; problem: string } {
  const pipeline = getPipeline(db, pipelineId);
  if (pipeline === undefined) return { ok: false, problem: "the pipeline no longer exists" };
  const projects = (pipeline.projectId !== null ? [pipeline.projectId as Uuid] : projectsWithWorkOnPipeline(db, pipelineId).filter((id): id is Uuid => id !== null)).filter(
    (projectId) => isTheRecord || !projectMovedToTheRecord(db, projectId),
  );
  const itemIds: Uuid[] = [];
  for (const projectId of projects) {
    const thread = openProjectThread(db, projectId);
    if (!thread.ok) return { ok: false, problem: thread.problem };
    itemIds.push(thread.item.id as Uuid);
  }
  return { ok: true, itemIds };
}

function fieldOf(value: unknown, field: string): unknown {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>)[field] : undefined;
}

function routeLabel(change: KeyChange): string {
  const label = fieldOf(change.template, "label") ?? fieldOf(change.current, "label") ?? fieldOf(change.base, "label");
  return typeof label === "string" ? label : change.key.kind === "route" ? change.key.resultKey : "";
}

/**
 * EO's brief: the first message of the chat Fix with assistant opens
 * (EO-533), addressed to the assistant.
 *
 * Everything the assistant needs to start without the person typing:
 * the pipeline's name and id, the template and both versions, the
 * release notes, and what conflicts. Then what to do — read the details
 * with the comparison tool and propose drafts — and the one thing never
 * to do, which is apply one. The tool is named without any backend's
 * spelling of it (invariant 12): each backend advertises it in its own.
 */
export function updateConflictBrief(db: Db, conflict: PipelineUpdateConflict): string {
  const pipeline = getPipeline(db, conflict.pipelineId);
  const name = pipeline?.name ?? conflict.pipelineId;
  const title = getTemplateSnapshot(db, conflict.templateId)?.template?.title ?? conflict.templateSlug;
  const lines = [
    `Resolve the held template update to the pipeline "${name}".`,
    "",
    `- Pipeline: ${name} (id: ${conflict.pipelineId})`,
    `- Template: ${title} (${conflict.templateSlug}), from version ${conflict.fromVersion} (the pipeline's base) to version ${conflict.toVersion}`,
  ];
  lines.push("", "Release notes:", ...(conflict.notes === "" ? ["- (none)"] : conflict.notes.split("\n").map((line) => `- ${line}`)));
  if (conflict.conflicts.length > 0) {
    lines.push(
      "",
      "Conflicting keys — the person and the template both changed each, differently:",
      ...describeConflicts(conflict.conflicts, conflictStepNames(db, conflict), "assistant").map((line) => `- ${line}`),
    );
  }
  if (conflict.problems.length > 0) lines.push("", "The automatic merge would not be valid:", ...conflict.problems.map((problem) => `- ${problem}`));
  lines.push(
    "",
    `Read the details with the pipeline_update_conflict tool for pipeline id ${conflict.pipelineId}: the base, the person's current pipeline and the new template version, ` +
      "every changed key with its three values, and the person's own edits since the base. " +
      "Then propose up to three alternative drafts of this pipeline on the ordinary draft card, the one you recommend first, " +
      "each saying in one line what it keeps from the person's version and from the template's. " +
      "Never apply anything: nothing changes until the person publishes a draft or keeps their own pipeline.",
  );
  return lines.join("\n");
}
