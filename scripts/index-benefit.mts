// Whether repository intelligence actually helps (EO-155).
//
// This is the report the whole of EO-141 was built to make possible, and
// the reason none of the other stories claims a saving. It answers, per
// item and then across the two arms:
//
//   how many repository-intelligence calls were made against how many
//   filesystem reads and searches -- and how many of each came *before*
//   the item first changed a file, which is the orienting sequence the
//   index is supposed to shorten;
//
//   how many tokens had been spent by then;
//
//   how long that took;
//
//   what the index itself cost -- to build once, to sync at each
//   handover, and in bytes on disk.
//
// Then it says the difference between the arms in words, rather than
// printing two columns and leaving somebody to subtract them.
//
//   pnpm report:index-benefit                    # every item that ran an agent
//   pnpm report:index-benefit EO-162 EO-170
//   pnpm report:index-benefit --db path/to/eo.db --json
//
// **It is a report, not a telemetry system, and running it fetches
// nothing.** EO has none by choice. Nothing here opens a socket, nothing
// is written anywhere, and no part of running it reaches a package
// registry: it is Node executing files already in this checkout, reading
// one SQLite file already on this machine, printing to this terminal.
//
// That last clause is why there is no `#!/usr/bin/env -S pnpm dlx tsx`
// at the top of this file. `pnpm dlx` downloads its tool when the
// machine has not cached it, so the documented way to run a report whose
// acceptance criterion is "nothing is transmitted anywhere" began with a
// request to registry.npmjs.org. It runs on Node's own type stripping
// instead, through `scripts/local-typescript.mjs`, which is what the
// `report:index-benefit` script above wires up. `measurement.test.ts`
// runs that exact invocation with every route to a network poisoned and
// fails if it needs one.
//
// **No source content, ever.** The classifier reads a command line to
// decide what kind of call it was and keeps the word, never the command.
// What is printed is counts, durations, sizes, tool names and item
// keys.
//
// The arithmetic is imported, never copied. It lives in
// `apps/desktop/src/main/packs/developer/repositoryIntelligence/measurement.ts` with its
// tests beside it, and this file is a query and a printer -- so what is
// reported here is what the shipped code computes, and a person can go
// and read why each figure means what it says.
//
// Read-only, and through `node:sqlite` rather than `better-sqlite3` --
// the native module has exactly one import site (ARCHITECTURE.md, "SQLite, and nothing more") and a
// reporting script is not it.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  compare,
  indexCostOf,
  measureItem,
  type RecordedEvent,
  type RecordedIndex,
  type RecordedRun,
  type RecordedItem,
  type Spread,
  type ItemMeasurement,
} from "../apps/desktop/src/main/packs/developer/repositoryIntelligence/measurement.js";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
};

const dbPath = flag("--db") ?? join(homedir(), ".config", "EO", "eo.db");
const wanted = argv.filter((argument) => /^[A-Z][A-Z0-9]*-\d+$/.test(argument));
const asJson = argv.includes("--json");

if (!existsSync(dbPath)) {
  console.error(`No database at ${dbPath}. Pass one with --db.`);
  process.exit(1);
}

const db = new DatabaseSync(dbPath, { readOnly: true });
// Bound parameters even for a read-only script somebody runs by hand:
// the day an item key comes from anywhere but a keyboard, the habit is
// already right.
const where = wanted.length === 0 ? "" : `AND t.key IN (${wanted.map(() => "?").join(",")})`;

interface RunRow {
  id: string;
  key: string;
  action: string;
  startedAt: number;
  endedAt: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  costCents: number | null;
}

/**
 * Every run that did something an agent does.
 *
 * A run with no tool calls is a builtin -- a worktree cut, a pull
 * request opened -- and including them would pad every item with rows
 * that have nothing to census. Their *cost* is not lost: the token
 * columns come from the run rows of the runs that reported any.
 */
const runs = db
  .prepare(
    `SELECT r.id AS id, t.key AS key, r.action AS action, r.started_at AS startedAt, r.ended_at AS endedAt,
            r.tokens_in AS tokensIn, r.tokens_out AS tokensOut, r.cost_cents AS costCents
       FROM runs r JOIN items t ON t.id = r.item_id
      WHERE r.started_at IS NOT NULL ${where}
        AND EXISTS (SELECT 1 FROM run_events e WHERE e.run_id = r.id)
      ORDER BY t.key, r.started_at`,
  )
  .all(...wanted) as unknown as RunRow[];

const eventsOf = db.prepare(`SELECT seq, ts, type, payload FROM run_events WHERE run_id = ? ORDER BY seq`);

/**
 * The index note for an item, by key.
 *
 * One row per (repository, item), so an item has at most one. An
 * item with none is one that never reached the indexing step -- or one
 * whose worktree was released and note forgotten, which is why the
 * durations are recorded on the row as they happen rather than measured
 * when somebody asks.
 */
const indexColumns = new Set((db.prepare(`PRAGMA table_info(repository_indexes)`).all() as { name: string }[]).map((row) => row.name));

/**
 * A column if this database has it, and a null if it does not.
 *
 * The whole point of deriving a measurement from what EO already records
 * is that it works on databases that predate the measurement. A copy of
 * `eo.db` from before the build-duration and size columns existed still
 * answers every other question in this report, and refusing to open it
 * because two columns are missing would be the report insisting on the
 * instrumentation it was written to avoid needing.
 */
const optional = (column: string, alias: string): string => (indexColumns.has(column) ? `i.${column} AS ${alias}` : `NULL AS ${alias}`);

const indexRows = db
  .prepare(
    `SELECT t.key AS key, i.status AS status, ${optional("last_index_duration_ms", "lastIndexDurationMs")},
            ${optional("last_sync_duration_ms", "lastSyncDurationMs")}, ${optional("last_sync_changed_files", "lastSyncChangedFiles")},
            ${optional("index_size_bytes", "indexSizeBytes")}
       FROM repository_indexes i JOIN items t ON t.id = i.item_id`,
  )
  .all() as unknown as (RecordedIndex & { key: string })[];

const indexes = new Map(indexRows.map((row) => [row.key, row]));

const byItem = new Map<string, RecordedRun[]>();
for (const row of runs) {
  const events = eventsOf.all(row.id) as unknown as RecordedEvent[];
  const list = byItem.get(row.key) ?? [];
  list.push({
    id: row.id,
    action: row.action,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    tokensIn: row.tokensIn,
    tokensOut: row.tokensOut,
    costCents: row.costCents,
    events,
  });
  byItem.set(row.key, list);
}

const items: RecordedItem[] = [...byItem.entries()].map(([key, itemRuns]) => ({
  key,
  runs: itemRuns,
  index: indexes.get(key) ?? null,
}));

const measured = items.map(measureItem).sort(byKey);
const comparison = compare(measured);

// ── printing ────────────────────────────────────────────────────

function byKey(a: ItemMeasurement, b: ItemMeasurement): number {
  const number = (key: string): number => Number(key.split("-")[1] ?? 0);
  const project = (key: string): string => key.split("-")[0] ?? key;
  return project(a.key) === project(b.key) ? number(a.key) - number(b.key) : project(a.key).localeCompare(project(b.key));
}

const pad = (value: string | number, width: number): string => String(value).padStart(width);

/** Milliseconds a person can read. Durations here run from twenty to several hundred thousand. */
function duration(ms: number | null): string {
  if (ms === null) return "not recorded";
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 90_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function bytes(size: number | null): string {
  if (size === null) return "not recorded";
  if (size < 1_048_576) return `${Math.round(size / 1_024)} KB`;
  return `${(size / 1_048_576).toFixed(1)} MB`;
}

/** Tokens, in the units people actually quote them in. */
function tokens(count: number): string {
  return count >= 1_000_000 ? `${(count / 1_000_000).toFixed(2)}M` : count >= 1_000 ? `${Math.round(count / 1_000)}k` : String(count);
}

function spend(item: ItemMeasurement): string {
  const opening = item.spendBeforeFirstEdit;
  if (opening === null) return "no change recorded";
  if (opening.exact) return `${tokens(opening.atLeast.tokensIn)} in`;
  return `${tokens(opening.atLeast.tokensIn)}–${tokens(opening.atMost.tokensIn)} in (bounded)`;
}

function spreadLine(label: string, spread: Spread, render: (value: number) => string): string {
  if (spread.n === 0) return `  ${label.padEnd(34)} nothing recorded`;
  return `  ${label.padEnd(34)} median ${render(spread.median)}, range ${render(spread.min)}–${render(spread.max)} over ${spread.n}`;
}

/**
 * The whole human-readable report, in one function.
 *
 * A function rather than the module body so that `--json` can decline
 * to run it without `process.exit` truncating what it just printed.
 */
function printReport(): void {
  console.log(`\n${dbPath}`);
  console.log(`\n${measured.length} ticket(s): ${comparison.on.length} ran with the index attached, ${comparison.off.length} without.`);

  console.log("\nPer ticket — `opening` is everything before the ticket first changed a file");
  for (const item of measured) {
    const opening = item.callsBeforeFirstEdit;
    console.log(
      `\n  ${item.key.padEnd(9)} ${item.arm === "on" ? "index on " : "index off"}  ${pad(item.runs, 3)} runs   ` +
        `${pad(item.calls.index, 3)} index · ${pad(item.calls.search, 4)} search · ${pad(item.calls.read, 4)} read`,
    );
    console.log(
      `     opening ${pad(opening.index, 3)} index · ${pad(opening.search, 4)} search · ${pad(opening.read, 4)} read` +
        `   (${item.answerableSearches} search${item.answerableSearches === 1 ? "" : "es"} the index could have answered)`,
    );
    console.log(
      item.workingMsBeforeFirstEdit === null
        ? "     no source change recorded — everything above is opening, and the tokens cannot be split"
        : `     first change after ${duration(item.workingMsBeforeFirstEdit)} of run time` +
          `${item.elapsedMsBeforeFirstEdit === null ? "" : ` (${duration(item.elapsedMsBeforeFirstEdit)} wall clock)`}` +
          ` · ${spend(item)}`,
    );
    if (item.interceptions > 0) {
      console.log(
        `     nudged ${item.interceptions}× toward the index, taken up ${item.interceptionsTakenUp}×` +
          `${item.takenUpAfter.length === 0 ? "" : ` (after ${item.takenUpAfter.join(", ")} call${item.takenUpAfter.length === 1 ? "" : "s"})`}`,
      );
    }
    // Merged after shortening, because the same tool reached from both
    // backends arrives under two ids and is one tool.
    const tools = new Map<string, number>();
    for (const [name, count] of Object.entries(item.indexTools)) tools.set(short(name), (tools.get(short(name)) ?? 0) + count);
    const reached = [...tools].sort((a, b) => b[1] - a[1]);
    if (reached.length > 0) console.log(`     index tools reached: ${reached.map(([name, count]) => `${name}×${count}`).join(", ")}`);
    if (item.index !== null) {
      console.log(
        `     index: built in ${duration(item.index.lastIndexDurationMs)} · last sync ${duration(item.index.lastSyncDurationMs)}` +
          `${item.index.lastSyncChangedFiles === null ? "" : ` over ${item.index.lastSyncChangedFiles} file(s)`}` +
          ` · ${bytes(item.index.indexSizeBytes)} on disk`,
      );
    }
  }

  /** A tool id without whichever backend's prefix it arrived under. */
  function short(name: string): string {
    return name.replace(/^mcp__[^_]+__/, "").replace(/^[^/]+\//, "");
  }

  console.log("\n\nThe difference between the arms — stated, not left to be worked out");
  for (const stated of comparison.differences) console.log(`\n  ${stated.stated}`);

  console.log("\n\nNudged, and then queried the index");
  if (comparison.compliance === null) {
    console.log("  Nothing has been nudged in this set, so there is nothing to say. A zero here would be EO's silence, not an agent's.");
  } else {
    const { interceptions, takenUp, share } = comparison.compliance;
    console.log(
      `  ${takenUp} of ${interceptions} interceptions were followed by an index call before the next one — ${Math.round(share * 100)}%.\n` +
        "  This is the one comparison here that is internally controlled: both halves happen inside a single run,\n" +
        "  so a ticket being harder than another cannot explain it.",
    );
  }

  const cost = indexCostOf(comparison.on);
  console.log("\n\nWhat the index cost, from the rows the provider wrote");
  console.log(spreadLine("Build from nothing, once per worktree", cost.builds, (value) => duration(value)));
  console.log(spreadLine("Sync at a handover", cost.syncs, (value) => duration(value)));
  console.log(spreadLine("Files a sync reported changing", cost.changedFiles, (value) => String(value)));
  console.log(spreadLine("On disk", cost.sizeBytes, (value) => bytes(value)));
  if (cost.unrecorded > 0) {
    console.log(`  ${cost.unrecorded} index row(s) recorded none of this — written before EO-155 added the columns, and counted as unknown rather than zero.`);
  }

  console.log(`
  What this cannot say, which is most of it

    The two arms are different tickets. Nothing here holds task difficulty
    still, and the tickets in the "on" arm are the ones that built this
    feature — an unusually navigation-heavy stretch of work. A difference
    in a mean across a dozen tickets each side is a direction to look in,
    not a result, and every line above that has overlapping ranges says so.

    Tokens before the first change is a bound wherever it says "bounded".
    Both backends report usage when a stream ends, so a run that edited in
    its eighth turn has no reading taken at the moment it did; what is
    printed is the least it can have been and the most.

    "Tokens in" is what EO records under that name, cache reads included.
    On a long run most of it is the same context re-sent every turn, so
    this number tracks turns and context size as much as it tracks how
    much looking around an agent did.

    A ticket whose agent edited through the shell rather than through an
    edit tool records no \`file_edit\` event, and shows "no change recorded".
    Its calls are still counted; its opening is its whole length.
  `);
}

// Two whole reports rather than one with holes in it: `--json` is for
// something else to read and everything below is for a person.
//
// Deliberately not `console.log(json); process.exit(0)`, which is what
// this did and which loses the tail of a large payload when stdout is a
// pipe -- `process.exit` does not wait for an asynchronous write to
// drain, so `--json > file` produced a truncated document and
// `| head` produced an empty one. Letting the module end instead means
// Node flushes before it exits.
if (asJson) {
  console.log(JSON.stringify({ database: dbPath, items: measured, comparison, cost: indexCostOf(comparison.on) }, null, 2));
} else {
  printReport();
}
