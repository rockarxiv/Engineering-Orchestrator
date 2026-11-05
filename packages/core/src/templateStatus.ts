import { z } from "zod";

/**
 * Where a pipeline came from, and whether its template has news for it
 * (EO-536, ARCHITECTURE.md, "Template versions and origins") — what the
 * head of a pipeline's board and Graph view says.
 *
 * Three facts, each optional, read where the pipeline's updates are
 * held: the organisation's record for a pipeline it holds, this
 * database for every other.
 *
 * - **origin** — the template and the version the pipeline's base is.
 *   Null for a pipeline made from no template, and then nothing else is
 *   said either.
 * - **updated** — an update EO applied, while it is recent
 *   (`TEMPLATE_UPDATE_RECENT_MS`), with the release notes of the version
 *   it took.
 * - **waiting** — a held update: the version it holds, how many keys
 *   conflict, and where pressing it goes — the chat Fix with assistant
 *   opened, or the notice when no chat has been opened yet.
 */

/** How long "Updated to vN" stays on a pipeline's head after EO applied it: a few days. */
export const TEMPLATE_UPDATE_RECENT_MS = 3 * 24 * 60 * 60 * 1000;

export const PipelineTemplateOriginSchema = z.object({
  slug: z.string(),
  /** The template's title, as the version it names calls it. */
  title: z.string(),
  /** The version the pipeline's base is. */
  version: z.string(),
});
export type PipelineTemplateOrigin = z.infer<typeof PipelineTemplateOriginSchema>;

export const PipelineTemplateUpdatedSchema = z.object({
  /** The template version EO applied. */
  version: z.string(),
  /** The pipeline version the update was filed as. */
  pipelineVersion: z.number().int().positive(),
  /** When it was applied. */
  at: z.number(),
  /** The release notes of the version it took, as the template's history writes them. Empty where it wrote none. */
  notes: z.string(),
});
export type PipelineTemplateUpdated = z.infer<typeof PipelineTemplateUpdatedSchema>;

export const PipelineTemplateWaitingSchema = z.object({
  conflictId: z.string(),
  /** The base's version. */
  fromVersion: z.string(),
  /** The version that was held. */
  toVersion: z.string(),
  /** How many keys conflict. */
  conflicts: z.number().int().nonnegative(),
  /** Why the merge would not validate, counted, where that is what held it rather than a conflict. */
  problems: z.number().int().nonnegative(),
  /** The chat Fix with assistant opened for it, where that chat still exists. */
  chatId: z.string().nullable(),
  /** The notice, where it was posted: the comment and the thread it is on. */
  notice: z.object({ itemId: z.string(), commentId: z.string() }).nullable(),
});
export type PipelineTemplateWaiting = z.infer<typeof PipelineTemplateWaitingSchema>;

export const PipelineTemplateStatusSchema = z.object({
  origin: PipelineTemplateOriginSchema.nullable(),
  updated: PipelineTemplateUpdatedSchema.nullable(),
  waiting: PipelineTemplateWaitingSchema.nullable(),
  /** Why nothing could be said: the record that holds the pipeline could not be asked. Null whenever the answer is the truth. */
  problem: z.string().nullable(),
});
export type PipelineTemplateStatus = z.infer<typeof PipelineTemplateStatusSchema>;

/** What a pipeline with no origin, or one nobody could ask about, answers. */
export const NO_TEMPLATE_STATUS: PipelineTemplateStatus = { origin: null, updated: null, waiting: null, problem: null };

/** How a template version is written short, beside its title. */
export function templateVersionLabel(version: string): string {
  return `v${version}`;
}

/** "From Software feature to merge v4". */
export function templateOriginLabel(origin: Pick<PipelineTemplateOrigin, "title" | "version">): string {
  return `From ${origin.title} ${templateVersionLabel(origin.version)}`;
}

/** "Updated to v5". */
export function templateUpdatedLabel(updated: Pick<PipelineTemplateUpdated, "version">): string {
  return `Updated to ${templateVersionLabel(updated.version)}`;
}

/** "Update waiting: 1 conflict" — or, for a merge held because it would not validate, its problems. */
export function templateWaitingLabel(waiting: Pick<PipelineTemplateWaiting, "conflicts" | "problems">): string {
  if (waiting.conflicts === 0 && waiting.problems > 0) return `Update waiting: ${waiting.problems} ${waiting.problems === 1 ? "problem" : "problems"}`;
  return `Update waiting: ${waiting.conflicts} ${waiting.conflicts === 1 ? "conflict" : "conflicts"}`;
}

const TEMPLATE_UPDATE_AUTHOR_PREFIX = "template:";

/**
 * The author a pipeline version is filed under when a template update
 * wrote it (EO-532): `template:<slug>@<version>`.
 *
 * `created_by` otherwise holds a person's id, or null for a version EO
 * took itself. An applied template update is neither — nobody pressed
 * Publish, and it is not EO's own bookkeeping either — so it says which
 * template version did it, and `templateUpdateOfAuthor` reads it back.
 */
export function templateUpdateAuthor(slug: string, version: string): string {
  return `${TEMPLATE_UPDATE_AUTHOR_PREFIX}${slug}@${version}`;
}

/**
 * The template update a version's `createdBy` names, or null for a
 * version a person or EO filed. `version` is null where the author is
 * a template update's but names no version this build can read.
 */
export function templateUpdateOfAuthor(createdBy: string | null): { slug: string; version: string | null } | null {
  if (createdBy === null || !createdBy.startsWith(TEMPLATE_UPDATE_AUTHOR_PREFIX)) return null;
  const named = createdBy.slice(TEMPLATE_UPDATE_AUTHOR_PREFIX.length);
  const at = named.lastIndexOf("@");
  if (at <= 0) return { slug: named, version: null };
  return { slug: named.slice(0, at), version: named.slice(at + 1) };
}
