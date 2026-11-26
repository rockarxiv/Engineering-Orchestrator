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
 * Every entry is in at most one batch — two batches given one entry would
 * have the second refused once the first retired it — so new entries
 * whose lists overlap, or that are in each other's, are one group: the
 * union of each one's own list, kept whole in one batch, so each new
 * entry is sent with every neighbour it ranks however the lists overlap.
 * Groups are packed into batches oldest new entry first, a group that
 * would take a batch over `limits` starting the next. Only a group too
 * large for any batch is cut, new entry by new entry: each with its
 * neighbours not yet placed, and a new entry already placed in the batch
 * being filled with its own that still fit there — so only there can a
 * new entry go without part of its list. Without neighbours — the index
 * could not be asked — the new entries go alone, by age.
 */
export function planNewEntryBatches<T extends BatchableEntry>(
  fresh: readonly T[],
  entries: readonly T[],
  neighbours: EntryNeighbours | null,
  limits: BatchLimits = CONSOLIDATION_BATCH_LIMITS,
): T[][] {
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
  // Lists that share an entry are one group.
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

  const batches: T[][] = [];
  const placed = new Set<string>();
  let batch: T[] = [];
  let chars = 0;
  const flush = () => {
    if (batch.length > 0) batches.push(batch.sort(byAge));
    batch = [];
    chars = 0;
  };
  const add = (member: T) => {
    batch.push(member);
    placed.add(member.id);
    chars += member.body.length;
  };
  const fits = (count: number, size: number) => batch.length + count <= limits.maxEntries && chars + size <= limits.maxChars;
  const sizeOf = (members: readonly T[]) => members.reduce((sum, member) => sum + member.body.length, 0);
  // In order of each group's oldest new entry: the order units are in.
  for (const group of groups.values()) {
    const members = [...new Set(group.flat())];
    const size = sizeOf(members);
    if (members.length <= limits.maxEntries && size <= limits.maxChars) {
      if (!fits(members.length, size)) flush();
      members.forEach(add);
      continue;
    }
    // Too large for one batch: new entry by new entry.
    flush();
    for (const unit of group) {
      const [head, ...rest] = unit as [T, ...T[]];
      if (placed.has(head.id)) {
        // Placed with an earlier new entry: its own neighbours join it
        // where that batch is still being filled and they fit.
        if (!batch.includes(head)) continue;
        for (const member of rest) if (!placed.has(member.id) && fits(1, member.body.length)) add(member);
        continue;
      }
      const members = [head, ...rest.filter((member) => !placed.has(member.id))];
      if (batch.length > 0 && !fits(members.length, sizeOf(members))) flush();
      members.forEach(add);
    }
    flush();
  }
  flush();
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
