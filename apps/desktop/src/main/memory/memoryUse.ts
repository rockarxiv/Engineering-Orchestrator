import { MEMORY_USED_EVENT, MEMORY_USED_FIELD, type MemoryUsedEvent } from "@eo/core";

/**
 * What a run said it relied on, held to what it was given (EO-597,
 * ARCHITECTURE.md §7.5).
 *
 * An answer may list the memory entries it relied on in `memoryUsed`. The
 * claim is checked against the run's own log, as every claim the engine
 * can check is (invariant 5): an id the run was not delivered — a guess,
 * an id read off a listing it was not given, a typo — is taken out of the
 * answer the engine acts on and recorded as dropped, so the count of uses
 * is a count of entries that were actually in front of the agent.
 *
 * Null where the answer has no `memoryUsed` list: it said nothing about
 * memory, which is not saying none was used, and nothing is recorded. An
 * empty list is recorded — that is a run saying it used none.
 *
 * Pure: the delivered set is read by the caller.
 */
export function heldToDelivered(answer: unknown, delivered: ReadonlySet<string>): { answer: unknown; event: MemoryUsedEvent | null } {
  if (typeof answer !== "object" || answer === null || Array.isArray(answer)) return { answer, event: null };
  const listed: unknown = (answer as Record<string, unknown>)[MEMORY_USED_FIELD];
  if (!Array.isArray(listed)) return { answer, event: null };
  const ids = [...new Set(listed.filter((id): id is string => typeof id === "string"))];
  const entryIds = ids.filter((id) => delivered.has(id));
  const droppedIds = ids.filter((id) => !delivered.has(id));
  return {
    answer: { ...(answer as Record<string, unknown>), [MEMORY_USED_FIELD]: entryIds },
    event: { type: MEMORY_USED_EVENT, entryIds, droppedIds },
  };
}
