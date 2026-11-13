import { z } from "zod";
import { DEPENDENCY_WAITS, type DependencyWait } from "../domain.js";

/**
 * How a caller names a dependency and the rule it waits by (EO-777,
 * EO-775), wherever an edge can be written: `items:update`, a plan's
 * stories, `work:submitItem`, a module's `ctx.createItem`.
 *
 * A bare reference — a key or an id, or a story's index in a plan —
 * still means `finished`, so every caller written before the rule
 * existed means what it always did. The object form sets a gate:
 * `{ item, wait, step? }`, or `{ story, wait, step? }` in a plan. `step`
 * is a step *name* on the dependency's own pipeline, required for
 * `reached` and refused with anything else; the host turns it into the
 * step's id when it writes the edge (`roles/itemDependencies.ts`), so
 * nothing in here knows a pipeline.
 */
export const DependencyWaitSchema = z.enum(DEPENDENCY_WAITS);

/** One dependency on an existing item, with its rule spelled out. */
export const DependencyGateOnItemSchema = z.object({
  /** The item waited for, by key (`EO-42`) or id. */
  item: z.string().min(1),
  /** `finished` (what leaving it out means), `reached` with a `step`, or `none`. */
  wait: DependencyWaitSchema,
  /** A step name on the dependency's own pipeline; only with `wait: "reached"`. */
  step: z.string().min(1).optional(),
});
export type DependencyGateOnItem = z.infer<typeof DependencyGateOnItemSchema>;

/** A dependency on an existing item: a bare key or id (`finished`), or the object form. */
export const DependencyOnItemSchema = z.union([z.string().min(1), DependencyGateOnItemSchema]);
export type DependencyOnItem = z.infer<typeof DependencyOnItemSchema>;

/** One dependency on a sibling story in a plan, with its rule spelled out. */
export const DependencyGateOnStorySchema = z.object({
  /** The index, into the same plan's stories, of the story waited for. */
  story: z.number().int().nonnegative(),
  wait: DependencyWaitSchema,
  step: z.string().min(1).optional(),
});
export type DependencyGateOnStory = z.infer<typeof DependencyGateOnStorySchema>;

/** A dependency on a sibling story in a plan: a bare index (`finished`), or the object form. */
export const DependencyOnStorySchema = z.union([z.number().int().nonnegative(), DependencyGateOnStorySchema]);
export type DependencyOnStory = z.infer<typeof DependencyOnStorySchema>;

/** The rule a caller asked for, before its step is resolved against a pipeline. */
export interface DependencyGateRequest {
  wait: DependencyWait;
  /** The step name as the caller gave it, or null where it gave none. */
  step: string | null;
}

/** The rule a bare reference means. */
export const FINISHED_GATE: DependencyGateRequest = { wait: "finished", step: null };

/** A dependency on an existing item as a reference and the rule asked for. */
export function dependencyOnItem(entry: DependencyOnItem): { reference: string; gate: DependencyGateRequest } {
  if (typeof entry === "string") return { reference: entry, gate: FINISHED_GATE };
  return { reference: entry.item, gate: { wait: entry.wait, step: entry.step ?? null } };
}

/** A dependency on a sibling story as its index and the rule asked for. */
export function dependencyOnStory(entry: DependencyOnStory): { story: number; gate: DependencyGateRequest } {
  if (typeof entry === "number") return { story: entry, gate: FINISHED_GATE };
  return { story: entry.story, gate: { wait: entry.wait, step: entry.step ?? null } };
}

/**
 * A gate in words, as an engine comment and a read surface say it:
 * "waits for EO-14 to reach Watch merge request", "waits for EO-12 to
 * finish", "links to EO-15 without waiting for it".
 */
export function gateInWords(dependencyKey: string, wait: DependencyWait, stepName: string | null): string {
  if (wait === "none") return `links to ${dependencyKey} without waiting for it`;
  if (wait === "reached") return `waits for ${dependencyKey} to reach ${stepName ?? "a step that no longer exists"}`;
  return `waits for ${dependencyKey} to finish`;
}
