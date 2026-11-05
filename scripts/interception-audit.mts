#!/usr/bin/env -S pnpm dlx tsx
// What EO-165's interception would have said, on runs that already happened.
//
// EO-165's whole risk is precision. It matches `Bash` and reads the
// command line, which is where every false positive lives, and its own
// acceptance criterion says a false positive costs more than a true
// positive gains — the agent still has to do its job with something
// interrupting it. Tests name commands somebody thought of; this replays
// the ones agents actually ran.
//
// It answers two questions off `run_events`, for any item:
//
//   how many shell calls would have been interrupted, and which — so a
//   person can read the list and see for themselves that none of them is
//   the check suite, a git operation or a file the agent had already
//   found;
//
//   and which search-shaped commands were left alone, so the misses are
//   visible too rather than hidden inside a percentage.
//
//   pnpm dlx tsx scripts/interception-audit.mts                        # the two EO-165 baselines
//   pnpm dlx tsx scripts/interception-audit.mts EO-171 EO-172
//   pnpm dlx tsx scripts/interception-audit.mts --db path/to/eo.db --all
//
// Since EO-168 an interception is itself a `run_events` row, so it also
// reports what actually fired rather than what would have:
//
//   pnpm dlx tsx scripts/interception-audit.mts --recorded EO-171
//
// That is the mode to reach for first. Everything above this line is a
// replay — it says what the classifier *would* have interrupted on runs
// that predate the recording — and a replay cannot tell a run where the
// hook never fired from one where it fired and was ignored. The
// recorded mode can, because a zero in it means the agent was never
// nudged.
//
// And it audits a *trial transcript* against its own recorded firings:
//
//   pnpm dlx tsx scripts/interception-audit.mts --trial scripts/fixtures/eo165/trial-hook.json
//
// That mode exists because of a specific mistake. Three runs of the hook
// arm were published claiming the interception fired, on a transcript
// whose `interceptions` field was empty for every one of them: the
// harness had been counting a channel that carries nothing, and the
// census reads `calls` only, so nothing contradicted the prose. This
// replays the shipping classifier over the recorded calls and compares
// it to what the harness recorded, and **exits non-zero** when a run
// that was given the hook made a search the classifier recognises and
// recorded no interception. A claim that the hook fired is now something
// a command can refuse.
//
// The classifier is imported, never copied: this has to be the code that
// ships or it is measuring something else. Read-only, and through
// `node:sqlite` rather than `better-sqlite3` — the native module has
// exactly one import site (ARCHITECTURE.md, "SQLite, and nothing more") and a reporting script is
// not
// it.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { broadSearchInCommand } from "../apps/desktop/src/main/packs/developer/repositoryIntelligence/broadSearch.js";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
};

/** One run as `index-adoption-trial.mjs` writes it. */
interface TrialRun {
  id: string;
  calls: { name: string; args?: Record<string, unknown> }[];
  /** Whether this run's query server carried a vocabulary, and so got a hook at all. */
  hookDelivered?: boolean;
  /** What the harness recorded EO's hook actually saying. */
  interceptions?: string[];
}

interface Trial {
  arm?: string;
  runs: TrialRun[];
}

const isBroad = (call: TrialRun["calls"][number]): boolean =>
  call.name === "Bash" && broadSearchInCommand(typeof call.args?.["command"] === "string" ? (call.args["command"] as string) : "") !== null;

/**
 * A trial transcript against its own account of itself.
 *
 * Two numbers per run: what the shipping classifier says should have
 * been intercepted, and what the harness recorded. They are produced by
 * different mechanisms — a replay here, a wrapped callback there — which
 * is the whole point. Agreement is evidence; a silent zero on one side
 * is the thing that got published once already.
 */
function auditTrials(paths: string[]): never {
  let refused = false;
  for (const path of paths) {
    const trial = JSON.parse(readFileSync(path, "utf8")) as Trial;
    console.log(`\n${path}`);
    for (const run of trial.runs) {
      // The fallback is for transcripts written before the harness
      // recorded this, and it is exact rather than a guess: `hook` is
      // the only arm that gives the query server a vocabulary, which is
      // the only thing that produces a hook.
      const delivered = run.hookDelivered ?? trial.arm === "hook";
      const replayed = run.calls.filter(isBroad).length;
      const recorded = run.interceptions?.length ?? 0;
      const stated = run.hookDelivered === undefined ? " (inferred from the arm)" : "";

      if (!delivered) {
        console.log(`  ${run.id.padEnd(24)} hook off${stated} — ${replayed} broad searches, none intercepted, as expected`);
        if (recorded > 0) {
          console.log(`     !! but ${recorded} interceptions were recorded on a run that was given no hook`);
          refused = true;
        }
        continue;
      }

      const verdict = recorded === 0 && replayed > 0 ? "!! RECORDED NOTHING" : recorded === replayed ? "agree" : "differ";
      console.log(`  ${run.id.padEnd(24)} hook on${stated} — classifier ${replayed}, harness ${recorded} — ${verdict}`);
      if (recorded === 0 && replayed > 0) {
        console.log("     This run is not evidence that the hook fired. Either it was not delivered,");
        console.log("     or the counter was reading a channel that carries nothing. Fix it and re-run.");
        refused = true;
      }
    }
  }
  console.log(refused ? "\nRefused: at least one run claims a hook it cannot show.\n" : "\nEvery run's two counts agree.\n");
  process.exit(refused ? 1 : 0);
}

const trialPaths = argv.filter((argument) => argument.endsWith(".json"));
if (argv.includes("--trial") || trialPaths.length > 0) auditTrials(trialPaths);

/** The two runs EO-165 is measured against, unless a caller names others. */
const DEFAULT_ITEMS = ["EO-159", "EO-162"];
const items = argv.filter((argument) => /^[A-Z]+-\d+$/.test(argument));
const all = argv.includes("--all");
const dbPath = flag("--db") ?? join(homedir(), ".config", "EO", "eo.db");

if (!existsSync(dbPath)) {
  console.error(`No database at ${dbPath}. Pass one with --db.`);
  process.exit(1);
}

/**
 * How many times a run's agent was actually redirected (EO-168).
 *
 * One query over the event log, written down once so the measurement is
 * repeatable rather than reassembled from memory each time somebody asks.
 * The same count `countSearchInterceptions` in
 * `apps/desktop/src/main/db/repos/runEventsRepo.ts` returns inside the
 * app; this is the spelling for anyone standing outside it with a
 * database file.
 *
 *     SELECT COUNT(*) FROM run_events
 *      WHERE run_id = ? AND type = 'search_interception'
 *
 * The per-run report below is that count with two figures beside it, and
 * the three together are what make the two worlds legible:
 *
 *   interceptions 0, broad searches many — the hook never fired. The
 *     matcher missed, no index was attached, the vocabulary was absent,
 *     or the backend has no hook to carry one. A wiring problem, and
 *     nothing about the agent's judgement.
 *
 *   interceptions many, index calls 0 — it fired and was ignored. A
 *     persuasion problem, and the case for something stronger than a
 *     nudge.
 *
 * Before this event existed both produced the identical transcript.
 *
 * `nudgedCalls` counts the distinct calls behind those firings and
 * `joined` counts the firings that find their call in this same run's
 * log. Both are normally equal to `interceptions` and are here for when
 * they are not: a model can ask for several tools in one message, so two
 * identical parallel greps produce two interceptions that agree in every
 * visible field, and only `tool_call.callId` says whether that was two calls
 * nudged once or one call nudged twice — or a firing attributed to a
 * call that was never recorded at all.
 *
 * The join is the reason `search_interception.callId` exists rather
 * than being decoration, so it is spelled out here rather than left as
 * something a person would have to invent at the moment they needed it.
 * It is the same field EO-169's `tool_result` pairs on, so the three
 * kinds join to each other with one word between them.
 */
const RECORDED_INTERCEPTIONS = `
  SELECT t.key AS item, r.action AS action, r.id AS run,
         SUM(CASE WHEN e.type = 'search_interception' THEN 1 ELSE 0 END) AS interceptions,
         COUNT(DISTINCT CASE WHEN e.type = 'search_interception' THEN json_extract(e.payload,'$.callId') END) AS nudgedCalls,
         SUM(CASE WHEN e.type = 'search_interception' AND EXISTS (
               SELECT 1 FROM run_events c
                WHERE c.run_id = e.run_id AND c.type = 'tool_call'
                  AND json_extract(c.payload,'$.callId') = json_extract(e.payload,'$.callId')
             ) THEN 1 ELSE 0 END) AS joined,
         SUM(CASE WHEN e.type = 'tool_call' AND json_extract(e.payload,'$.name') = 'Bash' THEN 1 ELSE 0 END) AS shell,
         SUM(CASE WHEN e.type = 'tool_call' AND json_extract(e.payload,'$.name') LIKE 'mcp__%' THEN 1 ELSE 0 END) AS indexCalls
    FROM run_events e JOIN runs r ON r.id = e.run_id JOIN items t ON t.id = r.item_id
   WHERE 1 = 1 REPLACED_WHERE
   GROUP BY r.id
   ORDER BY t.key, r.attempt`;

function reportRecorded(database: DatabaseSync, where: string, parameters: string[]): never {
  const rows = database
    .prepare(RECORDED_INTERCEPTIONS.replace("REPLACED_WHERE", where))
    .all(...parameters) as {
      item: string;
      action: string;
      run: string;
      interceptions: number;
      nudgedCalls: number;
      joined: number;
      shell: number;
      indexCalls: number;
    }[];

  console.log(`\n${dbPath}`);
  console.log("\nWhat actually fired, per run — an interception is a run_events row since EO-168");
  if (rows.length === 0) console.log("  (no runs matched)");
  for (const row of rows) {
    // Said in words rather than left as three numbers, because the
    // reading is the point and a table of counts is what got read wrong
    // twice already.
    const verdict =
      row.interceptions === 0
        ? row.shell === 0
          ? "no shell calls to intercept"
          : "NEVER FIRED — wiring, not persuasion"
        : row.indexCalls === 0
          ? "FIRED AND IGNORED — persuasion, not wiring"
          : "fired, and the index was used";
    console.log(
      `  ${row.item.padEnd(8)} ${row.action.padEnd(10)} ${String(row.interceptions).padStart(3)} intercepted · ` +
        `${String(row.shell).padStart(3)} shell · ${String(row.indexCalls).padStart(3)} index — ${verdict}`,
    );
    // Every firing carries the backend's id for the call it fired on, so
    // a run with fewer distinct ids than firings recorded one call twice
    // — an inflated count, and exactly the kind of number that looks
    // like a measurement and is not one. Said only when it happens.
    if (row.nudgedCalls > 0 && row.nudgedCalls !== row.interceptions) {
      const calls = row.nudgedCalls === 1 ? "1 distinct call" : `${row.nudgedCalls} distinct calls`;
      console.log(`     !! ${row.interceptions} firings across only ${calls} — this count is inflated`);
    }
    // And every firing should find the call it fired on. One that does
    // not is either a call the log never recorded or an id that does not
    // match one, and both make the firing unattributable — a number
    // without the thing it is about, which is what this whole feature
    // exists to stop. Silent for rows written before ids were carried,
    // which have no id to join with and are not claiming to.
    if (row.nudgedCalls > 0 && row.joined !== row.interceptions) {
      console.log(`     !! ${row.interceptions - row.joined} of ${row.interceptions} firings join to no recorded call`);
    }
  }
  console.log("");
  process.exit(0);
}

/**
 * Commands that look like a search but were not intercepted.
 *
 * Reported rather than counted, because "how many did it miss" is not a
 * number anybody can act on — the question is always *which*, and
 * whether each of them is a miss or a command that was right to leave
 * alone. Most are the second: a search already pointed at a directory,
 * or a search for prose no index of declarations holds.
 */
const LOOKS_LIKE_SEARCHING = /\b(?:grep|egrep|rg|ag|ack|find|fd|ls)\b/;

const db = new DatabaseSync(dbPath, { readOnly: true });
// Bound parameters rather than interpolation, even for a read-only
// reporting script run by hand: the day somebody passes an item key
// from anywhere but their own keyboard, the habit is already right.
const parameters = all ? [] : items.length > 0 ? items : DEFAULT_ITEMS;
const where = parameters.length === 0 ? "" : `AND t.key IN (${parameters.map(() => "?").join(",")})`;

// The recorded mode leaves here — it reads the firings themselves and
// has nothing to replay.
if (argv.includes("--recorded")) reportRecorded(db, where, parameters);

const rows = db
  .prepare(
    `SELECT t.key AS item, r.action AS action, json_extract(e.payload,'$.name') AS name, json_extract(e.payload,'$.args') AS args
       FROM run_events e JOIN runs r ON r.id = e.run_id JOIN items t ON t.id = r.item_id
      WHERE e.type = 'tool_call' ${where}
      ORDER BY t.key, e.seq`,
  )
  .all(...parameters) as { item: string; action: string; name: string | null; args: string | null }[];

const commandOf = (args: string | null): string => {
  try {
    return String((JSON.parse(args ?? "{}") as { command?: unknown }).command ?? "");
  } catch {
    return "";
  }
};

const clip = (text: string): string => (text.length > 120 ? `${text.slice(0, 117)}…` : text).replace(/\s+/g, " ");

let shell = 0;
const fired: string[] = [];
const quiet: string[] = [];

for (const row of rows) {
  if (row.name !== "Bash") continue;
  shell++;
  const command = commandOf(row.args);
  const search = broadSearchInCommand(command);
  if (search !== null) fired.push(`${row.item} ${row.action.padEnd(10)} [${search.kind}] ${clip(command)}`);
  else if (LOOKS_LIKE_SEARCHING.test(command)) quiet.push(`${row.item} ${row.action.padEnd(10)} ${clip(command)}`);
}

console.log(`\n${dbPath}`);
console.log(`\n${shell} shell calls, ${fired.length} of them interrupted (${shell === 0 ? 0 : Math.round((fired.length / shell) * 100)}%)`);
console.log("\nWhat EO-165 would have answered — read this list, not the number");
for (const line of fired) console.log(`  ${line}`);
console.log(`\nSearch-shaped and left alone (${quiet.length}) — the false-positive budget, spent the other way`);
for (const line of quiet) console.log(`  ${line}`);
console.log("");
