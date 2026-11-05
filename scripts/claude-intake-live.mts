#!/usr/bin/env node
// Intake against a real Claude backend (KAN-32).
//
// The bug this exists to close was invisible to every unit test. `intake`
// had no registered schema, so there was nothing to constrain generation
// with; the provider handed back the model's own text, and a model asked
// for JSON writes it inside a ```json fence. Five well-formed questions
// were discarded that way and the item advanced past the agent asking
// them. A fixture cannot reproduce that, because a fixture is written by
// someone who already knows the answer.
//
// So this asks a real model a deliberately under-specified question and
// checks what shape comes back.
//
//   pnpm exec tsx scripts/claude-intake-live.mts
//
// Spends real credit — one dispatch, a few cents. Env: EO_LIVE_MODEL to
// pin a model.

import { homedir } from "node:os";
import { join } from "node:path";
import { createEngine } from "../apps/desktop/src/main/engine.js";
import { openMigratedTestDb } from "../apps/desktop/src/main/db/testHelpers.js";
import { listAgentDetails, saveAgent } from "../apps/desktop/src/main/ipc/configCommands.js";
import { createItem, getItem } from "../apps/desktop/src/main/db/repos/itemsRepo.js";
import { listRunsForItem } from "../apps/desktop/src/main/db/repos/runsRepo.js";
import { listRunEvents } from "../apps/desktop/src/main/db/repos/runEventsRepo.js";
import { listCommentsForItem, postComment } from "../apps/desktop/src/main/db/repos/commentsRepo.js";
import { checkClaudeAuth } from "../apps/desktop/src/main/providers/claude.js";
// Through the package's build output rather than the bare specifier:
// scripts/ is not a workspace member, so it has no `@eo/core` to
// resolve. Every other script reaches into apps/desktop the same way.
import { asClarification, parsedResultOf } from "../packages/core/dist/index.js";

const auth = await checkClaudeAuth(homedir());
if (!auth.ok) {
  console.error(`\n✗ ${auth.reason}\n`);
  process.exit(1);
}

const handle = openMigratedTestDb();
const model = process.env.EO_LIVE_MODEL;
for (const agent of listAgentDetails(handle.db).agents) {
  saveAgent(handle.db, { ...agent, provider: "claude", ...(model ? { model } : {}) });
}

// The installed app keeps its fetched runtimes in Electron's userData,
// not the `~/.eo/runtimes` a bare process defaults to — so a script that
// takes the default reports the SDK missing on a machine that has it.
const runtimeRoot = process.env.EO_RUNTIME_ROOT ?? join(homedir(), ".config", "EO", "runtimes");
const engine = createEngine({ db: handle.db, commentServerPath: "/unused", worktreeRoot: "/unused", runtimeRoot });

// Deliberately thin. The whole point is a feature no agent could
// responsibly decompose without asking something first — which is what
// makes the *asking* path the one that gets exercised.
const feature = createItem(handle.db, { type: "feature", title: "Add rate limiting", state: "intake" });
postComment(handle.db, { itemId: feature.id, author: { type: "human" }, body: "We need rate limiting." });

console.log(`\n--- intake on ${feature.key} ---`);
await engine.runOnce();

const run = listRunsForItem(handle.db, feature.id)[0];
const item = getItem(handle.db, feature.id)!;
const comments = listCommentsForItem(handle.db, feature.id);

// From `run_events`, not `runs.result`. A run that parks on a
// clarification never persists a result, so the column is null on
// exactly the path this script exists to inspect — while the append-only
// stream still holds what the provider actually handed back, which is
// the only place the object-versus-fence question can be answered.
const resultEvent = listRunEvents(handle.db, run!.id).find((event) => event.type === "result");
const raw = (resultEvent?.payload as { data?: unknown } | undefined)?.data ?? parsedResultOf(run?.result ?? null);

console.log(`\n--- what happened (${run?.costCents ?? 0}c) ---`);
console.log(`  run:    ${run?.action} ${run?.status}`);
console.log(`  ticket: ${item.state}`);
if (run?.error) console.log(`  error:  ${run.error}`);
for (const comment of comments) {
  console.log(`  [${comment.authorType}/${comment.kind}${comment.pinned ? " pinned" : ""}] ${comment.body.slice(0, 160).replace(/\n/g, " ")}`);
}
console.log(`\n  raw result (${typeof raw}): ${JSON.stringify(raw).slice(0, 400)}`);

const asked = asClarification(raw);
const answered = (raw as { ready?: boolean } | null)?.ready === true;

// The one that matters. A *string* result is the bug: it means
// generation was unconstrained and the model wrote a fence, and
// everything downstream only worked because of the text fallback.
const structured = typeof raw === "object" && raw !== null;

const checks: [string, boolean][] = [
  ["the result is an object, not fenced text", structured],
  ["it either asked or answered — no third outcome", asked !== null || answered],
  ...(asked
    ? ([
        ["every question carries a why", asked.questions.every((question) => question.why.trim() !== "")],
        ["the questions reached the thread", comments.some((comment) => comment.kind === "question")],
        ["the ticket stayed in intake", item.state === "intake"],
        ["the run parked rather than succeeding", run?.status === "awaiting_input"],
      ] as [string, boolean][])
    : ([
        ["the understanding was pinned", comments.some((comment) => comment.pinned)],
        ["the ticket advanced", item.state === "backlog"],
      ] as [string, boolean][])),
];

console.log(`\n--- checks ---`);
let failed = 0;
for (const [label, ok] of checks) {
  console.log(`  ${ok ? "✓" : "✗"} ${label}`);
  if (!ok) failed += 1;
}

handle.close();
console.log("");
process.exit(failed === 0 ? 0 : 1);
