import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalPath, commitsAhead, composeGitArgs, currentBranch, fetchBranch, git, globalUserEmail, isAncestor, rebaseOntoBase, statusPorcelain } from "./git.js";
import { run, initRepo } from "../../../testing/git.js";

// Real repositories in a temp dir, same discipline as worktrees.test.ts:
// the point of G-01 is that these git invocations behave against real
// git, and a mock would only assert we call the commands we think we
// call.
let scratch: string;
let originPath: string;
let repoPath: string;

async function makeRepo(path: string): Promise<void> {
  await initRepo(path);
}

async function commit(path: string, file: string, contents: string): Promise<void> {
  writeFileSync(join(path, file), contents);
  await run(["add", "-A"], path);
  await run(["commit", "-m", `add ${file}`], path);
}

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), "eo git primitives "));
  originPath = join(scratch, "origin");
  repoPath = join(scratch, "repo");

  await makeRepo(originPath);
  await commit(originPath, "README.md", "# origin\n");

  // A clone, so `repoPath` has an `origin` remote pointing at the
  // origin repo the same way a repository's repo has a real forge remote.
  await run(["clone", originPath, repoPath], scratch);
  await run(["config", "user.email", "eo@example.com"], repoPath);
  await run(["config", "user.name", "EO Test"], repoPath);
  await run(["config", "commit.gpgsign", "false"], repoPath);
  await run(["config", "tag.gpgsign", "false"], repoPath);

  // A branch already merged into origin's main — same tip, trivially an
  // ancestor.
  await run(["branch", "already-merged", "main"], originPath);

  // A branch with a commit main doesn't have — not yet merged.
  await run(["checkout", "-b", "still-open"], originPath);
  await commit(originPath, "open.txt", "wip\n");
  await run(["checkout", "main"], originPath);
});

/**
 * Windows keeps a handle open for a moment after the process that owned it
 * exits, and answers EBUSY to whoever tries to delete underneath. Retrying
 * covers the usual case; giving up quietly covers the rest, because this is
 * a directory under TEMP and a cleanup that loses a race is not a failed
 * test.
 */
function removeScratch(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
  } catch {
    // Left for the operating system to reclaim.
  }
}

// These tests spawn real git processes, and a killed one can still hold its
// own repo open after `run` has resolved.
//
// Longer than Windows' 30-second hook limit, which is shorter than the
// retries above (150ms more each time, 31.5s for all twenty). On Windows,
// killing git leaves the hanging remote's `sleep 30` running in the repo,
// so after those two tests the removal is refused until it exits, and the
// hook used to time out first (EO-670, test-windows on Node 24).
afterEach(() => {
  removeScratch(scratch);
}, 60_000);

describe("composeGitArgs", () => {
  // Pure argument building, so both platforms' shapes are assertable
  // from whichever machine happens to run the suite — which is the whole
  // reason the platform is a parameter rather than read from `process`.
  it("asks for long-path support on Windows, ahead of the caller's own arguments", () => {
    // Issue #131: `git worktree remove` fails with "Filename too long"
    // on a worktree an agent has installed dependencies into, and the
    // checkout is stranded on disk. The position matters as much as the
    // flag — git only accepts `-c` before the subcommand, so this
    // asserts the whole array rather than that the key appears
    // somewhere in it.
    expect(composeGitArgs(["worktree", "remove", "--force", "C:\\Users\\eo\\.eo\\worktrees\\FEAT-2"], "win32")).toEqual([
      "-c",
      "core.longpaths=true",
      "worktree",
      "remove",
      "--force",
      "C:\\Users\\eo\\.eo\\worktrees\\FEAT-2",
    ]);
  });

  it("hands back the caller's arguments untouched on every other platform", () => {
    const platforms: NodeJS.Platform[] = ["darwin", "linux", "freebsd"];

    for (const platform of platforms) {
      const args = ["status", "--porcelain"];
      // The same array, not an equal copy of it: git ignores
      // `core.longpaths` off Windows, so there is nothing to be gained
      // by touching what gets spawned there.
      expect(composeGitArgs(args, platform)).toBe(args);
      expect(args).toEqual(["status", "--porcelain"]);
    }
  });

  it("does not mutate what the caller passed, even on Windows", () => {
    // A caller that reuses its array — `rebaseOntoBase` builds several —
    // must not accumulate a `-c` per invocation.
    const args = ["worktree", "add", "/tmp/wt", "main"];

    composeGitArgs(args, "win32");
    composeGitArgs(args, "win32");

    expect(args).toEqual(["worktree", "add", "/tmp/wt", "main"]);
  });
});

describe("fetchBranch", () => {
  it("fetches a branch that only exists on the remote into its tracking ref, without creating a local branch", async () => {
    const result = await fetchBranch(repoPath, "origin", "still-open");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const localBranch = await git(["show-ref", "--verify", "--quiet", "refs/heads/still-open"], repoPath);
    expect(localBranch.ok).toBe(false);

    // The commit it answers with is the one it wrote to the tracking ref,
    // not something to be read back off `FETCH_HEAD` later (EO-755).
    expect(result.ref).toBe("refs/remotes/origin/still-open");
    const tracking = await git(["rev-parse", "refs/remotes/origin/still-open"], repoPath);
    expect(tracking.ok && tracking.stdout).toBe(result.commit);
  });

  it("answers with its own branch's commit even after another fetch has rewritten FETCH_HEAD", async () => {
    const fetched = await fetchBranch(repoPath, "origin", "still-open");
    await fetchBranch(repoPath, "origin", "already-merged");

    const fetchHead = await git(["rev-parse", "FETCH_HEAD"], repoPath);
    const stillOpen = await git(["rev-parse", "refs/remotes/origin/still-open"], repoPath);
    expect(fetched.ok && fetched.commit).toBe(stillOpen.ok && stillOpen.stdout);
    expect(fetchHead.ok && fetchHead.stdout).not.toBe(fetched.ok && fetched.commit);
  });

  it("fails against a remote that doesn't exist", async () => {
    const result = await fetchBranch(repoPath, "not-a-remote", "still-open");
    expect(result.ok).toBe(false);
  });
});

/**
 * A remote that accepts the connection and then never answers.
 *
 * `GIT_SSH_COMMAND` is what git runs to reach an `ssh://` remote, so a
 * command that sleeps is a fetch that hangs — which is the state this
 * timeout exists for and the one thing a wrong hostname cannot
 * reproduce, since that fails immediately.
 */
function withHangingRemote<T>(body: () => Promise<T>): Promise<T> {
  const previous = process.env["GIT_SSH_COMMAND"];
  process.env["GIT_SSH_COMMAND"] = "sh -c 'sleep 30'";
  return body().finally(() => {
    if (previous === undefined) delete process.env["GIT_SSH_COMMAND"];
    else process.env["GIT_SSH_COMMAND"] = previous;
  });
}

describe("a git command that reaches the network", () => {
  it("gives up on a remote that never answers, rather than waiting for one that never will", async () => {
    // The bug: `fetchBranch` had no timeout while `pushBranch` did, and
    // `create_worktree` resolves its start point by fetching. An
    // unreachable remote left the run on `running` with nothing on
    // screen, no elapsed limit and no way out but cancelling it by hand.
    await run(["remote", "add", "unreachable", "ssh://eo.invalid/repo"], repoPath);

    const started = Date.now();
    const fetched = await withHangingRemote(() => fetchBranch(repoPath, "unreachable", "main", { timeoutMs: 750 }));

    expect(fetched.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it("stops when the run it belongs to is cancelled", async () => {
    await run(["remote", "add", "unreachable", "ssh://eo.invalid/repo"], repoPath);
    const controller = new AbortController();

    const started = Date.now();
    const fetching = withHangingRemote(() => fetchBranch(repoPath, "unreachable", "main", { signal: controller.signal }));
    controller.abort();

    // The process is killed rather than the promise merely abandoned,
    // which is the difference between cancelling a run and hiding one.
    // The clock is the assertion that says so: the remote sleeps for
    // thirty seconds and the default timeout is two minutes, so anything
    // returning promptly can only have been killed.
    expect((await fetching).ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});

describe("commitsAhead", () => {
  it("counts what a branch has beyond a base", async () => {
    await run(["checkout", "-b", "feature"], repoPath);
    await commit(repoPath, "one.txt", "1\n");
    await commit(repoPath, "two.txt", "2\n");

    expect(await commitsAhead(repoPath, "main", "feature")).toEqual({ ok: true, count: 2 });
  });

  it("says zero when the branch adds nothing", async () => {
    await run(["checkout", "-b", "feature"], repoPath);

    expect(await commitsAhead(repoPath, "main", "feature")).toEqual({ ok: true, count: 0 });
  });

  it("reports a ref it could not read as a failure, not as an empty branch", async () => {
    // These were the same answer, and they are not the same thing. A
    // base ref that does not resolve came back as a count of zero, which
    // `openPullRequest` reported to the person as "your branch has no
    // commits the base does not already have" — and marked final, so it
    // never tried again.
    const result = await commitsAhead(repoPath, "origin/nothing-like-this", "main");

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error).not.toBe("");
  });
});

describe("isAncestor", () => {
  it("is true when the fetched branch's tip is already on the base branch", async () => {
    const fetched = await fetchBranch(repoPath, "origin", "already-merged");
    expect(fetched.ok && (await isAncestor(repoPath, fetched.commit, "main"))).toBe(true);
  });

  it("is false when the fetched branch has a commit the base branch doesn't", async () => {
    const fetched = await fetchBranch(repoPath, "origin", "still-open");
    expect(fetched.ok).toBe(true);
    expect(fetched.ok && (await isAncestor(repoPath, fetched.commit, "main"))).toBe(false);
  });

  it("is false — not thrown — for a ref that doesn't exist", async () => {
    expect(await isAncestor(repoPath, "refs/heads/does-not-exist", "main")).toBe(false);
  });
});

describe("rebaseOntoBase", () => {
  it("drops a dependency's pre-squash commits and leaves repoPath itself untouched", async () => {
    // A dependency branch the item stacked on ...
    await run(["checkout", "-b", "dep-branch"], repoPath);
    await commit(repoPath, "dep.txt", "from the dependency\n");
    const preSquashSha = await git(["rev-parse", "dep-branch"], repoPath);

    // ... the item's own branch, cut from it, with its own commit on top.
    await run(["checkout", "-b", "eo/TICKET-1"], repoPath);
    await commit(repoPath, "ticket.txt", "the ticket's own work\n");

    // The dependency merges into main — via squash, so main gets a new
    // commit with the same content but a different sha, and the item's
    // branch still points at the pre-squash commit.
    await run(["checkout", "main"], repoPath);
    await run(["merge", "--squash", "dep-branch"], repoPath);
    await run(["commit", "-m", "squash-merge dep-branch"], repoPath);

    // repoPath is left checked out on main throughout — the shared
    // checkout other items' sends might still be using.
    await run(["checkout", "main"], repoPath);
    const branchBefore = await currentBranch(repoPath);
    const statusBefore = await statusPorcelain(repoPath);

    const result = await rebaseOntoBase(repoPath, "eo/TICKET-1", "main");
    expect(result.ok).toBe(true);

    // repoPath's own checkout is exactly as it was.
    expect(await currentBranch(repoPath)).toEqual(branchBefore);
    expect(await statusPorcelain(repoPath)).toEqual(statusBefore);

    // No leftover worktree registered for the rebase.
    const worktrees = await git(["worktree", "list", "--porcelain"], repoPath);
    expect(worktrees.ok).toBe(true);
    if (worktrees.ok) expect(worktrees.stdout).not.toContain("eo-rebase-");

    // The item's branch now sits on top of the current main, and the
    // original pre-squash commit is gone from its history.
    expect(await isAncestor(repoPath, "main", "eo/TICKET-1")).toBe(true);
    if (preSquashSha.ok) {
      const contains = await git(["merge-base", "--is-ancestor", preSquashSha.stdout, "eo/TICKET-1"], repoPath);
      expect(contains.ok).toBe(false);
    }
    const itemLog = await git(["log", "--oneline", "eo/TICKET-1"], repoPath);
    expect(itemLog.ok).toBe(true);
    if (itemLog.ok) expect(itemLog.stdout).not.toContain("add dep.txt");
  });

  it("is a no-op — still ok — when the branch already contains the base branch", async () => {
    await run(["checkout", "-b", "eo/TICKET-2"], repoPath);
    await commit(repoPath, "ticket.txt", "work\n");
    await run(["checkout", "main"], repoPath);

    const before = await git(["rev-parse", "eo/TICKET-2"], repoPath);

    const result = await rebaseOntoBase(repoPath, "eo/TICKET-2", "main");
    expect(result.ok).toBe(true);

    const after = await git(["rev-parse", "eo/TICKET-2"], repoPath);
    expect(after).toEqual(before);
  });

  it("aborts and reports failure on a real conflict, leaving repoPath untouched", async () => {
    // main and the item branch both touch the same line, so replaying
    // the item's commit on top of main's conflicts for real.
    await run(["checkout", "-b", "eo/TICKET-3"], repoPath);
    await commit(repoPath, "README.md", "ticket's version\n");
    await run(["checkout", "main"], repoPath);
    await commit(repoPath, "README.md", "main's version\n");

    const branchBefore = await currentBranch(repoPath);
    const statusBefore = await statusPorcelain(repoPath);
    const tipBefore = await git(["rev-parse", "eo/TICKET-3"], repoPath);

    const result = await rebaseOntoBase(repoPath, "eo/TICKET-3", "main");
    expect(result.ok).toBe(false);

    expect(await currentBranch(repoPath)).toEqual(branchBefore);
    expect(await statusPorcelain(repoPath)).toEqual(statusBefore);
    // The branch was left exactly where it was — the rebase never landed.
    expect(await git(["rev-parse", "eo/TICKET-3"], repoPath)).toEqual(tipBefore);
  });

  // EO-156. A branch cannot be checked out in two worktrees at once, so
  // for as long as the item's own `~/.eo/worktrees/<KEY>` holds it —
  // which, at the moment a pull request is opened, is the normal case —
  // the throwaway `worktree add` above is the one thing git will refuse.
  // These are the cases above again with the branch held, and the ones
  // about whose checkout it is being held in.
  it("rebases inside the worktree that already holds the branch", async () => {
    await run(["checkout", "-b", "eo/TICKET-4"], repoPath);
    await commit(repoPath, "ticket.txt", "the ticket's own work\n");
    await run(["checkout", "main"], repoPath);
    await commit(repoPath, "base.txt", "landed while the ticket was in review\n");

    // The item's own checkout, still on its branch: EO cut it, nobody
    // else is using it, and the send happens while it is still there.
    const worktreePath = join(scratch, "worktrees", "TICKET-4");
    await run(["worktree", "add", worktreePath, "eo/TICKET-4"], repoPath);

    const branchBefore = await currentBranch(repoPath);
    const statusBefore = await statusPorcelain(repoPath);

    const result = await rebaseOntoBase(repoPath, "eo/TICKET-4", "main", { worktreePath });
    expect(result.ok).toBe(true);

    // The rebase actually landed on the branch itself, which is what the
    // pull request is about to be opened from.
    expect(await isAncestor(repoPath, "main", "eo/TICKET-4")).toBe(true);

    // And the item's worktree is handed back exactly as usable as it
    // was — it is needed again the moment the reviewer sends this back.
    expect(await currentBranch(worktreePath)).toEqual({ ok: true, stdout: "eo/TICKET-4" });
    expect(await statusPorcelain(worktreePath)).toEqual({ ok: true, stdout: "" });
    expect(existsSync(join(worktreePath, "base.txt"))).toBe(true);

    // repoPath is untouched, and nothing throwaway was created at all.
    expect(await currentBranch(repoPath)).toEqual(branchBefore);
    expect(await statusPorcelain(repoPath)).toEqual(statusBefore);
    const worktrees = await git(["worktree", "list", "--porcelain"], repoPath);
    expect(worktrees.ok).toBe(true);
    if (worktrees.ok) expect(worktrees.stdout).not.toContain("eo-rebase-");
  });

  it("aborts a conflicted rebase in the holding worktree rather than parking it mid-rebase", async () => {
    await run(["checkout", "-b", "eo/TICKET-5"], repoPath);
    await commit(repoPath, "README.md", "ticket's version\n");
    await run(["checkout", "main"], repoPath);
    await commit(repoPath, "README.md", "main's version\n");

    const worktreePath = join(scratch, "worktrees", "TICKET-5");
    await run(["worktree", "add", worktreePath, "eo/TICKET-5"], repoPath);
    const tipBefore = await git(["rev-parse", "eo/TICKET-5"], repoPath);

    const result = await rebaseOntoBase(repoPath, "eo/TICKET-5", "main", { worktreePath });
    expect(result.ok).toBe(false);
    // What a person reads is the conflict, which is the real answer —
    // not a worktree EO could not create, which is a detail of how it
    // used to go looking for one.
    expect(result.ok ? "" : result.error).toContain("failed and was aborted");

    // Not left mid-rebase: parked in that state, every later git command
    // in there fails and the item's next attempt has nowhere to run.
    expect(await currentBranch(worktreePath)).toEqual({ ok: true, stdout: "eo/TICKET-5" });
    expect(await statusPorcelain(worktreePath)).toEqual({ ok: true, stdout: "" });
    expect((await git(["rev-parse", "--verify", "--quiet", "REBASE_HEAD"], worktreePath)).ok).toBe(false);
    // The branch was left where it was — the rebase never landed.
    expect(await git(["rev-parse", "eo/TICKET-5"], repoPath)).toEqual(tipBefore);
  });

  it("refuses rather than rebasing when repoPath itself has the branch checked out", async () => {
    await run(["checkout", "-b", "eo/TICKET-6"], repoPath);
    await commit(repoPath, "ticket.txt", "work\n");
    await run(["checkout", "main"], repoPath);
    await commit(repoPath, "base.txt", "landed\n");
    // The shared checkout, sitting on the item's branch. Rebasing here
    // would rewrite a working tree another item's send may be using.
    await run(["checkout", "eo/TICKET-6"], repoPath);

    const tipBefore = await git(["rev-parse", "eo/TICKET-6"], repoPath);
    const result = await rebaseOntoBase(repoPath, "eo/TICKET-6", "main");

    expect(result.ok).toBe(false);
    // The reason names the checkout, since moving off it is what a person
    // has to do about this.
    expect(result.ok ? "" : result.error).toContain(repoPath);
    expect(await currentBranch(repoPath)).toEqual({ ok: true, stdout: "eo/TICKET-6" });
    expect(await git(["rev-parse", "eo/TICKET-6"], repoPath)).toEqual(tipBefore);
  });

  it("reports git's own refusal when the holding worktree's registration is stale", async () => {
    await run(["checkout", "-b", "eo/TICKET-7"], repoPath);
    await commit(repoPath, "ticket.txt", "work\n");
    await run(["checkout", "main"], repoPath);
    await commit(repoPath, "base.txt", "landed\n");

    const worktreePath = join(scratch, "worktrees", "TICKET-7");
    await run(["worktree", "add", worktreePath, "eo/TICKET-7"], repoPath);
    // The directory goes, the registration outlives it — and git still
    // counts the branch as checked out there.
    rmSync(worktreePath, { recursive: true, force: true });

    const result = await rebaseOntoBase(repoPath, "eo/TICKET-7", "main", { worktreePath });

    expect(result.ok).toBe(false);
    const error = result.ok ? "" : result.error;
    // git's refusal, which names the entry to prune — not an ENOENT from
    // trying to run a rebase in a directory that is not there.
    //
    // Asserted on the path git names rather than on the sentence it
    // wraps around it. git changed the wording of this refusal between
    // releases — "is already checked out at" became "is already used by
    // worktree at" — so matching the prose pinned the test to whichever
    // git the author happened to have installed, and it passed on every
    // developer machine while never once passing on CI's older one.
    // What has to be true is that git refused and said which stale
    // registration to prune, and that is the path.
    //
    // Compared with the separators flattened, because the spelling of the
    // path is git's too: Git for Windows 2.56 writes it `C:/Users/...`,
    // while canonicalPath gives the native backslashes.
    const slashes = (text: string) => text.replaceAll("\\", "/");
    expect(slashes(error)).toContain(slashes(canonicalPath(worktreePath)));
    expect(error).not.toContain("ENOENT");
  });

  it("refuses to rebase in a worktree EO did not create, and leaves it alone", async () => {
    await run(["checkout", "-b", "eo/TICKET-8"], repoPath);
    await commit(repoPath, "ticket.txt", "work\n");
    await run(["checkout", "main"], repoPath);
    await commit(repoPath, "base.txt", "landed\n");

    // A person's own checkout of the branch — which is a thing that can
    // happen: releasing the item's worktree keeps the branch, and a
    // branch nobody holds is a branch anybody can check out.
    const theirs = join(scratch, "somebody-elses-checkout");
    await run(["worktree", "add", theirs, "eo/TICKET-8"], repoPath);
    const headBefore = await git(["rev-parse", "HEAD"], theirs);
    const tipBefore = await git(["rev-parse", "eo/TICKET-8"], repoPath);

    // EO's own worktree for the item is elsewhere, and is not there.
    const worktreePath = join(scratch, "worktrees", "TICKET-8");
    const result = await rebaseOntoBase(repoPath, "eo/TICKET-8", "main", { worktreePath });

    expect(result.ok).toBe(false);
    // Both paths, because the two together are the whole explanation:
    // where the branch actually is, and where EO would have accepted it.
    const error = result.ok ? "" : result.error;
    expect(error).toContain(canonicalPath(theirs));
    expect(error).toContain(canonicalPath(worktreePath));

    // Their checkout is exactly as they left it: same HEAD, same branch,
    // and none of what landed on main pulled in under them.
    expect(await git(["rev-parse", "HEAD"], theirs)).toEqual(headBefore);
    expect(await currentBranch(theirs)).toEqual({ ok: true, stdout: "eo/TICKET-8" });
    expect(await statusPorcelain(theirs)).toEqual({ ok: true, stdout: "" });
    expect(existsSync(join(theirs, "base.txt"))).toBe(false);
    // And the branch itself never moved.
    expect(await git(["rev-parse", "eo/TICKET-8"], repoPath)).toEqual(tipBefore);
  });

  it("leaves a worktree stopped mid-rebase exactly as it is, aborting nothing it did not start", async () => {
    await run(["checkout", "-b", "eo/TICKET-9"], repoPath);
    await commit(repoPath, "README.md", "ticket's version\n");
    await run(["checkout", "main"], repoPath);
    await commit(repoPath, "README.md", "main's version\n");
    // A third line of history to rebase onto, so the rebase already
    // running is demonstrably not the one EO would have started.
    await run(["checkout", "-b", "sideways", "main"], repoPath);
    await commit(repoPath, "README.md", "sideways version\n");
    await run(["checkout", "main"], repoPath);

    const worktreePath = join(scratch, "worktrees", "TICKET-9");
    await run(["worktree", "add", worktreePath, "eo/TICKET-9"], repoPath);

    // Somebody — a person at a terminal, or an interrupted run — starts a
    // rebase in there and it stops on a conflict, half resolved.
    const started = await git(["rebase", "sideways"], worktreePath);
    expect(started.ok).toBe(false);
    const rebaseHeadBefore = await git(["rev-parse", "REBASE_HEAD"], worktreePath);
    expect(rebaseHeadBefore.ok).toBe(true);
    const statusBefore = await statusPorcelain(worktreePath);
    const headBefore = await git(["rev-parse", "HEAD"], worktreePath);
    const tipBefore = await git(["rev-parse", "eo/TICKET-9"], repoPath);

    const result = await rebaseOntoBase(repoPath, "eo/TICKET-9", "main", { worktreePath });

    // A refusal that says what is in the way — the caller turns it into
    // the comment a person reads (invariant #8).
    expect(result.ok).toBe(false);
    const error = result.ok ? "" : result.error;
    expect(error).toContain(canonicalPath(worktreePath));
    expect(error).toContain("stopped part-way through");

    // Every piece of that half-finished rebase is still there. `--abort`
    // would have discarded all of it, and the conflict resolutions with
    // it, to make room for a rebase nobody asked for yet.
    expect(await git(["rev-parse", "REBASE_HEAD"], worktreePath)).toEqual(rebaseHeadBefore);
    expect(await statusPorcelain(worktreePath)).toEqual(statusBefore);
    expect(await git(["rev-parse", "HEAD"], worktreePath)).toEqual(headBefore);
    expect(await git(["rev-parse", "eo/TICKET-9"], repoPath)).toEqual(tipBefore);
    // Still resumable, which is the whole point of not touching it.
    expect((await git(["rebase", "--abort"], worktreePath)).ok).toBe(true);
  });

  it("refuses when the holding worktree is part-way through a `git am`, and aborts nothing", async () => {
    // The case that actually reaches the rebase itself. A rebase detaches
    // HEAD, so a worktree stopped in one no longer reports the branch at
    // all — but `git am` parks its work in the same state directory and
    // *keeps the branch checked out*, so this is EO's own worktree,
    // holding this item's branch, with somebody's half-applied patch
    // in it. Rebasing over that, or aborting to make room, throws it away.
    await run(["checkout", "-b", "eo/TICKET-10"], repoPath);
    await commit(repoPath, "patchable.txt", "the ticket's work\n");
    const patches = join(scratch, "patches");
    await run(["format-patch", "-1", "-o", patches], repoPath);
    // The branch moves somewhere the patch cannot apply cleanly, so the
    // `am` below stops rather than finishing.
    await run(["reset", "--hard", "HEAD~1"], repoPath);
    await commit(repoPath, "patchable.txt", "something else entirely\n");
    await run(["checkout", "main"], repoPath);
    await commit(repoPath, "base.txt", "landed\n");

    const worktreePath = join(scratch, "worktrees", "TICKET-10");
    await run(["worktree", "add", worktreePath, "eo/TICKET-10"], repoPath);
    const patch = join(patches, readdirSync(patches)[0] as string);
    expect((await git(["am", patch], worktreePath)).ok).toBe(false);

    // Still on the branch — which is what makes this reachable — with the
    // stopped patch on disk.
    expect(await currentBranch(worktreePath)).toEqual({ ok: true, stdout: "eo/TICKET-10" });
    const stateDir = await git(["rev-parse", "--git-path", "rebase-apply"], worktreePath);
    expect(stateDir.ok && existsSync(resolve(worktreePath, stateDir.stdout))).toBe(true);
    const statusBefore = await statusPorcelain(worktreePath);
    const headBefore = await git(["rev-parse", "HEAD"], worktreePath);
    const tipBefore = await git(["rev-parse", "eo/TICKET-10"], repoPath);

    const result = await rebaseOntoBase(repoPath, "eo/TICKET-10", "main", { worktreePath });

    expect(result.ok).toBe(false);
    const error = result.ok ? "" : result.error;
    expect(error).toContain(canonicalPath(worktreePath));
    expect(error).toContain("stopped part-way through");

    // Nothing was run in there at all: the patch is still stopped where
    // it was, on the same commit, with the same conflicted tree.
    expect(stateDir.ok && existsSync(resolve(worktreePath, stateDir.stdout))).toBe(true);
    expect(await statusPorcelain(worktreePath)).toEqual(statusBefore);
    expect(await git(["rev-parse", "HEAD"], worktreePath)).toEqual(headBefore);
    expect(await git(["rev-parse", "eo/TICKET-10"], repoPath)).toEqual(tipBefore);
    // And it is still the person's to finish or drop.
    expect((await git(["am", "--abort"], worktreePath)).ok).toBe(true);
  });
});

describe("globalUserEmail", () => {
  // `GIT_CONFIG_GLOBAL` (git 2.32+) points "global" config at a file of
  // our own choosing instead of the real machine's, so these control what
  // `git config --global user.email` reports without touching anything
  // outside the test (EO-15's branch-prefix default).
  it("reads user.email out of the global config", async () => {
    const configPath = join(scratch, "gitconfig");
    writeFileSync(configPath, "[user]\n\temail = lyudvig@example.com\n");

    expect(await globalUserEmail({ GIT_CONFIG_GLOBAL: configPath })).toBe("lyudvig@example.com");
  });

  it("is null when the global config has no user.email", async () => {
    const configPath = join(scratch, "empty-gitconfig");
    writeFileSync(configPath, "[core]\n\teditor = vi\n");

    expect(await globalUserEmail({ GIT_CONFIG_GLOBAL: configPath })).toBeNull();
  });

  it("is null when the global config sets it to an empty string", async () => {
    const configPath = join(scratch, "blank-gitconfig");
    writeFileSync(configPath, '[user]\n\temail = ""\n');

    expect(await globalUserEmail({ GIT_CONFIG_GLOBAL: configPath })).toBeNull();
  });
});
