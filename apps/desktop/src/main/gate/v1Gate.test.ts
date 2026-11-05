import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refineChildren } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import {
  type Workspace,
  getItem,
  listRunsForItem,
  listItems,
  needsAttention,
} from "../db/repos/index.js";
import { attachWorkspace, createTestItem, openMigratedTestDb, REVIEWABLE_SPEC } from "../db/testHelpers.js";
import { createEngine } from "../engine.js";
import { createScriptedProvider } from "../providers/scripted.js";
import { applyApprovedProposal } from "../roles/refine.js";

import { setBranchPrefix } from "../packs/developer/workspace/branchPrefix.js";
import { git } from "../packs/developer/workspace/git.js";
import { run } from "../testing/git.js";

/**
 * `applyApprovedProposal` with the shipped pipeline's placement.
 *
 * Stories need a pipeline and an entry step now: the literal `"todo"` they
 * used to be created on assumed one pipeline's slugs (ARCHITECTURE.md, "Vocabulary").
 */
function applyApprovedProposalAt(db: Parameters<typeof applyApprovedProposal>[0], feature: Parameters<typeof applyApprovedProposal>[1], output: Parameters<typeof applyApprovedProposal>[2]) {
  return applyApprovedProposal(db, feature, output, { pipelineId: "default" as never, entryStepId: "worktree" });
}

/**
 * ── The v1 gate ───────────────────────────────────────────────────
 *
 * "Describe a feature in chat; later, find branches waiting to merge."
 *
 * Where the Wave 3 gate proved the engine loop with a hand-built
 * supervisor, this drives the *assembled* engine — createEngine, with
 * the real workspace, the real verifier and the real role wiring — over
 * a real git repository. Only the agents are scripted.
 *
 * The one thing still supplied by hand is approving the plan, because
 * that is a human's decision (R-04). Everything else — including the
 * decomposition itself, which this gate used to apply by hand because
 * nothing in the app did — is the engine's own doing.
 */

const REFINE_OUTPUT = {
  children: [
    { type: "story", title: "Add the limiter", body: "Core token bucket.", acceptance_criteria: ["429 over budget"], depends_on: [], touches: ["limiter.txt"] },
    { type: "story", title: "Wire it in", body: "Call it from the API.", acceptance_criteria: ["API uses it"], depends_on: [0], touches: ["api.txt"] },
  ],
};

let scratch: string;
let repoPath: string;
let worktreeRoot: string;
let handle: DbHandle;
let workspace: Workspace;

/**
 * A scripted implementer that behaves like a real one: it writes a file
 * in its worktree, commits it, and reports the branch.
 *
 * The committing matters — G-02 verifies the branch independently, so an
 * agent that only *claims* to have worked is correctly rejected. This
 * gate is about the honest path, so the agent has to actually do it.
 */
function workingProvider(reviewVerdict: "approve" | "reject") {
  const scripted = createScriptedProvider([
      {
        when: (context) => context.includes(`"intake" action`),
        script: { result: { ready: true, understanding: "Throttle the public API for anonymous callers." } },
      },
      { when: (context) => context.includes(`"refine" action`), script: { result: REFINE_OUTPUT } },
      {
        when: (context) => context.includes(`"implement" action`),
        script: {
          steps: [{ output: "writing the code" }],
          result: { branch: "eo/impl", summary: "Implemented and committed.", handoff: "Straightforward; nothing to flag." },
        },
      },
    {
      when: (context) => context.includes(`"review" action`),
      script: {
        result:
          reviewVerdict === "reject"
            ? {
                verdict: "reject",
                feedback: "Checked against the criteria.",
                criteria_coverage: [{ criterion: "429 over budget", result: "not_met" }],
                blocking_issues: ["the retry path has no test"],
              }
            : { verdict: "approve", feedback: "Checked against the criteria." },
      },
    },
  ]);

  return {
    async *start(opts: Parameters<typeof scripted.start>[0]) {
      if (opts.context.includes(`"implement" action`)) {
        writeFileSync(join(opts.cwd, "work.txt"), `done at ${Date.now()}\n`);
        await run(["add", "-A"], opts.cwd);
        await run(["commit", "-m", "agent work"], opts.cwd);
      }
      yield* scripted.start(opts);
    },
    resume: scripted.resume.bind(scripted),
  };
}

function engineWithAgents(reviewVerdict: "approve" | "reject" = "approve") {
  return createEngine({
    db: handle.db,
    eoMcpServerPath: "/unused/in/this/test",
    worktreeRoot,
    provider: workingProvider(reviewVerdict),
  });
}

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), "eo v1 gate "));
  repoPath = join(scratch, "the repo");
  worktreeRoot = join(scratch, "work trees");
  mkdirSync(repoPath, { recursive: true });
  await run(["init", "-b", "main"], repoPath);
  await run(["config", "user.email", "eo@example.com"], repoPath);
  await run(["config", "user.name", "EO Test"], repoPath);
  await run(["config", "commit.gpgsign", "false"], repoPath);
  await run(["config", "tag.gpgsign", "false"], repoPath);
  writeFileSync(join(repoPath, "README.md"), "# fixture\n");
  await run(["add", "-A"], repoPath);
  await run(["commit", "-m", "initial"], repoPath);

  handle = openMigratedTestDb();
  // Hermetic: without this, the branch prefix seeds itself from whatever
  // `git config --global user.email` happens to be on the machine
  // running the tests, not from the fixed "eo" every assertion expects.
  setBranchPrefix(handle.db, "eo");
  workspace = attachWorkspace(handle.db, { name: "the repo", keyPrefix: "EO", repoPath, baseBranch: "main" });
});

afterEach(() => {
  handle.close();
  rmSync(scratch, { recursive: true, force: true });
});

/** Runs ticks until nothing changes, so the test doesn't depend on a magic tick count. */
async function settle(engine: ReturnType<typeof createEngine>, maxTicks = 20): Promise<void> {
  let previous = "";
  for (let i = 0; i < maxTicks; i++) {
    await engine.runOnce();
    const snapshot = listItems(handle.db)
      .map((item) => `${item.key}:${item.stepId}:${listRunsForItem(handle.db, item.id).length}`)
      .join("|");
    if (snapshot === previous) return;
    previous = snapshot;
  }
}

describe("v1 gate", () => {
  it("an approved decomposition becomes branches waiting to merge", async () => {
    // ── "Describe a feature in chat" ────────────────────────────────
    //
    // The describing half happens in Discussions now (ARCHITECTURE.md, "A column is a
    // responsibility, not a status") — a conversation
    // with the product owner, ending in a plan somebody approves. That
    // gate is covered by `discussion.test.ts`; this gate is the other half,
    // and the more load-bearing one: given work a human has agreed to,
    // does the engine actually drive it to branches waiting to merge.
    //
    // A feature is on no pipeline (ARCHITECTURE.md, "One work entity"). It is the container; its
    // stories are the work.
    const feature = createTestItem(handle.db, { type: "feature", title: "Rate limiting", stepId: null, workspaceId: workspace.id });
    const applied = applyApprovedProposalAt(handle.db, feature, refineChildren(REFINE_OUTPUT));
    expect(applied.ok, applied.ok ? "" : applied.reason).toBe(true);
    if (!applied.ok) return;

    const engine = engineWithAgents();

    // ── The engine takes it from here ───────────────────────────────
    await settle(engine);

    // "later, find branches waiting to merge"
    for (const story of applied.stories) {
      const finished = getItem(handle.db, story.id)!;
      expect(finished.stepId, finished.title).toBe("ready_to_merge");

      // A real branch with a real commit, verified independently (G-02).
      const branch = await git(["rev-list", "--count", `main..eo/${finished.key}`], repoPath);
      expect(branch.ok, `${finished.key} branch exists`).toBe(true);
      if (branch.ok) expect(Number(branch.stdout), `${finished.key} has commits`).toBeGreaterThan(0);

      const implementRun = listRunsForItem(handle.db, finished.id).find((entry) => entry.action === "implement")!;
      expect((implementRun.verification as { ok?: boolean } | null)?.ok).toBe(true);
    }
  });

  it("respects dependency order — the second story waits for the first", async () => {
    // A feature takes no dispatch slot of its own now: it is on no
    // pipeline at all (ARCHITECTURE.md, "One work entity"), so its stories compete only with each
    // other.
    const feature = createTestItem(handle.db, { type: "feature", title: "Ordered", stepId: null, workspaceId: workspace.id });
    const applied = applyApprovedProposalAt(handle.db, feature, refineChildren(REFINE_OUTPUT));
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;

    const engine = engineWithAgents();
    await engine.runOnce();

    expect(listRunsForItem(handle.db, applied.stories[0]!.id)).toHaveLength(1);
    expect(listRunsForItem(handle.db, applied.stories[1]!.id)).toHaveLength(0); // blocked

    await settle(engine);
    for (const story of applied.stories) expect(getItem(handle.db, story.id)?.stepId).toBe("ready_to_merge");
  });

  it("a rejecting reviewer sends work back as a fresh implementation initiation", async () => {
    const story = createTestItem(handle.db, { type: "story", title: "Contested", stepId: "todo", workspaceId: workspace.id, spec: REVIEWABLE_SPEC });
    const engine = engineWithAgents("reject");

    await settle(engine);

    const runs = listRunsForItem(handle.db, story.id);
    const implementations = runs.filter((entry) => entry.action === "implement" && entry.status === "succeeded");
    expect(implementations.length).toBeGreaterThan(3); // item-lifetime history no longer exhausts the per-initiation guard
    expect(implementations.every((entry) => entry.attempt === 1)).toBe(true);
    expect(new Set(implementations.map((entry) => entry.initiationId)).size).toBe(implementations.length);
    expect(getItem(handle.db, story.id)?.stepId).toBe("todo"); // never reached ready_to_merge
    expect(needsAttention(handle.db, story.id)).toBe(false); // each review return is authorized work, not a failed retry loop
  });

  it("nothing is dispatched while the engine is paused", async () => {
    createTestItem(handle.db, { type: "story", title: "Paused", stepId: "todo", workspaceId: workspace.id });
    const engine = engineWithAgents();

    engine.pause();
    await engine.runOnce();

    expect(listItems(handle.db).every((item) => listRunsForItem(handle.db, item.id).length === 0)).toBe(true);
  });
});
