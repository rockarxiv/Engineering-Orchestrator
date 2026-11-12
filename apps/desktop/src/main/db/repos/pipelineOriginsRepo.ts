import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { boardHolding, documentBoards, PipelineExportSchema, uuidv7, type PipelineExport } from "@eo/core";
import type { Db } from "../client.js";
import { pipelines, templateVersions } from "../schema.js";

/**
 * Where a pipeline came from (EO-531).
 *
 * A pipeline made from a template records the template's slug, the
 * version, and a snapshot of that version — its *base* — so a later
 * release can compare three things: the base, the pipeline as the
 * person has it now, and the new template version.
 *
 * The base is read from the database and never from the file the app
 * ships. Once recorded, a release that drops an old file, or a fetched
 * template that was never a file here at all, still has its base.
 */
export interface PipelineOrigin {
  pipelineId: string;
  slug: string;
  version: string;
  /** The stored snapshot's id, a `template_versions.id`. */
  baseId: string;
  /** The template version as it was when this pipeline was made from it, read from the database. */
  base: PipelineExport;
  /**
   * The template's step ids, each mapped to this pipeline's own.
   *
   * An import re-mints step ids, so this is what a comparison by step id
   * reads through. A template step with no entry is one this pipeline
   * does not have.
   */
  stepIds: Record<string, string>;
  /**
   * When the base last moved (EO-534) — what the person's edits "since the
   * base" are counted from. Null where it was never kept: an origin from
   * before it was, or a backfilled one, whose every version is the person's.
   */
  baseMovedAt: number | null;
}

/** A template document: a pack whose `template` block is filled in. */
export type TemplateDocument = PipelineExport & { template: NonNullable<PipelineExport["template"]> };

export function isTemplateDocument(document: PipelineExport): document is TemplateDocument {
  return document.template !== null;
}

/** sha256 of the document as it is stored. */
function digestOf(document: PipelineExport): string {
  return createHash("sha256").update(JSON.stringify(document)).digest("hex");
}

/**
 * The stored snapshot of this document, written if it is not there yet.
 *
 * One row per distinct document: every pipeline made from the same
 * template version points at the same snapshot. A row is never updated.
 */
export function storeTemplateSnapshot(db: Db, document: TemplateDocument): string {
  const { slug, version } = document.template;
  const digest = digestOf(document);
  const existing = db
    .select({ id: templateVersions.id })
    .from(templateVersions)
    .where(and(eq(templateVersions.slug, slug), eq(templateVersions.version, version), eq(templateVersions.digest, digest)))
    .get();
  if (existing !== undefined) return existing.id;

  const id = uuidv7() as string;
  db.insert(templateVersions).values({ id, slug, version, digest, document, createdAt: Date.now() }).run();
  return id;
}

export interface RecordPipelineOriginInput {
  pipelineId: string;
  /** The template version this pipeline is made from. Stored as its base. */
  document: TemplateDocument;
  /** The template's step ids, each mapped to this pipeline's own. */
  stepIds: Record<string, string>;
  /**
   * When the base moved to this document (EO-534): now, unless the caller
   * says otherwise. The startup backfill says null — the pipeline was made
   * from this base long before anybody recorded it — and a pipeline
   * arriving with its project keeps the moment it carries.
   */
  baseMovedAt?: number | null;
}

/**
 * Records where a pipeline came from: the slug, the version, the stored
 * base and the step map, together.
 *
 * Does not stamp `updated_at`. That column is what carries a pipeline's
 * change from a record to its replicas, and an origin is this
 * installation's own note about the pipeline rather than a change to it.
 */
export function recordPipelineOrigin(db: Db, input: RecordPipelineOriginInput): void {
  const baseId = storeTemplateSnapshot(db, input.document);
  db.update(pipelines)
    .set({
      templateSlug: input.document.template.slug,
      templateVersion: input.document.template.version,
      templateBaseId: baseId,
      templateStepIds: input.stepIds,
      templateBaseMovedAt: input.baseMovedAt === undefined ? Date.now() : input.baseMovedAt,
    })
    .where(eq(pipelines.id, input.pipelineId))
    .run();
}

/**
 * Where this pipeline came from, or null if it has no origin.
 *
 * The base is read from `template_versions`, never from the app's
 * shipped files. A row whose snapshot is missing or no longer parses
 * reads as no origin: a pipeline compared against a base EO cannot read
 * would be compared against a guess.
 */
export function getPipelineOrigin(db: Db, pipelineId: string): PipelineOrigin | null {
  const row = db
    .select({
      slug: pipelines.templateSlug,
      version: pipelines.templateVersion,
      baseId: pipelines.templateBaseId,
      stepIds: pipelines.templateStepIds,
      baseMovedAt: pipelines.templateBaseMovedAt,
    })
    .from(pipelines)
    .where(eq(pipelines.id, pipelineId))
    .get();
  if (row === undefined || row.slug === null || row.version === null || row.baseId === null) return null;

  const snapshot = db.select({ document: templateVersions.document }).from(templateVersions).where(eq(templateVersions.id, row.baseId)).get();
  if (snapshot === undefined) return null;
  const base = PipelineExportSchema.safeParse(snapshot.document);
  if (!base.success) return null;

  return { pipelineId, slug: row.slug, version: row.version, baseId: row.baseId, base: base.data, stepIds: stepIdsOf(row.stepIds), baseMovedAt: row.baseMovedAt };
}

/**
 * Which of its template's boards a pipeline is, by the board's key — null
 * for the first board — or undefined where its origin cannot say (EO-762).
 *
 * Read of the base and the step map recorded with it, always together,
 * and never of a newer version: a board keeps its key from one version
 * to the next whatever its steps become (`sameBoard`).
 */
export function originBoardKey(origin: Pick<PipelineOrigin, "base" | "stepIds">): string | null | undefined {
  const index = boardHolding(origin.base, Object.keys(origin.stepIds));
  return index === null ? undefined : documentBoards(origin.base)[index]?.key;
}

/** A pipeline made from a template, as far as which of its boards it is (EO-762). */
export interface TemplateBoardHolder {
  pipelineId: string;
  projectId: string | null;
  /** Its origin's step map: the template's step ids to its own. */
  stepIds: Record<string, string>;
}

/**
 * Every pipeline made from this template in this project — the same
 * project, or none for none — archived ones included and trials never
 * (EO-762).
 *
 * The boards of one installation of a template: a template of several
 * boards installs them together into one project, and a route on one
 * names the others' steps as that project holds them. Archived boards
 * count, so a board somebody archived is not made again. Read without
 * the stored snapshots, which are large and nobody here needs.
 */
export function templateBoardHolders(db: Db, slug: string, projectId: string | null): TemplateBoardHolder[] {
  return db
    .select({ pipelineId: pipelines.id, projectId: pipelines.projectId, stepIds: pipelines.templateStepIds })
    .from(pipelines)
    .where(and(eq(pipelines.templateSlug, slug), isNull(pipelines.trialAt), projectId === null ? isNull(pipelines.projectId) : eq(pipelines.projectId, projectId)))
    .all()
    .map((row) => ({ pipelineId: row.pipelineId, projectId: row.projectId, stepIds: stepIdsOf(row.stepIds) }));
}

/** A stored template snapshot by its `template_versions.id`, or null where there is none or it no longer parses. */
export function getTemplateSnapshot(db: Db, id: string): PipelineExport | null {
  const snapshot = db.select({ document: templateVersions.document }).from(templateVersions).where(eq(templateVersions.id, id)).get();
  if (snapshot === undefined) return null;
  const parsed = PipelineExportSchema.safeParse(snapshot.document);
  return parsed.success ? parsed.data : null;
}

/**
 * The ids of every pipeline, archived ones included, that has no origin
 * yet. Never a trial (EO-582): a draft under test is no gallery
 * template's copy, whatever its graph happens to match.
 */
export function pipelinesWithoutOrigin(db: Db): string[] {
  return db
    .select({ id: pipelines.id })
    .from(pipelines)
    .where(and(isNull(pipelines.templateSlug), isNull(pipelines.trialAt)))
    .all()
    .map((row) => row.id);
}

/** The stored step map, keeping only string-to-string entries. */
function stepIdsOf(value: unknown): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const map: Record<string, string> = {};
  for (const [key, id] of Object.entries(value)) {
    if (typeof id === "string") map[key] = id;
  }
  return map;
}

/**
 * The template update EO last applied to a pipeline (EO-536): the
 * template version it took, the pipeline version it was filed as, and
 * when.
 */
export interface AppliedTemplateUpdate {
  version: string;
  pipelineVersion: number;
  at: number;
}

/**
 * Records the update EO just applied, in the transaction that applied it.
 *
 * Kept on the pipeline rather than read back from the version it filed:
 * a later save prunes versions, and the head's "Updated to" must not
 * vanish with one. Does not stamp `updated_at`, for
 * `recordPipelineOrigin`'s reason.
 */
export function recordAppliedTemplateUpdate(db: Db, pipelineId: string, applied: AppliedTemplateUpdate): void {
  db.update(pipelines).set({ templateApplied: { ...applied } }).where(eq(pipelines.id, pipelineId)).run();
}

/** The update EO last applied to this pipeline, or null where none was, or the stored value is not one. */
export function getAppliedTemplateUpdate(db: Db, pipelineId: string): AppliedTemplateUpdate | null {
  const row = db.select({ applied: pipelines.templateApplied }).from(pipelines).where(eq(pipelines.id, pipelineId)).get();
  const value: unknown = row?.applied ?? null;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const { version, pipelineVersion, at } = value as Record<string, unknown>;
  if (typeof version !== "string" || typeof pipelineVersion !== "number" || typeof at !== "number") return null;
  return { version, pipelineVersion, at };
}
