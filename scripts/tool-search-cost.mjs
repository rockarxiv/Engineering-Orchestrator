#!/usr/bin/env node
// What reaching EO's own MCP tools costs a run (EO-161).
//
// EO-160 established that agents were told the repository tools were in
// their tool list and they were not — they are deferred, and reaching
// one costs a `ToolSearch` call first. EO-161 asked the question
// underneath it: is that round-trip worth removing? This is where the
// answer stopped being a guess.
//
// It reads a real `run_events` and counts, per provider: how many runs
// paid the toll, how many calls it took, where in the run it happened,
// and how often EO's own tools were reached at all. Every number in
// `providers/claude.ts` and `providers/codex.ts` about this came from
// here, so re-running it is how they get checked rather than trusted.
//
//   node scripts/tool-search-cost.mjs                 # the installed app's database
//   node scripts/tool-search-cost.mjs path/to/eo.db
//
// Read-only, and through `node:sqlite` rather than `better-sqlite3` —
// the native module has exactly one import site (ARCHITECTURE.md, "SQLite, and nothing more") and a
// reporting script is not it.
//
// One reading is deliberately absent: the tokens a single round-trip
// spends. `run_events` records one session-cumulative `usage` per run,
// so there is no per-turn delta in it to difference. What it does
// support is the shape of the cost — an extra assistant turn, taken
// while the context is at its smallest — and the per-turn median below
// is the honest upper bound on it rather than the figure itself.

import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const path = process.argv[2] ?? join(homedir(), ".config", "EO", "eo.db");
if (!existsSync(path)) {
  console.error(`No database at ${path}. Pass one as the first argument.`);
  process.exit(1);
}

const db = new DatabaseSync(path, { readOnly: true });
const rows = (sql, ...args) => db.prepare(sql).all(...args);

// A query that loads EO's own tools. The prefixes are the spelling the
// harness takes; the bare words catch the agents that searched by
// keyword instead of selecting by name, which is the same toll paid less
// efficiently.
const LOADS_OUR_TOOLS = `(query LIKE '%mcp__eo__%' OR query LIKE '%mcp__repo__%' OR query LIKE '%comment%' OR query LIKE '%ticket%')`;

const CALLS = `
  SELECT e.run_id AS run_id,
         e.seq AS seq,
         r.provider AS provider,
         json_extract(e.payload, '$.name') AS name,
         json_extract(e.payload, '$.args.query') AS query,
         ROW_NUMBER() OVER (PARTITION BY e.run_id ORDER BY e.seq) AS rank
  FROM run_events e JOIN runs r ON r.id = e.run_id
  WHERE e.type = 'tool_call'`;

// The tools EO's own server offers, as they are recorded: the Claude
// adapter strips the `mcp__eo__` prefix before an event is written
// (`normaliseToolName`), so this is the name both providers land on.
const OUR_TOOLS = "'ticket_detail','comment_search','comment_read','attachment_read','comment','thread_read','pipeline_list','pipeline_read','agents_list','agent_read','runtimes_list'";

console.log(`\n${path}\n`);

console.log("Runs, and how many reached EO's own tools at all");
for (const row of rows(`
  SELECT r.provider AS provider,
         COUNT(*) AS runs,
         (SELECT COUNT(DISTINCT c.run_id) FROM (${CALLS}) c
           WHERE c.provider = r.provider AND (c.name IN (${OUR_TOOLS}) OR c.name LIKE 'mcp__repo__%')) AS reached
  FROM runs r WHERE r.provider IS NOT NULL AND r.provider <> '' GROUP BY 1 ORDER BY 2 DESC`)) {
  console.log(`  ${row.provider.padEnd(8)} ${String(row.runs).padStart(5)} runs   ${String(row.reached).padStart(4)} reached them`);
}

console.log("\nThe toll: ToolSearch calls that load EO's own tools");
const toll = rows(`
  SELECT provider, COUNT(*) AS calls, COUNT(DISTINCT run_id) AS runs
  FROM (${CALLS}) WHERE name = 'ToolSearch' AND ${LOADS_OUR_TOOLS} GROUP BY 1 ORDER BY 2 DESC`);
if (toll.length === 0) console.log("  none");
for (const row of toll) console.log(`  ${row.provider.padEnd(8)} ${String(row.calls).padStart(5)} calls across ${row.runs} runs`);

console.log("\n  ...and ToolSearch calls that loaded something else");
for (const row of rows(`
  SELECT provider, COUNT(*) AS calls, COUNT(DISTINCT run_id) AS runs
  FROM (${CALLS}) WHERE name = 'ToolSearch' AND NOT ${LOADS_OUR_TOOLS} GROUP BY 1 ORDER BY 2 DESC`)) {
  console.log(`  ${row.provider.padEnd(8)} ${String(row.calls).padStart(5)} calls across ${row.runs} runs`);
}

console.log("\nWhere in the run the toll was paid (rank among that run's tool calls)");
for (const row of rows(`
  SELECT rank, COUNT(*) AS calls FROM (${CALLS})
  WHERE name = 'ToolSearch' AND ${LOADS_OUR_TOOLS} GROUP BY 1 ORDER BY 1 LIMIT 6`)) {
  console.log(`  #${String(row.rank).padEnd(3)} ${row.calls}`);
}

console.log("\nEO's own tools, as actually called");
for (const row of rows(`
  SELECT provider, name, COUNT(*) AS calls, COUNT(DISTINCT run_id) AS runs FROM (${CALLS})
  WHERE name IN (${OUR_TOOLS}) OR name LIKE 'mcp__repo__%' GROUP BY 1, 2 ORDER BY 1, 3 DESC`)) {
  console.log(`  ${row.provider.padEnd(8)} ${row.name.padEnd(28)} ${String(row.calls).padStart(5)} calls in ${row.runs} runs`);
}

// The number the whole story turns on. A toll of one call is cheap; a
// tool nothing has ever reached is not, and these two lines are what
// tells them apart.
console.log("\nFor scale");
for (const row of rows(`
  SELECT name, COUNT(*) AS calls FROM (${CALLS})
  WHERE name = 'Bash' OR name LIKE 'mcp__repo__%' GROUP BY 1 ORDER BY 2 DESC`)) {
  console.log(`  ${row.name.padEnd(28)} ${String(row.calls).padStart(6)} calls`);
}

// The shape of what an extra turn costs. Session-cumulative, so this is
// a per-run average spread over its turns rather than a measured turn —
// and an upper bound on the toll, which is paid at the start of a run
// where the context is smallest.
console.log("\nWhat a turn costs, as an upper bound on one round-trip");
const perTurn = rows(`
  SELECT r.provider AS provider,
         json_extract(e.payload, '$.tokensIn') AS tokens_in,
         json_extract(e.payload, '$.turns') AS turns
  FROM run_events e JOIN runs r ON r.id = e.run_id
  WHERE e.type = 'usage' AND json_extract(e.payload, '$.turns') > 0 AND json_extract(e.payload, '$.tokensIn') > 0`);
const grouped = new Map();
for (const row of perTurn) {
  const list = grouped.get(row.provider) ?? [];
  list.push(row.tokens_in / row.turns);
  grouped.set(row.provider, list);
}
for (const [provider, list] of grouped) {
  list.sort((a, b) => a - b);
  const median = list[Math.floor(list.length / 2)];
  console.log(`  ${provider.padEnd(8)} median ${Math.round(median).toLocaleString()} input tokens per turn (n=${list.length} runs)`);
}
console.log("");
