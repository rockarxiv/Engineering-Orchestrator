#!/usr/bin/env node
// Was the index's answer good enough to act on? (EO-164)
//
// EO-164 offered "the response is half noise" as a reason agents query
// the index once and then go back to grep, and asked for it to be either
// fixed or ruled out with evidence. This is the evidence.
//
// It replays every `mcp__repo__` call recorded in `run_events` against
// **the same index that run was given** — EO keeps one per item
// worktree, and they survive the run — and scores each answer against
// something the same run recorded independently: the files it went on to
// edit. A response that named the files an agent then changed was good
// enough to act on, whatever else was in it. One that did not was not.
//
// It also reports what `trimRepositoryResponses.mjs` would have removed,
// so the size of the noise and its effect on the answer can be read off
// the same line.
//
//   node scripts/index-answer-quality.mjs
//   node scripts/index-answer-quality.mjs path/to/eo.db
//
// Read-only against the database, and read-only against the indexes —
// the server is started with `--no-watch`, exactly as EO starts it.

import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { trim } from "./trimRepositoryResponses.mjs";

const dbPath = process.argv.find((a) => a.endsWith(".db")) ?? join(homedir(), ".config", "EO", "eo.db");
const codewiki = join(homedir(), ".config", "EO", "repositoryIntelligence", "codewiki@0.2.1", "codewiki");
if (!existsSync(dbPath)) {
  console.error(`No database at ${dbPath}.`);
  process.exit(1);
}
const db = new DatabaseSync(dbPath, { readOnly: true });
const rows = (sql, ...args) => db.prepare(sql).all(...args);

/** One MCP session against one worktree's index, for as many calls as we have for it. */
async function ask(workspacePath, calls) {
  const child = spawn(codewiki, ["serve", "--mcp", "--path", workspacePath, "--no-watch"], { stdio: ["pipe", "pipe", "ignore"] });
  const pending = new Map();
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      const resolve = pending.get(message.id);
      if (resolve) (pending.delete(message.id), resolve(message));
    }
  });
  let id = 0;
  const send = (method, params) =>
    new Promise((resolve) => {
      const mine = ++id;
      pending.set(mine, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: mine, method, params }) + "\n");
    });

  await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "eo164", version: "1" } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const answers = [];
  for (const call of calls) {
    const reply = await send("tools/call", { name: call.tool, arguments: call.args });
    answers.push((reply.result?.content ?? []).map((part) => part.text ?? "").join("\n"));
  }
  child.kill();
  return answers;
}

/** Repo-relative source paths a response names. */
const named = (text) => new Set([...text.matchAll(/`?((?:apps|packages|scripts)\/[\w./-]+\.\w+)/g)].map((m) => m[1]));

const calls = rows(`
  SELECT t.key AS item, r.id AS run_id, r.action AS action, r.cwd AS worktree, e.seq AS seq,
         json_extract(e.payload, '$.name') AS name, json_extract(e.payload, '$.args') AS args
  FROM run_events e JOIN runs r ON r.id = e.run_id JOIN items t ON t.id = r.item_id
  WHERE e.type = 'tool_call' AND json_extract(e.payload, '$.name') LIKE 'mcp__repo__%'
  ORDER BY t.key, e.seq`);

console.log(`\n${dbPath}\n`);
console.log("Every recorded index call, replayed against the index that answered it.");
console.log("`hit` is a file the answer named that the same run then edited.\n");

const byWorktree = new Map();
for (const call of calls) {
  const list = byWorktree.get(call.worktree) ?? [];
  list.push(call);
  byWorktree.set(call.worktree, list);
}

let scored = 0;
let withHits = 0;
for (const [worktree, group] of byWorktree) {
  if (worktree === null || !existsSync(join(worktree, ".codewiki", "codewiki.db"))) {
    for (const call of group) console.log(`  ${call.item} ${call.action.padEnd(10)} ${call.name.replace("mcp__repo__codewiki_", "").padEnd(9)} — index gone, cannot replay`);
    continue;
  }
  const answers = await ask(worktree, group.map((call) => ({ tool: call.name.replace("mcp__repo__", ""), args: JSON.parse(call.args ?? "{}") })));
  for (const [index, call] of group.entries()) {
    const answer = answers[index] ?? "";
    // What the run went on to change, from its own `file_edit` events —
    // recorded by EO, not inferred from anything this script did.
    const edited = new Set(
      rows(`SELECT json_extract(payload, '$.path') AS path FROM run_events WHERE run_id = ? AND type = 'file_edit'`, call.run_id)
        .map((row) => String(row.path ?? "").replace(`${worktree}/`, ""))
        .filter(Boolean),
    );
    // The fairer ground truth, and the one the headline uses. An
    // orienting call is not trying to name the file that will be edited
    // — it is trying to say where to look — so scoring it only on edits
    // marks a correct answer wrong. This is every repo path the run
    // mentioned in a shell command *after* the call: where the answer
    // actually sent it.
    const visited = new Set(
      rows(
        `SELECT json_extract(payload, '$.args.command') AS command FROM run_events
          WHERE run_id = ? AND type = 'tool_call' AND seq > ? AND json_extract(payload, '$.name') = 'Bash'`,
        call.run_id, call.seq,
      ).flatMap((row) => [...String(row.command ?? "").matchAll(/((?:apps|packages|scripts)\/[\w./-]+\.\w+)/g)].map((m) => m[1])),
    );
    const mentioned = named(answer);
    const hits = [...edited].filter((file) => mentioned.has(file));
    const trimmed = trim(answer);
    const removed = answer.length === 0 ? 0 : Math.round(100 - (100 * trimmed.length) / answer.length);
    const went = [...visited].filter((file) => mentioned.has(file));
    const trimmedWent = [...visited].filter((file) => named(trimmed).has(file));
    scored++;
    if (went.length > 0) withHits++;
    console.log(
      `  ${call.item} ${call.action.padEnd(10)} ${call.name.replace("mcp__repo__codewiki_", "").padEnd(9)} ` +
        `${String(answer.length).padStart(5)} chars  ${String(mentioned.size).padStart(2)} named  ` +
        `${String(went.length).padStart(2)}/${String(mentioned.size).padStart(2)} then visited  ` +
        `${String(hits.length).padStart(2)}/${String(edited.size).padStart(2)} then edited  ` +
        `trim −${String(removed).padStart(2)}% → ${trimmedWent.length} visited`,
    );
  }
}

console.log(`\n  ${withHits} of ${scored} replayed answers named at least one file the same run then opened.`);
console.log("  The `trim` columns are the same answer with the material EO-164 calls noise removed.\n");
