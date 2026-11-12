import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git } from "./git.js";
import { resolveRemoteRef } from "./remoteRef.js";
import { run, initRepo } from "../../../testing/git.js";

/**
 * Real repositories and a real bare remote, for the same reason
 * `worktrees.test.ts` uses them: what is under test is whether these git
 * invocations behave, and a mock would only assert that we call the
 * commands we think we call. Directory names contain a space on purpose.
 */
let scratch: string;
let repoPath: string;
let remotePath: string;

async function commit(cwd: string, file: string, message: string): Promise<void> {
  writeFileSync(join(cwd, file), `${message}\n`);
  await run(["add", "-A"], cwd);
  await run(["commit", "-m", message], cwd);
}

async function makeRepo(name: string): Promise<string> {
  const path = join(scratch, name);
  await initRepo(path);
  await commit(path, "README.md", "initial");
  return path;
}

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), "eo remote ref "));
  repoPath = await makeRepo("the repo");
  remotePath = join(scratch, "the remote.git");
  await run(["init", "--bare", "-b", "main", remotePath], scratch);
  await run(["remote", "add", "origin", remotePath], repoPath);
  await run(["push", "-u", "origin", "main"], repoPath);
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** A commit pushed to the remote by somebody else, which `repoPath` has never seen. */
async function landUpstream(message: string): Promise<string> {
  const clone = join(scratch, `${message} clone`);
  await run(["clone", remotePath, clone], scratch);
  await run(["config", "user.email", "other@example.com"], clone);
  await run(["config", "user.name", "Someone Else"], clone);
  await run(["config", "commit.gpgsign", "false"], clone);
  await run(["config", "tag.gpgsign", "false"], clone);
  await commit(clone, `${message}.txt`, message);
  await run(["push", "origin", "main"], clone);
  const head = await git(["rev-parse", "HEAD"], clone);
  if (!head.ok) throw new Error(head.error);
  return head.stdout;
}

describe("resolveRemoteRef", () => {
  it("resolves to the remote-tracking ref", async () => {
    const resolved = await resolveRemoteRef(repoPath, "origin", "main");

    expect(resolved).toEqual({ kind: "remote", ref: "origin/main" });
  });

  it("fetches first, so the ref it names is the remote's current tip", async () => {
    const upstream = await landUpstream("landed");

    const resolved = await resolveRemoteRef(repoPath, "origin", "main");

    expect(resolved.kind).toBe("remote");
    if (resolved.kind !== "remote") return;
    // The point of the fetch: before it, origin/main was the old commit.
    const tip = await git(["rev-parse", resolved.ref], repoPath);
    expect(tip.ok && tip.stdout).toBe(upstream);
  });

  it("leaves the local branch and the working copy alone", async () => {
    await landUpstream("landed");
    const before = await git(["rev-parse", "main"], repoPath);

    await resolveRemoteRef(repoPath, "origin", "main");

    // Never a fast-forward of the human's branch: that is their checkout,
    // and it fails outright when it is the one they have checked out.
    const after = await git(["rev-parse", "main"], repoPath);
    expect(after.ok && after.stdout).toBe(before.ok && before.stdout);
    const status = await git(["status", "--porcelain"], repoPath);
    expect(status.ok && status.stdout).toBe("");
  });

  it("resolves a branch that is not the base branch, so a stacked dependency reads from the remote too", async () => {
    await run(["checkout", "-b", "eo/EO-1"], repoPath);
    await commit(repoPath, "dep.txt", "dependency work");
    await run(["push", "-u", "origin", "eo/EO-1"], repoPath);
    await run(["checkout", "main"], repoPath);

    expect(await resolveRemoteRef(repoPath, "origin", "eo/EO-1")).toEqual({ kind: "remote", ref: "origin/eo/EO-1" });
  });

  it("reports no-remote for a repository that has none", async () => {
    const local = await makeRepo("no remote here");

    expect(await resolveRemoteRef(local, "origin", "main")).toEqual({ kind: "no-remote" });
  });

  it("reports no-remote when the configured remote name is not the one this repository has", async () => {
    expect(await resolveRemoteRef(repoPath, "upstream", "main")).toEqual({ kind: "no-remote" });
  });

  it("reports unresolved, with what git said, when the remote has no such branch", async () => {
    const resolved = await resolveRemoteRef(repoPath, "origin", "develop");

    expect(resolved.kind).toBe("unresolved");
    if (resolved.kind !== "unresolved") return;
    expect(resolved.problem).toContain("develop");
  });

  it("still resolves to the tracking ref when the remote has become unreachable", async () => {
    // An offline laptop should not stop a dispatch: the tracking ref is
    // older than it could be, but it is still what the remote said, and
    // the local branch is not a better answer.
    rmSync(remotePath, { recursive: true, force: true });

    const resolved = await resolveRemoteRef(repoPath, "origin", "main");

    expect(resolved).toMatchObject({ kind: "remote", ref: "origin/main" });
    // Marked as not confirmed by this call, with what the fetch said
    // (EO-364): a base a person named refuses a ref it cannot confirm.
    expect(resolved.kind === "remote" && resolved.unconfirmed).toBeTruthy();
  });

  it("moves the tracking ref even when the remote's refspec does not cover the branch", async () => {
    // `release/2.4` fetched once into a tracking ref, then the remote is
    // set to fetch only `main` — a mirror-ish or hand-configured remote.
    await run(["push", "origin", "main:release/2.4"], repoPath);
    await run(["config", "remote.origin.fetch", "+refs/heads/main:refs/remotes/origin/main"], repoPath);
    const old = await git(["rev-parse", "origin/release/2.4"], repoPath);

    // The branch moves on upstream.
    const clone = join(scratch, "release clone");
    await run(["clone", "-b", "release/2.4", remotePath, clone], scratch);
    await run(["config", "user.email", "other@example.com"], clone);
    await run(["config", "user.name", "Someone Else"], clone);
    await run(["config", "commit.gpgsign", "false"], clone);
    await commit(clone, "release-fix.txt", "release fix");
    await run(["push", "origin", "release/2.4"], clone);
    const tip = await git(["rev-parse", "HEAD"], clone);

    const resolved = await resolveRemoteRef(repoPath, "origin", "release/2.4");

    // The fetch names the tracking ref as its destination, so it is the
    // remote's tip whatever the configured refspec covers.
    expect(resolved).toEqual({ kind: "remote", ref: "origin/release/2.4" });
    const after = await git(["rev-parse", "origin/release/2.4"], repoPath);
    expect(after).not.toEqual(old);
    expect(after.ok && after.stdout).toBe(tip.ok && tip.stdout);
  });

  it("says nothing extra when the fetch moved the tracking ref itself", async () => {
    await landUpstream("landed");

    expect(await resolveRemoteRef(repoPath, "origin", "main")).toEqual({ kind: "remote", ref: "origin/main" });
  });

  it("marks a branch deleted upstream as unconfirmed, though its old tracking ref is still here", async () => {
    await run(["push", "origin", "main:release/2.4"], repoPath);
    expect(await resolveRemoteRef(repoPath, "origin", "release/2.4")).toEqual({ kind: "remote", ref: "origin/release/2.4" });
    // Deleted on the remote itself, as somebody else's cleanup would —
    // a push --delete from here would take the tracking ref with it.
    await run(["branch", "-D", "release/2.4"], remotePath);
    expect(await git(["rev-parse", "--verify", "origin/release/2.4"], repoPath)).toMatchObject({ ok: true });

    const resolved = await resolveRemoteRef(repoPath, "origin", "release/2.4");

    expect(resolved).toMatchObject({ kind: "remote", ref: "origin/release/2.4" });
    expect(resolved.kind === "remote" && resolved.unconfirmed).toBeTruthy();
  });

  it("reports unresolved when the remote is unreachable and nothing was ever fetched", async () => {
    const fresh = await makeRepo("never fetched");
    await run(["remote", "add", "origin", join(scratch, "does not exist.git")], fresh);

    const resolved = await resolveRemoteRef(fresh, "origin", "main");

    expect(resolved.kind).toBe("unresolved");
    if (resolved.kind !== "unresolved") return;
    expect(resolved.problem).toContain("git fetch origin main");
  });
});
