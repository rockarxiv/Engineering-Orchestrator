import { and, asc, desc, eq, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { DEFAULT_PIPELINE_VERSIONS_TO_KEEP, EntryRulesSchema, PipelineGraphSnapshotSchema, PipelineVersionsToKeepSchema, templateUpdateAuthor, templateUpdateOfAuthor, uuidv7 } from "@eo/core";
import type { EntryRule, PipelineGraphSnapshot, PipelineStep, StepRoute, Uuid, VersionRoute, VersionStep } from "@eo/core";
import type { Db } from "../client.js";
import { items, pipelineVersions, pipelines, publishedSections } from "../schema.js";
import { getSetting, setSetting } from "./settingsRepo.js";
import { getStep, listPipelineSteps, listRetiredStepsForPipeline, listRoutesForPipeline, listStepsForPipeline } from "./pipelineStepsRepo.js";

/**
 * A pipeline's versions — the immutable step and route sets an item
 * finishes on (EO-327, ARCHITECTURE.md, "Publish, lock and versions").
 *
 * The rule the whole file turns on: **the live `pipeline_steps` and
 * `step_routes` rows are the current version.** A snapshot is written
 * when a version is created, and read only when an item is bound to a
 * version that is no longer the current one. That is what let versions
 * land without teaching forty existing readers of
 * `listStepsForPipeline` a predicate — and what makes "an item mid-flight
 * keeps routing by its own version" a change to one function rather than
 * to every one of them.
 */

export interface PipelineVersionRow {
  id: Uuid;
  pipelineId: Uuid;
  number: number;
  createdAt: number;
  createdBy: string | null;
}

/**
 * The author a version is filed under when a template update wrote it
 * (EO-532): `template:<slug>@<version>`. The spelling is `@eo/core`'s
 * (`templateUpdateAuthor`), so the Changes view reads it back the way
 * this file writes it (EO-536).
 */
export { templateUpdateAuthor };

/**
 * The name to show for a version's author: the template update that
 * filed it, or the person's name through `personName`, or null.
 */
export function versionAuthorName(createdBy: string | null, personName: (personId: string) => string | null): string | null {
  if (createdBy === null) return null;
  const update = templateUpdateOfAuthor(createdBy);
  if (update !== null) return update.version === null ? "a template update" : `the ${update.slug} ${update.version} template update`;
  return personName(createdBy);
}

function toVersion(row: typeof pipelineVersions.$inferSelect): PipelineVersionRow {
  return {
    id: row.id as Uuid,
    pipelineId: row.pipelineId as Uuid,
    number: row.number,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
  };
}

/** The document a version holds, or null when the row's JSON is not one EO can read. */
function snapshotOf(row: typeof pipelineVersions.$inferSelect): PipelineGraphSnapshot | null {
  const parsed = PipelineGraphSnapshotSchema.safeParse({ steps: row.steps, routes: row.routes, entryStepId: row.entryStepId, entryRules: row.entryRules });
  return parsed.success ? parsed.data : null;
}

/** The graph as it stands right now, as a document to freeze. */
function liveSnapshot(db: Db, pipelineId: string): PipelineGraphSnapshot {
  // Retired steps are part of the version that still has them and of no
  // later one, so they are read from the older snapshot rather than
  // copied forward into every one after it.
  const steps = listStepsForPipeline(db, pipelineId);
  const entryStepId = db.select({ entryStepId: pipelines.entryStepId }).from(pipelines).where(eq(pipelines.id, pipelineId)).get()?.entryStepId ?? null;
  return PipelineGraphSnapshotSchema.parse({ steps, routes: listRoutesForPipeline(db, pipelineId), entryStepId, entryRules: liveEntryRules(db, pipelineId) });
}

/** The rules a pipeline holds now, read as `toPipeline` reads them, and only them: filing a version asks nothing else of the row. */
function liveEntryRules(db: Db, pipelineId: string): EntryRule[] {
  const row = db.select({ entryRules: pipelines.entryRules }).from(pipelines).where(eq(pipelines.id, pipelineId)).get();
  return EntryRulesSchema.safeParse(row?.entryRules).data ?? [];
}

/** This pipeline's newest version number, or 0 for one that has never had any. */
function highestNumber(db: Db, pipelineId: string): number {
  const row = db
    .select({ number: pipelineVersions.number })
    .from(pipelineVersions)
    .where(eq(pipelineVersions.pipelineId, pipelineId))
    .orderBy(desc(pipelineVersions.number))
    .limit(1)
    .get();
  return row?.number ?? 0;
}

/**
 * Files the graph as it stands as this pipeline's next version, and
 * points the pipeline at it.
 *
 * Called after a save has written the new graph — the snapshot is of
 * what was just published, which is what the version *is*. `createdBy`
 * is the person who pressed Save, and null when nobody did.
 */
export function createPipelineVersion(db: Db, pipelineId: string, createdBy: string | null = null): PipelineVersionRow {
  // The document and the pointer at it, together (EO-327). Two
  // statements that must never be seen apart: a version row nothing
  // points at is a snapshot nobody reads, and — far worse — a pointer
  // moved without the row it names would leave `boundGraphForItem`
  // comparing an item's version against a current version that does not
  // exist, and answering "current" for every item on the pipeline.
  //
  // Nested inside the caller's transaction where there is one (a save,
  // an item binding, a hand-off): better-sqlite3 nests with a savepoint,
  // so this participates rather than committing early.
  return db.transaction((tx): PipelineVersionRow => {
    const snapshot = liveSnapshot(tx as unknown as Db, pipelineId);
    const row = tx
      .insert(pipelineVersions)
      .values({
        id: uuidv7(),
        pipelineId,
        number: highestNumber(tx as unknown as Db, pipelineId) + 1,
        steps: snapshot.steps,
        routes: snapshot.routes,
        entryStepId: snapshot.entryStepId,
        entryRules: snapshot.entryRules,
        createdAt: Date.now(),
        createdBy,
      })
      .returning()
      .get();
    tx.update(pipelines).set({ currentVersionId: row.id }).where(eq(pipelines.id, pipelineId)).run();
    return toVersion(row);
  });
}

/**
 * The version this pipeline is on, filing a v1 for it if it has never
 * had one.
 *
 * The lazy half of the migration, and the reason 0098 backfills
 * nothing. A pipeline that predates versions — or one a pack install
 * wrote step by step, without ever going through a save — has a graph
 * and no document of it. The first question anybody asks it (a save, or
 * an item binding to it) files that graph as v1, which is true: it is
 * the shape everything standing on it entered on.
 *
 * Items already mid-flight are bound to that v1 in the same breath, for
 * the same reason. They are standing in it.
 *
 * Undefined for a pipeline that does not exist, which a caller holding a
 * stale id can meet.
 */
export function ensureCurrentVersion(db: Db, pipelineId: string): PipelineVersionRow | undefined {
  const pipeline = db.select({ currentVersionId: pipelines.currentVersionId }).from(pipelines).where(eq(pipelines.id, pipelineId)).get();
  if (!pipeline) return undefined;

  if (pipeline.currentVersionId !== null) {
    const current = db.select().from(pipelineVersions).where(eq(pipelineVersions.id, pipeline.currentVersionId)).get();
    if (current) return toVersion(current);
  }

  // The snapshot, the pointer and the bindings in one unit (EO-327).
  // The gap between them is the whole hazard: a v1 filed and pointed at
  // while the items standing in it are still unbound would leave every
  // one of them reading as "on the current version" — so the next save
  // would move them onto a graph they never entered, which is the one
  // thing this story exists to prevent.
  return db.transaction((tx): PipelineVersionRow => {
    const version = createPipelineVersion(tx as unknown as Db, pipelineId, null);
    tx.update(items)
      .set({ pipelineVersionId: version.id })
      .where(and(eq(items.pipelineId, pipelineId), isNull(items.pipelineVersionId)))
      .run();
    return version;
  });
}

/**
 * The version a publish replaces, brought up to the graph its items have
 * actually been routed by (EO-514).
 *
 * An item on the current version reads the live rows, not the current
 * version's document (`boundGraphForItem`). So a graph written outside a
 * save — a migration such as 0114 or 0123, which add routes and steps to
 * the shipped pipeline's live rows and file no version — is the graph
 * those items run on from the moment it lands, while the document they
 * are bound to still describes the one before it. Nothing notices until
 * the next publish makes that version an older one: from then on its
 * items are read against the document, and an item 0123 sent to
 * "Watching pull request" stands on a step its version has never heard
 * of, with no route for `merged` out of it.
 *
 * So before a publish moves the pointer, the graph as it stands is
 * compared with the current version's document, as a diff reads them
 * (`diffableGraph` — the fields that are machine-local, such as a step's
 * inputs or its disk, are not what an item routes by). Where they
 * differ, the live graph is filed as a version of its own and the items
 * bound to the outgoing one are bound to it instead. That is the truth
 * about them, for `ensureCurrentVersion`'s reason: it is the graph they
 * are standing in. Where they agree, nothing is written.
 *
 * Answers with the version the publish replaces — the one just filed, or
 * the current one — and undefined for a pipeline that does not exist.
 */
export function catchUpCurrentVersion(db: Db, pipelineId: string): PipelineVersionRow | undefined {
  const current = ensureCurrentVersion(db, pipelineId);
  if (!current) return undefined;
  const row = db.select().from(pipelineVersions).where(eq(pipelineVersions.id, current.id)).get();
  const snapshot = row ? snapshotOf(row) : null;
  // A document EO cannot read is not one to compare with; the live graph
  // already answers for its items (`boundGraphForItem`).
  if (!snapshot) return current;
  const live = liveSnapshot(db, pipelineId);
  if (sameGraph(snapshot, live)) return current;

  // The version and the bindings together, for `ensureCurrentVersion`'s
  // reason: a version filed and pointed at while its items are still
  // bound to the outgoing one would leave them reading the stale
  // document the moment the publish lands.
  return db.transaction((tx): PipelineVersionRow => {
    const caughtUp = createPipelineVersion(tx as unknown as Db, pipelineId, null);
    tx.update(items)
      // The binding is part of the item a record pages to its devices
      // by `updated_at`, so a rebinding that left it alone would reach
      // nobody's replica.
      .set({ pipelineVersionId: caughtUp.id, updatedAt: Date.now() })
      .where(and(eq(items.pipelineId, pipelineId), eq(items.pipelineVersionId, current.id)))
      .run();
    return caughtUp;
  });
}

/** Whether two graph documents say the same thing, as a diff reads them. */
function sameGraph(a: PipelineGraphSnapshot, b: PipelineGraphSnapshot): boolean {
  return a.entryStepId === b.entryStepId && JSON.stringify(diffableGraph(a)) === JSON.stringify(diffableGraph(b));
}

/**
 * The version an item arriving on this step should bind to (EO-327,
 * ARCHITECTURE.md, "Publish, lock and versions").
 *
 * The destination pipeline's current version, which is the answer for
 * every ordinary hand-off: a step that is part of the graph as it stands
 * is part of the version that graph is.
 *
 * And not, for the case this exists for. A route is resolved against the
 * *sending* item's version, so a hand-off drawn in v1 of pipeline A can
 * still name a step pipeline B has since retired — B removed it while it
 * was empty, which B was entitled to do, and nothing in B could know
 * that an older version of A still pointed at it. Binding that arrival
 * to B's current version would hand the item a graph with no definition
 * for the step it is standing on and no route leaving it: stranded on
 * arrival, which is the failure this whole story is about.
 *
 * So it binds to the last version of B that *has* the step, which is
 * what `retired_version` records. The item then finishes in B under a
 * coherent older version — chipped `v3` on B's board and drawn in B's
 * ghost column, both of which are true.
 *
 * Undefined only for a pipeline that does not exist.
 */
export function versionForArrival(db: Db, pipelineId: string, stepId: string): PipelineVersionRow | undefined {
  const current = ensureCurrentVersion(db, pipelineId);
  if (!current) return undefined;

  // The fast path, and the one nearly every hand-off takes: a step that
  // is not retired is part of the current graph, which is the current
  // version.
  const retired = listRetiredStepsForPipeline(db, pipelineId).find((entry) => entry.step.id === stepId);
  if (!retired) return current;

  const versions = listPipelineVersions(db, pipelineId);
  const holdsIt = (version: PipelineVersionRow): boolean => {
    const row = db.select().from(pipelineVersions).where(eq(pipelineVersions.id, version.id)).get();
    const snapshot = row ? snapshotOf(row) : null;
    return snapshot?.steps.some((step) => step.id === stepId) ?? false;
  };

  // `retired_version` names it outright. Verified rather than trusted
  // (invariant #5), and searched newest-first if the number names a
  // version this database cannot read — a version that cannot be honoured
  // is not one to bind an arriving item to.
  const recorded = versions.find((version) => version.number === retired.retiredVersion);
  if (recorded && holdsIt(recorded)) return recorded;
  return [...versions].reverse().find(holdsIt) ?? current;
}

/**
 * What an item arriving on this step must have (EO-610, ARCHITECTURE.md,
 * "Entry rules"): the rules of the version it would bind to.
 *
 * The live rows answer for the current version, as they do for the graph,
 * and that is every arrival but one on a step the pipeline has retired,
 * which `versionForArrival` binds to the version that has it. Asked in
 * that order so an ordinary arrival writes nothing: `versionForArrival`
 * files a v1 for a pipeline with none, and a refusal leaves nothing behind.
 */
export function entryRulesForArrival(db: Db, pipelineId: string, stepId: string | null): EntryRule[] {
  const live = liveEntryRules(db, pipelineId);
  if (stepId === null || !listRetiredStepsForPipeline(db, pipelineId).some((entry) => entry.step.id === stepId)) return live;
  const version = versionForArrival(db, pipelineId, stepId);
  return (version === undefined ? undefined : versionSnapshot(db, version.id))?.entryRules ?? live;
}

/** The version this pipeline is on, or undefined if it has never been asked. Never writes. */
export function currentVersion(db: Db, pipelineId: string): PipelineVersionRow | undefined {
  const pipeline = db.select({ currentVersionId: pipelines.currentVersionId }).from(pipelines).where(eq(pipelines.id, pipelineId)).get();
  if (!pipeline?.currentVersionId) return undefined;
  const row = db.select().from(pipelineVersions).where(eq(pipelineVersions.id, pipeline.currentVersionId)).get();
  return row ? toVersion(row) : undefined;
}

/**
 * Points a pipeline back at a version it already has, and answers with
 * that version's number (EO-329, ARCHITECTURE.md, "Publish, lock and versions").
 *
 * The pointer only. The graph itself is written by
 * `replacePipelineGraph`, in the same transaction and from this
 * version's own document — the two are never apart, for
 * `createPipelineVersion`'s reason: a pointer moved without the rows it
 * describes would make `boundGraphForItem` answer "current" for items
 * standing in a graph that is not the current one.
 *
 * Undefined where no such version belongs to this pipeline, which is
 * what a caller holding a number from another pipeline meets.
 */
export function setCurrentVersion(db: Db, pipelineId: string, versionId: string): number | undefined {
  const row = db
    .select({ id: pipelineVersions.id, number: pipelineVersions.number })
    .from(pipelineVersions)
    .where(and(eq(pipelineVersions.id, versionId), eq(pipelineVersions.pipelineId, pipelineId)))
    .get();
  if (!row) return undefined;
  db.update(pipelines).set({ currentVersionId: row.id }).where(eq(pipelines.id, pipelineId)).run();
  return row.number;
}

/** One version of one pipeline by the number a person reads. */
export function pipelineVersionByNumber(db: Db, pipelineId: string, number: number): PipelineVersionRow | undefined {
  const row = db
    .select()
    .from(pipelineVersions)
    .where(and(eq(pipelineVersions.pipelineId, pipelineId), eq(pipelineVersions.number, number)))
    .get();
  return row ? toVersion(row) : undefined;
}

/**
 * The document one version froze, as a graph to write back.
 *
 * What a rollback restores from. Undefined for a version whose JSON
 * this build cannot read, which is the one case where the honest answer
 * is to refuse rather than to write half a graph.
 */
export function versionSnapshot(db: Db, versionId: string): PipelineGraphSnapshot | undefined {
  const row = db.select().from(pipelineVersions).where(eq(pipelineVersions.id, versionId)).get();
  if (!row) return undefined;
  return snapshotOf(row) ?? undefined;
}

export function getPipelineVersion(db: Db, versionId: string): PipelineVersionRow | undefined {
  const row = db.select().from(pipelineVersions).where(eq(pipelineVersions.id, versionId)).get();
  return row ? toVersion(row) : undefined;
}

/** Every version of one pipeline, oldest first. */
export function listPipelineVersions(db: Db, pipelineId: string): PipelineVersionRow[] {
  return db.select().from(pipelineVersions).where(eq(pipelineVersions.pipelineId, pipelineId)).orderBy(asc(pipelineVersions.number)).all().map(toVersion);
}

/** A graph document as a comparison reads it. */
export interface DiffableGraph {
  steps: VersionStep[];
  routes: VersionRoute[];
  entryRules: EntryRule[];
}

/** The steps and routes one version holds, as a diff reads them. */
export function versionGraph(db: Db, versionId: string): DiffableGraph | undefined {
  const row = db.select().from(pipelineVersions).where(eq(pipelineVersions.id, versionId)).get();
  if (!row) return undefined;
  const snapshot = snapshotOf(row);
  if (!snapshot) return undefined;
  return diffableGraph(snapshot);
}

/**
 * The graph as it stands *now*, in the shape a diff reads (EO-331,
 * `ARCHITECTURE.md`, "Divergence and suggestions").
 *
 * `versionGraph` one function up answers for a version somebody filed;
 * this answers for the live rows, which is the only place a **diverged**
 * pipeline's edit exists at all. That is the whole reason it is here: a
 * diverged copy deliberately files no version (see
 * `ReplacePipelineGraphOptions.fileVersion`), so *Compare* on the
 * configure screen has nothing in `pipeline_versions` to show, and a
 * person would be told their substantial local edit was "nothing to
 * compare with".
 *
 * Same document, same reading, same omissions — it goes through
 * `liveSnapshot`, which is the document `createPipelineVersion` would
 * freeze if this edit were ever published. So what Compare shows and
 * what a version would have recorded are the same graph by
 * construction.
 */
export function liveGraph(db: Db, pipelineId: string): DiffableGraph {
  return diffableGraph(liveSnapshot(db, pipelineId));
}

/**
 * One reading of a graph document as a diff reads it, for the two
 * callers above.
 *
 * Named apart from `graphOf` further down, which reads the same
 * document as *the rest of EO's types* spell it — steps and routes the
 * router can walk. This one drops to `VersionStep`/`VersionRoute`,
 * which is the narrower shape a comparison is made of.
 */
function diffableGraph(snapshot: PipelineGraphSnapshot): DiffableGraph {
  return {
    entryRules: snapshot.entryRules,
    steps: snapshot.steps.map((step) => ({
      id: step.id,
      position: step.position,
      name: step.name,
      type: step.type,
      ownerRole: step.ownerRole,
      entryAction: step.entryAction,
      instructionsSummary: step.instructionsSummary,
      isTerminal: step.isTerminal,
      planMode: step.planMode,
      offBoard: step.offBoard,
      watch: step.watch,
      // What a person may decide here (EO-310), carried so the diff can
      // report a save that renamed, retoned or withdrew a button. A
      // human step's results are executable — an item finishing on an
      // older version is offered *these* — so a diff without them would
      // call two versions that accept different answers identical.
      results: step.results.map((result) => ({ key: result.key, label: result.label, tone: result.tone, requiresComment: result.requiresComment })),
    })),
    // Every field of the route but its id, which `replacePipelineGraph`
    // regenerates on every save and which is therefore not something a
    // diff can compare (EO-327). What is left is the route set a version
    // *is* — so a save that only renamed a button is a change the diff
    // can see.
    routes: snapshot.routes.map((route) => ({
      fromStepId: route.fromStepId,
      resultKey: route.resultKey,
      label: route.label,
      target: route.target,
      tone: route.tone,
      position: route.position,
    })),
  };
}

/**
 * The graph an item routes by — its own version's, not the pipeline's
 * (EO-327, ARCHITECTURE.md, "Publish, lock and versions").
 *
 * The live rows whenever the item is on the current version, which is
 * every item on a pipeline nobody has edited since it entered: reading
 * a snapshot there would answer the same thing more slowly, and would
 * make a graph written by `createStep` outside a save invisible.
 *
 * The snapshot when it is not. An older version's document is what the
 * item agreed to, and it holds the steps the current graph has retired —
 * which is how a result can still send an item to a step that is no
 * longer a column (the ghost, ARCHITECTURE.md, "Publish, lock and versions").
 *
 * The live graph again when the snapshot cannot be read at all. A
 * version EO cannot parse is a bug in EO; stranding a running item on
 * it would be a second one.
 */
export function graphForItem(db: Db, item: BoundItem): { steps: PipelineStep[]; routes: StepRoute[] } {
  if (item.pipelineId === null) return { steps: [], routes: [] };
  return (
    boundGraphForItem(db, item) ?? { steps: listStepsForPipeline(db, item.pipelineId), routes: listRoutesForPipeline(db, item.pipelineId) }
  );
}

/**
 * The same question, asked so that "it is on the current version" is an
 * answer rather than a copy of the live graph.
 *
 * **Null means "read the live graph"**, and the callers that want this
 * spelling are the ones whose live answer is not simply
 * `listStepsForPipeline` — the supervisor is handed the steps it has
 * already read, and the two must stay the same call. Substituting a
 * freshly-read live graph there would quietly change what an ordinary
 * run routes by, which is the one thing this story must not do.
 */
export function boundGraphForItem(db: Db, item: BoundItem): BoundGraph | null {
  if (item.pipelineId === null || item.pipelineVersionId === null) return null;

  const pipeline = db.select({ currentVersionId: pipelines.currentVersionId }).from(pipelines).where(eq(pipelines.id, item.pipelineId)).get();
  if (!pipeline || pipeline.currentVersionId === item.pipelineVersionId) return null;

  const row = db.select().from(pipelineVersions).where(eq(pipelineVersions.id, item.pipelineVersionId)).get();
  const snapshot = row ? snapshotOf(row) : null;
  // A version EO cannot read is a bug in EO; stranding a running item on
  // it would be a second one, so the live graph answers.
  if (!snapshot || !row) return null;

  return { number: row.number, ...graphOf(snapshot) };
}

/** As much of an item as a version question needs. */
export interface BoundItem {
  pipelineId: string | null;
  stepId?: string | null;
  pipelineVersionId: string | null;
}

/** An older version's graph, with the number a refusal has to name. */
export interface BoundGraph {
  number: number;
  steps: PipelineStep[];
  routes: StepRoute[];
}

/** A parsed snapshot as the rest of EO's types spell it. */
function graphOf(snapshot: PipelineGraphSnapshot): { steps: PipelineStep[]; routes: StepRoute[] } {
  return {
    steps: snapshot.steps.map((step) => ({ ...step, pipelineId: step.pipelineId as Uuid, ownerPersonId: step.ownerPersonId as Uuid | null })),
    routes: snapshot.routes.map((route) => ({ ...route, id: route.id as Uuid, pipelineId: route.pipelineId as Uuid })),
  };
}

/**
 * The step an item is standing on, **as its own version defines it**
 * (EO-327, ARCHITECTURE.md, "Publish, lock and versions").
 *
 * This is the other half of "an item finishes on the version it entered
 * on", and the half that is about *running* rather than routing. A step
 * is not only a place: it carries the role dispatched there, the action,
 * the prompt, whether it plans first, and the buttons a person is
 * offered. A save that changes any of those under an item mid-flight
 * would change what happens to that item — the sharpest case being a
 * human step whose decisions were renamed, where the person is shown
 * buttons the item's own routes have no branch for, and `items:decide`
 * refuses the answer they give.
 *
 * So every reader that means "the step this item is on" resolves it
 * here. A step the bound version does not have falls back to the live
 * row rather than answering nothing: that combination is refused at the
 * transition now, but rows written before it was refused still exist,
 * and an item nothing can dispatch is worse than one dispatched by the
 * current graph.
 */
export function stepForItem(db: Db, item: BoundItem): PipelineStep | undefined {
  if (item.stepId === null || item.stepId === undefined) return undefined;
  const bound = boundGraphForItem(db, item);
  return bound?.steps.find((step) => step.id === item.stepId) ?? getStep(db, item.stepId);
}

/**
 * Whether this item's own version has such a step — what a move made by
 * hand must not go outside (EO-327, ARCHITECTURE.md, "Publish, lock and versions").
 *
 * True for everything on the current version, which is nearly every
 * item and every item at all until somebody saves. False only for a
 * step that did not exist when this item entered: putting it there
 * would leave its next result with no route out and no definition to
 * run, which is the strand this story exists to prevent, met from the
 * other side.
 */
export function versionHasStep(db: Db, item: BoundItem, stepId: string): boolean {
  const bound = boundGraphForItem(db, item);
  return bound === null || bound.steps.some((step) => step.id === stepId);
}

/**
 * The steps one version of a pipeline holds (EO-567): the live rows for
 * the current version, which is what an item bound to it routes by, and
 * the version's own document for an older one — `boundGraphForItem`'s
 * reading, asked of a version rather than of an item.
 */
export function stepsOfVersion(db: Db, pipelineId: string, versionId: string): PipelineStep[] {
  const bound = boundGraphForItem(db, { pipelineId, pipelineVersionId: versionId });
  return bound?.steps ?? listStepsForPipeline(db, pipelineId);
}

/**
 * Binds one item to a version of the pipeline it is already on
 * (EO-567, ARCHITECTURE.md, "Publish, lock and versions").
 *
 * The binding and nothing else: not the step, not the pipeline, and so
 * not a transition (invariant #1 is not in play — `items.stepId` is not
 * written). `updatedAt` moves, for `catchUpCurrentVersion`'s reason: the
 * binding is part of the item a record pages to its devices by it, and
 * a rebinding that left it alone would reach nobody's replica.
 *
 * The one caller is `record/versionMove.ts`, which has already asked
 * whether the version exists, belongs to this item's pipeline and has
 * the step the item is on.
 */
export function bindItemToVersion(db: Db, itemId: string, versionId: string): void {
  db.update(items).set({ pipelineVersionId: versionId, updatedAt: Date.now() }).where(eq(items.id, itemId)).run();
}

/**
 * The step definitions the scheduler must dispatch these items by,
 * keyed by item id (EO-327).
 *
 * Only the items on an older version appear: a miss means "the live
 * row", which is what the scheduler has always used and what every item
 * on the current version wants. Grouped by version so a board with
 * forty items finishing on v6 parses one snapshot rather than forty.
 *
 * The map exists because the scheduler indexes steps by
 * `(pipelineId, stepId)`, and two items on one step under two versions
 * are two different definitions — which that index cannot hold. Data
 * rather than a lookup function, for `stepsElsewhere`'s reason: the
 * engine is pure and cannot go and read a version.
 */
export function stepsByItemVersion(db: Db, items: readonly BoundItem[] & readonly { id: string }[]): Map<string, PipelineStep> {
  const byVersion = new Map<string, BoundGraph | null>();
  const resolved = new Map<string, PipelineStep>();

  for (const item of items) {
    if (item.pipelineVersionId === null || item.stepId === null || item.stepId === undefined) continue;
    if (!byVersion.has(item.pipelineVersionId)) byVersion.set(item.pipelineVersionId, boundGraphForItem(db, item));
    const bound = byVersion.get(item.pipelineVersionId) ?? null;
    if (bound === null) continue;
    const step = bound.steps.find((candidate) => candidate.id === item.stepId);
    if (step) resolved.set(item.id, step);
  }
  return resolved;
}

/**
 * How many live items are finishing on each version of this pipeline
 * other than the current one — what the banner counts (ARCHITECTURE.md, "Publish, lock and
 * versions").
 *
 * Archived items are left out, unlike the strand refusal's count: this
 * is a sentence about a board, and "3 items finish on v6" that includes
 * work nobody can see is a number a person cannot reconcile with what
 * is in front of them.
 */
export function itemsOnOlderVersions(db: Db, pipelineId: string): { versionId: string; number: number; items: number }[] {
  const current = db.select({ currentVersionId: pipelines.currentVersionId }).from(pipelines).where(eq(pipelines.id, pipelineId)).get()?.currentVersionId ?? null;
  const counts = db
    .select({ versionId: items.pipelineVersionId, count: sql<number>`count(*)` })
    .from(items)
    .where(and(eq(items.pipelineId, pipelineId), isNull(items.archivedAt)))
    .groupBy(items.pipelineVersionId)
    .all();

  const numbers = new Map(listPipelineVersions(db, pipelineId).map((version) => [version.id as string, version.number] as const));
  return counts
    .flatMap((row) => {
      if (row.versionId === null || row.versionId === current) return [];
      const number = numbers.get(row.versionId);
      return number === undefined ? [] : [{ versionId: row.versionId, number, items: row.count }];
    })
    .sort((a, b) => b.number - a.number);
}

/**
 * The older versions of this pipeline that unfinished work still runs
 * on, each with the steps it defines and how many items that is
 * (EO-425).
 *
 * `itemsOnOlderVersions` counts for a banner; this answers "whose
 * definitions are still in force", which is a narrower question in one
 * way and a wider one in another. Narrower, because an item standing on
 * a terminal step of its version is done: nothing dispatches it again,
 * and counting it would keep a version "in use" for ever. Wider, because
 * it hands back the steps — an item mid-flight is dispatched by its own
 * version's definition of whichever step it reaches next
 * (`stepForItem`), so every step of that version is one it may yet run.
 *
 * Archived items are left out, as they are next door: what this is used
 * to refuse has to be something a person can see and clear.
 *
 * The version's routes come with its steps (EO-427): an item bound to it
 * is routed by them, so what a change of an action's result keys does to
 * that item is a question about these routes and not the live graph's.
 *
 * A version whose document cannot be read is skipped, for
 * `boundGraphForItem`'s reason — its items are answered by the live
 * graph, which the caller already has.
 */
export function olderVersionsInUse(db: Db, pipelineId: string): { number: number; steps: PipelineStep[]; routes: StepRoute[]; items: number }[] {
  const current = db.select({ currentVersionId: pipelines.currentVersionId }).from(pipelines).where(eq(pipelines.id, pipelineId)).get()?.currentVersionId ?? null;
  const standing = db
    .select({ versionId: items.pipelineVersionId, stepId: items.stepId })
    .from(items)
    .where(and(eq(items.pipelineId, pipelineId), isNull(items.archivedAt), isNotNull(items.pipelineVersionId), isNotNull(items.stepId)))
    .all();

  const inUse: { number: number; steps: PipelineStep[]; routes: StepRoute[]; items: number }[] = [];
  for (const versionId of new Set(standing.map((row) => row.versionId))) {
    if (versionId === null || versionId === current) continue;
    const row = db.select().from(pipelineVersions).where(eq(pipelineVersions.id, versionId)).get();
    const snapshot = row ? snapshotOf(row) : null;
    if (!row || !snapshot) continue;

    const { steps, routes } = graphOf(snapshot);
    const unfinished = standing.filter((item) => {
      if (item.versionId !== versionId || item.stepId === null) return false;
      // The step as this version defines it, and the live row where the
      // version has none — the same fallback a dispatch makes.
      const step = steps.find((candidate) => candidate.id === item.stepId) ?? getStep(db, item.stepId);
      return step !== undefined && !step.isTerminal;
    }).length;
    if (unfinished > 0) inUse.push({ number: row.number, steps, routes, items: unfinished });
  }
  return inUse.sort((a, b) => b.number - a.number);
}

/**
 * How many live items on this pipeline are bound to one particular
 * version (EO-329, ARCHITECTURE.md, "Publish, lock and versions").
 *
 * `itemsOnOlderVersions` next door answers the banner's question and
 * excludes the current version by definition — right for "3 items
 * finish on v6", which is about the past. Publish asks it of the
 * version that is current *now*, because that is precisely the work a
 * publish is about to leave behind, and it has not been left behind
 * yet.
 *
 * Archived items are left out, for the same reason they are there: this
 * is a sentence about work somebody can see.
 */
export function itemsOnVersion(db: Db, pipelineId: string, versionId: string): number {
  const row = db
    .select({ count: sql<number>`count(*)` })
    .from(items)
    .where(and(eq(items.pipelineId, pipelineId), eq(items.pipelineVersionId, versionId), isNull(items.archivedAt)))
    .get();
  return row?.count ?? 0;
}

/**
 * Retired steps of this pipeline that nothing can reach any more
 * (EO-327, ARCHITECTURE.md, "Publish, lock and versions").
 *
 * The question a step's *belongings* turn on. A step removed from a
 * pipeline is retired rather than dropped, precisely so an item
 * finishing on an older version can still be routed onto it — and
 * anything scoped to that step by id, which today is its module
 * secrets, has to survive exactly as long as that possibility does.
 * Discarding them at the moment of removal was right when removal meant
 * the row was gone; now it means a ghost step's run reaches for a
 * credential EO threw away, and fails with the module's name on it.
 *
 * Unreachable means both halves, archived work included: nothing is
 * standing on the step, and no item is bound to a version whose document
 * contains it. An archived item counts because restoring one is a thing
 * a person may do, and it would come back standing exactly where it was.
 *
 * Asked after every save rather than only of the steps that save
 * removed, which is what gives the sweep a second chance: a step whose
 * last ghost item finished months ago is cleared by the next ordinary
 * edit to its pipeline.
 */
export function unreachableRetiredSteps(db: Db, pipelineId: string): string[] {
  const retired = listRetiredStepsForPipeline(db, pipelineId).map((entry) => entry.step.id);
  if (retired.length === 0) return [];

  // **Every item in the installation**, not this pipeline's (EO-327).
  // A route is resolved against the *sending* item's version, so a
  // hand-off drawn in an older version of some other pipeline can still
  // name a step this one has retired — `versionForArrival` binds that
  // arrival to the version that has the step, and the module it runs
  // there reaches for the secret filed against its id. Asking only about
  // this pipeline's own items is how that credential gets thrown away
  // while the item that will need it is still two steps upstream in
  // another pipeline.
  const rows = db.select({ stepId: items.stepId, versionId: items.pipelineVersionId }).from(items).all();

  const occupied = new Set(rows.flatMap((row) => (row.stepId === null ? [] : [row.stepId])));
  // One parse per version rather than per item: forty items finishing on
  // v6 ask about v6 once. The whole installation's bound versions, which
  // is a handful on any real database — and this is asked once per save.
  const reachableFrom = new Set<string>();
  for (const versionId of new Set(rows.flatMap((row) => (row.versionId === null ? [] : [row.versionId])))) {
    const row = db.select().from(pipelineVersions).where(eq(pipelineVersions.id, versionId)).get();
    const snapshot = row ? snapshotOf(row) : null;
    // A version EO cannot read is one whose items route by the live
    // graph, which has no retired step in it — so it reaches none.
    if (!snapshot) continue;
    // What that version can put an item on: the steps it has, and
    // wherever its routes point — which is how a hand-off reaches a step
    // belonging to another pipeline entirely. The two sentinels land in
    // here too and match no step id, which costs nothing.
    for (const step of snapshot.steps) reachableFrom.add(step.id);
    for (const route of snapshot.routes) reachableFrom.add(route.target);
  }

  return retired.filter((stepId) => !occupied.has(stepId) && !reachableFrom.has(stepId));
}

/**
 * Which of these items are standing on a terminal step **of their own
 * version** (EO-327, ARCHITECTURE.md, "Publish, lock and versions").
 *
 * "Finished" is not a fact about the pipeline, it is a fact about the
 * item — and the two come apart the moment somebody marks a step
 * terminal, or stops marking one. An item that entered on v1 and is
 * sitting on a step v2 has just made terminal has not finished: the
 * version it agreed to has more for it to do. The mirror is worse in
 * the other direction — an item that *did* finish on v1's terminal step
 * would be reported as still running because v2 unmarked it, and would
 * go on blocking everything that waits on it.
 *
 * A set of item ids, because every reader of this asks about a list:
 * what a dependency is waiting for, how far a feature has got, what is
 * left in the inbox, what the archive may sweep. One pass over the
 * versions rather than one query per item, for `stepsByItemVersion`'s
 * reason.
 *
 * An item on no step is not here: a feature is finished when its
 * stories are, which is `featureIsDone`'s question and not this one's.
 */
export function finishedItemIds(db: Db, rows: readonly (BoundItem & { id: string })[]): Set<string> {
  const bound = stepsByItemVersion(db, rows);
  const liveTerminal = new Set(
    listPipelineSteps(db)
      .filter((step) => step.isTerminal)
      .map((step) => step.id),
  );

  const finished = new Set<string>();
  for (const item of rows) {
    if (item.stepId === null || item.stepId === undefined) continue;
    const own = bound.get(item.id);
    // The item's own version's answer where there is one, and the live
    // row's where the item is on the current version — which is every
    // item until somebody edits a pipeline.
    if (own ? own.isTerminal : liveTerminal.has(item.stepId)) finished.add(item.id);
  }
  return finished;
}

/**
 * One field of the step an item stands on, **as its own version defines
 * it**, as a SQL expression over the `items` row a query is reading
 * (EO-539).
 *
 * `stepForItem`, `stepsByItemVersion` and `finishedItemIds` ask this of
 * rows already read; this asks it inside the read, so a list narrowed by
 * step name or by finished-or-not is narrowed by the database rather than
 * by hydrating every row and throwing most away. It has to give the same
 * answer as they do, and is written in their order:
 *
 * - an item on an older version of its pipeline — its version is not
 *   the pipeline's current one — reads the step from that version's
 *   snapshot, where the snapshot has it;
 * - every other item, and one whose step its snapshot lacks, reads the
 *   live row;
 * - and for `name`, a step there is no row for at all is called by its
 *   id, which is what the board shows for one (`stepLabel`).
 *
 * The one thing it does not repeat is the schema check `snapshotOf`
 * makes before trusting a snapshot: a version EO cannot parse is a bug
 * EO wrote, and the board falls back to the live graph for it. This reads
 * the field from the JSON regardless. `itemListFilters.test.ts` holds the
 * two readings to each other across a rename and a re-marked terminal.
 *
 * `isTerminal` answers 1 for a terminal step and 0 or null otherwise.
 */
export function boundStepFieldSql(field: "name" | "isTerminal"): SQL {
  const snapshotPath = sql.raw(field === "name" ? "'$.name'" : "'$.isTerminal'");
  const liveColumn = sql.raw(field === "name" ? '"live_step"."name"' : '"live_step"."is_terminal"');
  const bound = sql`(select json_extract("bound_step"."value", ${snapshotPath})
    from "pipeline_versions" as "bound_version"
    inner join "pipelines" as "bound_pipeline" on "bound_pipeline"."id" = ${items.pipelineId}
    inner join json_each("bound_version"."steps") as "bound_step"
    where "bound_version"."id" = ${items.pipelineVersionId}
      and "bound_pipeline"."current_version_id" is not "bound_version"."id"
      and json_extract("bound_step"."value", '$.id') = ${items.stepId}
    limit 1)`;
  const live = sql`(select ${liveColumn} from "pipeline_steps" as "live_step" where "live_step"."id" = ${items.stepId})`;
  return field === "name" ? sql`coalesce(${bound}, ${live}, ${items.stepId})` : sql`coalesce(${bound}, ${live}, 0)`;
}

/** The same question about one item, for the readers that hold exactly one. */
export function isFinishedOnItsVersion(db: Db, item: BoundItem & { id: string }): boolean {
  return stepForItem(db, item)?.isTerminal === true;
}

// ── Retention (EO-359) ────────────────────────────────────────

/** Where "Pipeline versions to keep" is stored, beside `project.archiveAfterDays`. */
export const PIPELINE_VERSIONS_TO_KEEP_KEY = "pipelines.versionsToKeep";

/**
 * How many versions of each pipeline this installation keeps.
 *
 * Wrapped in an object for `archiveAfterDays`' reason, and parsed rather
 * than cast: a row somebody wrote by hand that says `0` or `2.5` is not
 * a limit EO can honour, and the default is a better answer to it than
 * deleting every version but the one in use.
 */
export function pipelineVersionsToKeep(db: Db): number {
  const stored = getSetting<{ count?: unknown }>(db, PIPELINE_VERSIONS_TO_KEEP_KEY, { count: DEFAULT_PIPELINE_VERSIONS_TO_KEEP });
  return PipelineVersionsToKeepSchema.safeParse(stored.count).data ?? DEFAULT_PIPELINE_VERSIONS_TO_KEEP;
}

export function setPipelineVersionsToKeep(db: Db, count: number): void {
  setSetting(db, PIPELINE_VERSIONS_TO_KEEP_KEY, { count: PipelineVersionsToKeepSchema.parse(count) });
}

/**
 * Deletes this pipeline's oldest versions beyond `keep`, and answers
 * with the numbers it deleted (EO-359).
 *
 * The newest `keep` by number stay. Of the rest, a version is kept
 * anyway when anything still stands on it:
 *
 * - **the current version** — the live graph's own document, which an
 *   organisation's rollback can point back at an older number;
 * - **any version an item is bound to**, archived ones included and
 *   items of any pipeline: an archived item can be restored and would
 *   come back finishing on exactly the version it had, and an item
 *   handed over from another pipeline is bound to a version of this one
 *   (`versionForArrival`);
 * - **the version a diverged copy was based on, and the one the
 *   organisation published** — both are pointers into this history that
 *   the lines on the configure screen read;
 * - **the newest version that still holds a retired step something can
 *   reach** — a hand-off drawn in another pipeline's older version can
 *   still deliver work onto that step, and `versionForArrival` binds the
 *   arrival to the version that has it;
 * - **the highest number the pipeline has used**, always. `highestNumber`
 *   is the newest row, so deleting it would hand its number out again —
 *   and "finishes on v6" would become a sentence with two answers. The
 *   newest `keep` include it whenever `keep` is at least one; this is the
 *   guard that does not depend on that.
 *
 * Applied after a save, so a lowered limit takes effect at each
 * pipeline's next save rather than all at once. Nothing else about a
 * version is rewritten: the rows that stay are exactly as they were.
 */
export function prunePipelineVersions(db: Db, pipelineId: string, keep: number): number[] {
  const limit = Math.max(1, Math.floor(keep));
  const versions = listPipelineVersions(db, pipelineId);
  if (versions.length <= limit) return [];

  const older = versions.slice(0, versions.length - limit);
  const highest = versions[versions.length - 1];
  const kept = new Set<string>(highest ? [highest.id] : []);

  const pipeline = db
    .select({ currentVersionId: pipelines.currentVersionId, divergedFromVersionId: pipelines.divergedFromVersionId })
    .from(pipelines)
    .where(eq(pipelines.id, pipelineId))
    .get();
  if (pipeline?.currentVersionId) kept.add(pipeline.currentVersionId);
  if (pipeline?.divergedFromVersionId) kept.add(pipeline.divergedFromVersionId);

  for (const row of db
    .select({ versionId: publishedSections.versionId })
    .from(publishedSections)
    .where(and(eq(publishedSections.subjectId, pipelineId), isNotNull(publishedSections.versionId)))
    .all()) {
    if (row.versionId !== null) kept.add(row.versionId);
  }

  const candidates = older.filter((version) => !kept.has(version.id));
  if (candidates.length === 0) return [];

  // Every item in the installation, archived included — see above.
  for (const row of db
    .selectDistinct({ versionId: items.pipelineVersionId })
    .from(items)
    .where(inArray(
      items.pipelineVersionId,
      candidates.map((version) => version.id),
    ))
    .all()) {
    if (row.versionId !== null) kept.add(row.versionId);
  }

  // A retired step something can still deliver work onto keeps the
  // newest version that defines it.
  const unreachable = new Set(unreachableRetiredSteps(db, pipelineId));
  const reachableRetired = listRetiredStepsForPipeline(db, pipelineId)
    .map((entry) => entry.step.id)
    .filter((stepId) => !unreachable.has(stepId));
  if (reachableRetired.length > 0) {
    const snapshots = new Map(versions.map((version) => [version.id, versionSnapshot(db, version.id)] as const));
    for (const stepId of reachableRetired) {
      const holder = [...versions].reverse().find((version) => snapshots.get(version.id)?.steps.some((step) => step.id === stepId) ?? false);
      if (holder) kept.add(holder.id);
    }
  }

  const doomed = candidates.filter((version) => !kept.has(version.id));
  if (doomed.length === 0) return [];
  db.delete(pipelineVersions)
    .where(inArray(
      pipelineVersions.id,
      doomed.map((version) => version.id),
    ))
    .run();
  return doomed.map((version) => version.number);
}
