#!/usr/bin/env node
// What the repository index actually removes from a run (EO-164).
//
// EO-161 got the index into agents' tool lists. EO-162 then made one
// `codewiki_context` call and 176 Bash calls, and this is the script
// that stopped that being an anecdote. It counts, per run, the thing the
// feature exists to remove: **shell calls that ask the repository a
// question the index answers** — a recursive grep for a symbol, a find
// by filename, a ripgrep across `apps` and `packages`.
//
// The count to watch is not how often the index was called. A prompt
// can inflate that without removing a single grep, which is precisely
// the measurement EO-164 was told not to produce. What it reports
// instead is `repo-search` calls, and where in the run they stop.
//
//   node scripts/index-adoption.mjs                     # the installed app's database
//   node scripts/index-adoption.mjs path/to/eo.db
//   node scripts/index-adoption.mjs --runs EO-159,EO-162
//   node scripts/index-adoption.mjs --trial out/trial-*.json
//
// `--trial` censuses a transcript from `index-adoption-trial.mjs`
// through this same classifier, so an arm of that experiment and a real
// dispatch are counted by one piece of code rather than two that agree
// by inspection.
//
// Read-only, and through `node:sqlite` rather than `better-sqlite3` —
// the native module has exactly one import site (ARCHITECTURE.md, "SQLite, and nothing more") and a
// reporting script is not it.

import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A shell command that asks the repository where something is.
 *
 * Deliberately narrow. `cat file`, `sed -n 1,80p file` and `git log` are
 * *not* counted: an agent that already knows the file and reads it is
 * doing the thing the index is supposed to lead it to, and counting
 * those would make a successful run look like a failing one. What is
 * counted is the search — a name, matched across a tree, because the
 * agent does not yet know where it lives.
 *
 * The three shapes, and why each is here:
 *  - `grep -r` / `grep --include` / `rg` over a directory: the symbol hunt.
 *  - `find … -name/-iname/-path`: the file hunt.
 *  - `ls -R` / `find` with no predicate over a source tree: the layout hunt.
 */
const REPO_SEARCH = [
  // A grep that was told to walk a tree: `-r` anywhere in a flag bundle
  // (`-rn`, `-rni`, `-rln` are all the same call), or `--include` /
  // `--exclude-dir`, which only mean anything on a recursive one.
  /\b(?:grep|egrep|fgrep)\b[^|;&]*(?:\s-[a-zA-Z]*[rR][a-zA-Z]*(?=\s|$)|\s--(?:recursive|include|exclude-dir)\b)/,
  // Recursive by construction — there is no non-searching spelling.
  /\b(?:rg|ag|ack)\b/,
  /\bfind\b[^|;&]*\s-(?:i?name|i?path|regex)\b/,
  /\bls\b\s+-[a-zA-Z]*R/,
];

/**
 * The pattern a repo-search was searching for, if it can be read off the
 * command. Quoted first argument, near enough — enough to tell an
 * identifier from a sentence, which is the only distinction drawn here.
 */
function needle(command) {
  const quoted = /(?:grep|egrep|rg|ag|ack)\b[^|;&]*?(?:["']([^"']{2,})["']|\s([A-Za-z_$][\w$]{2,})(?=\s))/.exec(command);
  return quoted?.[1] ?? quoted?.[2] ?? null;
}

/**
 * Could a **symbol** index have answered this search?
 *
 * The distinction the whole feature rests on and which EO-164 did not
 * draw. CodeWiki indexes declarations: names, signatures, docstrings,
 * and the edges between them. It does not index prose, string literals,
 * comments or CSS class names. So a grep for `DEFAULT_MODULE_TIMEOUT_MS`
 * is a query the index answers exactly, and a grep for
 * `"every agent has always had"` is one it cannot answer at all — and
 * counting both as "exploration the index should have removed" sets a
 * target no index can hit.
 *
 * An alternation of identifiers (`foo\|bar`) counts: that is one
 * question about several names, which is what `search` takes.
 */
export function symbolSearchable(command) {
  const found = needle(command);
  if (found === null) return false;
  const alternatives = found.split(/\\?\||\\s*,\\s*/).map((part) => part.trim()).filter(Boolean);
  if (alternatives.length === 0) return false;
  return alternatives.every((part) => /^[A-Za-z_$][\w$]*\(?$/.test(part));
}

/** Tools that are a repo search by their nature, whatever the arguments say. */
const SEARCH_TOOLS = new Set(["Grep", "Glob"]);

/**
 * Is this tool call the agent asking where something is?
 *
 * `Bash` is classified on its command text; a compound command counts
 * once, because it cost one turn and one round trip whatever it chained.
 */
export function isRepoSearch(name, args) {
  if (SEARCH_TOOLS.has(name)) return true;
  if (name !== "Bash") return false;
  const command = typeof args?.command === "string" ? args.command : "";
  return REPO_SEARCH.some((pattern) => pattern.test(command));
}

const isIndexCall = (name) => name.startsWith("mcp__repo__") || name.startsWith("codewiki_");

/** The tidy spellings of "change a file". */
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/**
 * A shell command that writes a file.
 *
 * Here rather than in the harness, and deliberately broad, because the
 * first round of this trial recorded three runs as never having edited
 * when all three had — one through `perl -0pi`, one through a `python3`
 * heredoc, one through `sed -i`. An agent picks whichever spelling suits
 * it, and a measurement that only recognises `Edit` measures tidiness
 * rather than progress. `run_events` does not need this: EO's providers
 * emit `file_edit` for the tool calls, and that is used in preference
 * wherever it exists.
 */
const SHELL_EDIT = [
  /\bsed\b[^|;&]*\s-[a-zA-Z]*i/,                       // sed -i, sed -ri
  /\bperl\b[^|;&]*\s-[a-zA-Z0-9]*i[a-zA-Z0-9]*\s/,           // perl -pi -e, perl -0pi -e
  /\b(?:cat|tee|printf|echo)\b[^|;&]*>\s*\S*\.\w+/,     // cat > file.ts, echo >> file.md
  /\bopen\([^)]*["'][wa]/,                             // python: open(p, "w")
  /\.write_text\(|writeFileSync\(|\bTee-Object\b/,     // pathlib / node / pwsh
  /\bapply_patch\b|\bgit\s+apply\b|\bpatch\s+-p/,    // patch application
  /\bmv\b[^|;&]*\s\S*\.\w+\s|\brm\b\s+[^|;&]*\.\w+/, // moves and deletes are changes too
];

export function isEdit(call) {
  if (EDIT_TOOLS.has(call.name)) return true;
  if (call.name !== "Bash") return false;
  const command = typeof call.args?.command === "string" ? call.args.command : "";
  return SHELL_EDIT.some((pattern) => pattern.test(command));
}

/** The number of tool calls a run made before it first changed a file, or null if it never did. */
export function firstEditRankOf(calls) {
  const index = calls.findIndex((call) => isEdit(call));
  return index === -1 ? null : index;
}

/**
 * The census of one run, from its ordered tool calls and the rank at
 * which it first changed a file.
 *
 * `opening` is the number the story turns on: repo-searches made *before
 * the first edit*, which is the orienting sequence — an agent that knows
 * where it is going edits early and searches little. A run that never
 * edits (a review, a read-only trial) has its whole length as its
 * opening, which is correct rather than a fallback: nothing in it was
 * anything but looking.
 */
export function census(calls, firstEditRank) {
  const opening = firstEditRank ?? calls.length;
  const byTool = new Map();
  let searches = 0;
  let openingSearches = 0;
  let openingSymbolSearches = 0;
  let lastSearchRank = 0;
  const indexCalls = [];
  for (const [index, call] of calls.entries()) {
    const rank = index + 1;
    byTool.set(call.name, (byTool.get(call.name) ?? 0) + 1);
    if (isIndexCall(call.name)) indexCalls.push({ rank, name: call.name });
    if (!isRepoSearch(call.name, call.args)) continue;
    searches++;
    lastSearchRank = rank;
    if (rank > opening) continue;
    openingSearches++;
    if (call.name === "Bash" && symbolSearchable(String(call.args?.command ?? ""))) openingSymbolSearches++;
  }
  return { total: calls.length, byTool, searches, openingSearches, openingSymbolSearches, opening, lastSearchRank, indexCalls };
}

function report(label, result) {
  const tools = [...result.byTool].sort((a, b) => b[1] - a[1]).map(([name, n]) => `${name}×${n}`).join("  ");
  console.log(`\n${label}`);
  console.log(`  ${String(result.total).padStart(4)} tool calls, first edit at #${result.opening === result.total ? "—" : result.opening}`);
  console.log(`  ${String(result.openingSearches).padStart(4)} repo-searches before the first edit   (${result.searches} across the whole run, last at #${result.lastSearchRank || "—"})`);
  console.log(`  ${String(result.openingSymbolSearches).padStart(4)}   of those asked for a symbol name — the only ones an index could have answered`);
  console.log(`  ${String(result.indexCalls.length).padStart(4)} index calls${result.indexCalls.length ? ": " + result.indexCalls.map((c) => `#${c.rank} ${c.name.replace(/^mcp__repo__/, "")}`).join(", ") : ""}`);
  if (tools) console.log(`       ${tools}`);
}

/**
 * The report, run only when this file is the program.
 *
 * Guarded because `index-adoption-trial.mjs` imports `isEdit` from here
 * so that an arm stops on exactly what the census will later count as
 * its first edit — and an unguarded module body would print a full
 * database report every time a trial started.
 */
function main() {
  // --- trial transcripts -----------------------------------------------

  const trialPaths = process.argv.slice(2).filter((a) => a.endsWith(".json"));
  if (process.argv.includes("--trial") || trialPaths.length > 0) {
    for (const path of trialPaths) {
      const trial = JSON.parse(readFileSync(path, "utf8"));
      for (const run of trial.runs) {
        // Recomputed rather than trusted: the harness stops at the first
        // edit *it* recognised, and this classifier has since learned
        // spellings it had not. Re-censusing a recorded transcript is
        // free; re-running an arm is not.
        report(`${trial.arm ?? "?"} · ${run.id}`, census(run.calls, firstEditRankOf(run.calls)));
      }
    }
    console.log("");
    process.exit(0);
  }

  // --- run_events ------------------------------------------------------

  const dbPath = process.argv.find((a) => a.endsWith(".db")) ?? join(homedir(), ".config", "EO", "eo.db");
  if (!existsSync(dbPath)) {
    console.error(`No database at ${dbPath}. Pass one as the first argument.`);
    process.exit(1);
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const rows = (sql, ...args) => db.prepare(sql).all(...args);

  const only = (() => {
    const flag = process.argv.indexOf("--runs");
    return flag === -1 ? null : new Set((process.argv[flag + 1] ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  })();

  console.log(`\n${dbPath}`);

  // The whole-database picture first: which of the nine tools has ever
  // been reached, and by whom. EO-164 opened with eight of nine at zero.
  console.log("\nEvery index call in the database, by tool and by the step that made it");
  const everCalled = rows(`
    SELECT t.key AS item, r.action AS action,
           json_extract(e.payload, '$.name') AS name, COUNT(*) AS calls
    FROM run_events e JOIN runs r ON r.id = e.run_id JOIN items t ON t.id = r.item_id
    WHERE e.type = 'tool_call' AND json_extract(e.payload, '$.name') LIKE 'mcp__repo__%'
    GROUP BY 1, 2, 3 ORDER BY t.key, r.action`);
  if (everCalled.length === 0) console.log("  none");
  for (const row of everCalled) {
    console.log(`  ${row.item.padEnd(8)} ${String(row.action).padEnd(10)} ${row.name.replace("mcp__repo__", "").padEnd(20)} ${row.calls}`);
  }

  console.log("\nThe nine tools, and how often each has been reached");
  for (const tool of ["search", "context", "callers", "callees", "impact", "node", "explore", "status", "files"]) {
    const calls = everCalled.filter((r) => r.name.endsWith(`_${tool}`)).reduce((n, r) => n + r.calls, 0);
    console.log(`  codewiki_${tool.padEnd(10)} ${calls === 0 ? "never called" : `${calls} call${calls === 1 ? "" : "s"}`}`);
  }

  // Per-run censuses. Agent runs only: a builtin has no tool calls and
  // would pad the table with zeroes.
  console.log("\nPer-run census — the opening is what EO-164 is measured on");
  const runs = rows(`
    SELECT r.id AS id, t.key AS item, r.action AS action, r.turns AS turns
    FROM runs r JOIN items t ON t.id = r.item_id
    WHERE EXISTS (SELECT 1 FROM run_events e WHERE e.run_id = r.id AND e.type = 'tool_call')
    ORDER BY r.started_at`);
  for (const run of runs) {
    if (only && !only.has(run.item) && !only.has(run.id)) continue;
    const calls = rows(
      `SELECT json_extract(payload, '$.name') AS name, json_extract(payload, '$.args') AS args
         FROM run_events WHERE run_id = ? AND type = 'tool_call' ORDER BY seq`, run.id,
    ).map((r) => ({ name: r.name ?? "", args: r.args ? JSON.parse(r.args) : {} }));

    // The first edit, located among the tool calls rather than among all
    // events: `file_edit` and `tool_call` share one `seq` sequence, so the
    // rank is how many tool calls preceded it.
    const firstEdit = rows(
      `SELECT (SELECT COUNT(*) FROM run_events c WHERE c.run_id = e.run_id AND c.type = 'tool_call' AND c.seq < e.seq) AS rank
         FROM run_events e WHERE e.run_id = ? AND e.type = 'file_edit' ORDER BY e.seq LIMIT 1`, run.id)[0]?.rank;

    report(`${run.item} · ${run.action} · ${run.id}`, census(calls, firstEdit ?? null));
  }
  console.log("");
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
