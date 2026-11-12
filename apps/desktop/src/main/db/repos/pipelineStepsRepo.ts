import { and, asc, count, eq, inArray, isNotNull, isNull, ne } from "drizzle-orm";
import { DEFAULT_WORKSPACE_MODE, EntryRulesSchema, PreviewItemSchema, StepInputsSchema, StepResultsSchema, WorkspaceModeSchema, uuidv7 } from "@eo/core";
import type { EntryRule, IncomingHandOff, Pipeline, PipelineStep, PipelineStepType, PreviewItem, StepHoldingItems, StepInputs, StepResult, StepRoute, StepWatch, Uuid, WorkspaceMode } from "@eo/core";
import type { Db } from "../client.js";
import { pipelines, pipelineSteps, stepRoutes, items } from "../schema.js";
// A cycle with `pipelineVersionsRepo`, and a deliberate one: the graph
// needs the version it is retiring a step out of, and a version is a
// snapshot of the graph. Both directions are function calls made after
// both modules have loaded, which is what makes it safe.
import { catchUpCurrentVersion, createPipelineVersion, ensureCurrentVersion, pipelineVersionsToKeep, prunePipelineVersions, setCurrentVersion } from "./pipelineVersionsRepo.js";

function toStep(row: typeof pipelineSteps.$inferSelect): PipelineStep {
  return {
    id: row.id,
    pipelineId: row.pipelineId as Uuid,
    position: row.position,
    name: row.name,
    type: row.type as PipelineStepType,
    ownerRole: row.ownerRole,
    entryAction: row.entryAction,
    instructionsSummary: row.instructionsSummary,
    isTerminal: row.isTerminal,
    planMode: row.planMode,
    // Parsed rather than cast, for `inputs`' reason one field down: the
    // column is open text, and a value no version of EO ever wrote is
    // not a mode this one can honour. `isolated` is the honest answer —
    // the same one a step that has never been touched gives.
    workspaceMode: WorkspaceModeSchema.safeParse(row.workspaceMode).data ?? DEFAULT_WORKSPACE_MODE,
    // Straight off the row, unparsed, because there is nothing to parse
    // it against (EO-301): the legal values are every workspace id in
    // this installation plus one sentinel, and a schema that knew them
    // would have to read the database. An id whose row has gone is
    // `resolveItemWorkspace`'s to answer for, which it does by falling
    // back to the ticket's workspace exactly as an unset pick does.
    workspaceId: row.workspaceId,
    offBoard: row.offBoard,
    // Straight off the row for `workspaceId`'s reason (EO-302): it is an
    // id, and the only thing that could validate it is the `people`
    // table. `owner_group_id` is mapped beside it since EO-323, when
    // there came to be a `groups` table for it to name and a column head
    // that reads it.
    ownerPersonId: row.ownerPersonId as Uuid | null,
    ownerGroupId: row.ownerGroupId,
    // Parsed rather than cast (EO-78). The column is JSON somebody could
    // have written by hand, and a blob that is not a map of scalars is
    // not a configuration EO can honour — reading it as one would hand a
    // module an array where it declared a number. Nothing configured is
    // the honest answer, and `moduleInputProblems` still refuses anything
    // scalar-but-wrong that survives this.
    inputs: StepInputsSchema.safeParse(row.inputs).data ?? {},
    timeoutMs: row.timeoutMs,
    // Both columns or neither (EO-456): an interval with no give-up time
    // is a row nothing wrote, and reading it as "runs once" is the
    // answer that cannot surprise anybody with checks they never asked
    // for.
    watch: watchOf(row),
    // Parsed rather than cast for `inputs`' reason (EO-310): the column
    // is JSON, and a blob that is not a list of results is not a
    // decision EO can put in front of anybody. Nothing declared is the
    // honest answer — the same one every human step gave before a
    // person could decide at all — and a step showing no buttons is a
    // step that waits, which is what it always did.
    results: StepResultsSchema.safeParse(row.results).data ?? [],
  };
}

/** The columns a step's keep-checking settings live in (EO-456, EO-571). */
type WatchColumns = { watchEveryMinutes: number | null; watchGiveUpHours: number | null; watchNeverGivesUp: boolean };

/**
 * The step's keep-checking settings off its columns, or null for a step
 * that runs once (EO-456).
 *
 * The run-once answer is still the two numeric columns alone: the flag
 * (EO-571) says how a watch ends, not whether there is one, so a step
 * whose hours are NULL runs once whatever it says. `neverGivesUp` is
 * present only when set, so a step that gives up reads back exactly as it
 * did before the flag existed.
 */
export function watchOf(row: WatchColumns): StepWatch | null {
  const { watchEveryMinutes: everyMinutes, watchGiveUpHours: giveUpAfterHours } = row;
  if (everyMinutes === null || giveUpAfterHours === null) return null;
  return row.watchNeverGivesUp ? { everyMinutes, giveUpAfterHours, neverGivesUp: true } : { everyMinutes, giveUpAfterHours };
}

/** The columns a step's keep-checking settings are written to (EO-456, EO-571). */
export function watchColumns(watch: StepWatch | null): WatchColumns {
  return { watchEveryMinutes: watch?.everyMinutes ?? null, watchGiveUpHours: watch?.giveUpAfterHours ?? null, watchNeverGivesUp: watch?.neverGivesUp === true };
}

function toRoute(row: typeof stepRoutes.$inferSelect): StepRoute {
  return {
    id: row.id as Uuid,
    pipelineId: row.pipelineId as Uuid,
    fromStepId: row.fromStepId,
    resultKey: row.resultKey,
    label: row.label,
    tone: row.tone as StepRoute["tone"],
    target: row.target,
    position: row.position,
  };
}

function toPipeline(row: typeof pipelines.$inferSelect): Pipeline {
  return {
    id: row.id as Uuid,
    projectId: row.projectId as Uuid | null,
    name: row.name,
    icon: row.icon,
    entryStepId: row.entryStepId,
    position: row.position,
    previewItem: previewItemOf(row.previewItem),
    webhookUnattended: row.webhookUnattended,
    // Unreadable reads as none, for `previewItemOf`'s reason: a pipeline
    // that shut every door over a malformed row is no better a report of it.
    entryRules: EntryRulesSchema.safeParse(row.entryRules).data ?? [],
    archivedAt: row.archivedAt,
  };
}

/**
 * The template item this pipeline carries, or null (EO-314).
 *
 * Unparseable reads as none, the way `item_types.spec_shape` does: a
 * malformed example is that row's problem, and a pipeline that will not
 * list is not a better report of it than a Preview button that has
 * nothing to walk.
 */
function previewItemOf(value: unknown): PreviewItem | null {
  if (value === null || value === undefined) return null;
  const parsed = PreviewItemSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

// ── Pipelines ─────────────────────────────────────────────────

export interface CreatePipelineInput {
  projectId?: Uuid | null;
  name: string;
  icon?: string | null;
  position?: number;
  /** The template item a pack ships for Preview (EO-314). Absent on every pipeline a person draws. */
  previewItem?: PreviewItem | null;
}

/** Where work enters a pipeline (ARCHITECTURE.md, "Vocabulary"). Null until it has a step to enter. */
export function setEntryStep(db: Db, pipelineId: string, entryStepId: string | null): void {
  db.update(pipelines).set({ entryStepId, updatedAt: Date.now() }).where(eq(pipelines.id, pipelineId)).run();
}

/**
 * Whether this pipeline may send what a webhook delivers unread
 * (EO-405).
 *
 * The one write of the column on a machine that owns its pipelines, and
 * `setWebhookUnattendedCommand` is its one caller. `createPipeline`
 * takes no such input on purpose: a pipeline that arrives — drawn,
 * imported, installed from a pack — arrives with it off, and there is no
 * argument an import could pass to make it otherwise.
 *
 * Stamps `updated_at`, which is what carries the change from a record
 * to its replicas.
 */
export function setWebhookUnattended(db: Db, pipelineId: string, unattended: boolean): void {
  db.update(pipelines).set({ webhookUnattended: unattended, updatedAt: Date.now() }).where(eq(pipelines.id, pipelineId)).run();
}

export function createPipeline(db: Db, input: CreatePipelineInput): Pipeline {
  const now = Date.now();
  const row = db
    .insert(pipelines)
    .values({
      id: uuidv7(),
      projectId: input.projectId ?? null,
      name: input.name,
      icon: input.icon ?? null,
      position: input.position ?? 0,
      // Absent on every pipeline but an imported pack's (EO-314).
      previewItem: input.previewItem ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  return toPipeline(row);
}

export function getPipeline(db: Db, id: string): Pipeline | undefined {
  const row = db.select().from(pipelines).where(eq(pipelines.id, id)).get();
  return row ? toPipeline(row) : undefined;
}

/**
 * Every live pipeline, oldest position first. Never a trial pipeline
 * (EO-582).
 *
 * Archived ones are excluded here rather than filtered by each caller:
 * a deleted pipeline is archived rather than dropped (KAN-59) so the work
 * that flowed through it keeps something to point at, and "list the
 * pipelines" never means "including the deleted ones".
 *
 * Tie-broken on id. `createPipelineCommand` stamps `position` with
 * `Date.now()`, so two pipelines created in the same millisecond share
 * one and would otherwise order arbitrarily — and permanently — in the
 * switcher. Ids are UUIDv7 and minted monotonically, so within a
 * millisecond their lexicographic order is creation order.
 */
export function listPipelines(db: Db, projectId?: Uuid | null, includeArchived = false): Pipeline[] {
  // Never a trial (EO-582, ARCHITECTURE.md, "Trial pipelines"). A trial is
  // a draft under test, made so items could stand on it, and every
  // screen, list, export and name check reads pipelines through here: so
  // this is the one place that keeps a trial out of all of them. A trial
  // is found by id, through `trialsRepo`.
  const rows = db
    .select()
    .from(pipelines)
    .where(isNull(pipelines.trialAt))
    .orderBy(asc(pipelines.position), asc(pipelines.id))
    .all()
    .map(toPipeline);
  const live = includeArchived ? rows : rows.filter((pipeline) => pipeline.archivedAt === null);
  if (projectId === undefined) return live;
  // A project-less pipeline is one nothing has adopted yet, so it belongs
  // to whichever project is asking — the same rule `items.workspaceId`
  // follows before the first workspace exists.
  return live.filter((pipeline) => pipeline.projectId === projectId || pipeline.projectId === null);
}

/**
 * Gives a project-less pipeline a project (EO-317).
 *
 * The one pipeline this is about today is the "Delivery" board every
 * installation is seeded with: `listPipelines` shows an unadopted
 * pipeline to whichever project is asking, which is what lets EO work
 * before anything is configured — and what makes a *second* copy of it
 * visible the moment somebody installs the pack that it is an export
 * of. First run adopts it instead of importing a twin; see
 * `pipelineAlreadyHere`.
 */
export function adoptPipeline(db: Db, id: string, projectId: Uuid): void {
  db.update(pipelines).set({ projectId, updatedAt: Date.now() }).where(eq(pipelines.id, id)).run();
}

export function archivePipeline(db: Db, id: string, at: number = Date.now()): void {
  db.update(pipelines).set({ archivedAt: at, updatedAt: at }).where(eq(pipelines.id, id)).run();
}

// ── Steps ─────────────────────────────────────────────────────

export interface CreateStepInput {
  id?: string;
  pipelineId: Uuid;
  position: number;
  name: string;
  type?: PipelineStepType;
  ownerRole?: string | null;
  entryAction?: string | null;
  instructionsSummary?: string | null;
  isTerminal?: boolean;
  planMode?: boolean;
  /** How this step uses a git workspace (EO-296). `isolated` when nobody says, which is what every step did before modes existed. */
  workspaceMode?: WorkspaceMode;
  /**
   * Which of the project's workspaces this step runs on (EO-301).
   *
   * Optional with no default for `inputs`' reason, and `replacePipelineGraph`
   * holds the same distinction: absent leaves the row's pick alone —
   * an imported document carries no workspace id, and one that did
   * would name a row on somebody else's machine — while `null` is a
   * caller saying "back to the ticket's workspace".
   */
  workspaceId?: string | null;
  offBoard?: boolean;
  /**
   * What this step sets for its module's declared inputs (EO-78).
   *
   * Optional with no default, and the distinction is load-bearing in
   * `replacePipelineGraph`: absent means "leave what the row had", `{}`
   * means "this step configures nothing". A caller that rewrites the
   * graph without opinions about inputs — the architect applying a
   * draft — must not erase a number somebody tuned, while the editor
   * publishing a step whose module just changed must be able to clear
   * one. The same "keep what the row had" arrangement `ModuleSaveInput.source`
   * uses, for the same reason.
   */
  inputs?: StepInputs;
  /**
   * How long this step's module may run before EO stops it (EO-162).
   *
   * Optional with no default for the reason `inputs` is, and the same
   * distinction holds in `replacePipelineGraph`: absent leaves the row's
   * value alone, `null` clears it back to EO's default. A caller with no
   * opinion about how long a step may run — the architect applying a
   * draft — must not reset a limit somebody raised on purpose.
   */
  timeoutMs?: number | null;
  /**
   * Keep checking (EO-456): check every N minutes, give up after H hours.
   *
   * Optional with no default, and `replacePipelineGraph` reads it three
   * ways like the fields around it: absent leaves the row alone — an
   * architect's draft is not asked about it — `null` turns the mode off,
   * and a value sets it. Part of the graph document, unlike `timeoutMs`:
   * the editor publishes it and an export carries it.
   */
  watch?: StepWatch | null;
  /**
   * The person this human step waits on (EO-302, ARCHITECTURE.md, "Identity").
   *
   * Optional with no default, and `replacePipelineGraph` holds the same
   * distinction the four fields above hold, for the sharpest version of
   * their reason: a pipeline document carries no person. A person id
   * means nothing on the machine importing it — and in 7b, nothing in
   * another organisation — so absent must leave the row's owner exactly
   * where it is, while `null` is a caller saying "nobody in
   * particular", which is what every step says today.
   */
  ownerPersonId?: Uuid | null;
  /**
   * The group this human step waits on, with `ownerPersonId`'s three-way
   * reading: absent leaves the row alone, `null` clears it, a value sets
   * it.
   *
   * Absent from every publish but one (EO-323). A publish is a graph
   * document, and a group id means as little on the machine importing
   * one as a person id does — less, since a group is an organisation's
   * own row. Naming a group is `steps:setOwner`, which checks the group
   * exists on *this* list first.
   *
   * The one exception is publishing a restored version (EO-359), whose
   * owners `savePipeline` reads out of that version's own document on
   * this machine and checks against the groups that exist here before
   * passing them on.
   */
  ownerGroupId?: string | null;
  /**
   * What a person may decide on this human step (EO-310, ARCHITECTURE.md, "Results and routes").
   *
   * Optional with no default, and `replacePipelineGraph` holds the
   * distinction the fields above hold — with one difference worth
   * naming: absent leaves the row's results alone, and `[]` clears
   * them. The editor sends `[]` for every step that is not a user step,
   * which is what stops a step that stopped being human from keeping
   * buttons nobody can reach.
   */
  results?: StepResult[];
}

export function createStep(db: Db, input: CreateStepInput): PipelineStep {
  const row = db
    .insert(pipelineSteps)
    .values({
      id: input.id ?? uuidv7(),
      pipelineId: input.pipelineId,
      position: input.position,
      name: input.name,
      type: input.type ?? "agent",
      ownerRole: input.ownerRole ?? null,
      entryAction: input.entryAction ?? null,
      instructionsSummary: input.instructionsSummary ?? null,
      isTerminal: input.isTerminal ?? false,
      planMode: input.planMode ?? false,
      workspaceMode: input.workspaceMode ?? DEFAULT_WORKSPACE_MODE,
      workspaceId: input.workspaceId ?? null,
      offBoard: input.offBoard ?? false,
      inputs: input.inputs ?? {},
      timeoutMs: input.timeoutMs ?? null,
      ...watchColumns(input.watch ?? null),
      ownerPersonId: input.ownerPersonId ?? null,
      results: input.results ?? [],
    })
    .returning()
    .get();
  return toStep(row);
}

/**
 * Changes one step in place.
 *
 * The configuration screen publishes the whole graph (`replacePipelineGraph`)
 * because its shape is a property of the set. This is for the settings
 * that are not about shape — plan mode, how a git workspace is used,
 * which workspace is used at all, who owns a human step and what a
 * module step sets for its module's inputs. None of them can make a
 * graph invalid, which is what the whole-document publish exists to
 * judge.
 *
 * The last two arrived with the gallery (EO-316): "Use this" answers a
 * template's blanks onto a pipeline it has *just* imported, so there is
 * no draft to publish and nothing about the graph's shape to re-judge —
 * only values landing on steps that already exist.
 */
export function updateStep(
  db: Db,
  id: string,
  patch: { planMode?: boolean; workspaceMode?: WorkspaceMode; workspaceId?: string | null; ownerPersonId?: Uuid | null; inputs?: StepInputs },
): void {
  db.update(pipelineSteps).set(patch).where(eq(pipelineSteps.id, id)).run();
}

/**
 * Who waits at a human step — a person, a group, or nobody (EO-323,
 * ARCHITECTURE.md, "Identity").
 *
 * Its own function rather than two more optional fields on `updateStep`,
 * because the two columns are one answer and writing them separately is
 * how a step comes to name both. Both are always written: naming a group
 * clears the person, naming a person clears the group, and naming
 * neither is what every step is by default — it waits for whoever is
 * there.
 *
 * The caller checks that the person and the group exist
 * (`setStepOwnerCommand`); this writes. `owner_group_id` has no foreign
 * key — schema.ts says why — so a group that is deleted is cleared from
 * here by `deleteGroup` rather than by SQLite.
 */
export function setStepOwner(db: Db, id: string, owner: { personId: Uuid | null; groupId: string | null }): void {
  db.update(pipelineSteps).set({ ownerPersonId: owner.personId, ownerGroupId: owner.groupId }).where(eq(pipelineSteps.id, id)).run();
}

export function getStep(db: Db, id: string): PipelineStep | undefined {
  const row = db.select().from(pipelineSteps).where(eq(pipelineSteps.id, id)).get();
  return row ? toStep(row) : undefined;
}

/**
 * The steps of one pipeline, in position order.
 *
 * The *current* version's steps (EO-327): a step somebody removed is
 * retired rather than dropped, and a retired step is not a column, not a
 * route target a new graph may name, and not something the validator
 * counts as existing. It is still a row, because items can be finishing
 * on it — `listRetiredStepsForPipeline` is who asks about those.
 */
export function listStepsForPipeline(db: Db, pipelineId: string): PipelineStep[] {
  return db
    .select()
    .from(pipelineSteps)
    .where(and(eq(pipelineSteps.pipelineId, pipelineId), isNull(pipelineSteps.retiredVersion)))
    .orderBy(asc(pipelineSteps.position))
    .all()
    .map(toStep);
}

/**
 * The steps this pipeline has removed but not forgotten (EO-327, ARCHITECTURE.md, "Publish, lock
 * and versions").
 *
 * Each with the version it was last part of, which is what the ghost
 * column's head says: "Review (v6) · 2 finishing". Whether one is drawn
 * at all is a question about what it holds, and this answers only what
 * exists — the board counts the items.
 */
export function listRetiredStepsForPipeline(db: Db, pipelineId: string): { step: PipelineStep; retiredVersion: number }[] {
  return db
    .select()
    .from(pipelineSteps)
    .where(and(eq(pipelineSteps.pipelineId, pipelineId), isNotNull(pipelineSteps.retiredVersion)))
    .orderBy(asc(pipelineSteps.position))
    .all()
    .map((row) => ({ step: toStep(row), retiredVersion: row.retiredVersion as number }));
}

/**
 * Every step of every pipeline, retired ones included.
 *
 * The scheduler wants this — it groups by `pipelineId` itself so one tick
 * can advance items across several pipelines (KAN-56) — and so does
 * anything resolving an item's step without first knowing its pipeline.
 *
 * Retired steps are here deliberately (EO-327), and it is the difference
 * between "3 items finish on v6" and three items stopping dead. An item
 * on a step the current version has removed still has to be dispatched,
 * and the row it sits on is frozen exactly as its own version left it —
 * so what runs is the definition it entered on.
 */
export function listPipelineSteps(db: Db): PipelineStep[] {
  return db.select().from(pipelineSteps).orderBy(asc(pipelineSteps.pipelineId), asc(pipelineSteps.position)).all().map(toStep);
}

/**
 * The steps of the *other* pipelines a route out of this one may land in —
 * the validator's candidate targets (EO-58, EO-69).
 *
 * `validatePipeline` takes these as `stepsElsewhere` and consults them only
 * after this pipeline's own steps, so what is returned here can never
 * redirect a route that already resolved. It is the validator's set, and
 * only the validator's: what the editor offers is the narrower question
 * `listRoutableStepsElsewhere` answers (EO-72).
 *
 * Scoped to one project, because handing work over is a thing one project's
 * pipelines do among themselves. *Which* project is the whole subtlety, and
 * it depends on the pipeline doing the asking.
 *
 * A pipeline a project has adopted names that project, and sees its
 * pipelines — plus the project-less ones, which belong to everybody, by the
 * adoption rule `listPipelines` applies.
 *
 * A pipeline no project has adopted has no project of its own to name, so
 * the answer is the project it is being edited in, which is what
 * `editingProjectId` carries. Asking `listPipelines` with its own `null`
 * collapsed the filter to "the other project-less ones" and hid, from the
 * shipped project-less Delivery pipeline, every pipeline anyone had created
 * on the project. Asking with `undefined` swings as far the other way: work
 * in this project may not be handed to another project's pipeline, and a
 * cross-project target the picker offered would be a route this project
 * could never sensibly take.
 *
 * `editingProjectId` is the active project, which both callers read in the
 * main process rather than accept from the client — the same reason the
 * candidates themselves are read there: nothing on the wire gets to widen
 * what a route may resolve to.
 *
 * Archived pipelines are excluded by `listPipelines`: a deleted pipeline is
 * kept so the work that flowed through it still points at something, not so
 * new work can be sent into it.
 *
 * Every step of the pipelines that survive that filter, off-dashboard ones
 * included. Off-dashboard is a statement about the board — whether the step
 * renders as a column of the pipeline it belongs to — not about whether the
 * step exists to be routed to, and a route naming one is emphatically not
 * the typo this list exists to keep catching. It also keeps the check
 * honest: `wiring.ts` hands `resolveRoute` every step of every other
 * pipeline at runtime, so excluding them here would refuse to save a route
 * the engine would then happily follow.
 */
export function listStepsElsewhere(db: Db, pipelineId: string, editingProjectId: Uuid | null): PipelineStep[] {
  const pipeline = getPipeline(db, pipelineId);
  if (!pipeline) return [];
  // Its own project when it has one, so a saved graph's targets do not move
  // under it when somebody switches projects; the project it is being edited
  // in when it has none, because then it has no project of its own to name.
  return listPipelines(db, pipeline.projectId ?? editingProjectId)
    .filter((other) => other.id !== pipelineId)
    .flatMap((other) => listStepsForPipeline(db, other.id));
}

/**
 * The steps the editor's target picker offers as a hand-off (EO-72).
 *
 * A subset of `listStepsElsewhere`, and deliberately a strict one: what a
 * validator tolerates and what a picker proposes are different questions.
 * Being permissive about what may be *saved* — so that a route the engine
 * would follow is never refused, and nothing saved today stops saving —
 * must not force being permissive about what is *suggested*. Subset is the
 * load-bearing part: everything offered here still validates.
 *
 * Two things are left out.
 *
 * A pipeline with no entry step has nowhere for work to arrive, so it can
 * receive none — the same rule EO-70 applies to the destinations a card's
 * `⋯` menu offers, which is why the card offers Merge and neither offers
 * Discussions.
 *
 * And an off-dashboard step hosts a conversation rather than holding work.
 * That is what `offBoardStepIds` keeps the dashboard, the archive and the
 * inbox away from; offering one as an ordinary route target invites
 * somebody to send real work into a discussion.
 */
export function listRoutableStepsElsewhere(db: Db, pipelineId: string, editingProjectId: Uuid | null): PipelineStep[] {
  const entered = new Set(
    listPipelines(db)
      .filter((pipeline) => pipeline.entryStepId !== null)
      .map((pipeline) => pipeline.id as string),
  );
  return listStepsElsewhere(db, pipelineId, editingProjectId).filter((step) => entered.has(step.pipelineId) && !step.offBoard);
}

/**
 * The steps that hold something other than work, as a set to test item
 * rows against.
 *
 * Every screen that answers "what work is there?" — the dashboard, the
 * archive, the inbox's stall check — has to exclude these, and each would
 * otherwise grow its own `stepId === "discussion"` comparison. Keeping it one
 * query keyed on the column means adding a second off-dashboard step stays
 * a data change (invariant #7).
 */
export function offBoardStepIds(db: Db): Set<string> {
  return new Set(
    db
      .select({ id: pipelineSteps.id })
      .from(pipelineSteps)
      .where(eq(pipelineSteps.offBoard, true))
      .all()
      .map((row) => row.id),
  );
}

// ── Routes ────────────────────────────────────────────────────

export interface CreateRouteInput {
  pipelineId: Uuid;
  fromStepId: string;
  resultKey: string;
  label: string;
  tone?: StepRoute["tone"];
  target: string;
  position?: number;
}

export function createRoute(db: Db, input: CreateRouteInput): StepRoute {
  const row = db
    .insert(stepRoutes)
    .values({
      id: uuidv7(),
      pipelineId: input.pipelineId,
      fromStepId: input.fromStepId,
      resultKey: input.resultKey,
      label: input.label,
      tone: input.tone ?? "info",
      target: input.target,
      position: input.position ?? 0,
    })
    .returning()
    .get();
  return toRoute(row);
}

/** Every route of one pipeline, so a caller resolving a result has them all. */
export function listRoutesForPipeline(db: Db, pipelineId: string): StepRoute[] {
  return db.select().from(stepRoutes).where(eq(stepRoutes.pipelineId, pipelineId)).orderBy(asc(stepRoutes.position)).all().map(toRoute);
}

/** The routes leaving one step — what that step declares it can return. */
export function listRoutesForStep(db: Db, stepId: string): StepRoute[] {
  return db.select().from(stepRoutes).where(eq(stepRoutes.fromStepId, stepId)).orderBy(asc(stepRoutes.position)).all().map(toRoute);
}

/**
 * The routes from *other* pipelines that land on a step of this one — the
 * hand-offs pointing in (EO-58, EO-167).
 *
 * The one edge into this pipeline's graph that neither the configuration
 * screen nor `validatePipeline` can see for itself: both are given this
 * pipeline's routes, and a route into it belongs to whichever pipeline
 * declares it. Which is why removing a step has to ask — deleting the
 * step a hand-off names leaves that route pointing at nothing, in a
 * pipeline nobody was editing, discovered when an item takes it.
 * `step_routes.target` has no foreign key to catch it.
 *
 * One function rather than a query and a name lookup at each call site,
 * because there are three of them — the editor's read, the publish
 * validation and the architect's — and a check that disagrees with the
 * screen that offered it is worse than no check.
 *
 * Live pipelines only. An archived one is somewhere work cannot flow: its
 * items were archived with it (KAN-59), and `listStepsElsewhere` has
 * always left it out of the wiring for the same reason. Counting one here
 * would hold a step hostage to a pipeline somebody deleted, which is a
 * refusal with nothing they can do about it — the route is not editable
 * from anywhere.
 *
 * `replacing` is the routes other pipelines will have once writes made
 * in the same transaction land (EO-762): the boards of one template
 * updated together, where one stops handing work to a step the other
 * removes. Their stored routes are read as these instead.
 */
export function listIncomingHandOffs(db: Db, pipelineId: string, replacing: ReadonlyMap<string, readonly StepRoute[]> = new Map()): IncomingHandOff[] {
  const mine = new Set(listStepsForPipeline(db, pipelineId).map((step) => step.id));
  const live = new Map(listPipelines(db).map((pipeline) => [pipeline.id as string, pipeline.name]));

  const stored = db
    .select()
    .from(stepRoutes)
    .where(ne(stepRoutes.pipelineId, pipelineId))
    .all()
    .map(toRoute)
    .filter((route) => !replacing.has(route.pipelineId));
  const replaced = [...replacing].flatMap(([id, routes]) => (id === pipelineId ? [] : routes));
  return [...stored, ...replaced]
    .filter((route) => mine.has(route.target) && live.has(route.pipelineId))
    .map((route) => ({ target: route.target, pipelineName: live.get(route.pipelineId)!, label: route.label }));
}

/**
 * What `replacePipelineGraph` answers (EO-230).
 *
 * A refusal names every removed step that still holds items, with its
 * count, rather than the first: a person told about one of two would
 * move those and meet the refusal again.
 */
export type ReplacePipelineGraphResult = { replaced: true; version: number } | { replaced: false; holding: StepHoldingItems[] };

/** What else lands with the graph, because it is part of the same document (EO-327). */
export interface ReplacePipelineGraphOptions {
  /**
   * Where work enters, written inside the same transaction.
   *
   * Part of the document a version freezes (ARCHITECTURE.md, "Vocabulary"), so it cannot be a
   * separate write: a version filed before the entry step lands would
   * freeze the wrong one, and a crash between them would leave a graph
   * whose entry is the old one.
   *
   * Absent leaves it exactly as it was, which is what a caller with no
   * opinion about it means.
   */
  entryStepId?: string | null;
  /**
   * What an item must have to enter (EO-610), written inside the same
   * transaction for `entryStepId`'s reason: it is part of the document a
   * version freezes. Absent leaves them as they were, which is what a
   * caller with no opinion about them means; `[]` clears them.
   */
  entryRules?: readonly EntryRule[];
  /** Who saved it, for "Pipeline updated to v7 by Dana". Null for a version EO took itself. */
  createdBy?: string | null;
  /** The release notes of the template update filing it (EO-728), kept on the version. */
  releaseNotes?: string | null;
  /**
   * Publish a version this pipeline already has, instead of filing a
   * new one (EO-329, ARCHITECTURE.md, "Publish, lock and versions": "rollback is publishing an
   * older version
   * again").
   *
   * The graph is written from that version's own document and
   * `pipelines.current_version_id` is pointed back at it. The version
   * named is never rewritten — it is immutable, and rewriting it would
   * be changing the document every item bound to it finishes on, which
   * is the one promise EO-327 makes.
   *
   * It goes through this function rather than around it because a
   * rollback is a graph change like any other: it can remove a step
   * that work is standing on, and it meets the same strand refusal,
   * with the same counts, from the same guard.
   */
  republishVersionId?: string;
  /**
   * Write the graph and file no version for it (EO-331, ARCHITECTURE.md, "Divergence and
   * suggestions").
   *
   * One caller: a save into a pipeline this machine has **diverged**
   * from the version its organisation published. The version history of
   * a published pipeline is the organisation's — every number in it was
   * something an admin published, and every item in flight finishes on
   * one of them. A desktop filing its own v7 into that history would be
   * claiming a publish that never happened, and would collide with the
   * record's v7 the moment it arrives (`pipeline_versions` is unique on
   * pipeline and number).
   *
   * So a diverged copy is the live graph and nothing more. What makes
   * that safe rather than lossy is where it goes next: the copy leaves
   * this machine as a *suggestion*, and approving one files v7 on the
   * record, from the admin's own act, which is where the number was
   * always going to come from.
   *
   * Absent means file one, which is every other caller.
   */
  fileVersion?: boolean;
}

/**
 * Replaces a pipeline's steps and routes wholesale, in one transaction.
 *
 * Wholesale rather than a diff because the configuration screen edits the
 * graph as one document and publishes it as one (KAN-63): applying it in
 * pieces would let a half-wired graph exist between statements, which is
 * the state the validator exists to reject. Routes go first on the way out
 * and last on the way in, since they reference the steps.
 *
 * Refuses, and writes nothing, when the graph removes a step that items
 * sit on (EO-230). The validator refuses the same save one layer up, and
 * this is the guard under it rather than a repeat of it: `pipeline:save`
 * is one caller of several, and a foreign-key error is not an answer a
 * person can act on. Renaming a step or changing its type with items on
 * it is allowed — steps are updated in place — and only removal is
 * refused.
 *
 * A removal that gets past that guard **retires** the step rather than
 * dropping it (EO-327, ARCHITECTURE.md, "Publish, lock and versions"). The row is what an item
 * finishing on an
 * older version may still be routed onto, and it is frozen as that
 * version left it. Re-adding a step by the same id revives it.
 */
export function replacePipelineGraph(
  db: Db,
  pipelineId: string,
  steps: CreateStepInput[],
  routes: CreateRouteInput[],
  options: ReplacePipelineGraphOptions = {},
): ReplacePipelineGraphResult {
  return db.transaction((tx): ReplacePipelineGraphResult => {
    const inTx = tx as unknown as Db;
    // Before anything is compared: a step being retired has to name the
    // version it was last part of, and a pipeline that has never been
    // asked what version it is on gets its v1 here — of the graph as it
    // stands, which is the one being replaced (EO-327).
    let outgoing = ensureCurrentVersion(inTx, pipelineId);
    // Steps are updated in place rather than dropped and re-inserted.
    // `items.step_id` references this table and foreign keys are ON, so
    // deleting a step an item sits on would fail mid-transaction — and
    // deleting a step that is merely being *renamed* would fail for a
    // item that is perfectly happy where it is.
    //
    // Retired steps are in `existing` too, so that a graph re-adding one
    // by id updates that row back into the current version rather than
    // inserting a second one under a primary key it already holds.
    const existing = new Map(
      tx
        .select({ id: pipelineSteps.id, name: pipelineSteps.name, retiredVersion: pipelineSteps.retiredVersion })
        .from(pipelineSteps)
        .where(eq(pipelineSteps.pipelineId, pipelineId))
        .all()
        .map((row) => [row.id, row] as const),
    );
    const incoming = new Map(steps.map((step) => [step.id ?? uuidv7(), step] as const));

    // Only what this save removes. A step retired by an earlier save and
    // still absent is not being removed again — it is where it was.
    const removed = [...existing.values()].filter((row) => row.retiredVersion === null && !incoming.has(row.id)).map((row) => row.id);

    // Before the first write, so a refusal leaves the graph exactly as it
    // was. Archived items count: the foreign key does not care whether
    // the dashboard is showing them, and the answer here has to be the
    // one `validationInput` gives at Publish.
    if (removed.length > 0) {
      const holding = tx
        .select({
          stepId: items.stepId,
          count: count(),
          // How many of them the board cannot show, so the refusal can
          // point at the Archive for those. `count()` over a column
          // counts its non-null rows, which is exactly "archived".
          archived: count(items.archivedAt),
        })
        .from(items)
        .where(inArray(items.stepId, removed))
        .groupBy(items.stepId)
        .all()
        .flatMap((row): StepHoldingItems[] =>
          row.stepId === null || row.count === 0
            ? []
            : [{ stepId: row.stepId, stepName: existing.get(row.stepId)?.name ?? row.stepId, count: row.count, archived: row.archived }],
        );
      if (holding.length > 0) return { replaced: false, holding };
    }

    // The version being replaced, caught up first where something other
    // than a save changed the graph since it was filed — a migration
    // writing the shipped pipeline's rows. The items bound to it have been
    // routed by the live graph all along, and this publish is what would
    // start reading them against the stale document
    // (`catchUpCurrentVersion`, EO-514). After the refusal, so a refused
    // save files nothing; and not for a diverged copy, which files no
    // version and leaves the pointer where it is, so its items go on
    // reading the live rows.
    if (options.fileVersion !== false) outgoing = catchUpCurrentVersion(inTx, pipelineId) ?? outgoing;

    // Routes first: they reference the steps, and every one is rewritten.
    // Retired steps keep no routes: a route is part of a version's
    // document, and the version that has the step has the routes out of
    // it. The live table is the current version and nothing else.
    tx.delete(stepRoutes).where(eq(stepRoutes.pipelineId, pipelineId)).run();

    if (removed.length > 0) {
      // Retired, not dropped (EO-327). The row stays exactly as it is —
      // the definition its own version published — and stops being a
      // column, a target and a step the validator can see.
      tx.update(pipelineSteps)
        .set({ retiredVersion: outgoing?.number ?? 1 })
        .where(inArray(pipelineSteps.id, removed))
        .run();
    }

    for (const [id, step] of incoming) {
      const values = {
        pipelineId,
        position: step.position,
        name: step.name,
        type: step.type ?? "agent",
        ownerRole: step.ownerRole ?? null,
        entryAction: step.entryAction ?? null,
        instructionsSummary: step.instructionsSummary ?? null,
        isTerminal: step.isTerminal ?? false,
        planMode: step.planMode ?? false,
        offBoard: step.offBoard ?? false,
        // A step in the submitted graph is a step of the current
        // version, which is how a retired one comes back: somebody
        // re-adding "Review" by the same id gets the row they had
        // rather than a second one, items and all (EO-327).
        retiredVersion: null,
      };
      // Omitted from the update when the caller said nothing about it
      // (EO-78), which is the one field here that is not "publish what
      // I sent". A rewrite that has no opinion about a step's configured
      // values — the architect applying a draft, which is not asked for
      // them — must leave the numbers somebody tuned exactly where they
      // are. `{}` still clears, so the editor can discard the values a
      // newly chosen module does not declare.
      const configured = step.inputs === undefined ? {} : { inputs: step.inputs };
      // The same arrangement, one field over (EO-162). A rewrite that says
      // nothing about how long a step may run leaves the number where it
      // is; `null` is a caller saying "back to EO's default", which is
      // what the editor sends when somebody empties the box.
      const limit = step.timeoutMs === undefined ? {} : { timeoutMs: step.timeoutMs };
      // And the same again for how a step uses its workspace (EO-296). An
      // imported pipeline document carries no mode — it is a fact about
      // the disk this machine has, not about the graph — so importing
      // over an existing step must not quietly start cutting branches
      // for one somebody had set to read only.
      const mode = step.workspaceMode === undefined ? {} : { workspaceMode: step.workspaceMode };
      // And once more, one field over again (EO-301). An imported
      // pipeline carries no workspace id — a UUID means nothing on the
      // machine reading it — so importing over an existing step must
      // leave the disk somebody pointed it at alone.
      const disk = step.workspaceId === undefined ? {} : { workspaceId: step.workspaceId };
      // And once more for who a human step waits on (EO-302). The same
      // arrangement as the disk one line up, and the sharpest case for
      // it: a person id means nothing on the machine importing a
      // pipeline document, so a rewrite that says nothing about an
      // owner must not clear the person somebody named.
      //
      // Note what this already bought before the field existed:
      // `values` never mentioned the column, so publishing a graph left
      // it alone by omission. Being explicit is what makes that a
      // decision rather than an oversight — and what lets `null` mean
      // "back to nobody in particular".
      const owner = step.ownerPersonId === undefined ? {} : { ownerPersonId: step.ownerPersonId };
      // And the group beside it, by the same three-way rule (EO-359).
      const group = step.ownerGroupId === undefined ? {} : { ownerGroupId: step.ownerGroupId };
      // And once more for what a person may decide here (EO-310). The
      // same arrangement, for a narrower reason than the four above:
      // this one *is* part of the graph document — it travels on export
      // and the editor publishes it — so a caller that sends results
      // publishes them, and one with nothing to say about them (an
      // architect's draft, which is not asked for any) leaves the
      // buttons somebody wrote exactly where they are.
      const decisions = step.results === undefined ? {} : { results: step.results };
      // And keep checking (EO-456), on `results`' terms: part of the
      // graph document, so a caller that sends it publishes it and one
      // with nothing to say about it leaves the row alone.
      const watching = step.watch === undefined ? {} : watchColumns(step.watch);
      if (existing.has(id))
        tx.update(pipelineSteps).set({ ...values, ...configured, ...limit, ...mode, ...disk, ...owner, ...group, ...decisions, ...watching }).where(eq(pipelineSteps.id, id)).run();
      else
        tx
          .insert(pipelineSteps)
          .values({
            id,
            ...values,
            inputs: step.inputs ?? {},
            timeoutMs: step.timeoutMs ?? null,
            ...watchColumns(step.watch ?? null),
            workspaceMode: step.workspaceMode ?? DEFAULT_WORKSPACE_MODE,
            workspaceId: step.workspaceId ?? null,
            ownerPersonId: step.ownerPersonId ?? null,
            ownerGroupId: step.ownerGroupId ?? null,
            results: step.results ?? [],
          })
          .run();
    }
    for (const route of routes) {
      tx.insert(stepRoutes)
        .values({
          id: uuidv7(),
          pipelineId,
          fromStepId: route.fromStepId,
          resultKey: route.resultKey,
          label: route.label,
          tone: route.tone ?? "info",
          target: route.target,
          position: route.position ?? 0,
        })
        .run();
    }

    // Where work enters, before the version freezes it: a pipeline
    // cannot point at a step that does not exist yet, and a brand-new
    // entry step is inserted by the loop above.
    if (options.entryStepId !== undefined) setEntryStep(inTx, pipelineId, options.entryStepId);
    if (options.entryRules !== undefined) tx.update(pipelines).set({ entryRules: options.entryRules }).where(eq(pipelines.id, pipelineId)).run();

    // A graph that changed has to page to the devices drawing it
    // (EO-329). `pipelines.updated_at` is the only timestamp the graph
    // has — `pipeline_steps` and `step_routes` carry none, which is why
    // `RecordCursorsSchema.pipelines` pages on it — so a rewrite that
    // left it alone would be a published pipeline that reached nobody
    // until somebody happened to rename it.
    tx.update(pipelines).set({ updatedAt: Date.now() }).where(eq(pipelines.id, pipelineId)).run();

    // And the version, in the same breath as the graph it is of
    // (EO-327, ARCHITECTURE.md, "Publish, lock and versions"). Here rather than at the callers,
    // because a caller
    // that forgot would leave the *current* version's document
    // describing a graph that is no longer live — and every item bound
    // to it stranded on that document the day a later save made it
    // older. A graph cannot change without a version saying what it
    // changed to.
    //
    // A rollback is the one caller that files none: the version it
    // publishes already exists, and a second row holding the same
    // document under a later number would make "finishes on v6" a
    // sentence with two answers (EO-329).
    if (options.republishVersionId !== undefined) {
      const number = setCurrentVersion(inTx, pipelineId, options.republishVersionId);
      if (number === undefined) throw new Error(`no version ${options.republishVersionId} on pipeline ${pipelineId}`);
      return { replaced: true, version: number };
    }
    // And the second caller that files none (EO-331): a diverged copy
    // of a pipeline the organisation publishes. See `fileVersion`. The
    // version it answers with is the one the pipeline is still on,
    // which is the truth — its graph moved and its history did not.
    if (options.fileVersion === false && outgoing !== undefined) return { replaced: true, version: outgoing.number };
    const filed = createPipelineVersion(inTx, pipelineId, options.createdBy ?? null, options.releaseNotes ?? null);
    // "Pipeline versions to keep" (EO-359), here rather than at any one
    // caller because this is the one place a version is filed for a
    // graph change: an editor save, an approved suggestion and an import
    // all pass through it, and a limit honoured by only some of them is
    // a history that grows without bound on the others. Only after a
    // version is *filed* — the two returns above file none, and a
    // rollback must leave the organisation's history as it found it.
    // In the same transaction, so a refused or failed write prunes
    // nothing. What is never deleted, and why, is
    // `prunePipelineVersions`' to say.
    prunePipelineVersions(inTx, pipelineId, pipelineVersionsToKeep(inTx));
    return { replaced: true, version: filed.number };
  });
}
