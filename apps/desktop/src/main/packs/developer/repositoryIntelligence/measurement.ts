import { REPOSITORY_MCP_SERVER_NAME, SEARCH_INTERCEPTION_EVENT, type UsageEvent } from "@eo/core";
import { createUsageTally } from "../../../supervisor/usageTally.js";
import { broadSearchInCommand, invocationsIn, type Invocation } from "./broadSearch.js";

/**
 * Whether repository intelligence actually helps, read off what EO
 * already records (EO-155).
 *
 * This is the story the rest of EO-141 was built to make answerable, and
 * the reason none of the other stories claims a saving. It is a
 * *derivation*, not an instrument: every number below comes out of
 * `run_events` rows and `runs` columns that were already being written
 * before this file existed, which is what makes the same figures
 * computable for items that ran months ago. Nothing here is emitted,
 * nothing is stored, and nothing leaves the machine — a report is
 * something a person runs, and `scripts/index-benefit.mts` is the one
 * that runs it.
 *
 * **No source content, anywhere.** Tool arguments are read to decide
 * what a call *was* — a search, a read, a query — and the answer that
 * survives is a word from a fixed vocabulary. A command line is never
 * kept, a file's contents are never opened, and the only strings that
 * reach a caller are tool names, programs from an allowlist, item keys
 * and paths EO already stores. That is a property of the return types
 * and `measurement.test.ts` asserts it structurally rather than trusting
 * it.
 *
 * **What is honest and what is bounded.** Three of the four figures are
 * exact. Tokens before the first change usually is not, and the reason
 * is worth stating rather than papering over: both backends report usage
 * once, when the stream ends, so a run that edits in its eighth turn has
 * no reading taken at the moment it did. Where readings straddle the
 * edit — a backend reporting per turn — the figure is exact and says so.
 * Where they do not, this returns the two numbers it can defend, the
 * most it could have been and the least, and a report that printed one
 * of them as *the* answer would be inventing a measurement.
 *
 * Deliberately not exported from `index.ts`. That barrel is the face
 * the rest of the main process uses, and nothing in the runtime asks
 * this question — it is asked by a person, through a command, about
 * runs that are already over. `interception-audit.mts` reaches
 * `broadSearch.ts` the same way, for the same reason.
 *
 * What it found, and the numbers as they stood when it was written, are
 * in `README.md` beside this file.
 *
 * The counterpart in `scripts/index-adoption.mjs` counts a narrower
 * thing — repository searches, and where in a run they stop — for
 * EO-164. It is not superseded and is not shared: it censuses one arm at
 * a time and predates both the interception event and the tokens
 * question. What is shared is the parser, which lives in
 * `broadSearch.ts` and is imported by everything that has an opinion
 * about a command line.
 */

// ── What a tool call was ────────────────────────────────────────

/**
 * The four things a call can be, as far as this question goes.
 *
 * `index` and the two filesystem kinds are the comparison the story
 * asks for. `other` is everything else and is deliberately large: a
 * test run, a git operation, a comment posted, an outcome returned.
 * Counting those as discovery would make a run that worked hard look
 * like a run that was lost.
 */
export type ToolCallKind = "index" | "search" | "read" | "other";

/** The four kinds, in a fixed order, so every rollup walks them the same way. */
const KINDS = ["index", "search", "read", "other"] as const;

const zeroCalls = (): Record<ToolCallKind, number> => ({ index: 0, search: 0, read: 0, other: 0 });

/**
 * The two spellings of a repository-intelligence tool id.
 *
 * Both backends put the server name in the middle of the tool id and
 * they disagree about the punctuation: one sends `mcp__repo__<tool>`,
 * the other `repo/<tool>`. A census that knew only the first reports
 * zero index calls for every run on the second backend — and there are
 * such runs in this database that made them.
 *
 * Derived from the reserved server name rather than written out, so the
 * two cannot drift, and naming no implementation: what comes after the
 * server name is the provider's vocabulary and nothing here reads it.
 */
const INDEX_TOOL_PREFIXES = [`mcp__${REPOSITORY_MCP_SERVER_NAME}__`, `${REPOSITORY_MCP_SERVER_NAME}/`];

/** Tools that are a search of the tree by their nature, whatever their arguments say. */
const SEARCH_TOOLS = new Set(["Grep", "Glob", "Search", "file_search"]);

/** Tools that open a file the agent has already found. */
const READ_TOOLS = new Set(["Read", "NotebookRead", "read_file", "View"]);

/** Tools that hand a command line to a shell. */
const SHELL_TOOLS = new Set(["Bash", "command_execution", "shell", "local_shell", "exec_command"]);

/**
 * Programs whose whole purpose is to ask a tree where something is.
 *
 * The same family `broadSearch.ts` allows, plus the two that only ever
 * list (`tree`, `locate`). This set is looser than the interception's on
 * purpose and the comment there says why: an interception must be
 * narrow or it interrupts work that was not exploration, and a census
 * must be wide or it undercounts what the index was supposed to remove.
 *
 * `which` is not in it either, for the plainer reason that it asks
 * `PATH` where an executable is. That is not a question about this
 * repository and no index of its declarations could answer it; counting
 * the 21 such calls in this database as searches would have padded both
 * arms with work the feature was never going to remove.
 *
 * `git` is not in it, because `git` is not a program that does one
 * thing. `git grep` is a search of the tree and `git log` is a question
 * about history that no index of declarations answers, so which one a
 * call was is decided from its subcommand, below, and every other
 * subcommand lands in `other`.
 */
const SEARCH_PROGRAMS = new Set([
  "grep", "egrep", "fgrep", "rg", "ripgrep", "ag", "ack", "ack-grep", "find", "fd", "fdfind", "ls", "tree", "locate",
]);

/** Programs that show what is in a file somebody already located. */
const READ_PROGRAMS = new Set(["cat", "head", "tail", "sed", "awk", "less", "more", "bat", "nl", "od", "xxd", "strings"]);

/**
 * The `git` subcommands that ask the tree where something is.
 *
 * Two, and only two. `git grep` is a repository-wide search for a name
 * and `git ls-files` is a repository-wide search for a file, which are
 * exactly the two questions `search` and `files` answer — an agent that
 * reaches for either is doing the thing this feature exists to replace,
 * and leaving them out undercounted the comparison by every call an
 * agent spelled the git way.
 *
 * Everything else `git` does is history, state or work — `log`, `diff`,
 * `show`, `status`, `add`, `commit`, `worktree`, `merge-base` — and none
 * of it is a question an index of declarations answers. They are the
 * overwhelming majority of git calls in this database, so a rule that
 * counted `git` as a search would have been wrong far more often than
 * the omission it replaced.
 *
 * Note the deliberate asymmetry with `isIndexAnswerableSearch` below: a
 * `git grep` counts here as a search that happened, and does *not* count
 * as one the interception would have caught. EO-165 promises agents that
 * git operations are never interrupted, and that promise is about what
 * EO does to a running agent, not about what a census may notice
 * afterwards.
 */
const GIT_SEARCH_SUBCOMMANDS = new Set(["grep", "ls-files"]);

/**
 * `git`'s own options that take a value, before the subcommand.
 *
 * `git -C /some/path grep foo` is a real spelling and the subcommand is
 * not the first operand — so the value of `-C` has to be stepped over
 * or the subcommand reads as a path.
 */
const GIT_FLAGS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);

/** The subcommand a `git` call ran, or null when it was given none. */
function gitSubcommand(args: string[]): string | null {
  for (let index = 0; index < args.length; index++) {
    const token = args[index] as string;
    if (GIT_FLAGS_WITH_VALUE.has(token)) {
      index++;
      continue;
    }
    if (token.startsWith("-")) continue;
    return token;
  }
  return null;
}

/** Was this one command a search of the tree, whichever way it was spelled? */
function searches(invocation: Invocation): boolean {
  if (invocation.name === "git") {
    const subcommand = gitSubcommand(invocation.args);
    return subcommand !== null && GIT_SEARCH_SUBCOMMANDS.has(subcommand);
  }
  return SEARCH_PROGRAMS.has(invocation.name);
}

/**
 * A stream editor told to write rather than to print.
 *
 * `sed -n '1,80p' file` is how half the reads in this database are
 * spelled, and `sed -i` is how a good many of the edits are. They are
 * the same program, so the flag has to decide — and an edit counted as
 * a read would inflate exactly the number this story is comparing.
 */
const WRITES_IN_PLACE = /\b(?:sed|perl|ruby)\b[^|;&]*\s-[A-Za-z0-9]*i(?:[A-Za-z0-9]*)?(?=\s|$)/;

/** Whether a tool id names the repository index, on either backend's spelling. */
export function isIndexToolName(name: string): boolean {
  return INDEX_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** The command a shell tool was given, or "" for a call that carried none. */
function commandOf(args: unknown): string {
  if (typeof args !== "object" || args === null) return "";
  const command = (args as { command?: unknown }).command;
  return typeof command === "string" ? command : "";
}

/**
 * What this call was: a query, a search, a read, or none of EO's
 * business.
 *
 * Tool names first, because a backend that offers a real search tool
 * has already answered the question. Shell calls are read off the
 * programs they run, which is where the parser in `broadSearch.ts`
 * earns its keep — a `bash -lc "…"` wrapper, a quoted pipe and a
 * `VAR=value` prefix all resolve to the same answer they would if the
 * command had been written plainly.
 *
 * A command that both searches and reads counts as a search: the search
 * is the part the index was supposed to replace, and it is what the
 * agent did first.
 */
export function toolCallKind(name: string, args: unknown): ToolCallKind {
  if (isIndexToolName(name)) return "index";
  if (SEARCH_TOOLS.has(name)) return "search";
  if (READ_TOOLS.has(name)) return "read";
  if (!SHELL_TOOLS.has(name)) return "other";

  const command = commandOf(args);
  const invocations = invocationsIn(command);
  if (invocations.some(searches)) return "search";
  if (WRITES_IN_PLACE.test(command)) return "other";
  return invocations.some((invocation) => READ_PROGRAMS.has(invocation.name)) ? "read" : "other";
}

/**
 * Was this call a search the index could have answered?
 *
 * The shipping classifier, not a description of it, so that "how often
 * was there something to say" is answered by the code that would have
 * said it. A search of a directory the agent had already chosen is not
 * counted, and neither is a search for prose — an index of declarations
 * cannot answer either, and a target no index could hit is not a target.
 */
export function isIndexAnswerableSearch(name: string, args: unknown): boolean {
  if (SEARCH_TOOLS.has(name)) return true;
  if (!SHELL_TOOLS.has(name)) return false;
  return broadSearchInCommand(commandOf(args)) !== null;
}

// ── What the log holds ──────────────────────────────────────────

/** One `run_events` row, as the report reads it back. */
export interface RecordedEvent {
  seq: number;
  ts: number;
  type: string;
  payload: unknown;
}

/** One run and its log. Token columns are the tally's own output, read back rather than recomputed. */
export interface RecordedRun {
  id: string;
  action: string;
  startedAt: number;
  endedAt: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  costCents: number | null;
  events: RecordedEvent[];
}

/**
 * The note EO keeps about an item's index, as much of it as this asks
 * for.
 *
 * Every field nullable, and null means "nobody recorded that" rather
 * than zero. Rows written before EO-155 have no build duration and no
 * size, and a report that filled those in with zeroes would be claiming
 * an index that took no time and occupies no disk.
 */
export interface RecordedIndex {
  status: string;
  lastIndexDurationMs: number | null;
  lastSyncDurationMs: number | null;
  lastSyncChangedFiles: number | null;
  indexSizeBytes: number | null;
}

/** Everything one item contributes. */
export interface RecordedItem {
  key: string;
  runs: RecordedRun[];
  index: RecordedIndex | null;
}

function parsePayload(event: RecordedEvent): Record<string, unknown> {
  const { payload } = event;
  if (typeof payload === "string") {
    try {
      const parsed: unknown = JSON.parse(payload);
      return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
}

/**
 * A usage row as the tally understands it, or null.
 *
 * Narrowed rather than cast, because the tally's whole correctness rests
 * on `scope`: a session reading replaces and a turn reading adds, and a
 * row whose scope could not be read must be dropped rather than guessed
 * at. Rows this rejects cost the measurement a bound, never a wrong
 * number.
 */
function asUsageEvent(payload: Record<string, unknown>): UsageEvent | null {
  const scope = payload["scope"];
  if (scope !== "turn" && scope !== "session") return null;
  const tokensIn = payload["tokensIn"];
  const tokensOut = payload["tokensOut"];
  if (typeof tokensIn !== "number" || typeof tokensOut !== "number") return null;
  const optional = (key: string): number | undefined => (typeof payload[key] === "number" ? (payload[key] as number) : undefined);
  return {
    type: "usage",
    scope,
    tokensIn,
    tokensOut,
    ...(optional("cacheReadTokens") === undefined ? {} : { cacheReadTokens: optional("cacheReadTokens") as number }),
    ...(optional("cacheWriteTokens") === undefined ? {} : { cacheWriteTokens: optional("cacheWriteTokens") as number }),
    ...(optional("turns") === undefined ? {} : { turns: optional("turns") as number }),
    ...(optional("costCents") === undefined ? {} : { costCents: optional("costCents") as number }),
  };
}

/** What a stretch of a run cost. */
export interface Spend {
  tokensIn: number;
  tokensOut: number;
  costCents: number;
}

const NOTHING: Spend = { tokensIn: 0, tokensOut: 0, costCents: 0 };

const plus = (a: Spend, b: Spend): Spend => ({
  tokensIn: a.tokensIn + b.tokensIn,
  tokensOut: a.tokensOut + b.tokensOut,
  costCents: a.costCents + b.costCents,
});

/**
 * What the usage readings up to a point add up to.
 *
 * Through the shipping tally rather than by summing, because summing is
 * the specific mistake it exists to prevent: Claude re-reports a running
 * total on every result message and adding those counts the first turn
 * once for every turn after it. Importing it means the report cannot
 * drift from what the run row says.
 */
function spendOf(events: RecordedEvent[]): Spend {
  const tally = createUsageTally();
  let any = false;
  for (const event of events) {
    if (event.type !== "usage") continue;
    const usage = asUsageEvent(parsePayload(event));
    if (usage !== null && tally.record(usage)) any = true;
  }
  if (!any) return NOTHING;
  const totals = tally.totals();
  return { tokensIn: totals.tokensIn, tokensOut: totals.tokensOut, costCents: totals.costCents };
}

/** What the run row says the whole run cost. Nulls are zeroes here: nothing reported is nothing spent. */
function totalSpendOf(run: RecordedRun): Spend {
  return { tokensIn: run.tokensIn ?? 0, tokensOut: run.tokensOut ?? 0, costCents: run.costCents ?? 0 };
}

// ── One run ─────────────────────────────────────────────────────

/** Which of an implementation's tools were reached, and how often. Names only. */
export type IndexToolTally = Record<string, number>;

export interface RunMeasurement {
  runId: string;
  action: string;
  /** Whether the index server was attached to this run, as the backend reported it. */
  indexAttached: boolean;
  calls: Record<ToolCallKind, number>;
  /** Searches the index could have answered — the target, rather than every search. */
  answerableSearches: number;
  indexTools: IndexToolTally;
  /** When this run first changed a file, by the event the backends emit for it. */
  firstEditAt: number | null;
  firstEditSeq: number | null;
  /**
   * The calls it made before that edit, by kind.
   *
   * All of them when it never edited, which is correct rather than a
   * fallback: a run that changed nothing spent its whole length looking,
   * and a review or a failed attempt is exactly the kind of run whose
   * cost this story is trying to account for.
   */
  callsBeforeFirstEdit: Record<ToolCallKind, number>;
  /** Nudges EO delivered, and the ones an index call followed before the next nudge. */
  interceptions: number;
  interceptionsTakenUp: number;
  /** How many tool calls each taken-up nudge took to land. Short is the claim; long is a coincidence. */
  takenUpAfter: number[];
  total: Spend;
  /**
   * What had been spent when the first edit happened, when the readings
   * can say. Null when every reading arrived after it, which is the
   * usual case and is what makes the item figure a bound.
   */
  spendBeforeFirstEdit: Spend | null;
}

/** Server statuses that mean the agent could actually call the thing. */
const ATTACHED_STATUSES = new Set(["connected", "ok", "ready", "running"]);

function indexAttachedIn(events: RecordedEvent[]): boolean {
  for (const event of events) {
    if (event.type === "tool_call" && isIndexToolName(String(parsePayload(event)["name"] ?? ""))) return true;
    if (event.type !== "server_status") continue;
    const servers = parsePayload(event)["servers"];
    if (!Array.isArray(servers)) continue;
    for (const server of servers as { name?: unknown; status?: unknown }[]) {
      if (server.name !== REPOSITORY_MCP_SERVER_NAME) continue;
      if (ATTACHED_STATUSES.has(String(server.status ?? "").toLowerCase())) return true;
    }
  }
  return false;
}

/**
 * One run, censused.
 *
 * Everything is taken in `seq` order because `seq` is the run's own
 * clock: `tool_call`, `file_edit`, `usage` and `search_interception`
 * share one sequence, so "before the first edit" is a comparison of two
 * integers rather than an inference from timestamps that a batched
 * write could reorder.
 */
export function measureRun(run: RecordedRun): RunMeasurement {
  const events = [...run.events].sort((a, b) => a.seq - b.seq);
  const firstEdit = events.find((event) => event.type === "file_edit") ?? null;

  const calls = zeroCalls();
  const callsBeforeFirstEdit = zeroCalls();
  const indexTools: IndexToolTally = {};
  let answerableSearches = 0;
  let interceptions = 0;
  let interceptionsTakenUp = 0;
  const takenUpAfter: number[] = [];
  /** The nudge still waiting to see whether it was taken up, and how many calls ago it was. */
  let pending: { callsSince: number } | null = null;

  for (const event of events) {
    if (event.type === SEARCH_INTERCEPTION_EVENT) {
      interceptions++;
      // A second nudge closes the first unanswered one. "Nudged, then
      // queried the index" is the claim; "nudged, nudged again, and
      // eventually queried" is not the same claim.
      pending = { callsSince: 0 };
      continue;
    }
    if (event.type !== "tool_call") continue;

    const payload = parsePayload(event);
    const name = String(payload["name"] ?? "");
    const kind = toolCallKind(name, payload["args"]);
    calls[kind]++;
    if (kind === "index") indexTools[name] = (indexTools[name] ?? 0) + 1;
    if (isIndexAnswerableSearch(name, payload["args"])) answerableSearches++;
    if (firstEdit === null || event.seq < firstEdit.seq) callsBeforeFirstEdit[kind]++;

    if (pending !== null) {
      pending.callsSince++;
      if (kind === "index") {
        interceptionsTakenUp++;
        takenUpAfter.push(pending.callsSince);
        pending = null;
      }
    }
  }

  const before = firstEdit === null ? null : spendOf(events.filter((event) => event.seq < firstEdit.seq));

  return {
    runId: run.id,
    action: run.action,
    indexAttached: indexAttachedIn(events),
    calls,
    answerableSearches,
    indexTools,
    firstEditAt: firstEdit?.ts ?? null,
    firstEditSeq: firstEdit?.seq ?? null,
    callsBeforeFirstEdit,
    interceptions,
    interceptionsTakenUp,
    takenUpAfter,
    total: totalSpendOf(run),
    // A zero reading is "no reading", not "nothing was spent": both
    // backends report at the end of a stream, so a run with nothing
    // before its first edit has not measured zero, it has measured
    // nothing. Saying so is what keeps the item figure a bound rather
    // than a claim.
    spendBeforeFirstEdit: before === null || (before.tokensIn === 0 && before.tokensOut === 0) ? null : before,
  };
}

// ── One item ──────────────────────────────────────────────────

/**
 * What had been spent before an item first changed a source file.
 *
 * Two numbers and a flag, rather than one number, and the flag is the
 * honest part. `atLeast` is what EO can prove was spent on work that had
 * not yet touched a file — whole runs that finished before it. `atMost`
 * adds the run the edit happened in, all of it, because when a backend
 * reports usage only at the end of a stream there is no reading inside
 * that run to divide it at. `exact` says the two are the same number
 * because readings straddled the edit.
 *
 * A single figure here would be a plausible number with nothing behind
 * it, which is the failure this whole story exists to avoid.
 */
export interface OpeningSpend {
  atLeast: Spend;
  atMost: Spend;
  exact: boolean;
}

export interface ItemMeasurement {
  key: string;
  /** Whether the index was attached to any of this item's runs. The arm, read off the log. */
  arm: "on" | "off";
  runs: number;
  agentRuns: number;
  calls: Record<ToolCallKind, number>;
  answerableSearches: number;
  indexTools: IndexToolTally;
  interceptions: number;
  interceptionsTakenUp: number;
  takenUpAfter: number[];
  /** Tool calls made before the item first changed a file. Every call it made, when it never did. */
  callsBeforeFirstEdit: Record<ToolCallKind, number>;
  firstEditAt: number | null;
  /**
   * Time spent inside runs before the first change, in milliseconds.
   *
   * Inside runs, because an item waiting overnight for a person is not
   * an item spending time looking for a symbol, and wall clock would
   * report the wait as the cost of discovery. Null when nothing ever
   * recorded an edit.
   */
  workingMsBeforeFirstEdit: number | null;
  /** The same span in wall clock, from the first run's start. The number a person feels. */
  elapsedMsBeforeFirstEdit: number | null;
  spendBeforeFirstEdit: OpeningSpend | null;
  total: Spend;
  index: RecordedIndex | null;
}

/**
 * One item, from its runs in the order they happened.
 *
 * Runs are ordered by `started_at` and treated as consecutive, which
 * they are: concurrency is 1 (invariant #10), so no two runs of an item
 * overlap and "the run the first edit happened in" divides the item
 * cleanly into before and after.
 */
export function measureItem(item: RecordedItem): ItemMeasurement {
  const ordered = [...item.runs].sort((a, b) => a.startedAt - b.startedAt);
  const measured = ordered.map(measureRun);
  const openingAt = measured.findIndex((run) => run.firstEditAt !== null);
  const opening = openingAt === -1 ? null : (measured[openingAt] as RunMeasurement);

  const calls = zeroCalls();
  const before = zeroCalls();
  const indexTools: IndexToolTally = {};
  let answerableSearches = 0;
  let interceptions = 0;
  let interceptionsTakenUp = 0;
  const takenUpAfter: number[] = [];
  let total: Spend = NOTHING;

  for (const [at, run] of measured.entries()) {
    for (const kind of KINDS) {
      calls[kind] += run.calls[kind];
      // Every run up to and including the one that first edited, each
      // contributing what it did before *its* first edit — which for
      // every run but the last of them is everything it did. A run after
      // it contributes nothing: whatever it was doing, the item had
      // already started changing the repository.
      if (openingAt === -1 || at <= openingAt) before[kind] += run.callsBeforeFirstEdit[kind];
    }
    for (const [name, count] of Object.entries(run.indexTools)) indexTools[name] = (indexTools[name] ?? 0) + count;
    answerableSearches += run.answerableSearches;
    interceptions += run.interceptions;
    interceptionsTakenUp += run.interceptionsTakenUp;
    takenUpAfter.push(...run.takenUpAfter);
    total = plus(total, run.total);
  }

  return {
    key: item.key,
    arm: measured.some((run) => run.indexAttached) ? "on" : "off",
    runs: ordered.length,
    agentRuns: measured.filter((run) => run.calls.index + run.calls.search + run.calls.read + run.calls.other > 0).length,
    calls,
    answerableSearches,
    indexTools,
    interceptions,
    interceptionsTakenUp,
    takenUpAfter,
    callsBeforeFirstEdit: before,
    firstEditAt: opening?.firstEditAt ?? null,
    workingMsBeforeFirstEdit: workingMsBefore(ordered, measured, openingAt),
    elapsedMsBeforeFirstEdit: opening === null ? null : (opening.firstEditAt as number) - (ordered[0] as RecordedRun).startedAt,
    spendBeforeFirstEdit: openingSpendOf(measured, openingAt),
    total,
    index: item.index,
  };
}

function workingMsBefore(ordered: RecordedRun[], measured: RunMeasurement[], openingAt: number): number | null {
  if (openingAt === -1) return null;
  let elapsed = 0;
  for (const [at, run] of ordered.entries()) {
    if (at > openingAt) break;
    const until = at === openingAt ? (measured[at] as RunMeasurement).firstEditAt : (run.endedAt ?? run.startedAt);
    elapsed += Math.max(0, (until ?? run.startedAt) - run.startedAt);
  }
  return elapsed;
}

function openingSpendOf(measured: RunMeasurement[], openingAt: number): OpeningSpend | null {
  if (openingAt === -1) return null;
  let closed: Spend = NOTHING;
  for (const [at, run] of measured.entries()) {
    if (at >= openingAt) break;
    closed = plus(closed, run.total);
  }
  const opening = measured[openingAt] as RunMeasurement;
  if (opening.spendBeforeFirstEdit !== null) {
    const exact = plus(closed, opening.spendBeforeFirstEdit);
    return { atLeast: exact, atMost: exact, exact: true };
  }
  return { atLeast: closed, atMost: plus(closed, opening.total), exact: false };
}

// ── The two arms, and the difference between them ───────────────

/** A metric over a set of items. Spread as well as centre: a mean without one is not a finding. */
export interface Spread {
  n: number;
  total: number;
  mean: number;
  median: number;
  min: number;
  max: number;
}

export function spreadOf(values: number[]): Spread {
  if (values.length === 0) return { n: 0, total: 0, mean: 0, median: 0, min: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    n: sorted.length,
    total,
    mean: total / sorted.length,
    median: sorted.length % 2 === 1 ? (sorted[middle] as number) : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2,
    min: sorted[0] as number,
    max: sorted[sorted.length - 1] as number,
  };
}

/** One number compared across the two arms, with the difference already worked out. */
export interface Difference {
  label: string;
  unit: string;
  on: Spread;
  off: Spread;
  /** On minus off, on the means. Negative is less work with the feature on. */
  delta: number;
  /**
   * The same subtraction on the medians.
   *
   * Kept beside the mean because when the two disagree the mean is being
   * carried by one item, and that is the exact shape of the wrong
   * claim this report exists to stop somebody making — a 43% saving
   * whose medians are identical.
   */
  medianDelta: number;
  /** The same as a share of the off arm, or null when the off arm is zero and a ratio would be meaningless. */
  share: number | null;
  /** Whether the arms' ranges overlap, which at these sample sizes they usually do. */
  overlapping: boolean;
  /** The difference in words, so a reader is not left to compute it. */
  stated: string;
}

const round = (value: number): string => (Number.isInteger(value) ? String(value) : value.toFixed(value < 10 ? 2 : 1));

/**
 * One metric, stated.
 *
 * The sentence is built here rather than in the printer because "states
 * the difference" is an acceptance criterion, and a criterion met by a
 * `console.log` in a script is a criterion nothing can test. It says the
 * direction in words, and when the two arms' ranges overlap it says that
 * too — at these sample sizes they nearly always do, and a difference
 * quoted without it is the kind of claim this story exists to stop being
 * made.
 */
export function difference(label: string, unit: string, onValues: number[], offValues: number[]): Difference {
  const on = spreadOf(onValues);
  const off = spreadOf(offValues);
  const delta = on.mean - off.mean;
  const medianDelta = on.median - off.median;
  const share = off.mean === 0 ? null : delta / off.mean;
  const overlapping = on.n > 0 && off.n > 0 && on.min <= off.max && off.min <= on.max;
  // A mean that moved while the median did not, or moved the other way,
  // is one item's story rather than the set's.
  const carried = on.n > 0 && off.n > 0 && delta !== 0 && (medianDelta === 0 || Math.sign(medianDelta) !== Math.sign(delta));

  const direction = delta === 0 ? "the same" : delta < 0 ? `${round(Math.abs(delta))} fewer` : `${round(delta)} more`;
  const percent = share === null || delta === 0 ? "" : ` (${share > 0 ? "+" : "−"}${Math.round(Math.abs(share) * 100)}%)`;
  const heads =
    on.n === 0 || off.n === 0
      ? `${label}: nothing to compare — ${on.n} ticket(s) with the feature on, ${off.n} with it off.`
      : `${label}: ${round(on.mean)} ${unit} with it on against ${round(off.mean)} with it off — ${direction}${percent}.`;
  const spreads =
    on.n === 0 || off.n === 0
      ? ""
      : ` On: median ${round(on.median)}, range ${round(on.min)}–${round(on.max)} over ${on.n}. Off: median ${round(off.median)}, range ${round(off.min)}–${round(off.max)} over ${off.n}.`;
  const caution = overlapping ? " The ranges overlap, so this is a direction and not a result." : "";
  const outliers = carried
    ? ` The medians do not move with the means (${round(on.median)} against ${round(off.median)}), so this difference is carried by outliers rather than by the set.`
    : "";

  return { label, unit, on, off, delta, medianDelta, share, overlapping, stated: `${heads}${spreads}${caution}${outliers}` };
}

/** How the two arms compare, on the numbers this story names. */
export interface Comparison {
  on: ItemMeasurement[];
  off: ItemMeasurement[];
  differences: Difference[];
  /**
   * Nudged, and then queried the index.
   *
   * The one comparison that is internally controlled: both halves come
   * from inside a single run, so an item being harder than another
   * cannot explain it. Null until something has been nudged at all —
   * a zero here would say the agent ignored EO, when what happened is
   * that EO never said anything.
   */
  compliance: { interceptions: number; takenUp: number; share: number } | null;
}

/**
 * The two arms and the difference between them.
 *
 * Which arm an item is in is read off its runs — did the backend report
 * the index server, or did the item call an index tool — rather than
 * off the flag as it stands today. The flag is a live setting and this
 * is a question about the past, so a report that read it would relabel
 * every historical item the moment somebody flipped a switch.
 */
export function compare(items: ItemMeasurement[]): Comparison {
  const on = items.filter((item) => item.arm === "on");
  const off = items.filter((item) => item.arm === "off");

  const discovery = (item: ItemMeasurement): number => item.callsBeforeFirstEdit.search + item.callsBeforeFirstEdit.read;
  const differences = [
    difference("Filesystem reads and searches before the first change", "calls", on.map(discovery), off.map(discovery)),
    difference(
      "Searches before the first change",
      "calls",
      on.map((t) => t.callsBeforeFirstEdit.search),
      off.map((t) => t.callsBeforeFirstEdit.search),
    ),
    difference(
      "Index calls",
      "calls",
      on.map((t) => t.calls.index),
      off.map((t) => t.calls.index),
    ),
    difference(
      "Searches the index could have answered",
      "calls",
      on.map((t) => t.answerableSearches),
      off.map((t) => t.answerableSearches),
    ),
    difference(
      "Tokens in before the first change, at most",
      "tokens",
      on.flatMap((t) => (t.spendBeforeFirstEdit === null ? [] : [t.spendBeforeFirstEdit.atMost.tokensIn])),
      off.flatMap((t) => (t.spendBeforeFirstEdit === null ? [] : [t.spendBeforeFirstEdit.atMost.tokensIn])),
    ),
    difference(
      "Working minutes before the first change",
      "minutes",
      on.flatMap((t) => (t.workingMsBeforeFirstEdit === null ? [] : [t.workingMsBeforeFirstEdit / 60_000])),
      off.flatMap((t) => (t.workingMsBeforeFirstEdit === null ? [] : [t.workingMsBeforeFirstEdit / 60_000])),
    ),
  ];

  const interceptions = items.reduce((sum, item) => sum + item.interceptions, 0);
  const takenUp = items.reduce((sum, item) => sum + item.interceptionsTakenUp, 0);

  return {
    on,
    off,
    differences,
    compliance: interceptions === 0 ? null : { interceptions, takenUp, share: takenUp / interceptions },
  };
}

/** What the index cost to build and to keep, across the items that recorded it. */
export interface IndexCost {
  /** Items whose row records a build duration. Rows written before EO-155 do not. */
  builds: Spread;
  syncs: Spread;
  changedFiles: Spread;
  sizeBytes: Spread;
  /** Items with an index row that recorded none of it, so a reader knows what the spreads are missing. */
  unrecorded: number;
}

export function indexCostOf(items: ItemMeasurement[]): IndexCost {
  const rows = items.flatMap((item) => (item.index === null ? [] : [item.index]));
  const collect = (read: (row: RecordedIndex) => number | null): number[] =>
    rows.flatMap((row) => {
      const value = read(row);
      return value === null ? [] : [value];
    });

  return {
    builds: spreadOf(collect((row) => row.lastIndexDurationMs)),
    syncs: spreadOf(collect((row) => row.lastSyncDurationMs)),
    changedFiles: spreadOf(collect((row) => row.lastSyncChangedFiles)),
    sizeBytes: spreadOf(collect((row) => row.indexSizeBytes)),
    unrecorded: rows.filter((row) => row.lastIndexDurationMs === null && row.lastSyncDurationMs === null && row.indexSizeBytes === null).length,
  };
}
