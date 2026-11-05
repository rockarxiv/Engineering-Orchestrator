import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git, samePath } from "../../workspace/git.js";
import { CODEWIKI_HOOK_MARKER, containHooks, describeHookEscape, hookRedirectEnv } from "./hooks.js";
import { run, initRepo } from "../../../../testing/git.js";

/**
 * Keeping CodeWiki's git hooks out of somebody's repository (EO-146).
 *
 * Real repositories and real git throughout. The claim being made is
 * about how git resolves a hooks directory when its environment says
 * one thing and a repository says another, and against a mocked git
 * every assertion here would be an assertion about the mock.
 *
 * No binary is involved and none is needed: what is being proven is
 * that the environment EO hands a child process redirects hook
 * resolution, and that whatever lands in a repository's hooks directory
 * is put back exactly as it was. `provider.test.ts` then proves the
 * whole thing end to end with something that actually tries to install
 * them.
 */

let scratch: string;
let repoPath: string;

async function makeRepo(path: string): Promise<void> {
  await initRepo(path);
  writeFileSync(join(path, "README.md"), "# repo\n");
  await run(["add", "-A"], path);
  await run(["commit", "-m", "first"], path);
}

function hookFile(repo: string, name: string): string {
  return join(repo, ".git", "hooks", name);
}

/** What CodeWiki writes: its marker block, wrapped in a shell script. */
function codeWikiBlock(): string {
  return `${CODEWIKI_HOOK_MARKER}\nif command -v codewiki >/dev/null 2>&1; then\n  ( codewiki sync >/dev/null 2>&1 & )\nfi\n# <<< codewiki sync hook <<<\n`;
}

beforeEach(async () => {
  // A space in the path, deliberately: every path here reaches git and
  // an environment variable, and both are places a quoting mistake hides.
  scratch = mkdtempSync(join(tmpdir(), "eo codewiki hooks "));
  repoPath = join(scratch, "repo");
  await makeRepo(repoPath);
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("the environment that redirects hook resolution", () => {
  it("declares core.hooksPath when the parent declared nothing", () => {
    expect(hookRedirectEnv("/tmp/decoy", {})).toEqual({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: "/tmp/decoy",
    });
  });

  it("appends to what the parent already declared rather than overwriting it", () => {
    // The failure this prevents is silent and total: `GIT_CONFIG_COUNT=1`
    // written over an inherited `2` does not add a setting, it drops the
    // other two — and the whole point of reaching for this mechanism is
    // that it changes exactly one thing about one child.
    const inherited = { GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "somebody" };

    expect(hookRedirectEnv("/tmp/decoy", inherited)).toEqual({
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_2: "core.hooksPath",
      GIT_CONFIG_VALUE_2: "/tmp/decoy",
    });
  });

  it("treats a count that is not a count as no count at all", () => {
    expect(hookRedirectEnv("/tmp/decoy", { GIT_CONFIG_COUNT: "" })).toMatchObject({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath" });
    expect(hookRedirectEnv("/tmp/decoy", { GIT_CONFIG_COUNT: "lots" })).toMatchObject({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath" });
  });

  it("actually moves where git says the hooks are — asked of real git", async () => {
    const containment = await containHooks(repoPath);
    try {
      // The same question CodeWiki asks (`git rev-parse --git-path
      // hooks`), asked with and without the environment EO hands it.
      const redirected = await git(["rev-parse", "--git-path", "hooks"], repoPath, { env: containment.env });
      const ordinary = await git(["rev-parse", "--git-path", "hooks"], repoPath);

      expect(redirected.ok && redirected.stdout).toBe(containment.decoyPath);
      expect(ordinary.ok && ordinary.stdout).not.toBe(containment.decoyPath);
    } finally {
      await containment.release();
    }
  });

  it("finds a linked worktree's real hooks directory, which is not inside the worktree", async () => {
    // Every checkout EO makes is a linked worktree, where `.git` is a
    // file and the hooks live in the main repository's common directory.
    // A guard that looked at `<worktree>/.git/hooks` would be watching a
    // path that does not exist while CodeWiki wrote into somebody's own
    // checkout.
    const linked = join(scratch, "linked");
    await run(["worktree", "add", "-b", "side", linked], repoPath);
    writeFileSync(hookFile(repoPath, "post-commit"), `#!/bin/sh\n${codeWikiBlock()}`);

    const containment = await containHooks(linked);
    const outcome = await containment.release();

    expect(existsSync(join(linked, ".git"))).toBe(true);
    expect(statSync(join(linked, ".git")).isFile()).toBe(true);
    // `samePath` rather than `===`: this path came back from git, which
    // prints the fully resolved one, and on macOS a temporary directory
    // is reached through a symlink.
    expect(outcome.hooksPath !== null && samePath(outcome.hooksPath, join(repoPath, ".git", "hooks"))).toBe(true);
    // The marker was there before EO started, so it is somebody else's
    // and stays: this guard undoes what happened during its own watch
    // and nothing else.
    expect(outcome.restored).toEqual([]);
    expect(readFileSync(hookFile(repoPath, "post-commit"), "utf8")).toContain(CODEWIKI_HOOK_MARKER);
  });
});

/**
 * Whether this process is subject to file permissions at all.
 *
 * The one test below simulates "a hooks directory EO may read but not
 * write" with `chmod`, and that simulation only works for a user the
 * mode bits actually bind. Root is not such a user — it bypasses them
 * entirely, so the directory stays writable, the hook is removed, and
 * the guard correctly reports a clean recovery that the test was
 * written to see fail. CI runs this suite in a container as root, which
 * is why that test passed on every developer machine and had never once
 * passed on CI.
 *
 * Windows was already skipped for the same reason with a different
 * cause: `chmod` there does not model POSIX permissions either. This
 * replaces that check rather than sitting beside it, because the
 * question both are asking is this one.
 */
const BOUND_BY_PERMISSIONS = process.platform !== "win32" && process.getuid?.() !== 0;

describe("what the guard does with hooks that appear while it is watching", () => {
  it("reports nothing and deletes its throwaway directory when nothing was written", async () => {
    const containment = await containHooks(repoPath);
    const decoy = containment.decoyPath;
    expect(existsSync(decoy)).toBe(true);

    const outcome = await containment.release();

    expect(outcome).toMatchObject({ restored: [], leaked: [] });
    expect(describeHookEscape(outcome)).toBeNull();
    expect(existsSync(decoy)).toBe(false);
  });

  it("deletes a hook file that was not there before", async () => {
    const containment = await containHooks(repoPath);
    // What `codewiki init` does when git tells it the hooks belong here.
    writeFileSync(hookFile(repoPath, "post-commit"), `#!/bin/sh\n${codeWikiBlock()}`);

    const outcome = await containment.release();

    expect(outcome.restored).toEqual([hookFile(repoPath, "post-commit")]);
    expect(outcome.leaked).toEqual([]);
    expect(existsSync(hookFile(repoPath, "post-commit"))).toBe(false);
  });

  it("puts a hook somebody else wrote back byte for byte, mode and all", async () => {
    const mine = "#!/bin/sh\n# my own hook\nnpm run lint\n";
    writeFileSync(hookFile(repoPath, "post-merge"), mine);
    chmodSync(hookFile(repoPath, "post-merge"), 0o755);
    const before = statSync(hookFile(repoPath, "post-merge")).mode;

    const containment = await containHooks(repoPath);
    // Upstream appends its block to whatever was there, which is what
    // makes "strip the block back out again" look like the obvious
    // repair — and why this asserts the bytes rather than the absence of
    // a marker. Restoring the snapshot cannot leave a stray blank line
    // or a trimmed trailing newline behind; editing would have to be
    // trusted not to.
    writeFileSync(hookFile(repoPath, "post-merge"), `${mine}\n${codeWikiBlock()}`);

    const outcome = await containment.release();

    expect(outcome.restored).toEqual([hookFile(repoPath, "post-merge")]);
    expect(readFileSync(hookFile(repoPath, "post-merge"), "utf8")).toBe(mine);
    expect(statSync(hookFile(repoPath, "post-merge")).mode).toBe(before);
  });

  it("leaves every other file in the hooks directory alone", async () => {
    const samples = join(repoPath, ".git", "hooks", "pre-commit.sample");
    const before = readFileSync(samples, "utf8");

    const containment = await containHooks(repoPath);
    writeFileSync(hookFile(repoPath, "post-checkout"), `#!/bin/sh\n${codeWikiBlock()}`);
    const outcome = await containment.release();

    expect(outcome.restored).toEqual([hookFile(repoPath, "post-checkout")]);
    expect(readFileSync(samples, "utf8")).toBe(before);
  });

  it.skipIf(!BOUND_BY_PERMISSIONS)("reports a hook it could not put back, rather than claiming it did", async () => {
    const containment = await containHooks(repoPath);
    writeFileSync(hookFile(repoPath, "post-commit"), `#!/bin/sh\n${codeWikiBlock()}`);
    // A hooks directory EO may read but not write. Contrived, and the
    // point is what the guard says when repair fails: the repository is
    // still carrying somebody else's hook and the sentence has to say so
    // rather than reporting a clean recovery.
    chmodSync(join(repoPath, ".git", "hooks"), 0o500);

    let outcome;
    try {
      outcome = await containment.release();
    } finally {
      chmodSync(join(repoPath, ".git", "hooks"), 0o755);
    }

    expect(outcome.restored).toEqual([]);
    expect(outcome.leaked).toEqual([hookFile(repoPath, "post-commit")]);
    expect(describeHookEscape(outcome)).toContain("could not remove them");
    expect(describeHookEscape(outcome)).toContain(hookFile(repoPath, "post-commit"));
  });

  it("says what happened in words that name files and never quote them", async () => {
    const containment = await containHooks(repoPath);
    writeFileSync(hookFile(repoPath, "post-commit"), `#!/bin/sh\n${codeWikiBlock()}\necho "a line nobody should ever read in a comment"\n`);

    const escape = describeHookEscape(await containment.release());

    expect(escape).toContain(hookFile(repoPath, "post-commit"));
    expect(escape).toContain("put those files back");
    expect(escape).not.toContain("a line nobody should ever read");
  });

  it("still cleans up when the work it was watching threw", async () => {
    // The case the guard exists for is the one that went wrong: a
    // command that timed out or was cancelled is exactly the one that
    // may have written something on its way out.
    const containment = await containHooks(repoPath);
    const decoy = containment.decoyPath;
    writeFileSync(hookFile(repoPath, "post-commit"), `#!/bin/sh\n${codeWikiBlock()}`);

    await containment.release();

    expect(existsSync(decoy)).toBe(false);
    expect(existsSync(hookFile(repoPath, "post-commit"))).toBe(false);
  });

  it("does nothing at all outside a git repository, and does not fall over", async () => {
    const plain = join(scratch, "not a repo");
    mkdirSync(plain, { recursive: true });

    const containment = await containHooks(plain);
    const outcome = await containment.release();

    expect(outcome).toMatchObject({ restored: [], leaked: [] });
    expect(existsSync(containment.decoyPath)).toBe(false);
  });
});
