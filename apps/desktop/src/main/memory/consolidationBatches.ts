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
 * Each new entry's own list — itself and its neighbours — goes into one
 * batch whole wherever it fits a batch at all: into the batch being
 * filled where what it adds to it fits there, the next batch otherwise.
 * An entry already in the batch is not counted again, so new entries whose
 * lists overlap share it; an entry in an earlier batch is given again
 * wherever a later new entry ranks it, since that new entry's context is
 * the point. A list too long for any batch is cut: the new entry and its
 * neighbours best first, as far as they fit, never past `limits`. Lists
 * that share entries are taken one after another, in order of their
 * oldest new entry, so overlapping ones tend to share a batch. A new entry
 * that one batch already gave as a neighbour is still given again with
 * its own list where that did not fit there. What an earlier batch of the
 * run retired or replaced is put right before a later one is sent
 * (`refreshBatch`), so no batch is given an entry as it no longer is.
 * Without neighbours — the index could not be asked — the new entries go
 * alone, by age.
 */
export function planNewEntryBatches<T extends BatchableEntry>(
  fresh: readonly T[],
  entries: readonly T[],
  neighbours: EntryNeighbours | null,
  limits: BatchLimits = CONSOLIDATION_BATCH_LIMITS,
): T[][] {
  return planNewEntryBatchGroups(fresh, entries, neighbours, limits).map((planned) => planned.entries);
}

/** One batch `planNewEntryBatchGroups` plans: what it is given, and the new entries whose own list it holds. */
export interface PlannedNewEntryBatch<T> {
  entries: T[];
  /**
   * The new entries this batch is for (EO-913): each one whose own list —
   * itself and its neighbours — was placed in it. A new entry another's
   * list brings into a batch as a neighbour is context there, not done,
   * and is given again with its own list in the batch that holds it.
   */
  owns: string[];
}

/** `planNewEntryBatches`, with each batch's `owns`: what a run counts as handled once that batch is applied. */
export function planNewEntryBatchGroups<T extends BatchableEntry>(
  fresh: readonly T[],
  entries: readonly T[],
  neighbours: EntryNeighbours | null,
  limits: BatchLimits = CONSOLIDATION_BATCH_LIMITS,
): PlannedNewEntryBatch<T>[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  for (const entry of fresh) byId.set(entry.id, entry);
  // Each new entry's own list: itself and its nearest neighbours, best first.
  const units = [...new Map(fresh.map((entry) => [entry.id, entry])).values()].sort(byAge).map((entry) => {
    const unit = [entry];
    for (const id of neighbours?.get(entry.id) ?? []) {
      if (unit.length > NEW_ENTRY_NEIGHBOURS) break;
      const neighbour = byId.get(id);
      if (neighbour !== undefined && !unit.includes(neighbour)) unit.push(neighbour);
    }
    return unit;
  });
  // Lists that share an entry are taken one after another, so they tend to share a batch.
  const parent = new Map<string, string>();
  const root = (id: string): string => {
    let at = id;
    while (parent.get(at) !== at) at = parent.get(at)!;
    parent.set(id, at);
    return at;
  };
  for (const unit of units) {
    for (const member of unit) if (!parent.has(member.id)) parent.set(member.id, member.id);
    for (const member of unit.slice(1)) parent.set(root(member.id), root(unit[0]!.id));
  }
  const groups = new Map<string, T[][]>();
  for (const unit of units) {
    const key = root(unit[0]!.id);
    groups.set(key, [...(groups.get(key) ?? []), unit]);
  }

  const batches: PlannedNewEntryBatch<T>[] = [];
  let batch: T[] = [];
  let owns: string[] = [];
  let chars = 0;
  const flush = () => {
    if (batch.length > 0) batches.push({ entries: batch.sort(byAge), owns });
    batch = [];
    owns = [];
    chars = 0;
  };
  const add = (member: T) => {
    batch.push(member);
    chars += member.body.length;
  };
  const fits = (count: number, size: number) => batch.length + count <= limits.maxEntries && chars + size <= limits.maxChars;
  const sizeOf = (members: readonly T[]) => members.reduce((sum, member) => sum + member.body.length, 0);
  for (const unit of [...groups.values()].flat()) {
    const missing = unit.filter((member) => !batch.includes(member));
    if (fits(missing.length, sizeOf(missing))) {
      missing.forEach(add);
      owns.push(unit[0]!.id);
      continue;
    }
    flush();
    // Too long for any batch: the new entry, then its neighbours best
    // first while they fit.
    const [head, ...rest] = unit as [T, ...T[]];
    add(head);
    owns.push(head.id);
    for (const member of rest) if (fits(1, member.body.length)) add(member);
  }
  flush();
  return batches;
}

/**
 * A planned batch as it is to be sent, once the batches of its run before
 * it have been applied (EO-913): an entry one of them retired is left out,
 * and in its place go the entries it was folded or rewritten into, still
 * active and not already in the batch, as far as they fit `limits` — so a
 * neighbour two batches shared reaches the second as the first left it,
 * and no batch is given an entry as it no longer is. `replaced` maps each
 * entry the run retired to what it wrote from it, `current` reads an
 * entry as it is now (undefined once it is retired).
 */
export function refreshBatch<T extends BatchableEntry>(
  batch: readonly T[],
  replaced: ReadonlyMap<string, readonly string[]>,
  current: (id: string) => T | undefined,
  limits: BatchLimits = CONSOLIDATION_BATCH_LIMITS,
): T[] {
  if (!batch.some((entry) => replaced.has(entry.id))) return [...batch];
  const kept = batch.filter((entry) => !replaced.has(entry.id));
  const ids = new Set(kept.map((entry) => entry.id));
  let chars = kept.reduce((sum, entry) => sum + entry.body.length, 0);
  const into = (id: string, seen: Set<string>): string[] => {
    if (seen.has(id)) return [];
    seen.add(id);
    const next = replaced.get(id);
    return next === undefined ? [id] : next.flatMap((one) => into(one, seen));
  };
  for (const entry of batch) {
    if (!replaced.has(entry.id)) continue;
    for (const id of into(entry.id, new Set())) {
      if (ids.has(id)) continue;
      const now = current(id);
      if (now === undefined || kept.length + 1 > limits.maxEntries || chars + now.body.length > limits.maxChars) continue;
      kept.push(now);
      ids.add(id);
      chars += now.body.length;
    }
  }
  return kept.sort(byAge);
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
