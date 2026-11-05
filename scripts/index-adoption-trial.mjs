#!/usr/bin/env node
// EO-164: the two candidate causes, run one at a time against a real agent.
//
// EO-164 named two reasons the repository index gets called once and then
// abandoned — that the answer is half noise, and that the prompt says the
// tools exist without saying when to reach for one — and required that
// they be tested separately, because changing both at once produces a
// number nobody can explain. This is the harness that does it.
//
// **Why not measure this on EO's own dispatches.** A prompt edit on a
// branch does not reach a dispatched agent until it is merged and the app
// reloads, so an A/B across real items would cost as many merges as
// arms and would confound each arm with whatever story happened to be
// next. This runs the provider EO dispatches (`providers/claude.ts`),
// with the prompt file EO ships, against a throwaway checkout of this
// branch carrying this branch's index — so the only thing differing
// between arms is the thing under test.
//
// Spends real Claude credit. Never run by CI or the test suite.
//
//   pnpm dlx tsx scripts/index-adoption-trial.mjs --arm baseline -n 3
//   pnpm dlx tsx scripts/index-adoption-trial.mjs --arm trim     -n 3
//   pnpm dlx tsx scripts/index-adoption-trial.mjs --arm habit    -n 3
//   pnpm dlx tsx scripts/index-adoption-trial.mjs --arm hook     -n 3
//
// Each writes `out/index-adoption-<arm>.json`, censused by
//   node scripts/index-adoption.mjs out/index-adoption-*.json
// which is the same classifier that counts `run_events` — so an arm and
// a real dispatch are counted by one piece of code rather than two that
// agree by inspection.
//
//   baseline  the shipped implementer prompt, the index as it answers
//   trim      the shipped prompt, responses through
//             `trimRepositoryResponses.mjs` — candidate cause 1
//   habit     the candidate prompt, responses untouched — candidate cause 2
//   hook      the shipped prompt, the index as it answers, and EO-165's
//             `PreToolUse` interception switched on — RETIRED, see below
//
// The `hook` arm and its control differed in exactly one field. EO-165's
// interception is delivered only when the query server carries the
// provider's own vocabulary (`answers`), so an arm that omits it is a
// run of the same code with the hook absent — no `hooks` option reaches
// the SDK at all. That is why `baseline` is still the control here even
// though the interception now ships: it is the switch the production
// code already reads, not a flag added for the experiment.
//
// **The `hook` arm no longer runs, and had stopped measuring anything
// well before it was switched off (KAN-126).** Two independent reasons,
// and the first is the older:
//
//   1. EO-173 (28 August) made `knows` — a way of asking the index
//      whether it holds the thing — as necessary as `answers`. This
//      script was never updated: its `hook` arm passes `answers` alone,
//      so `searchInterception` has returned `undefined` for it ever
//      since, and the arm has been a second `baseline` wearing a
//      different name. Any run of it after that date reported zero
//      interceptions because none was possible, not because the model
//      ignored them.
//   2. KAN-126 made the classifier something the *composition root*
//      supplies to the adapter rather than something the adapter
//      imports, so that `repositoryIntelligence/` can move into the
//      developer pack. A script is not the composition root, and the
//      acceptance criterion is explicit that nothing outside that
//      directory may import the nudge from it.
//
// Reviving it means taking the nudge from the developer pack's public
// entry point once the pack exists (KAN-144) and passing a `knows`
// beside the `answers` below. Both are that story's to give; inventing
// a local nudge here would measure a sentence production never says,
// which is the mistake the `answers` comment further down already warns
// about. Until then the arm refuses rather than quietly measuring its
// own control — the failure mode it has been in for a fortnight.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createClaudeProvider } from "../apps/desktop/src/main/providers/claude.js";
// The shipping classifier, not a copy of it. This runs under tsx, which
// is what makes importing a TypeScript module from a `.mjs` script work
// — the same resolution that reaches `providers/claude.js` above.
//
// The leaf module rather than `repositoryIntelligence/index.js`, on
// purpose: the barrel re-exports the composition root, which pulls the
// gate, which reads settings out of SQLite — a native module this script
// runs without. `broadSearch.js` imports one type and nothing else.
//
// The census classifier only. The *nudge* is deliberately not imported
// here — see the `hook` arm below (KAN-126).
import { broadSearchInCommand } from "../apps/desktop/src/main/packs/developer/repositoryIntelligence/broadSearch.js";
// One classifier, shared with the census, so an arm stops on exactly what
// the census will later count as its first edit.
import { isEdit } from "./index-adoption.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const arg = (flag, fallback) => {
  const index = process.argv.indexOf(flag);
  return index === -1 ? fallback : process.argv[index + 1];
};

const arm = arg("--arm", "baseline");
// Refused rather than run, and loudly: an arm that cannot register a
// hook produces a transcript indistinguishable from `baseline`, and
// this one has published such a transcript before (see the note on
// `hookDelivered` below, which exists because of it).
if (arm === "hook") {
  console.error(
    "The `hook` arm is retired. It has been unable to register an interception since EO-173\n" +
      "(it passes `answers` without `knows`), and since KAN-126 the search nudge is supplied by\n" +
      "the composition root rather than imported, which a script is not. Reviving it needs the\n" +
      "developer pack's nudge and a `knows` beside the vocabulary — both land in KAN-144.\n" +
      "Running it now would measure `baseline` under another name.",
  );
  process.exit(2);
}
const runs = Number(arg("-n", "3"));
const shipped = join(repoRoot, "apps/desktop/src/main/packs/developer/prompts/implementer.md");
const candidate = join(repoRoot, "scripts/fixtures/implementer-habit.md");
const promptPath = arm === "habit" ? candidate : shipped;

/**
 * The task, and why this one.
 *
 * An implementation story, not a navigation quiz. The first version of
 * this harness asked the agent to *report* where something lived, and the
 * shipped prompt scored almost perfectly on it — because a task phrased
 * as "what calls this" hands the agent the very situation the prompt is
 * supposed to teach it to notice. That measured the question, not the
 * prompt.
 *
 * EO-159 and EO-162 were not navigation quizzes. They were stories with
 * no file paths in them, where finding the code was incidental to
 * changing it, and the exploration EO-164 exists to remove is the part
 * before the first edit. So this is a real, small change described the
 * way a story is described — an outcome, no paths, no symbol names — and
 * the run stops at the first edit, which is where the measurement ends.
 */
const TASK = `When EO finishes building a repository index it does not trust the exit code — it re-reads the index and confirms one is there. A sync already reports how many files it changed, and that number reaches the row EO keeps for the index. A first build reports no such number, so a freshly built index has a blank where a sync leaves a count.

Give a successful first build the same treatment: report how many files were indexed, carry it to the same place the sync's count goes, and cover it with tests.

Take the smaller reading of anything ambiguous and note it in your handoff rather than asking.`;

const codewiki = arg("--codewiki", join(homedir(), ".config", "EO", "repositoryIntelligence", "codewiki@0.2.1", "codewiki"));
if (!existsSync(codewiki)) {
  console.error(`No CodeWiki binary at ${codewiki}. Pass one with --codewiki.`);
  process.exit(1);
}
if (!existsSync(join(repoRoot, ".codewiki", "codewiki.db"))) {
  console.error(`No index at ${join(repoRoot, ".codewiki")}. EO's indexing step builds it; ${codewiki} init && ${codewiki} index does it by hand.`);
  process.exit(1);
}

// The same runtimes the app dispatches with, laid out the way
// `runtimes/resolve.ts` lays them out. Passed explicitly because this
// runs outside Electron, where nothing has read the settings that
// normally supply them.
const runtimeRoot = arg("--runtimes", join(homedir(), ".config", "EO", "runtimes"));
const newest = (prefix) => {
  const chosen = readdirSync(runtimeRoot).filter((name) => name.startsWith(`${prefix}@`)).sort().at(-1);
  if (chosen === undefined) throw new Error(`No ${prefix} runtime under ${runtimeRoot}. EO downloads these; install one from Agents.`);
  return join(runtimeRoot, chosen);
};
/**
 * Every time EO's own `PreToolUse` interception actually answered
 * something (EO-165).
 *
 * Reset per run, and read off the SDK's own `hook_response` messages,
 * which carry the JSON the hook returned. Without this an arm can only
 * show that its numbers moved; with it, an arm shows *that the mechanism
 * fired at all* — which is the difference between measuring EO-165 and
 * measuring the weather, and is the only place a silent regression (a
 * matcher the CLI stops honouring, an option a version bump renames)
 * appears as a zero rather than as a slightly different mean.
 *
 * **By wrapping EO's own callback**, which was the only channel that
 * carried this when this harness was written — EO-168 has since made a
 * firing a `search_interception` event on the provider's stream, and
 * that is the channel a real dispatch is counted on. The wrapper stays
 * anyway, deliberately: it observes the callback itself rather than what
 * the adapter reports about it, so the two are independent and
 * `interception-audit.mts --trial` can refuse a run where they disagree.
 * Two earlier versions got it wrong in two different ways. `onUnmappedMessage` never sees anything: `mapSdkMessage` reports
 * every `system` message as recognised — `init` is mapped and the rest
 * deliberately dropped. And the SDK's `hook_started` / `hook_response`
 * messages are not it either: they carry `stdout`, `stderr` and
 * `exit_code`, so they describe a *command* hook, and EO's is an
 * in-process callback the CLI invokes over the control protocol without
 * announcing it. Both spellings recorded zero on runs that had fired,
 * which is the exact failure mode this story is about — a number that
 * looks like a measurement and is not one.
 *
 * The `sdk` option is already there for callers that need the real SDK,
 * and it hands over `options` on the way past, so the callback EO built
 * can be wrapped without the adapter growing a seam for a script.
 */
let firedThisRun = [];
const sdkEntry = join(newest("claude-sdk"), "node_modules", "@anthropic-ai", "claude-agent-sdk", "sdk.mjs");
const realSdk = await import(pathToFileURL(sdkEntry).href);
const provider = createClaudeProvider({
  sdk: {
    ...realSdk,
    query: (params) => {
      for (const group of params?.options?.hooks?.PreToolUse ?? []) {
        group.hooks = group.hooks.map((hook) => async (...args) => {
          const answer = await hook(...args);
          const said = answer?.hookSpecificOutput?.additionalContext;
          if (typeof said === "string" && said.trim() !== "") firedThisRun.push(said);
          return answer;
        });
      }
      return realSdk.query(params);
    },
  },
  executablePath: join(newest("claude"), "claude"),
});

const instructions = readFileSync(promptPath, "utf8").trim();
const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();

/** A backstop, so an arm that never finds anything cannot cost more than one that does. */
const CALL_CAP = 60;

const results = [];
for (let attempt = 1; attempt <= runs; attempt++) {
  // A throwaway checkout per run, so run 2 does not inherit run 1's edits
  // and score an opening of zero for having nothing left to find.
  // `--detach` at HEAD, sharing this worktree's object store; the index
  // is copied rather than rebuilt because it already describes HEAD,
  // which is exactly what the checkout is.
  // A clone, not a `git worktree`. The first round of this trial used a
  // worktree, which shares `.git` with this checkout — and one arm's
  // agent walked out of its own directory, into this one, and committed
  // to the branch the trial was being written on. `--shared` borrows
  // this checkout's object store instead of copying it — hardlinks are
  // not available across the filesystem `/tmp` usually sits on — and the
  // clone gets refs of its own, so the worst an arm can now do is commit
  // to a directory that is deleted when it finishes.
  const cwd = mkdtempSync(join(tmpdir(), `eo164-${arm}-`));
  execFileSync("git", ["clone", "--local", "--shared", "--quiet", repoRoot, cwd], { stdio: "pipe" });
  execFileSync("git", ["checkout", "--detach", "--quiet", head], { cwd, stdio: "pipe" });
  // Installed, by borrowing rather than by resolving: the arms differ in
  // one thing, and "could this run its tests" must not be it.
  for (const dir of ["", "apps/desktop", "packages/core", "packages/engine", "packages/ui"]) {
    const from = join(repoRoot, dir, "node_modules");
    if (existsSync(from)) symlinkSync(from, join(cwd, dir, "node_modules"), "dir");
  }
  // Built here, never copied. A copied index answers every query with
  // the path of the checkout it was built in — which, in the first round
  // of this trial, sent all three baseline runs out of their own
  // checkout and into this one within three calls. The index has to
  // describe the tree the agent is standing in.
  process.stdout.write("indexing… ");
  execFileSync(codewiki, ["init", "--no-index", "--path", cwd], { cwd, stdio: "pipe", env: { ...process.env, HOME: cwd } });
  execFileSync(codewiki, ["index", "--path", cwd], { cwd, stdio: "pipe", env: { ...process.env, HOME: cwd } });

  const server = { name: "repo", command: codewiki, args: ["serve", "--mcp", "--path", cwd, "--no-watch"], env: {} };
  // The vocabulary CodeWiki's provider supplies, spelled here rather
  // than imported: `codewiki/provider.ts` is the only file in the main
  // process allowed to say these, and importing it from a script to
  // avoid four strings would be the coupling that rule exists to stop.
  // If they ever disagree, the arm is measuring the wrong sentence —
  // `provider.test.ts` pins the real ones.
  const answers = { symbol: "codewiki_search", area: "codewiki_context", reach: ["codewiki_callers", "codewiki_impact"], files: "codewiki_files" };
  const repositoryMcp =
    arm === "trim"
      ? { ...server, command: process.execPath, args: [join(repoRoot, "scripts/trimRepositoryResponses.mjs"), codewiki, ...server.args] }
      : // Unreachable while the `hook` arm is retired above, and kept
        // rather than deleted: it is the one line that records what the
        // arm was, so reviving it in KAN-144 is adding `knows` here
        // rather than reconstructing the switch from the commit log.
        arm === "hook"
        ? { ...server, answers }
        : server;

  const controller = new AbortController();
  firedThisRun = [];
  const calls = [];
  let firstEditRank = null;
  let usage = null;
  let id = `${arm}-${attempt}`;
  process.stdout.write(`\n[${id}] `);
  try {
    for await (const event of provider.start({ instructions, context: TASK, cwd, repositoryMcp, signal: controller.signal })) {
      if (event.type === "thread_started") id = `${arm}-${attempt}·${event.threadId.slice(0, 8)}`;
      if (event.type === "usage") usage = { tokensIn: event.tokensIn, tokensOut: event.tokensOut, costCents: event.costCents };
      if (event.type === "error") console.error(`\n  error: ${event.message}`);
      if (event.type !== "tool_call") continue;
      calls.push({ name: event.name, args: event.args });
      process.stdout.write(event.name.startsWith("mcp__repo__") ? "▣" : event.name === "Bash" ? "·" : "▫");
      if (isEdit(calls.at(-1))) firstEditRank = calls.length - 1;
      // Everything after the first edit is implementation, which this is
      // not measuring and should not be paying for.
      if (firstEditRank !== null || calls.length >= CALL_CAP) {
        controller.abort();
        break;
      }
    }
  } catch (error) {
    if (!controller.signal.aborted) console.error(`\n  ${String(error)}`);
  }

  // What the shipping classifier says *should* have been intercepted in
  // this run, beside what the harness actually recorded.
  //
  // Written into the transcript so the two can never drift apart in
  // prose. The first three runs of this arm were published claiming the
  // interception fired, on a transcript whose own `interceptions` field
  // was empty for every one of them — the harness had been counting a
  // channel that carries nothing, which is the exact failure this story
  // spent three commits on. A number nobody can contradict is not
  // evidence, so the contradiction now lives in the file.
  const broadSearches = calls.filter(
    (call) => call.name === "Bash" && broadSearchInCommand(typeof call.args?.command === "string" ? call.args.command : "") !== null,
  ).length;
  const hookDelivered = repositoryMcp.answers !== undefined;
  results.push({ id, calls, firstEditRank, usage, hookDelivered, broadSearches, interceptions: firedThisRun });
  console.log(`  ${calls.length} tool calls, first edit at #${firstEditRank ?? "—"}, ${firedThisRun.length} interceptions of ${broadSearches} broad searches`);
  if (hookDelivered && broadSearches > 0 && firedThisRun.length === 0) {
    // Loud, and at the moment it happens rather than in a review three
    // days later. An arm that delivered the hook, made a search the
    // classifier recognises, and recorded nothing has not measured the
    // interception — it has measured the instrumentation.
    console.error(
      `  !! ${id} delivered the hook and made ${broadSearches} broad searches but recorded no interception.\n` +
        `     Do not quote this run as evidence that the hook fired; fix the counter first.`,
    );
  }
  rmSync(cwd, { recursive: true, force: true });
}

mkdirSync(join(repoRoot, "out"), { recursive: true });
const path = join(repoRoot, "out", `index-adoption-${arm}.json`);
writeFileSync(path, JSON.stringify({ arm, task: TASK, instructionsFrom: promptPath, runs: results }, null, 2));
console.log(`\n${path}\n`);
