#!/usr/bin/env node
// Live verification for A-06 — the parts a unit test cannot establish.
//
// Spends real Claude credit, so it is never run by CI or the test suite.
// It exercises the acceptance criteria that need a real agent:
//
//   1. A real session runs against a local repo and streams events
//   2. Structured output round-trips through the A-02 schema
//   3. Real cost lands on the run (not an estimate)
//   4. resume() continues the same session with context intact (E-04)
//   5. The comment tool reaches the agent in-process (A-03, no subprocess)
//
// Usage (tsx, because electron-vite bundles main into a single
// out/main/index.js — there is no per-module build output to import):
//   pnpm exec tsx scripts/claude-smoke.mjs        # a few short turns

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createClaudeProvider, checkClaudeAuth } from "../apps/desktop/src/main/providers/claude.js";

const auth = await checkClaudeAuth(homedir());
if (!auth.ok) {
  console.error(`\n✗ ${auth.reason}\n`);
  process.exit(1);
}

const repo = mkdtempSync(join(tmpdir(), "eo-claude-smoke-"));
const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
git("init", "-b", "main");
git("config", "user.email", "eo@example.com");
git("config", "user.name", "EO Smoke");
git("config", "commit.gpgsign", "false");
writeFileSync(join(repo, "README.md"), "# smoke\n\nThis repository contains exactly one tracked file.\n");
git("add", "-A");
git("commit", "-m", "initial");

const provider = createClaudeProvider({
  onUnmappedMessage: (message) => console.warn("  [unmapped]", message.type),
});

console.log(`\nRepo: ${repo}\n--- turn 1: structured output over a real repo ---`);

const schema = {
  type: "object",
  properties: { file_count: { type: "number" }, summary: { type: "string" } },
  required: ["file_count", "summary"],
  additionalProperties: false,
};

const seen = [];
let threadId = null;
let usage = null;
let structured = null;

for await (const event of provider.start({
  instructions: "You inspect repositories and report what you find. Be brief and do not modify anything.",
  context: "How many files are tracked in this git repository? Answer with the required JSON only.",
  cwd: repo,
  outputSchema: schema,
  signal: new AbortController().signal,
})) {
  seen.push(event.type);
  if (event.type === "thread_started") (threadId = event.threadId), console.log(`  session ${threadId}`);
  if (event.type === "tool_call") console.log(`  tool: ${event.name}`);
  if (event.type === "usage") (usage = event), console.log(`  usage in=${event.tokensIn} out=${event.tokensOut} cost=${event.costCents}c`);
  if (event.type === "result") (structured = event.data), console.log(`  result`, event.data);
  if (event.type === "error") console.error(`  error: ${event.message}`);
}

console.log(`\n--- turn 2: resume the same session (E-04) ---`);
let resumed = null;
// cwd is not optional in practice: the CLI keys sessions by working
// directory and answers "No conversation found" without it.
for await (const event of provider.resume(threadId, "What number did you just report? Reply with only that number.", { cwd: repo })) {
  if (event.type === "result") (resumed = event.data), console.log(`  result`, event.data);
  if (event.type === "error") console.error(`  error: ${event.message}`);
}

console.log(`\n--- turn 3: the comment tool, in-process (A-03) ---`);
let commentCall = null;
for await (const event of provider.start({
  instructions:
    "You are an implementer. When something is ambiguous you must ask rather than guess, using the `comment` tool with blocking set to true.",
  context:
    "Task: rename the greeting in this project. There is no greeting anywhere and the task is ambiguous. " +
    "Use the comment tool to ask @user what they meant. Do not edit any files.",
  cwd: repo,
  signal: new AbortController().signal,
})) {
  if (event.type === "tool_call" && event.name === "comment") {
    commentCall = event.args;
    console.log(`  comment tool called:`, JSON.stringify(event.args).slice(0, 160));
  }
  if (event.type === "error") console.error(`  error: ${event.message}`);
}

rmSync(repo, { recursive: true, force: true });

const checks = [
  ["streams events into the mapped union", seen.includes("thread_started") && seen.includes("result")],
  ["structured output round-trips", structured !== null && typeof structured === "object" && "file_count" in structured],
  ["real cost is reported", usage !== null && usage.costCents !== undefined],
  ["resume continues the same session with context", resumed !== null && String(JSON.stringify(resumed)).includes("1")],
  ["the comment tool reaches the agent in-process", commentCall !== null],
];

console.log("\n--- results ---");
let failed = 0;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? "✓" : "✗"} ${name}`);
  if (!ok) failed++;
}
console.log(`\nEvent types seen: ${[...new Set(seen)].join(", ")}\n`);
process.exit(failed === 0 ? 0 : 1);
