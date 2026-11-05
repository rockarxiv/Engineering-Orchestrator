import { z } from "zod";
import { PipelineStepViewSchema, StepRouteViewSchema } from "./ipc-schemas.js";

/**
 * A held template update, as the assistant reads it (EO-534,
 * ARCHITECTURE.md, "Template versions and origins").
 *
 * What `pipeline_update_conflict` answers on EO's administrative server:
 * everything a resolution needs, read from the database rather than
 * from anything a brief or a person said. The template and both
 * versions, the release notes, the three graphs — the base the pipeline
 * was made from, the pipeline as the person has it now, the new
 * template version — every key somebody changed with its three values
 * and which side changed it, conflicts first, and the person's own edits
 * since the base, from the pipeline's versions.
 *
 * Every graph is in the pipeline's own step ids, so a draft built from
 * it is a draft of this pipeline: a step the template adds keeps the
 * template's id, which is the id the new step gets unless another
 * pipeline already holds it (`takenStepIds`).
 */

/** One of the three graphs, in this pipeline's step ids. */
export const UpdateConflictGraphSchema = z.object({
  steps: z.array(PipelineStepViewSchema),
  routes: z.array(StepRouteViewSchema),
  entryStepId: z.string().nullable(),
});
export type UpdateConflictGraph = z.infer<typeof UpdateConflictGraphSchema>;

/** A compared key: a step present in only some of the graphs, a setting of a step in all three, or a route by step and result. */
export const UpdateKeySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("step"), stepId: z.string() }),
  z.object({ kind: z.literal("setting"), stepId: z.string(), field: z.string() }),
  z.object({ kind: z.literal("route"), fromStepId: z.string(), resultKey: z.string() }),
]);

/**
 * Who changed a key: only the template, only the person, both to the
 * same value, or both differently — a conflict.
 */
export const UpdateChangedBySchema = z.enum(["template", "person", "same", "conflict"]);
export type UpdateChangedBy = z.infer<typeof UpdateChangedBySchema>;

export const UpdateKeyChangeSchema = z.object({
  key: UpdateKeySchema,
  changedBy: UpdateChangedBySchema,
  /** The key's value in each graph; null where the step or route is absent from it. */
  base: z.unknown(),
  current: z.unknown(),
  template: z.unknown(),
  /** The key in a sentence, in the pipeline's step names. */
  description: z.string(),
});
export type UpdateKeyChange = z.infer<typeof UpdateKeyChangeSchema>;

/** One version the person filed since the base: who, when, and what it changed from the version before it. */
export const UpdateConflictEditSchema = z.object({
  version: z.number().int().positive(),
  /** The version it is compared with: the one filed before it, or null for the first version the pipeline has, which has nothing before it. */
  previousVersion: z.number().int().positive().nullable(),
  createdAt: z.number(),
  createdBy: z.string().nullable(),
  createdByName: z.string().nullable(),
  /**
   * One line per change from the previous version, step and route alike,
   * every setting a version holds included — inputs, time limits, keep
   * checking, the workspace — each with its value before and after.
   */
  changes: z.array(z.string()),
});
export type UpdateConflictEdit = z.infer<typeof UpdateConflictEditSchema>;

export const UpdateConflictDetailSchema = z.object({
  conflictId: z.string(),
  pipelineId: z.string(),
  pipelineName: z.string(),
  templateSlug: z.string(),
  templateTitle: z.string(),
  /** The base's version. */
  fromVersion: z.string(),
  /** The version that was held. */
  toVersion: z.string(),
  /** The release notes of every version after the base, up to the held one, one per line. */
  releaseNotes: z.string(),
  base: UpdateConflictGraphSchema,
  current: UpdateConflictGraphSchema,
  template: UpdateConflictGraphSchema,
  /** Every key somebody changed, the conflicts first. Compared now, against the pipeline as it stands. */
  changes: z.array(UpdateKeyChangeSchema),
  /** Why the automatic merge would not validate, where that is what held the update. */
  problems: z.array(z.string()),
  /**
   * Step ids the template adds that another pipeline already holds: a
   * draft must give each a fresh id, since step ids are unique across EO,
   * and say which template step it is in the draft's `templateStepIds`.
   */
  takenStepIds: z.array(z.string()),
  /** The assistant chat Fix with assistant opened for this update, where one has been: the chat whose drafts resolve it. */
  chatId: z.string().nullable(),
  /** The person's own versions since the base, oldest first. */
  edits: z.array(UpdateConflictEditSchema),
});
export type UpdateConflictDetail = z.infer<typeof UpdateConflictDetailSchema>;

/**
 * How a held template update is resolved (EO-534): the person published
 * a draft from the chat about it, or kept their pipeline as it is.
 */
export const UpdateConflictResolutionSchema = z.enum(["published", "kept"]);
export type UpdateConflictResolution = z.infer<typeof UpdateConflictResolutionSchema>;

/**
 * Which step of the published graph is which step of the held template
 * version, where the draft gave a template step a fresh id: the
 * template's step id to the pipeline's. Carried onto the new base's step
 * map, so a later version of the template still recognises the step.
 */
export const TemplateStepIdsSchema = z.record(z.string().min(1), z.string().min(1));
export type TemplateStepIds = z.infer<typeof TemplateStepIdsSchema>;

/**
 * What a read of a pipeline's held template update answers (EO-534):
 * the update, or why there is none to read.
 *
 * `authoritative` tells the two kinds of "none" apart. True where the
 * installation that holds the pipeline's updates answered — the update,
 * or that nothing is held. False where nobody who could say was asked:
 * the organisation's record holds the pipeline and could not be reached,
 * or this desktop is not signed in to it. A caller deciding whether a
 * draft resolves an update must not read a false one as "it resolves
 * nothing".
 */
export const UpdateConflictAnswerSchema = z.object({
  conflict: UpdateConflictDetailSchema.nullable(),
  problem: z.string().nullable(),
  authoritative: z.boolean().default(false),
});
export type UpdateConflictAnswer = z.infer<typeof UpdateConflictAnswerSchema>;
