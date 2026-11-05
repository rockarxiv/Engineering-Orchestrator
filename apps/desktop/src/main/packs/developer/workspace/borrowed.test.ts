import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { borrowedFromSiblings } from "./borrowed.js";
import type { DbHandle } from "../../../db/client.js";
import { getItem, listCommentsForItem } from "../../../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../../../db/testHelpers.js";
import { createScriptedProvider } from "../../../providers/scripted.js";
import { REPOSITORY_INDEX_DIRECTORIES } from "../repositoryIntelligence/index.js";
import { createRunSupervisor } from "../../../supervisor/runSupervisor.js";
import { fakeWorkspaceKind, installedKinds } from "../../../supervisor/testWorkspaceKinds.js";
import { borrowedFilesCheck } from "./gitKind.js";

/**
 * A directory an index really lands in, whoever built it.
 *
 * Taken from the catalogue rather than written down, so these fixtures
 * describe whatever implementation is configured rather than the one
 * that happened to exist when they were written (EO-163). The fallback
 * is deliberately a name nothing steps over: an empty catalogue should
 * fail these tests loudly rather than make them vacuous.
 */
const [INDEX_DIR = ".no-provider-has-this"] = REPOSITORY_INDEX_DIRECTORIES;

/**
 * Detecting work copied out of another item's checkout (KAN-27).
 *
 * Real git and real files, because the whole question is what is on
 * disk: a fake would only prove the shape of the code that reads it, and
 * the thing being modelled — a sibling worktree nobody merged — is
 * exactly what a fake would have to invent.
 *
 * The case this comes from: a story in one repository vendored a file
 * verbatim out of a sibling story's unmerged branch and passed review.
 */
const LIBRARY_FILE = `export function budget(limit) {\n  return { limit, used: 0 };\n}\n`;

let scratch: string;
let repo: string;
let worktreeRoot: string;
let handle: DbHandle;
/**
 * One clock for the whole test, because git records commit time to the
 * second and two `Date.now()` calls only land in the same second by
 * luck. Without this the "neither came first" case straddles a boundary
 * every so often and fails — observed once, which is once more than a
 * test about ordering is allowed to be lucky.
 */
let baseTime: number;

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** A worktree-shaped directory: its own git repo on a branch, under the shared root. */
function makeCheckout(itemKey: string, files: Record<string, string>, options: { secondsLater?: number } = {}): string {
  const path = join(worktreeRoot, itemKey);
  mkdirSync(path, { recursive: true });
  git(["init", "-b", "main"], path);
  git(["config", "user.email", "eo@example.com"], path);
  git(["config", "user.name", "EO"], path);
  git(["config", "commit.gpgsign", "false"], path);
  git(["config", "tag.gpgsign", "false"], path);
  writeFileSync(join(path, "README.md"), "# base\n");
  git(["add", "-A"], path);
  git(["commit", "-m", "base"], path);

  git(["checkout", "-q", "-b", `eo/${itemKey}`], path);
  for (const [name, contents] of Object.entries(files)) {
    mkdirSync(join(path, name, ".."), { recursive: true });
    writeFileSync(join(path, name), contents);
  }
  git(["add", "-A"], path);
  // Commit time is what says who had it first, so a test about ordering
  // has to set it rather than hope two commits land a second apart.
  const when = new Date(baseTime + (options.secondsLater ?? 0) * 1000).toISOString();
  execFileSync("git", ["commit", "-m", itemKey, "--date", when], {
    cwd: path,
    encoding: "utf8",
    env: { ...process.env, GIT_COMMITTER_DATE: when },
  });
  return path;
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "eo borrowed "));
  worktreeRoot = join(scratch, "worktrees");
  mkdirSync(worktreeRoot, { recursive: true });
  repo = worktreeRoot;
  baseTime = Date.now();
  handle = openMigratedTestDb();
});

afterEach(() => {
  handle.close();
  rmSync(scratch, { recursive: true, force: true });
});

describe("files copied from a sibling's unmerged work", () => {
  it("names the file and the item it came from", async () => {
    // The dependency runs first — that ordering is what the scheduler
    // enforces, and what makes the later story the copier.
    makeCheckout("RK-2", { "src/budget.js": LIBRARY_FILE });
    const mine = makeCheckout("GW-1", { "vendor/ratekeeper/budget.js": LIBRARY_FILE }, { secondsLater: 2 });

    const borrowed = await borrowedFromSiblings({ worktreePath: mine, itemKey: "GW-1", baseBranch: "main", worktreeRoot });

    expect(borrowed).toEqual([{ path: "vendor/ratekeeper/budget.js", fromItemKey: "RK-2" }]);
  });

  it("stays quiet when neither clearly came first", async () => {
    // Same commit second, so git cannot order them. Saying nothing is
    // the only honest answer — a coin-flip accusation is worse than
    // silence.
    makeCheckout("RK-2", { "src/budget.js": LIBRARY_FILE });
    const mine = makeCheckout("GW-1", { "vendor/budget.js": LIBRARY_FILE });

    expect(await borrowedFromSiblings({ worktreePath: mine, itemKey: "GW-1", baseBranch: "main", worktreeRoot })).toEqual([]);
  });

  it("says nothing about a story that wrote its own code", async () => {
    // The overwhelming case, and the one a false positive would ruin.
    makeCheckout("RK-2", { "src/budget.js": LIBRARY_FILE });
    const mine = makeCheckout("GW-1", { "src/router.js": "export const router = {};\n" });

    expect(await borrowedFromSiblings({ worktreePath: mine, itemKey: "GW-1", baseBranch: "main", worktreeRoot })).toEqual([]);
  });

  it("ignores a file that merely resembles the sibling's", async () => {
    // Byte-identical is the bar. Two stories solving related problems
    // will write similar code, and accusing them of copying would make
    // this noise rather than signal.
    makeCheckout("RK-2", { "src/budget.js": LIBRARY_FILE });
    const mine = makeCheckout("GW-1", { "src/budget.js": LIBRARY_FILE.replace("used: 0", "used: 1") });

    expect(await borrowedFromSiblings({ worktreePath: mine, itemKey: "GW-1", baseBranch: "main", worktreeRoot })).toEqual([]);
  });

  it("blames the story that committed it second, not the one that wrote it", async () => {
    // Identical files alone cannot say who copied whom, and a naive
    // check accuses the author as loudly as the copier. Running the
    // first version against the real artifact did exactly that: the
    // story that *wrote* requestBudget.js was reported for borrowing it
    // from the story that copied it.
    const author = makeCheckout("RK-2", { "src/budget.js": LIBRARY_FILE });
    // A second apart, so the ordering is unambiguous at one-second git
    // timestamp resolution.
    const copier = makeCheckout("GW-1", { "vendor/budget.js": LIBRARY_FILE }, { secondsLater: 2 });

    const againstCopier = await borrowedFromSiblings({ worktreePath: copier, itemKey: "GW-1", baseBranch: "main", worktreeRoot });
    const againstAuthor = await borrowedFromSiblings({ worktreePath: author, itemKey: "RK-2", baseBranch: "main", worktreeRoot });

    expect(againstCopier).toEqual([{ path: "vendor/budget.js", fromItemKey: "RK-2" }]);
    expect(againstAuthor, "the author must not be accused of copying its own work").toEqual([]);
  });

  it("does not accuse a story of copying from itself", async () => {
    const mine = makeCheckout("GW-1", { "a.js": LIBRARY_FILE, "b.js": LIBRARY_FILE });

    expect(await borrowedFromSiblings({ worktreePath: mine, itemKey: "GW-1", baseBranch: "main", worktreeRoot })).toEqual([]);
  });

  it("looks only at what this branch added", async () => {
    // A file already on the base branch is shared history, not a copy —
    // and both checkouts start from the same README.
    const mine = makeCheckout("GW-1", { "src/new.js": "export const x = 1;\n" });
    makeCheckout("RK-2", { "src/other.js": "export const y = 2;\n" });

    const borrowed = await borrowedFromSiblings({ worktreePath: mine, itemKey: "GW-1", baseBranch: "main", worktreeRoot });

    expect(borrowed.map((file) => file.path)).not.toContain("README.md");
  });

  it("is quiet when there is no worktree root at all", async () => {
    const mine = makeCheckout("GW-1", { "src/new.js": "export const x = 1;\n" });

    const borrowed = await borrowedFromSiblings({
      worktreePath: mine,
      itemKey: "GW-1",
      baseBranch: "main",
      worktreeRoot: join(scratch, "nothing-here"),
    });

    expect(borrowed).toEqual([]);
  });

  it("does not walk into node_modules, where a match means nothing", async () => {
    // Two checkouts of the same dependency share thousands of identical
    // files. Reporting those would bury the one that matters.
    makeCheckout("RK-2", { "node_modules/left-pad/index.js": LIBRARY_FILE });
    const mine = makeCheckout("GW-1", { "node_modules/left-pad/index.js": LIBRARY_FILE });

    expect(await borrowedFromSiblings({ worktreePath: mine, itemKey: "GW-1", baseBranch: "main", worktreeRoot })).toEqual([]);
  });

  it("never reports anything under the generated repository index (EO-147)", async () => {
    // Every worktree is indexed fresh from the same repository, so
    // byte-identical index files across two checkouts are the normal
    // case rather than a signal. Planted a clear second apart, so
    // without the skip GW-1 would be named as the copier — this is the
    // ordering the "blames the one that committed it second" case uses.
    makeCheckout("RK-2", { [`${INDEX_DIR}/graph.db`]: LIBRARY_FILE });
    const mine = makeCheckout("GW-1", { [`${INDEX_DIR}/graph.db`]: LIBRARY_FILE }, { secondsLater: 2 });

    expect(await borrowedFromSiblings({ worktreePath: mine, itemKey: "GW-1", baseBranch: "main", worktreeRoot })).toEqual([]);
  });

  it("does not name an index file even when it matches ordinary work in a sibling (EO-147)", async () => {
    // The sibling skip alone would not cover this: the match is against
    // a path that is not in an index, so the finding would come back
    // under this story's own path inside the index. Nothing under the
    // index is anybody's work to have borrowed.
    makeCheckout("RK-2", { "src/budget.js": LIBRARY_FILE });
    const mine = makeCheckout("GW-1", { [`${INDEX_DIR}/graph.db`]: LIBRARY_FILE }, { secondsLater: 2 });

    expect(await borrowedFromSiblings({ worktreePath: mine, itemKey: "GW-1", baseBranch: "main", worktreeRoot })).toEqual([]);
  });

  it("still catches a real copy sitting beside an index (EO-147)", async () => {
    // The skip narrows rather than blunts: a story that also happens to
    // hold an index is not thereby exempt.
    makeCheckout("RK-2", { "src/budget.js": LIBRARY_FILE });
    const mine = makeCheckout(
      "GW-1",
      { [`${INDEX_DIR}/graph.db`]: "an index of something\n", "vendor/budget.js": LIBRARY_FILE },
      { secondsLater: 2 },
    );

    const borrowed = await borrowedFromSiblings({ worktreePath: mine, itemKey: "GW-1", baseBranch: "main", worktreeRoot });

    expect(borrowed).toEqual([{ path: "vendor/budget.js", fromItemKey: "RK-2" }]);
  });

  void repo;
});

/**
 * The guard that reports it (KAN-27).
 *
 * Driven through the injected port rather than git, because what is
 * being pinned here is that the finding reaches the thread — invariant
 * 8 — and that it does not block work that may well be correct.
 */
describe("reporting borrowed work on the item", () => {
  const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };

  function supervisorFinding(borrowed: { path: string; fromItemKey: string }[]) {
    return createRunSupervisor({
      db: handle.db,
      limits: LIMITS,
      provider: createScriptedProvider([{ when: () => true, script: { result: { branch: "eo/EO-1", summary: "Did it.", handoff: "Straightforward; nothing to flag." } } }]),
      // The git kind's own borrowed-file check, over a scan this test
      // decides the answer to: what is under test is the sentence the
      // supervisor posts, not how a file is found.
      kinds: installedKinds(
        fakeWorkspaceKind({
          cwd: "/tmp/worktree",
          verifying: async () => [borrowedFilesCheck(borrowed)],
        }),
      ),
    });
  }

  it("names what was copied and where it came from", async () => {
    const item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo" });

    await supervisorFinding([{ path: "vendor/ratekeeper/budget.js", fromItemKey: "RK-2" }]).runOnce();

    const note = listCommentsForItem(handle.db, item.id).find((comment) => comment.authorType === "engine");
    expect(note, "invariant 8: the guard ends in a comment").toBeDefined();
    expect(note!.body).toContain("vendor/ratekeeper/budget.js");
    expect(note!.body).toContain("RK-2");
    expect(note!.body).toContain("not merged");
  });

  it("lets the item move — copying is sometimes the only option", async () => {
    const item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo" });

    await supervisorFinding([{ path: "a.js", fromItemKey: "RK-2" }]).runOnce();

    expect(getItem(handle.db, item.id)?.stepId).not.toBe("todo");
  });

  it("says nothing when a story wrote its own code", async () => {
    const item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo" });

    await supervisorFinding([]).runOnce();

    expect(listCommentsForItem(handle.db, item.id).filter((comment) => comment.authorType === "engine")).toEqual([]);
  });
});
