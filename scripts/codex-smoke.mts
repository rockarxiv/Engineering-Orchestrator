#!/usr/bin/env node
// Live verification for A-04 — the parts a unit test cannot establish.
//
// This spends real API credit on your Codex account, so it is never run
// by CI or by the test suite. It exercises the four acceptance criteria
// that need a real agent:
//
//   1. A real session runs against a local repo and streams events
//   2. Structured output round-trips through the schema
//   3. Token usage is reported
//   4. resume() continues the same thread with context intact (E-04)
//
// Usage:
//   codex login                     # once, if you haven't
//   pnpm exec tsx scripts/codex-smoke.mjs    # ~1-2 short turns, cents not dollars
//
// The 5th criterion (the `comment` tool) is deliberately not covered:
// the SDK has no tool-registration API, so it cannot work yet. See the
// note in apps/desktop/src/main/providers/codex.ts.

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createCodexProvider, checkCodexAuth } from "../apps/desktop/src/main/providers/codex.js";

const auth = await checkCodexAuth(homedir());
if (!auth.ok) {
  console.error(`\n✗ ${auth.reason}\n`);
  process.exit(1);
}

// A throwaway repo so the agent has somewhere real to look.
const repo = mkdtempSync(join(tmpdir(), "eo-codex-smoke-"));
const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
git("init", "-b", "main");
git("config", "user.email", "eo@example.com");
git("config", "user.name", "EO Smoke");
writeFileSync(join(repo, "README.md"), "# smoke\n\nThis repository contains exactly one file.\n");
git("add", "-A");
git("commit", "-m", "initial");

const provider = createCodexProvider({
  onUnmappedEvent: (event) => console.warn("  [unmapped]", event.type),
});

const seen = [];
let threadId = null;
let usage = null;
let result = null;

console.log(`\nRepo: ${repo}\n--- turn 1: structured output ---`);

const schema = {
  type: "object",
  properties: { file_count: { type: "number" }, summary: { type: "string" } },
  required: ["file_count", "summary"],
  additionalProperties: false,
};

for await (const event of provider.start({
  instructions: "You inspect repositories and report what you find. Be brief.",
  context: "How many files are tracked in this repository? Answer with the required JSON only.",
  cwd: repo,
  outputSchema: schema,
  signal: new AbortController().signal,
})) {
  seen.push(event.type);
  if (event.type === "thread_started") (threadId = event.threadId), console.log(`  thread ${threadId}`);
  if (event.type === "usage") (usage = event), console.log(`  usage in=${event.tokensIn} out=${event.tokensOut}`);
  if (event.type === "result") (result = event.data), console.log(`  result`, event.data);
  if (event.type === "error") console.error(`  error: ${event.message}`);
}

console.log(`\n--- turn 2: resume the same thread (E-04) ---`);
let resumedText = null;
for await (const event of provider.resume(threadId, "What was the number you just told me? Reply with only that number.")) {
  if (event.type === "result") (resumedText = event.data), console.log(`  result`, event.data);
  if (event.type === "error") console.error(`  error: ${event.message}`);
}

rmSync(repo, { recursive: true, force: true });

const checks = [
  ["streams events into the mapped union", seen.includes("thread_started") && seen.includes("result")],
  ["structured output round-trips", result !== null && typeof result === "object" && "file_count" in result],
  ["token usage is reported", usage !== null && usage.tokensIn > 0],
  ["resume continues the same thread with context", resumedText !== null && String(resumedText).includes("1")],
];

console.log("\n--- results ---");
let failed = 0;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? "✓" : "✗"} ${name}`);
  if (!ok) failed++;
}
console.log(`\nEvent types seen: ${[...new Set(seen)].join(", ")}\n`);
process.exit(failed === 0 ? 0 : 1);
