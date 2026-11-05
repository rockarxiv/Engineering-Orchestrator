import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refineChildren, type Item, type Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { createProject, getItem, listRunsForItem, listItems, type GitWorkspace } from "../db/repos/index.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { createEngine } from "../engine.js";
import { createScriptedProvider } from "../providers/scripted.js";
import { applyApprovedProposal } from "../roles/refine.js";

import { setBranchPrefix } from "../packs/developer/workspace/branchPrefix.js";
import { git } from "../packs/developer/workspace/git.js";
import { run, makeRepo as sharedMakeRepo } from "../testing/git.js";

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
 * ── One project, two repositories (KAN-17) ───────────────────────────
 *
 * The gate for multi-repository projects, and the only place all of it runs
 * together: two real git repositories, one project over both, the
 * assembled engine, real worktrees, real commits. Only the agents are
 * scripted.
 *
 * What it has to prove is the claim the whole feature rests on — that a
 * story lands in exactly one repository, and the right one. Getting that
 * wrong does not throw. It produces a branch and a pull request in
 * somebody else's repo, found later by a person.
 *
 * The second thing is cross-repository ordering. `addDependency` takes any
 * two item ids and `featureLifecycle` filters purely on `parentId`
 * with no repository check, so dependencies across repositories *should*
 * already work. "Should already work" is exactly the kind of claim this
 * repository has been wrong about before, so it is asserted rather than
 * assumed.
 */

/** A UI story and an API story, the second waiting on the first. */
const CROSS_REPO_PLAN = {
  children: [
    {
      type: "story",
      title: "Charge endpoint",
      repository: "shop-api",
      body: "Take the payment.",
      acceptance_criteria: ["Returns 201"],
      depends_on: [],
      touches: ["pay.txt"],
    },
    {
      type: "story",
      title: "Checkout button",
      repository: "shop-web",
      body: "Call the endpoint.",
      acceptance_criteria: ["Posts to /pay"],
      depends_on: [0],
      touches: ["button.txt"],
    },
  ],
};

let scratch: string;
let worktreeRoot: string;
let handle: DbHandle;
let web: GitWorkspace;
let api: GitWorkspace;
let projectId: Uuid;

async function makeRepo(name: string): Promise<string> {
  return sharedMakeRepo(scratch, name);
}

/** Writes and commits in whichever worktree it is handed, like the v1 gate's. */
function workingProvider() {
  const scripted = createScriptedProvider([
    {
      when: (context) => context.includes(`"intake" action`),
      script: { result: { ready: true, understanding: "Rate limiting, spanning the gateway and the dashboard." } },
    },
    { when: (context) => context.includes(`"refine" action`), script: { result: CROSS_REPO_PLAN } },
    {
      when: (context) => context.includes(`"implement" action`),
      script: { steps: [{ output: "writing the code" }], result: { branch: "eo/impl", summary: "Implemented and committed.", handoff: "Straightforward; nothing to flag." } },
    },
    {
      when: (context) => context.includes(`"review" action`),
      script: { result: { verdict: "approve", feedback: "Checked.", blocking_issues: [] } },
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

function engineWithAgents() {
  return createEngine({ db: handle.db, eoMcpServerPath: "/unused/in/this/test", worktreeRoot, provider: workingProvider() });
}

async function settle(engine: ReturnType<typeof createEngine>, maxTicks = 30): Promise<void> {
  let previous = "";
  for (let index = 0; index < maxTicks; index += 1) {
    await engine.runOnce();
    const snapshot = listItems(handle.db)
      .map((item) => `${item.key}:${item.stepId}:${listRunsForItem(handle.db, item.id).length}`)
      .join("|");
    if (snapshot === previous) return;
    previous = snapshot;
  }
}

function storiesOf(feature: Item): Item[] {
  return listItems(handle.db).filter((item) => item.parentId === feature.id);
}

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), "eo multi gate "));
  worktreeRoot = join(scratch, "work trees");

  handle = openMigratedTestDb();
  // Hermetic: without this, the branch prefix seeds itself from whatever
  // `git config --global user.email` happens to be on the machine
  // running the tests, not from the fixed "eo" every assertion expects.
  setBranchPrefix(handle.db, "eo");
  web = attachWorkspace(handle.db, { name: "shop-web", keyPrefix: "WEB", repoPath: await makeRepo("shop-web"), baseBranch: "main", description: "the storefront" });
  api = attachWorkspace(handle.db, { name: "shop-api", keyPrefix: "API", repoPath: await makeRepo("shop-api"), baseBranch: "main", description: "the payments service" });
  projectId = createProject(handle.db, { name: "Shop", keyPrefix: "SHOP", workspaceIds: [web.id, api.id] }).id;
});

afterEach(() => {
  handle.close();
  rmSync(scratch, { recursive: true, force: true });
});

describe("one project, two repositories", () => {
  it("a feature spanning both becomes a branch in each, in the right one", async () => {
    // The whole feature in one assertion at the end: each story's
    // commits exist in its own repository and nowhere else.
    const feature = createTestItem(handle.db, {
      type: "feature",
      title: "Discount codes at checkout",
      // A feature is on no pipeline (ARCHITECTURE.md, "One work entity"); its stories carry the
      // work,
      // and here they carry two different repositories.
      stepId: null,
      body: "Let people apply a code.",
      projectId,
    });

    // Project-owned, because its work is spread across both repos.
    expect(feature.workspaceId).toBeNull();
    expect(feature.key).toMatch(/^SHOP-/);

    // Decomposed and approved — which happens in Discussions now (ARCHITECTURE.md, "A column is a
    // responsibility, not a status").
    const engine = engineWithAgents();
    const approval = applyApprovedProposalAt(handle.db, feature, refineChildren(CROSS_REPO_PLAN));
    expect(approval.ok, approval.ok ? "" : approval.reason).toBe(true);

    const stories = storiesOf(feature);
    expect(stories).toHaveLength(2);

    // Each went to the repository the plan named, and both key from the
    // project (KAN-128) — one sequence for one project's work, whichever
    // repository each story is cut in. The keys still differ, which is
    // what keeps the two worktrees apart below.
    const byTitle = new Map(stories.map((story) => [story.title, story]));
    expect(byTitle.get("Charge endpoint")).toMatchObject({ workspaceId: api.id, projectId });
    expect(byTitle.get("Checkout button")).toMatchObject({ workspaceId: web.id, projectId });
    expect(byTitle.get("Charge endpoint")!.key).toMatch(/^SHOP-/);
    expect(byTitle.get("Checkout button")!.key).toMatch(/^SHOP-/);
    expect(byTitle.get("Charge endpoint")!.key).not.toBe(byTitle.get("Checkout button")!.key);

    await settle(engine);

    for (const story of stories) {
      const finished = getItem(handle.db, story.id)!;
      expect(finished.stepId, finished.title).toBe("ready_to_merge");

      const home = finished.workspaceId === api.id ? api : web;
      const away = finished.workspaceId === api.id ? web : api;

      // Real commits, on a real branch, in its own repository.
      const inHome = await git(["rev-list", "--count", `main..eo/${finished.key}`], home.config.repoPath);
      expect(inHome.ok, `${finished.key} has a branch in ${home.config.name}`).toBe(true);
      if (inHome.ok) expect(Number(inHome.stdout), `${finished.key} has commits`).toBeGreaterThan(0);

      // And nothing at all in the other one. This is the assertion the
      // feature exists for: a story that landed in the wrong repository
      // would still have passed everything above.
      const inAway = await git(["rev-parse", "--verify", `eo/${finished.key}`], away.config.repoPath);
      expect(inAway.ok, `${finished.key} must not exist in ${away.config.name}`).toBe(false);
    }
  });

  it("holds a story back until the one it depends on is done, across repositories", async () => {
    // Parked where nothing dispatches it, so the feature's own refine
    // run does not take the only concurrency slot and hide this.
    const feature = createTestItem(handle.db, { type: "feature", title: "Ordered", stepId: "ready_to_merge", projectId });
    const applied = applyApprovedProposalAt(handle.db, feature, refineChildren(CROSS_REPO_PLAN));
    expect(applied.ok, applied.ok ? "" : applied.reason).toBe(true);
    if (!applied.ok) return;

    const [blocker, blocked] = applied.stories;
    expect(blocker!.workspaceId, "the blocker is in the API repo").toBe(api.id);
    expect(blocked!.workspaceId, "the blocked story is in the web repo").toBe(web.id);

    const engine = engineWithAgents();
    await engine.runOnce();

    // Only the blocker runs, even though the other is in a different
    // repository and so has its own per-repository concurrency budget.
    expect(listRunsForItem(handle.db, blocker!.id)).toHaveLength(1);
    expect(listRunsForItem(handle.db, blocked!.id), "blocked by a story in another repo").toHaveLength(0);

    await settle(engine);

    expect(getItem(handle.db, blocker!.id)?.stepId).toBe("ready_to_merge");
    expect(getItem(handle.db, blocked!.id)?.stepId).toBe("ready_to_merge");
  });

  it("verifies each story against its own repository's checks", async () => {
    // G-02 runs the commands of the *item's* repository. On one project
    // over two repos with different commands, running the wrong ones
    // would pass or fail for reasons that have nothing to do with the
    // work.
    const failing = attachWorkspace(handle.db, {
      name: "shop-admin",
      keyPrefix: "ADM",
      repoPath: await makeRepo("shop-admin"),
      baseBranch: "main",
      testCommand: "exit 1",
    });
    // Naming `api` here moves it off "Shop": a workspace belongs to one
    // project since KAN-130, so a project it is added to is the project
    // it is now on. Nothing else in this test reads "Shop", and the
    // checkout on disk is untouched either way.
    const project = createProject(handle.db, { name: "Two", keyPrefix: "TWO", workspaceIds: [api.id, failing.id] });
    const feature = createTestItem(handle.db, { type: "feature", title: "Both", stepId: "ready_to_merge", projectId: project.id });

    const applied = applyApprovedProposalAt(
      handle.db,
      feature,
      refineChildren({
        children: [
          { type: "story", title: "In the good repo", repository: "shop-api", body: "b", acceptance_criteria: ["a"], depends_on: [], touches: [] },
          { type: "story", title: "In the failing repo", repository: "shop-admin", body: "b", acceptance_criteria: ["a"], depends_on: [], touches: [] },
        ],
      }),
    );
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;

    await settle(engineWithAgents());

    const verdictFor = (story: Item) =>
      (listRunsForItem(handle.db, story.id).find((entry) => entry.action === "implement")?.verification as { ok?: boolean } | null)?.ok;

    expect(verdictFor(applied.stories[0]!), "the good repo's suite passed").toBe(true);
    expect(verdictFor(applied.stories[1]!), "the failing repo's suite failed").toBe(false);
  });
});
