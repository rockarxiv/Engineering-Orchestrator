import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitStateOf, type Item } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../../../db/client.js";
import { addDependency, getGitWorkspace, getItem, updateWorkspace, type DependencyGate, type GitWorkspace } from "../../../db/repos/index.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../../../db/testHelpers.js";
import { makeRepo, run, status } from "../../../testing/git.js";
import { removeScratch } from "../../../testing/scratch.js";
import type { CliRunner } from "../forge/cli.js";
import { pullRequestTargetBranch } from "../forge/openForItem.js";
import { setBranchPrefix } from "./branchPrefix.js";
import { createWorktreeWorkspace } from "./dispatchWorkspace.js";
import { git, isAncestor } from "./git.js";
import { restackOnDependency } from "./restack.js";
import { worktreePathFor } from "./worktrees.js";

/**
 * Stacking on a dependency that has not finished (EO-780): which edges
 * stack, the commit a stacked branch records as its cut, and the restack
 * every later dispatch makes when the dependency's branch has moved or
 * merged.
 *
 * A real repository with a real bare remote, because what is being proven
 * is what git ends up holding — a force-pushed dependency, a squash merge
 * — and a recorded forge that answers each branch's pull request state.
 */

let scratch: string;
let repoPath: string;
let remotePath: string;
let worktreeRoot: string;
let handle: DbHandle;
let repository: GitWorkspace;
let featureA: Item;
let featureB: Item;
let dependency: Item;
let forgeStates: Record<string, "OPEN" | "MERGED" | "CLOSED">;

/** Answers `pr list --head <branch>` with the state named for that branch, as `dispatchWorkspace.test.ts` does. */
const forge: CliRunner = async (_cli, args) => {
  const branch = args[args.indexOf("--head") + 1];
  const state = branch ? forgeStates[branch] : undefined;
  if (!state) return { ok: true, stdout: "[]", error: "", notFound: false };
  return { ok: true, stdout: JSON.stringify([{ url: "https://github.com/acme/api/pull/1", state }]), error: "", notFound: false };
};

const nobody: CliRunner = async (_cli, args) => {
  throw new Error(`the forge should not have been asked: ${args.join(" ")}`);
};

const reachedReview: DependencyGate = { wait: "reached", stepId: "review" };

async function tipOf(ref: string, cwd = repoPath): Promise<string> {
  return run(["rev-parse", `${ref}^{commit}`], cwd);
}

async function commitIn(worktree: string, file: string, content: string, message: string): Promise<void> {
  writeFileSync(join(worktree, file), content);
  await run(["add", file], worktree);
  await run(["commit", "-m", message], worktree);
}

function prepare(item: Item, runner: CliRunner = forge) {
  return createWorktreeWorkspace(handle.db, worktreeRoot, runner)(getItem(handle.db, item.id)!, "implement");
}

/** The dependency's worktree with one commit on it, pushed: what `reached` releases an item onto. */
async function dependencyAtWork(): Promise<{ worktree: string; tip: string }> {
  const prepared = await prepare(dependency);
  if (!prepared.ok) throw new Error(prepared.reason);
  const worktree = prepared.workspace.cwd;
  await commitIn(worktree, "dep.txt", "the dependency's work\n", "dependency work");
  await run(["push", "-u", "origin", `eo/${dependency.key}`], worktree);
  forgeStates[`eo/${dependency.key}`] = "OPEN";
  return { worktree, tip: await tipOf("HEAD", worktree) };
}

/** A child in another feature, released by `reached`, cut and with one commit of its own. */
async function stackedChild(file = "child.txt", content = "the child's work\n"): Promise<{ child: Item; worktree: string }> {
  const child = createTestItem(handle.db, { type: "story", title: "Child", stepId: "todo", workspaceId: repository.id, parentId: featureB.id });
  addDependency(handle.db, child.id, dependency.id, reachedReview);
  const prepared = await prepare(child);
  if (!prepared.ok) throw new Error(prepared.reason);
  await commitIn(prepared.workspace.cwd, file, content, "child work");
  return { child, worktree: prepared.workspace.cwd };
}

/** Rewrites the dependency's one commit and force-pushes it — what review and a rebase do to a branch. */
async function rewriteDependency(worktree: string, content = "the dependency's work, rewritten\n"): Promise<string> {
  writeFileSync(join(worktree, "dep.txt"), content);
  await run(["add", "dep.txt"], worktree);
  await run(["commit", "--amend", "-m", "dependency work, rewritten"], worktree);
  await run(["push", "--force", "origin", `eo/${dependency.key}`], worktree);
  return tipOf("HEAD", worktree);
}

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), "eo restack "));
  repoPath = await makeRepo(scratch, "repo");
  remotePath = join(scratch, "remote.git");
  worktreeRoot = join(scratch, "worktrees");
  await run(["init", "--bare", "-b", "main", remotePath], scratch);
  await run(["remote", "add", "origin", remotePath], repoPath);
  await run(["push", "-u", "origin", "main"], repoPath);

  handle = openMigratedTestDb();
  setBranchPrefix(handle.db, "eo");
  const attached = attachWorkspace(handle.db, { name: "repo", keyPrefix: "EO", repoPath, baseBranch: "main" });
  updateWorkspace(handle.db, attached.id, { config: { forgeKind: "github" } });
  repository = getGitWorkspace(handle.db, attached.id)!;
  featureA = createTestItem(handle.db, { type: "feature", title: "Feature A", stepId: "todo", workspaceId: repository.id });
  featureB = createTestItem(handle.db, { type: "feature", title: "Feature B", stepId: "todo", workspaceId: repository.id });
  dependency = createTestItem(handle.db, { type: "story", title: "Dependency", stepId: "review", workspaceId: repository.id, parentId: featureA.id });
  forgeStates = {};
});

afterEach(() => {
  vi.restoreAllMocks();
  handle.close();
  removeScratch(scratch);
});

describe("which edges stack", () => {
  it("cuts a child with a reached edge from an unmerged dependency's branch in another feature, and records the exact commit it was cut from", async () => {
    const { tip } = await dependencyAtWork();
    const { child, worktree } = await stackedChild();

    expect(readFileSync(join(worktree, "dep.txt"), "utf8")).toBe("the dependency's work\n");
    expect(gitStateOf(getItem(handle.db, child.id)!).stackedOn).toEqual({ itemId: dependency.id, commit: tip });
    expect(await isAncestor(repoPath, tip, `eo/${child.key}`)).toBe(true);
  });

  it("cuts a child whose only edge to an unmerged same-feature item is none from the base branch, and opens its pull request against the base", async () => {
    await dependencyAtWork();
    const child = createTestItem(handle.db, { type: "story", title: "Child", stepId: "todo", workspaceId: repository.id, parentId: featureA.id });
    addDependency(handle.db, child.id, dependency.id, { wait: "none" });

    // Nothing to ask the forge: a `none` edge is out of the question
    // before any lookup is made.
    const prepared = await prepare(child, nobody);

    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(existsSync(join(prepared.workspace.cwd, "dep.txt"))).toBe(false);
    expect(await tipOf(`eo/${child.key}`)).toBe(await tipOf("origin/main"));
    expect(gitStateOf(getItem(handle.db, child.id)!).stackedOn).toBeNull();
    expect(await pullRequestTargetBranch(handle.db, getItem(handle.db, child.id)!, { run: nobody })).toBe("main");
  });

  it("still opens a reached child's pull request against the dependency's branch across features", async () => {
    await dependencyAtWork();
    const { child } = await stackedChild();

    expect(await pullRequestTargetBranch(handle.db, getItem(handle.db, child.id)!, { run: forge })).toBe(`eo/${dependency.key}`);
  });
});

describe("restacking on the next dispatch", () => {
  it("carries the child's own commits onto a dependency force-pushed with a rewritten commit, leaving none of the old ones", async () => {
    const { worktree: dependencyWorktree, tip: oldTip } = await dependencyAtWork();
    const { child } = await stackedChild();
    const newTip = await rewriteDependency(dependencyWorktree);

    const prepared = await prepare(child);

    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const branch = `eo/${child.key}`;
    expect(await isAncestor(repoPath, newTip, branch)).toBe(true);
    expect(await isAncestor(repoPath, oldTip, branch)).toBe(false);
    expect(await run(["log", "--format=%s", `${newTip}..${branch}`], repoPath)).toBe("child work");
    expect(readFileSync(join(prepared.workspace.cwd, "dep.txt"), "utf8")).toBe("the dependency's work, rewritten\n");
    const state = gitStateOf(getItem(handle.db, child.id)!);
    expect(state.stackedOn).toEqual({ itemId: dependency.id, commit: newTip });
    expect(state.restacked).toBe(true);
  });

  it("carries the child's own commits onto the remote base once the dependency is squash-merged, and stops being stacked", async () => {
    const { tip: dependencyTip } = await dependencyAtWork();
    const { child } = await stackedChild();
    // The forge squashes the dependency into main.
    await run(["merge", "--squash", `eo/${dependency.key}`], repoPath);
    await run(["commit", "-m", "Dependency (#1)"], repoPath);
    await run(["push", "origin", "main"], repoPath);
    forgeStates[`eo/${dependency.key}`] = "MERGED";

    const prepared = await prepare(child);

    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const branch = `eo/${child.key}`;
    const base = await tipOf("origin/main");
    expect(await isAncestor(repoPath, base, branch)).toBe(true);
    expect(await isAncestor(repoPath, dependencyTip, branch)).toBe(false);
    expect(await run(["log", "--format=%s", `${base}..${branch}`], repoPath)).toBe("child work");
    expect(await status(prepared.workspace.cwd)).toBe("");
    const state = gitStateOf(getItem(handle.db, child.id)!);
    expect(state.stackedOn).toBeNull();
    expect(state.restacked).toBe(true);
  });

  it("escalates a conflict naming the dependency and the files, and leaves the branch and worktree as they were", async () => {
    const { worktree: dependencyWorktree, tip: oldTip } = await dependencyAtWork();
    // The child changes the very file the dependency then rewrites.
    const { child, worktree } = await stackedChild("dep.txt", "the child's take on it\n");
    const before = await tipOf(`eo/${child.key}`);
    await rewriteDependency(dependencyWorktree, "something else entirely\n");

    const prepared = await prepare(child);

    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.reason).toContain(dependency.key);
    expect(prepared.reason).toContain("`dep.txt`");
    expect(await tipOf(`eo/${child.key}`)).toBe(before);
    expect(await status(worktree)).toBe("");
    const rebaseState = await git(["rev-parse", "--git-path", "rebase-merge"], worktree);
    expect(rebaseState.ok && existsSync(join(worktree, rebaseState.stdout))).toBe(false);
    expect(readFileSync(join(worktree, "dep.txt"), "utf8")).toBe("the child's take on it\n");
    expect(gitStateOf(getItem(handle.db, child.id)!).stackedOn).toEqual({ itemId: dependency.id, commit: oldTip });
  });

  it("runs no rebase at all while the dependency's tip is the commit recorded", async () => {
    await dependencyAtWork();
    const { child } = await stackedChild();
    const rebase = vi.fn();

    const restacked = await restackOnDependency(handle.db, repository, getItem(handle.db, child.id)!, {
      worktreePath: worktreePathFor(child.key, worktreeRoot),
      run: forge,
      rebase,
    });

    expect(restacked).toEqual({ ok: true, value: undefined });
    expect(rebase).not.toHaveBeenCalled();
    expect(gitStateOf(getItem(handle.db, child.id)!).restacked).toBe(false);
  });
});
