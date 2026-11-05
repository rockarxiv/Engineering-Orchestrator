#!/usr/bin/env node
// The v1 gate, driven by a real Claude backend (A-06).
//
// v1Gate.test.ts proves the assembled engine over a real git repo with
// *scripted* agents. This runs the same shape with real ones: every
// prompt, every schema, every guard and every worktree is production
// code, and the only thing changed is that an actual model is answering.
//
// Spends real credit and takes minutes, so it is never run by CI. It
// exists because every previously-shipped story that looked green in
// unit tests and broke in the real app broke at exactly this seam.
//
//   pnpm exec tsx scripts/claude-live-gate.mts
//
// Env: EO_LIVE_MODEL to pin a model (default: the CLI's own default).

import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createEngine } from "../apps/desktop/src/main/engine.js";
import { openMigratedTestDb } from "../apps/desktop/src/main/db/testHelpers.js";
import { listAgentDetails, saveAgent } from "../apps/desktop/src/main/ipc/configCommands.js";
import { createWorkspace } from "../apps/desktop/src/main/db/repos/workspacesRepo.js";
import { createItem, getItem, listItems } from "../apps/desktop/src/main/db/repos/itemsRepo.js";
import { listRunsForItem } from "../apps/desktop/src/main/db/repos/runsRepo.js";
import { listCommentsForItem, postComment } from "../apps/desktop/src/main/db/repos/commentsRepo.js";
import { listRunEvents } from "../apps/desktop/src/main/db/repos/runEventsRepo.js";
import { checkClaudeAuth } from "../apps/desktop/src/main/providers/claude.js";
import { git } from "../apps/desktop/src/main/packs/developer/workspace/git.js";

const auth = await checkClaudeAuth(homedir());
if (!auth.ok) {
  console.error(`\n✗ ${auth.reason}\n`);
  process.exit(1);
}

const scratch = mkdtempSync(join(tmpdir(), "eo-live-gate-"));
const repoPath = join(scratch, "repo");
const worktreeRoot = join(scratch, "worktrees");

async function run(args: string[], cwd: string): Promise<void> {
  const result = await git(args, cwd);
  if (!result.ok) throw new Error(`git ${args.join(" ")} failed: ${result.error}`);
}

mkdirSync(repoPath, { recursive: true });
await run(["init", "-b", "main"], repoPath);
await run(["config", "user.email", "eo@example.com"], repoPath);
await run(["config", "user.name", "EO Live Gate"], repoPath);
await run(["config", "commit.gpgsign", "false"], repoPath);
writeFileSync(
  join(repoPath, "README.md"),
  "# greeter\n\nA tiny project. `greet.js` prints a greeting.\n",
);
writeFileSync(join(repoPath, "greet.js"), "export function greet(name) {\n  return `Hello, ${name}!`;\n}\n");
await run(["add", "-A"], repoPath);
await run(["commit", "-m", "initial"], repoPath);

const handle = openMigratedTestDb();
createWorkspace(handle.db, { repoPath, baseBranch: "main" });

// Every agent onto the real backend — the same path the settings UI
// takes, so this also exercises the provider being editable at all.
const model = process.env.EO_LIVE_MODEL;
for (const agent of listAgentDetails(handle.db).agents) {
  saveAgent(handle.db, { ...agent, provider: "claude", ...(model ? { model } : {}) });
}
console.log(`Repo:      ${repoPath}`);
console.log(`Agents:    ${listAgentDetails(handle.db).agents.map((a) => `${a.role}=${a.provider}`).join(" ")}`);

const engine = createEngine({ db: handle.db, commentServerPath: "/unused", worktreeRoot });

const story = createItem(handle.db, {
  type: "story",
  title: "Add an exclamation option to greet()",
  state: "todo",
  body:
    "`greet(name)` in greet.js always ends with '!'. Add a second parameter `excited` " +
    "(default true); when false, end the greeting with '.' instead. Keep the existing " +
    "behaviour for existing callers.",
});
postComment(handle.db, { itemId: story.id, author: { type: "human" }, body: "No new dependencies please." });

/** Ticks until nothing changes, printing what moved. Real runs are slow, so progress is visible. */
async function settle(maxTicks = 12): Promise<void> {
  let previous = "";
  for (let i = 0; i < maxTicks; i++) {
    await engine.runOnce();
    const snapshot = listItems(handle.db)
      .map((item) => `${item.key}:${item.state}:${listRunsForItem(handle.db, item.id).length}`)
      .join("|");
    if (snapshot !== previous) console.log(`  tick ${i + 1}: ${snapshot}`);
    if (snapshot === previous) return;
    previous = snapshot;
  }
  console.log(`  (stopped after ${maxTicks} ticks)`);
}

console.log(`\n--- running the loop ---`);
const startedAt = Date.now();
await settle();
const elapsed = Math.round((Date.now() - startedAt) / 1000);

const finished = getItem(handle.db, story.id)!;
const runs = listRunsForItem(handle.db, story.id);
// The *last* implement run: G-02 rejecting a first attempt and the
// agent fixing it is the loop working, not the loop failing.
const implementRuns = runs.filter((entry) => entry.action === "implement");
const implement = implementRuns.at(-1);
const review = runs.find((entry) => entry.action === "review");
const spentCents = runs.reduce((total, entry) => total + (entry.costCents ?? 0), 0);

console.log(`\n--- what happened (${elapsed}s, ${spentCents}c) ---`);
for (const entry of runs) {
  console.log(`  ${entry.action.padEnd(10)} ${entry.status.padEnd(15)} ${entry.costCents ?? 0}c  events=${listRunEvents(handle.db, entry.id).length}`);
  if (entry.error) console.log(`    error: ${entry.error}`);
}
console.log(`  ticket state: ${finished.state}`);
for (const comment of listCommentsForItem(handle.db, story.id)) {
  console.log(`  [${comment.authorType}${comment.kind ? `/${comment.kind}` : ""}] ${comment.body.slice(0, 140).replace(/\n/g, " ")}`);
}

const branch = await git(["rev-list", "--count", `main..eo/${finished.key}`], repoPath);
const diff = await git(["diff", "main", `eo/${finished.key}`, "--stat"], repoPath);
if (diff.ok) console.log(`\n  diff:\n${diff.stdout.split("\n").map((line) => `    ${line}`).join("\n")}`);

const checks: [string, boolean][] = [
  ["the implement run succeeded", implement?.status === "succeeded"],
  // Not required, but when it happens it is the most valuable line in
  // the output: a real agent claimed done without committing and the
  // engine refused to take its word for it (invariant #5).
  ...(implementRuns.length > 1
    ? ([["G-02 rejected an unverified claim and the agent retried", implementRuns[0]?.status === "failed"]] as [string, boolean][])
    : []),
  ["real cost landed on the run", (implement?.costCents ?? 0) > 0],
  ["run_events recorded the stream", (implement ? listRunEvents(handle.db, implement.id).length : 0) > 0],
  ["a real branch with a real commit exists", branch.ok && Number(branch.stdout) > 0],
  ["G-02 verified the claim independently", (implement?.verification as { ok?: boolean } | null)?.ok === true],
  ["the reviewer ran and reached a verdict", review?.status === "succeeded"],
  ["the ticket reached ready_to_merge", finished.state === "ready_to_merge"],
  // Not "the worktree was released": releaseStaleWorktrees runs from
  // onReconciled, i.e. at startup, so during a session the tree is still
  // there — which is also what lets a human look at the work.
  ["the worktree still holds the work for inspection", readdirSync(worktreeRoot).includes(finished.key)],
];

console.log("\n--- results ---");
let failed = 0;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? "✓" : "✗"} ${name}`);
  if (!ok) failed++;
}

handle.close();
if (failed === 0) rmSync(scratch, { recursive: true, force: true });
else console.log(`\nLeft ${scratch} in place for inspection.`);
process.exit(failed === 0 ? 0 : 1);
