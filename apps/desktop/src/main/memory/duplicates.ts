import type { MemoryConsolidationOperations, MemoryEntryView } from "@eo/core";
import { trigramsOf } from "../db/approximateSearch.js";
import { foldCase } from "../db/textFold.js";
import { CONSOLIDATION_BATCH_LIMITS, type BatchLimits, type EntryNeighbours } from "./consolidationBatches.js";

/**
 * Duplicate memory entries, found without a model (EO-576), the pure
 * half. Before a consolidation asks for anything, entries an agent wrote
 * that say the same thing word for word are folded with no side call at
 * all, and those that say nearly the same thing are put side by side in
 * one batch and marked, so the model's decision about them is cheap.
 *
 * A person's entry is never one of them: consolidation never sends,
 * rewrites or retires what a person wrote, and nothing here does either.
 */

/**
 * How alike two entries must be, as `duplicateSimilarity` measures it, to
 * count as likely duplicates: more than this. Read off EO's own project
 * memory: the two notes about `itemVocabulary.test.ts` come to 0.53 and
 * the two about a fresh worktree needing `pnpm install` to 0.64, while
 * notes on one subject that say different things — two about
 * `watch_pull_request` — stay near 0.3.
 */
export const NEAR_DUPLICATE_SIMILARITY = 0.45;

/** What finding duplicates needs of an entry. */
export interface DuplicateCandidate {
  id: string;
  body: string;
  createdAt: number;
  source: MemoryEntryView["source"];
  contradictsRepositoryFile: boolean;
}

const byPerson = (entry: DuplicateCandidate) => entry.source.type === "person";

/**
 * The marks a sentence or a clause ends with, taken off the end of a word:
 * the ones that cannot change what a note says. Not `!` or `?`, which code
 * written without backticks uses (`println!`, `foo()?`), and no bracket,
 * quote or operator, since `(a + b) * c` is not `a + b * c` and `'a'` is
 * not `a`.
 */
const SENTENCE_MARKS = new Set([".", ",", ";", ":", "\u2026"]);
/** The mark markdown wraps inline code in: presentation, not text. */
const BACKTICK = "`";

/**
 * A word with only what cannot change its meaning taken off, in this
 * order: the sentence marks after it (`SENTENCE_MARKS`), then one
 * backtick closing inline code, then one opening it. So "`pnpm lint`." is
 * "pnpm lint", while a mark inside the backticks stays — "`println!`" is
 * "println!", not "println". A word made of nothing but marks, such as
 * `..` or `--`, is kept as it is.
 */
function plainWord(word: string): string {
  const chars = Array.from(word);
  let start = 0;
  let end = chars.length;
  while (end > start && SENTENCE_MARKS.has(chars[end - 1]!)) end -= 1;
  if (end > start && chars[end - 1] === BACKTICK) end -= 1;
  if (end > start && chars[start] === BACKTICK) start += 1;
  return start === end ? word : chars.slice(start, end).join("");
}

/**
 * A body as two entries are compared word for word: case folded in every
 * script, every run of whitespace one space, and of the punctuation only
 * what cannot change what a note says (`plainWord`) — sentence marks at
 * the end of a word and the backticks around inline code. So
 * "Run `pnpm install` first." and "run pnpm install first" are the same.
 *
 * Every other mark stays where it is: one inside a word
 * ("itemVocabulary.txt", "a!=b"), a sign or an operator ("-1", "!ready",
 * "!="), brackets ("(a + b) * c"), quotes ("'a'") and `!` or `?`. Two
 * notes that differ in one are never folded without a model; at worst
 * they are two duplicates the model merges as likely duplicates, which
 * costs a little, where folding two different facts into one would lose
 * one.
 */
export function normalisedBody(body: string): string {
  return foldCase(body)
    .split(/\s+/u)
    .filter((word) => word !== "")
    .map(plainWord)
    .join(" ");
}

/** Newest first: the one of a group of duplicates that is kept. */
const newestFirst = (a: DuplicateCandidate, b: DuplicateCandidate) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

/** One set of entries that say the same thing word for word: the one kept and those retired for it. */
export interface ExactDuplicates<T extends DuplicateCandidate = DuplicateCandidate> {
  kept: T;
  retired: T[];
}

/**
 * The agent-written entries that repeat another word for word once
 * normalised (`normalisedBody`), in sets, each keeping its newest entry.
 *
 * Two that differ in whether they are flagged as correcting the
 * repository file are not folded here: keeping one would drop or add the
 * flag, which is a judgement, so they are left to the model as likely
 * duplicates instead. People's entries are never in a set.
 */
export function exactDuplicates<T extends DuplicateCandidate>(entries: readonly T[]): ExactDuplicates<T>[] {
  const sets = new Map<string, T[]>();
  for (const entry of entries) {
    if (byPerson(entry)) continue;
    const key = `${entry.contradictsRepositoryFile ? "1" : "0"}:${normalisedBody(entry.body)}`;
    const set = sets.get(key);
    if (set) set.push(entry);
    else sets.set(key, [entry]);
  }
  return [...sets.values()]
    .filter((set) => set.length > 1)
    .map((set) => {
      const [kept, ...retired] = [...set].sort(newestFirst);
      return { kept: kept!, retired };
    });
}

/** The operations that fold `sets`: each retired entry retired, the kept ones left as they are. */
export function exactDuplicateOperations(sets: readonly ExactDuplicates[]): MemoryConsolidationOperations {
  return {
    retire: sets.flatMap(({ kept, retired }) => retired.map((entry) => ({ id: entry.id, reason: `repeats ${kept.id} word for word` }))),
    merge: [],
    rewrite: [],
  };
}

/** A body's trigrams as the full-text index holds them (migration 0139): case folded, whitespace runs one space. */
function indexTrigrams(body: string): Set<string> {
  return new Set(trigramsOf(foldCase(body).replace(/\s+/gu, " ").trim()));
}

/**
 * How alike two bodies are, from 0 to 1: the share of their three-letter
 * pieces they have in common (Dice's coefficient), over the same pieces
 * EO-545's full-text index holds them as. Case and spacing do not count;
 * a body with no piece is like nothing.
 */
export function duplicateSimilarity(a: string, b: string): number {
  return similarityOf(indexTrigrams(a), indexTrigrams(b));
}

/**
 * The entries `duplicateSimilarity` puts above `NEAR_DUPLICATE_SIMILARITY`
 * for `body`, closest first. What `memory_note` answers with (EO-611), so a
 * person's entry is among them: this shows, and retires nothing.
 */
export function closestEntries<T extends { body: string }>(body: string, entries: readonly T[]): T[] {
  return entries
    .map((entry) => ({ entry, similarity: duplicateSimilarity(body, entry.body) }))
    .filter(({ similarity }) => similarity > NEAR_DUPLICATE_SIMILARITY)
    .sort((a, b) => b.similarity - a.similarity)
    .map(({ entry }) => entry);
}

function similarityOf(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const piece of a) if (b.has(piece)) shared += 1;
  return (2 * shared) / (a.size + b.size);
}

/**
 * The agent-written entries likely to say the same thing, in groups of
 * two or more, the likeliest first.
 *
 * A pair is a candidate where the full-text index (`neighbours`, from
 * `similarMemoryNeighbours`) names one among the other's nearest, and a
 * likely duplicate where their similarity is above
 * `NEAR_DUPLICATE_SIMILARITY`. Pairs join into groups, most alike first,
 * so three notes saying one thing are one group — but never past what one
 * batch holds (`limits`), since a group is put in a batch whole. Without
 * neighbours there is no index to ask, and no entry is marked.
 */
export function nearDuplicateGroups<T extends DuplicateCandidate>(entries: readonly T[], neighbours: EntryNeighbours | null, limits: BatchLimits = CONSOLIDATION_BATCH_LIMITS): T[][] {
  if (neighbours === null) return [];
  const agents = entries.filter((entry) => !byPerson(entry));
  const byId = new Map(agents.map((entry) => [entry.id, entry]));
  const pieces = new Map<string, Set<string>>();
  const piecesOf = (entry: T) => {
    let held = pieces.get(entry.id);
    if (!held) pieces.set(entry.id, (held = indexTrigrams(entry.body)));
    return held;
  };
  const pairs: { a: T; b: T; similarity: number }[] = [];
  const seen = new Set<string>();
  for (const entry of agents) {
    for (const otherId of neighbours.get(entry.id) ?? []) {
      const other = byId.get(otherId);
      if (!other || other.id === entry.id) continue;
      const key = entry.id < other.id ? `${entry.id}|${other.id}` : `${other.id}|${entry.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const similarity = similarityOf(piecesOf(entry), piecesOf(other));
      if (similarity > NEAR_DUPLICATE_SIMILARITY) pairs.push(entry.id < other.id ? { a: entry, b: other, similarity } : { a: other, b: entry, similarity });
    }
  }
  pairs.sort((x, y) => y.similarity - x.similarity || (x.a.id < y.a.id ? -1 : x.a.id > y.a.id ? 1 : x.b.id < y.b.id ? -1 : x.b.id > y.b.id ? 1 : 0));

  // Groups by id, joined pair by pair while the joined group fits a batch.
  const groupOf = new Map<string, T[]>();
  const fits = (group: readonly T[]) => group.length <= limits.maxEntries && group.reduce((sum, entry) => sum + entry.body.length, 0) <= limits.maxChars;
  for (const { a, b } of pairs) {
    const left = groupOf.get(a.id) ?? [a];
    const right = groupOf.get(b.id) ?? [b];
    if (left === right) continue;
    const joined = [...left, ...right];
    if (!fits(joined)) continue;
    for (const entry of joined) groupOf.set(entry.id, joined);
  }
  // In the order their likeliest pair came, each group once, oldest entry first.
  const groups: T[][] = [];
  const listed = new Set<T[]>();
  for (const { a } of pairs) {
    const group = groupOf.get(a.id);
    if (!group || listed.has(group)) continue;
    listed.add(group);
    groups.push([...group].sort((x, y) => x.createdAt - y.createdAt || (x.id < y.id ? -1 : 1)));
  }
  return groups;
}

/** For each entry in a group, the others in it: what a batch's input marks it a likely duplicate of. */
export function likelyDuplicatesOf(groups: readonly (readonly { id: string }[])[]): Map<string, string[]> {
  const marks = new Map<string, string[]>();
  for (const group of groups) for (const entry of group) marks.set(entry.id, group.filter((other) => other.id !== entry.id).map((other) => other.id));
  return marks;
}
