import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Item } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../../../db/client.js";
import { comments } from "../../../db/schema.js";
import { addDependency, getItem, listRunsForItem, updateWorkspace, type Workspace } from "../../../db/repos/index.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../../../db/testHelpers.js";
import type { CliRunner } from "../forge/cli.js";
import { createFakeProvider } from "../../../providers/fake.js";
import { createRunSupervisor } from "../../../supervisor/runSupervisor.js";
import { setBranchPrefix } from "./branchPrefix.js";
import { createWorktreeWorkspace } from "./dispatchWorkspace.js";
import { createImplementationVerifier } from "./implementationVerifier.js";
import { run } from "../../../testing/git.js";
import { installedKinds } from "../../../supervisor/testWorkspaceKinds.js";
import { gitWorkspaceKind } from "./gitKind.js";
import { hourlyClock } from "../../../testing/clock.js";

function forgeRunnerFor(states: Record<string, "OPEN" | "MERGED" | "CLOSED">): CliRunner {
  return async (_cli, args) => {
    const branch = args[args.indexOf("--head") + 1];
    const state = branch ? states[branch] : undefined;
    if (!state) return { ok: true, stdout: "[]", error: "", notFound: false };
    return { ok: true, stdout: JSON.stringify([{ url: "https://github.com/acme/api/pull/1", state }]), error: "", notFound: false };
  };
}

let scratch: string;
let repoPath: string;
let worktreeRoot: string;
let handle: DbHandle;
let item: Item;
let repository: Workspace;

/**
 * A provider that behaves like an implementer: it writes a file, decides
 * whether to commit it, and then claims success either way. The claim is
 * always the same — which is the point. Only verification distinguishes
 * the honest run from the one that didn't do the work.
 */
function implementerThat(behaviour: { commit: boolean; content?: string }) {
  const inner = createFakeProvider({ result: { branch: "eo/EO-1", summary: "Implemented it.", handoff: "Straightforward; nothing to flag." } });
  return {
    async *start(opts: Parameters<typeof inner.start>[0]) {
      writeFileSync(join(opts.cwd, "feature.txt"), behaviour.content ?? "the work\n");
      if (behaviour.commit) {
        await run(["add", "-A"], opts.cwd);
        await run(["commit", "-m", "agent work"], opts.cwd);
      }
      yield* inner.start(opts);
    },
    resume: inner.resume.bind(inner),
  };
}

function makeSupervisor(overrides: Record<string, unknown> = {}) {
  return createRunSupervisor({
    db: handle.db,
    provider: implementerThat({ commit: true }),
    kinds: installedKinds(gitWorkspaceKind({ db: handle.db, worktreeRoot, intelligenceFor: () => null, verifyOptions: { timeoutMs: 15_000 } })),
    ...overrides,
  });
}

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), "eo verifier test "));
  repoPath = join(scratch, "the repo");
  worktreeRoot = join(scratch, "work trees");
  mkdirSync(repoPath, { recursive: true });
  await run(["init", "-b", "main"], repoPath);
  await run(["config", "user.email", "eo@example.com"], repoPath);
  await run(["config", "user.name", "EO Test"], repoPath);
  // Hermetic: a developer machine may sign commits globally (1Password,
  // gpg), and a signing agent that rate-limits under parallel test load
  // turns into "failed to write commit object". Test repos must not
  // depend on whose machine they run on.
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
  // The workspace comes first now: an item's checkout is resolved
  // through it, so an item without one has nothing to verify against (D-04).
  repository = attachWorkspace(handle.db, { name: "the repo", keyPrefix: "EO", repoPath, baseBranch: "main" });
  item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo", workspaceId: repository.id });
});

afterEach(() => {
  handle.close();
  rmSync(scratch, { recursive: true, force: true });
});

function engineComments() {
  return handle.db
    .select()
    .from(comments)
    .all()
    .filter((comment) => comment.authorType === "engine");
}

describe("createImplementationVerifier, wired into the supervisor", () => {
  it("lets a genuinely finished implementation through to review", async () => {
    updateWorkspace(handle.db, repository.id, { config: { testCommand: `node -e ""` } });

    await makeSupervisor().runOnce();

    const [runRow] = listRunsForItem(handle.db, item.id);
    expect(runRow?.status).toBe("succeeded");
    expect(getItem(handle.db, item.id)?.stepId).toBe("review");
    expect((runRow?.verification as { ok?: boolean } | null)?.ok).toBe(true); // persisted for inspection
  });

  it("an agent claiming success with failing tests does NOT reach review", async () => {
    updateWorkspace(handle.db, repository.id, { config: { testCommand: `node -e "console.log('FAIL: 3 assertions'); process.exit(1)"` } });

    await makeSupervisor().runOnce();

    const [runRow] = listRunsForItem(handle.db, item.id);
    expect(runRow?.status).toBe("failed"); // the agent said it was done; the suite disagreed
    expect(getItem(handle.db, item.id)?.stepId).toBe("todo"); // stayed put
    expect(runRow?.error).toContain("test");

    // The next attempt reads this through E-06's assembled context.
    const posted = engineComments();
    expect(posted).toHaveLength(1);
    expect(posted[0]?.kind).toBe("rejection");
    expect(posted[0]?.body).toContain("FAIL: 3 assertions"); // the captured output is attached
    expect(posted[0]?.runId).toBe(runRow?.id);
  });

  it("an agent that claims success without committing does NOT reach review", async () => {
    await makeSupervisor({ provider: implementerThat({ commit: false }) }).runOnce();

    const [runRow] = listRunsForItem(handle.db, item.id);
    expect(runRow?.status).toBe("failed");
    expect(getItem(handle.db, item.id)?.stepId).toBe("todo");
    expect(engineComments()[0]?.body).toContain("no commits");
  });

  it("persists the full verification result on the run for later inspection", async () => {
    updateWorkspace(handle.db, repository.id, { config: { testCommand: `node -e "process.exit(1)"` } });

    await makeSupervisor().runOnce();

    const [runRow] = listRunsForItem(handle.db, item.id);
    const verification = runRow?.verification as { ok: boolean; failedStep: string; steps: { name: string; ok: boolean }[] };
    expect(verification.ok).toBe(false);
    expect(verification.failedStep).toBe("test");
    expect(verification.steps.map((step) => step.name)).toEqual(["branch", "clean", "rebase", "test"]);
  });

  it("a failed verification counts as an attempt, so repeated failures eventually escalate", async () => {
    updateWorkspace(handle.db, repository.id, { config: { testCommand: `node -e "process.exit(1)"` } });
    // Past every retry backoff by the next tick.
    const supervisor = makeSupervisor({ guards: { perItemAttemptLimit: 2 }, now: hourlyClock() });

    await supervisor.runOnce(); // attempt 1 — fails verification
    await supervisor.runOnce(); // attempt 2 — fails verification
    await supervisor.runOnce(); // refused by the attempt limit

    const runs = listRunsForItem(handle.db, item.id);
    expect(runs.filter((entry) => entry.status === "failed")).toHaveLength(2);
    expect(runs.some((entry) => entry.status === "awaiting_input" && entry.threadId === null)).toBe(true);
    expect(getItem(handle.db, item.id)?.stepId).toBe("todo");
  });

  it("trusts the claim for an item with no repository — there is nothing to check against", async () => {
    const unattached = createTestItem(handle.db, { type: "story", title: "No repo", stepId: "todo" });
    const verify = createImplementationVerifier(handle.db, worktreeRoot);
    const result = await verify(unattached);

    expect(result).toEqual({ ok: true });
  });

  it("rebases onto the remote's base branch, so review meets what actually landed", async () => {
    // A bare remote whose `main` moves on without this checkout — the
    // normal state of any repository with more than one person on it.
    const remotePath = join(scratch, "the remote.git");
    await run(["init", "--bare", "-b", "main", remotePath], scratch);
    await run(["remote", "add", "origin", remotePath], repoPath);
    await run(["push", "-u", "origin", "main"], repoPath);

    const workspace = await createWorktreeWorkspace(handle.db, worktreeRoot)(item, "implement");
    expect(workspace.ok).toBe(true);
    if (!workspace.ok) return;
    writeFileSync(join(workspace.workspace.cwd, "story.txt"), "the work\n");
    await run(["add", "-A"], workspace.workspace.cwd);
    await run(["commit", "-m", "the work"], workspace.workspace.cwd);

    const clone = join(scratch, "some other clone");
    await run(["clone", remotePath, clone], scratch);
    await run(["config", "user.email", "other@example.com"], clone);
    await run(["config", "user.name", "Someone Else"], clone);
    await run(["config", "commit.gpgsign", "false"], clone);
    await run(["config", "tag.gpgsign", "false"], clone);
    writeFileSync(join(clone, "landed-upstream.txt"), "merged while EO was working\n");
    await run(["add", "-A"], clone);
    await run(["commit", "-m", "somebody else's merge"], clone);
    await run(["push", "origin", "main"], clone);

    const verify = createImplementationVerifier(handle.db, worktreeRoot, { timeoutMs: 15_000 });
    const result = await verify(getItem(handle.db, item.id)!);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const steps = result.verification?.steps;
    expect(steps?.find((step) => step.name === "rebase")?.detail).toContain("origin/main");
    // The branch now carries the commit that landed upstream while it
    // was being written — against the local `main`, it would not.
    expect(existsSync(join(workspace.workspace.cwd, "landed-upstream.txt"))).toBe(true);
    expect(existsSync(join(repoPath, "landed-upstream.txt"))).toBe(false);
  });

  describe("Branch stacking (EO-10 / KAN-42)", () => {
    it("recomputes the rebase target fresh and rebases onto a still-open dependency's branch that moved since the worktree was cut", async () => {
      updateWorkspace(handle.db, repository.id, { config: { forgeKind: "github" } });
      const feature = createTestItem(handle.db, { type: "feature", title: "A feature", stepId: "todo", workspaceId: repository.id });
      const dependency = createTestItem(handle.db, { type: "story", title: "Dependency", stepId: "todo", workspaceId: repository.id, parentId: feature.id });
      const dependent = createTestItem(handle.db, { type: "story", title: "Dependent", stepId: "todo", workspaceId: repository.id, parentId: feature.id });
      addDependency(handle.db, dependent.id, dependency.id);

      // The dependency's own worktree/branch.
      const depWorkspace = await createWorktreeWorkspace(handle.db, worktreeRoot)(dependency, "implement");
      expect(depWorkspace.ok).toBe(true);
      if (!depWorkspace.ok) return;
      writeFileSync(join(depWorkspace.workspace.cwd, "dep.txt"), "dependency work\n");
      await run(["add", "-A"], depWorkspace.workspace.cwd);
      await run(["commit", "-m", "dependency work"], depWorkspace.workspace.cwd);

      const runner = forgeRunnerFor({ [`eo/${dependency.key}`]: "OPEN" });

      // Cuts the dependent's worktree from the dependency's branch (the
      // worktree-creation half of this story).
      const depentWorkspace = await createWorktreeWorkspace(handle.db, worktreeRoot, runner)(dependent, "implement");
      expect(depentWorkspace.ok).toBe(true);
      if (!depentWorkspace.ok) return;
      writeFileSync(join(depentWorkspace.workspace.cwd, "story.txt"), "the story's own work\n");
      await run(["add", "-A"], depentWorkspace.workspace.cwd);
      await run(["commit", "-m", "implement the story"], depentWorkspace.workspace.cwd);

      // The dependency gains further work after the dependent already
      // branched off it — the "merges partway through implementation"
      // case the verify step must recompute for, not reuse.
      writeFileSync(join(depWorkspace.workspace.cwd, "dep-2.txt"), "more dependency work\n");
      await run(["add", "-A"], depWorkspace.workspace.cwd);
      await run(["commit", "-m", "more dependency work"], depWorkspace.workspace.cwd);

      const verify = createImplementationVerifier(handle.db, worktreeRoot, { timeoutMs: 15_000 }, runner);
      const result = await verify(dependent);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const steps = result.verification?.steps;
      expect(steps?.find((step) => step.name === "rebase")?.detail).toContain(`eo/${dependency.key}`);
      // Picked up the dependency's latest commit through the rebase.
      expect(existsSync(join(depentWorkspace.workspace.cwd, "dep-2.txt"))).toBe(true);
    });

    it("escalates through the existing rejection-comment path when the dependency's MR closed without merging", async () => {
      updateWorkspace(handle.db, repository.id, { config: { forgeKind: "github" } });
      const feature = createTestItem(handle.db, { type: "feature", title: "A feature", stepId: "todo", workspaceId: repository.id });
      const dependency = createTestItem(handle.db, { type: "story", title: "Dependency", stepId: "todo", workspaceId: repository.id, parentId: feature.id });
      const dependent = createTestItem(handle.db, { type: "story", title: "Dependent", stepId: "todo", workspaceId: repository.id, parentId: feature.id });
      addDependency(handle.db, dependent.id, dependency.id);

      // The dependency's own worktree/branch has to exist for the
      // dependent's to be cut from it.
      const depWorkspace = await createWorktreeWorkspace(handle.db, worktreeRoot)(dependency, "implement");
      expect(depWorkspace.ok).toBe(true);
      if (!depWorkspace.ok) return;
      writeFileSync(join(depWorkspace.workspace.cwd, "dep.txt"), "dependency work\n");
      await run(["add", "-A"], depWorkspace.workspace.cwd);
      await run(["commit", "-m", "dependency work"], depWorkspace.workspace.cwd);

      // Branched while the dependency was still open — then it closed
      // without merging before the dependent's own implementation
      // finished.
      const openRunner = forgeRunnerFor({ [`eo/${dependency.key}`]: "OPEN" });
      const workspace = await createWorktreeWorkspace(handle.db, worktreeRoot, openRunner)(dependent, "implement");
      expect(workspace.ok).toBe(true);
      if (!workspace.ok) return;
      writeFileSync(join(workspace.workspace.cwd, "story.txt"), "the story's own work\n");
      await run(["add", "-A"], workspace.workspace.cwd);
      await run(["commit", "-m", "implement the story"], workspace.workspace.cwd);

      const closedRunner = forgeRunnerFor({ [`eo/${dependency.key}`]: "CLOSED" });
      const verify = createImplementationVerifier(handle.db, worktreeRoot, {}, closedRunner);
      const result = await verify(dependent);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toContain(dependency.key);
      expect(result.reason).toContain("closed");
      // Same shape the runSupervisor already turns into a rejection
      // comment for a failed verification — no new comment-posting code.
      expect(result.comment).toBe(result.reason);
    });
  });
});

/**
 * A base branch set on the ticket (EO-364) is what "commits beyond the
 * base" is counted from. Counted from the repository's base instead, the
 * commits the named base already carries would pass for this run's work.
 */
describe("a base branch set on the ticket", () => {
  /** A release branch one commit ahead of `main`, both pushed — a named base has to be on the remote. */
  async function releaseBranchAhead(): Promise<void> {
    const remotePath = join(scratch, "the remote.git");
    await run(["init", "--bare", "-b", "main", remotePath], scratch);
    await run(["remote", "add", "origin", remotePath], repoPath);
    await run(["checkout", "-b", "release/2.4"], repoPath);
    writeFileSync(join(repoPath, "release-only.txt"), "release work\n");
    await run(["add", "-A"], repoPath);
    await run(["commit", "-m", "release work"], repoPath);
    await run(["checkout", "main"], repoPath);
    await run(["push", "origin", "main", "release/2.4"], repoPath);
  }

  it("counts the implementer's commits beyond that base", async () => {
    await releaseBranchAhead();
    const named = createTestItem(handle.db, { type: "story", title: "On the release", stepId: "todo", workspaceId: repository.id, git: { baseBranch: "release/2.4" } });
    const prepared = await createWorktreeWorkspace(handle.db, worktreeRoot)(named, "implement");
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    writeFileSync(join(prepared.workspace.cwd, "feature.txt"), "the work\n");
    await run(["add", "-A"], prepared.workspace.cwd);
    await run(["commit", "-m", "agent work"], prepared.workspace.cwd);

    const result = await createImplementationVerifier(handle.db, worktreeRoot)(getItem(handle.db, named.id)!);

    expect(result.ok).toBe(true);
    expect(result.verification?.steps[0]?.detail).toBe(`1 commit(s) on eo/${named.key} beyond origin/release/2.4.`);
  });

  it("finds nothing committed when the branch carries only what the base already had", async () => {
    await releaseBranchAhead();
    const named = createTestItem(handle.db, { type: "story", title: "On the release", stepId: "todo", workspaceId: repository.id, git: { baseBranch: "release/2.4" } });
    expect((await createWorktreeWorkspace(handle.db, worktreeRoot)(named, "implement")).ok).toBe(true);

    const result = await createImplementationVerifier(handle.db, worktreeRoot)(getItem(handle.db, named.id)!);

    // From `main` this branch is one commit ahead — the release's own —
    // and would have passed.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("no commits beyond origin/release/2.4");
  });
});

/**
 * An existing branch named on the ticket (EO-365) is counted from where
 * it stood when EO checked it out, and never rebased. Counted from the
 * repository's base, the commits it already carried would pass for this
 * run's work.
 */
describe("an existing branch named on the ticket", () => {
  /** `feature/limits`, two commits ahead of `main`, with `main` then moved on so a rebase would change it. */
  async function branchWithWork(): Promise<void> {
    await run(["checkout", "-b", "feature/limits"], repoPath);
    for (const name of ["one", "two"]) {
      writeFileSync(join(repoPath, `${name}.txt`), `${name}\n`);
      await run(["add", "-A"], repoPath);
      await run(["commit", "-m", name], repoPath);
    }
    await run(["checkout", "main"], repoPath);
    writeFileSync(join(repoPath, "later.txt"), "landed on main afterwards\n");
    await run(["add", "-A"], repoPath);
    await run(["commit", "-m", "later"], repoPath);
  }

  async function prepareNamed(): Promise<{ item: Item; cwd: string }> {
    await branchWithWork();
    const named = createTestItem(handle.db, { type: "story", title: "On their branch", stepId: "todo", workspaceId: repository.id, git: { branch: "feature/limits", namedBranch: true } });
    const prepared = await createWorktreeWorkspace(handle.db, worktreeRoot)(named, "implement");
    if (!prepared.ok) throw new Error(prepared.reason);
    return { item: getItem(handle.db, named.id)!, cwd: prepared.workspace.cwd };
  }

  it("fails a run that committed nothing, though the branch already had commits", async () => {
    const { item: named } = await prepareNamed();

    const result = await createImplementationVerifier(handle.db, worktreeRoot)(named);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("no commits beyond");
    expect(result.reason).toContain("where EO checked it out");
  });

  it("counts only what the run added, and does not rebase the branch", async () => {
    const { item: named, cwd } = await prepareNamed();
    writeFileSync(join(cwd, "feature.txt"), "the work\n");
    await run(["add", "-A"], cwd);
    await run(["commit", "-m", "agent work"], cwd);
    const before = await run(["rev-parse", "HEAD"], cwd);

    const result = await createImplementationVerifier(handle.db, worktreeRoot)(named);

    expect(result.ok).toBe(true);
    expect(result.verification?.steps[0]?.detail).toMatch(/^1 commit\(s\) on feature\/limits beyond /);
    expect(result.verification?.steps.find((step) => step.name === "rebase")?.detail).toContain("Not rebased");
    // `main` moved on; a rebase would have rewritten every commit.
    expect(await run(["rev-parse", "HEAD"], cwd)).toBe(before);
    expect(existsSync(join(cwd, "later.txt"))).toBe(false);
  });
});
