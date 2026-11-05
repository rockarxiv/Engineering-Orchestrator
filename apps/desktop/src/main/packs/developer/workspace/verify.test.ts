import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git } from "./git.js";
import { runCommand } from "../../../process/runCommand.js";
import { createWorktree, worktreePathFor, type WorktreeConfig } from "./worktrees.js";
import { formatVerificationComment, verifyImplementation } from "./verify.js";
import { toolDirectoryPath, writeToolDirectory } from "../../../agentAttachments/pluginDirectory.js";
import { borrowedFromSiblings } from "./borrowed.js";
import { REPOSITORY_INDEX_DIRECTORIES } from "../repositoryIntelligence/index.js";
import { run } from "../../../testing/git.js";
import { readTree } from "../../../testing/tree.js";
import { removeScratch } from "../../../testing/scratch.js";

let scratch: string;
let repoPath: string;
let worktreeRoot: string;

function config(): WorktreeConfig {
  return { repoPath, baseBranch: "main", worktreeRoot };
}

/** Commits everything in a worktree, the way a well-behaved agent would. */
async function commitAll(cwd: string, message: string): Promise<void> {
  await run(["add", "-A"], cwd);
  await run(["commit", "-m", message], cwd);
}

/**
 * The generated repository index, as the indexing step would leave it:
 * a directory at the root of the worktree that nobody committed.
 */
function plantRepositoryIndex(worktreePath: string): void {
  // One per configured implementation, and the directories come from the
  // catalogue rather than from here: this check has to hold for whatever
  // is behind the port, not for the implementation that happened to be
  // there when it was written (EO-163).
  for (const directory of REPOSITORY_INDEX_DIRECTORIES) {
    mkdirSync(join(worktreePath, directory, "graph"), { recursive: true });
    writeFileSync(join(worktreePath, directory, "meta.json"), '{"root":"somewhere"}\n');
    writeFileSync(join(worktreePath, directory, "graph", "symbols.db"), "not really sqlite\n");
  }
}

/** Nothing an implementation wrote reached a sentence a person reads. */
function namesNoIndex(output: string | undefined): void {
  expect(REPOSITORY_INDEX_DIRECTORIES.length).toBeGreaterThan(0); // never vacuously true
  for (const directory of REPOSITORY_INDEX_DIRECTORIES) expect(output).not.toContain(directory);
}

/**
 * Every file in a tree with its bytes, so "unchanged" is a claim about
 * the disk rather than about intent.
 */
function snapshot(root: string, skip: string[] = []): Record<string, string> {
  // Empty rather than a throw for a root that is not there: some of these
  // snapshots are taken before the directory exists, to prove it never does.
  return existsSync(root) ? readTree(root, { skip, encoding: "latin1" }) : {};
}

/** Every `.gitignore` anywhere under a tree, however deep. */
function gitignoresIn(root: string): string[] {
  return Object.keys(snapshot(root)).filter((path) => path === ".gitignore" || path.endsWith("/.gitignore"));
}

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), "eo verify test "));
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
  await commitAll(repoPath, "initial");
});

afterEach(() => {
  removeScratch(scratch);
});

// Commands are written as `node -e ...` rather than shell builtins.
// `sleep`, `seq` and friends are not cmd.exe builtins, so a test using
// them either fails on Windows or — worse — passes for the wrong reason
// because the command errored out fast instead of doing what the test
// claims. node is guaranteed present on every runner and behaves
// identically under cmd.exe and sh.
const NODE_PRINT_AND_FAIL = `node -e "console.log('hello'); process.exit(3)"`;
const NODE_HANG = `node -e "setTimeout(() => {}, 30000)"`;
const NODE_MANY_LINES = `node -e "for (let i = 1; i <= 4000; i++) console.log('line-' + i)"`;
const NODE_OK = `node -e ""`;

describe("runCommand", () => {
  it("captures output and reports a non-zero exit", async () => {
    const outcome = await runCommand(NODE_PRINT_AND_FAIL, { cwd: repoPath, timeoutMs: 10_000, maxOutputChars: 1000 });

    expect(outcome.ok).toBe(false);
    expect(outcome.exitCode).toBe(3);
    expect(outcome.output).toContain("hello");
  });

  it("kills a hanging command at the timeout instead of waiting for it", async () => {
    const started = Date.now();
    const outcome = await runCommand(NODE_HANG, { cwd: repoPath, timeoutMs: 500, maxOutputChars: 1000 });

    expect(outcome.timedOut).toBe(true);
    expect(outcome.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(10_000); // did not wait out the 30s hang
  });

  it("truncates long output, keeping the tail where the failure is", async () => {
    const outcome = await runCommand(NODE_MANY_LINES, { cwd: repoPath, timeoutMs: 20_000, maxOutputChars: 500 });

    expect(outcome.truncated).toBe(true);
    expect(outcome.output.length).toBeLessThan(1200);
    expect(outcome.output).toContain("line-4000"); // the tail survived
    expect(outcome.output).toContain("omitted");
    expect(outcome.output).not.toContain("line-1\n"); // the head did not
  });
});

describe("verifyImplementation", () => {
  it("passes a branch with commits, a clean tree, a clean rebase and passing checks", async () => {
    const created = await createWorktree(config(), "EO-1");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    writeFileSync(join(created.value.path, "feature.txt"), "done\n");
    await commitAll(created.value.path, "implement the thing");

    const result = await verifyImplementation(config(), "EO-1", { test: NODE_OK }, { timeoutMs: 10_000 });

    expect(result.ok).toBe(true);
    expect(result.steps.map((step) => step.name)).toEqual(["branch", "clean", "rebase", "test", "lint", "build"]);
    expect(result.steps.every((step) => step.ok)).toBe(true);
  });

  it("still passes clean when the run had MCP servers and skills attached", async () => {
    // The generated directory is EO's, not the person's, and `clean`
    // fails on anything untracked — so a directory written inside the
    // checkout would fail the verification of every run that had
    // anything attached (EO-107). It still lives outside the worktree,
    // and since EO-207 the reason is narrower than "git would see it":
    // `.mcp.json` carries a bearer for EO's administrative server, and a
    // credential in a checkout is one `git add -A` from a commit
    // whatever git's status says about it.
    const created = await createWorktree(config(), "EO-107");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    writeFileSync(join(created.value.path, "feature.txt"), "done\n");
    await commitAll(created.value.path, "implement the thing");

    // Written where the engine writes it: a root of its own, beside the
    // app's other state rather than under the worktree.
    const written = writeToolDirectory(toolDirectoryPath(join(scratch, "agent tools"), "T-1", "agent-1"), {
      servers: [
        {
          id: "s1",
          name: "github",
          description: "",
          config: { transport: "stdio", command: "gh-mcp", args: [] },
          envNames: ["GITHUB_TOKEN"],
          enabled: true,
          createdAt: 1,
          updatedAt: 1,
          archivedAt: null,
          connector: null,
        },
      ],
      skills: [
        {
          id: "k1",
          slug: "pr-review",
          name: "PR review",
          description: "How this house reviews a pull request.",
          body: "Read the whole diff.",
          files: [],
          disableModelInvocation: false,
          enabled: true,
          scope: { kind: "global" },
          createdAt: 1,
          updatedAt: 1,
          archivedAt: null,
        },
      ],
    });
    expect(written).not.toBeNull();
    expect(existsSync(join(written!.path, ".mcp.json"))).toBe(true);
    expect(written!.path.startsWith(created.value.path)).toBe(false);

    const result = await verifyImplementation(config(), "EO-107", { test: NODE_OK }, { timeoutMs: 10_000 });

    expect(result.steps.find((step) => step.name === "clean")?.ok).toBe(true);
    expect(result.ok).toBe(true);
  });

  it("fails when the agent claims success but committed nothing", async () => {
    await createWorktree(config(), "EO-2");

    const result = await verifyImplementation(config(), "EO-2", {});

    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe("branch");
    expect(result.steps.at(-1)?.detail).toContain("no commits");
  });

  it("fails when work was left uncommitted in the worktree", async () => {
    const created = await createWorktree(config(), "EO-3");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    writeFileSync(join(created.value.path, "committed.txt"), "a\n");
    await commitAll(created.value.path, "some work");
    writeFileSync(join(created.value.path, "forgotten.txt"), "b\n"); // never committed

    const result = await verifyImplementation(config(), "EO-3", {});

    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe("clean");
    expect(result.steps.at(-1)?.output).toContain("forgotten.txt");
  });

  it("passes clean when the generated repository index is the only untracked entry (EO-147)", async () => {
    // The index lands at the root of the worktree because the
    // provider's storage location is not configurable, and `clean`
    // fails on anything untracked — so without this every run with
    // indexing enabled fails verification.
    const created = await createWorktree(config(), "EO-147");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    writeFileSync(join(created.value.path, "feature.txt"), "done\n");
    await commitAll(created.value.path, "implement the thing");
    plantRepositoryIndex(created.value.path);

    const result = await verifyImplementation(config(), "EO-147", { test: NODE_OK }, { timeoutMs: 10_000 });

    expect(result.steps.find((step) => step.name === "clean")?.ok).toBe(true);
    expect(result.ok).toBe(true);
  });

  it("still fails clean for a real uncommitted file beside the index, naming it and not the index (EO-147)", async () => {
    // The narrowing that matters: stepping over the index must not make
    // the check blind to work the run actually forgot to commit, and the
    // output an agent reads must not send it looking at a generated
    // directory it did not write.
    const created = await createWorktree(config(), "EO-148");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    writeFileSync(join(created.value.path, "committed.txt"), "a\n");
    await commitAll(created.value.path, "some work");
    plantRepositoryIndex(created.value.path);
    writeFileSync(join(created.value.path, "forgotten.ts"), "export const x = 1;\n"); // never committed

    const result = await verifyImplementation(config(), "EO-148", {});

    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe("clean");
    expect(result.steps.at(-1)?.output).toContain("forgotten.ts");
    namesNoIndex(result.steps.at(-1)?.output);
  });

  it("still fails clean for a modified tracked file, index or no index (EO-147)", async () => {
    const created = await createWorktree(config(), "EO-149");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    writeFileSync(join(created.value.path, "shipped.ts"), "export const x = 1;\n");
    await commitAll(created.value.path, "some work");
    writeFileSync(join(created.value.path, "shipped.ts"), "export const x = 2;\n"); // tracked, edited, uncommitted
    plantRepositoryIndex(created.value.path);

    const result = await verifyImplementation(config(), "EO-149", {});

    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe("clean");
    expect(result.steps.at(-1)?.output).toContain("shipped.ts");
    namesNoIndex(result.steps.at(-1)?.output);
  });

  it("ignores the index by teaching its own checks, writing nothing into anybody's repository (EO-147)", async () => {
    // The rejected alternative, pinned so it stays rejected: in a linked
    // worktree `.git/info/` resolves to the main repository's copy, so
    // writing an exclude there edits the person's own checkout. A
    // `.gitignore` is worse again — a tracked file, in the diff under
    // review. EO teaches its own checks instead, and that has to mean
    // nothing on disk changes.
    const created = await createWorktree(config(), "EO-150");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    writeFileSync(join(created.value.path, "feature.txt"), "done\n");
    await commitAll(created.value.path, "implement the thing");
    plantRepositoryIndex(created.value.path);

    const checkoutBefore = snapshot(repoPath, [".git"]);
    const gitInfoBefore = snapshot(join(repoPath, ".git", "info"));

    const result = await verifyImplementation(config(), "EO-150", { test: NODE_OK }, { timeoutMs: 10_000 });
    // The other half of this change reads the same worktree.
    const borrowed = await borrowedFromSiblings({
      worktreePath: created.value.path,
      itemKey: "EO-150",
      baseBranch: "main",
      worktreeRoot,
    });

    expect(result.ok).toBe(true);
    expect(borrowed).toEqual([]);
    // `.git/info/exclude` — the main repository's copy, reached through
    // the worktree's `.git` file. Snapshotted after the worktree was
    // cut, which is when EO-207 writes its two exclusion lines: what is
    // asserted is that *verification* adds nothing, not that the file was
    // never touched.
    expect(snapshot(join(repoPath, ".git", "info"))).toEqual(gitInfoBefore);
    // The person's checkout, untouched down to the byte.
    expect(snapshot(repoPath, [".git"])).toEqual(checkoutBefore);
    // And no .gitignore invented anywhere — not in their repository, and
    // not in the worktree either.
    expect(gitignoresIn(repoPath)).toEqual([]);
    expect(gitignoresIn(created.value.path)).toEqual([]);
  });

  it("an agent claiming success with failing tests does not pass verification", async () => {
    const created = await createWorktree(config(), "EO-4");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    writeFileSync(join(created.value.path, "feature.txt"), "done\n");
    await commitAll(created.value.path, "implement");

    const result = await verifyImplementation(config(), "EO-4", { test: `node -e "console.log('2 tests failed'); process.exit(1)"` }, { timeoutMs: 10_000 });

    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe("test");
    expect(result.steps.at(-1)?.output).toContain("2 tests failed"); // the log is attached
  });

  it("reports rebase conflicts with the specific conflicting paths", async () => {
    const created = await createWorktree(config(), "EO-5");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    writeFileSync(join(created.value.path, "shared.txt"), "the agent's version\n");
    await commitAll(created.value.path, "agent edits shared.txt");

    // Meanwhile, main moves under it — the same file, different content.
    writeFileSync(join(repoPath, "shared.txt"), "someone else's version\n");
    await commitAll(repoPath, "main edits shared.txt");

    const result = await verifyImplementation(config(), "EO-5", {});

    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe("rebase");
    expect(result.steps.at(-1)?.detail).toContain("shared.txt"); // the specific path
  });

  it("leaves the worktree usable after a conflicted rebase rather than parked mid-rebase", async () => {
    const created = await createWorktree(config(), "EO-6");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    writeFileSync(join(created.value.path, "shared.txt"), "agent\n");
    await commitAll(created.value.path, "agent");
    writeFileSync(join(repoPath, "shared.txt"), "main\n");
    await commitAll(repoPath, "main");

    await verifyImplementation(config(), "EO-6", {});

    // A worktree left mid-rebase fails every subsequent git command,
    // which would break the agent's next attempt.
    const status = await git(["status", "--porcelain"], created.value.path);
    expect(status.ok).toBe(true);
    const inProgress = await git(["rev-parse", "--verify", "--quiet", "REBASE_HEAD"], created.value.path);
    expect(inProgress.ok).toBe(false);
  });

  it("kills a hanging check command and reports it as a timeout", async () => {
    const created = await createWorktree(config(), "EO-7");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    writeFileSync(join(created.value.path, "feature.txt"), "done\n");
    await commitAll(created.value.path, "implement");

    const result = await verifyImplementation(config(), "EO-7", { test: NODE_HANG }, { timeoutMs: 500 });

    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe("test");
    expect(result.steps.at(-1)?.timedOut).toBe(true);
    expect(result.steps.at(-1)?.detail).toContain("without finishing");
  });

  it("runs lint and build too, and stops at the first failure", async () => {
    const created = await createWorktree(config(), "EO-8");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    writeFileSync(join(created.value.path, "feature.txt"), "done\n");
    await commitAll(created.value.path, "implement");

    const result = await verifyImplementation(
      config(),
      "EO-8",
      { test: NODE_OK, lint: `node -e "console.log('lint broke'); process.exit(1)"`, build: NODE_OK },
      { timeoutMs: 10_000 },
    );

    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe("lint");
    // build never ran — a cascade of derived failures helps nobody.
    expect(result.steps.map((step) => step.name)).not.toContain("build");
  });

  it("marks an unconfigured check as skipped rather than passed", async () => {
    const created = await createWorktree(config(), "EO-9");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    writeFileSync(join(created.value.path, "feature.txt"), "done\n");
    await commitAll(created.value.path, "implement");

    const result = await verifyImplementation(config(), "EO-9", {});

    expect(result.ok).toBe(true);
    expect(result.steps.find((step) => step.name === "test")?.detail).toContain("skipped");
  });

  it("checks options.branch when given, instead of the default eo/<key> (EO-16)", async () => {
    // A branch cut under a configured prefix and/or a linked Jira key,
    // as `createWorktreeWorkspace` would actually produce — verification
    // must check the item's *real* branch, not one it recomputes.
    const created = await createWorktree(config(), "EO-10", undefined, { branch: "acme/KAN-1" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    writeFileSync(join(created.value.path, "feature.txt"), "done\n");
    await commitAll(created.value.path, "implement the thing");

    const result = await verifyImplementation(config(), "EO-10", {}, { branch: "acme/KAN-1" });

    expect(result.ok).toBe(true);
    expect(result.steps.find((step) => step.name === "branch")?.detail).toContain("acme/KAN-1");
  });

  describe("rebase target (EO-10 / KAN-42)", () => {
    it("rebases onto the resolved target — a still-open dependency's branch — not the base branch", async () => {
      // The dependency's branch, with its own commit.
      await run(["checkout", "-b", "eo/DEP"], repoPath);
      writeFileSync(join(repoPath, "dep.txt"), "from the dependency\n");
      await commitAll(repoPath, "dependency work");
      await run(["checkout", "main"], repoPath);

      // The story's worktree, cut from the dependency rather than main —
      // what createWorktreeWorkspace does once the resolver says "stack".
      const created = await createWorktree(config(), "EO-50", "eo/DEP");
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      writeFileSync(join(created.value.path, "story.txt"), "the story's own work\n");
      await commitAll(created.value.path, "implement the story");

      // The dependency gains a further commit after the story branched —
      // exactly the "merges partway through implementation" scenario
      // this recompute-on-every-run behavior exists for.
      await run(["checkout", "eo/DEP"], repoPath);
      writeFileSync(join(repoPath, "dep2.txt"), "more dependency work\n");
      await commitAll(repoPath, "more dependency work");
      await run(["checkout", "main"], repoPath);

      const result = await verifyImplementation(config(), "EO-50", {}, { rebaseTarget: "eo/DEP" });

      expect(result.ok).toBe(true);
      expect(result.steps.find((step) => step.name === "rebase")?.detail).toContain("eo/DEP");
      // Rebased onto the dependency's *current* tip, not main.
      expect(existsSync(join(created.value.path, "dep2.txt"))).toBe(true);
    });

    it("rebases onto the base branch once the dependency has merged, not its now-stale branch", async () => {
      await run(["checkout", "-b", "eo/DEP"], repoPath);
      writeFileSync(join(repoPath, "dep.txt"), "from the dependency\n");
      await commitAll(repoPath, "dependency work");
      await run(["checkout", "main"], repoPath);

      const created = await createWorktree(config(), "EO-51", "eo/DEP");
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      writeFileSync(join(created.value.path, "story.txt"), "the story's own work\n");
      await commitAll(created.value.path, "implement the story");

      // The dependency has since merged into main (as a squash would),
      // and main gained further work of its own after that.
      await run(["merge", "eo/DEP"], repoPath);
      writeFileSync(join(repoPath, "base-only.txt"), "landed on main after the merge\n");
      await commitAll(repoPath, "further work on main");

      const result = await verifyImplementation(config(), "EO-51", {}, { rebaseTarget: "main" });

      expect(result.ok).toBe(true);
      expect(result.steps.find((step) => step.name === "rebase")?.detail).toContain("main");
      // Rebased onto main's current tip, which now carries work the
      // dependency's own branch never will again.
      expect(existsSync(join(created.value.path, "base-only.txt"))).toBe(true);
    });
  });
});

describe("formatVerificationComment", () => {
  it("leads with the failing step and attaches its output", async () => {
    const created = await createWorktree(config(), "EO-40");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    writeFileSync(join(created.value.path, "feature.txt"), "done\n");
    await commitAll(created.value.path, "implement");

    const result = await verifyImplementation(config(), "EO-40", { test: `node -e "console.log('expected 1 got 2'); process.exit(1)"` }, { timeoutMs: 10_000 });
    const comment = formatVerificationComment("EO-40", result);

    expect(comment).toContain("EO-40");
    expect(comment).toContain("**test**");
    expect(comment).toContain("expected 1 got 2");
    expect(comment).toContain("Passed before this: branch, clean, rebase.");
  });
});

/** worktreePathFor is exercised indirectly above; this pins the shape the verifier relies on. */
describe("worktreePathFor", () => {
  it("puts an item's worktree under the configured root", () => {
    expect(worktreePathFor("EO-77", worktreeRoot)).toBe(join(worktreeRoot, "EO-77"));
  });
});
