import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  canonicalPath,
  commitsAhead,
  composeGitArgs,
  currentBranch,
  destinationKey,
  fetchBranch,
  git,
  globalUserEmail,
  isAncestor,
  pushBranch,
  pushDestination,
  pushDiverged,
  pushRefusal,
  pushUpdated,
  rebaseOntoBase,
  statusPorcelain,
} from "./git.js";
import { beforeGitPush, gitHttpServer, run, initRepo, type GitHttpRoute } from "../../../testing/git.js";

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

describe("pushBranch (EO-910)", () => {
  let barePath: string;
  const localTip = (): Promise<string> => run(["rev-parse", "refs/heads/eo/APP-1"], repoPath);
  /** The commit a push that went through sent. */
  const sentBy = (pushed: Awaited<ReturnType<typeof pushBranch>>): string => (pushed.ok ? (pushed.head ?? "") : "");
  // Where a push to a local path goes: the repository it resolves to, on
  // every platform.
  const at = (path: string): string => destinationKey(canonicalPath(path));
  /** The same, as a lease names it. */
  const leasedAt = at;
  const remoteTip = async (branch: string): Promise<string | null> => {
    const tip = await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], barePath);
    return tip.ok ? tip.stdout : null;
  };

  beforeEach(async () => {
    barePath = join(scratch, "bare.git");
    await run(["init", "--bare", barePath], scratch);
    await run(["remote", "add", "bare", barePath], repoPath);
    await run(["checkout", "-b", "eo/APP-1"], repoPath);
    await commit(repoPath, "work.ts", "// the work\n");
  });

  it("says which commit it sent, that it moved the remote's branch, and sets the upstream", async () => {
    const head = await run(["rev-parse", "eo/APP-1"], repoPath);

    const pushed = await pushBranch(repoPath, "bare", "eo/APP-1");

    expect(pushed).toMatchObject({ ok: true, head, updated: true });
    expect(await remoteTip("eo/APP-1")).toBe(head);
    expect(await run(["config", "branch.eo/APP-1.remote"], repoPath)).toBe("bare");
    expect(await run(["config", "branch.eo/APP-1.merge"], repoPath)).toBe("refs/heads/eo/APP-1");
  });

  it("says it moved nothing when the remote already held the commit — which may be somebody else's", async () => {
    await pushBranch(repoPath, "bare", "eo/APP-1");

    const again = await pushBranch(repoPath, "bare", "eo/APP-1");

    expect(again).toMatchObject({ ok: true, updated: false });
  });

  it("pushes to the branch of the same name whatever remote.<name>.push would map it to", async () => {
    await run(["config", "remote.bare.push", "refs/heads/eo/APP-1:refs/heads/elsewhere"], repoPath);

    const pushed = await pushBranch(repoPath, "bare", "eo/APP-1");

    expect(pushed.ok).toBe(true);
    expect(await remoteTip("eo/APP-1")).toBe(sentBy(pushed));
    expect(await remoteTip("elsewhere")).toBeNull();
  });

  it("reports a rejection as diverged, from the line --porcelain prints on stdout", async () => {
    await pushBranch(repoPath, "bare", "eo/APP-1");
    await run(["commit", "--amend", "-m", "rewritten"], repoPath);

    const pushed = await pushBranch(repoPath, "bare", "eo/APP-1");

    expect(pushed).toMatchObject({ ok: false, rejection: "diverged" });
    expect(pushed.ok ? "" : pushed.error).toMatch(/non-fast-forward|fetch first/);
  });

  it("tells a hook's refusal from divergence by the ref's status, whatever the branch is called", async () => {
    await run(["checkout", "-b", "eo/non-fast-forward-APP-1"], repoPath);
    writeFileSync(join(barePath, "hooks", "pre-receive"), "#!/bin/sh\necho 'not today' >&2\nexit 1\n", { mode: 0o755 });

    const pushed = await pushBranch(repoPath, "bare", "eo/non-fast-forward-APP-1");

    expect(pushed).toMatchObject({ ok: false, rejection: "other", published: null, status: "[remote rejected] (pre-receive hook declined)" });
    expect(await remoteTip("eo/non-fast-forward-APP-1")).toBeNull();
  });

  it("pushes a lease nowhere when the remote no longer pushes to the destination it names", async () => {
    const first = await pushBranch(repoPath, "bare", "eo/APP-1");
    const old = sentBy(first);
    const other = join(scratch, "other.git");
    await run(["init", "--bare", other], scratch);
    await run(["push", other, `${old}:refs/heads/eo/APP-1`], repoPath);
    await run(["remote", "set-url", "bare", other], repoPath);
    await run(["commit", "--amend", "-m", "rewritten"], repoPath);

    const leased = await pushBranch(repoPath, "bare", "eo/APP-1", { forceWithLease: { expect: old, destination: leasedAt(barePath), send: await localTip() } });

    expect(leased).toMatchObject({ ok: false, rejection: "destination", published: null, destination: at(other) });
    expect(await run(["rev-parse", "eo/APP-1"], other)).toBe(old);
    expect(await remoteTip("eo/APP-1")).toBe(old);
  });

  it("goes to the push URL git resolved, never rewriting it a second time (pushInsteadOf, then insteadOf)", async () => {
    const a = join(scratch, "a.git");
    const b = join(scratch, "b.git");
    await run(["init", "--bare", a], scratch);
    await run(["init", "--bare", b], scratch);
    await run(["config", `url.${a}.pushInsteadOf`, barePath], repoPath);
    await run(["config", `url.${b}.insteadOf`, a], repoPath);

    const pushed = await pushBranch(repoPath, "bare", "eo/APP-1");

    expect(pushed).toMatchObject({ ok: true, updated: true, destination: at(a) });
    expect(await run(["rev-parse", "eo/APP-1"], a)).toBe(sentBy(pushed));
    expect(await git(["rev-parse", "--verify", "--quiet", "refs/heads/eo/APP-1"], b)).toMatchObject({ ok: false });
    expect(await remoteTip("eo/APP-1")).toBeNull();
  });

  it("moves the remote-tracking ref as a push by the remote's name would", async () => {
    await run(["config", "remote.bare.fetch", "+refs/heads/*:refs/remotes/bare/*"], repoPath);

    const pushed = await pushBranch(repoPath, "bare", "eo/APP-1");

    expect(await run(["rev-parse", "refs/remotes/bare/eo/APP-1"], repoPath)).toBe(sentBy(pushed));
  });

  // A file name led by a byte-order mark is not one this suite has made on Windows.
  it.skipIf(process.platform === "win32")("tells apart push URLs that differ only by a leading byte-order mark, and pushes to the one git names", async () => {
    // Relative to the repository, so that the mark leads the URL.
    const plain = "a.git";
    const marked = "\uFEFFa.git";
    await run(["init", "--bare", join(repoPath, plain)], scratch);
    await run(["init", "--bare", join(repoPath, marked)], scratch);
    const first = await pushBranch(repoPath, "bare", "eo/APP-1");
    const old = sentBy(first);
    for (const path of [plain, marked]) await run(["push", join(repoPath, path), `${old}:refs/heads/eo/APP-1`], repoPath);
    await run(["remote", "set-url", "bare", marked], repoPath);
    await run(["commit", "--amend", "-m", "rewritten"], repoPath);

    expect(await pushDestination(repoPath, "bare")).toBe(marked);
    const leased = await pushBranch(repoPath, "bare", "eo/APP-1", { forceWithLease: { expect: old, destination: leasedAt(join(repoPath, plain)), send: await localTip() } });

    expect(leased).toMatchObject({ ok: false, rejection: "destination", destination: at(join(repoPath, marked)) });
    expect(await run(["rev-parse", "eo/APP-1"], join(repoPath, plain))).toBe(old);
    expect(await run(["rev-parse", "eo/APP-1"], join(repoPath, marked))).toBe(old);

    const pushed = await pushBranch(repoPath, "bare", "eo/APP-1", { forceWithLease: { expect: old, destination: leasedAt(join(repoPath, marked)), send: await localTip() } });
    expect(pushed).toMatchObject({ ok: true, updated: true, destination: at(join(repoPath, marked)) });
    expect(await run(["rev-parse", "eo/APP-1"], join(repoPath, marked))).toBe(sentBy(pushed));
    expect(await run(["rev-parse", "eo/APP-1"], join(repoPath, plain))).toBe(old);
  });

  it("pushes by the remote's name: its pre-push hook is told the name, and its receivepack is honoured, with no destination to force at", async () => {
    const told = join(scratch, "told.log");
    const hook = join(repoPath, await run(["rev-parse", "--git-path", "hooks"], repoPath), "pre-push");
    writeFileSync(hook, `#!/bin/sh\necho "$1" >> '${told}'\n[ "$1" = bare ]\n`, { mode: 0o755 });

    const pinned = await pushBranch(repoPath, "bare", "eo/APP-1");
    expect(pinned).toMatchObject({ ok: true, updated: true, destination: at(barePath) });

    // A receivepack that lands the push somewhere the URL does not name.
    const landed = join(scratch, "landed.git");
    await run(["init", "--bare", landed], scratch);
    const receive = join(scratch, "receive.sh");
    writeFileSync(receive, `#!/bin/sh\nexec git receive-pack '${landed}'\n`, { mode: 0o755 });
    await run(["config", "remote.bare.receivepack", `'${receive}'`], repoPath);
    await commit(repoPath, "more.ts", "// more\n");

    const received = await pushBranch(repoPath, "bare", "eo/APP-1");

    expect(received).toMatchObject({ ok: true, updated: true, destination: null });
    expect(await run(["rev-parse", "eo/APP-1"], landed)).toBe(sentBy(received));
    expect(await remoteTip("eo/APP-1")).toBe(sentBy(pinned));
    expect(readFileSync(told, "utf8")).toBe("bare\nbare\n");
  });

  it("moves only the tracking ref git's own push moves, though the fetch refspec changes while it pushes", async () => {
    await run(["config", "remote.bare.fetch", "+refs/heads/*:refs/remotes/bare/*"], repoPath);
    const main = await run(["rev-parse", "main"], repoPath);
    const hook = join(repoPath, await run(["rev-parse", "--git-path", "hooks"], repoPath), "pre-push");
    writeFileSync(hook, "#!/bin/sh\ngit config remote.bare.fetch +refs/heads/eo/APP-1:refs/heads/main\n", { mode: 0o755 });

    const pushed = await pushBranch(repoPath, "bare", "eo/APP-1");
    expect(pushed).toMatchObject({ ok: true, updated: true });
    expect(await run(["rev-parse", "main"], repoPath)).toBe(main);
    expect(await run(["rev-parse", "refs/remotes/bare/eo/APP-1"], repoPath)).toBe(sentBy(pushed));
  });

  // Windows cannot make a directory whose name ends in a space.
  it.skipIf(process.platform === "win32")("tells apart push URLs that differ only in trailing whitespace, and pushes to the one git names", async () => {
    const spaced = `${barePath} `;
    await run(["init", "--bare", spaced], scratch);
    await run(["remote", "set-url", "bare", spaced], repoPath);

    expect(await pushDestination(repoPath, "bare")).toBe(spaced);
    const pushed = await pushBranch(repoPath, "bare", "eo/APP-1");

    expect(pushed).toMatchObject({ ok: true, updated: true, destination: at(spaced) });
    expect(at(spaced)).not.toBe(at(barePath));
    expect(await run(["rev-parse", "eo/APP-1"], spaced)).toBe(sentBy(pushed));
    expect(await remoteTip("eo/APP-1")).toBeNull();
  });

  it("forces only over the exact commit it is leased to", async () => {
    const first = await pushBranch(repoPath, "bare", "eo/APP-1");
    const old = sentBy(first);
    await run(["commit", "--amend", "-m", "rewritten"], repoPath);

    const destination = leasedAt(barePath);
    const wrongLease = await pushBranch(repoPath, "bare", "eo/APP-1", { forceWithLease: { expect: await run(["rev-parse", "main"], repoPath), destination, send: await localTip() } });
    expect(wrongLease).toMatchObject({ ok: false, rejection: "other", published: null });
    expect(await remoteTip("eo/APP-1")).toBe(old);

    const leased = await pushBranch(repoPath, "bare", "eo/APP-1", { forceWithLease: { expect: old, destination, send: await localTip() } });
    expect(leased).toMatchObject({ ok: true, updated: true });
    expect(await remoteTip("eo/APP-1")).toBe(sentBy(leased));
  });
  /**
   * Windows' route to a local path: no `receive-pack` of EO's binds the
   * push to the repository it finds itself in, since the shell git runs
   * there names directories its own way (`bindsLocalRepository`). Run as
   * though on Windows everywhere else, so that route is tested here too.
   */
  describe("on the route Windows takes to a local path", () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    beforeEach(() => {
      Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    });
    afterEach(() => {
      Object.defineProperty(process, "platform", platform);
    });

    it("records a push to a local path as the repository it resolves to, and forces over it only through that exact commit", async () => {
      const first = await pushBranch(repoPath, "bare", "eo/APP-1");
      expect(first).toMatchObject({ ok: true, updated: true, destination: at(barePath) });
      const old = sentBy(first);
      await run(["commit", "--amend", "-m", "rewritten"], repoPath);

      const wrongLease = await pushBranch(repoPath, "bare", "eo/APP-1", { forceWithLease: { expect: await run(["rev-parse", "main"], repoPath), destination: at(barePath), send: await localTip() } });
      expect(wrongLease).toMatchObject({ ok: false, rejection: "other", published: null });
      expect(await remoteTip("eo/APP-1")).toBe(old);

      const leased = await pushBranch(repoPath, "bare", "eo/APP-1", { forceWithLease: { expect: old, destination: at(barePath), send: await localTip() } });
      expect(leased).toMatchObject({ ok: true, updated: true, destination: at(barePath) });
      expect(await remoteTip("eo/APP-1")).toBe(await localTip());
    });

    it("sends a lease nowhere when the remote no longer pushes to the repository it names", async () => {
      const first = await pushBranch(repoPath, "bare", "eo/APP-1");
      const old = sentBy(first);
      const other = join(scratch, "other.git");
      await run(["init", "--bare", other], scratch);
      await run(["push", other, `${old}:refs/heads/eo/APP-1`], repoPath);
      await run(["remote", "set-url", "bare", other], repoPath);
      await run(["commit", "--amend", "-m", "rewritten"], repoPath);

      const leased = await pushBranch(repoPath, "bare", "eo/APP-1", { forceWithLease: { expect: old, destination: at(barePath), send: await localTip() } });

      expect(leased).toMatchObject({ ok: false, rejection: "destination", published: null });
      expect(await run(["rev-parse", "eo/APP-1"], other)).toBe(old);
      expect(await remoteTip("eo/APP-1")).toBe(old);
    });
  });

  it("pushes only the branch, so a tag the remote refuses cannot fail a push whose branch went through", async () => {
    await run(["config", "push.followTags", "true"], repoPath);
    await run(["tag", "-a", "v1", "-m", "a tag push.followTags would send"], repoPath);
    const hook = join(barePath, "hooks", "pre-receive");
    writeFileSync(hook, "#!/bin/sh\nwhile read old new ref; do case \"$ref\" in refs/tags/*) echo \"no tags here\" >&2; exit 1;; esac; done\n", { mode: 0o755 });

    const pushed = await pushBranch(repoPath, "bare", "eo/APP-1");

    expect(pushed).toMatchObject({ ok: true, updated: true });
    expect(await remoteTip("eo/APP-1")).toBe(sentBy(pushed));
    expect(await run(["tag", "--list"], barePath)).toBe("");
  });

  it("says where it pushed: the push URL's fingerprint, and none where that is several", async () => {
    const pushed = await pushBranch(repoPath, "bare", "eo/APP-1");
    expect(pushed).toMatchObject({ ok: true, destination: at(barePath) });

    await run(["config", "--add", "remote.bare.pushurl", barePath], repoPath);
    await run(["config", "--add", "remote.bare.pushurl", barePath], repoPath);
    await commit(repoPath, "more.ts", "// more\n");
    expect(await pushBranch(repoPath, "bare", "eo/APP-1")).toMatchObject({ ok: true, updated: true, destination: null });
  });

  it("counts a push to several URLs as moving the branch when any of them moved it", async () => {
    // The first URL already holds the commit; the second has never seen it.
    const second = join(scratch, "second.git");
    await run(["init", "--bare", second], scratch);
    await pushBranch(repoPath, "bare", "eo/APP-1");
    await run(["config", "--add", "remote.bare.pushurl", barePath], repoPath);
    await run(["config", "--add", "remote.bare.pushurl", second], repoPath);

    const pushed = await pushBranch(repoPath, "bare", "eo/APP-1");

    expect(pushed).toMatchObject({ ok: true, updated: true, destination: null });
    expect(await run(["rev-parse", "eo/APP-1"], second)).toBe(sentBy(pushed));
  });

  it("says what a failed push published all the same, at the one of several URLs that took it", async () => {
    const second = join(scratch, "second.git");
    await run(["init", "--bare", second], scratch);
    writeFileSync(join(second, "hooks", "pre-receive"), "#!/bin/sh\necho refused >&2\nexit 1\n", { mode: 0o755 });
    await run(["config", "--add", "remote.bare.pushurl", barePath], repoPath);
    await run(["config", "--add", "remote.bare.pushurl", second], repoPath);
    const head = await run(["rev-parse", "eo/APP-1"], repoPath);

    const pushed = await pushBranch(repoPath, "bare", "eo/APP-1");

    expect(pushed).toMatchObject({ ok: false, published: head });
    expect(await remoteTip("eo/APP-1")).toBe(head);
  });

  it("says a rejected push published nothing", async () => {
    await pushBranch(repoPath, "bare", "eo/APP-1");
    await run(["commit", "--amend", "-m", "rewritten"], repoPath);

    expect(await pushBranch(repoPath, "bare", "eo/APP-1")).toMatchObject({ ok: false, published: null });
  });

  // Windows symlinks need a privilege a test runner rarely has.
  it.skipIf(process.platform === "win32")("records a local path as the repository it resolves to, so a symlink pointed elsewhere is somewhere else", async () => {
    const a = join(scratch, "a.git");
    const b = join(scratch, "b.git");
    const link = join(scratch, "link.git");
    await run(["init", "--bare", a], scratch);
    await run(["init", "--bare", b], scratch);
    symlinkSync(a, link);
    await run(["remote", "set-url", "bare", link], repoPath);
    const first = await pushBranch(repoPath, "bare", "eo/APP-1");
    expect(first).toMatchObject({ ok: true, updated: true, destination: at(a) });
    const old = sentBy(first);
    // B holds the same commit, put there by somebody else.
    await run(["push", b, `${old}:refs/heads/eo/APP-1`], repoPath);
    unlinkSync(link);
    symlinkSync(b, link);
    await run(["commit", "--amend", "-m", "rewritten"], repoPath);

    const rejected = await pushBranch(repoPath, "bare", "eo/APP-1");
    expect(rejected).toMatchObject({ ok: false, rejection: "diverged", destination: at(b) });
    expect(at(b)).not.toBe(at(a));

    const leased = await pushBranch(repoPath, "bare", "eo/APP-1", { forceWithLease: { expect: old, destination: leasedAt(a), send: await localTip() } });
    expect(leased).toMatchObject({ ok: false, rejection: "destination", published: null });
    expect(await run(["rev-parse", "eo/APP-1"], a)).toBe(old);
    expect(await run(["rev-parse", "eo/APP-1"], b)).toBe(old);
  });

  it("records no place where a local path might reach another repository's refs", async () => {
    const elsewhere = join(scratch, "elsewhere.git");
    await run(["init", "--bare", elsewhere], scratch);
    writeFileSync(join(barePath, "commondir"), `${elsewhere}\n`);

    expect(await pushBranch(repoPath, "bare", "eo/APP-1")).toMatchObject({ ok: true, destination: null });
  });

  it("records a remote's own push URL, on any git — no older one needs to clear what the environment never sets", async () => {
    const a = join(scratch, "a.git");
    await run(["init", "--bare", a], scratch);
    await run(["config", "remote.bare.pushurl", a], repoPath);

    const pushed = await pushBranch(repoPath, "bare", "eo/APP-1");

    expect(pushed).toMatchObject({ ok: true, updated: true, destination: at(a) });
    expect(await run(["rev-parse", "eo/APP-1"], a)).toBe(sentBy(pushed));
    expect(await remoteTip("eo/APP-1")).toBeNull();
  });

  it("records a file:/// URL as the repository it names, `file:///C:/…` on Windows too", async () => {
    // Git for Windows takes `file:///C:/…` for the path `C:/…`.
    const url = process.platform === "win32" ? `file:///${barePath.replace(/\\/g, "/")}` : `file://${barePath}`;
    await run(["remote", "set-url", "bare", url], repoPath);
    const pushed = await pushBranch(repoPath, "bare", "eo/APP-1");

    expect(pushed).toMatchObject({ ok: true, updated: true, destination: at(barePath) });
    expect(await remoteTip("eo/APP-1")).toBe(sentBy(pushed));
  });

  it("records no place for a remote helper, which decides for itself where a push goes", async () => {
    await run(["remote", "add", "helped", "ext::git %S '/nowhere'"], repoPath);
    const pushed = await pushBranch(repoPath, "helped", "eo/APP-1");
    expect(pushed).toMatchObject({ ok: false, destination: null });
  });

  it("pushes the branch itself, not a tag named like its commit's hash", async () => {
    const head = await localTip();
    // A lightweight tag called exactly the commit's hash, on another commit.
    await run(["tag", head, "main"], repoPath);

    const pushed = await pushBranch(repoPath, "bare", "eo/APP-1");

    expect(pushed).toMatchObject({ ok: true, head, updated: true });
    expect(await remoteTip("eo/APP-1")).toBe(head);
  });

  it("tells a pre-push hook the branch it pushes on its stdin, as a push of the branch always did", async () => {
    const told = join(scratch, "stdin.log");
    const hook = join(repoPath, await run(["rev-parse", "--git-path", "hooks"], repoPath), "pre-push");
    writeFileSync(hook, `#!/bin/sh\ncat >> '${told}'\nexit 0\n`, { mode: 0o755 });
    const head = await localTip();

    await pushBranch(repoPath, "bare", "eo/APP-1");

    const [localRef, localSha, remoteRef] = readFileSync(told, "utf8").trim().split(" ");
    expect({ localRef, localSha, remoteRef }).toEqual({ localRef: "refs/heads/eo/APP-1", localSha: head, remoteRef: "refs/heads/eo/APP-1" });
  });

  it("knows the commit it sent, though a hook moved the branch once git had read it", async () => {
    const head = await localTip();
    const main = await run(["rev-parse", "main"], repoPath);
    const hook = join(repoPath, await run(["rev-parse", "--git-path", "hooks"], repoPath), "pre-push");
    writeFileSync(hook, `#!/bin/sh\ngit update-ref refs/heads/eo/APP-1 ${main}\n`, { mode: 0o755 });

    const pushed = await pushBranch(repoPath, "bare", "eo/APP-1");

    expect(pushed).toMatchObject({ ok: true, head, updated: true, destination: at(barePath) });
    expect(await remoteTip("eo/APP-1")).toBe(head);
    expect(await localTip()).toBe(main);
  });

  describe("when the repository changes between EO's checks and git's own reads", () => {
    let restore: () => void = () => {};
    afterEach(() => restore());

    it.skipIf(process.platform === "win32")("sends the commit EO read, whatever the branch is at when git starts", async () => {
      const head = await localTip();
      const main = await run(["rev-parse", "main"], repoPath);
      restore = beforeGitPush(scratch, `"$GIT" update-ref refs/heads/eo/APP-1 ${main}`);

      const pushed = await pushBranch(repoPath, "bare", "eo/APP-1");

      expect(pushed).toMatchObject({ ok: true, head, updated: true, destination: at(barePath) });
      expect(await remoteTip("eo/APP-1")).toBe(head);
    });

    it.skipIf(process.platform === "win32")("says the commit git refused is the one EO read, though the branch was elsewhere when git started and back by the time its hook ran", async () => {
      const first = await pushBranch(repoPath, "bare", "eo/APP-1");
      const old = sentBy(first);
      await run(["commit", "--amend", "-m", "rewritten"], repoPath);
      const head = await localTip();
      // The tip git would have read had it pushed the branch by name, and
      // which the branch leaves again before git runs any hook.
      const intervening = await run(["commit-tree", `${head}^{tree}`, "-m", "a commit EO never read"], repoPath);
      restore = beforeGitPush(scratch, `"$GIT" update-ref refs/heads/eo/APP-1 ${intervening}`);
      const hook = join(repoPath, await run(["rev-parse", "--git-path", "hooks"], repoPath), "pre-push");
      writeFileSync(hook, `#!/bin/sh
git update-ref refs/heads/eo/APP-1 ${head}
`, { mode: 0o755 });

      const rejected = await pushBranch(repoPath, "bare", "eo/APP-1");

      expect(rejected).toMatchObject({ ok: false, rejection: "diverged", head, published: null, destination: at(barePath) });
      expect(await remoteTip("eo/APP-1")).toBe(old);
    });

    it.skipIf(process.platform === "win32").each([
      ["", false],
      [", though the configuration allows that helper outright", true],
    ])("sends a lease through no remote helper configured for the remote after EO checked where it pushes%s", async (_, allowed) => {
      const first = await pushBranch(repoPath, "bare", "eo/APP-1");
      const old = sentBy(first);
      if (allowed) await run(["config", "protocol.elsewhere.allow", "always"], repoPath);
      await run(["commit", "--amend", "-m", "rewritten"], repoPath);
      const helpers = join(scratch, "helpers");
      mkdirSync(helpers);
      const ran = join(scratch, "helper-ran");
      writeFileSync(join(helpers, "git-remote-elsewhere"), `#!/bin/sh\n: > '${ran}'\nexit 1\n`, { mode: 0o755 });
      const path = process.env["PATH"];
      process.env["PATH"] = `${helpers}${delimiter}${path ?? ""}`;
      const unhelp = beforeGitPush(scratch, `"$GIT" config remote.bare.vcs elsewhere`);
      restore = () => {
        unhelp();
        process.env["PATH"] = path;
      };

      const leased = await pushBranch(repoPath, "bare", "eo/APP-1", { forceWithLease: { expect: old, destination: leasedAt(barePath), send: await localTip() } });

      expect(leased).toMatchObject({ ok: false, published: null });
      expect(existsSync(ran)).toBe(false);
      expect(await remoteTip("eo/APP-1")).toBe(old);
    });

    it.skipIf(process.platform === "win32")("sends a lease exactly the commit it is to send, though the branch moves after EO checked it", async () => {
      const first = await pushBranch(repoPath, "bare", "eo/APP-1");
      const old = sentBy(first);
      await run(["commit", "--amend", "-m", "rewritten"], repoPath);
      const rejected = await localTip();
      const replacement = await run(["commit-tree", `${rejected}^{tree}`, "-p", old, "-m", "a commit nobody rejected"], repoPath);
      restore = beforeGitPush(scratch, `"$GIT" update-ref refs/heads/eo/APP-1 ${replacement}`);

      const leased = await pushBranch(repoPath, "bare", "eo/APP-1", { forceWithLease: { expect: old, destination: leasedAt(barePath), send: rejected } });

      expect(leased).toMatchObject({ ok: true, head: rejected, updated: true, destination: at(barePath) });
      expect(await remoteTip("eo/APP-1")).toBe(rejected);
    });

    it.skipIf(process.platform === "win32")("sends a lease nowhere when the remote is given a push URL after EO checked where it pushes", async () => {
      const first = await pushBranch(repoPath, "bare", "eo/APP-1");
      const old = sentBy(first);
      const other = join(scratch, "other.git");
      await run(["init", "--bare", other], scratch);
      await run(["push", other, `${old}:refs/heads/eo/APP-1`], repoPath);
      await run(["commit", "--amend", "-m", "rewritten"], repoPath);
      restore = beforeGitPush(scratch, `"$GIT" config --add remote.bare.pushurl '${other}'`);

      const leased = await pushBranch(repoPath, "bare", "eo/APP-1", { forceWithLease: { expect: old, destination: leasedAt(barePath), send: await localTip() } });

      expect(leased).toMatchObject({ ok: false, rejection: "destination", published: null });
      expect(await run(["rev-parse", "eo/APP-1"], other)).toBe(old);
      expect(await remoteTip("eo/APP-1")).toBe(old);
    });

    it.skipIf(process.platform === "win32")("replaces EO's push only at the URL it checked when another is added beside it", async () => {
      const a = join(scratch, "a.git");
      const other = join(scratch, "other.git");
      await run(["init", "--bare", a], scratch);
      await run(["init", "--bare", other], scratch);
      await run(["config", "remote.bare.pushurl", a], repoPath);
      const first = await pushBranch(repoPath, "bare", "eo/APP-1");
      const old = sentBy(first);
      await run(["push", other, `${old}:refs/heads/eo/APP-1`], repoPath);
      await run(["commit", "--amend", "-m", "rewritten"], repoPath);
      restore = beforeGitPush(scratch, `"$GIT" config --add remote.bare.pushurl '${other}'`);

      const leased = await pushBranch(repoPath, "bare", "eo/APP-1", { forceWithLease: { expect: old, destination: leasedAt(a), send: await localTip() } });

      expect(leased).toMatchObject({ ok: false, rejection: "destination", published: await localTip(), destination: null });
      expect(await run(["rev-parse", "eo/APP-1"], a)).toBe(await localTip());
      expect(await run(["rev-parse", "eo/APP-1"], other)).toBe(old);
    });

    it.skipIf(process.platform === "win32")("sends a lease only where EO checked, through git's own receive-pack, when the remote is given a receivepack after EO checked it", async () => {
      const first = await pushBranch(repoPath, "bare", "eo/APP-1");
      const old = sentBy(first);
      const landed = join(scratch, "landed.git");
      await run(["init", "--bare", landed], scratch);
      await run(["push", landed, `${old}:refs/heads/eo/APP-1`], repoPath);
      const receive = join(scratch, "receive.sh");
      writeFileSync(receive, `#!/bin/sh\nexec git receive-pack '${landed}'\n`, { mode: 0o755 });
      await run(["commit", "--amend", "-m", "rewritten"], repoPath);
      restore = beforeGitPush(scratch, `"$GIT" config remote.bare.receivepack "'${receive}'"`);

      const leased = await pushBranch(repoPath, "bare", "eo/APP-1", { forceWithLease: { expect: old, destination: leasedAt(barePath), send: await localTip() } });

      expect(leased).toMatchObject({ ok: true, updated: true, destination: at(barePath) });
      expect(await run(["rev-parse", "eo/APP-1"], landed)).toBe(old);
      expect(await remoteTip("eo/APP-1")).toBe(await localTip());
    });

    it.skipIf(process.platform === "win32")("sends a lease nowhere, and records where a push really went, when a symlink in the path is pointed elsewhere after EO checked it", async () => {
      const a = join(scratch, "a.git");
      const b = join(scratch, "b.git");
      const link = join(scratch, "link.git");
      await run(["init", "--bare", a], scratch);
      await run(["init", "--bare", b], scratch);
      symlinkSync(a, link);
      await run(["remote", "set-url", "bare", link], repoPath);
      const first = await pushBranch(repoPath, "bare", "eo/APP-1");
      const old = sentBy(first);
      await run(["push", b, `${old}:refs/heads/eo/APP-1`], repoPath);
      await run(["commit", "--amend", "-m", "rewritten"], repoPath);
      // After EO has resolved the path to A, before git goes into it.
      restore = beforeGitPush(scratch, `rm '${link}' && ln -s '${b}' '${link}'`);

      const leased = await pushBranch(repoPath, "bare", "eo/APP-1", { forceWithLease: { expect: old, destination: leasedAt(a), send: await localTip() } });

      expect(leased).toMatchObject({ ok: false, rejection: "destination", published: null });
      expect(await run(["rev-parse", "eo/APP-1"], a)).toBe(old);
      expect(await run(["rev-parse", "eo/APP-1"], b)).toBe(old);

      // An ordinary push the same way names B, where it went, not A.
      restore();
      unlinkSync(link);
      symlinkSync(a, link);
      await commit(repoPath, "more.ts", "// more\n");
      const c = join(scratch, "c.git");
      await run(["init", "--bare", c], scratch);
      restore = beforeGitPush(scratch, `rm '${link}' && ln -s '${c}' '${link}'`);
      const pushed = await pushBranch(repoPath, "bare", "eo/APP-1");
      expect(pushed).toMatchObject({ ok: true, updated: true, destination: at(c) });
      expect(await run(["rev-parse", "eo/APP-1"], c)).toBe(sentBy(pushed));
    });

    it.skipIf(process.platform === "win32")("pins the SSH command EO read, so one configured after EO checked it does not take the push elsewhere", async () => {
      const told = join(scratch, "ssh.log");
      const shim = (name: string): string => {
        const path = join(scratch, `${name}.sh`);
        writeFileSync(path, `#!/bin/sh\necho ${name} >> '${told}'\nexit 1\n`, { mode: 0o755 });
        return path;
      };
      const checked = shim("checked");
      const later = shim("later");
      await run(["remote", "set-url", "bare", "ssh://git@host/~/repo.git"], repoPath);
      await run(["config", "core.sshCommand", `'${checked}'`], repoPath);
      restore = beforeGitPush(scratch, `"$GIT" config core.sshCommand "'${later}'"`);

      await pushBranch(repoPath, "bare", "eo/APP-1");

      // Git may run it twice, the first time to ask it what kind of SSH it is.
      const ran = readFileSync(told, "utf8").trim().split("\n");
      expect(ran.length).toBeGreaterThan(0);
      expect(new Set(ran)).toEqual(new Set(["checked"]));
    });

    it.skipIf(process.platform === "win32")("records the URL git pushed to, not the one EO read before it pushed", async () => {
      const other = join(scratch, "other.git");
      await run(["init", "--bare", other], scratch);
      restore = beforeGitPush(scratch, `"$GIT" remote set-url bare '${other}'`);

      const pushed = await pushBranch(repoPath, "bare", "eo/APP-1");

      expect(pushed).toMatchObject({ ok: true, updated: true, destination: null });
      expect(await run(["rev-parse", "eo/APP-1"], other)).toBe(sentBy(pushed));
    });
  });

  it("runs the repository's own hooks beside its gate, with what git gave them", async () => {
    const told = join(scratch, "told.log");
    const hooks = join(repoPath, await run(["rev-parse", "--git-path", "hooks"], repoPath));
    writeFileSync(join(hooks, "pre-push"), `#!/bin/sh\necho "pre-push $1 $2" >> '${told}'\ncat >> '${told}'\n`, { mode: 0o755 });
    writeFileSync(join(hooks, "reference-transaction"), `#!/bin/sh\n[ "$1" = committed ] && cat >> '${told}'\nexit 0\n`, { mode: 0o755 });
    await run(["config", "remote.bare.fetch", "+refs/heads/*:refs/remotes/bare/*"], repoPath);
    const head = await localTip();

    await pushBranch(repoPath, "bare", "eo/APP-1");

    const lines = readFileSync(told, "utf8").trim().split("\n");
    expect(lines[0]).toBe(`pre-push bare ${barePath}`);
    expect(lines[1]).toMatch(new RegExp(`^refs/heads/eo/APP-1 ${head} refs/heads/eo/APP-1 0+$`));
    expect(lines.some((line) => line.endsWith(` ${head} refs/remotes/bare/eo/APP-1`))).toBe(true);
  });

  // Windows symlinks need a privilege a test runner rarely has.
  it.skipIf(process.platform === "win32")("records no place where the remote's refs, or the branch's own file, lead into another repository", async () => {
    const elsewhere = join(scratch, "elsewhere.git");
    await run(["init", "--bare", elsewhere], scratch);
    const pushed = await pushBranch(repoPath, "bare", "eo/APP-1");
    expect(pushed).toMatchObject({ ok: true, destination: at(barePath) });
    await run(["push", elsewhere, `${sentBy(pushed)}:refs/heads/eo/APP-1`], repoPath);
    await commit(repoPath, "more.ts", "// more\n");

    // The branch's directory, then `refs/heads` itself, pointed at the other repository's.
    rmSync(join(barePath, "refs", "heads", "eo"), { recursive: true });
    symlinkSync(join(elsewhere, "refs", "heads", "eo"), join(barePath, "refs", "heads", "eo"));
    expect(await pushBranch(repoPath, "bare", "eo/APP-1")).toMatchObject({ ok: true, destination: null });

    rmSync(join(barePath, "refs", "heads"), { recursive: true });
    symlinkSync(join(elsewhere, "refs", "heads"), join(barePath, "refs", "heads"));
    await commit(repoPath, "again.ts", "// again\n");
    expect(await pushBranch(repoPath, "bare", "eo/APP-1")).toMatchObject({ ok: true, destination: null });
    expect(await run(["rev-parse", "eo/APP-1"], elsewhere)).toBe(await localTip());
  });

  it.skipIf(process.platform === "win32")("resolves a local path's symlink before the `..` after it, as git does, and records the repository git reached", async () => {
    // `link/..` is `nested`, where the link points, not `scratch`, where the link is.
    const nested = join(scratch, "nested");
    mkdirSync(nested);
    const target = join(nested, "target.git");
    const besideTarget = join(nested, "elsewhere.git");
    const besideLink = join(scratch, "elsewhere.git");
    for (const path of [target, besideTarget, besideLink]) await run(["init", "--bare", path], scratch);
    symlinkSync(target, join(scratch, "link"));
    await run(["remote", "set-url", "bare", `${scratch}/link/../elsewhere.git`], repoPath);

    const pushed = await pushBranch(repoPath, "bare", "eo/APP-1");

    expect(pushed).toMatchObject({ ok: true, updated: true, destination: at(besideTarget) });
    expect(await run(["rev-parse", "eo/APP-1"], besideTarget)).toBe(sentBy(pushed));
    expect(await git(["rev-parse", "--verify", "--quiet", "refs/heads/eo/APP-1"], besideLink)).toMatchObject({ ok: false });
  });

  it("sends nothing on a lease where the branch is no longer at the commit it is to send", async () => {
    const first = await pushBranch(repoPath, "bare", "eo/APP-1");
    const old = sentBy(first);
    await run(["commit", "--amend", "-m", "rewritten"], repoPath);
    const rejectedHead = await localTip();
    await run(["commit", "--amend", "-m", "rewritten again"], repoPath);

    const leased = await pushBranch(repoPath, "bare", "eo/APP-1", { forceWithLease: { expect: old, destination: leasedAt(barePath), send: rejectedHead } });

    expect(leased).toMatchObject({ ok: false, rejection: "changed", published: null });
    expect(await remoteTip("eo/APP-1")).toBe(old);
  });


  it("runs its gate though the environment names another hooks directory", async () => {
    const elsewhere = join(scratch, "elsewhere-hooks");
    mkdirSync(elsewhere);
    const previous = { parameters: process.env["GIT_CONFIG_PARAMETERS"], count: process.env["GIT_CONFIG_COUNT"], key: process.env["GIT_CONFIG_KEY_0"], value: process.env["GIT_CONFIG_VALUE_0"] };
    process.env["GIT_CONFIG_PARAMETERS"] = `'core.hookspath'='${elsewhere}'`;
    process.env["GIT_CONFIG_COUNT"] = "1";
    process.env["GIT_CONFIG_KEY_0"] = "core.hooksPath";
    process.env["GIT_CONFIG_VALUE_0"] = elsewhere;
    try {
      const pushed = await pushBranch(repoPath, "bare", "eo/APP-1");
      expect(pushed).toMatchObject({ ok: true, head: await localTip(), updated: true, destination: at(barePath) });
    } finally {
      for (const [name, value] of [["GIT_CONFIG_PARAMETERS", previous.parameters], ["GIT_CONFIG_COUNT", previous.count], ["GIT_CONFIG_KEY_0", previous.key], ["GIT_CONFIG_VALUE_0", previous.value]] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  // A file name ending in a space is not one Windows will make.
  it.skipIf(process.platform === "win32")("runs the repository's own hook from a core.hooksPath ending in a space, exactly as git names it", async () => {
    const spaced = join(scratch, "hooks ");
    const trimmed = join(scratch, "hooks");
    mkdirSync(spaced);
    mkdirSync(trimmed);
    writeFileSync(join(spaced, "pre-push"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    await run(["config", "core.hooksPath", spaced], repoPath);

    expect(await pushBranch(repoPath, "bare", "eo/APP-1")).toMatchObject({ ok: false, published: null });
    expect(await git(["rev-parse", "--verify", "--quiet", "refs/heads/eo/APP-1"], barePath)).toMatchObject({ ok: false });
  });

  // Windows symlinks need a privilege a test runner rarely has.
  it.skipIf(process.platform === "win32")("runs the repository's own hook from a core.hooksPath with `..` after a symlink, where git follows the symlink first", async () => {
    // `link/../hooks` is `nested/hooks` to the system, and `hooks` beside
    // `link` only to a path tidied before it is followed.
    mkdirSync(join(repoPath, "nested", "inner"), { recursive: true });
    mkdirSync(join(repoPath, "nested", "hooks"));
    mkdirSync(join(repoPath, "hooks"));
    symlinkSync(join(repoPath, "nested", "inner"), join(repoPath, "link"));
    writeFileSync(join(repoPath, "nested", "hooks", "pre-push"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    await run(["config", "core.hooksPath", "link/../hooks"], repoPath);

    expect(await pushBranch(repoPath, "bare", "eo/APP-1")).toMatchObject({ ok: false, published: null });
    expect(await remoteTip("eo/APP-1")).toBeNull();
  });

  describe("over HTTP", () => {
    const routes = new Map<string, GitHttpRoute>();
    let web: { url: string; close: () => Promise<void> };
    let a: string;
    let b: string;
    const tipIn = async (repo: string): Promise<string | null> => {
      const tip = await git(["rev-parse", "--verify", "--quiet", "refs/heads/eo/APP-1"], repo);
      return tip.ok ? tip.stdout : null;
    };

    beforeEach(async () => {
      const root = join(scratch, "web");
      mkdirSync(root);
      a = join(root, "a.git");
      b = join(root, "b.git");
      await run(["init", "--bare", a], scratch);
      await run(["init", "--bare", b], scratch);
      routes.clear();
      web = await gitHttpServer(root, routes);
      await run(["remote", "add", "web", `${web.url}/alias.git`], repoPath);
    });
    afterEach(async () => {
      await web.close();
    });

    it("records a push to the URL it names as a push there", async () => {
      routes.set("alias.git", { serve: "a.git" });

      const pushed = await pushBranch(repoPath, "web", "eo/APP-1");

      expect(pushed).toMatchObject({ ok: true, updated: true, destination: destinationKey(`${web.url}/alias.git`) });
      expect(await tipIn(a)).toBe(await localTip());
    });

    it("pushes to a URL the server redirects, as git would, and records it as a push to no one place", async () => {
      routes.set("alias.git", { redirect: "a.git" });

      const pushed = await pushBranch(repoPath, "web", "eo/APP-1");

      expect(pushed).toMatchObject({ ok: true, updated: true, destination: null });
      expect(await tipIn(a)).toBe(await localTip());
      expect(await tipIn(b)).toBeNull();
    });

    it("sends a lease along no redirect, though the repository's configuration says to follow them for that very URL", async () => {
      routes.set("alias.git", { serve: "a.git" });
      const first = await pushBranch(repoPath, "web", "eo/APP-1");
      const old = sentBy(first);
      const destination = first.destination!;
      // Somebody else's repository holding the same commit, which the URL now redirects to.
      await run(["push", b, `${old}:refs/heads/eo/APP-1`], repoPath);
      routes.set("alias.git", { redirect: "b.git" });
      await run(["config", `http.${web.url}/alias.git.followRedirects`, "true"], repoPath);
      await run(["commit", "--amend", "-m", "rewritten"], repoPath);

      const leased = await pushBranch(repoPath, "web", "eo/APP-1", { forceWithLease: { expect: old, destination, send: await localTip() } });

      expect(leased).toMatchObject({ ok: false, published: null });
      expect(await tipIn(a)).toBe(old);
      expect(await tipIn(b)).toBe(old);
    });
  });

  describe("when EO's own temporary files cannot be made, read or removed", () => {
    const saved = { TMPDIR: process.env["TMPDIR"], TEMP: process.env["TEMP"], TMP: process.env["TMP"] };
    let tmp: string;
    const useTmp = (dir: string): void => {
      for (const key of ["TMPDIR", "TEMP", "TMP"] as const) process.env[key] = dir;
    };
    const ownHook = async (body: string): Promise<void> => {
      const hooks = join(repoPath, await run(["rev-parse", "--git-path", "hooks"], repoPath));
      mkdirSync(hooks, { recursive: true });
      writeFileSync(join(hooks, "pre-push"), `#!/bin/sh\n${body}\nexit 0\n`, { mode: 0o755 });
    };
    beforeEach(() => {
      tmp = join(scratch, "tmp");
      mkdirSync(tmp);
    });
    afterEach(() => {
      chmodSync(tmp, 0o755);
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    it("pushes as git would, to no one place, where its temporary directory cannot be made, and sends no lease", async () => {
      useTmp(join(scratch, "missing"));
      const pushed = await pushBranch(repoPath, "bare", "eo/APP-1");
      expect(pushed).toMatchObject({ ok: true, updated: true, destination: null });
      expect(await remoteTip("eo/APP-1")).toBe(await localTip());

      useTmp(tmp);
      await commit(repoPath, "more.ts", "// more\n");
      const checked = await pushBranch(repoPath, "bare", "eo/APP-1");
      const old = sentBy(checked);
      expect(checked.destination).not.toBeNull();
      await run(["commit", "--amend", "-m", "rewritten"], repoPath);
      useTmp(join(scratch, "missing"));

      const leased = await pushBranch(repoPath, "bare", "eo/APP-1", { forceWithLease: { expect: old, destination: checked.destination!, send: await localTip() } });

      expect(leased).toMatchObject({ ok: false, published: null, rejection: "destination" });
      expect(await remoteTip("eo/APP-1")).toBe(old);
    });

    // A directory its owner can still write to is one a root test runner
    // can remove whatever its mode says.
    it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("says what git did where its temporary directory cannot be removed afterwards", async () => {
      useTmp(tmp);
      await ownHook(`chmod 555 ${JSON.stringify(tmp)}`);

      const pushed = await pushBranch(repoPath, "bare", "eo/APP-1");

      expect(pushed).toMatchObject({ ok: true, updated: true, head: await localTip() });
      expect(await remoteTip("eo/APP-1")).toBe(await localTip());
    });

    it.skipIf(process.platform === "win32")("keeps the commit git pushed, as a push to no one place, where what its check saw of the push cannot be read", async () => {
      useTmp(tmp);
      await ownHook(`rm -rf ${JSON.stringify(tmp)}/eo-push-*/marks`);

      const pushed = await pushBranch(repoPath, "bare", "eo/APP-1");

      expect(pushed).toMatchObject({ ok: true, updated: true, head: await localTip(), destination: null });
      expect(await remoteTip("eo/APP-1")).toBe(await localTip());
    });
  });

  it("takes nothing its own hook prints for git's account of the push", async () => {
    await pushBranch(repoPath, "bare", "eo/APP-1");
    const hook = join(repoPath, await run(["rev-parse", "--git-path", "hooks"], repoPath), "pre-push");
    writeFileSync(
      hook,
      // The refspec of whichever push it runs for, so that a line leaked
      // into the porcelain output would match it.
      `#!/bin/sh\nh=$(git rev-parse refs/heads/eo/APP-1)\nprintf '*\\t%s\\t[new branch]\\n' "$h^{commit}:refs/heads/eo/APP-1"\nprintf '!\\t%s\\t[rejected] (non-fast-forward)\\n' "$h^{commit}:refs/heads/eo/APP-1"\n`,
      { mode: 0o755 },
    );

    expect(await pushBranch(repoPath, "bare", "eo/APP-1")).toMatchObject({ ok: true, updated: false });

    writeFileSync(join(barePath, "hooks", "pre-receive"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    await commit(repoPath, "more.ts", "// more\n");
    expect(await pushBranch(repoPath, "bare", "eo/APP-1")).toMatchObject({ ok: false, rejection: "other", published: null });
  });

  it("resolves a relative push URL from the top of the checkout, where git does, though EO works from a directory inside it", async () => {
    const inside = join(repoPath, "sub");
    mkdirSync(inside);
    // `../rel.git` from the top of the checkout, which is not where it is from `sub`.
    const rel = join(scratch, "rel.git");
    await run(["init", "--bare", rel], scratch);
    await run(["init", "--bare", join(repoPath, "rel.git")], scratch);
    await run(["remote", "set-url", "bare", "../rel.git"], repoPath);

    const pushed = await pushBranch(inside, "bare", "eo/APP-1");

    expect(pushed).toMatchObject({ ok: true, updated: true, destination: at(rel) });
    expect(await run(["rev-parse", "eo/APP-1"], rel)).toBe(sentBy(pushed));
  });
});

describe("pushDestination (EO-910)", () => {
  beforeEach(async () => {
    await run(["remote", "add", "elsewhere", "https://example.com/acme/api.git"], repoPath);
  });

  it("is the remote's URL where no push URL is set", async () => {
    expect(await pushDestination(repoPath, "elsewhere")).toBe("https://example.com/acme/api.git");
  });

  it("is the push URL where one is, which is not where fetches read", async () => {
    await run(["config", "remote.elsewhere.pushurl", "git@example.com:acme/api.git"], repoPath);
    expect(await pushDestination(repoPath, "elsewhere")).toBe("git@example.com:acme/api.git");
  });

  it("applies pushInsteadOf, as the push itself does", async () => {
    await run(["config", "url.ssh://git@example.com/.pushInsteadOf", "https://example.com/"], repoPath);
    expect(await pushDestination(repoPath, "elsewhere")).toBe("ssh://git@example.com/acme/api.git");
  });

  it("is none for a push URL it cannot read back as one line", async () => {
    await run(["config", "remote.elsewhere.pushurl", "https://a.example.com/api.git\nhttps://b.example.com/api.git"], repoPath);
    expect(await pushDestination(repoPath, "elsewhere")).toBeNull();
  });

  it("is none for several push URLs, or a remote that does not exist", async () => {
    await run(["config", "--add", "remote.elsewhere.pushurl", "https://a.example.com/api.git"], repoPath);
    await run(["config", "--add", "remote.elsewhere.pushurl", "https://b.example.com/api.git"], repoPath);
    expect(await pushDestination(repoPath, "elsewhere")).toBeNull();
    expect(await pushDestination(repoPath, "nowhere")).toBeNull();
  });
});

describe("destinationKey", () => {
  it("is a fingerprint of the whole URL, keeping no credential written into it", () => {
    const key = destinationKey("https://user:ghp_secret@github.com/acme/api.git");
    expect(key).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(key).not.toContain("ghp_secret");
    expect(destinationKey("https://user:ghp_secret@github.com/acme/api.git")).toBe(key);
  });

  it("tells apart URLs that differ anywhere, the SSH user who picks the repository included", () => {
    const keys = [
      "ssh://alice@host/~/repo.git",
      "ssh://bob@host/~/repo.git",
      "alice@host:repo.git",
      "bob@host:repo.git",
      "https://github.com/acme/api.git",
      "https://user:other@github.com/acme/api.git",
    ].map(destinationKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("pushDiverged", () => {
  const refspec = "abc:refs/heads/eo/APP-1";
  it.each([
    ["[rejected] (fetch first)", true],
    ["[rejected] (non-fast-forward)", true],
    ["[remote rejected] (pre-receive hook declined)", false],
    ["[rejected] (stale info)", false],
  ])("reads %j as divergence: %s", (summary, diverged) => {
    expect(pushDiverged(`To ../bare.git\n!\t${refspec}\t${summary}\nDone`, refspec)).toBe(diverged);
  });

  it("reads nothing into a branch whose name says non-fast-forward", () => {
    const named = "abc:refs/heads/eo/non-fast-forward-APP-1";
    expect(pushDiverged(`To ../bare.git\n!\t${named}\t[remote rejected] (pre-receive hook declined)\nDone`, named)).toBe(false);
  });
});

describe("pushRefusal", () => {
  const refspec = "abc:refs/heads/eo/APP-1";
  it.each([
    ["[remote rejected] (pre-receive hook declined)", "[remote rejected] (pre-receive hook declined)"],
    ["[rejected] (stale info)", "[rejected] (stale info)"],
    ["[remote rejected]", "[remote rejected]"],
    // A reason a server or hook could fill with anything is not repeated.
    ["[remote rejected] (see https://tok:SECRET@example.com/x)", "[remote rejected]"],
    // Nor one a server chose that is only plain words: it could still be a token.
    ["[remote rejected] (SYNTHETIC_SECRET token here)", "[remote rejected]"],
    ["[remote whatever] (pre-receive hook declined)", "[rejected]"],
    ["something else entirely", "[rejected]"],
  ])("says %j as %j", (summary, said) => {
    expect(pushRefusal(`To ../bare.git\n!\t${refspec}\t${summary}\nDone`, refspec)).toBe(said);
  });

  it("is null where git gave the ref no refused status", () => {
    expect(pushRefusal("", refspec)).toBeNull();
    expect(pushRefusal(`To ../bare.git\n*\t${refspec}\t[new branch]\nDone`, refspec)).toBeNull();
  });
});

describe("pushUpdated", () => {
  const refspec = "abc:refs/heads/eo/APP-1";
  it.each([
    [" ", true],
    ["+", true],
    ["*", true],
    ["=", false],
    ["!", false],
  ])("reads the %j flag as moved: %s", (flag, moved) => {
    expect(pushUpdated(`To ../bare.git\n${flag}\t${refspec}\tsummary\nDone`, refspec)).toBe(moved);
  });

  it("is true when any of several URLs' lines moved the ref, and false when none did", () => {
    expect(pushUpdated(`To ../a.git\n=\t${refspec}\t[up to date]\nDone\nTo ../b.git\n*\t${refspec}\t[new branch]\nDone`, refspec)).toBe(true);
    expect(pushUpdated(`To ../a.git\n \t${refspec}\tabc..def\nDone\nTo ../b.git\n!\t${refspec}\t[rejected] (fetch first)\nDone`, refspec)).toBe(true);
    expect(pushUpdated(`To ../a.git\n=\t${refspec}\t[up to date]\nDone\nTo ../b.git\n!\t${refspec}\t[rejected]\nDone`, refspec)).toBe(false);
  });

  it("is false when its refspec has no line", () => {
    expect(pushUpdated("To ../bare.git\n \tother:refs/heads/other\tsummary\nDone", refspec)).toBe(false);
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

  it("writes git's refusal to create the temporary worktree as a code span (EO-830)", async () => {
    // A branch that does not exist: nothing holds it, so the rebase goes
    // to a temporary worktree, and git refuses to add one. Its refusal
    // can quote a path, which in a comment keeps its backslashes only
    // inside a code span.
    const result = await rebaseOntoBase(repoPath, "eo/NO-SUCH-BRANCH", "main");

    expect(result.ok).toBe(false);
    const error = result.ok ? "" : result.error;
    expect(error).toMatch(/^Could not create a temporary worktree to rebase `eo\/NO-SUCH-BRANCH` onto `main`: `[^`]+`$/);
  });

  it("writes git's refusal of a rebase that never started as a code span (EO-830)", async () => {
    await run(["checkout", "-b", "eo/TICKET-7b"], repoPath);
    await commit(repoPath, "ticket.txt", "work\n");
    await run(["checkout", "main"], repoPath);

    // A \`from\` that does not resolve: git refuses before it starts, so
    // there is nothing to abort and its own words are the reason.
    const result = await rebaseOntoBase(repoPath, "eo/TICKET-7b", "main", { from: "no-such-ref" });

    expect(result.ok).toBe(false);
    const error = result.ok ? "" : result.error;
    expect(error).toMatch(/^Rebasing `eo\/TICKET-7b` onto `main` failed: `[^`]*no-such-ref[^`]*`$/);
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
