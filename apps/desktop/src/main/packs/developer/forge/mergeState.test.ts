import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliResult, CliRunner } from "./cli.js";
import { resolveMergeState, type ResolveMergeStateInput } from "./mergeState.js";

/**
 * Forge-first, git-fallback merge-state resolution (EO-10 / KAN-42).
 *
 * The forge-success paths never touch git at all, so a placeholder
 * `repoPath` is enough for them. The fallback paths are exercised
 * against a real repository and a real clone — same discipline as
 * `openPullRequest.test.ts` and `workspace/git.test.ts` — so the
 * "never returns closed" guarantee is proven against real git, not a
 * mock of it.
 */

interface Call {
  cli: string;
  args: string[];
}

function recorder(replies: CliResult[] = []): { run: CliRunner; calls: Call[] } {
  const calls: Call[] = [];
  const queue = [...replies];
  const run: CliRunner = async (cli, args) => {
    calls.push({ cli, args });
    return queue.shift() ?? { ok: true, stdout: "[]", error: "", notFound: false };
  };
  return { run, calls };
}

const json = (value: unknown): CliResult => ({ ok: true, stdout: JSON.stringify(value), error: "", notFound: false });
const notFound: CliResult = { ok: false, stdout: "", error: "command not found: gh", notFound: true };
const erroring: CliResult = { ok: false, stdout: "", error: "HTTP 500: something went wrong", notFound: false };

function input(overrides: Partial<ResolveMergeStateInput> = {}): ResolveMergeStateInput {
  return {
    repoPath: "/unused",
    branch: "eo/EO-2",
    baseBranch: "main",
    remote: "origin",
    forgeKind: "github",
    run: recorder().run,
    ...overrides,
  };
}

describe("forge state — github", () => {
  it("reports 'open' for gh's OPEN", async () => {
    const { run } = recorder([json([{ url: "https://github.com/acme/api/pull/1", state: "OPEN" }])]);
    expect(await resolveMergeState(input({ run }))).toBe("open");
  });

  it("reports 'merged' for gh's MERGED", async () => {
    const { run } = recorder([json([{ url: "https://github.com/acme/api/pull/1", state: "MERGED" }])]);
    expect(await resolveMergeState(input({ run }))).toBe("merged");
  });

  it("reports 'closed' for gh's CLOSED", async () => {
    const { run } = recorder([json([{ url: "https://github.com/acme/api/pull/1", state: "CLOSED" }])]);
    expect(await resolveMergeState(input({ run }))).toBe("closed");
  });

  it("asks gh for exactly the same lookup openPullRequest uses", async () => {
    const { run, calls } = recorder([json([{ url: "https://github.com/acme/api/pull/1", state: "OPEN" }])]);
    await resolveMergeState(input({ run, branch: "eo/EO-2" }));
    expect(calls[0]).toEqual({ cli: "gh", args: ["pr", "list", "--head", "eo/EO-2", "--state", "all", "--json", "url,state", "--limit", "1"] });
  });
});

describe("forge state — gitlab", () => {
  it("reports 'open' for glab's opened", async () => {
    const { run } = recorder([json([{ web_url: "https://gitlab.com/acme/api/-/merge_requests/1", state: "opened" }])]);
    expect(await resolveMergeState(input({ run, forgeKind: "gitlab" }))).toBe("open");
  });

  it("reports 'merged' for glab's merged", async () => {
    const { run } = recorder([json([{ web_url: "https://gitlab.com/acme/api/-/merge_requests/1", state: "merged" }])]);
    expect(await resolveMergeState(input({ run, forgeKind: "gitlab" }))).toBe("merged");
  });

  it("reports 'closed' for glab's closed", async () => {
    const { run } = recorder([json([{ web_url: "https://gitlab.com/acme/api/-/merge_requests/1", state: "closed" }])]);
    expect(await resolveMergeState(input({ run, forgeKind: "gitlab" }))).toBe("closed");
  });
});

describe("falling back to git", () => {
  let scratch: string;
  let originPath: string;
  let repoPath: string;

  function git(args: string[], cwd: string): void {
    execFileSync("git", args, { cwd, encoding: "utf8" });
  }

  function commit(path: string, file: string): void {
    writeFileSync(join(path, file), "x\n");
    git(["add", "-A"], path);
    git(["commit", "-m", `add ${file}`], path);
  }

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "eo merge-state "));
    originPath = join(scratch, "origin");
    repoPath = join(scratch, "repo");

    mkdirSync(originPath, { recursive: true });
    git(["init", "-b", "main"], originPath);
    git(["config", "user.email", "eo@example.com"], originPath);
    git(["config", "user.name", "EO Test"], originPath);
    git(["config", "commit.gpgsign", "false"], originPath);
    git(["config", "tag.gpgsign", "false"], originPath);
    commit(originPath, "README.md");

    // Already landed on main — trivially an ancestor.
    git(["branch", "eo/EO-merged", "main"], originPath);

    // Has a commit main doesn't — not yet merged.
    git(["checkout", "-b", "eo/EO-open"], originPath);
    commit(originPath, "wip.txt");
    git(["checkout", "main"], originPath);

    // A clone with a plain filesystem path as its remote — not a URL
    // `guessForge` can read a host out of, which is exactly how "no
    // forge configured and none guessable" arises without extra
    // plumbing.
    git(["clone", originPath, repoPath], scratch);
    git(["config", "user.email", "eo@example.com"], repoPath);
    git(["config", "user.name", "EO Test"], repoPath);
    git(["config", "commit.gpgsign", "false"], repoPath);
    git(["config", "tag.gpgsign", "false"], repoPath);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(scratch, { recursive: true, force: true });
  });

  it("falls back when the CLI is not found, and reports 'merged' for an already-landed branch", async () => {
    const { run } = recorder([notFound]);
    const result = await resolveMergeState(input({ run, repoPath, branch: "eo/EO-merged", forgeKind: "github" }));
    expect(result).toBe("merged");
  });

  it("falls back when the CLI exits non-zero, and reports 'open' for a not-yet-landed branch", async () => {
    const { run } = recorder([erroring]);
    const result = await resolveMergeState(input({ run, repoPath, branch: "eo/EO-open", forgeKind: "github" }));
    expect(result).toBe("open");
  });

  it("falls back straight to git, without calling the CLI at all, when there is no forge configured", async () => {
    const { run, calls } = recorder([]);
    const result = await resolveMergeState(input({ run, repoPath, branch: "eo/EO-merged", forgeKind: null }));
    expect(calls).toEqual([]);
    expect(result).toBe("merged");
  });

  it("measures 'merged' against the remote's base branch, not the local one", async () => {
    // The dependency landed on origin's main while the local clone's main
    // stayed where it was — the ordinary state of a checkout nobody has
    // pulled in a day. Against the local branch this reads as 'open', and
    // the dependent story goes on being stacked on commits that are
    // already in the base.
    git(["merge", "--no-ff", "-m", "merge eo/EO-open", "eo/EO-open"], originPath);

    const { run } = recorder([notFound]);
    const result = await resolveMergeState(input({ run, repoPath, branch: "eo/EO-open", forgeKind: "github" }));

    expect(result).toBe("merged");
    // The clone's own main was not moved to get there.
    const localMain = execFileSync("git", ["rev-parse", "main"], { cwd: repoPath, encoding: "utf8" }).trim();
    const localOrigin = execFileSync("git", ["rev-parse", "origin/main"], { cwd: repoPath, encoding: "utf8" }).trim();
    expect(localMain).not.toBe(localOrigin);
  });

  it("compares the commit its own fetch brought back, even when another fetch rewrites FETCH_HEAD straight after (EO-755)", async () => {
    // Another item's step fetches a branch that has landed, in the same
    // repository, the moment this fetch of an open one returns. Read off
    // `FETCH_HEAD`, the open branch would be reported merged.
    const gitModule = await import("../workspace/git.js");
    const realFetchBranch = gitModule.fetchBranch;
    vi.spyOn(gitModule, "fetchBranch").mockImplementation(async (path, remote, branch, options) => {
      const fetched = await realFetchBranch(path, remote, branch, options);
      if (branch === "eo/EO-open") git(["fetch", "origin", "eo/EO-merged"], repoPath);
      return fetched;
    });

    const { run } = recorder([notFound]);
    const result = await resolveMergeState(input({ run, repoPath, branch: "eo/EO-open", forgeKind: "github" }));

    const fetchHead = execFileSync("git", ["rev-parse", "FETCH_HEAD"], { cwd: repoPath, encoding: "utf8" }).trim();
    const merged = execFileSync("git", ["rev-parse", "origin/eo/EO-merged"], { cwd: repoPath, encoding: "utf8" }).trim();
    expect(fetchHead).toBe(merged);
    expect(result).toBe("open");
  });

  it("never reports 'closed' from the fallback, even for a branch that never merged", async () => {
    const { run } = recorder([notFound]);
    const result = await resolveMergeState(input({ run, repoPath, branch: "eo/EO-open", forgeKind: "github" }));
    expect(result).not.toBe("closed");
    expect(result).toBe("open");
  });
});
