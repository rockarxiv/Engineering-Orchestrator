import { memorySearchWords } from "@eo/core";
import { foldCase } from "./textFold.js";

/**
 * Approximate search over memory entries (EO-545) — the half that is not
 * SQL.
 *
 * `memories_fts` (migration 0139) indexes every three-character piece of
 * every body. A query is asked of it as each of its words' trigrams on
 * its own, joined with OR, so an entry holding most of a word — part of
 * it, another form of it, or a spelling a letter off — is a candidate,
 * and bm25 ranks the candidates by how many of the query's pieces they
 * hold and how rare those pieces are.
 *
 * OR on its own would also make a candidate of every entry sharing one
 * common piece with the query — "ind" from "windows" is in "find" and
 * "kind". So a candidate is kept only where at least one of the query's
 * words is mostly there: at least `MIN_WORD_OVERLAP` of its trigrams in
 * the body. A partial word or another form of it has all of them; a
 * small misspelling of a long word keeps most.
 */

/** The share of a query word's trigrams a body must hold for the word to count as found in it. */
export const MIN_WORD_OVERLAP = 0.5;

/** Every three-character piece of a text, by Unicode character, as the trigram tokenizer cuts it. */
export function trigramsOf(text: string): string[] {
  const chars = Array.from(text);
  const pieces: string[] = [];
  for (let at = 0; at + 3 <= chars.length; at += 1) pieces.push(chars.slice(at, at + 3).join(""));
  return pieces;
}

/** A query as the words it is matched on, each with its trigrams. Empty when no word is long enough. */
export interface PreparedQuery {
  words: { word: string; trigrams: string[] }[];
  /** The FTS5 MATCH expression: every distinct trigram, quoted, joined with OR. */
  match: string;
}

export function prepareQuery(query: string): PreparedQuery {
  const words = memorySearchWords(query).map((word) => ({ word, trigrams: [...new Set(trigramsOf(word))] }));
  const all = [...new Set(words.flatMap((word) => word.trigrams))];
  // Quoted, with any double quote doubled, so no piece is read as FTS5
  // syntax. Words are letters and digits only, so none has one today.
  return { words, match: all.map((piece) => `"${piece.replaceAll('"', '""')}"`).join(" OR ") };
}

/**
 * Whether a body holds enough of the query to be a match: some word of
 * it with at least `MIN_WORD_OVERLAP` of its trigrams there.
 */
export function bodyMatches(prepared: PreparedQuery, body: string): boolean {
  const held = new Set(trigramsOf(foldCase(body)));
  return prepared.words.some(({ trigrams }) => trigrams.length > 0 && trigrams.filter((piece) => held.has(piece)).length / trigrams.length >= MIN_WORD_OVERLAP);
}
