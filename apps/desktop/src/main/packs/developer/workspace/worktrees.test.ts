import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeWorktreeSkills } from "../../../agentAttachments/worktreeSkills.js";
import { REPOSITORY_INDEX_DIRECTORIES } from "../repositoryIntelligence/index.js";
import { branchExists, canonicalPath, checkGitAvailable, git, listWorktrees, statusPorcelain } from "./git.js";
import {
  branchNameFor,
  checkRepoReady,
  createWorktree,
  ensureWorktree,
  listHeldWorktrees,
  listStaleWorktrees,
  removalFailureReason,
  removeWorktree,
  worktreePathFor,
  type BranchNaming,
} from "./worktrees.js";
import { run, status, makeRepo as sharedMakeRepo } from "../../../testing/git.js";

// Driven against real repositories in a temp dir rather than a mocked
// git: the whole point of G-01 is that these git invocations behave, and
// a mock would assert only that we call the commands we think we call.
// The directory names deliberately contain a space — that's an
// acceptance criterion, and it's the thing that breaks the moment
// anyone builds a shell string instead of passing argv.
let scratch: string;
let repoPath: string;
let worktreeRoot: string;

/**
 * Directories whose deletion fails, by basename.
 *
 * The filesystem fallback's own failure is a real state with required
 * behaviour, and there is no portable way to make a real `rm` fail on
 * demand: `chmod` does nothing on Windows and this suite runs there,
 * and running as root would ignore it anywhere else. Everything not
 * named here goes to the real filesystem, so the only thing faked is
 * the failure itself — the git failures below are all genuine.
 */
const undeletable = vi.hoisted(() => new Set<string>());
/**
 * Directories that cannot be inspected, by basename.
 *
 * The other half of the same problem: a path that is still there but
 * unreadable — EACCES on the directory above it, or an ELOOP — is what
 * separates "verified gone" from "the check threw", and it cannot be
 * conjured portably either.
 */
const uninspectable = vi.hoisted(() => new Set<string>());
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    rm: ((path: Parameters<typeof real.rm>[0], options?: Parameters<typeof real.rm>[1]) => {
      if (undeletable.has(basename(String(path)))) {
        return Promise.reject(Object.assign(new Error("EACCES: permission denied, rmdir"), { code: "EACCES" }));
      }
      return real.rm(path, options);
    }) satisfies typeof real.rm,
    lstat: ((path: Parameters<typeof real.lstat>[0], options?: Parameters<typeof real.lstat>[1]) => {
      if (uninspectable.has(basename(String(path)))) {
        return Promise.reject(Object.assign(new Error("EACCES: permission denied, lstat"), { code: "EACCES" }));
      }
      return real.lstat(path, options);
    }) as unknown as typeof real.lstat,
  };
});

async function makeRepo(name: string): Promise<string> {
  return sharedMakeRepo(scratch, name, { readme: "# fixture\n" });
}

function config(overrides: Partial<{ repoPath: string; baseBranch: string; worktreeRoot: string }> = {}) {
  return { repoPath, baseBranch: "main", worktreeRoot, ...overrides };
}

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), "eo git test "));
  repoPath = await makeRepo("the repo");
  worktreeRoot = join(scratch, "work trees");
});

afterEach(() => {
  undeletable.clear();
  uninspectable.clear();
  rmSync(scratch, { recursive: true, force: true });
});

describe("checkGitAvailable", () => {
  it("finds the git binary", async () => {
    const result = await checkGitAvailable();
    expect(result.ok).toBe(true);
  });
});

describe("branchNameFor (EO-14 / EO-16 / EO-638)", () => {
  it("defaults to the historical eo/<KEY> when given nothing else", () => {
    expect(branchNameFor("EO-1")).toBe("eo/EO-1");
  });

  it("uses the given prefix", () => {
    expect(branchNameFor("EO-1", null, "lyudvig")).toBe("lyudvig/EO-1");
  });

  it("prefers a jiraKey over the item's own key", () => {
    expect(branchNameFor("EO-1", { kind: "jira", value: "KAN-46" }, "lyudvig")).toBe("lyudvig/KAN-46");
  });

  it("falls back to the item key when nothing else names the work", () => {
    expect(branchNameFor("EO-1", null, "lyudvig")).toBe("lyudvig/EO-1");
    expect(branchNameFor("EO-1", { kind: "key", value: "EO-1" }, "lyudvig")).toBe("lyudvig/EO-1");
  });

  it("names a Reference and keeps the EO key, so siblings sharing it never share a branch", () => {
    const name = { kind: "reference", value: "PROJ-123" } as const;
    expect(branchNameFor("EO-45", name)).toBe("eo/PROJ-123-EO-45");
    expect(branchNameFor("EO-46", name)).toBe("eo/PROJ-123-EO-46");
    expect(branchNameFor("EO-45", name, "feat")).toBe("feat/PROJ-123-EO-45");
  });
});

describe("createWorktree", () => {
  it("creates a worktree on eo/<KEY> at a path containing spaces", async () => {
    const result = await createWorktree(config(), "EO-1");

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.branch).toBe("eo/EO-1");
    expect(result.value.path).toContain(" "); // the criterion under test
    expect(existsSync(join(result.value.path, "README.md"))).toBe(true);
    expect(await branchExists(repoPath, "eo/EO-1")).toBe(true);
  });

  it("cuts the branch from the base branch, not from whatever is checked out", async () => {
    await run(["checkout", "-b", "some-other-branch"], repoPath);
    writeFileSync(join(repoPath, "only-here.txt"), "x\n");
    await run(["add", "."], repoPath);
    await run(["commit", "-m", "on the other branch"], repoPath);

    const result = await createWorktree(config(), "EO-2");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Cut from main, so the other branch's commit must not be present.
    expect(existsSync(join(result.value.path, "only-here.txt"))).toBe(false);
  });

  it("is not blocked by uncommitted changes in the base repo, and does not carry them in", async () => {
    // This used to refuse. It cut nothing while a human had unrelated work
    // in progress in their own checkout — work that was never going to be
    // included either way, because `git worktree add` cuts from a commit.
    writeFileSync(join(repoPath, "dirty.txt"), "uncommitted\n");

    const result = await createWorktree(config(), "EO-3");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(existsSync(join(result.value.path, "dirty.txt"))).toBe(false); // the new worktree is cut from the commit, not the working copy
    const status = await statusPorcelain(repoPath);
    expect(status.ok && status.stdout).toContain("dirty.txt"); // and the human's work is left exactly where it was
  });

  it("refuses when the branch already exists rather than reusing or clobbering it", async () => {
    await run(["branch", branchNameFor("EO-4")], repoPath);

    const result = await createWorktree(config(), "EO-4");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("already exists");
  });

  it("refuses when the path is not a git repository", async () => {
    const notARepo = join(scratch, "not a repo");
    mkdirSync(notARepo, { recursive: true });

    const result = await createWorktree(config({ repoPath: notARepo }), "EO-5");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("not a git repository");
  });

  it("two worktrees for different items coexist without interfering", async () => {
    const first = await createWorktree(config(), "EO-10");
    const second = await createWorktree(config(), "EO-11");
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    writeFileSync(join(first.value.path, "only-in-10.txt"), "a\n");
    writeFileSync(join(second.value.path, "only-in-11.txt"), "b\n");

    // Each sees its own change and not the other's.
    expect(existsSync(join(first.value.path, "only-in-11.txt"))).toBe(false);
    expect(existsSync(join(second.value.path, "only-in-10.txt"))).toBe(false);

    const firstStatus = await statusPorcelain(first.value.path);
    expect(firstStatus.ok && firstStatus.stdout).toContain("only-in-10.txt");
    expect(firstStatus.ok && firstStatus.stdout).not.toContain("only-in-11.txt");

    // And the base repo is untouched by either.
    const baseStatus = await statusPorcelain(repoPath);
    expect(baseStatus.ok && baseStatus.stdout).toBe("");
  });

  it("cuts the branch from an explicit start point instead of the base branch (EO-10 / KAN-42)", async () => {
    await run(["checkout", "-b", "eo/DEP"], repoPath);
    writeFileSync(join(repoPath, "dep-only.txt"), "x\n");
    await run(["add", "."], repoPath);
    await run(["commit", "-m", "dependency work"], repoPath);
    await run(["checkout", "main"], repoPath);

    const result = await createWorktree(config(), "EO-12", "eo/DEP");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(existsSync(join(result.value.path, "dep-only.txt"))).toBe(true); // cut from eo/DEP, not main
  });
});

describe("removeWorktree", () => {
  it("removes a clean worktree", async () => {
    const created = await createWorktree(config(), "EO-20");
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const removed = await removeWorktree(config(), "EO-20");

    expect(removed.ok).toBe(true);
    expect(existsSync(created.value.path)).toBe(false);
    expect(await branchExists(repoPath, "eo/EO-20")).toBe(true); // branch kept unless asked
  });

  it("deletes the branch too when asked", async () => {
    await createWorktree(config(), "EO-21");

    const removed = await removeWorktree(config(), "EO-21", { deleteBranch: true });

    expect(removed.ok).toBe(true);
    expect(await branchExists(repoPath, "eo/EO-21")).toBe(false);
  });

  it("deletes the stored branch, not one recomputed from the key, and never one a person named (EO-365)", async () => {
    await createWorktree(config(), "EO-23", undefined, { branch: "acme/KAN-46" });
    expect(await removeWorktree(config(), "EO-23", { deleteBranch: true, branch: "acme/KAN-46" })).toMatchObject({ ok: true });
    expect(await branchExists(repoPath, "acme/KAN-46")).toBe(false);

    await run(["branch", "feature/limits"], repoPath);
    await run(["worktree", "add", worktreePathFor("EO-24", config().worktreeRoot), "feature/limits"], repoPath);
    const removed = await removeWorktree(config(), "EO-24", { deleteBranch: true, branch: "feature/limits", namedBranch: true });

    expect(removed.ok).toBe(true);
    expect(existsSync(worktreePathFor("EO-24", config().worktreeRoot))).toBe(false);
    expect(await branchExists(repoPath, "feature/limits")).toBe(true);
  });

  it("refuses to discard uncommitted agent work without an explicit force", async () => {
    const created = await createWorktree(config(), "EO-22");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    writeFileSync(join(created.value.path, "agent-work.txt"), "half-finished\n");

    const refused = await removeWorktree(config(), "EO-22");

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.reason).toContain("uncommitted");
    // Classified, not just worded: this is the one refusal that means
    // there is work in there to go and look at, and callers report it
    // as such (EO-131).
    expect(refused.refusal).toBe("uncommitted-changes");
    expect(existsSync(created.value.path)).toBe(true); // still there — the work survived
    expect(existsSync(join(created.value.path, "agent-work.txt"))).toBe(true);
  });

  it("removes uncommitted work when force is given", async () => {
    const created = await createWorktree(config(), "EO-23");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    writeFileSync(join(created.value.path, "agent-work.txt"), "discard me\n");

    const removed = await removeWorktree(config(), "EO-23", { force: true });

    expect(removed.ok).toBe(true);
    expect(existsSync(created.value.path)).toBe(false);
  });

  /**
   * The generated repository index, and a release that used to refuse
   * on it (EO-170).
   *
   * Written against the catalogue rather than a directory name typed in
   * here, for the reason `indexPaths.test.ts` gives: a test that spelled
   * one implementation's answer would go green for a second provider
   * whose worktrees had gone back to never being released.
   */
  describe("the index EO generates in the worktree", () => {
    /** An index of the shape a provider writes, one per configured implementation. */
    function plantRepositoryIndex(worktreePath: string): void {
      for (const directory of REPOSITORY_INDEX_DIRECTORIES) {
        mkdirSync(join(worktreePath, directory, "graph"), { recursive: true });
        writeFileSync(join(worktreePath, directory, "meta.json"), '{"root":"somewhere"}\n');
        writeFileSync(join(worktreePath, directory, "graph", "symbols.db"), "not really sqlite\n");
      }
    }

    /** Nothing an implementation wrote reached a sentence a person reads. */
    function namesNoIndex(text: string): void {
      expect(REPOSITORY_INDEX_DIRECTORIES.length).toBeGreaterThan(0); // never vacuously true
      for (const directory of REPOSITORY_INDEX_DIRECTORIES) expect(text).not.toContain(directory);
    }

    it("releases a settled worktree whose only uncommitted entry is that index", async () => {
      const created = await createWorktree(config(), "EO-35");
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      plantRepositoryIndex(created.value.path);
      // The reported state, established rather than assumed. It used to
      // be "git itself calls this tree dirty", which is what both
      // refusals keyed on; since EO-207 the worktree is handed back with
      // the index excluded, so git does not see it at all. The disposal
      // below still runs — the exclusion is a write that can fail and a
      // line a person can delete — and this is the assertion that says
      // which half is answering today.
      const status = await statusPorcelain(created.value.path);
      expect(status.ok && status.stdout).toBe("");

      const removed = await removeWorktree(config(), "EO-35");

      expect(removed.ok).toBe(true);
      expect(existsSync(created.value.path)).toBe(false);
      // Released, not abandoned: the branch is free for anything else
      // that wants to check it out, which is the failure this one was
      // making routine.
      expect(await branchExists(repoPath, "eo/EO-35")).toBe(true);
      const listed = await listWorktrees(repoPath);
      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      expect(listed.worktrees.map((entry) => canonicalPath(entry.path))).not.toContain(canonicalPath(created.value.path));
    });

    it("still refuses over real work sitting beside the index, and leaves the tree as it found it", async () => {
      const created = await createWorktree(config(), "EO-36");
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      plantRepositoryIndex(created.value.path);
      writeFileSync(join(created.value.path, "agent-work.txt"), "half-finished\n");

      const refused = await removeWorktree(config(), "EO-36");

      expect(refused.ok).toBe(false);
      if (refused.ok) return;
      expect(refused.refusal).toBe("uncommitted-changes");
      expect(refused.reason).toContain("agent-work.txt");
      // A person sent to go and look at unsaved work must not be sent
      // looking at EO's own output.
      namesNoIndex(refused.reason);
      // "Left alone" is a claim about the disk. The index is not deleted
      // either: a refusal happens before anything is disposed of, so a
      // tree that was refused is exactly the tree that was found.
      expect(existsSync(join(created.value.path, "agent-work.txt"))).toBe(true);
      for (const directory of REPOSITORY_INDEX_DIRECTORIES) expect(existsSync(join(created.value.path, directory))).toBe(true);
    });

    it("lets git itself do the removal, having taken the index back out first", async () => {
      const created = await createWorktree(config(), "EO-37");
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      plantRepositoryIndex(created.value.path);
      const gitModule = await import("./git.js");
      const realGit = gitModule.git;
      const invocations: { args: string[]; ok: boolean }[] = [];
      vi.spyOn(gitModule, "git").mockImplementation(async (args, cwd, options) => {
        const outcome = await realGit(args, cwd, options);
        invocations.push({ args, ok: outcome.ok });
        return outcome;
      });

      const removed = await removeWorktree(config(), "EO-37");

      vi.restoreAllMocks();
      expect(removed.ok).toBe(true);
      const removals = invocations.filter((call) => call.args[0] === "worktree" && call.args[1] === "remove");
      expect(removals.length).toBeGreaterThan(0); // the assertions below are about calls that happened

      // The distinction the whole fix turns on. `--force` clears the
      // same obstruction and would also discard an agent's work in the
      // case the guard exists to catch, so a release nobody asked to
      // force must never reach for it.
      for (const call of removals) expect(call.args).not.toContain("--force");

      // And git accepted the tree, rather than refusing it to something
      // else. Teaching only EO's guard to ignore the index leaves git
      // still refusing over it, which sends an ordinary release down the
      // filesystem fallback built for trees git cannot remove at all
      // (issue #131) — a recursive delete standing in for the check that
      // is the actual protection here. That would pass a test that
      // watched the outcome alone, so what is asserted is the route:
      // git removed it, and there was no wreckage left to reconcile.
      for (const call of removals) expect(call.ok).toBe(true);
      expect(invocations.some((call) => call.args[0] === "worktree" && call.args[1] === "prune")).toBe(false);
    });

    it("still reaches the filesystem fallback for an indexed tree git cannot remove (issue #131)", async () => {
      const created = await createWorktree(config(), "EO-40");
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      plantRepositoryIndex(created.value.path);
      // A locked worktree is one git refuses to remove even with
      // --force, while `status` still reads it — the same fixture the
      // fallback's own test uses, now with an index in it. The gate on
      // that fallback was tightened to a raw-clean status, and the
      // tightening must not have made an indexed repository unable to
      // reach it: an index is exactly what disposal has just removed,
      // so by the time the gate is asked this tree is clean.
      await run(["worktree", "lock", created.value.path], repoPath);

      const removed = await removeWorktree(config(), "EO-40");

      expect(removed.ok).toBe(true);
      expect(existsSync(created.value.path)).toBe(false);
    });

    it("leaves a directory that merely shares the index's name where it is, whoever put it there", async () => {
      const created = await createWorktree(config(), "EO-39");
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      // `vendor/` has to be tracked for this to be the reported shape:
      // git collapses an untracked directory to its topmost entry, so
      // an untracked `vendor/` is printed as `?? vendor/` and caught by
      // the guard on its own name. It is the *nested* line —
      // `?? vendor/<index>/`, which only appears once the parent is
      // tracked — that the guard steps over.
      mkdirSync(join(created.value.path, "vendor"), { recursive: true });
      writeFileSync(join(created.value.path, "vendor", "keep.txt"), "tracked\n");
      await run(["add", "vendor/keep.txt"], created.value.path);
      await run(["commit", "-m", "vendor"], created.value.path);
      // Not an index: EO writes one at the root, and nothing it
      // generated is in here. `isRepositoryIndexPath` matches the
      // segment at any depth all the same, so EO's guard overlooks this
      // — which is safe only for as long as nothing downstream reads
      // "the guard was happy" as "there is nothing here to lose".
      for (const directory of REPOSITORY_INDEX_DIRECTORIES) {
        mkdirSync(join(created.value.path, "vendor", directory), { recursive: true });
        writeFileSync(join(created.value.path, "vendor", directory, "theirs.txt"), "not EO's\n");
      }
      const overlooked = await statusPorcelain(created.value.path);
      expect(overlooked.ok).toBe(true);
      if (!overlooked.ok) return;
      // The premise, established rather than assumed: git calls this
      // tree dirty and EO's guard does not.
      expect(overlooked.stdout).not.toBe("");

      const refused = await removeWorktree(config(), "EO-39");

      expect(refused.ok).toBe(false);
      if (refused.ok) return;
      // Git refuses over the untracked directory, and that refusal is
      // the answer rather than the cue to clear the tree by hand: the
      // filesystem fallback exists for a checkout nobody can account
      // for, and this is a checkout holding something somebody else put
      // there.
      expect(refused.refusal).toBe("removal-failed");
      expect(existsSync(created.value.path)).toBe(true);
      for (const directory of REPOSITORY_INDEX_DIRECTORIES) {
        expect(readFileSync(join(created.value.path, "vendor", directory, "theirs.txt"), "utf8")).toBe("not EO's\n");
      }
    });

    it("says so when it could not delete the index and git then refuses over the tree", async () => {
      const created = await createWorktree(config(), "EO-38");
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      plantRepositoryIndex(created.value.path);
      // Somebody's own untracked file, which is what git refuses over
      // now that the index itself is excluded (EO-207). The refusal is
      // the same one; what has changed is that an index alone no longer
      // produces it, and this test is about the sentence EO adds to a
      // refusal when its own disposal failed — not about which entry
      // git objected to.
      writeFileSync(join(created.value.path, "someone-elses-work.txt"), "half-finished\n");
      for (const directory of REPOSITORY_INDEX_DIRECTORIES) undeletable.add(directory);
      // A status git cannot read is what leaves nobody accounting for
      // the tree, so the filesystem fallback stays out of it and git's
      // own refusal — over the index still sitting there — is the
      // answer. Only that read is faked; the tree, the index and git's
      // refusal are real.
      const gitModule = await import("./git.js");
      vi.spyOn(gitModule, "statusPorcelain").mockResolvedValue({ ok: false, error: "fatal: could not read status" });

      const refused = await removeWorktree(config(), "EO-38");

      vi.restoreAllMocks();
      expect(refused.ok).toBe(false);
      if (refused.ok) return;
      expect(refused.refusal).toBe("removal-failed");
      // Without this the message reads "contains untracked files" about
      // a tree EO had just cleared its own index out of, and the reader
      // has nowhere to go.
      expect(refused.reason).toContain("could not delete the index it generated");
      expect(refused.reason).toContain("EACCES: permission denied, rmdir");
      expect(existsSync(created.value.path)).toBe(true); // nothing was destroyed on the way
    });
  });

  it("refuses when git reports a removal the disk does not show, instead of taking git's word for it", async () => {
    const created = await createWorktree(config(), "EO-33");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    // A `git worktree remove` that says it worked and leaves the
    // checkout where it was. Only that answer is faked; the tree, the
    // branch and the status check are real.
    const gitModule = await import("./git.js");
    const realGit = gitModule.git;
    vi.spyOn(gitModule, "git").mockImplementation(async (args, cwd, options) =>
      args[0] === "worktree" && args[1] === "remove" ? { ok: true, stdout: "" } : realGit(args, cwd, options),
    );

    const refused = await removeWorktree(config(), "EO-33", { deleteBranch: true });

    vi.restoreAllMocks();
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.reason).toContain("still on disk");
    expect(existsSync(created.value.path)).toBe(true);
    // Checked before the branch went: a refusal must not leave the work
    // harder to reach than it was.
    expect(await branchExists(repoPath, "eo/EO-33")).toBe(true);
  });

  // Issue #131: `git worktree remove` failing used to be the whole
  // answer, and the checkout stayed on disk with nothing to be done
  // about it. The two git failures below are real ones, reproducible on
  // any platform — Windows' path-length failure is not, and lands in
  // exactly the same branch.
  describe("when git cannot remove the tree", () => {
    /** A worktree git refuses to remove, and whose status it cannot read either. */
    async function brokenWorktree(itemKey: string): Promise<string> {
      const created = await createWorktree(config(), itemKey);
      if (!created.ok) throw new Error(`fixture failed: ${created.reason}`);
      writeFileSync(join(created.value.path, "left-behind.txt"), "still here\n");
      rmSync(join(created.value.path, ".git"));
      return created.value.path;
    }

    it("clears the directory itself, and prunes git's bookkeeping after", async () => {
      const path = await brokenWorktree("EO-24");

      const removed = await removeWorktree(config(), "EO-24", { force: true });

      expect(removed.ok).toBe(true);
      expect(existsSync(path)).toBe(false);
      const listed = await listWorktrees(repoPath);
      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      // Pruned, not merely deleted: git still listing a worktree that is
      // no longer there is the other half of the stranding.
      expect(listed.worktrees.map((entry) => canonicalPath(entry.path))).not.toContain(canonicalPath(path));
    });

    it("falls back for a tree whose status reads clean, without needing force", async () => {
      const created = await createWorktree(config(), "EO-25");
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      // A locked worktree is one git refuses to remove even with
      // --force, while `status` still reads it and finds it clean —
      // which is the fallback's other gate.
      await run(["worktree", "lock", created.value.path], repoPath);

      const removed = await removeWorktree(config(), "EO-25");

      expect(removed.ok).toBe(true);
      expect(existsSync(created.value.path)).toBe(false);
      const listed = await listWorktrees(repoPath);
      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      // `worktree prune` keeps locked entries, so this is the case where
      // the registration outlives the checkout unless the lock is
      // released first — and a registration git still lists is one
      // `ensureWorktree` would reuse, pointing at nothing.
      expect(listed.worktrees.map((entry) => basename(entry.path))).not.toContain("EO-25");
    });

    it("returns git's error unchanged and deletes nothing when the status could not be read and force was not given", async () => {
      const path = await brokenWorktree("EO-26");
      const gitFailure = await git(["worktree", "remove", path], repoPath);
      expect(gitFailure.ok).toBe(false);
      if (gitFailure.ok) return;

      const refused = await removeWorktree(config(), "EO-26");

      expect(refused.ok).toBe(false);
      if (refused.ok) return;
      expect(refused.reason).toBe(`Could not remove the worktree for EO-26 at ${path}: ${gitFailure.error}`);
      // A removal that failed, which is not the same claim as work left
      // unsaved — nothing here established anything about the contents.
      expect(refused.refusal).toBe("removal-failed");
      // Nobody could account for what is in there, so it is left exactly as it was.
      expect(existsSync(join(path, "left-behind.txt"))).toBe(true);
    });

    it("names both failures when neither route can remove the tree", async () => {
      const path = await brokenWorktree("EO-27");
      const gitFailure = await git(["worktree", "remove", "--force", path], repoPath);
      expect(gitFailure.ok).toBe(false);
      if (gitFailure.ok) return;
      undeletable.add("EO-27");

      const refused = await removeWorktree(config(), "EO-27", { force: true });

      expect(refused.ok).toBe(false);
      if (refused.ok) return;
      expect(refused.reason).toContain(gitFailure.error); // what git said
      expect(refused.reason).toContain("EACCES"); // and what the filesystem said
      expect(existsSync(path)).toBe(true);
    });

    it("refuses when the checkout went but git still lists it, rather than leaving a reuse pointing at nothing", async () => {
      const created = await createWorktree(config(), "EO-29");
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      await run(["worktree", "lock", created.value.path], repoPath);
      // Releasing the lock is what lets the prune land, so a git that
      // cannot release it is the state where the registration outlives
      // the checkout. Only that one invocation is faked; the lock, the
      // delete, the prune and the listing are all real.
      const gitModule = await import("./git.js");
      const realGit = gitModule.git;
      vi.spyOn(gitModule, "git").mockImplementation(async (args, cwd, options) =>
        args[0] === "worktree" && args[1] === "unlock" ? { ok: false, error: "fatal: could not unlock" } : realGit(args, cwd, options),
      );

      const refused = await removeWorktree(config(), "EO-29");

      vi.restoreAllMocks();
      expect(refused.ok).toBe(false);
      if (refused.ok) return;
      expect(refused.reason).toContain("git still lists it");
      expect(existsSync(created.value.path)).toBe(false); // the directory did go
      const listed = await listWorktrees(repoPath);
      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      expect(listed.worktrees.map((entry) => basename(entry.path))).toContain("EO-29"); // and this is what was left behind
    });

    // git prints the fully resolved path and EO holds the one it was
    // configured with, and the two differ on macOS (/tmp is
    // /private/tmp) and on Windows (8.3 short names) — the same trap
    // `canonicalPath` exists for. A path that has just been deleted
    // cannot be resolved any more, so matching it against git's listing
    // has to go through the parent, and a check that gets this wrong
    // reports the stale registration above as no registration at all.
    it.skipIf(process.platform === "win32")("recognises the leftover registration through a symlinked worktree root", async () => {
      const real = join(scratch, "real trees");
      const linked = join(scratch, "linked trees");
      mkdirSync(real, { recursive: true });
      symlinkSync(real, linked);
      const linkedConfig = config({ worktreeRoot: linked });
      const created = await createWorktree(linkedConfig, "EO-31");
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      await run(["worktree", "lock", created.value.path], repoPath);
      const gitModule = await import("./git.js");
      const realGit = gitModule.git;
      vi.spyOn(gitModule, "git").mockImplementation(async (args, cwd, options) =>
        args[0] === "worktree" && args[1] === "unlock" ? { ok: false, error: "fatal: could not unlock" } : realGit(args, cwd, options),
      );

      const refused = await removeWorktree(linkedConfig, "EO-31");

      vi.restoreAllMocks();
      // git registered <scratch>/real trees/EO-31; EO deleted
      // <scratch>/linked trees/EO-31. Same worktree, and it is still on
      // git's books.
      expect(refused.ok).toBe(false);
      if (refused.ok) return;
      expect(refused.reason).toContain("git still lists it");
    });

    it("leaves a lock in place when it could not remove the tree the lock protects", async () => {
      const created = await createWorktree(config(), "EO-34");
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      await run(["worktree", "lock", created.value.path], repoPath);
      undeletable.add("EO-34");

      const refused = await removeWorktree(config(), "EO-34");

      expect(refused.ok).toBe(false);
      expect(existsSync(created.value.path)).toBe(true);
      // The lock is why git refused in the first place. A removal that
      // could not go through must not leave the tree less protected
      // than it found it.
      const listed = await git(["worktree", "list", "--porcelain"], repoPath);
      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      const entry = listed.stdout.split("\n\n").find((block) => block.includes(`${basename(created.value.path)}\n`));
      expect(entry).toContain("locked");
    });

    it("refuses when git cannot say whether the registration went, rather than reading silence as a clean removal", async () => {
      const path = await brokenWorktree("EO-32");
      // The two git calls that would have settled it, both failing: the
      // prune that should have dropped the entry, and the listing that
      // would have shown whether it did. The delete itself is real, so
      // the checkout genuinely goes — what is missing is any way to
      // know git followed.
      const gitModule = await import("./git.js");
      const realGit = gitModule.git;
      vi.spyOn(gitModule, "git").mockImplementation(async (args, cwd, options) =>
        args[0] === "worktree" && args[1] === "prune" ? { ok: false, error: "fatal: could not read prune" } : realGit(args, cwd, options),
      );
      vi.spyOn(gitModule, "listWorktrees").mockResolvedValue({ ok: false, error: "fatal: could not read list" });

      const refused = await removeWorktree(config(), "EO-32", { force: true });

      vi.restoreAllMocks();
      expect(refused.ok).toBe(false);
      if (refused.ok) return;
      expect(refused.reason).toContain("could not be established");
      expect(refused.reason).toContain("fatal: could not read list"); // what could not be checked
      expect(refused.reason).toContain("fatal: could not read prune"); // and what was meant to have settled it
      expect(existsSync(path)).toBe(false); // the directory did go — that is not the part in doubt
    });

    it("refuses when it cannot establish that the tree went, rather than assuming it did", async () => {
      const path = await brokenWorktree("EO-28");
      // Still on disk, and unreadable with it: a check that throws
      // EACCES says nothing about whether the tree is gone, and the one
      // thing it must not be read as is "gone".
      undeletable.add("EO-28");
      uninspectable.add("EO-28");

      const refused = await removeWorktree(config(), "EO-28", { force: true });

      expect(refused.ok).toBe(false);
      if (refused.ok) return;
      expect(refused.reason).toContain("could not be established");
      expect(refused.reason).toContain("EACCES: permission denied, rmdir"); // the delete's own failure, kept
      expect(existsSync(path)).toBe(true);
    });
  });
});

describe("removalFailureReason", () => {
  // The failure from issue #131, verbatim: git names the worktree root
  // it was asked to delete, and the filesystem names the nested path it
  // actually choked on.
  const failure = {
    itemKey: "EO-30",
    path: "C:/Users/dev/.eo/worktrees/EO-30",
    gitError: "error: failed to delete 'C:/Users/dev/.eo/worktrees/EO-30': Filename too long",
    fsError: "ENAMETOOLONG: name too long, unlink 'C:/Users/dev/.eo/worktrees/EO-30/node_modules/.pnpm/...'",
  };

  it("names both the git error and the filesystem error", () => {
    const reason = removalFailureReason({ ...failure, platform: "linux" });

    expect(reason).toContain(failure.gitError);
    expect(reason).toContain(failure.fsError);
  });

  it("names the OS-level remediation on Windows, since core.longpaths is already set and cannot fix this", () => {
    const reason = removalFailureReason({ ...failure, platform: "win32" });

    expect(reason).toContain("long-path support");
    expect(reason).toContain("LongPathsEnabled");
  });

  it("offers no long-path remediation for a failure that has nothing to do with path length", () => {
    const reason = removalFailureReason({
      ...failure,
      gitError: "fatal: validation failed, cannot remove working tree",
      fsError: "EACCES: permission denied, rmdir",
      platform: "win32",
    });

    expect(reason).not.toContain("LongPathsEnabled");
  });

  it("offers it on Windows only, where it is the remediation that exists", () => {
    const reason = removalFailureReason({ ...failure, platform: "darwin" });

    expect(reason).not.toContain("LongPathsEnabled");
  });
});

describe("ensureWorktree", () => {
  it("reuses the item's existing worktree instead of tripping over its own branch", async () => {
    await createWorktree(config(), "EO-1");

    const again = await ensureWorktree(config(), "EO-1");

    expect(again.ok).toBe(true);
    if (again.ok) expect(again.value.path).toBe(worktreePathFor("EO-1", worktreeRoot));
  });

  it("re-attaches to its branch after the worktree was released", async () => {
    // The reason releasing a worktree is safe at all. Cleanup keeps the
    // branch and drops the checkout — without this, the next dispatch
    // hit "the branch eo/EO-1 already exists" and the item could never
    // move again. Releasing frees disk; it must not retire an item.
    await createWorktree(config(), "EO-1");
    const path = worktreePathFor("EO-1", worktreeRoot);
    writeFileSync(join(path, "work.txt"), "committed work\n");
    await run(["add", "-A"], path);
    await run(["commit", "-m", "agent work"], path);
    expect((await removeWorktree(config(), "EO-1")).ok).toBe(true);
    expect(existsSync(path)).toBe(false);

    const again = await ensureWorktree(config(), "EO-1");

    expect(again.ok).toBe(true);
    // Back on the same branch with the earlier commit still there —
    // re-attached, not started over.
    expect(existsSync(join(path, "work.txt"))).toBe(true);
    const log = await git(["log", "--oneline"], path);
    expect(log.ok && log.stdout).toContain("agent work");
  });

  it("says so when the branch is checked out somewhere unexpected, rather than letting git fail mid-dispatch", async () => {
    await createWorktree(config(), "EO-1");
    // Someone registered the branch at a path EO doesn't manage.
    const moved = join(scratch, "elsewhere");
    await run(["worktree", "move", worktreePathFor("EO-1", worktreeRoot), moved], repoPath);

    const again = await ensureWorktree(config(), "EO-1");

    expect(again.ok).toBe(false);
    if (!again.ok) {
      expect(again.reason).toContain("already checked out");
      expect(again.reason).toContain("elsewhere");
    }
  });

  describe("a worktree path that is already occupied (issue #143)", () => {
    /**
     * Every git invocation `worktrees.ts` makes, so a test can assert
     * one of them never happened.
     *
     * `git worktree add` is the command at the heart of #143: it refuses
     * a path that already holds anything, so a preparation that reaches
     * it for a checkout that is already sitting there has failed no
     * matter what it does afterwards. Asserting on the result alone
     * would pass for an implementation that deleted the tree and cut it
     * again, which is the opposite of re-attaching to it.
     */
    async function recordGit(): Promise<string[][]> {
      const gitModule = await import("./git.js");
      const realGit = gitModule.git;
      const calls: string[][] = [];
      vi.spyOn(gitModule, "git").mockImplementation(async (args, cwd, options) => {
        calls.push(args);
        return realGit(args, cwd, options);
      });
      return calls;
    }

    /** The listing that misses the reuse fast path — git could not produce one at all. */
    async function unreadableListing(): Promise<void> {
      const gitModule = await import("./git.js");
      vi.spyOn(gitModule, "listWorktrees").mockResolvedValue({ ok: false, error: "fatal: could not read the worktree list" });
    }

    it("re-attaches to the checkout that survived on disk when git's listing does not report it", async () => {
      // #143 itself. The worktree is there, on the item's own branch,
      // with committed work in it — and the reuse fast path is missed
      // because the listing did not come back. Every route out of that
      // used to end in `git worktree add`, which answered
      // `fatal: '<path>' already exists`, and the dispatch was parked.
      await createWorktree(config(), "EO-1");
      const path = worktreePathFor("EO-1", worktreeRoot);
      writeFileSync(join(path, "work.txt"), "committed work\n");
      await run(["add", "-A"], path);
      await run(["commit", "-m", "agent work"], path);
      await unreadableListing();
      const calls = await recordGit();

      const again = await ensureWorktree(config(), "EO-1");

      vi.restoreAllMocks();
      expect(again.ok).toBe(true);
      if (!again.ok) return;
      expect(again.value.path).toBe(path);
      expect(calls.some((args) => args[0] === "worktree" && args[1] === "add")).toBe(false);
      expect(existsSync(join(path, "work.txt"))).toBe(true); // the same checkout, not a fresh one
    });

    it("re-attaches to it when the listing comes back without the path in it", async () => {
      // The other half of the same miss: a listing that succeeded and
      // simply has no entry for this path — a registration pruned while
      // the checkout stayed where it was.
      await createWorktree(config(), "EO-2");
      const path = worktreePathFor("EO-2", worktreeRoot);
      const gitModule = await import("./git.js");
      vi.spyOn(gitModule, "listWorktrees").mockResolvedValue({ ok: true, worktrees: [{ path: repoPath, branch: "main", head: null }] });
      const calls = await recordGit();

      const again = await ensureWorktree(config(), "EO-2");

      vi.restoreAllMocks();
      expect(again.ok).toBe(true);
      if (!again.ok) return;
      expect(again.value.path).toBe(path);
      expect(calls.some((args) => args[0] === "worktree" && args[1] === "add")).toBe(false);
    });

    it("refuses a path holding another branch, naming both what is there and what belongs there", async () => {
      await createWorktree(config(), "EO-3");
      const path = worktreePathFor("EO-3", worktreeRoot);
      await run(["checkout", "-b", "somebody-elses-branch"], path);

      const refused = await ensureWorktree(config(), "EO-3");

      expect(refused.ok).toBe(false);
      if (refused.ok) return;
      expect(refused.reason).toContain("somebody-elses-branch"); // what was found
      expect(refused.reason).toContain("eo/EO-3"); // what was expected
    });

    it("refuses a path holding something that is not a checkout, saying what is in it", async () => {
      // The refusal this replaces was git's own `already exists`, which
      // names a path and nothing about why it is in the way.
      await createWorktree(config(), "EO-4");
      const path = worktreePathFor("EO-4", worktreeRoot);
      expect((await removeWorktree(config(), "EO-4")).ok).toBe(true);
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, "leftover.txt"), "not a checkout\n");

      const refused = await ensureWorktree(config(), "EO-4");

      expect(refused.ok).toBe(false);
      if (refused.ok) return;
      expect(refused.reason).toContain("leftover.txt");
      expect(refused.reason).not.toContain("already exists");
    });

    it("refuses a checkout of a different repository, even on a branch of the same name", async () => {
      // Handing this one to an agent would be worse than refusing it:
      // the commits would land in somebody else's history.
      const other = await makeRepo("another repo");
      const path = worktreePathFor("EO-5", worktreeRoot);
      await run(["worktree", "add", path, "-b", "eo/EO-5", "main"], other);

      const refused = await ensureWorktree(config(), "EO-5");

      expect(refused.ok).toBe(false);
      if (refused.ok) return;
      expect(refused.reason).toContain("different repository");
      expect(refused.reason).not.toContain("already exists");
    });

    it("refuses a detached checkout rather than reading it as the item's branch", async () => {
      await createWorktree(config(), "EO-6");
      await run(["checkout", "--detach"], worktreePathFor("EO-6", worktreeRoot));

      const refused = await ensureWorktree(config(), "EO-6");

      expect(refused.ok).toBe(false);
      if (refused.ok) return;
      expect(refused.reason).toContain("detached HEAD");
    });

    it("re-attaches straight through an empty directory left at the path, which git accepts", async () => {
      // `git worktree add` refuses a path that exists only when there is
      // something in it, so an empty directory must not become a
      // refusal of its own.
      await createWorktree(config(), "EO-7");
      const path = worktreePathFor("EO-7", worktreeRoot);
      writeFileSync(join(path, "work.txt"), "committed work\n");
      await run(["add", "-A"], path);
      await run(["commit", "-m", "agent work"], path);
      expect((await removeWorktree(config(), "EO-7")).ok).toBe(true);
      mkdirSync(path, { recursive: true });

      const again = await ensureWorktree(config(), "EO-7");

      expect(again.ok).toBe(true);
      expect(existsSync(join(path, "work.txt"))).toBe(true); // re-attached, with its commit
    });

    it("refuses when it cannot read the path at all, rather than reading an unreadable path as a free one", async () => {
      await createWorktree(config(), "EO-8");
      await unreadableListing();
      uninspectable.add("EO-8");

      const refused = await ensureWorktree(config(), "EO-8");

      vi.restoreAllMocks();
      expect(refused.ok).toBe(false);
      if (refused.ok) return;
      expect(refused.reason).toContain("EACCES");
    });
  });

  describe("resolveStartPoint (EO-10 / KAN-42)", () => {
    it("cuts a new branch from the resolver's start point", async () => {
      await run(["checkout", "-b", "eo/DEP"], repoPath);
      writeFileSync(join(repoPath, "dep-only.txt"), "x\n");
      await run(["add", "."], repoPath);
      await run(["commit", "-m", "dependency work"], repoPath);
      await run(["checkout", "main"], repoPath);

      const result = await ensureWorktree(config(), "EO-1", async () => ({ ok: true, value: "eo/DEP" }));

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(existsSync(join(result.value.path, "dep-only.txt"))).toBe(true);
    });

    it("refuses without creating a branch when the resolver escalates", async () => {
      const result = await ensureWorktree(config(), "EO-1", async () => ({ ok: false, reason: "two dependencies are equally close" }));

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toContain("equally close");
      expect(existsSync(worktreePathFor("EO-1", worktreeRoot))).toBe(false);
      expect(await branchExists(repoPath, "eo/EO-1")).toBe(false);
    });

    it("never calls the resolver when the worktree already exists", async () => {
      await createWorktree(config(), "EO-1");
      const neverCalled = async (): Promise<never> => {
        throw new Error("must not be called when reusing an existing worktree");
      };

      const result = await ensureWorktree(config(), "EO-1", neverCalled);

      expect(result.ok).toBe(true);
    });

    it("never calls the resolver when re-attaching a released worktree", async () => {
      await createWorktree(config(), "EO-1");
      expect((await removeWorktree(config(), "EO-1")).ok).toBe(true);
      const neverCalled = async (): Promise<never> => {
        throw new Error("must not be called when re-attaching");
      };

      const result = await ensureWorktree(config(), "EO-1", neverCalled);

      expect(result.ok).toBe(true);
    });
  });

  describe("BranchNaming override (EO-16)", () => {
    it("uses naming.branch verbatim, bypassing prefix/jiraKey computation entirely", async () => {
      const naming: BranchNaming = { branch: "acme/EO-1" };

      const created = await ensureWorktree(config(), "EO-1", undefined, naming);

      expect(created.ok).toBe(true);
      if (!created.ok) return;
      expect(created.value.branch).toBe("acme/EO-1");
      expect(await branchExists(repoPath, "acme/EO-1")).toBe(true);
    });

    it("reuses the same worktree on a later call even if prefix/jiraKey naming would now compute differently", async () => {
      const first = await ensureWorktree(config(), "EO-1", undefined, { branch: "acme/EO-1" });
      expect(first.ok).toBe(true);

      // Simulates a second dispatch after the item was linked to Jira
      // and/or the prefix setting changed: the caller (dispatchWorkspace.ts)
      // always passes the *stored* branch once one exists, never a fresh
      // computation, which is what this override represents.
      const second = await ensureWorktree(config(), "EO-1", undefined, { branch: "acme/EO-1" });

      expect(second).toEqual(first);
    });
  });
});

describe("listHeldWorktrees", () => {
  it("reports size and uncommitted work per tree, and ignores trees that are not ours", async () => {
    await createWorktree(config(), "EO-1");
    await createWorktree(config(), "EO-2");
    writeFileSync(join(worktreePathFor("EO-2", worktreeRoot), "scratch.txt"), "x".repeat(5000));

    const held = await listHeldWorktrees(config());

    expect(held.ok).toBe(true);
    if (!held.ok) return;
    // The main checkout is on `main`, not `eo/`, so it is none of our business.
    expect(held.value.map((entry) => entry.itemKey).sort()).toEqual(["EO-1", "EO-2"]);

    const two = held.value.find((entry) => entry.itemKey === "EO-2")!;
    expect(two.uncommittedChanges).toBe(1);
    expect(two.sizeBytes).toBeGreaterThan(5000);
    expect(held.value.find((entry) => entry.itemKey === "EO-1")?.uncommittedChanges).toBe(0);
  });

  it("uses the currently configured prefix, not a hardcoded eo/, to decide which trees are ours (EO-16)", async () => {
    await createWorktree(config(), "EO-5", undefined, { prefix: "acme" });
    // A worktree under an unrelated branch name — not "acme/", and not
    // the default "eo/" either — is none of our business.
    await run(["worktree", "add", join(scratch, "unrelated"), "-b", "unrelated/EO-6"], repoPath);

    const held = await listHeldWorktrees(config(), "acme");

    expect(held.ok).toBe(true);
    if (!held.ok) return;
    expect(held.value.map((entry) => entry.itemKey)).toEqual(["EO-5"]);
    expect(held.value[0]?.branch).toBe("acme/EO-5");
  });
});

describe("listStaleWorktrees", () => {
  it("reports EO worktrees with no active run, and skips those still working", async () => {
    await createWorktree(config(), "EO-30");
    await createWorktree(config(), "EO-31");

    const stale = await listStaleWorktrees(config(), (itemKey) => itemKey === "EO-31");

    expect(stale.ok).toBe(true);
    if (!stale.ok) return;
    expect(stale.value.map((entry) => entry.itemKey)).toEqual(["EO-30"]);
  });

  it("never reports the main checkout or a human's own worktree", async () => {
    await createWorktree(config(), "EO-32");
    // A worktree a human made for their own work, not on an eo/ branch.
    await run(["worktree", "add", join(scratch, "my own branch"), "-b", "my-feature"], repoPath);

    const stale = await listStaleWorktrees(config(), () => false);

    expect(stale.ok).toBe(true);
    if (!stale.ok) return;
    expect(stale.value.map((entry) => entry.itemKey)).toEqual(["EO-32"]);
    expect(stale.value.some((entry) => entry.path === repoPath)).toBe(false);
  });

  it("reports a checkout under EO's own root on a branch a person named, which carries no prefix (EO-365)", async () => {
    await run(["branch", "feature/limits"], repoPath);
    await run(["worktree", "add", worktreePathFor("EO-34", config().worktreeRoot), "feature/limits"], repoPath);
    await run(["worktree", "add", join(scratch, "my own branch"), "-b", "my-feature"], repoPath);

    const stale = await listStaleWorktrees(config(), () => false);
    const held = await listHeldWorktrees(config());

    expect(stale.ok && stale.value.map((entry) => entry.itemKey)).toEqual(["EO-34"]);
    expect(held.ok && held.value.map((entry) => entry.branch)).toEqual(["feature/limits"]);
  });

  it("parses worktree paths that contain spaces", async () => {
    const created = await createWorktree(config(), "EO-33");
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const listed = await listWorktrees(repoPath);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    // Canonical on both sides: git resolves symlinks (/tmp on macOS) and short names (Windows).
    expect(listed.worktrees.map((entry) => canonicalPath(entry.path))).toContain(canonicalPath(created.value.path));
  });

  it("detects a worktree under the currently configured prefix, and ignores one under an unrelated branch name (EO-16)", async () => {
    await createWorktree(config(), "EO-34", undefined, { prefix: "acme" });
    await run(["worktree", "add", join(scratch, "someone else"), "-b", "someone-else/EO-35"], repoPath);

    const stale = await listStaleWorktrees(config(), () => false, "acme");

    expect(stale.ok).toBe(true);
    if (!stale.ok) return;
    expect(stale.value.map((entry) => entry.itemKey)).toEqual(["EO-34"]);
  });

  it("still finds a worktree cut under the default eo/ prefix when the caller doesn't pass one", async () => {
    await createWorktree(config(), "EO-36");

    const stale = await listStaleWorktrees(config(), () => false);

    expect(stale.ok).toBe(true);
    if (!stale.ok) return;
    expect(stale.value.map((entry) => entry.itemKey)).toEqual(["EO-36"]);
  });
});

describe("checkRepoReady", () => {
  it("reports the current branch for a healthy repo", async () => {
    const result = await checkRepoReady(config());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.branch).toBe("main");
  });

  it("fails clearly when the path is not a repo", async () => {
    const result = await checkRepoReady(config({ repoPath: join(scratch, "nope") }));
    expect(result.ok).toBe(false);
  });
});

/**
 * Cancelling a worktree run (EO-77).
 *
 * `cancelRun` registered the run and discarded whatever came back, so the
 * board said "cancelled" while git carried on — accurate about the run
 * and wrong about the machine. The checks below are between steps rather
 * than inside them: `show-ref` and `worktree list` return in
 * milliseconds, so there is nothing to interrupt, and the commands that
 * can actually block take the signal itself.
 */
describe("narrating", () => {
  it("says which ref the branch was actually cut from", async () => {
    // The line worth having a week later, and the one nothing else
    // records: `git` knows the start point for exactly as long as the
    // command runs.
    const said: string[] = [];

    const result = await ensureWorktree(config(), "EO-9", async () => ({ ok: true as const, value: "main" }), {}, { onProgress: (text) => said.push(text) });

    expect(result.ok).toBe(true);
    expect(said.join("\n")).toContain("Working out where to cut");
    expect(said.join("\n")).toContain(`Cut "eo/EO-9" from main`);
  });

  it("says it reused a checkout rather than saying nothing", async () => {
    // Every dispatch after the first takes this path. A run that says
    // nothing and a run that quietly did nothing look identical.
    await ensureWorktree(config(), "EO-9", async () => ({ ok: true as const, value: "main" }));

    const said: string[] = [];
    await ensureWorktree(config(), "EO-9", async () => ({ ok: true as const, value: "main" }), {}, { onProgress: (text) => said.push(text) });

    expect(said.join("\n")).toContain("Reusing the worktree already at");
  });

  it("says nothing about a start point it never resolved", async () => {
    // A reused worktree does not re-decide where its branch came from —
    // that was settled once, and narrating it again would be EO claiming
    // to have done work it skipped.
    await ensureWorktree(config(), "EO-9", async () => ({ ok: true as const, value: "main" }));

    const said: string[] = [];
    await ensureWorktree(config(), "EO-9", async () => ({ ok: true as const, value: "main" }), {}, { onProgress: (text) => said.push(text) });

    expect(said.join("\n")).not.toContain("Working out where to cut");
  });
});

describe("cancelling", () => {
  it("cuts nothing when the run was already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await ensureWorktree(config(), "EO-9", undefined, {}, { signal: controller.signal });

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.reason).toContain("cancelled");
    // Nothing was created, which is the part that matters: a cancelled
    // run must not leave a branch behind for the next one to trip over.
    expect(existsSync(worktreePathFor("EO-9", worktreeRoot))).toBe(false);
    expect(await branchExists(repoPath, "eo/EO-9")).toBe(false);
  });

  it("stops after resolving a start point when the cancel landed while it resolved", async () => {
    // The realistic case: the resolution is the slow half, so a person
    // clicking Cancel almost always does it during that call rather than
    // before it.
    const controller = new AbortController();

    const result = await ensureWorktree(
      config(),
      "EO-9",
      async () => {
        controller.abort();
        return { ok: true as const, value: "main" };
      },
      {},
      { signal: controller.signal },
    );

    expect(result.ok).toBe(false);
    expect(await branchExists(repoPath, "eo/EO-9")).toBe(false);
  });

  it("blames the cancel, not the repository, when the cancel is what broke the resolution", async () => {
    // Killing the fetches a start point is made of does not produce a
    // refusal saying "cancelled" — it produces whatever they degrade
    // into: a base ref that will not resolve, or a dependency that looks
    // unmerged because the fetch that would have said otherwise was the
    // one killed. Reading the result before the signal reported one of
    // those, so a run the person themselves stopped came back blaming
    // their repository — and, now that builtins keep a transcript, wrote
    // it there in red.
    const controller = new AbortController();

    const result = await ensureWorktree(
      config(),
      "EO-9",
      async () => {
        controller.abort();
        return { ok: false as const, reason: "`origin` has no branch `main`." };
      },
      {},
      { signal: controller.signal },
    );

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.reason).toContain("cancelled");
    expect(result.ok ? "" : result.reason).not.toContain("no branch");
  });
});

/**
 * EO's own directories, kept out of the checkout's `git status`
 * (EO-207).
 *
 * Two of them are written inside a worktree EO does not own: the
 * repository index, and the skills a Codex agent reads. Neither was
 * excluded from anything — the index stayed out of commits because
 * implementers kept remembering, which is a guard held up by agent
 * discipline and exactly what invariant #8 is against. It already cost
 * something: EO's own delete-safety check counts an unignored index as
 * work a person might want to look at, and refused to delete an item
 * over one.
 *
 * `excludes.test.ts` covers the file itself. What is asserted here is
 * that a worktree EO hands back is one where this has already happened.
 */
describe("EO's generated directories in a worktree", () => {
  /** What EO writes into a checkout, planted where EO plants it. */
  function plantGenerated(worktreePath: string): void {
    for (const directory of [".agent/skills/pr-review", ...REPOSITORY_INDEX_DIRECTORIES.map((name) => `${name}/inner`)]) {
      mkdirSync(join(worktreePath, directory), { recursive: true });
      writeFileSync(join(worktreePath, directory, "generated.txt"), "generated\n");
    }
  }

  it("is a fresh worktree where .agent and the index are already excluded", async () => {
    const created = await createWorktree(config(), "EO-207");
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    plantGenerated(created.value.path);

    expect(await status(created.value.path)).toBe("");
  });

  it("does not write a .gitignore anywhere to do it", async () => {
    // EO drives repositories it does not own. A tracked `.gitignore` is
    // somebody's file: editing it writes into their project to suit EO's
    // plumbing, and it lands in the diff under review.
    writeFileSync(join(repoPath, ".gitignore"), "node_modules/\n");
    await run(["add", ".gitignore"], repoPath);
    await run(["commit", "-m", "their ignore file"], repoPath);
    const before = readFileSync(join(repoPath, ".gitignore"));

    const created = await createWorktree(config(), "EO-207");
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(readFileSync(join(repoPath, ".gitignore"))).toEqual(before);
    expect(existsSync(join(created.value.path, ".gitignore"))).toBe(true); // theirs, checked out
    // Text with line endings normalised, not bytes: this copy came out of a
    // fresh checkout, and git rewrites LF to CRLF on the way out when
    // `core.autocrlf` is on, as it is by default on Windows. What is being
    // asserted is that the content is still theirs and EO wrote nothing —
    // not which line ending git chose to check it out with.
    expect(readFileSync(join(created.value.path, ".gitignore"), "utf8").replace(/\r\n/g, "\n")).toEqual(before.toString("utf8"));
  });

  it("refuses to release a worktree holding .agent files EO did not write", async () => {
    // The exclusion has a cost a review caught: `.agent` is out of `git
    // status`, so it is also out of git's own refusal to remove a
    // worktree with untracked content in it, and `git worktree remove`
    // deletes ignored content along with the rest. EO hid the directory,
    // so EO owes the protection back — narrowed to the one directory it
    // hid and to content it cannot prove it wrote.
    const created = await createWorktree(config(), "EO-207");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    mkdirSync(join(created.value.path, ".agent", "skills", "theirs"), { recursive: true });
    writeFileSync(join(created.value.path, ".agent", "notes.md"), "mine, and nowhere else\n");
    writeFileSync(join(created.value.path, ".agent", "skills", "theirs", "SKILL.md"), "theirs\n");
    // The premise: git says this tree is clean, because EO told it to.
    expect(await status(created.value.path)).toBe("");

    const refused = await removeWorktree(config(), "EO-207");

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.refusal).toBe("uncommitted-changes");
    expect(refused.reason).toContain(".agent/notes.md");
    expect(refused.reason).toContain(".agent/skills/theirs");
    // Still there, which is the whole point.
    expect(readFileSync(join(created.value.path, ".agent", "notes.md"), "utf8")).toBe("mine, and nowhere else\n");
    expect(readFileSync(join(created.value.path, ".agent", "skills", "theirs", "SKILL.md"), "utf8")).toBe("theirs\n");
  });

  it("releases one whose .agent content the repository tracks", async () => {
    // The guard asks two questions and needs both. A repository is free
    // to keep files under `.agent` — EO's exclusion does nothing to a
    // tracked path — and removing a worktree full of tracked files loses
    // nothing, because the branch still has them. Refusing over those
    // would strand every worktree of such a repository, which is the
    // failure EO-170 records for the generated index.
    const created = await createWorktree(config(), "EO-207");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    mkdirSync(join(created.value.path, ".agent", "prompts"), { recursive: true });
    writeFileSync(join(created.value.path, ".agent", "prompts", "house-style.md"), "theirs, and committed\n");
    // `-f`, because EO has just excluded the directory — which is
    // exactly the shape this is about: excluded, and tracked anyway.
    await run(["add", "-f", ".agent/prompts/house-style.md"], created.value.path);
    await run(["commit", "-m", "the repository keeps its own .agent"], created.value.path);

    const removed = await removeWorktree(config(), "EO-207");

    expect(removed.ok).toBe(true);
    expect(existsSync(created.value.path)).toBe(false);
  });

  it("still refuses over an untracked file beside the tracked ones", async () => {
    // And the guard is not blunted by the file next to it: a directory
    // holding one of each is reported by git at file granularity, so the
    // untracked one still refuses on its own.
    const created = await createWorktree(config(), "EO-207");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    mkdirSync(join(created.value.path, ".agent", "prompts"), { recursive: true });
    writeFileSync(join(created.value.path, ".agent", "prompts", "house-style.md"), "committed\n");
    await run(["add", "-f", ".agent/prompts/house-style.md"], created.value.path);
    await run(["commit", "-m", "one of each"], created.value.path);
    writeFileSync(join(created.value.path, ".agent", "prompts", "draft.md"), "never committed anywhere\n");

    const refused = await removeWorktree(config(), "EO-207");

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.refusal).toBe("uncommitted-changes");
    expect(readFileSync(join(created.value.path, ".agent", "prompts", "draft.md"), "utf8")).toBe("never committed anywhere\n");
  });

  it("releases one whose .agent holds only the skills EO delivered", async () => {
    // The other side, so the guard is a guard rather than a wall: EO's
    // own delivery is derived, goes with the worktree, and costs nobody
    // anything.
    const created = await createWorktree(config(), "EO-207");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    writeWorktreeSkills(created.value.path, [
      {
        id: "0199cf00-0000-7000-8000-00000000000c",
        slug: "pr-review",
        name: "PR review",
        description: "How this house reviews a pull request.",
        body: "# PR review\n",
        files: [{ path: "checklist.md", content: "- [ ] tests\n" }],
        disableModelInvocation: false,
        enabled: true,
        scope: { kind: "global" },
        createdAt: 1,
        updatedAt: 2,
        archivedAt: null, createdBy: "person", locked: false,
      },
    ]);

    const removed = await removeWorktree(config(), "EO-207");

    expect(removed.ok).toBe(true);
    expect(existsSync(created.value.path)).toBe(false);
  });

  it("removes it anyway when a person passes force", async () => {
    // Force means "I know what is in there". The guard is EO declining
    // to decide for somebody, not EO refusing to be told.
    const created = await createWorktree(config(), "EO-207");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    mkdirSync(join(created.value.path, ".agent"), { recursive: true });
    writeFileSync(join(created.value.path, ".agent", "notes.md"), "mine\n");

    const removed = await removeWorktree(config(), "EO-207", { force: true });

    expect(removed.ok).toBe(true);
    expect(existsSync(created.value.path)).toBe(false);
  });

  it("heals a worktree that already existed before the exclusion did", async () => {
    // The reuse path does it too, because the exclusion is
    // per-repository rather than per-worktree and a repository EO drove
    // before this shipped has nothing in its exclude file.
    const created = await createWorktree(config(), "EO-207");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    writeFileSync(join(repoPath, ".git", "info", "exclude"), "");
    plantGenerated(created.value.path);
    expect(await status(created.value.path)).not.toBe("");

    const reused = await ensureWorktree(config(), "EO-207");

    expect(reused.ok).toBe(true);
    expect(await status(created.value.path)).toBe("");
  });
});
