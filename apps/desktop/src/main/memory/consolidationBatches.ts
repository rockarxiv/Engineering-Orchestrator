import { z } from "zod";
import { MemoryMergeCandidatesSchema, type MemoryMergeCandidates } from "@eo/core";

/**
 * Consolidating a scope in batches (EO-574), the pure half: how a scope
 * is cut into batches, how a scheduled consolidation's new entries are
 * (EO-913), and the cross-batch pass that finds duplicates which fell
 * into different ones.
 * The calls and the order they run in are `consolidator.ts`.
 *
 * A scope's whole set, sent in one call, is an answer too large to
 * produce: EO's own project scope, at 111 entries and 56,000 characters,
 * failed eight consolidations in a row. A batch is small enough to answer.
 */

/** The most entries one batch holds. */
export const CONSOLIDATION_BATCH_MAX_ENTRIES = 30;
/** The most characters one batch holds — whichever of the two limits comes first. One entry longer than this is a batch on its own. */
export const CONSOLIDATION_BATCH_MAX_CHARS = 15_000;
/** The most of an entry's first line the cross-batch pass is shown. */
export const FIRST_LINE_MAX_CHARS = 200;

export interface BatchLimits {
  maxEntries: number;
  maxChars: number;
}

export const CONSOLIDATION_BATCH_LIMITS: BatchLimits = { maxEntries: CONSOLIDATION_BATCH_MAX_ENTRIES, maxChars: CONSOLIDATION_BATCH_MAX_CHARS };

/** What batching needs of an entry. */
export interface BatchableEntry {
  id: string;
  body: string;
  createdAt: number;
}

/** For each entry, the others most like it, best first — from the full-text index (`similarMemoryNeighbours`). */
export type EntryNeighbours = ReadonlyMap<string, readonly string[]>;

const byAge = (a: BatchableEntry, b: BatchableEntry) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The scope's entries cut into batches of at most `limits.maxEntries`
 * entries and `limits.maxChars` characters, whichever comes first.
 *
 * Related entries tend to share a batch. Each batch starts from the
 * oldest entry not yet in one and grows by its neighbours, then theirs,
 * as the full-text index ranks them; when those run out it takes the
 * next oldest and grows from that. Without neighbours — the index could
 * not be asked — batches are simply by age. A batch closes at the first
 * entry that would take it over a limit, which starts a later one.
 *
 * Every entry is in exactly one batch, and a scope that fits in one batch
 * is one batch.
 *
 * Entries in one of `together` — likely duplicates of one another
 * (EO-576, `nearDuplicateGroups`) — always share a batch: placing one
 * places the rest of its group with it, and a batch that has no room for
 * the whole group closes before it, and the group goes to a later one. A group
 * larger than a batch's limits is a batch on its own.
 */
export function planBatches<T extends BatchableEntry>(
  entries: readonly T[],
  neighbours: EntryNeighbours | null,
  limits: BatchLimits = CONSOLIDATION_BATCH_LIMITS,
  together: readonly (readonly { id: string }[])[] = [],
): T[][] {
  const ordered = [...entries].sort(byAge);
  const byId = new Map(ordered.map((entry) => [entry.id, entry]));
  const groupOf = new Map<string, T[]>();
  for (const group of together) {
    const members = group.flatMap((member) => byId.get(member.id) ?? []).filter((member) => !groupOf.has(member.id));
    for (const member of members) groupOf.set(member.id, members);
  }
  const placed = new Set<string>();
  const batches: T[][] = [];
  let oldest = 0;
  const nextOldest = (): T | undefined => {
    while (oldest < ordered.length && placed.has(ordered[oldest]!.id)) oldest += 1;
    return ordered[oldest];
  };
  while (placed.size < ordered.length) {
    const batch: T[] = [];
    let chars = 0;
    const frontier: string[] = [];
    for (;;) {
      let candidate: T | undefined;
      while (frontier.length > 0 && candidate === undefined) {
        const id = frontier.shift()!;
        if (!placed.has(id)) candidate = byId.get(id);
      }
      candidate ??= nextOldest();
      if (candidate === undefined) break;
      const unit = groupOf.get(candidate.id) ?? [candidate];
      const size = unit.reduce((sum, entry) => sum + entry.body.length, 0);
      if (batch.length > 0 && (batch.length + unit.length > limits.maxEntries || chars + size > limits.maxChars)) break;
      for (const entry of unit) {
        batch.push(entry);
        placed.add(entry.id);
      }
      chars += size;
      for (const entry of unit) for (const id of neighbours?.get(entry.id) ?? []) if (!placed.has(id) && byId.has(id)) frontier.push(id);
    }
    batches.push(batch.sort(byAge));
  }
  return batches;
}

/** The most neighbours a scheduled consolidation gives each new entry with (EO-913). */
export const NEW_ENTRY_NEIGHBOURS = 8;

/**
 * A scheduled consolidation's batches (EO-913): each of `fresh` — the
 * entries written or changed since the scope's last consolidation — with
 * up to `NEW_ENTRY_NEIGHBOURS` of its nearest neighbours among `entries`,
 * best first, as `neighbours` ranks them (`similarMemoryNeighbours`). The
 * rest of the scope is not sent, so what it costs follows the new notes,
 * not the size of memory.
 *
 * New entries are taken oldest first, each with its neighbours, into the
 * batch being filled; one whose unit — itself and its neighbours not yet
 * in a batch — would take that batch over `limits` starts the next, and a
 * unit larger than a batch is a batch on its own. Every entry is in at
 * most one batch, so a new entry already placed as an earlier one's
 * neighbour is not placed again, and a neighbour two new entries share
 * goes with the first. Without neighbours — the index could not be asked
 * — the new entries go alone, by age.
 */
export function planNewEntryBatches<T extends BatchableEntry>(
  fresh: readonly T[],
  entries: readonly T[],
  neighbours: EntryNeighbours | null,
  limits: BatchLimits = CONSOLIDATION_BATCH_LIMITS,
): T[][] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  for (const entry of fresh) byId.set(entry.id, entry);
  const placed = new Set<string>();
  const batches: T[][] = [];
  let batch: T[] = [];
  let chars = 0;
  for (const entry of [...fresh].sort(byAge)) {
    if (placed.has(entry.id)) continue;
    const unit = [entry];
    for (const id of neighbours?.get(entry.id) ?? []) {
      if (unit.length > NEW_ENTRY_NEIGHBOURS) break;
      const neighbour = byId.get(id);
      if (neighbour !== undefined && !placed.has(id) && !unit.includes(neighbour)) unit.push(neighbour);
    }
    const size = unit.reduce((sum, member) => sum + member.body.length, 0);
    if (batch.length > 0 && (batch.length + unit.length > limits.maxEntries || chars + size > limits.maxChars)) {
      batches.push(batch.sort(byAge));
      batch = [];
      chars = 0;
    }
    for (const member of unit) {
      batch.push(member);
      placed.add(member.id);
    }
    chars += size;
  }
  if (batch.length > 0) batches.push(batch.sort(byAge));
  return batches;
}

/** An entry's first line, as the cross-batch pass is shown it. */
export function firstLine(body: string): string {
  const line = body.trim().split(/\r?\n/, 1)[0]!.trim();
  return line.length > FIRST_LINE_MAX_CHARS ? `${line.slice(0, FIRST_LINE_MAX_CHARS - 1)}…` : line;
}

/**
 * The shape the cross-batch pass's first answer is held to: groups of at
 * least two ids, each id one it was given and in at most one group.
 */
export function mergeCandidatesSchema(entries: readonly { id: string }[]): z.ZodType<MemoryMergeCandidates> {
  const known = new Set(entries.map((entry) => entry.id));
  return MemoryMergeCandidatesSchema.superRefine((answer, ctx) => {
    const named = new Set<string>();
    answer.groups.forEach((group, at) =>
      group.ids.forEach((id, index) => {
        const path = ["groups", at, "ids", index];
        if (!known.has(id)) ctx.addIssue({ code: "custom", path, message: `names an entry it was not given: ${id}` });
        else if (named.has(id)) ctx.addIssue({ code: "custom", path, message: `names ${id} in two groups` });
        named.add(id);
      }),
    );
  });
}

export const MEMORY_MERGE_CANDIDATES_SYSTEM = [
  "You look for duplicates in the memory an engineering tool keeps for its agents. Each entry is a note an agent wrote about a project or a workspace, for the next agent to read.",
  "The entries were tidied in batches, so two that say the same thing may have been in different batches and never seen side by side. You are shown each entry's id and its first line only.",
  "Answer with `groups`: each `{ ids }` lists two or more entries whose first lines suggest they say the same thing, or parts of one thing, and could be merged into one. Each id may appear in only one group, and only ids you are shown.",
  `A later step reads the full text of what you pick and decides what to merge, and it can read at most ${CONSOLIDATION_BATCH_MAX_ENTRIES} entries: pick the likeliest duplicates first. An answer with no groups is a valid answer.`,
].join("\n");

/** What the cross-batch pass's first call is told: each remaining entry's id and first line, and nothing else of it. */
export function mergeCandidatesInput(input: { scopeLabel: string; entries: readonly BatchableEntry[] }): string {
  const lines = [`These are the ${input.entries.length} agent-written memory entries of ${input.scopeLabel}, each as its id and its first line.`, ""];
  for (const entry of [...input.entries].sort(byAge)) lines.push(`- ${entry.id}: ${firstLine(entry.body)}`);
  return lines.join("\n");
}

/**
 * The candidate groups the cross-batch pass's last call reads in full:
 * those whose entries are still there, in the order given, as many as
 * fit one batch. A group whose entries do not all fit is left out rather
 * than cut, and a group left with fewer than two entries is no candidate.
 */
export function pickCandidateGroups<T extends BatchableEntry>(groups: readonly { ids: readonly string[] }[], entries: readonly T[], limits: BatchLimits = CONSOLIDATION_BATCH_LIMITS): T[][] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const picked: T[][] = [];
  let count = 0;
  let chars = 0;
  for (const group of groups) {
    const members = group.ids.flatMap((id) => byId.get(id) ?? []);
    if (members.length < 2) continue;
    const size = members.reduce((sum, entry) => sum + entry.body.length, 0);
    if (count + members.length > limits.maxEntries || chars + size > limits.maxChars) continue;
    picked.push(members);
    count += members.length;
    chars += size;
  }
  return picked;
}
