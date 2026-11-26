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
  /**
   * Entries it is shown as context only, which no operation may name: on
   * the schedule, a new entry given as another's neighbour whose own batch
   * is still to come (EO-913). Changed there, it would no longer be new,
   * and its own batch would never be asked.
   */
  context?: ReadonlySet<string>;
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
 * Where a text's code is, delimiters included (EO-913): fenced blocks
 * (a line opening with three or more backticks or tildes, to the line
 * closing it with as many of the same or more, at most three spaces in, as
 * deep in block quotes as it opened and on no new list item), indented lines (four
 * spaces or a tab) — either of them inside block quotes and list items,
 * nested in any order — `<code>` and `<pre>` elements, and inline code spans
 * as Markdown reads them — a run of backticks to the next run of exactly
 * as many, so ``` ``today`` ``` is one span however many backticks it is
 * written with. A fence or a run that nothing closes is taken as code to
 * the end of the text: a literal EO cannot place is left as it is.
 */
function codeSpans(text: string): [number, number][] {
  const blocks = codeBlocks(text);
  const blank = (spans: readonly [number, number][], from: string) => {
    let out = from;
    for (const [start, end] of spans) out = out.slice(0, start) + " ".repeat(end - start) + out.slice(end);
    return out;
  };
  const rest = blank(blocks, text);
  const runs = [...rest.matchAll(/`+/g)];
  for (let at = 0; at < runs.length; at += 1) {
    const open = runs[at]!;
    const close = runs.findIndex((run, index) => index > at && run[0].length === open[0].length);
    if (close === -1) {
      blocks.push([open.index, text.length]);
      break;
    }
    blocks.push([open.index, runs[close]!.index + runs[close]![0].length]);
    at = close;
  }
  return blocks.sort((a, b) => a[0] - b[0]);
}

/**
 * Whether a line's leading whitespace makes it indented code (EO-913):
 * four columns or more, a tab counted to the next multiple of four, or any
 * tab at all among it. A tab after a space reaches the fourth column, and
 * where it falls after a quote's or a list's marker EO does not reckon the
 * columns, so a tab in an indent is taken as code: over-reach only leaves
 * more text as it is.
 */
function indentsAsCode(line: string): boolean {
  const indent = /^[ \t]*/.exec(line)![0];
  return indent.includes("\t") || indent.length >= 4;
}

/**
 * Where a text's code blocks are, delimiters included (EO-913): fenced
 * blocks, indented lines and `<pre>` and `<code>` elements, as `codeSpans`
 * reads them, but not inline code spans — the part of a source that is an
 * example rather than something it says.
 */
function codeBlocks(text: string): [number, number][] {
  const blocks: [number, number][] = [];
  let fence: { char: string; length: number; start: number; depth: number } | null = null;
  for (let at = 0; at < text.length; ) {
    const breakAt = text.indexOf("\n", at);
    const next = breakAt === -1 ? text.length : breakAt + 1;
    const line = text.slice(at, next).replace(/\r?\n$/, "");
    // A block quote's markers are not the line's content: a fence or an
    // indented line inside one is code all the same.
    // Nor are a list item's: a fence may open after them, in any nesting
    // of the two ("- > ~~~sh"). Taking off more than Markdown would only
    // takes more as code, which is left as it is.
    const inner = line.replace(/^(?:[ \t]*(?:>|(?:[-*+]|\d{1,9}[.)])(?=[ \t]))[ \t]?)+/, "");
    // How many quotes deep the line is, and whether a list item opens on it.
    const markers = line.slice(0, line.length - inner.length);
    const depth = markers.split(">").length - 1;
    if (fence !== null) {
      // Closed only as Markdown surely closes it: at most three spaces in,
      // as deep in quotes as it opened, and on no new list item, which
      // would end the item it opened in and open a fence of its own. A
      // closer EO is unsure of leaves the block open, which leaves more of
      // the text as it is.
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(inner);
      if (close !== null && close[1]![0] === fence.char && close[1]!.length >= fence.length && depth === fence.depth && !/[-*+\d]/.test(markers)) {
        blocks.push([fence.start, at + line.length]);
        fence = null;
      }
    } else {
      const open = /^[ \t]*(`{3,}|~{3,})/.exec(inner);
      if (open !== null && !(open[1]![0] === "`" && inner.slice(open[0].length).includes("`"))) fence = { char: open[1]![0]!, length: open[1]!.length, start: at, depth };
      else if ((indentsAsCode(inner) || indentsAsCode(line)) && inner.trim() !== "") blocks.push([at, at + line.length]);
    }
    at = next;
  }
  if (fence !== null) blocks.push([fence.start, text.length]);
  let rest = text;
  for (const [start, end] of blocks) rest = rest.slice(0, start) + " ".repeat(end - start) + rest.slice(end);
  for (const element of rest.matchAll(/<(code|pre)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi)) blocks.push([element.index, element.index + element[0].length]);
  return blocks.sort((a, b) => a[0] - b[0]);
}

/** A word as a correction is read by: a sign before a number kept, and a name or path (`config.today`, `src/main`, `don't`) one word. */
const CONCRETE_WORD = /(?<![\p{L}\p{N}_])[-+]?[\p{L}\p{N}_]+(?:[.'’:/_-][\p{L}\p{N}_]+)*/gu;

/** A digit and the word for it, so "2" said as "two" is not a number dropped. */
const NUMBER_NAMES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];

/** Whether a text negates (`not`, `never`, `don't`). */
function negates(prose: string): boolean {
  return /(?<![\p{L}\p{N}_])(?:no|not|never|nor|none|cannot|without)(?![\p{L}\p{N}_])|n['’]t(?![\p{L}\p{N}_])/iu.test(prose);
}

/** A text's words, lowercased, with every negation taken out: "Do not run" and "Run", "don't" and "do", say the same but for it. */
function withoutNegation(text: string): string {
  return text
    .toLowerCase()
    .replace(/`/g, " ")
    .replace(/\b(?:do|does|did)\s+not\b|\b(?:do|does|did)n['’]t\b/g, " ")
    .replace(/\bcannot\b|\bcan['’]t\b/g, "can")
    .replace(/\bwon['’]t\b/g, "will")
    .replace(/n['’]t\b/g, "")
    .replace(/\b(?:not|never|no)\b/g, " ")
    .replace(/[^\p{L}\p{N}_'’.:/+-]+/gu, " ")
    .trim();
}

/**
 * Whether `put` says `term` in any notation (EO-913): as a word of it, or
 * within it as code or prose (`pnpm test` and pnpm test are one), a
 * number as its word ("2" as "two"), or an acronym as words whose initials
 * are its letters ("CI" as "continuous integration"). A sign before a
 * number is part of it: "-1" does not say 1.
 */
function sayer(put: string): (term: string) => boolean {
  const flat = put.replace(/`/g, "").toLowerCase();
  const words = [...flat.matchAll(CONCRETE_WORD)].map(([word]) => word);
  const said = new Set(words);
  const initials = words.map((word) => word.replace(/^[-+]/, "")[0] ?? "");
  const spelled = (acronym: string) => {
    const letters = [...acronym].sort().join("");
    for (let at = 0; at + acronym.length <= initials.length; at += 1) {
      if (initials.slice(at, at + acronym.length).sort().join("") === letters) return true;
    }
    return false;
  };
  const within = (term: string) => {
    for (let from = 0; ; ) {
      const at = flat.indexOf(term, from);
      if (at === -1) return false;
      const before = /^[\p{N}]/u.test(term) ? /[\p{L}\p{N}_+-]/u : /[\p{L}\p{N}_]/u;
      if (!before.test(flat[at - 1] ?? "") && !/[\p{L}\p{N}_]/u.test(flat[at + term.length] ?? "")) return true;
      from = at + 1;
    }
  };
  return (term) => {
    const word = term.toLowerCase();
    if (said.has(word) || within(word)) return true;
    if (/^\d+$/.test(word) && said.has(NUMBER_NAMES[Number(word)] ?? "")) return true;
    return /^[a-z]{2,}$/.test(word) && spelled(word);
  };
}

/**
 * Words too common to say what a sentence is about: left out of the
 * terms a correction's context is compared by. "no", "not" and "never"
 * are not among them — a correction may be one.
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

/** One piece of a text as a correction is diffed by: a word (`CONCRETE_WORD`), a run of whitespace, or one other mark. */
interface Token {
  text: string;
  start: number;
  kind: "word" | "space" | "mark";
}

const TOKEN = /(?<![\p{L}\p{N}_])(?:[-+](?=\p{N}))?[\p{L}\p{N}_]+(?:[.'’:/_-][\p{L}\p{N}_]+)*|\s+|[\s\S]/gu;

function tokensOf(text: string): Token[] {
  return [...text.matchAll(TOKEN)].map((match) => ({
    text: match[0],
    start: match.index,
    kind: /^\s+$/.test(match[0]) ? "space" : /^[-+]?[\p{L}\p{N}_]/u.test(match[0]) && match[0].length > (/^[-+]/.test(match[0]) ? 1 : 0) ? "word" : "mark",
  }));
}

/**
 * Where two token lists differ (EO-913): each run of the first replaced
 * by a run of the second, as half-open token ranges, by their longest
 * common subsequence — everything between two runs is the same token for
 * token, whitespace included. Runs only whitespace apart are one run.
 */
function changedRuns(from: readonly Token[], to: readonly Token[]): { from: [number, number]; to: [number, number] }[] {
  let head = 0;
  while (head < from.length && head < to.length && from[head]!.text === to[head]!.text) head += 1;
  let tail = 0;
  while (tail < from.length - head && tail < to.length - head && from[from.length - 1 - tail]!.text === to[to.length - 1 - tail]!.text) tail += 1;
  const a = from.slice(head, from.length - tail);
  const b = to.slice(head, to.length - tail);
  // Longest common subsequence of the middle, from the end.
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * width + j] = a[i]!.text === b[j]!.text ? table[(i + 1) * width + j + 1]! + 1 : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    }
  }
  const runs: { from: [number, number]; to: [number, number] }[] = [];
  let open: { from: [number, number]; to: [number, number] } | null = null;
  let i = 0;
  let j = 0;
  const close = () => {
    if (open !== null) runs.push(open);
    open = null;
  };
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i]!.text === b[j]!.text) {
      close();
      i += 1;
      j += 1;
      continue;
    }
    open ??= { from: [head + i, head + i], to: [head + j, head + j] };
    if (j < b.length && (i === a.length || table[i * width + j + 1]! >= table[(i + 1) * width + j]!)) j += 1;
    else i += 1;
    open.from[1] = head + i;
    open.to[1] = head + j;
  }
  close();
  // Runs with only whitespace between them, on both sides, are one.
  const merged: { from: [number, number]; to: [number, number] }[] = [];
  for (const run of runs) {
    const last = merged[merged.length - 1];
    const gap = (tokens: readonly Token[], start: number, end: number) => tokens.slice(start, end).every((token) => token.kind === "space");
    if (last !== undefined && gap(from, last.from[1], run.from[0]) && gap(to, last.to[1], run.to[0])) {
      last.from[1] = run.from[1];
      last.to[1] = run.to[1];
    } else merged.push({ from: [...run.from], to: [...run.to] });
  }
  return merged;
}

/** Whether a word says a value no synonym stands for: code (`codeSpans`), a number, a name or path, or an acronym. */
function isConcrete(token: Token, code: readonly [number, number][]): boolean {
  return code.some(([start, end]) => token.start >= start && token.start < end) || isConcreteWord(token.text);
}

/** A text's terms, as a correction's context is compared by: its words, lowercased, less the common ones (`COMMON_WORDS`), each in one spelling (`terms`). */
function terms(text: string): Set<string> {
  const found = new Set<string>();
  for (const [raw] of text.replace(/`/g, " ").toLowerCase().matchAll(CONCRETE_WORD)) {
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

/** Whether a word says a value no synonym stands for, as `isConcrete` reads one in prose: a number, a name or path, or an acronym. */
function isConcreteWord(word: string): boolean {
  const bare = word.replace(/^[-+]/, "");
  return /\p{N}/u.test(word) || /[._:/]/.test(bare) || /^\p{Lu}[\p{Lu}\p{N}]+$/u.test(bare);
}

/**
 * A sentence as it is compared with another (EO-913): a list, quote or
 * heading marker off its start, one closing mark off, backticks gone, and
 * prose with its whitespace collapsed. Code is kept exactly as written,
 * its case and its whitespace, and every word keeps its case: `/tmp/NEW`
 * is another path than `/tmp/new` on a case-sensitive filesystem,
 * `pnpm  test` another command line than `pnpm test`, and "getcache" may
 * be another name than `getCache` — EO cannot tell a word in prose from
 * an identifier written without backticks.
 */
function sentenceKey(text: string): string {
  const bare = text.replace(/^\s*(?:(?:[-*+>#]+|\d{1,9}[.)])\s+)+/, "");
  const prose = (part: string) => part.replace(/\s+/g, " ");
  let key = "";
  let at = 0;
  for (const [start, end] of codeSpans(bare)) {
    if (start < at) continue;
    key += prose(bare.slice(at, start)) + bare.slice(start, end).replace(/`/g, "");
    at = end;
  }
  key += prose(bare.slice(at));
  return key.trim().replace(/[.!?;:,]$/, "").trim();
}

/** A word that opens a sentence by qualifying the one before it: "It is only a fallback.", "Unless CI is down." */
const QUALIFYING_START = /^(?:it|its|this|that|these|those|they|then|only|but|however|unless|except|although|though|if|when|whereas|otherwise|still|yet|instead)(?![\p{L}\p{N}_])/iu;

/** A word by which a sentence points at what follows it as an example, or as what no longer holds: "Do not follow the bad example below." */
const POINTING = /(?<![\p{L}\p{N}_])(?:examples?|samples?|below|following|e\.g|for instance|such as|like this|outdated|deprecated|obsolete|legacy|old|wrong|incorrect|bad)(?![\p{L}\p{N}_])/iu;

/**
 * A source with what it shows rather than says blanked out, its line
 * breaks kept (EO-913): code blocks (`codeBlocks`), HTML comments and
 * block quotes, to the blank line that ends one, its unmarked lines
 * included. A sentence of a fenced example, a commented-out
 * line or a quotation is not the source's instruction, whatever it reads.
 */
function saidPart(source: string): string {
  const spans = [...codeBlocks(source)];
  for (const comment of source.matchAll(/<!--[\s\S]*?(?:-->|$)/g)) spans.push([comment.index, comment.index + comment[0].length]);
  // A quote runs on to the next blank line: a line after a quoted one,
  // unmarked, is the quote's own lazily continued paragraph.
  let quoted = false;
  for (const line of source.matchAll(/^.*$/gm)) {
    if (/^[ \t]{0,3}>/.test(line[0])) quoted = true;
    else if (line[0].trim() === "") quoted = false;
    if (quoted) spans.push([line.index, line.index + line[0].length]);
  }
  let out = source;
  for (const [start, end] of spans) out = out.slice(0, start) + out.slice(start, end).replace(/[^\n]/g, " ") + out.slice(end);
  return out;
}

/**
 * The sentences of a source that say something on their own about what
 * `entry` is about (EO-913), as `sentenceKey` compares them.
 *
 * - Not one of the source's code, comments or quotations (`saidPart`).
 * - Not one under a heading narrower than the entry, nor under a lead
 *   that narrows it: an ATX or setext heading, until one of its level or
 *   above; a line wholly in bold, or one ending in a colon, until the next
 *   heading; a bold phrase opening a paragraph, until the paragraph ends.
 *   Each must negate nothing, and every term it has (`terms`) must be one
 *   the entry has, so "Use Postgres 16 for local database testing." under
 *   "## Remote testing" says nothing of an entry about local testing, and
 *   under "## Testing" it may. A title such as "# EO — working agreement"
 *   narrows as any heading does, which costs corrections from a file with
 *   one, never a fact.
 * - Not one a sentence before it ending in a colon or semicolon heads
 *   ("For remote testing: use Postgres 16."), nor one a sentence before it
 *   in its section points at as an example or as what no longer holds
 *   (`POINTING`: "Everything below is outdated."), not one that
 *   runs on into the next with a colon, semicolon or comma, and not one
 *   whose next sentence opens by qualifying it ("It is only a fallback.").
 *
 * What such a sentence says holds only with words it does not have, so it
 * bears out no correction.
 */
function standingSentences(source: string, entry: string): string[] {
  const text = saidPart(source);
  const about = terms(entry);
  const narrows = (lead: string) => negates(lead) || [...terms(lead)].some((term) => !about.has(term));
  const lines: { start: number; end: number }[] = [];
  for (let at = 0; at <= text.length; ) {
    const breakAt = text.indexOf("\n", at);
    const end = breakAt === -1 ? text.length : breakAt;
    lines.push({ start: at, end });
    if (breakAt === -1) break;
    at = breakAt + 1;
  }
  // Whether each line may be a source at all, from the headings and leads over it.
  const open = new Array<boolean>(lines.length).fill(false);
  const headings: { level: number; narrows: boolean }[] = [];
  const pointedFrom = new Map<number, number>();
  let paragraph = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = text.slice(lines[index]!.start, lines[index]!.end);
    if (line.trim() === "") {
      paragraph = false;
      continue;
    }
    const atx = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t#]*$/.exec(line);
    const underline = index + 1 < lines.length ? /^ {0,3}(=+|-+)[ \t]*$/.exec(text.slice(lines[index + 1]!.start, lines[index + 1]!.end)) : null;
    const heading = atx !== null ? { level: atx[1]!.length, said: atx[2] ?? "" } : underline !== null && !/^\s*(?:[-*+]|\d{1,9}[.)])\s/.test(line) ? { level: underline[1]![0] === "=" ? 1 : 2, said: line } : null;
    if (heading !== null) {
      while (headings.length > 0 && headings[headings.length - 1]!.level >= heading.level) headings.pop();
      headings.push({ level: heading.level, narrows: narrows(heading.said) });
      paragraph = false;
      if (atx === null) index += 1;
      continue;
    }
    const bare = line.replace(/^\s*(?:(?:[-*+]|\d{1,9}[.)])\s+)?/, "");
    const bold = /^(\*\*|__)(.+?)\1(.*)$/.exec(bare);
    const boldLine = bold !== null && /^\s*:?\s*$/.test(bold[3]!);
    // A bold phrase opening a paragraph leads the rest of its own line too.
    if (bold !== null && !boldLine && narrows(bold[2]!)) paragraph = true;
    open[index] = !(headings.some((over) => over.narrows) || paragraph);
    // A lead over what follows, to the next heading.
    if (boldLine || /:\s*$/.test(line)) headings.push({ level: 7, narrows: narrows(boldLine ? bold[2]! : line) });
    // A sentence pointing at what follows as an example or as what no
    // longer holds ("Everything below is outdated.") stands over the rest
    // of its section — to the next heading of the one it is under, or of
    // its level or above, or to the end where it is under none — and over
    // the rest of its own line.
    const pointing = POINTING.exec(line);
    if (pointing !== null) {
      pointedFrom.set(index, lines[index]!.start + pointing.index);
      const section = [...headings].reverse().find((over) => Number.isInteger(over.level) && over.level < 7)?.level ?? 0;
      headings.push({ level: section + 0.5, narrows: true });
    }
  }
  const lineOf = (at: number) => lines.findIndex((line) => at >= line.start && at <= line.end);
  const spans = sentenceSpans(text);
  const found: string[] = [];
  for (const [index, [start, end]] of spans.entries()) {
    const line = lineOf(start);
    if (!open[line] || start > (pointedFrom.get(line) ?? Infinity)) continue;
    const said = text.slice(start, end);
    // A paragraph's own bold lead says nothing of itself.
    if (/^\s*(?:(?:[-*+]|\d{1,9}[.)])\s+)?(\*\*|__).+\1\s*$/.test(said)) continue;
    const before = index > 0 ? text.slice(spans[index - 1]![0], spans[index - 1]![1]) : "";
    const after = index + 1 < spans.length ? text.slice(spans[index + 1]![0], spans[index + 1]![1]) : "";
    if (/[:;]$/.test(before) || POINTING.test(before) || /[:;,]$/.test(said)) continue;
    if (QUALIFYING_START.test(after.replace(/^\s*(?:(?:[-*+>#]+|\d{1,9}[.)])\s+)+/, "").replace(/^[^\p{L}\p{N}]+/u, ""))) continue;
    // A bold lead the line opens with is no part of the sentence after it: "**Testing.** Use Postgres 16 …".
    found.push(sentenceKey(said.replace(/^(\s*(?:(?:[-*+]|\d{1,9}[.)])\s+)?)(\*\*|__)(.+?)\2\s+(?=\S)/, "$1")));
  }
  return found;
}

/** What may stand after a corrected value in a source to say the value it replaced: ", not UTC", " (not UTC)", " instead of UTC", " rather than UTC". */
const CONTRASTS = [", not ", " (not ", ", never ", " instead of ", ", instead of ", " rather than ", ", rather than ", " and not "];

/**
 * The source sentences (`sources`, as `sentenceKey` keys them) that say
 * the rewritten sentence `said[start, end)` as it now reads, none where
 * none does (EO-913): the same instruction under the same
 * conditions, which overlapping words and the new value alone do not
 * show — "Use Postgres 16 for remote testing" bears out nothing about
 * local testing, nor "Do not skip smoke tests" a "Do not run". So a
 * source sentence must be, word for word, the rewritten sentence from its
 * start to at least the end of the change (`changeEnd`), cut there or at
 * a clause it goes on with — ", …" or " and …" that does not negate —
 * since the clauses after the change are the entry's own. For a value
 * (`replaced`, the text the change took out), the source may also say the
 * value it replaces just after the new one: "local time, not UTC".
 */
function bornOut(said: string, start: number, end: number, changeEnd: number, replaced: string | null, sources: ReadonlySet<string>): Set<string> {
  const found = new Set<string>();
  const cuts = [end];
  const rest = said.slice(changeEnd, end);
  for (const clause of rest.matchAll(/,\s|\s+and\s/g)) cuts.push(changeEnd + clause.index);
  if (squashed(rest) === "") cuts.push(changeEnd);
  for (const cut of cuts) {
    if (cut < end && negates(said.slice(cut, end))) continue;
    const head = said.slice(start, cut);
    if (sources.has(sentenceKey(head))) found.add(sentenceKey(head));
    if (replaced !== null && (cut === changeEnd || squashed(said.slice(changeEnd, cut)) === "")) {
      const old = replaced.trim();
      for (const contrast of CONTRASTS) {
        const key = sentenceKey(`${head.trimEnd()}${contrast}${old}${contrast.includes("(") ? ")" : ""}`);
        if (sources.has(key)) found.add(key);
      }
    }
  }
  return found;
}

/**
 * Units a number may be written with, by what they measure and as the
 * multiples of its base unit they may mean, so "4000ms" and "4s", "50%"
 * and "0.5", "1024KiB" and "1MiB" are one value. A decimal byte unit may
 * mean its binary multiple too, so "1024KB" and "1MB" are one value as
 * well. A bare number counts. Matched lowercased.
 */
const UNITS: Readonly<Record<string, { measures: string; scales: readonly number[] }>> = (() => {
  const table: Record<string, { measures: string; scales: readonly number[] }> = { "": { measures: "count", scales: [1] } };
  const add = (measures: string, scales: readonly number[], ...names: string[]) => {
    for (const name of names) table[name] = { measures, scales };
  };
  add("count", [0.01], "%", "percent");
  add("count", [1e3], "k", "thousand");
  add("count", [1e6], "million");
  add("count", [1e9], "billion");
  add("time", [1e-9], "ns", "nanosecond", "nanoseconds");
  add("time", [1e-6], "us", "µs", "microsecond", "microseconds");
  add("time", [1e-3], "ms", "msec", "msecs", "millisecond", "milliseconds");
  add("time", [1], "s", "sec", "secs", "second", "seconds");
  add("time", [60], "min", "mins", "minute", "minutes");
  add("time", [3600], "h", "hr", "hrs", "hour", "hours");
  add("time", [86400], "d", "day", "days");
  add("time", [604800], "w", "wk", "wks", "week", "weeks");
  add("bytes", [1], "b", "byte", "bytes");
  for (const [power, prefix] of ["k", "m", "g", "t", "p"].entries()) {
    add("bytes", [1000 ** (power + 1), 1024 ** (power + 1)], `${prefix}b`);
    add("bytes", [1024 ** (power + 1)], `${prefix}ib`, `${prefix}i`);
  }
  return table;
})();

/** A number a text says, as `numbersOf` reads it: its value in its unit, what the unit measures (or the unit itself, where EO does not know it), and the multiples it may mean. */
interface Quantity {
  value: number;
  measures: string;
  scales: readonly number[];
  /** A version's parts, "1.2.3", where it is one: its `value` is then 0. */
  version?: string;
}

/**
 * The numbers a text says (EO-913), each with its unit, attached ("4s",
 * "1024KiB", "50%") or after a space where EO knows the word ("4 seconds",
 * "1 MiB"): "4.0" and "4", "1,000" and "1000", "0x10" and "16", "+1" and
 * "1" are one value; "-1" is not "1". A unit EO does not know is kept as
 * itself, so "18x" and "18y" measure different things it cannot convert.
 * A version ("1.2.3") is compared part by part. Null where a word with a
 * digit in it is in no notation EO can read — "0b10000", "sha256",
 * "CACHE_V1" — whose value may be the one put for it.
 */
function numbersOf(text: string): Quantity[] | null {
  const plain = text.replace(/`/g, "").replace(/(\d)[,_](?=\d{3}(?!\d))/g, "$1");
  const found: Quantity[] = [];
  // Each word with a digit in it, whole: one EO cannot read as a number,
  // with its unit, as a version or as "v18", is a notation it does not
  // know — "0b10000", "sha256", "1e3e4" — whose value it cannot compare.
  for (const match of plain.matchAll(/[\p{L}\p{N}_µ]*\p{N}[\p{L}\p{N}_µ]*(?:\.\p{N}[\p{L}\p{N}_µ]*)*/gu)) {
    const [word] = match;
    const before = plain.slice(Math.max(0, match.index - 2), match.index);
    const sign = /(?:^|[^\p{L}\p{N}_])[-+]$/u.test(before) ? before[before.length - 1] : "";
    const version = /^v?(\d+(?:\.\d+){2,})$/i.exec(word);
    if (version !== null) {
      // "1.2.3": compared part by part, trailing ".0"s and leading zeros aside.
      const parts = version[1]!.split(".").map((part) => String(Number(part)));
      while (parts.length > 1 && parts[parts.length - 1] === "0") parts.pop();
      found.push({ value: 0, measures: "version", scales: [1], version: `${sign}${parts.join(".")}` });
      continue;
    }
    const number = /^v?(0x[0-9a-f]+|\d+(?:\.\d+)?(?:e[-+]?\d+)?)([\p{L}µ]*)$/iu.exec(word);
    if (number === null) return null;
    const [, digits, attached] = number;
    let unit = (attached ?? "").toLowerCase();
    const after = plain.slice(match.index + word.length);
    if (unit === "") {
      const spaced = /^(%|[ \t]+(%|[\p{L}µ]+)(?![\p{L}\p{N}_]))/u.exec(after);
      const named = spaced === null ? undefined : (spaced[2] ?? spaced[1]!).toLowerCase();
      if (named !== undefined && UNITS[named] !== undefined) unit = named;
    } else if (/^[-+]?\d/.test(after)) return null;
    const value = Number(digits) * (sign === "-" ? -1 : 1);
    if (!Number.isFinite(value)) return null;
    const known = UNITS[unit];
    found.push(known === undefined ? { value, measures: `unit ${unit}`, scales: [1] } : { value, measures: known.measures, scales: known.scales });
  }
  return found;
}

/**
 * Whether what a run took out and what it put in say the same numbers
 * (EO-913): "same" where, measure by measure, the values are one list
 * under some reading of their units — "1024KB" for "1MB" read in binary
 * multiples; "unconvertible" where they do not measure the same things,
 * a unit EO does not know changed or a bare number given a unit ("4" for
 * "4000ms"), so EO cannot tell whether the value changed; "changed" where
 * EO can see that it did. Two lists of different lengths say different
 * numbers.
 */
function compareNumbers(out: readonly Quantity[], into: readonly Quantity[]): "same" | "changed" | "unconvertible" {
  if (out.length !== into.length) return "changed";
  const measures = (list: readonly Quantity[]) => list.map((quantity) => quantity.measures).sort().join("\n");
  if (measures(out) !== measures(into)) return "unconvertible";
  const values = (list: readonly Quantity[], reading: number) =>
    list
      .map((quantity) => ({ measure: quantity.measures, value: quantity.value * quantity.scales[Math.min(reading, quantity.scales.length - 1)]! }))
      .sort((a, b) => (a.measure === b.measure ? a.value - b.value : a.measure < b.measure ? -1 : 1));
  const versions = (list: readonly Quantity[]) => list.flatMap((quantity) => (quantity.version === undefined ? [] : [quantity.version])).sort().join("\n");
  if (versions(out) !== versions(into)) return "changed";
  const one = (a: readonly { value: number }[], b: readonly { value: number }[]) => a.every((item, index) => Math.abs(item.value - b[index]!.value) <= 1e-9 * Math.max(1, Math.abs(item.value)));
  for (const outReading of [0, 1]) {
    for (const intoReading of [0, 1]) {
      if (one(values(out, outReading), values(into, intoReading))) return "same";
    }
  }
  return "changed";
}

/**
 * Why a rewrite does not put right what `sources` say, or null where it
 * does (EO-913) — the evidence a `repository_file` or `newer_entry`
 * rewrite is held to, by the text itself (invariant 5). The rewrite is
 * diffed against its entry token by token (`changedRuns`): every
 * character outside the runs it changed is the entry's own, whitespace
 * included, and each run must be one of two things.
 *
 * - **A value replaced.** What the run took out holds at least one value
 *   no synonym stands for — a number, a name or path, code or an acronym
 *   (`isConcrete`) — that what it put in does not say in any notation
 *   (`sayer`): `16` for `15`, `-1` for `1`, `` `pnpm lint` `` for
 *   `` `pnpm test` ``, "local time" for "UTC". Every other word and mark
 *   it took out is in what it put in, so a value is never replaced
 *   together with the words beside it ("and keep backups" dropped with a
 *   version put right), and a run that only rewords ("before" for "prior
 *   to"), respaces (`pnpm  test`), repunctuates, spells out ("CI"), takes
 *   words out or adds them is refused.
 * - **A negation added or taken off**, every other word the same.
 *
 * And a value replaced is a value changed: a run whose numbers are the
 * ones it took out, written another way — "4" for "4.0", "4s" for
 * "4000ms", "18" for "v18" (`numbersOf`) — is refused.
 *
 * And a sentence of a source bears each run out (`bornOut`): it is, word
 * for word, the rewritten sentence from its start to at least the end of
 * the change, cut there or before a clause of the entry's own (", …" or
 * " and …"), and it stands on its own in its source (`standingSentences`)
 * — so it says the same instruction under the same conditions, negated
 * as the rewritten one is. One about another environment, a fallback, a
 * negation of another action, or one a clause or the next sentence
 * qualifies, bears out nothing. A value's source may say the value it
 * replaces after the new one ("local time, not UTC"). A rewrite that
 * would be only a source's sentences is that source again, and the entry
 * is retired rather than rewritten.
 *
 * Where no such disagreement can be found, the entry is left as it is: a
 * correction in plain words ("run" to "lint") is refused, which costs a
 * rewrite the model could have made, never a fact.
 */
function correctionProblem(rewrite: string, entry: string, given: readonly { body: string; at: number }[], what: string): string | null {
  const sources = given.map((source) => source.body);
  const had = entry.trim();
  const said = rewrite.trim();
  if (had === said) return "changes nothing of the entry's text";
  if (sources.some((source) => isWholeSentencesOf(said, source))) return `says nothing but what ${what} says, so the entry is retired rather than rewritten`;
  const from = tokensOf(had);
  const to = tokensOf(said);
  const codeFrom = codeSpans(had);
  const sentences = sentenceSpans(said);
  const standing = sources.map((source) => standingSentences(source, had));
  const sourceSentences = new Set(standing.flat());
  let unborne: string | null = null;
  for (const run of changedRuns(from, to)) {
    const out = from.slice(run.from[0], run.from[1]);
    const into = to.slice(run.to[0], run.to[1]);
    const outText = out.map((token) => token.text).join("");
    const intoText = into.map((token) => token.text).join("");
    const shown = `"${outText.trim()}" to "${intoText.trim()}"`;
    const outWords = out.filter((token) => token.kind === "word");
    const intoWords = into.filter((token) => token.kind === "word");
    if (outWords.length === 0 && intoWords.length === 0) return `changes only spacing or punctuation, ${shown}, which nothing in ${what} bears out`;
    const marks = (tokens: readonly Token[]) => tokens.filter((token) => token.kind === "mark").map((token) => token.text);
    const intoMarks = marks(into);
    const lostMark = marks(out).find((mark) => {
      const at = intoMarks.indexOf(mark);
      if (at === -1) return true;
      intoMarks.splice(at, 1);
      return false;
    });
    const position = into[0]?.start ?? to[run.to[0]]?.start ?? said.length;
    const [sentenceStart, sentenceEnd] = sentences.find(([start, end]) => position >= start && position <= end) ?? [0, said.length];
    const sentence = said.slice(sentenceStart, sentenceEnd);
    const negation = withoutNegation(outText) === withoutNegation(intoText) && negates(outText) !== negates(intoText) && lostMark === undefined;
    let lost: string[] = [];
    if (!negation) {
      if (intoWords.length === 0) return `takes "${outText.trim()}" out of the entry, which nothing in ${what} bears out: a correction replaces a value, and takes nothing else out`;
      if (outWords.length === 0) return `adds "${intoText.trim()}" to the entry rather than correcting what it says`;
      if (lostMark !== undefined) return `changes ${shown}, taking out "${lostMark}", which nothing in ${what} bears out`;
      const kept = new Set(intoWords.map((token) => token.text.toLowerCase()));
      const reworded = outWords.filter((token) => !isConcrete(token, codeFrom) && !kept.has(token.text.toLowerCase()));
      if (reworded.length > 0) {
        return `changes ${shown}, which takes out "${reworded.map((token) => token.text).join(" ")}": a correction replaces only a number, name, path, piece of code, acronym or negation the source contradicts, and keeps every other word of the entry as it was`;
      }
      const values = numbersOf(outText);
      const intoValues = numbersOf(intoText);
      // A number in a notation EO cannot read, on either side, may be the
      // same value: "0b10000" for "16".
      if (values === null || intoValues === null) {
        return `changes ${shown}, which writes a number in a notation EO cannot read ("0b10000", "sha256"), so EO cannot tell that the value changed: where EO cannot see a value change, the entry is left as it is`;
      }
      const numbers = values.length > 0 ? compareNumbers(values, intoValues) : "changed";
      if (numbers === "same") {
        return `changes ${shown}, which says the same number${values.length === 1 ? "" : "s"} written another way, so it corrects no value: where EO cannot see a value change, the entry is left as it is`;
      }
      if (numbers === "unconvertible") {
        return `changes ${shown}, which changes what a number is measured in to a unit EO cannot convert it to, so EO cannot tell that the value changed: where EO cannot see a value change, the entry is left as it is`;
      }
      const says = sayer(intoText);
      lost = outWords.filter((token) => isConcrete(token, codeFrom) && !says(token.text)).map((token) => token.text);
      if (lost.length === 0) {
        return `changes ${shown}, which still says every number, name, path, piece of code and acronym it did, in some notation, and negates as it did, so it says the same in other words or adds to it, and corrects nothing`;
      }
    }
    if (into.length > 0 && into[into.length - 1]!.start + into[into.length - 1]!.text.length > sentenceEnd) {
      return `changes ${shown} across a sentence's end, which no one sentence of ${what} bears out`;
    }
    const around = terms(sentence);
    for (const term of terms(intoText)) around.delete(term);
    if (around.size === 0) return `changes ${shown} in a sentence with nothing else in it to tell which sentence of ${what} it follows`;
    const end = into.length > 0 ? into[into.length - 1]!.start + into[into.length - 1]!.text.length : position;
    // Checked once every run's own shape is: what a run is matters more
    // to the model than which source fails to bear it out.
    const borne = bornOut(said, sentenceStart, sentenceEnd, end, negation ? null : outText, sourceSentences);
    if (borne.size > 0) {
      // Borne out by the newest word on it, or by nothing: a sentence as
      // new as the newest one bearing the change out, or newer, that is
      // about the same thing and says another value or negates otherwise,
      // leaves the sources at odds, and the entry as it is.
      const newest = Math.max(...given.filter((_, index) => standing[index]!.some((key) => borne.has(key))).map((source) => source.at));
      const says = sayer(sentence);
      // About the same thing: more than half the terms the sentence has
      // besides the new value, and one of those just before the change —
      // or just after it, where the change opens the sentence — so
      // "Listen on port 5433 for local testing." is not at odds with "Use
      // Postgres 16 for local testing.".
      const half = Math.floor(around.size / 2) + 1;
      const changeStart = into[0]?.start ?? position;
      const anchor = terms(said.slice(sentenceStart, changeStart));
      if (anchor.size === 0) for (const term of terms(said.slice(end, sentenceEnd))) anchor.add(term);
      for (const term of terms(intoText)) anchor.delete(term);
      for (const source of given) {
        if (source.at < newest) continue;
        // Every sentence of it, standing or not, code and quotes too: a
        // qualified or quoted word against the change is still one.
        const other = sentenceSpans(source.body).map(([from, to]) => sentenceKey(source.body.slice(from, to))).find((key) => {
          if (borne.has(key)) return false;
          const shared = [...terms(key)].filter((term) => around.has(term)).length;
          if (shared < half || (anchor.size > 0 && ![...terms(key)].some((term) => anchor.has(term)))) return false;
          return negates(key) !== negates(sentence) || [...key.matchAll(CONCRETE_WORD)].some(([word]) => isConcreteWord(word) && !says(word));
        });
        if (other !== undefined) return `changes ${shown}, but ${what} also says "${other}", as new or newer, so the sources disagree and the entry is left as it is`;
      }
    }
    if (borne.size === 0) {
      unborne ??= negation
        ? `changes ${shown}, but no sentence of ${what} says "${sentence}" as it now reads, word for word`
        : `changes ${shown}, but no sentence of ${what} says "${sentence}" as it now reads, word for word, up to the end of "${intoText.trim()}" — so nothing shows that ${what} says "${intoText.trim()}" in place of "${lost.join(" ")}" for the same thing under the same conditions`;
    }
  }
  if (unborne !== null) return unborne;
  return null;
}

const NUMBER_WORDS: Readonly<Record<string, number>> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const DAY_MS = 24 * 60 * 60 * 1000;
const COUNT = "(\\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten)";

/**
 * The date a relative date means, counted from the day its entry was
 * written as the model is shown it (UTC, `isoDay`), where EO can tell:
 * as a day (`YYYY-MM-DD`) for "today", "yesterday", "tomorrow", "N days
 * ago" and "N days from now"; as a month (`YYYY-MM`) for "this month",
 * "last month" and "next month". Null for one it cannot — "last week", "on
 * Monday", "recently", "three months ago" — for one a date cannot stand
 * for without losing what it says of the time of day, "tonight" or "this
 * morning", and for "in N days", which says a time ahead ("ships in two
 * days") as often as a span behind ("no timeout in two days"): a
 * `relative_date` rewrite leaves those as they are.
 */
export function resolvedDate(phrase: string, writtenAt: number): string | null {
  const said = phrase.toLowerCase().trim().replace(/\s+/g, " ");
  // A day no four-digit year can be written for is no date EO can give:
  // "999999999 days from now" stays as it is.
  const day = (offset: number) => {
    const at = Date.parse(isoDay(writtenAt)) + offset * DAY_MS;
    // 0000-01-01 to 9999-12-31, in UTC.
    return Number.isFinite(at) && at >= -62_167_219_200_000 && at <= 253_402_214_400_000 ? isoDay(at) : null;
  };
  if (said === "today") return day(0);
  if (said === "yesterday") return day(-1);
  if (said === "tomorrow") return day(1);
  const count = (word: string) => (/^\d+$/.test(word) ? Number(word) : NUMBER_WORDS[word]!);
  const ago = new RegExp(`^${COUNT} days? (?:ago|back)$`).exec(said);
  if (ago) return day(-count(ago[1]!));
  const ahead = new RegExp(`^${COUNT} days? from now$`).exec(said);
  if (ahead) return day(count(ahead[1]!));
  const month = /^(this|last|previous|next|coming) month$/.exec(said);
  if (month) {
    const offset = { this: 0, last: -1, previous: -1, next: 1, coming: 1 }[month[1] as "this" | "last" | "previous" | "next" | "coming"];
    const written = new Date(writtenAt);
    const at = new Date(Date.UTC(written.getUTCFullYear(), written.getUTCMonth() + offset, 1));
    return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}`;
  }
  return null;
}

/** A word before a relative date that makes it a span rather than a day or month: "over the last month", "within two days from now", "throughout this month". */
const DURATION_BEFORE = /(?<![\p{L}\p{N}_])(?:the|within|over|throughout|past|all)\s+$/iu;

/** The one word a date put for a relative one may have before it, so it says what the phrase did and no more: "on" a day, "in" or "during" a month. */
const DAY_PREPOSITIONS = new Set(["on"]);
const MONTH_PREPOSITIONS = new Set(["in", "during"]);

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
  // Code is found in the body as written: trimming would take the indent
  // off a first line indented as code.
  const lead = entry.body.length - entry.body.trimStart().length;
  const phrases = [...body.matchAll(RELATIVE_TIMES)].filter((phrase) => !inCode(entry.body, lead + phrase.index, phrase[0].length));
  if (phrases.length === 0) return "gives relative_date, but the entry says no relative date or time outside code";
  if (rewrite.contradictsRepositoryFile !== entry.contradictsRepositoryFile) return "gives relative_date, but the rewrite also changes contradictsRepositoryFile";
  // Walked once, left to right, without backtracking: each piece of the
  // entry between two phrases must follow where the last one ended, and
  // what stands between is what was put for the phrase. A wildcard per
  // phrase in one pattern backtracked through every way of placing them
  // before refusing, long enough to stall the main process (EO-913).
  const said = rewrite.body.trim();
  const puts: string[] = [];
  let cursor = 0;
  let at = 0;
  for (const [index, phrase] of phrases.entries()) {
    const before = body.slice(at, phrase.index);
    if (!said.startsWith(before, cursor)) return "gives relative_date, but the rewrite changes more than the relative dates and times the entry says";
    cursor += before.length;
    at = phrase.index + phrase[0].length;
    const next = phrases[index + 1];
    const piece = body.slice(at, next === undefined ? body.length : next.index);
    const until = next === undefined ? said.length - piece.length : said.indexOf(piece, cursor);
    if (until < cursor || (next === undefined && !said.endsWith(piece))) return "gives relative_date, but the rewrite changes more than the relative dates and times the entry says";
    puts.push(said.slice(cursor, until));
    cursor = until;
  }
  if (said.slice(cursor) !== body.slice(at)) return "gives relative_date, but the rewrite changes more than the relative dates and times the entry says";
  const written = isoDay(entry.createdAt);
  let replaced = 0;
  for (const [index, phrase] of phrases.entries()) {
    const put = puts[index]!;
    if (put === phrase[0]) continue;
    // "over the last month", "within two days from now": a span, which a date is not.
    const meant = DURATION_BEFORE.test(body.slice(Math.max(0, phrase.index - 20), phrase.index)) ? null : resolvedDate(phrase[0], entry.createdAt);
    if (meant === null) return `gives relative_date, but EO cannot tell what date "${phrase[0]}" in an entry written ${written} meant, so it stays as it is, not "${put}"`;
    replaced += 1;
    const dates = [...put.matchAll(ABSOLUTE_DATE)];
    const dated = dates.length === 1 ? absoluteDates(put) : new Set<string>();
    if (dated.size !== 1 || !dated.has(meant)) return `gives relative_date, but "${phrase[0]}" in an entry written ${written} is ${meant}, not "${put}"`;
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
 * - `repository_file` — the rewrite replaces values of the entry, or a
 *   negation, with what a sentence of a repository file the call was
 *   given says in their place, and changes nothing else
 *   (`correctionProblem`). It may clear `contradictsRepositoryFile` — the
 *   entry now says what the file does — but never set it.
 * - `newer_entry` — the same, by a sentence of an entry the call was
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
      const problem = correctionProblem(rewrite.body, entry.body, given.repositoryFiles.map((body) => ({ body, at: 0 })), "a repository file it was given");
      return problem === null ? null : `gives repository_file, but the rewrite ${problem}`;
    }
    case "newer_entry": {
      const newer = sent.filter((other) => other.id !== entry.id && other.createdAt > entry.createdAt);
      if (newer.length === 0) return "gives newer_entry, but no entry given is newer than this one";
      if (rewrite.contradictsRepositoryFile !== entry.contradictsRepositoryFile) return "gives newer_entry, but the rewrite also changes contradictsRepositoryFile";
      const problem = correctionProblem(rewrite.body, entry.body, newer.map((other) => ({ body: other.body, at: other.createdAt })), "a newer entry it was given");
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
    checkOperations(known, answer, ctx, given.context);
    answer.rewrite.forEach((rewrite, at) => {
      const entry = byId.get(rewrite.id);
      const problem = entry === undefined ? null : rewriteReasonProblem(rewrite, entry, sent, given);
      if (problem !== null) ctx.addIssue({ code: "custom", path: ["rewrite", at, "reason"], message: `${rewrite.id} ${problem}` });
    });
  });
}

function checkOperations(known: ReadonlySet<string>, answer: MemoryConsolidationOperations, ctx: z.RefinementCtx, context?: ReadonlySet<string>): void {
  const named = new Map<string, string>();
  const name = (id: string, path: (string | number)[]) => {
    const where = path.join(".");
    if (!known.has(id)) ctx.addIssue({ code: "custom", path, message: `names an entry it was not given: ${id}` });
    else if (context?.has(id) === true) ctx.addIssue({ code: "custom", path, message: `names ${id}, which it was given as context only: a batch of its own handles it` });
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
  `- \`rewrite\`: \`{ id, body, reason, contradictsRepositoryFile }\` — replace one entry's text with \`body\`. \`reason\` is one of ${MEMORY_CONSOLIDATION_REWRITE_REASONS.map((reason) => `\`${reason}\``).join(", ")}: a relative date or time the entry says made absolute, a disagreement with a repository file you are given put right, or a correction by an entry you are given that was written after it. EO checks each reason against the change itself and refuses the whole answer where one does not hold. A \`relative_date\` rewrite replaces only the relative date or time with the date it meant, counted from the date the entry was written, and changes not one other character of the entry — not a space, a backtick or a letter's case — nor contradictsRepositoryFile: a day as YYYY-MM-DD, alone or after "on", for "today", "yesterday", "tomorrow", "N days ago" or "N days from now", where the day falls in a four-digit year — "yesterday" in an entry written 2026-11-26 is 2026-11-25, so "Released yesterday." becomes "Released 2026-11-25." or "Released on 2026-11-25.", never "Released before 2026-11-25." — and a month as YYYY-MM, alone or after "in" or "during", for "this month", "last month" or "next month". Any other relative phrase — "last week", "on Monday", "recently", "three months ago", "in two days" (a time ahead or a span behind), one that is a span ("over the last month", "within two days from now"), and "tonight" or "this morning", whose time of day a date would lose — stays exactly as it is, and so does a word in code (inside a code span, however many backticks open it, a fenced code block opened with backticks or tildes, a line indented four spaces or with a tab in its indent — either also inside block quotes or list items, nested in any order —, a <code> or <pre> element, or part of a name or path such as \`today_count\` or \`today.json\`). A \`repository_file\` rewrite puts right a value the file says otherwise, and nothing else: it replaces a number, a name or path, a piece of code or an acronym of the entry with what the file says in its place, written exactly as one sentence of the file writes it, every word in the same case ("getCache" is not "getcache") and code with the same spaces — \`16\` for \`15\`, \`-1\` for \`1\`, "\`pnpm lint\`" for "\`pnpm test\`", "local time" for "UTC" — or adds or takes off a negation ("Do not run" for "Run") where the file's sentence negates otherwise. Every other character of the entry stays exactly as it was: every other word, clause and sentence, every mark and every space, even in a sentence it corrects — "Use Postgres 15 for tests and keep backups." becomes "Use Postgres 16 for tests and keep backups.", never "Use Postgres 16 for tests." The corrected sentence, as it then reads from its start to at least the end of the change, must be word for word a sentence of the file standing on its own — the same instruction under the same conditions, not one about another environment, only as a fallback, after a heading clause such as "When CI is down:", qualified by the sentence after it ("It is only a fallback."), under a heading, bold lead or line ending in a colon whose words the entry does not have ("## Remote testing" over an entry about local testing), after a sentence earlier in its section introducing an example or what no longer holds ("Do not follow the bad example below.", "Everything below is outdated."), or inside the file's code blocks, block quotes (to the blank line ending one, unmarked lines included) or HTML comments; the entry's own clause after the change, ", …" or " and …", may follow, and so may ", not" and the old value in the file's sentence ("local time, not UTC"). A negation is borne out only by a sentence that negates the same action: "Do not skip the smoke tests" bears out nothing about "Run the smoke tests". A change of wording, spacing or punctuation alone ("before" for "prior to", \`pnpm test\` for \`pnpm  test\`), the same value in another notation ("CI" for "continuous integration", "2" for "two", "4 seconds" for "4.0 seconds", "4s" for "4000ms", "1MiB" for "1024KiB", "18" for "v18", code as prose), a number in a notation EO cannot read ("16" for "0b10000", "sha512" for "sha256"), a number given a unit EO cannot convert it to ("4000ms" for "4"), a command in plain words changed for another (pnpm lint for pnpm test, outside code), a word dropped or a detail added is no correction, and is refused: leave the entry as it is. Where another sentence of the files, about the same thing, says another value or negates otherwise, the sources disagree, and the entry is left as it is. An entry that would say only what the file says is retired instead. A \`newer_entry\` rewrite does the same with a sentence of the newer entry, and only with the newest word on it: where an entry as new as that one, or newer, says something else about it, the entry is left as it is. A rewrite keeps the entry's contradictsRepositoryFile as it is, except that a \`repository_file\` rewrite may clear it; it never sets it, and an entry is never rewritten only to change it. There is no other reason to rewrite an entry: never rewrite one only to shorten it, reword it or tidy its style.`,
  "Every id you name must be one of the entries you are given, and each id may appear only once in the whole answer — in one retire, one merge's `from`, or one rewrite. An answer with nothing to change has all three lists empty; that is a valid answer, and often the right one.",
  "What to change, and nothing else:",
  `- Merge entries that state the same fact into one, keeping every detail any of them adds. Keep each entry you merge or rewrite to one fact, at most ${MAX_MEMORY_NOTE_CHARS} characters: an answer with a longer one is refused whole. Entries about one topic that state different facts are not duplicates; leave them as they are.`,
  "- Retire what is stale, contradicted by a newer entry, or derivable from the code itself — what an agent would see by reading the repository. Between two entries that disagree, the newer one is current.",
  "- Write the relative dates EO can date (\"yesterday\", \"two days ago\", \"last month\") as absolute dates, using the date each entry was written, as the rewrite rule above says; leave every other relative phrase as it is.",
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
  /** Of those, the ones given here only as another's neighbour, which a batch of their own handles: context, never named (`ConsolidationGiven.context`). */
  context?: ReadonlySet<string>;
}

/**
 * Each entry with its id, the day it was written, the item it came from
 * and its flag, oldest first — and, where `likelyDuplicates` says so, the
 * others it is likely a duplicate of (EO-576), and where `fresh` holds it,
 * that it is new since the last consolidation (EO-913).
 */
function entryLines(entries: readonly MemoryEntryView[], likelyDuplicates?: ReadonlyMap<string, readonly string[]>, fresh?: ReadonlySet<string>, context?: ReadonlySet<string>): string[] {
  const lines: string[] = [];
  for (const entry of [...entries].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))) {
    const item = entry.source.type === "run" && entry.source.itemId !== null ? `; from item ${entry.source.itemId}` : "";
    const alike = likelyDuplicates?.get(entry.id) ?? [];
    const duplicate = alike.length > 0 ? `; likely a duplicate of ${alike.join(", ")}` : "";
    const isNew = context?.has(entry.id) === true ? `; ${CONTEXT_MARK}` : fresh?.has(entry.id) === true ? "; new since the last consolidation" : "";
    lines.push("", `### ${entry.id} (written ${isoDay(entry.createdAt)}${item}${isNew}${entry.contradictsRepositoryFile ? "; already flagged as correcting the repository file" : ""}${duplicate})`, entry.body);
  }
  return lines;
}

/** How an entry given only as context is marked (`ConsolidationBatchPart.context`). */
const CONTEXT_MARK = "new, and handled in a batch of its own: context here only";

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
    if (input.entries.some((entry) => batch.context?.has(entry.id) === true)) {
      lines.push(`Those marked "${CONTEXT_MARK}" are new too, but another batch gives each with its own neighbours: read them, and a newer one may correct another entry here, but name none of them in any operation — not to retire, merge or rewrite it. An answer that names one is refused whole.`);
    }
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
  lines.push("", "## Entries", ...entryLines(input.entries, marks, batch?.fresh, batch?.context));
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
