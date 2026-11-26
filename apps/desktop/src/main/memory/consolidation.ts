import { z } from "zod";
import {
  MAX_MEMORY_NOTE_CHARS,
  MAX_SKILL_PROPOSALS,
  SKILL_PROPOSAL_SECTIONS,
  SkillProposalSchema,
  type MemoryScope,
  MEMORY_CONSOLIDATION_INTERVAL_MS,
  MEMORY_CONSOLIDATION_MIN_RUNS,
  MemoryConsolidationAnswerSchema,
  MEMORY_CONSOLIDATION_REWRITE_REASONS,
  MemoryContainerDoneAnswerSchema,
  MemorySkillProposalsAnswerSchema,
  type MemoryContainerDoneAnswer,
  type MemoryConsolidationAnswer,
  type MemoryConsolidationOperations,
  type MemoryConsolidationRewriteReason,
  type MemorySkillProposalsAnswer,
  type MemoryConsolidationTrigger,
  type MemoryEntryView,
} from "@eo/core";
import type { ScopeConsolidationState, ScopeTally } from "../db/repos/memoryConsolidationsRepo.js";

/**
 * Automatic memory consolidation, the pure half (EO-480, ARCHITECTURE.md,
 * "What an agent is given"): when a scope is due, what it is told, and the
 * shape its answer is held to. The database and the scheduling are
 * `consolidator.ts`.
 *
 * Consolidation is hygiene, never a matter of size (EO-913): a scope is
 * not capped, nothing is asked to shrink to a target, and an entry is
 * rewritten only for one of the reasons a rewrite may give.
 */

/**
 * How long a scope waits after a failed consolidation (EO-577): an hour
 * after the first failure in a row, four after the second, and a day
 * after the third and every one after it — rather than being asked again
 * on every look, holding the global slot each time for a call that keeps
 * failing the same way.
 */
export const CONSOLIDATION_BACKOFF_MS = [60 * 60 * 1000, 4 * 60 * 60 * 1000, 24 * 60 * 60 * 1000] as const;
/**
 * How many failures in a row make a scope's consolidation stuck: the
 * message saying so is sent at the one that makes it this
 * many (EO-577).
 */
export const CONSOLIDATION_STUCK_AFTER = 3;
/**
 * How long a consolidation refused for budget waits before it looks
 * again. Not doubled: what it waits for is the budget allowing — a new
 * day, or a person raising it — not for a backend to recover.
 */
export const CONSOLIDATION_BUDGET_RETRY_MS = 30 * 60 * 1000;
/** How long one whose entries changed under it waits: somebody is editing, and the next look will see what they left. */
export const CONSOLIDATION_CHANGED_RETRY_MS = 60 * 1000;
/**
 * The failure a consolidation stopped by pausing the engine is recorded
 * with (EO-514). Retried like one whose entries changed — after a minute,
 * never doubled — because nothing went wrong: the person paused EO, and
 * none starts again until they resume it.
 */
export const CONSOLIDATION_PAUSED_REASON = "paused";
/**
 * The failure a batch is recorded with when it gave way to pipeline work
 * (EO-577): an item became dispatchable, or a run started, between two
 * batches of a scope or as its call was about to take the slot. Like a
 * pause, nothing went wrong — the work comes first — so it is looked at
 * again after a minute and taken up once the pipeline is idle, and it
 * neither backs the scope off nor counts towards its being stuck.
 */
export const CONSOLIDATION_DEFERRED_REASON = "deferred";

/** Whether a failure is the backend's or the answer's — what backs a scope off and makes it stuck — rather than a wait for something else. */
function countsAsFailure(reason: string | null): boolean {
  return reason !== "budget" && reason !== "changed" && reason !== CONSOLIDATION_PAUSED_REASON && reason !== CONSOLIDATION_DEFERRED_REASON;
}

/** The scope's failures in a row since its last consolidation that was not one, newest first, that back it off (EO-577). */
export function consecutiveFailures(state: ScopeConsolidationState): ScopeConsolidationState["failuresSince"] {
  return state.failuresSince.filter((failure) => countsAsFailure(failure.reason));
}

/**
 * When a scope that failed may be asked again, or null when it has not
 * failed since it last succeeded. A budget refusal waits for the budget,
 * and a change, a pause or pipeline work for a minute; the rest back off
 * by how many there have been in a row (`CONSOLIDATION_BACKOFF_MS`).
 */
export function retryAt(state: ScopeConsolidationState): number | null {
  const last = state.failuresSince[0];
  if (!last) return null;
  if (last.reason === "budget") return last.finishedAt + CONSOLIDATION_BUDGET_RETRY_MS;
  if (!countsAsFailure(last.reason)) return last.finishedAt + CONSOLIDATION_CHANGED_RETRY_MS;
  const failures = consecutiveFailures(state).length;
  return last.finishedAt + CONSOLIDATION_BACKOFF_MS[Math.min(CONSOLIDATION_BACKOFF_MS.length, failures) - 1]!;
}

/**
 * Whether the message saying a scope's consolidation is stuck is owed now
 * (EO-577): its failures in a row have reached `CONSOLIDATION_STUCK_AFTER`
 * and none of them has had the note yet. Said once per run of failures —
 * a success, which ends the run, is what lets it be said again. The row
 * it is posted at, the newest of them; null when none is owed.
 */
export function stuckNoticeOwed(state: ScopeConsolidationState): ScopeConsolidationState["failuresSince"][number] | null {
  // Every failure since the last success, waits included: one that has
  // had the note is one whatever its reason.
  if (state.failuresSince.some((failure) => failure.stuckNoticed)) return null;
  const failures = consecutiveFailures(state);
  return failures.length >= CONSOLIDATION_STUCK_AFTER ? failures[0]! : null;
}

/**
 * The message saying a scope's consolidation is stuck
 * (EO-577): which scope, what it holds, how many times in a row it has
 * failed and why the last one did — and that nothing else is held up by
 * it.
 */
export function stuckNoticeBody(input: {
  scopeLabel: string;
  tally: ScopeTally;
  failures: number;
  last: { reason: string | null; note: string | null };
  retryAt: number | null;
}): string {
  const { tally } = input;
  const entries = tally.agentEntries + tally.personEntries;
  const chars = tally.agentChars + tally.personChars;
  const reason = input.last.reason ?? "error";
  const lines = [
    `Memory consolidation of ${input.scopeLabel} is stuck: it has failed ${input.failures} times in a row.`,
    "",
    `- **Holds:** ${entries} entries, ${chars.toLocaleString("en-US")} characters.`,
    `- **Last failure:** \`${reason}\`${input.last.note ? ` — ${input.last.note}` : ""}`,
  ];
  if (input.retryAt !== null) lines.push(`- **Next attempt:** ${new Date(input.retryAt).toISOString().replace("T", " ").slice(0, 16)} UTC, and a day apart after that until one succeeds.`);
  lines.push(
    "",
    "The scope keeps working as it is: agents are still given its memory and can still write to it, and no delivery waits on this. This message is not repeated until a consolidation of the scope succeeds, which resolves it.",
  );
  return lines.join("\n");
}

/**
 * What the scheduler should do about one scope now. `resumes` is a run
 * that stopped part-way taken up again under its own trigger
 * (`failedSinceSettled`), which alone may go on from where it stopped
 * (EO-913); any other starts from the scope as it is.
 */
export type ConsolidationDecision = { kind: "consolidate"; trigger: MemoryConsolidationTrigger; resumes?: true } | { kind: "none" };

/**
 * Whether the scope's last consolidation is a run that stopped part-way:
 * a batch failing after an earlier consolidation of the same run — a
 * batch, or the fold of exact duplicates — was applied (EO-574), which
 * settled the scope as it left it and counted as its last consolidation.
 * Such a run is asked again once its backoff is over, as any failure is
 * — not left waiting for somebody to write to the scope, nor for another
 * day and five runs. A run that failed before it applied anything is not
 * one (EO-913): nothing it did moved the day and the five runs, so it is
 * due again as the schedule says, and a person's request that failed so
 * is not repeated unasked. Nor is a failure from before the scope was
 * last settled (a restore since, say).
 */
export function failedSinceSettled(state: ScopeConsolidationState): boolean {
  const failed = state.failuresSince[0];
  return failed !== undefined && failed.afterApplied && state.settled !== null && failed.finishedAt >= state.settled.at;
}

/**
 * Whether a scope is due a consolidation (EO-480).
 *
 * - Never while one is running for it, or while a failed one is backing
 *   off (`retryAt`).
 * - Never for its size (EO-913): a scope holding many entries, or many
 *   characters, is not due for that.
 * - **Schedule:** more than 24 hours since it was last consolidated (or,
 *   never consolidated, since its oldest agent-written entry), at least
 *   five runs given its memory since then, and at least one agent-written
 *   entry written or changed since its last consolidation
 *   (`newEntries`) — what a scheduled consolidation is given. A scope
 *   with none has nothing new to tidy, and is left.
 * - **A run that stopped part-way** (`failedSinceSettled`) is taken up
 *   again once its backoff is over, with the trigger it ran under: a
 *   person's `manual` one goes on over the whole scope, a `schedule` one
 *   with what was new when it started and nothing written since — and
 *   where none of that is left, its retry finishes it without a call. No
 *   other trigger's
 *   failure skips the day and the five runs: a `cap` one, from before
 *   EO-913 removed that trigger, waits for the schedule as any scope
 *   does, and a container's `container_done` is `containerDoneDue`'s.
 *
 * Every one needs an agent-written entry: a person's are never sent, so a
 * scope of only those has nothing to consolidate. `runsDeliveredSince` is
 * asked only when the day has passed, because it reads run events, and
 * `newEntries` only once everything else says yes.
 */
export function consolidationDue(input: {
  tally: ScopeTally;
  state: ScopeConsolidationState;
  now: number;
  runsDeliveredSince: (since: number) => number;
  /** How many agent-written entries were written or changed since the scope's last consolidation (`entriesNewSinceConsolidated`). */
  newEntries: () => number;
}): ConsolidationDecision {
  const { tally, state, now } = input;
  if (state.running) return { kind: "none" };
  const retry = retryAt(state);
  if (retry !== null && now < retry) return { kind: "none" };
  if (tally.agentEntries === 0) return { kind: "none" };
  // A run that stopped part-way: its successful batches made it the
  // scope's last consolidation, so the day and the five runs would be
  // counted from them, and its failed batch never retried.
  if (failedSinceSettled(state)) {
    const interrupted = state.failuresSince[0]!.trigger;
    if (interrupted === "manual") return { kind: "consolidate", trigger: "manual", resumes: true };
    // Whatever is left of it: what it was to give, or nothing, which its
    // retry finds and finishes the run on without a call. Never what was
    // written since, which waits for the schedule (consolidator.ts).
    if (interrupted === "schedule") return { kind: "consolidate", trigger: "schedule", resumes: true };
  }
  const since = state.lastConsolidatedAt ?? tally.oldestAgentAt;
  if (since === null || now - since <= MEMORY_CONSOLIDATION_INTERVAL_MS) return { kind: "none" };
  if (input.runsDeliveredSince(since) < MEMORY_CONSOLIDATION_MIN_RUNS) return { kind: "none" };
  return input.newEntries() > 0 ? { kind: "consolidate", trigger: "schedule" } : { kind: "none" };
}

/** An entry a consolidation was given, as far as its answer is checked against it. */
export interface SentEntry {
  id: string;
  body: string;
  /** When it was written: what says whether another entry given is newer (`newer_entry`), and the day a relative date is counted from (`relative_date`). */
  createdAt: number;
  /** Whether it is flagged as correcting the repository file: what a `repository_file` rewrite that keeps its text must change. */
  contradictsRepositoryFile: boolean;
}

/** What else a consolidation's call was given, which a rewrite's reason is checked against (EO-913). */
export interface ConsolidationGiven {
  /** The text of each workspace CLAUDE.md or AGENTS.md it was given: what a `repository_file` rewrite takes its words from. */
  repositoryFiles: readonly string[];
}

const RELATIVE_TIME_SOURCE =
  "\\b(?:yesterday|today|tonight|tomorrow|recently|lately|the other day|(?:last|next|this|coming|past|previous)\\s+(?:night|morning|evening|week(?:end)?|month|year|quarter|sprint|release|(?:mon|tues|wednes|thurs|fri|satur|sun)day)|(?:\\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten|a few|few|several|couple of)\\s+(?:minutes?|hours?|days?|weeks?|months?|years?)\\s+(?:ago|back|from now)|in\\s+(?:\\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten|a few|a couple of)\\s+(?:minutes?|hours?|days?|weeks?|months?|years?)|(?:on\\s+)?(?:mon|tues|wednes|thurs|fri|satur|sun)day)\\b";
/**
 * A relative date or time an entry may say — "yesterday", "last week",
 * "three days ago", "in two weeks", "on Monday" — which a `relative_date`
 * rewrite makes absolute (EO-913). Matched case-insensitively.
 */
const RELATIVE_TIME = new RegExp(RELATIVE_TIME_SOURCE, "i");
const RELATIVE_TIMES = new RegExp(RELATIVE_TIME_SOURCE, "gi");

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
/** An absolute date: `2026-11-26`, `2026-11`, `November 26, 2026`, `26 November 2026`, `November 2026`. Every match, case-insensitively. */
const ABSOLUTE_DATE = new RegExp(
  `\\b(?:(\\d{4})-(\\d{2})(?:-(\\d{2}))?|${MONTH}\\.?\\s+(?:(\\d{1,2})(?:st|nd|rd|th)?,?\\s+)?(\\d{4})|(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH}\\.?,?\\s+(\\d{4}))\\b`,
  "gi",
);

/** Whether a body says a relative date or time (`RELATIVE_TIME`). */
export function saysRelativeTime(body: string): boolean {
  return RELATIVE_TIME.test(body);
}

function pad(value: string | number): string {
  return String(value).padStart(2, "0");
}

/**
 * The absolute dates a body says, each as the day or month it names
 * (`2026-10-24`, `2026-10`), so one date written two ways is one date:
 * "October 24, 2026" made "2026-10-24" says no date it did not.
 */
export function absoluteDates(body: string): Set<string> {
  const dates = new Set<string>();
  for (const match of body.matchAll(ABSOLUTE_DATE)) {
    const [, isoYear, isoMonth, isoDay, nameFirst, dayAfterName, yearAfterName, dayFirst, nameAfterDay, yearAfterDay] = match;
    if (isoYear !== undefined) dates.add(isoDay === undefined ? `${isoYear}-${isoMonth}` : `${isoYear}-${isoMonth}-${isoDay}`);
    else if (nameFirst !== undefined) {
      const month = pad(MONTHS.indexOf(nameFirst.slice(0, 3).toLowerCase()) + 1);
      dates.add(dayAfterName === undefined ? `${yearAfterName}-${month}` : `${yearAfterName}-${month}-${pad(dayAfterName)}`);
    } else if (nameAfterDay !== undefined) dates.add(`${yearAfterDay}-${pad(MONTHS.indexOf(nameAfterDay.slice(0, 3).toLowerCase()) + 1)}-${pad(dayFirst!)}`);
  }
  return dates;
}

/**
 * A text's terms: its words, lowercased, without the punctuation around
 * them — `test:api`, `2026-10-24` and `v1.2` stay one word each, and a
 * sign before a number is kept, so `-1` is not `1` — less the common words
 * (`COMMON_WORDS`), each brought to one spelling: `re-run` is `rerun`,
 * and `tests`, `pushing` and `pushed` are `test` and `push`. What a
 * correction's quoted sentence is compared with the part of the entry it
 * replaces by.
 */
function terms(text: string): Set<string> {
  const found = new Set<string>();
  for (const [raw] of text.toLowerCase().matchAll(/(?<![\p{L}\p{N}_])[-+]?[\p{L}\p{N}_]+(?:[.'’:/-][\p{L}\p{N}_]+)*/gu)) {
    if (COMMON_WORDS.has(raw)) continue;
    const sign = raw[0] === "-" || raw[0] === "+" ? raw[0] : "";
    let term = sign + raw.slice(sign.length).replace(/[-'’]/g, "");
    if (/^[a-z]+$/.test(term)) {
      if (term.endsWith("ies") && term.length > 4) term = `${term.slice(0, -3)}y`;
      else if (term.endsWith("ing") && term.length > 5) term = term.slice(0, -3);
      else if (term.endsWith("ed") && term.length > 4) term = term.slice(0, -2);
      else if (/(?:s|x|z|ch|sh)es$/.test(term) && term.length > 4) term = term.slice(0, -2);
      else if (term.endsWith("s") && !term.endsWith("ss") && term.length > 3) term = term.slice(0, -1);
    }
    found.add(term);
  }
  return found;
}

/**
 * Where a text's code spans are, delimiters included, as Markdown reads
 * them: a run of backticks to the next run of exactly as many, so
 * ``` ``today`` ``` is one span however many backticks it is written
 * with. A run that nothing closes is taken as code to the end of the
 * text: a literal EO cannot place is left as it is.
 */
function codeSpans(text: string): [number, number][] {
  const spans: [number, number][] = [];
  const runs = [...text.matchAll(/`+/g)];
  for (let at = 0; at < runs.length; at += 1) {
    const open = runs[at]!;
    const close = runs.findIndex((run, index) => index > at && run[0].length === open[0].length);
    if (close === -1) {
      spans.push([open.index, text.length]);
      break;
    }
    spans.push([open.index, runs[close]!.index + runs[close]![0].length]);
    at = close;
  }
  return spans;
}

/**
 * What a sentence says that another word for the same thing cannot stand
 * for (EO-913): each code span, each word with a digit in it (`16`,
 * `-1`, `v1.2`), each name or path (`config.today`, `src/main`,
 * `test:api`, `snake_case`), each acronym (`UTC`, `CI`), and whether it
 * negates (`not`, `never`, `don't`). Two sentences that differ in none
 * of these say the same thing in other words, as far as EO can tell, so
 * one is no correction of the other.
 */
function concreteTerms(text: string): Set<string> {
  const found = new Set<string>();
  let prose = text;
  for (const [start, end] of codeSpans(text)) {
    found.add(`\`${text.slice(start, end).replace(/^`+|`+$/g, "").trim()}\``);
    prose = prose.slice(0, start) + " ".repeat(end - start) + prose.slice(end);
  }
  for (const [raw] of prose.matchAll(/(?<![\p{L}\p{N}_])[-+]?[\p{L}\p{N}_]+(?:[.'’:/_-][\p{L}\p{N}_]+)*/gu)) {
    const word = raw.replace(/^[-+]/, "");
    if (/\p{N}/u.test(raw) || /[._:/]/.test(word) || /^\p{Lu}[\p{Lu}\p{N}]+$/u.test(word)) found.add(raw.toLowerCase());
  }
  if (/(?<![\p{L}\p{N}_])(?:no|not|never|nor|none|cannot|without)(?![\p{L}\p{N}_])|n['’]t(?![\p{L}\p{N}_])/iu.test(prose)) found.add("¬");
  return found;
}

/** The fewest words a sentence a correction quotes may have: fewer is a phrase every text has, not a statement. */
const MIN_QUOTED_WORDS = 3;

/**
 * Words too common to say what a sentence is about: left out of the
 * terms a correction is compared by. "no", "not" and "never" are not
 * among them — a correction may be one.
 */
const COMMON_WORDS = new Set(
  "a an the and or but so of to in on at for by with from into onto as than then is are was were be been being it its this that these those there here any all some each every do does did has have had will would can could should may might must".split(" "),
);

/**
 * What ends one sentence of a note or a repository file and starts the
 * next: a full stop, question or exclamation mark, semicolon or colon
 * followed by a space, a line break, or a spaced dash. A sentence ends
 * where the match starts, its mark included, and the next starts where
 * the match ends.
 */
const SENTENCE_BREAK = /(?<=[.!?;:])\s+|\r?\n+|\s[—–-]\s/g;

/** Each sentence of a text as where it starts and ends, whitespace around it left out. */
function sentenceSpans(text: string): [number, number][] {
  const spans: [number, number][] = [];
  const push = (start: number, end: number) => {
    while (start < end && /\s/.test(text[start]!)) start += 1;
    while (end > start && /\s/.test(text[end - 1]!)) end -= 1;
    if (end > start) spans.push([start, end]);
  };
  let at = 0;
  for (const found of text.matchAll(SENTENCE_BREAK)) {
    push(at, found.index);
    at = found.index + found[0].length;
  }
  push(at, text.length);
  return spans;
}

/** A text with its whitespace collapsed and one sentence mark at its end left out: what two sentences are compared as. */
function squashed(text: string): string {
  return text.replace(/\s+/g, " ").trim().replace(/[.!?;:]$/, "").trim();
}

/** Whether `quote` is, word for word and mark for mark, one or more whole sentences in a row of `source` (`sentenceSpans`). */
function isWholeSentencesOf(quote: string, source: string): boolean {
  const wanted = squashed(quote);
  const spans = sentenceSpans(source);
  for (let first = 0; first < spans.length; first += 1) {
    for (let last = first; last < spans.length; last += 1) {
      const candidate = squashed(source.slice(spans[first]![0], spans[last]![1]));
      if (candidate === wanted) return true;
      if (candidate.length > wanted.length) break;
    }
  }
  return false;
}

/**
 * Where a rewrite differs from its entry, widened to whole sentences: the
 * text before `start` and the `tail` characters after the changed
 * sentences are the entry's own, character for character, in both, and
 * `replaced` is what the rewrite put `put` in place of. Null where the two
 * are the same text.
 */
function changedSentences(entry: string, rewrite: string): { start: number; tail: number; replaced: string; put: string } | null {
  let head = 0;
  while (head < entry.length && head < rewrite.length && entry[head] === rewrite[head]) head += 1;
  if (head === entry.length && head === rewrite.length) return null;
  let tail = 0;
  while (tail < entry.length - head && tail < rewrite.length - head && entry[entry.length - 1 - tail] === rewrite[rewrite.length - 1 - tail]) tail += 1;
  // Back to the start of the sentence the change begins in, and on to the
  // end of the one it ends in, by breaks wholly within the text both share.
  let start = 0;
  for (const found of entry.slice(0, head).matchAll(SENTENCE_BREAK)) start = found.index + found[0].length;
  const after = entry.slice(entry.length - tail);
  const next = new RegExp(SENTENCE_BREAK.source).exec(after);
  const kept = next === null ? 0 : tail - next.index;
  return { start, tail: kept, replaced: entry.slice(start, entry.length - kept), put: rewrite.slice(start, rewrite.length - kept) };
}

/**
 * Why a rewrite does not put right what `sources` say, or null where it
 * does (EO-913) — the evidence a `repository_file` or `newer_entry`
 * rewrite is held to, by the text itself (invariant 5):
 *
 * - **One correction, the source's own words.** The rewrite is its entry
 *   with one run of whole sentences replaced (`changedSentences`), and
 *   every other character exactly as it was — a sign, an operator, a
 *   word dropped elsewhere is a change outside the correction. What it
 *   puts there is, mark for mark, one or more whole sentences in a row of
 *   a source, of `MIN_QUOTED_WORDS` words or more, that the entry did not
 *   already say.
 * - **About the same fact, and saying something else of it.** Compared
 *   term by term (`terms`), the source's sentence brings at least one the
 *   replaced sentence did not have — one that only repeats it, in fewer
 *   words or the same ones respelled, corrects nothing — and keeps at
 *   least as many of the replaced sentence's terms as it adds, and as it
 *   drops: a sentence on another subject that happens to share a word or
 *   two is not a correction of this one.
 * - **A concrete disagreement.** The two differ in something no synonym
 *   stands for (`concreteTerms`): a number, a name or path, a code span,
 *   an acronym, or a negation. "Execute pnpm test" for "Run pnpm test"
 *   differs in none, so however the source words it, it corrects nothing.
 * - **The entry's own beside it.** Something of the entry not common to
 *   every text is left outside the replaced sentences: an entry that would
 *   say only what the source says is the source again, and is retired
 *   rather than rewritten.
 *
 * Where no such disagreement can be found, the entry is left as it is:
 * a correction in plain words alone ("run" to "lint") is refused, which
 * costs a rewrite the model could have made, never a fact.
 */
function correctionProblem(rewrite: string, entry: string, sources: readonly string[], what: string): string | null {
  const had = entry.trim();
  const said = rewrite.trim();
  const changed = changedSentences(had, said);
  if (changed === null) return "changes nothing of the entry's text";
  const put = changed.put.trim();
  const replaced = changed.replaced.trim();
  if (put === "") return `takes sentences out of the entry, which no ${what} puts right`;
  if (replaced === "") return `adds a sentence to the entry rather than correcting one of it`;
  if (!sources.some((source) => isWholeSentencesOf(put, source))) {
    return `changes "${replaced}" to "${put}", which is not one or more whole sentences of ${what}, word for word; a correction puts the source's sentence in place of the entry's and changes nothing else`;
  }
  if ((put.match(/[\p{L}\p{N}_]+/gu) ?? []).length < MIN_QUOTED_WORDS) return `quotes "${put}", too short a sentence of ${what} to be a correction`;
  if (squashed(had).includes(squashed(put))) return `quotes "${put}", which the entry already says`;
  const was = terms(replaced);
  const now = terms(put);
  const shared = [...now].filter((term) => was.has(term)).length;
  const added = now.size - shared;
  const dropped = was.size - shared;
  if (added === 0) return `puts "${put}" for "${replaced}", which says nothing it did not, so it corrects nothing`;
  if (shared < added || shared < dropped) return `puts "${put}" for "${replaced}", which is about something else: a correction keeps at least as many of the words of the sentence it replaces as it adds or drops`;
  const before = concreteTerms(replaced);
  const after = concreteTerms(put);
  if (before.size === after.size && [...after].every((term) => before.has(term))) {
    return `puts "${put}" for "${replaced}", which disagrees with it in no number, name, path, code or negation, so it says the same in other words and corrects nothing`;
  }
  const own = had.slice(0, changed.start) + had.slice(had.length - changed.tail);
  if (terms(own).size === 0) return `says nothing but what ${what} says, so the entry is retired rather than rewritten`;
  return null;
}

const NUMBER_WORDS: Readonly<Record<string, number>> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const DAY_MS = 24 * 60 * 60 * 1000;
const COUNT = "(\\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten)";

/**
 * The date a relative date means, counted from the day its entry was
 * written as the model is shown it (UTC, `isoDay`), where EO can tell:
 * as a day (`YYYY-MM-DD`) for "today", "yesterday", "tomorrow", "N days
 * ago" and "in N days"; as a month (`YYYY-MM`) for "this month", "last
 * month" and "next month". Null for one it cannot — "last week", "on
 * Monday", "recently", "three months ago" — and for one a date cannot
 * stand for without losing what it says of the time of day, "tonight" or
 * "this morning": a `relative_date` rewrite leaves those as they are.
 */
export function resolvedDate(phrase: string, writtenAt: number): string | null {
  const said = phrase.toLowerCase().trim().replace(/\s+/g, " ");
  const day = (offset: number) => isoDay(Date.parse(isoDay(writtenAt)) + offset * DAY_MS);
  if (said === "today") return day(0);
  if (said === "yesterday") return day(-1);
  if (said === "tomorrow") return day(1);
  const count = (word: string) => (/^\d+$/.test(word) ? Number(word) : NUMBER_WORDS[word]!);
  const ago = new RegExp(`^${COUNT} days? (?:ago|back)$`).exec(said);
  if (ago) return day(-count(ago[1]!));
  const ahead = new RegExp(`^(?:in ${COUNT} days?|${COUNT} days? from now)$`).exec(said);
  if (ahead) return day(count((ahead[1] ?? ahead[2])!));
  const month = /^(this|last|previous|next|coming) month$/.exec(said);
  if (month) {
    const offset = { this: 0, last: -1, previous: -1, next: 1, coming: 1 }[month[1] as "this" | "last" | "previous" | "next" | "coming"];
    const written = new Date(writtenAt);
    const at = new Date(Date.UTC(written.getUTCFullYear(), written.getUTCMonth() + offset, 1));
    return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}`;
  }
  return null;
}

/** The one word a date put for a relative one may have before it, so it says what the phrase did and no more: "on" a day, "in" or "during" a month. */
const DAY_PREPOSITIONS = new Set(["on"]);
const MONTH_PREPOSITIONS = new Set(["in", "during"]);

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether the phrase at `index` is code rather than prose: within a code
 * span, however many backticks open it (`codeSpans`), or joined to a name or a path — `today_count`,
 * `config.today`, `today.json`, `--yesterday` — which is a literal a date
 * never stands for, and stays exactly as it is.
 */
function inCode(body: string, index: number, length: number): boolean {
  if (codeSpans(body).some(([start, end]) => index < end && index + length > start)) return true;
  const before = body[index - 1] ?? "";
  const after = body.slice(index + length, index + length + 2);
  return /[-_./\\@$#=]/.test(before) || /^(?:[-_/\\@=(]|\.\w)/.test(after);
}

/**
 * Why a `relative_date` rewrite does not hold, or null where it does:
 * the rewrite must be its entry with one or more of the relative dates or
 * times it says each replaced by the date EO reckons it meant
 * (`resolvedDate`), and nothing else changed — not a character outside
 * them, a space or a backtick included, nor the flag. A replacement is that date alone, or with "on" before a
 * day and "in" or "during" before a month, so it keeps the time relation
 * the phrase had: "before 2026-11-25" for "yesterday" says something
 * else. A phrase EO cannot date stays exactly as it is, and so does one
 * in code (`inCode`), which is a name rather than a date.
 */
function relativeDateProblem(rewrite: { body: string; contradictsRepositoryFile: boolean }, entry: SentEntry): string | null {
  const body = entry.body.trim();
  const phrases = [...body.matchAll(RELATIVE_TIMES)].filter((phrase) => !inCode(body, phrase.index, phrase[0].length));
  if (phrases.length === 0) return "gives relative_date, but the entry says no relative date or time outside code";
  if (rewrite.contradictsRepositoryFile !== entry.contradictsRepositoryFile) return "gives relative_date, but the rewrite also changes contradictsRepositoryFile";
  const pieces: string[] = [];
  let at = 0;
  for (const phrase of phrases) {
    pieces.push(escapeRegExp(body.slice(at, phrase.index)), "([\\s\\S]*?)");
    at = phrase.index + phrase[0].length;
  }
  pieces.push(escapeRegExp(body.slice(at)));
  const match = new RegExp(`^${pieces.join("")}$`).exec(rewrite.body.trim());
  if (match === null) return "gives relative_date, but the rewrite changes more than the relative dates and times the entry says";
  const written = isoDay(entry.createdAt);
  let replaced = 0;
  for (const [index, phrase] of phrases.entries()) {
    const put = match[index + 1]!;
    if (put === phrase[0]) continue;
    const meant = resolvedDate(phrase[0], entry.createdAt);
    if (meant === null) return `gives relative_date, but EO cannot tell what date "${phrase[0]}" in an entry written ${written} meant, so it stays as it is, not "${put}"`;
    replaced += 1;
    const dates = [...put.matchAll(ABSOLUTE_DATE)];
    const said = dates.length === 1 ? absoluteDates(put) : new Set<string>();
    if (said.size !== 1 || !said.has(meant)) return `gives relative_date, but "${phrase[0]}" in an entry written ${written} is ${meant}, not "${put}"`;
    const date = dates[0]!;
    const before = put.slice(0, date.index);
    const after = put.slice(date.index + date[0].length);
    const prepositions = meant.length === 10 ? DAY_PREPOSITIONS : MONTH_PREPOSITIONS;
    if (after !== "" || (before !== "" && !(before.endsWith(" ") && prepositions.has(before.slice(0, -1).toLowerCase())))) {
      return `gives relative_date, but "${put}", put for "${phrase[0]}", says more than ${meant}: only ${[...prepositions].map((word) => `"${word}"`).join(" or ")} may stand before it`;
    }
  }
  if (replaced === 0) return "gives relative_date, but the rewrite still says every relative date or time the entry did";
  return null;
}

/**
 * Why a rewrite's reason does not hold, or null where it does (EO-913):
 * what EO can check of the claim without a model (invariant 5), tied to
 * the change the rewrite makes rather than to what the call happened to
 * be given — so a rewrite that only shortens or rewords an entry is
 * refused under any reason it gives.
 *
 * - `relative_date` — the rewrite is the entry with one or more of the
 *   relative dates or times it says each replaced by the date EO reckons
 *   it meant, from the day the entry was written (`resolvedDate`), and
 *   nothing else changed (`relativeDateProblem`).
 * - `repository_file` — the rewrite carries over a whole sentence of a
 *   repository file the call was given, and changes nothing outside it
 *   (`correctionProblem`). It may clear `contradictsRepositoryFile` — the
 *   entry now says what the file does — but never set it.
 * - `newer_entry` — the same, with a sentence of an entry the call was
 *   given that was written after this one, and the flag as it was.
 *
 * No rewrite sets `contradictsRepositoryFile`, nor changes the flag
 * alone: EO cannot see that an entry disagrees with a file, so flagging
 * one is a merge's, which carries the entry it is about.
 */
export function rewriteReasonProblem(
  rewrite: { reason: MemoryConsolidationRewriteReason; body: string; contradictsRepositoryFile: boolean },
  entry: SentEntry,
  sent: readonly SentEntry[],
  given: ConsolidationGiven,
): string | null {
  switch (rewrite.reason) {
    case "relative_date":
      return relativeDateProblem(rewrite, entry);
    case "repository_file": {
      if (given.repositoryFiles.length === 0) return "gives repository_file, but no repository file was given";
      if (rewrite.contradictsRepositoryFile && !entry.contradictsRepositoryFile) return "gives repository_file, but sets contradictsRepositoryFile, which a rewrite never does";
      const problem = correctionProblem(rewrite.body, entry.body, given.repositoryFiles, "a repository file it was given");
      return problem === null ? null : `gives repository_file, but the rewrite ${problem}`;
    }
    case "newer_entry": {
      const newer = sent.filter((other) => other.id !== entry.id && other.createdAt > entry.createdAt);
      if (newer.length === 0) return "gives newer_entry, but no entry given is newer than this one";
      if (rewrite.contradictsRepositoryFile !== entry.contradictsRepositoryFile) return "gives newer_entry, but the rewrite also changes contradictsRepositoryFile";
      const problem = correctionProblem(rewrite.body, entry.body, newer.map((other) => other.body), "a newer entry it was given");
      return problem === null ? null : `gives newer_entry, but the rewrite ${problem}`;
    }
  }
}

/**
 * The shape one consolidation's answer is held to (EO-573): retire, merge
 * and rewrite operations, each naming only entries it was given — never a
 * person's, which are never sent — and none of them twice, across all
 * three lists, and every rewrite with the reason it is made (EO-913), so
 * one that only shortens or rewords an entry is refused with the whole
 * answer. One that changes nothing is a valid no-op, and its size is no
 * test of it either way. Checked again when the answer comes back
 * (invariant 5); the lists and the reasons reach the backend as JSON
 * Schema, the rest is checked here.
 *
 * The same for a batch, the whole set and the cross-batch pass's merge
 * call (EO-574). None of them carries skill proposals: those are asked
 * for in a call of their own (EO-575, `skillProposalsAnswerSchema`).
 */
export function consolidationAnswerSchema(sent: readonly SentEntry[], given: ConsolidationGiven): z.ZodType<MemoryConsolidationAnswer> {
  const known = new Set(sent.map((entry) => entry.id));
  const byId = new Map(sent.map((entry) => [entry.id, entry]));
  return MemoryConsolidationAnswerSchema.superRefine((answer, ctx) => {
    checkOperations(known, answer, ctx);
    answer.rewrite.forEach((rewrite, at) => {
      const entry = byId.get(rewrite.id);
      const problem = entry === undefined ? null : rewriteReasonProblem(rewrite, entry, sent, given);
      if (problem !== null) ctx.addIssue({ code: "custom", path: ["rewrite", at, "reason"], message: `${rewrite.id} ${problem}` });
    });
  });
}

function checkOperations(known: ReadonlySet<string>, answer: MemoryConsolidationOperations, ctx: z.RefinementCtx): void {
  const named = new Map<string, string>();
  const name = (id: string, path: (string | number)[]) => {
    const where = path.join(".");
    if (!known.has(id)) ctx.addIssue({ code: "custom", path, message: `names an entry it was not given: ${id}` });
    else if (named.has(id)) ctx.addIssue({ code: "custom", path, message: `names ${id} again, already named at ${named.get(id)}` });
    else named.set(id, where);
  };
  answer.retire.forEach((retire, at) => name(retire.id, ["retire", at, "id"]));
  answer.merge.forEach((merge, at) => merge.from.forEach((id, index) => name(id, ["merge", at, "from", index])));
  answer.rewrite.forEach((rewrite, at) => name(rewrite.id, ["rewrite", at, "id"]));
}

/** What the skill proposal call's answer is checked against: the scope it is about, and the item each entry it was given came from. */
export interface ProposalFacts {
  scope: MemoryScope;
  /** Each given entry's source item, or null for one with none. */
  sourceItems: ReadonlyMap<string, string | null>;
}

/**
 * The shape the skill proposal call's answer is held to (EO-575): at most
 * three proposals in `SkillProposalSchema`, and the half of a proposal
 * that schema cannot say (invariant 5) — it is for the scope it was asked
 * about, its evidence is entries it was given and the items those came
 * from, an improvement is to the skill its slug names, and no two
 * proposals share a slug.
 */
export function skillProposalsAnswerSchema(given: readonly { id: string }[], facts: ProposalFacts): z.ZodType<MemorySkillProposalsAnswer> {
  const known = new Set(given.map((entry) => entry.id));
  return MemorySkillProposalsAnswerSchema.superRefine((answer, ctx) => checkSkillProposals(answer.skills, known, facts, ctx));
}

function checkSkillProposals(skills: readonly z.infer<typeof SkillProposalSchema>[], known: ReadonlySet<string>, facts: ProposalFacts, ctx: z.RefinementCtx): void {
  const slugs = new Set<string>();
  skills.forEach((skill, at) => {
    const path = ["skills", at];
    if (slugs.has(skill.slug)) ctx.addIssue({ code: "custom", path: [...path, "slug"], message: `proposes "${skill.slug}" twice` });
    slugs.add(skill.slug);
    if (skill.kind === "improvement" && skill.target !== skill.slug) {
      ctx.addIssue({ code: "custom", path: [...path, "slug"], message: `is an improvement to "${skill.target}", so its slug is "${skill.target}"` });
    }
    const unknown = skill.evidence.entryIds.filter((id) => !known.has(id));
    if (unknown.length > 0) ctx.addIssue({ code: "custom", path: [...path, "evidence", "entryIds"], message: `names entries it was not given: ${unknown.join(", ")}` });
    if (skill.scope.kind !== facts.scope.kind || skill.scope.id !== facts.scope.id) {
      ctx.addIssue({ code: "custom", path: [...path, "scope"], message: `is not the scope it was asked about, ${facts.scope.kind} ${facts.scope.id}` });
    }
    const items = new Set(skill.evidence.entryIds.flatMap((id) => facts.sourceItems.get(id) ?? []));
    const strangers = skill.evidence.itemIds.filter((id) => !items.has(id));
    if (strangers.length > 0) {
      ctx.addIssue({ code: "custom", path: [...path, "evidence", "itemIds"], message: `names items its evidence entries did not come from: ${strangers.join(", ")}` });
    }
  });
}

/** A workspace's own instructions file, as it is on disk. */
export interface RepositoryFile {
  name: string;
  /** Which workspace it is from, for a project's consolidation, which is given each of its workspaces' (EO-514). Absent for a workspace's own. */
  workspace?: string;
  text: string;
  /** Whether it was cut to fit. */
  truncated: boolean;
}

/** What a consolidation may answer and how it should choose — the rules every call that answers with operations is told. */
const OPERATION_RULES = [
  "Answer with the changes to make, not with the entries to keep. Name only what changes: an entry you do not mention stays exactly as it is, so never list an entry just to keep it. There are three operations:",
  "- `retire`: `{ id, reason }` — retire one entry, saying in a few words why.",
  "- `merge`: `{ from, body, contradictsRepositoryFile }` — fold two or more entries (`from` holds at least two ids) into one new entry whose text is `body`.",
  `- \`rewrite\`: \`{ id, body, reason, contradictsRepositoryFile }\` — replace one entry's text with \`body\`. \`reason\` is one of ${MEMORY_CONSOLIDATION_REWRITE_REASONS.map((reason) => `\`${reason}\``).join(", ")}: a relative date or time the entry says made absolute, a disagreement with a repository file you are given put right, or a correction by an entry you are given that was written after it. EO checks each reason against the change itself and refuses the whole answer where one does not hold. A \`relative_date\` rewrite replaces only the relative date or time with the date it meant, counted from the date the entry was written, and changes not one other character of the entry — not a space, a backtick or a letter's case — nor contradictsRepositoryFile: a day as YYYY-MM-DD, alone or after "on", for "today", "yesterday", "tomorrow", "N days ago" or "in N days" — "yesterday" in an entry written 2026-11-26 is 2026-11-25, so "Released yesterday." becomes "Released 2026-11-25." or "Released on 2026-11-25.", never "Released before 2026-11-25." — and a month as YYYY-MM, alone or after "in" or "during", for "this month", "last month" or "next month". Any other relative phrase — "last week", "on Monday", "recently", "three months ago", and "tonight" or "this morning", whose time of day a date would lose — stays exactly as it is, and so does a word in code (inside a code span, however many backticks open it, or part of a name or path such as \`today_count\` or \`today.json\`). A \`repository_file\` rewrite replaces one or more whole sentences of the entry — from one full stop, semicolon, colon or line break to the next — with one or more whole sentences of the file, copied exactly, mark for mark, and leaves every other character of the entry exactly as it was: one correction per rewrite, and nothing else touched, not a sign, an operator or a word. The file's sentence must be about the same thing as the sentence it replaces and say something different of it: it keeps at least as many of that sentence's words as it adds, and as it drops, and it differs from it in a number, a name or path, a code span, an acronym or a negation — "Execute pnpm test" for "Run pnpm test" differs in none, and is refused. A sentence that only repeats the entry's in other or fewer words corrects nothing, and one about something else is no correction of it: leave the entry as it is. It must keep a sentence of the entry's own beside it, since an entry that would say only what the file says is retired instead. A \`newer_entry\` rewrite does the same with a whole sentence of the newer entry. A rewrite keeps the entry's contradictsRepositoryFile as it is, except that a \`repository_file\` rewrite may clear it; it never sets it, and an entry is never rewritten only to change it. There is no other reason to rewrite an entry: never rewrite one only to shorten it, reword it or tidy its style.`,
  "Every id you name must be one of the entries you are given, and each id may appear only once in the whole answer — in one retire, one merge's `from`, or one rewrite. An answer with nothing to change has all three lists empty; that is a valid answer, and often the right one.",
  "What to change, and nothing else:",
  `- Merge entries that state the same fact into one, keeping every detail any of them adds. Keep each entry you merge or rewrite to one fact, at most ${MAX_MEMORY_NOTE_CHARS} characters: an answer with a longer one is refused whole. Entries about one topic that state different facts are not duplicates; leave them as they are.`,
  "- Retire what is stale, contradicted by a newer entry, or derivable from the code itself — what an agent would see by reading the repository. Between two entries that disagree, the newer one is current.",
  "- Write the relative dates EO can date (\"yesterday\", \"in two days\", \"last month\") as absolute dates, using the date each entry was written, as the rewrite rule above says; leave every other relative phrase as it is.",
  "- When the workspace's CLAUDE.md or AGENTS.md is given — for a project, those of each of its workspaces — treat it as current: an entry that disagrees with it is rewritten to agree, or retired. The one exception is an entry that is plainly newer than the file and says it corrects it; keep it, and where you merge it set contradictsRepositoryFile to true on the merge that carries it. An entry already flagged stays flagged. Never suggest editing the file.",
  "- Do not invent anything an entry does not say.",
  "- How many entries there are, and how long they are, is no reason to change any of them. A distinct, current, useful entry stays exactly as it is, and a change you are unsure of is better left out.",
];

const MEMORY_TIDY_INTRO =
  "You tidy the memory an engineering tool keeps for its agents. Each entry is a note an agent wrote about a project or a workspace, for the next agent to read.";

/** What a consolidation is told: the operations and how to choose them, and nothing about skills (EO-575). */
export const MEMORY_CONSOLIDATE_SYSTEM = [MEMORY_TIDY_INTRO, ...OPERATION_RULES].join("\n");

/**
 * What the skill proposal call is told (EO-483, EO-575): asked on its own
 * once a consolidation of the scope has succeeded, over the scope's
 * entries as that consolidation left them.
 */
export const MEMORY_PROPOSE_SKILLS_SYSTEM = [
  "You read the memory an engineering tool keeps for its agents, and propose skills from it. Each entry is a note an agent wrote about a project or a workspace, for the next agent to read; the entries have just been tidied.",
  `Answer with up to ${MAX_SKILL_PROPOSALS} skills in \`skills\`. A skill is a procedure — how to run, debug or release something here, step by step — that an agent chooses by its description and reads when it needs it. Propose one only for a procedure that appears again and again across several entries, not for a single fact. When there is none, answer with \`skills\` empty; most of the time there is none.`,
  "- `kind` is `new`, or `improvement` when one of the existing skills you are shown already covers the procedure and the entries add to it or correct it. An improvement names that skill's slug in `target`, uses the same slug, and gives the skill's whole new body. A new skill never reuses an existing skill's slug.",
  "- `slug` is lowercase letters and digits with single hyphens. `name` is what a person calls it. `description` is one line saying when to use it: it is what a model chooses the skill by.",
  "- `scope` is exactly the scope you are told the entries are of.",
  "- `evidence.entryIds` are the ids of the given entries the procedure was seen in, and `evidence.itemIds` the items those entries came from, as each entry is labelled. The skill is created or changed as you propose it, with no person's approval, and its evidence entries leave memory for it, so name only entries that hold the procedure and nothing else worth keeping.",
  `- \`body\` is the SKILL.md body, in markdown, with these sections as headings: ${SKILL_PROPOSAL_SECTIONS.map((section) => `\`## ${section}\``).join(", ")} — when to use it, what to do, and how to know it worked.`,
  "- Never propose again what a person discarded, or a skill a person archived: not under the same slug, and not as the same procedure under another slug or in other words.",
  "- Do not invent anything an entry does not say.",
].join("\n");

/**
 * What the cross-batch pass's last call is told (EO-574): the same
 * operations and rules, over entries picked from across the scope's
 * batches as possible duplicates, and no skill proposals.
 */
export const MEMORY_CROSS_BATCH_MERGE_SYSTEM = [
  MEMORY_TIDY_INTRO,
  "The scope was tidied in batches, so entries that say the same thing may have been in different batches and never seen side by side. The entries you are given were picked from across those batches, in groups, as possible duplicates of one another. Merge those that state the same fact; leave alone those that only look alike, or state different facts about one topic. A group is a suggestion: you may merge part of one, or entries from two.",
  ...OPERATION_RULES,
].join("\n");

function isoDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** An existing skill a proposal may improve: one in the scope, or a global one. */
export interface ExistingSkill {
  id: string;
  slug: string;
  description: string;
  /** `global`, or this scope. */
  scopeLabel: string;
  body: string;
}

/** A proposal a person discarded in the scope, or a skill a consolidation created there that a person archived: what the skill proposal call is told not to make again (EO-512, EO-719). */
export interface DiscardedProposal {
  slug: string;
  description: string;
}

/** The most of one existing skill's body the skill proposal call is shown. */
const EXISTING_SKILL_BODY_MAX_CHARS = 6_000;
/** The most existing skills the skill proposal call is shown. */
export const EXISTING_SKILLS_MAX = 30;

/**
 * Which part of a scope one call is given, when it is not the whole
 * scope's agent entries in one call: its place among the run's batches,
 * and what the whole scope's agents hold, so the model knows the rest
 * exist and are not its to name. `new` is a scheduled consolidation's
 * batch (EO-913): entries written or changed since the scope's last
 * consolidation, the ids `fresh` holds, each with the entries most like
 * it; otherwise it is one of the batches the whole scope was cut into
 * (EO-574).
 */
export interface ConsolidationBatchPart {
  index: number;
  count: number;
  scopeEntries: number;
  scopeChars: number;
  fresh?: ReadonlySet<string>;
}

/**
 * Each entry with its id, the day it was written, the item it came from
 * and its flag, oldest first — and, where `likelyDuplicates` says so, the
 * others it is likely a duplicate of (EO-576), and where `fresh` holds it,
 * that it is new since the last consolidation (EO-913).
 */
function entryLines(entries: readonly MemoryEntryView[], likelyDuplicates?: ReadonlyMap<string, readonly string[]>, fresh?: ReadonlySet<string>): string[] {
  const lines: string[] = [];
  for (const entry of [...entries].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))) {
    const item = entry.source.type === "run" && entry.source.itemId !== null ? `; from item ${entry.source.itemId}` : "";
    const alike = likelyDuplicates?.get(entry.id) ?? [];
    const duplicate = alike.length > 0 ? `; likely a duplicate of ${alike.join(", ")}` : "";
    const isNew = fresh?.has(entry.id) === true ? "; new since the last consolidation" : "";
    lines.push("", `### ${entry.id} (written ${isoDay(entry.createdAt)}${item}${isNew}${entry.contradictsRepositoryFile ? "; already flagged as correcting the repository file" : ""}${duplicate})`, entry.body);
  }
  return lines;
}

/** What a call is told about the entries marked as likely duplicates, when any are. */
const LIKELY_DUPLICATES_NOTE =
  "Entries marked \"likely a duplicate of\" were found by EO, without reading them, to share most of their wording with the entries named. Read each such set first: merge those that state the same fact, keeping every fact any of them adds; leave apart those that only look alike.";

const charsOf = (entries: readonly { body: string }[]) => entries.reduce((sum, entry) => sum + entry.body.length, 0);

/** What a consolidation is told: today, the entries with their ids and dates, and the workspace's file. No target: size is not what it is for (EO-913). */
export function consolidationInput(input: {
  scopeLabel: string;
  entries: readonly MemoryEntryView[];
  /** Which part of the scope these entries are, when they are not its whole set in one call (EO-574, EO-913). */
  batch?: ConsolidationBatchPart;
  repositoryFiles: readonly RepositoryFile[];
  /**
   * For each entry found to be a likely duplicate of others (EO-576,
   * `nearDuplicateGroups`), those others. Marked on each entry, where
   * those others are in this call too.
   */
  likelyDuplicates?: ReadonlyMap<string, readonly string[]>;
  now: number;
}): string {
  const lines: string[] = [`Today is ${isoDay(input.now)}.`];
  const { batch } = input;
  if (batch?.fresh) {
    lines.push(
      `These are ${input.entries.length} of the agent-written memory entries of ${input.scopeLabel}, ${charsOf(input.entries)} characters${batch.count > 1 ? `: batch ${batch.index} of ${batch.count}` : ""}. Those marked "new since the last consolidation" were written or changed since the scope was last tidied; each is given with the existing entries most like it, which it may repeat, correct or be corrected by.`,
      `The scope's agents hold ${batch.scopeEntries} entries in ${batch.scopeChars} characters; the rest were tidied before and are not part of this, so change only these.`,
    );
  } else if (batch) {
    lines.push(
      `These are ${input.entries.length} of the agent-written memory entries of ${input.scopeLabel}, ${charsOf(input.entries)} characters: batch ${batch.index} of ${batch.count}, chosen so that entries alike tend to share one.`,
      `The scope's agents hold ${batch.scopeEntries} entries in ${batch.scopeChars} characters; the others are consolidated in their own batches, so change only these.`,
    );
  } else {
    lines.push(`These are the agent-written memory entries of ${input.scopeLabel}: ${input.entries.length} entries, ${charsOf(input.entries)} characters.`);
  }
  const given = new Set(input.entries.map((entry) => entry.id));
  const marks = new Map<string, string[]>();
  for (const [id, others] of input.likelyDuplicates ?? []) {
    const here = others.filter((other) => given.has(other));
    if (given.has(id) && here.length > 0) marks.set(id, here);
  }
  if (marks.size > 0) lines.push(LIKELY_DUPLICATES_NOTE);
  lines.push("", "## Entries", ...entryLines(input.entries, marks, batch?.fresh));
  for (const file of input.repositoryFiles) {
    const whose = file.workspace === undefined ? "The workspace's" : `The workspace ${JSON.stringify(file.workspace)}'s`;
    lines.push("", `## ${whose} ${file.name}${file.truncated ? " (cut short to fit)" : ""}`, file.text);
  }
  return lines.join("\n");
}

/**
 * What the skill proposal call is told (EO-575): today, the scope as a
 * proposal names it, the scope's agent-written entries as a consolidation
 * just left them — each with its id, its day and the item it came from —
 * the skills a proposal may improve, and every proposal a person
 * discarded in the scope.
 */
export function skillProposalsInput(input: {
  scopeLabel: string;
  scope: MemoryScope;
  entries: readonly MemoryEntryView[];
  /** Existing skills in the scope or global, which a proposal may improve (EO-483). */
  skills: readonly ExistingSkill[];
  /** Proposals a person discarded in the scope, and consolidation-created skills a person archived there, newest first (EO-512, EO-719). */
  discarded: readonly DiscardedProposal[];
  now: number;
}): string {
  const lines: string[] = [
    `Today is ${isoDay(input.now)}.`,
    `These are the agent-written memory entries of ${input.scopeLabel}: ${input.entries.length} entries, ${charsOf(input.entries)} characters.`,
    `The scope they are of, as a skill proposal's \`scope\` names it: ${JSON.stringify({ kind: input.scope.kind, id: input.scope.id })}.`,
    "",
    "## Entries",
    ...entryLines(input.entries),
  ];
  const skills = input.skills.slice(0, EXISTING_SKILLS_MAX);
  lines.push("", "## Existing skills", skills.length === 0 ? "None yet." : "A proposal may improve one of these; a new one may not reuse their slugs.");
  for (const skill of skills) {
    const cut = skill.body.length > EXISTING_SKILL_BODY_MAX_CHARS;
    lines.push("", `### ${skill.slug} (${skill.scopeLabel}${cut ? "; body cut short" : ""})`, skill.description, "", skill.body.slice(0, EXISTING_SKILL_BODY_MAX_CHARS));
  }
  // What a person already turned down. Without it the model has no
  // reason to know, and proposes the same skill again in new words.
  // Every one, uncapped: a discard left out is a procedure the model
  // is free to propose again under another slug. Each is one line of at
  // most a slug and a description's 300 characters.
  if (input.discarded.length > 0) {
    lines.push(
      "",
      "## Skill proposals a person discarded",
      "A person turned these down: discarded the proposal, or archived the skill a consolidation made. Do not propose them again — not under the same slug, and not as the same procedure under another slug or in other words. EO will not apply a proposal with one of these slugs.",
      "",
    );
    for (const proposal of input.discarded) lines.push(`- \`${proposal.slug}\`: ${proposal.description}`);
  }
  return lines.join("\n");
}

/**
 * What the cross-batch pass's last call is told (EO-574): the entries
 * picked as possible duplicates, with their full bodies, group by group.
 */
export function crossBatchMergeInput(input: { scopeLabel: string; groups: readonly (readonly MemoryEntryView[])[]; now: number }): string {
  const entries = input.groups.flat();
  const lines: string[] = [
    `Today is ${isoDay(input.now)}.`,
    `These are ${entries.length} of the agent-written memory entries of ${input.scopeLabel}, ${charsOf(entries)} characters, in ${input.groups.length} groups of possible duplicates.`,
  ];
  input.groups.forEach((group, at) => lines.push("", `## Possible duplicates ${at + 1}`, ...entryLines(group)));
  return lines.join("\n");
}

// ── The end of a container's work (EO-596) ──────────────────────

/**
 * Whether a container scope is due its `container_done` consolidation
 * (EO-596): the work filed under the container has finished
 * (`finishedAt`, `containerWorkFinishedAt`), the scope holds an entry an
 * agent wrote — a person's are never sent, so a container of only those,
 * or of none, queues nothing — and nobody has restored one since that
 * finish, which is a person saying the container's entries are to stay.
 *
 * Never while one is running for the scope, nor while a failed one is
 * backing off (`retryAt`), as any consolidation. Once one has succeeded
 * the scope holds no agent's entry and is not due again; one that stopped
 * part-way leaves some, and is taken up again after its backoff. A finish
 * after the restore — an item filed under the container later, finished
 * in its turn — is a new end, and due.
 */
export function containerDoneDue(input: {
  tally: ScopeTally;
  state: ScopeConsolidationState;
  finishedAt: number | null;
  /** When a person last restored a `container_done` consolidation of the scope, or null. */
  restoredAt: number | null;
  now: number;
}): boolean {
  const { tally, state } = input;
  if (input.finishedAt === null || tally.agentEntries === 0 || state.running) return false;
  if (input.restoredAt !== null && input.restoredAt >= input.finishedAt) return false;
  const retry = retryAt(state);
  return retry === null || input.now >= retry;
}

/**
 * What a `container_done` consolidation is told (EO-596): the container's
 * work is over, its entries were written for that work alone, and only
 * what will still hold for the project goes on — as entries of the
 * project, one fact each. What is not kept is retired, so the answer
 * names only what is kept.
 */
export const MEMORY_CONTAINER_DONE_SYSTEM = [
  "You tidy the memory an engineering tool keeps for its agents. The entries you are given were written by agents for the work filed under one container item: what the items under it needed from one another while that work was in progress. That work is now finished, every item under it done, so the container's memory ends here.",
  "Answer with `keep`: the facts from these entries that will still be true, and still matter, to a later agent working on something else in the project now that this work is finished — how to build, run or test the project, a rule the whole project follows, a trap in how the code works. Each becomes an entry of the project. Every entry you do not draw a kept fact from is retired.",
  "- Each kept fact is `{ from, body }`: `from` holds the ids of the entries it is drawn from — one, or several that say parts of one thing — and `body` is the fact, standing on its own.",
  `- Keep each fact to one fact, at most ${MAX_MEMORY_NOTE_CHARS} characters: an answer with a longer one is refused whole. Two facts are two kept entries, so each can reach the run it bears on without the other.`,
  "- Leave out what was only true while the work was in progress: who was doing what, what was still to do, what was missing or wrong in the work, maps of code that was being written, findings about a change. They mattered to the items under the container, and nobody will need them now.",
  "- Every id you name must be one of the entries you are given, and each id may appear in only one kept fact's `from`. Keeping nothing is a valid answer, and retires them all.",
  "- When you rewrite, write relative dates and times (\"yesterday\", \"last week\") as absolute dates, using the date each entry was written.",
  "- Do not invent anything an entry does not say. A fact you are unsure will still hold is better left out.",
].join("\n");

/**
 * What a `container_done` consolidation is given (EO-596): today, which
 * container's work finished and which project its kept facts go to, and
 * the entries with their ids, dates and the items they came from — of a
 * batch where the scope is consolidated in more than one.
 */
export function containerDoneInput(input: {
  containerLabel: string;
  projectLabel: string;
  entries: readonly MemoryEntryView[];
  batch?: { index: number; count: number; scopeEntries: number };
  now: number;
}): string {
  const lines = [
    `Today is ${isoDay(input.now)}.`,
    `The work filed under ${input.containerLabel} is finished. What will still hold goes to ${input.projectLabel}; the rest is retired.`,
    input.batch
      ? `These are ${input.entries.length} of the ${input.batch.scopeEntries} agent-written entries of its memory: batch ${input.batch.index} of ${input.batch.count}. The others are in their own batches, so name only these.`
      : `These are the agent-written entries of its memory: ${input.entries.length} entries, ${charsOf(input.entries)} characters.`,
    "",
    "## Entries",
    ...entryLines(input.entries),
  ];
  return lines.join("\n");
}

/**
 * The shape a `container_done` answer is held to (EO-596): every id a
 * kept fact is drawn from is one of the entries it was given, and none is
 * drawn on by two. Checked again when the answer comes back (invariant 5).
 */
export function containerDoneAnswerSchema(sent: readonly { id: string }[]): z.ZodType<MemoryContainerDoneAnswer> {
  const known = new Set(sent.map((entry) => entry.id));
  return MemoryContainerDoneAnswerSchema.superRefine((answer, ctx) => {
    const named = new Map<string, string>();
    answer.keep.forEach((keep, at) =>
      keep.from.forEach((id, index) => {
        const path = ["keep", at, "from", index];
        if (!known.has(id)) ctx.addIssue({ code: "custom", path, message: `names an entry it was not given: ${id}` });
        else if (named.has(id)) ctx.addIssue({ code: "custom", path, message: `names ${id} again, already named at ${named.get(id)}` });
        else named.set(id, path.join("."));
      }),
    );
  });
}

/** Why an entry a `container_done` consolidation did not keep was retired. */
export const CONTAINER_DONE_RETIRE_REASON = "only true while the container's work was in progress";

/**
 * A `container_done` answer as operations (EO-596), so it is applied by
 * the one function every consolidation is (`applyConsolidation`, with the
 * project as where it writes): a fact drawn from several entries is a
 * merge, one drawn from one a rewrite, and every entry given that no kept
 * fact is drawn from is retired.
 */
export function containerDoneOperations(sent: readonly { id: string }[], answer: MemoryContainerDoneAnswer): MemoryConsolidationOperations {
  const kept = new Set(answer.keep.flatMap((keep) => keep.from));
  return {
    retire: sent.filter((entry) => !kept.has(entry.id)).map((entry) => ({ id: entry.id, reason: CONTAINER_DONE_RETIRE_REASON })),
    merge: answer.keep.filter((keep) => keep.from.length > 1).map((keep) => ({ from: keep.from, body: keep.body, contradictsRepositoryFile: false })),
    rewrite: answer.keep.filter((keep) => keep.from.length === 1).map((keep) => ({ id: keep.from[0]!, body: keep.body, contradictsRepositoryFile: false })),
  };
}
