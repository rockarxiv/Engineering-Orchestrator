import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EO_EXCLUDE_BANNER, excludeGeneratedDirectories } from "./excludes.js";
import { samePath } from "./git.js";
import { run, status, makeRepo as sharedMakeRepo } from "../../../testing/git.js";

/**
 * Against real repositories, for the reason `worktrees.test.ts` is: the
 * claim under test is what *git* does with a file, and a mock would
 * assert only that we wrote the bytes we meant to. The load-bearing one
 * — that a linked worktree's `info/exclude` is the main repository's
 * copy — is a fact about git's own layout, and the only way to state it
 * is to make a worktree and look.
 */
let scratch: string;
let repoPath: string;

async function makeRepo(name: string): Promise<string> {
  return sharedMakeRepo(scratch, name, { readme: "# fixture\n" });
}

/**
 * The other directory EO generates, standing in for the repository
 * index.
 *
 * Named here rather than imported, because which directory an index
 * lands in is the configured provider's answer and nothing outside
 * `repositoryIntelligence/` may know it. What this file is about is what
 * the exclusion does with *a* directory name, and the caller that
 * supplies the real ones is `worktrees.ts` — where `worktrees.test.ts`
 * asserts they arrive.
 */
const INDEX_DIRECTORY = ".generated-index";

/** A directory of EO's, planted where EO would plant it. */
function plant(root: string, directory: string): void {
  mkdirSync(join(root, directory, "inner"), { recursive: true });
  writeFileSync(join(root, directory, "inner", "generated.txt"), "generated\n");
}

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), "eo exclude test "));
  repoPath = await makeRepo("the repo");
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("excludeGeneratedDirectories", () => {
  it("keeps EO's own directories out of git status", async () => {
    plant(repoPath, ".agent");
    plant(repoPath, INDEX_DIRECTORY);
    expect(await status(repoPath)).not.toBe("");

    const outcome = await excludeGeneratedDirectories(repoPath, [".agent", INDEX_DIRECTORY]);

    expect(outcome.ok).toBe(true);
    expect(await status(repoPath)).toBe("");
  });

  it("writes into .git/info/exclude and never a .gitignore", async () => {
    // The whole reason this route was chosen: EO drives repositories it
    // does not own, and a tracked `.gitignore` is somebody's file — an
    // edit to it lands in the diff under review.
    writeFileSync(join(repoPath, ".gitignore"), "node_modules/\ndist/\n");
    await run(["add", ".gitignore"], repoPath);
    await run(["commit", "-m", "their own ignore file"], repoPath);
    const before = readFileSync(join(repoPath, ".gitignore"));

    await excludeGeneratedDirectories(repoPath, [".agent", INDEX_DIRECTORY]);

    // Byte for byte, and still the only ignore file in the checkout.
    expect(readFileSync(join(repoPath, ".gitignore"))).toEqual(before);
    expect(readFileSync(join(repoPath, ".git", "info", "exclude"), "utf8")).toContain("/.agent/");
    expect(await status(repoPath)).toBe("");
  });

  it("keeps what was already in the exclude file, and says who added the rest", async () => {
    const theirs = "# mine\nscratch/\n";
    writeFileSync(join(repoPath, ".git", "info", "exclude"), theirs);

    await excludeGeneratedDirectories(repoPath, [".agent"]);

    const written = readFileSync(join(repoPath, ".git", "info", "exclude"), "utf8");
    expect(written.startsWith(theirs)).toBe(true);
    // Signed, because it is a person's file EO is adding to and they are
    // entitled to know which lines are not theirs.
    expect(written).toContain(EO_EXCLUDE_BANNER);
    expect(written).toContain("/.agent/");
  });

  it("adds nothing the second time", async () => {
    const first = await excludeGeneratedDirectories(repoPath, [".agent", INDEX_DIRECTORY]);
    expect(first.ok && first.added).toEqual(["/.agent/", `/${INDEX_DIRECTORY}/`]);
    const after = readFileSync(join(repoPath, ".git", "info", "exclude"), "utf8");

    // It runs on every worktree preparation, so a run that changes the
    // file every time would grow it without bound.
    const second = await excludeGeneratedDirectories(repoPath, [".agent", INDEX_DIRECTORY]);

    expect(second.ok && second.added).toEqual([]);
    expect(readFileSync(join(repoPath, ".git", "info", "exclude"), "utf8")).toBe(after);
  });

  it("adds only what is missing when one of them is already excluded", async () => {
    writeFileSync(join(repoPath, ".git", "info", "exclude"), `/${INDEX_DIRECTORY}/\n`);

    const outcome = await excludeGeneratedDirectories(repoPath, [".agent", INDEX_DIRECTORY]);

    expect(outcome.ok && outcome.added).toEqual(["/.agent/"]);
  });

  it("reaches a linked worktree, whose info/exclude is the main repository's copy", async () => {
    // The correction EO-207 needed. Git's per-worktree path list holds
    // `info/` as common with one exception (`info/sparse-checkout`), so
    // `$GIT_DIR/info/exclude` in a linked worktree resolves through
    // `commondir` — which is why the path is asked for with `rev-parse
    // --git-path` rather than joined onto the worktree (there, `.git` is
    // a file, and the join is not even a directory).
    const worktree = join(scratch, "linked");
    await run(["worktree", "add", worktree, "-b", "eo/EO-207"], repoPath);
    plant(worktree, ".agent");

    const outcome = await excludeGeneratedDirectories(worktree, [".agent"]);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // `samePath`, not string equality: `--git-path` answers in git's own
    // spelling — forward slashes, and the long form of a directory that
    // `tmpdir()` handed us as an 8.3 short name on Windows — so the two
    // name the same file and differ as strings. That is the whole reason
    // `samePath` exists, and `realpathSync` alone is not enough: it
    // normalises separators and leaves `RUNNER~1` short, where
    // `realpathSync.native` behind `samePath` expands it.
    const expected = join(repoPath, ".git", "info", "exclude");
    expect(samePath(outcome.file, expected), `${outcome.file} vs ${expected}`).toBe(true);
    expect(await status(worktree)).toBe("");
  });

  it("refuses rather than throws when the path is not a repository", async () => {
    const notARepo = join(scratch, "not a repo");
    mkdirSync(notARepo, { recursive: true });

    const outcome = await excludeGeneratedDirectories(notARepo, [".agent"]);

    expect(outcome.ok).toBe(false);
  });
});
