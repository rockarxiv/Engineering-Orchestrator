import {
  boardDocument,
  boardHolding,
  DEFAULT_WORKSPACE_MODE,
  documentBoards,
  documentSteps,
  MODULE_ENTRY_RULE_KIND,
  sameBoard,
  TERMINAL_TARGET,
  USER_ATTENTION_TARGET,
  uuidv7,
  type CommentOption,
  type PipelineExport,
  type PipelineStep,
  type StepRoute,
  type Uuid,
} from "@eo/core";
import { mergeThreeWay, type ComparableGraph, type ComparedStepField, type KeyChange } from "@eo/engine";
import type { Db } from "../db/client.js";
import {
  createPipeline,
  getModuleBySlug,
  getPipeline,
  getPipelineOrigin,
  getStep,
  getSetting,
  getTemplateSnapshot,
  listPipelines,
  listRoutesForPipeline,
  listStepsForPipeline,
  openUpdateConflict,
  projectsWithWorkOnPipeline,
  publishedSectionRow,
  recordAppliedTemplateUpdate,
  recordPipelineOrigin,
  recordUpdateConflict,
  replacePipelineGraph,
  resolveUpdateConflict,
  setSetting,
  setUpdateConflictNotices,
  SHARED_UNTIL_SPLIT_SETTING,
  storeTemplateSnapshot,
  templateBoardHolders,
  templateUpdateAuthor,
  updateConflictNoticed,
  type PipelineOrigin,
  type PipelineUpdateConflict,
  type TemplateDocument,
} from "../db/repos/index.js";
import { TEMPLATE_CONFLICT_SOURCE } from "../db/repos/pipelineUpdateConflictsRepo.js";
import { projectMovedToTheRecord } from "../db/repos/projectsRepo.js";
import { storedGraphProblems } from "../ipc/configCommands.js";
import { sendMessageHere } from "../messages/messages.js";
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
 *   Nothing is posted (EO-728): nothing is asked of anyone. The version
 *   keeps the release notes, and the pipeline's version list shows them.
 * - **Held.** A key conflicts, or the merge does not validate: nothing
 *   is applied, not even the parts that do not conflict, and an open
 *   update conflict records the version and each conflicting key with
 *   its three values. The pipeline keeps working as it is. A message
 *   asks the person to resolve it, with Fix with assistant (EO-727).
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
  | { pipelineId: string; outcome: "conflict"; slug: string; from: string; to: string; conflictId: string };

/**
 * Compares and updates every pipeline this installation holds whose
 * template has shipped a newer version than its base.
 *
 * Not one installation's failure for another's: the boards one project
 * holds of one template are compared and written together, in one
 * transaction (EO-762), and an update that throws is logged and left for
 * the next launch rather than stopping the rest or the app.
 */
export function applyTemplateUpdates(db: Db, history: TemplateHistory, options: TemplateUpdateOptions): TemplateUpdateResult[] {
  const now = options.now ?? Date.now();
  // The boards a newer version adds, first (EO-762): before any board of
  // the same template is compared, so an update that routes into one
  // finds its steps — and whether or not that update is then held, so a
  // person resolving it has them to route into.
  const created = createAddedBoards(db, history, options.isTheRecord, now);
  // A route on a board just made that waits for a step the update to
  // another of its boards adds is pointed at it when that update applies
  // (`pointRoutesWaitingOn`), on this launch or whenever it is resolved.
  const installations = new Map<string, string[]>();
  for (const pipeline of listPipelines(db)) {
    if (!options.isTheRecord && heldByTheRecord(db, pipeline.id)) {
      retireObsoleteHold(db, pipeline.id, now);
      continue;
    }
    if (created.some((board) => board.pipelineId === pipeline.id)) continue;
    const slug = getPipelineOrigin(db, pipeline.id)?.slug;
    if (slug === undefined) continue;
    const key = JSON.stringify([slug, pipeline.projectId]);
    installations.set(key, [...(installations.get(key) ?? []), pipeline.id]);
  }
  const results: TemplateUpdateResult[] = [];
  for (const pipelineIds of installations.values()) {
    try {
      results.push(...updateInstallation(db, pipelineIds, history, now, options.isTheRecord, created));
    } catch (error) {
      console.warn(`[eo] the template update for pipelines ${pipelineIds.join(", ")} could not be compared and was left for the next launch: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return results;
}

/** A board EO made for a template's newer version (EO-762). */
export interface CreatedBoard {
  pipelineId: string;
  name: string;
  slug: string;
  version: string;
  projectId: string | null;
  /**
   * Its routes into a step of another of the template's boards that the
   * project does not hold yet — one the update to that board adds, where
   * that update is held. Each waits until it is pointed: an agent's or a
   * builtin's result for a person, and a person's decision (`decision`)
   * by not being offered.
   */
  waiting: { fromStepId: string; resultKey: string; templateTarget: string; decision: boolean }[];
}

/**
 * Makes, for every project holding a template, the boards a newer
 * version of it adds (EO-762).
 *
 * One installation of a template is the pipelines made from it in one
 * project (`templateBoardHolders`), archived ones included. A board of
 * the newest version is made where none of their bases had a board of
 * its key: a board one of them is was in its base, and a board the
 * template had before, which somebody deleted, is theirs to have deleted
 * and is not made again. The first board is never made here.
 *
 * Made whether or not the update to the template's other boards will
 * then apply — before they are compared, so an update whose routes go
 * into the new board finds its steps, and a person resolving a held one
 * has them to route into. Each project's boards in their own
 * transaction, and one that fails is logged and left for the next launch.
 */
function createAddedBoards(db: Db, history: TemplateHistory, isTheRecord: boolean, now: number): CreatedBoard[] {
  const installations = new Map<string, { slug: string; projectId: string | null; origins: PipelineOrigin[] }>();
  for (const pipeline of listPipelines(db)) {
    if (!isTheRecord && heldByTheRecord(db, pipeline.id)) continue;
    const origin = getPipelineOrigin(db, pipeline.id);
    if (origin === null) continue;
    const key = JSON.stringify([origin.slug, pipeline.projectId]);
    const installation = installations.get(key) ?? { slug: origin.slug, projectId: pipeline.projectId, origins: [] };
    installation.origins.push(origin);
    installations.set(key, installation);
  }

  const created: CreatedBoard[] = [];
  for (const { slug, projectId, origins } of installations.values()) {
    const newest = history.get(slug)?.at(-1);
    if (newest === undefined || !origins.some((origin) => compareTemplateVersions(newest.version, origin.version) > 0)) continue;
    // Every base of the installation, an archived board's included, so a board somebody archived is not made again.
    const bases = templateBoardHolders(db, slug, projectId).flatMap((holder) => {
      const origin = getPipelineOrigin(db, holder.pipelineId);
      return origin === null ? [] : [origin.base];
    });
    const known = new Set(bases.flatMap((base) => documentBoards(base).map((board) => board.key)));
    const added = documentBoards(newest.document)
      .map((board, index) => ({ board, index }))
      .filter(({ board, index }) => index > 0 && board.steps.length > 0 && !known.has(board.key))
      .map(({ index }) => index);
    if (added.length === 0) continue;
    try {
      created.push(
        ...db.transaction(() => {
          const boards = createTemplateBoards(db, newest.document, added, projectId, {
            createdBy: templateUpdateAuthor(slug, newest.version),
            releaseNotes: `Created by the ${newest.document.template.title} template's ${newest.version} update, which adds this board.`,
            now,
          });
          shareWhileUnsplit(db, projectId, origins, boards);
          return boards;
        }),
      );
    } catch (error) {
      console.warn(`[eo] the boards the ${slug} ${newest.version} template adds could not be made and are left for the next launch: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return created;
}

/**
 * Keeps a board made for a still-shared installation as reachable as the
 * installation itself (EO-766 review).
 *
 * Where the split that gives every project its own pipelines failed at
 * this launch, the pipelines it was splitting stay shared among every
 * project (`SHARED_UNTIL_SPLIT_SETTING`) until a later launch splits
 * them. A board an update adds to such an installation has no project
 * either, so it is shared the same way, or no project could open it or
 * hand work to it; the next split takes it with the rest, and each
 * project's copy of it is routed to by that project's copy of the others.
 */
function shareWhileUnsplit(db: Db, projectId: string | null, origins: readonly PipelineOrigin[], boards: readonly CreatedBoard[]): void {
  if (projectId !== null || boards.length === 0) return;
  const unsplit = getSetting<string[]>(db, SHARED_UNTIL_SPLIT_SETTING, []);
  if (!origins.some((origin) => unsplit.includes(origin.pipelineId))) return;
  setSetting(db, SHARED_UNTIL_SPLIT_SETTING, [...unsplit, ...boards.map((board) => board.pipelineId).filter((id) => !unsplit.includes(id))]);
}

/**
 * Makes these boards of a template document as pipelines in this
 * project, in one transaction, each remembering the document as its
 * base (EO-762). What a template update does with the boards a version
 * adds, and what using a template does with the boards beside a
 * pipeline it adopted rather than imported.
 *
 * A step keeps the template's id where no pipeline here has it — as a
 * step a template update adds does (`placeMerge`) — and gets a fresh one
 * where another does. A route into another of the template's boards
 * goes to that step as this project holds it, read through the map of
 * the pipeline made from that board. Where the project does not hold it
 * — the step is one the held update to that board adds — the route
 * waits, and says so in `waiting`, rather than naming a step that is in
 * no pipeline, where an item would stop with nothing said. An agent's or
 * a builtin's result waits for a person (`user_attention`), which parks
 * the item and asks. A person's decision cannot: routed to a person it
 * would be a button that leaves the item where it stands, which the
 * validator refuses and `items:decide` refuses every time it is pressed.
 * So the step does not offer it — neither the result nor its route —
 * until the step it goes to is there (`pointRoutesWaitingOn`). Every
 * button the board does offer works.
 */
export function createTemplateBoards(
  db: Db,
  document: TemplateDocument,
  indexes: readonly number[],
  projectId: string | null,
  version: { createdBy: string | null; releaseNotes: string | null; now?: number },
): CreatedBoard[] {
  const boards = documentBoards(document);
  const making = indexes.flatMap((index) => {
    const board = boards[index];
    return board === undefined ? [] : [{ index, board }];
  });
  const fresh = new Map<string, string>();
  const claimed = new Set<string>();
  for (const { board } of making) {
    for (const step of board.steps) {
      const id = getStep(db, step.id) === undefined && !claimed.has(step.id) ? step.id : (uuidv7() as string);
      fresh.set(step.id, id);
      claimed.add(id);
    }
  }
  const elsewhere = new Map<string, string>();
  for (const holder of templateBoardHolders(db, document.template.slug, projectId)) {
    for (const [templateId, id] of Object.entries(holder.stepIds)) if (!elsewhere.has(templateId) && getStep(db, id) !== undefined) elsewhere.set(templateId, id);
  }
  const target = (id: string): string | null => (id === USER_ATTENTION_TARGET || id === TERMINAL_TARGET ? id : (fresh.get(id) ?? elsewhere.get(id) ?? null));
  const moduleId = (slug: string): string => getModuleBySlug(db, slug)?.id ?? slug;

  return db.transaction(() =>
    making.map(({ index, board }) => {
      const pipeline = createPipeline(db, { projectId: projectId as Uuid | null, name: board.pipeline.name, icon: board.pipeline.icon, position: (version.now ?? Date.now()) + index });
      const waiting: CreatedBoard["waiting"] = [];
      const routes = board.routes.flatMap((route) => {
        const to = target(route.target);
        const fromStepId = fresh.get(route.fromStepId) ?? route.fromStepId;
        if (to !== null) return [{ ...route, pipelineId: pipeline.id, fromStepId, target: to }];
        const decision = board.steps.find((step) => step.id === route.fromStepId)?.type === "user";
        waiting.push({ fromStepId, resultKey: route.resultKey, templateTarget: route.target, decision });
        return decision ? [] : [{ ...route, pipelineId: pipeline.id, fromStepId, target: USER_ATTENTION_TARGET }];
      });
      const withheld = (stepId: string, key: string): boolean => waiting.some((route) => route.decision && route.fromStepId === stepId && route.resultKey === key);
      const written = replacePipelineGraph(
        db,
        pipeline.id,
        board.steps.map((step) => {
          const id = fresh.get(step.id) ?? step.id;
          return {
            ...step,
            id,
            pipelineId: pipeline.id,
            entryAction: step.type === "module" && step.entryAction !== null ? moduleId(step.entryAction) : step.entryAction,
            results: step.results.filter((result) => !withheld(id, result.key)),
            offBoard: false,
          };
        }),
        routes,
        {
          entryStepId: board.pipeline.entryStepId === null ? null : (fresh.get(board.pipeline.entryStepId) ?? null),
          entryRules: board.pipeline.entryRules.map((rule) => (rule.kind === MODULE_ENTRY_RULE_KIND && rule.module !== undefined ? { ...rule, module: moduleId(rule.module) } : rule)),
          createdBy: version.createdBy,
          releaseNotes: version.releaseNotes,
        },
      );
      if (!written.replaced) throw new Error(`A freshly created pipeline refused its graph: ${written.holding.map((hold) => hold.stepId).join(", ")}`);
      recordPipelineOrigin(db, { pipelineId: pipeline.id, document, stepIds: Object.fromEntries(board.steps.map((step) => [step.id, fresh.get(step.id) ?? step.id])) });
      return { pipelineId: pipeline.id, name: board.pipeline.name, slug: document.template.slug, version: document.template.version, projectId, waiting };
    }),
  );
}

/**
 * Points the routes that wait for a step of this pipeline's board at it,
 * now that the board has it (EO-762).
 *
 * A board EO makes for a template's new version may route into a step the
 * update to another of its boards adds, and while that update is held the
 * step is in no pipeline: an agent's or a builtin's result waits for a
 * person (`user_attention`), and a person's decision is not offered at all
 * (`createTemplateBoards`). Nothing about that is kept apart from what the
 * origins already say, so it survives a restart and a move to the record
 * alike: the waiting board's base routes the result to the template step,
 * this pipeline's map did not hold that step before (`previous`) and does
 * now (`next`), and the board as it is either still sends the result to a
 * person, or — a decision — neither offers it nor routes it. Each such
 * route is pointed at the step as this pipeline holds it, a withheld
 * decision is offered again as the template words it, and the board files
 * a version by the template update.
 *
 * Called wherever a pipeline's map moves: an update applied or caught up
 * on a launch, and a held one resolved, the step map then being the
 * published draft's. A route somebody pointed elsewhere meanwhile is
 * theirs and stays. One that goes to a person as the template says it
 * should is not one of these: its template target is no step.
 */
export function pointRoutesWaitingOn(db: Db, pipelineId: string, slug: string, previous: Readonly<Record<string, string>>, next: Readonly<Record<string, string>>, createdBy: string): void {
  const gained = new Map(Object.entries(next).filter(([templateId, id]) => previous[templateId] !== id && getStep(db, id)?.pipelineId === pipelineId));
  if (gained.size === 0) return;
  const projectId = getPipeline(db, pipelineId)?.projectId ?? null;
  for (const holder of templateBoardHolders(db, slug, projectId)) {
    if (holder.pipelineId === pipelineId) continue;
    const origin = getPipelineOrigin(db, holder.pipelineId);
    const index = origin === null ? null : boardHolding(origin.base, Object.keys(origin.stepIds));
    if (origin === null || index === null) continue;
    const based = documentBoards(origin.base)[index]!;
    const steps = listStepsForPipeline(db, holder.pipelineId).map(({ ownerPersonId: _person, ownerGroupId: _group, ...step }) => step);
    const routes = listRoutesForPipeline(db, holder.pipelineId).map(({ id: _id, ...route }) => route);
    let changed = false;
    for (const route of based.routes) {
      const to = gained.get(route.target);
      const from = origin.stepIds[route.fromStepId];
      if (to === undefined || from === undefined) continue;
      const current = routes.find((each) => each.fromStepId === from && each.resultKey === route.resultKey);
      if (current !== undefined) {
        if (current.target !== USER_ATTENTION_TARGET) continue;
        current.target = to;
        changed = true;
        continue;
      }
      // A decision withheld until its step was there: offered again, as the template words it.
      const step = steps.find((each) => each.id === from);
      const result = based.steps.find((each) => each.id === route.fromStepId)?.results.find((each) => each.key === route.resultKey);
      if (step === undefined || step.type !== "user" || result === undefined || step.results.some((each) => each.key === route.resultKey)) continue;
      step.results = [...step.results, result];
      routes.push({ pipelineId: holder.pipelineId as Uuid, fromStepId: from, resultKey: route.resultKey, label: route.label, tone: route.tone, target: to, position: route.position });
      changed = true;
    }
    if (!changed) continue;
    replacePipelineGraph(db, holder.pipelineId, steps, routes, {
      createdBy,
      releaseNotes: `Pointed the routes that waited for ${getPipeline(db, pipelineId)?.name ?? "another board"} at the steps its template update added.`,
    });
  }
}

/** How a desktop's conflict is closed once its organisation's record holds the pipeline (EO-534). */
export const HELD_BY_THE_RECORD_RESOLUTION = "held by the record";

/**
 * Closes the update conflict a desktop recorded for a pipeline before its
 * organisation's record took the pipeline over (EO-534).
 *
 * Obsolete rather than open: the record compares the pipeline now, holds
 * its own conflict and sends its own notice, and that is the update the
 * assistant reads and a person resolves. Left open, the desktop's would
 * keep its own message in the person's inbox — with a Fix with assistant
 * opening a chat about an update nobody may resolve here — and nothing
 * could ever close it. Resolving it marks that notice's messages resolved
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
  /**
   * This pipeline's board of the base and of the new version, each as a
   * document of one board (EO-762). Where the template has one board,
   * that board; where it has several, the one this pipeline's step map
   * names (`boardHolding`).
   */
  baseBoard: PipelineExport;
  nextBoard: TemplateDocument;
  /** The new version's step ids as this installation holds them: this board's through the origin's map, the template's other boards' through theirs. */
  nextLocal: (id: string) => string;
}

/**
 * Compares one pipeline with a template version, or null where it has
 * no origin, or its board of the template cannot be told or is gone
 * from that version (EO-762).
 *
 * `nextSiblings` is the template's other boards' steps as this project
 * will hold them once the boards updated with this one are written
 * (`updateInstallation`); the new version's routes into them are read
 * through it. Absent, they are read as the project holds them now. The
 * base is always read as they are now: it is what the person's routes
 * are compared with.
 *
 * Both template documents are read through the origin's step map, so
 * the comparison is in this pipeline's ids: an imported pipeline's
 * `review` is a uuid, and it is that uuid the person's graph has.
 * A template step with no entry in the map keeps the template's id —
 * either a step the person removed, or one the template adds.
 */
export function compareWithTemplate(db: Db, pipelineId: string, template: TemplateVersion, nextSiblings?: ReadonlyMap<string, string>): PipelineComparison | null {
  const origin = getPipelineOrigin(db, pipelineId);
  if (origin === null) return null;
  // Which board it is, read of its base and followed into the new
  // version by key (EO-762); nothing to compare where either cannot say,
  // or the new version no longer has its board.
  const held = Object.keys(origin.stepIds);
  const baseIndex = boardHolding(origin.base, held);
  const nextIndex = sameBoard(origin.base, held, template.document);
  if (baseIndex === null || nextIndex === null) return null;
  const baseBoard = boardDocument(origin.base, baseIndex);
  const nextBoard = boardDocument(template.document, nextIndex);
  const nextLocal = installedStepIds(db, origin, template.document, nextIndex, nextSiblings);
  const base = graphOfDocument(db, pipelineId, baseBoard, installedStepIds(db, origin, origin.base, baseIndex));
  const next = graphOfDocument(db, pipelineId, nextBoard, nextLocal);
  const current: ComparableGraph<PipelineStep, StepRoute> = {
    // Off-board steps are not the graph a template describes, and a
    // publish never sees them either (`savePipeline`).
    steps: listStepsForPipeline(db, pipelineId).filter((step) => !step.offBoard),
    routes: listRoutesForPipeline(db, pipelineId),
  };
  return { origin, template, base, current, next, merge: mergeThreeWay(base, current, next), baseBoard, nextBoard, nextLocal };
}

/**
 * A template document's step ids as this installation holds them, for
 * the pipeline made from one of its boards (EO-762).
 *
 * A step of the pipeline's own board through its origin's map, as
 * always; a step the map does not name is one the person removed, or
 * one the template adds, and keeps the template's id. A step of another
 * of the template's boards through the map of the pipeline made from
 * that board in the same project — which may hold it under another id,
 * renamed because the template's was taken or re-minted by an import —
 * so a route between boards is compared with where it actually goes.
 * `siblings`, where given, is that map instead (`compareWithTemplate`).
 */
export function installedStepIds(db: Db, origin: PipelineOrigin, document: PipelineExport, board: number, siblings?: ReadonlyMap<string, string>): (id: string) => string {
  const own = new Set((documentBoards(document)[board] ?? documentBoards(document)[0]!).steps.map((step) => step.id));
  const elsewhere = siblings ?? siblingStepIds(db, origin.slug, origin.pipelineId, own);
  return (id) => origin.stepIds[id] ?? (own.has(id) ? id : (elsewhere.get(id) ?? id));
}

/** The step maps of the other pipelines made from this template in this pipeline's project, leaving out this board's own steps. */
function siblingStepIds(db: Db, slug: string, pipelineId: string, own: ReadonlySet<string>): Map<string, string> {
  const projectId = getPipeline(db, pipelineId)?.projectId ?? null;
  const ids = new Map<string, string>();
  for (const holder of templateBoardHolders(db, slug, projectId)) {
    if (holder.pipelineId === pipelineId) continue;
    for (const [templateId, id] of Object.entries(holder.stepIds)) if (!own.has(templateId) && !ids.has(templateId)) ids.set(templateId, id);
  }
  return ids;
}

/** A pipeline whose template has a newer version to compare it with, on this launch. */
interface Candidate {
  pipelineId: string;
  origin: PipelineOrigin;
  template: TemplateVersion;
  /** An update held at an older version, which this one supersedes. */
  open: PipelineUpdateConflict | undefined;
}

/** A candidate compared, merged and placed, ready to be judged and written. */
interface Prepared {
  candidate: Candidate;
  compared: PipelineComparison;
  /** The template's changes it takes; none is only its base moving. */
  taken: KeyChange[];
  steps: PipelineStep[];
  routes: StepRoute[];
  stepIds: Record<string, string>;
  entryStepId: string | null;
  /** The template's other boards' steps as the batch leaves them, in this project's ids. */
  siblings: ReadonlyMap<string, string>;
}

/**
 * Updates the boards one project holds of one template, together
 * (EO-762).
 *
 * A board's new version may route into a step the new version of another
 * of them adds, and may stop routing into one the other removes. Compared
 * one at a time against the database, either would be held for nothing
 * but the order: the step it routes into is not there yet, or the route
 * it stops taking is still there. So every board due an update is
 * compared reading the others' steps as their updates will leave them
 * (`plannedStepIds`), judged with the others' graphs as they will be
 * written (`storedGraphProblems`' `alongside`), and the boards that pass
 * are written in one transaction. A board that is held — a conflict, a
 * merge that does not validate, or a step it removes still holding items
 * — leaves the batch, and the rest are compared again without it, its
 * steps as they are now: a board whose new routes go into a step only the
 * held one adds is held too, and its notice says which.
 */
function updateInstallation(db: Db, pipelineIds: readonly string[], history: TemplateHistory, now: number, isTheRecord: boolean, created: readonly CreatedBoard[]): TemplateUpdateResult[] {
  const results: TemplateUpdateResult[] = [];
  let batch: Candidate[] = [];
  for (const pipelineId of pipelineIds) {
    const origin = getPipelineOrigin(db, pipelineId);
    if (origin === null) continue;
    const template = newerTemplateVersion(origin, history);
    if (template === null) continue;
    // Already held at this version: the same comparison raised again on
    // every launch would be noise. Only its notice may still be owed — a
    // conflict held before there were notices, or while nobody could be
    // told (EO-533).
    const open = openUpdateConflict(db, pipelineId);
    if (open !== undefined && open.toVersion === template.version) {
      const announced = announceHeldUpdate(db, open, isTheRecord, { pipelineId, slug: origin.slug, from: open.fromVersion, to: open.toVersion }, now);
      if (announced !== null) results.push(announced);
      continue;
    }
    batch.push({ pipelineId, origin, template, open });
  }

  // The ids given to steps whose template id another pipeline holds, kept
  // across rounds, so a board and the routes into it agree on one.
  const minted = new Map<string, string>();
  const summaryOf = (candidate: Candidate) => ({ pipelineId: candidate.pipelineId, slug: candidate.origin.slug, from: candidate.origin.version, to: candidate.template.version });
  const notesOf = (candidate: Candidate): { notes: string; madeHere: CreatedBoard[] } => {
    // The boards of this template made on this launch for this project
    // (EO-762), which the update — applied or held — names.
    const projectId = getPipeline(db, candidate.pipelineId)?.projectId ?? null;
    const madeHere = created.filter((board) => board.slug === candidate.origin.slug && board.projectId === projectId);
    const notes = [releaseNotes(history, candidate.origin, candidate.template), ...madeHere.map((board) => `Created the ${board.name} board this version adds.`)].filter((line) => line !== "").join("\n");
    return { notes, madeHere };
  };
  const hold = (prepared: Pick<Prepared, "candidate" | "compared">, conflicts: KeyChange[], problems: string[]): void => {
    const { notes, madeHere } = notesOf(prepared.candidate);
    const conflictId = holdUpdate(db, prepared.compared, notes, conflicts, problems, now, isTheRecord, madeHere);
    results.push({ ...summaryOf(prepared.candidate), outcome: "conflict", conflictId });
  };

  while (batch.length > 0) {
    const planned = plannedStepIds(db, batch, minted);
    // Compared and merged. A board whose comparison cannot be made, or
    // whose merge conflicts, leaves the batch before anything is judged,
    // since the others read its steps as its update would leave them.
    const prepared: Prepared[] = [];
    const leaving = new Set<string>();
    for (const candidate of batch) {
      const siblings = nextSiblingStepIds(db, candidate, planned);
      const compared = compareWithTemplate(db, candidate.pipelineId, candidate.template, siblings);
      if (compared === null) {
        leaving.add(candidate.pipelineId);
        continue;
      }
      if (!compared.merge.ok) {
        hold({ candidate, compared }, compared.merge.comparison.conflicts, []);
        leaving.add(candidate.pipelineId);
        continue;
      }
      const placed = placeMerge(db, compared, compared.merge.merged, (id) => mintedId(minted, candidate.pipelineId, id));
      const entryStepId = mergedEntryStep(compared, getPipeline(db, candidate.pipelineId)?.entryStepId ?? null, placed.stepIds);
      prepared.push({ candidate, compared, taken: compared.merge.comparison.changes.filter((change) => change.outcome === "template"), ...placed, entryStepId, siblings });
    }
    if (leaving.size > 0) {
      batch = batch.filter((candidate) => !leaving.has(candidate.pipelineId));
      continue;
    }

    // Judged, each with the others as they will be written.
    const alongside = new Map(prepared.map((each) => [each.candidate.pipelineId, { steps: each.steps, routes: each.routes }]));
    for (const each of prepared) {
      if (each.taken.length === 0) continue;
      const problems = [...unheldLinks(db, each), ...storedGraphProblems(db, each.candidate.pipelineId, each.steps, each.routes, each.entryStepId, alongside).filter((problem) => problem.severity === "error").map((problem) => problem.message)];
      if (problems.length === 0) continue;
      hold(each, [], problems);
      leaving.add(each.candidate.pipelineId);
    }
    if (leaving.size > 0) {
      batch = batch.filter((candidate) => !leaving.has(candidate.pipelineId));
      continue;
    }

    const written = writeInstallation(db, prepared, notesOf, now);
    if ("refused" in written) {
      // The validator refuses removing a step that holds items; this is
      // the repository's guard under it, answering the same thing.
      hold(written.refused, [], written.messages);
      batch = batch.filter((candidate) => candidate.pipelineId !== written.refused.candidate.pipelineId);
      continue;
    }
    results.push(
      ...written.applied.map(({ prepared: each, version }): TemplateUpdateResult =>
        version === null ? { ...summaryOf(each.candidate), outcome: "caught-up" } : { ...summaryOf(each.candidate), outcome: "applied", version, changes: each.taken },
      ),
    );
    break;
  }
  return results;
}

/** A replacement the repository refused, which rolls the whole batch back. */
class RefusedReplacement extends Error {
  constructor(
    readonly prepared: Prepared,
    readonly messages: string[],
  ) {
    super("a template update's graph was refused");
  }
}

/**
 * Writes a batch of boards' updates in one transaction (EO-762): each
 * graph, its release notes and its origin — the version an update files
 * always says what the update was (EO-728) — then the routes on other
 * boards that waited for a step one of them added. A board with nothing
 * left to take only has its base moved. Where the repository refuses a
 * graph, nothing of the batch is written, and that board is answered.
 */
function writeInstallation(
  db: Db,
  prepared: readonly Prepared[],
  notesOf: (candidate: Candidate) => { notes: string },
  now: number,
): { applied: { prepared: Prepared; version: number | null }[] } | { refused: Prepared; messages: string[] } {
  try {
    return db.transaction(() => {
      const applied = prepared.map((each) => {
        const { pipelineId, origin, template, open } = each.candidate;
        const author = templateUpdateAuthor(origin.slug, template.version);
        let version: number | null = null;
        if (each.taken.length > 0) {
          const { notes } = notesOf(each.candidate);
          const preserved = listStepsForPipeline(db, pipelineId).filter((step) => step.offBoard);
          const replaced = replacePipelineGraph(
            db,
            pipelineId,
            [...each.steps, ...preserved].map(({ ownerPersonId: _person, ownerGroupId: _group, ...step }) => step),
            each.routes.map(({ id: _id, ...route }) => route),
            { entryStepId: each.entryStepId, createdBy: author, releaseNotes: notes === "" ? null : notes },
          );
          if (!replaced.replaced) throw new RefusedReplacement(each, replaced.holding.map((hold) => `"${hold.stepName}" still holds ${hold.count} item(s), and the update removes it.`));
          version = replaced.version;
          // What the pipeline's head says for a few days (EO-536), kept here
          // rather than read from the version just filed, which a save may prune.
          recordAppliedTemplateUpdate(db, pipelineId, { version: template.version, pipelineVersion: replaced.version, at: now });
        }
        recordPipelineOrigin(db, { pipelineId, document: template.document, stepIds: each.stepIds });
        if (open !== undefined) resolveUpdateConflict(db, open.id, "superseded", now);
        return { prepared: each, version };
      });
      // Once every board of the batch has its steps.
      for (const each of prepared) {
        const { pipelineId, origin, template } = each.candidate;
        pointRoutesWaitingOn(db, pipelineId, origin.slug, origin.stepIds, each.stepIds, templateUpdateAuthor(origin.slug, template.version));
      }
      return { applied };
    });
  } catch (error) {
    if (error instanceof RefusedReplacement) return { refused: error.prepared, messages: error.messages };
    throw error;
  }
}

/**
 * The step ids each board of a batch will hold once its update is
 * written, by template step (EO-762): its map's where it has the step,
 * the template's where nothing else holds that id, and otherwise the id
 * minted for it — which `placeMerge` gives the step itself. Its new
 * version's steps only: a step it drops is not there to route into.
 */
function plannedStepIds(db: Db, batch: readonly Candidate[], minted: Map<string, string>): Map<string, Map<string, string>> {
  const planned = new Map<string, Map<string, string>>();
  for (const { pipelineId, origin, template } of batch) {
    const index = sameBoard(origin.base, Object.keys(origin.stepIds), template.document);
    if (index === null) continue;
    const ids = new Map<string, string>();
    for (const step of documentBoards(template.document)[index]!.steps) {
      const holder = getStep(db, step.id);
      ids.set(step.id, origin.stepIds[step.id] ?? (holder === undefined || holder.pipelineId === pipelineId ? step.id : mintedId(minted, pipelineId, step.id)));
    }
    planned.set(pipelineId, ids);
  }
  return planned;
}

/** The fresh id for a template step on one board, the same one every time it is asked for. */
function mintedId(minted: Map<string, string>, pipelineId: string, templateStepId: string): string {
  const key = JSON.stringify([pipelineId, templateStepId]);
  const id = minted.get(key) ?? (uuidv7() as string);
  minted.set(key, id);
  return id;
}

/** The template's other boards' steps as this project holds them once the batch is written: a board in the batch as planned, any other as it is. */
function nextSiblingStepIds(db: Db, candidate: Candidate, planned: ReadonlyMap<string, ReadonlyMap<string, string>>): Map<string, string> {
  const projectId = getPipeline(db, candidate.pipelineId)?.projectId ?? null;
  const ids = new Map<string, string>();
  for (const holder of templateBoardHolders(db, candidate.origin.slug, projectId)) {
    if (holder.pipelineId === candidate.pipelineId) continue;
    for (const [templateId, id] of planned.get(holder.pipelineId) ?? Object.entries(holder.stepIds)) if (!ids.has(templateId)) ids.set(templateId, id);
  }
  return ids;
}

/**
 * The routes of the merged board into a step of another of the template's
 * boards that this project will not hold (EO-762) — the update to that
 * board adds it and is held, or somebody removed the step or the board —
 * each said as a problem. Asked apart from the validator, because the
 * route names the template's id, and another pipeline may hold a step of
 * that id that has nothing to do with this template.
 */
function unheldLinks(db: Db, prepared: Prepared): string[] {
  const { compared, routes, stepIds, siblings } = prepared;
  const boards = documentBoards(compared.template.document);
  const own = new Set(compared.nextBoard.steps.map((step) => step.id));
  return compared.nextBoard.routes.flatMap((route) => {
    if (own.has(route.target) || siblings.has(route.target)) return [];
    const board = boards.find((each) => each.steps.some((step) => step.id === route.target));
    const from = stepIds[route.fromStepId];
    if (board === undefined || from === undefined || !routes.some((each) => each.fromStepId === from && each.resultKey === route.resultKey && each.target === route.target)) return [];
    const target = board.steps.find((step) => step.id === route.target)!;
    const source = getStep(db, from)?.name ?? compared.nextBoard.steps.find((step) => step.id === route.fromStepId)?.name ?? from;
    return [
      `"${route.label}" out of "${source}" goes to "${target.name}" on ${board.pipeline.name}, which ${board.pipeline.name} does not have here: the update that adds it was not applied, or the step was removed. ` +
        `Resolve ${board.pipeline.name}'s update first, or point the route elsewhere.`,
    ];
  });
}

/**
 * Records the held update, closing an older one it supersedes, and tells
 * the person (EO-533, EO-727). Answers the new row's id.
 *
 * The notice is a message about each project the update concerns
 * (`noticeProjects`), to the person — on the organisation's record, to
 * each admin (`sendMessageHere`) — so it is in their inbox. It names the
 * pipeline, the template and both versions, lists what conflicts in
 * plain words, and has exactly one button, Fix with assistant
 * (`conflictNoticeOptions`). Its subject is the conflict, so resolving
 * the conflict resolves it (`resolveUpdateConflict`).
 *
 * Written in one transaction with the row, for the reason an applied
 * update's notice is: an open conflict at this version is what tells the
 * next launch there is nothing to compare, so a conflict recorded
 * without its notice would never be announced.
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
  created: readonly CreatedBoard[] = [],
): string {
  const pipelineId = compared.origin.pipelineId;
  const noticed = updateConflictNoticed(db, pipelineId, compared.template.version);
  const projects = noticed ? [] : noticeProjects(db, pipelineId, isTheRecord);

  const conflictId = db.transaction(() => {
    const older = openUpdateConflict(db, pipelineId);
    if (older !== undefined) resolveUpdateConflict(db, older.id, "superseded", now);
    const templateId = storeTemplateSnapshot(db, compared.template.document);
    const id = uuidv7() as string;
    const noticeIds = sendConflictNotices(db, projects, id, isTheRecord, now, {
      pipelineId,
      title: compared.template.document.template.title,
      fromVersion: compared.origin.version,
      toVersion: compared.template.version,
      notes,
      conflicts,
      problems,
      stepName: comparisonStepNames(db, compared),
      // Only the routes that wait on this board's update are this notice's to name.
      created: created.map((board) => ({ ...board, waiting: board.waiting.filter((route) => compared.nextBoard.steps.some((step) => step.id === route.templateTarget)) })),
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
        noticeIds,
      },
      now,
      id,
    ).id;
  });
  if (!noticed && projects.length === 0) {
    console.log(`[eo] the ${compared.origin.slug} ${compared.template.version} update to pipeline ${pipelineId} is held; no project has work on it, so nobody was told.`);
  }
  return conflictId;
}

/** The notice: one message about each project, with Fix with assistant, its subject the conflict. Answers their ids. */
function sendConflictNotices(db: Db, projectIds: readonly Uuid[], conflictId: string, isTheRecord: boolean, now: number, facts: ConflictNoticeFacts): string[] {
  if (projectIds.length === 0) return [];
  const body = conflictNoticeBody(db, facts);
  const options = conflictNoticeOptions(conflictId);
  return projectIds.flatMap((projectId) =>
    sendMessageHere(db, { projectId, source: TEMPLATE_CONFLICT_SOURCE, subject: conflictId, body, options }, isTheRecord, now).map((message) => message.id),
  );
}

/**
 * Tells the person about a held update nobody was told about yet
 * (EO-533), on a launch that finds it still open.
 *
 * Two ways a conflict is held unannounced. It was recorded before
 * notices existed — every conflict EO-532 held, which migration 0136
 * gave an empty notice list — or, when it was held, its pipeline had no
 * project and no work on any, so there was nobody's project to say it
 * about. Either way the notice is sent now, once there is one, built
 * from what the conflict recorded.
 *
 * Never a second notice: a conflict that has one, or whose pipeline was
 * already told about this version, is left alone.
 */
function announceHeldUpdate(db: Db, conflict: PipelineUpdateConflict, isTheRecord: boolean, summary: Omit<Extract<TemplateUpdateResult, { outcome: "conflict" }>, "outcome" | "conflictId">, now: number): TemplateUpdateResult | null {
  if (conflict.noticeIds.length > 0 || updateConflictNoticed(db, conflict.pipelineId, conflict.toVersion)) return null;
  const projects = noticeProjects(db, conflict.pipelineId, isTheRecord);
  if (projects.length === 0) return null;
  db.transaction(() => {
    const ids = sendConflictNotices(db, projects, conflict.id, isTheRecord, now, {
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
  const snapshot = getTemplateSnapshot(db, conflict.templateId);
  // Every board's steps (EO-762): a held update may route into another of the template's boards.
  for (const step of snapshot === null ? [] : documentSteps(snapshot)) {
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
  /** The boards this version adds, made for this pipeline's project on this launch (EO-762). */
  created?: readonly CreatedBoard[];
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
  for (const board of facts.created ?? []) {
    const routes = board.waiting.filter((route) => !route.decision);
    const decisions = board.waiting.filter((route) => route.decision);
    lines.push(
      "",
      `EO created the **${board.name}** board, which this version adds, so its steps are there to route into while you resolve this.` +
        (routes.length === 0
          ? ""
          : ` ${routes.map((route) => `Its '${route.resultKey}' route`).join(", ")} ${routes.length === 1 ? "waits" : "wait"} for a person until this update is resolved: ` +
            `${routes.length === 1 ? "it goes" : "they go"} to a step this update adds.`) +
        (decisions.length === 0
          ? ""
          : ` ${decisions.map((route) => `'${route.resultKey}'`).join(", ")} ${decisions.length === 1 ? "is" : "are"} not offered on it until this update is resolved: ` +
            `${decisions.length === 1 ? "that decision goes" : "those decisions go"} to a step this update adds.`),
    );
  }
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
 * one (`mint`, which a batch of boards shares, so the routes into it from
 * the others name the same one), and the routes are re-pointed with it.
 */
function placeMerge(
  db: Db,
  compared: PipelineComparison,
  merged: { steps: PipelineStep[]; routes: StepRoute[] },
  mint: (templateStepId: string) => string = () => uuidv7(),
): { steps: PipelineStep[]; routes: StepRoute[]; stepIds: Record<string, string> } {
  const pipelineId = compared.origin.pipelineId;
  const before = new Set(compared.current.steps.map((step) => step.id));
  const renamed = new Map<string, string>();
  for (const step of merged.steps) {
    if (before.has(step.id)) continue;
    const holder = getStep(db, step.id);
    if (holder !== undefined && holder.pipelineId !== pipelineId) renamed.set(step.id, mint(step.id));
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
  for (const step of compared.nextBoard.steps) {
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
      // A document carries no module pin (EO-770); the save chooses one.
      moduleVersion: null,
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

/**
 * Where work enters the merged pipeline: the new version's entry step,
 * as the merge placed it, where the person left the base's where it was
 * and the pipeline holds the new one; otherwise the pipeline's own.
 *
 * Needed once a version may replace every step of a board (EO-762): the
 * board's old entry step goes with the rest, and a merge that kept
 * pointing at it would not validate.
 */
function mergedEntryStep(compared: PipelineComparison, current: string | null, stepIds: Readonly<Record<string, string>>): string | null {
  const based = compared.baseBoard.pipeline.entryStepId;
  const base = based === null ? null : (compared.origin.stepIds[based] ?? null);
  const wanted = compared.nextBoard.pipeline.entryStepId;
  const next = wanted === null ? null : (stepIds[wanted] ?? null);
  return current === base && next !== null ? next : current;
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

/**
 * The projects an update is told about (EO-533): the project that owns
 * the pipeline; for one no project has adopted, each project with work
 * on it. On a desktop, a project moved to the organisation's record is
 * the record's to tell about, and is left out. None for a pipeline that
 * is gone.
 */
function noticeProjects(db: Db, pipelineId: string, isTheRecord: boolean): Uuid[] {
  const pipeline = getPipeline(db, pipelineId);
  if (pipeline === undefined) return [];
  return (pipeline.projectId !== null ? [pipeline.projectId as Uuid] : projectsWithWorkOnPipeline(db, pipelineId).filter((id): id is Uuid => id !== null)).filter(
    (projectId) => isTheRecord || !projectMovedToTheRecord(db, projectId),
  );
}

function fieldOf(value: unknown, field: string): unknown {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>)[field] : undefined;
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
