import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../../../../db/client.js";
import {
  createAgent,
  createPipeline,
  createRun,
  listAgents,
  listCommentsForItem,
  listPipelines,
  listPipelineSteps,
  listWorkspaces,
  listRunsForItem,
  listItemsIncludingArchived,
  postComment,
  updateRun,
} from "../../../../db/repos/index.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../../../../db/testHelpers.js";
import {
  initializeRepositoryIndexCommand,
  rebuildRepositoryIndexCommand,
  repositoryIntelligenceStatusCommand,
  type RepositoryIntelligenceContext,
} from "../../../../ipc/repositoryIntelligenceCommands.js";
import type { ResolveOptions } from "../binary/resolve.js";
import { createItemLock } from "../../../../supervisor/itemLock.js";
import { createRepositoryIntelligenceService } from "../service.js";
import { createCodeWikiProvider } from "./provider.js";
import { runCodeWiki, type CodeWikiRunRequest, type CodeWikiRunResult } from "./run.js";
import { CODEWIKI_SHIM } from "./testShim.js";
import { readTree } from "../../../../testing/tree.js";
import { run } from "../../../../testing/git.js";
import { removeScratch } from "../../../../testing/scratch.js";

/**
 * Rebuild as the recovery path, proven by breaking an index and pressing
 * the button (EO-154).
 *
 * The whole reason the section this drives exists: an index is derived
 * state and derived state gets corrupted — a half-written file, a
 * process killed mid-build, a disk that filled up — and until now the
 * only way out was a terminal and `rm -rf`. So the test does the damage
 * for real. It truncates the index file on disk and then calls the same
 * command the Rebuild button calls, with nothing between the two: no
 * deleting a directory to help it along, no re-running `init` by hand.
 * If the command cannot recover from this on its own, this fails.
 *
 * **Why this test lives in `codewiki/`.** It has to know what an index
 * file is in order to break one, and `architecturalInvariants.test.ts`
 * says which directory is allowed to know that. Written one level up it
 * would have been the first file outside this directory to learn the
 * implementation's layout, which is precisely the leak that invariant
 * exists to stop — and it would have had to learn it in a test, where
 * nobody would have looked for it.
 *
 * The other half is the promise about what rebuild does *not* touch.
 * "Deletes derived state, and only derived state" is easy to write and
 * easy to break — one `rm -rf` given the wrong root, one helpful
 * clean-up added later — so the checkout, its history and every table EO
 * keeps are photographed before and compared after.
 */

const EMPTY_ROOT = join(tmpdir(), "eo-codewiki-no-such-root");

let shims: string;
let shim: string;
let scratch: string;
let worktreeRoot: string;
let workspace: string;
let handle: DbHandle | undefined;


/**
 * The context the handler builds in production, with the stand-in
 * binary behind it.
 *
 * The factory is the seam and the *only* seam: everything above it —
 * the command, the service, the transition table, the provider, the
 * process spawn — is the shipped code. What differs from a real machine
 * is which executable runs at the end of it, which is what the
 * `configured` branch of resolution is for.
 */
function context(): RepositoryIntelligenceContext {
  const binary: ResolveOptions = { root: EMPTY_ROOT, configuredPath: process.execPath };
  const run = (request: CodeWikiRunRequest): Promise<CodeWikiRunResult> =>
    runCodeWiki({ ...request, binary, args: [shim, ...request.args] });

  return {
    root: EMPTY_ROOT,
    worktreeRoot,
    factory: ({ db }) => ({
      service: createRepositoryIntelligenceService({ db, provider: createCodeWikiProvider({ binary, run }) }),
      ensureInstalled: async () => ({ ok: true }),
    }),
  };
}

/** The whole checkout except the index: every path, and every file's bytes. */
function checkout(): Record<string, string> {
  return readTree(workspace, { skip: [".codewiki"] });
}

/**
 * Everything EO keeps that a rebuild has no business touching, as one
 * comparable object.
 *
 * Whole rows rather than counts. A count would survive a rebuild that
 * rewrote a comment body, moved an item or changed a repository's test
 * command, and "unchanged" in the criterion means unchanged. The one
 * table deliberately absent is `repository_indexes` itself: that *is*
 * the note about the derived state, and a rebuild is supposed to move
 * it.
 */
function records(db: DbHandle["db"], itemId: Parameters<typeof listRunsForItem>[1]) {
  return {
    workspaces: listWorkspaces(db),
    items: listItemsIncludingArchived(db),
    comments: listCommentsForItem(db, itemId),
    runs: listRunsForItem(db, itemId),
    pipelines: listPipelines(db),
    steps: listPipelineSteps(db),
    agents: listAgents(db),
  };
}

/**
 * The service the indexing step builds, over the stand-in binary.
 *
 * Used to put the *first* index in place, because that is what puts it
 * there in production: a row is written by the pipeline step, not by
 * this screen. Everything the tests then assert about goes through the
 * commands.
 */
function serviceFor(db: DbHandle["db"]) {
  const binary: ResolveOptions = { root: EMPTY_ROOT, configuredPath: process.execPath };
  return createRepositoryIntelligenceService({
    db,
    provider: createCodeWikiProvider({ binary, run: (request) => runCodeWiki({ ...request, binary, args: [shim, ...request.args] }) }),
  });
}

beforeEach(async () => {
  shims = mkdtempSync(join(tmpdir(), "eo-codewiki-recovery-shims-"));
  shim = join(shims, "codewiki.mjs");
  writeFileSync(shim, CODEWIKI_SHIM);

  // A space in the path, because a repository path is user-controlled
  // and this one reaches argv, an environment variable and git.
  scratch = mkdtempSync(join(tmpdir(), "eo codewiki recovery "));
  worktreeRoot = join(scratch, "worktrees");
  // Named after the item key, because that is how the command finds a
  // checkout from a row — `worktreePathFor`, the same answer
  // `workspace/verify.ts` uses.
  workspace = join(worktreeRoot, "EO-1");
  mkdirSync(workspace, { recursive: true });

  await run(["init", "-b", "main"], workspace);
  await run(["config", "user.email", "eo@example.com"], workspace);
  await run(["config", "user.name", "EO Test"], workspace);
  await run(["config", "commit.gpgsign", "false"], workspace);
  await run(["config", "tag.gpgsign", "false"], workspace);
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(join(workspace, "src", "alpha.ts"), "export function alpha() {\n  return 1;\n}\n");
  writeFileSync(join(workspace, "src", "beta.ts"), 'import { alpha } from "./alpha.js";\nexport const beta = alpha();\n');
  writeFileSync(join(workspace, "README.md"), "# a checkout\n");
  await run(["add", "-A"], workspace);
  await run(["commit", "-m", "first"], workspace);
});

afterEach(() => {
  handle?.close();
  handle = undefined;
  removeScratch(shims);
  removeScratch(scratch);
});

/** A database with one repository, one item, and a comment, a run, a pipeline and an agent beside them. */
function seed() {
  handle = openMigratedTestDb();
  const db = handle.db;
  const repository = attachWorkspace(db, { name: "api", keyPrefix: "EO", repoPath: workspace, baseBranch: "main" });
  const item = createTestItem(db, { type: "story", title: "A story", stepId: "todo", workspaceId: repository.id });
  const agent = createAgent(db, { name: "implementer", role: "implementer", provider: "claude", instructions: "do the work" });
  postComment(db, { itemId: item.id, author: { type: "engine" }, body: "The reviewer asked for a change." });
  // Finished, on purpose. A queued or running one is what the commands
  // refuse to touch an index for, and the tests that assert *that* say
  // so themselves; this one is here to be left alone by a rebuild.
  createRun(db, { itemId: item.id, agentId: agent.id, action: "implement", status: "succeeded" });
  createPipeline(db, { name: "default" });
  return { db, repository, item };
}

/** The one row the listing holds for this repository. */
function only(db: DbHandle["db"]) {
  const listed = repositoryIntelligenceStatusCommand(db, worktreeRoot);
  const index = listed.repositories.flatMap((entry) => entry.indexes)[0];
  if (!index) throw new Error("expected the listing to hold an index");
  return index;
}

describe("rebuilding a corrupted repository index", () => {
  it("recovers one whose index file has been truncated, with nobody touching a file by hand", async () => {
    const { db, repository, item } = seed();

    const first = await serviceFor(db).ensureIndexed({ workspaceId: repository.id, itemId: item.id, workspacePath: workspace });
    expect(first.ok).toBe(true);

    const indexFile = join(workspace, ".codewiki", "codewiki.db");
    expect(statSync(indexFile).size).toBeGreaterThan(0);

    // The damage. Truncation rather than deletion, deliberately: a
    // missing file is the easy case — every layer notices it — and a
    // zero-length one is what a killed process or a full disk actually
    // leaves behind, still present, still named, and describing nothing.
    writeFileSync(indexFile, "");
    expect(statSync(indexFile).size).toBe(0);
    // EO's own note still says the index is fine, which is exactly the
    // state a person is in when they come looking for this screen.
    expect(only(db).status).toBe("ready");

    const recovered = await rebuildRepositoryIndexCommand(db, context(), { id: only(db).id });

    expect({ ok: recovered.ok, problem: recovered.problem }).toEqual({ ok: true, problem: null });
    expect(recovered.index?.status).toBe("ready");
    expect(only(db).status).toBe("ready");
    // The file is there again and it is not the empty one that was there
    // a moment ago — the assertion this whole test is for.
    expect(statSync(indexFile).size).toBeGreaterThan(0);
    expect(Object.keys(JSON.parse(readFileSync(indexFile, "utf8")).files)).toContain(join("src", "alpha.ts"));
  });

  it("leaves the source, the history and every record EO keeps exactly as they were", async () => {
    const { db, repository, item } = seed();

    await serviceFor(db).ensureIndexed({ workspaceId: repository.id, itemId: item.id, workspacePath: workspace });

    const sourceBefore = checkout();
    const historyBefore = await run(["log", "--format=%H %T %s"], workspace);
    const statusBefore = await run(["status", "--porcelain"], workspace);
    const recordsBefore = records(db, item.id);

    writeFileSync(join(workspace, ".codewiki", "codewiki.db"), "");
    const recovered = await rebuildRepositoryIndexCommand(db, context(), { id: only(db).id });
    expect(recovered.ok).toBe(true);

    // Source files: every path and every byte.
    expect(checkout()).toEqual(sourceBefore);
    // Git history: the commits, their trees and their subjects. A
    // rebuild that committed, reset or checked anything out moves one of
    // the three.
    expect(await run(["log", "--format=%H %T %s"], workspace)).toBe(historyBefore);
    // And the working tree is no dirtier than it was. The whole porcelain
    // rather than "it is empty": `.codewiki` is untracked and git reports
    // it either way, so what matters is that the two agree.
    expect(await run(["status", "--porcelain"], workspace)).toBe(statusBefore);

    // Items, comments, runs, pipelines, their steps, agents, and the
    // repository's own configuration.
    expect(records(db, item.id)).toEqual(recordsBefore);
  });

  it("frees an index left mid-build by an interrupted run, which nothing else can", async () => {
    // The state a crash or a quit leaves behind: the row says `indexing`
    // and the transition table refuses `indexing -> indexing`, so every
    // later attempt would be turned away by the very rule that keeps two
    // builds out of one directory. Rebuild is the way out, and it takes
    // it by recording the interruption first rather than by weakening
    // the rule.
    const { db, repository, item } = seed();
    const service = serviceFor(db);
    await service.ensureIndexed({ workspaceId: repository.id, itemId: item.id, workspacePath: workspace });
    service.setStatus({ workspaceId: repository.id, itemId: item.id, workspacePath: workspace }, "indexing");
    expect(only(db).status).toBe("indexing");

    const recovered = await rebuildRepositoryIndexCommand(db, context(), { id: only(db).id });

    expect({ ok: recovered.ok, problem: recovered.problem }).toEqual({ ok: true, problem: null });
    expect(only(db).status).toBe("ready");
  });

  it("builds one for a row nothing ever got as far as filling", async () => {
    // `not_indexed` is the other thing an interruption leaves: a note
    // written before the build that was meant to fill it. Refresh cannot
    // help — there is no index to update, and the table says so — which
    // is why the screen offers Index here and this channel exists.
    const { db, repository, item } = seed();
    const target = { workspaceId: repository.id, itemId: item.id, workspacePath: workspace };
    const service = serviceFor(db);
    await service.ensureIndexed(target);
    rmSync(join(workspace, ".codewiki"), { recursive: true, force: true });
    service.setStatus(target, "stale");
    service.setStatus(target, "indexing");
    service.setStatus(target, "failed", { errorMessage: "EO stopped before it built anything." });

    const built = await initializeRepositoryIndexCommand(db, context(), { id: only(db).id });

    expect({ ok: built.ok, problem: built.problem }).toEqual({ ok: true, problem: null });
    expect(only(db).status).toBe("ready");
    expect(existsSync(join(workspace, ".codewiki", "codewiki.db"))).toBe(true);
  });

  it("recovers a corrupted index that a run is holding, by stopping the run first", async () => {
    // The two halves of the criterion in one go, against a real index on
    // a real disk: something is holding the checkout, the index is
    // broken, and pressing Rebuild has to end with a working index
    // rather than with a refusal.
    //
    // It matters that these arrive together. An index gets corrupted
    // *by* a run that died badly, so the state where a `running` row
    // sits in front of a truncated index is not a corner case — it is
    // the ordinary shape of the thing this button exists for.
    const { db, repository, item } = seed();
    await serviceFor(db).ensureIndexed({ workspaceId: repository.id, itemId: item.id, workspacePath: workspace });

    const agent = createAgent(db, { name: "reviewer", role: "reviewer", provider: "claude", instructions: "read it" });
    const holding = createRun(db, { itemId: item.id, agentId: agent.id, action: "review", status: "running" });
    // The claim as well as the row, because that is what a dispatch
    // holds and what "something is in that worktree" actually means.
    const lock = createItemLock();
    const hold = lock.acquire(item.id);

    const indexFile = join(workspace, ".codewiki", "codewiki.db");
    writeFileSync(indexFile, "");

    // Both halves, the way the supervisor does them: the terminal row,
    // and the claim released as the run unwinds.
    const engine = {
      cancelRun: (runId: string) => {
        updateRun(db, runId as typeof holding.id, { status: "cancelled" });
        hold?.();
      },
    };
    const recovered = await rebuildRepositoryIndexCommand(
      db,
      { ...context(), itemLock: lock, engine: engine as unknown as NonNullable<RepositoryIntelligenceContext["engine"]> },
      { id: only(db).id },
    );

    expect({ ok: recovered.ok, problem: recovered.problem }).toEqual({ ok: true, problem: null });
    expect(only(db).status).toBe("ready");
    expect(statSync(indexFile).size).toBeGreaterThan(0);
    expect(Object.keys(JSON.parse(readFileSync(indexFile, "utf8")).files)).toContain(join("src", "alpha.ts"));

    // The run was stopped, and the item says so — invariant #8.
    expect(listRunsForItem(db, item.id).find((run) => run.id === holding.id)?.status).toBe("cancelled");
    expect(listCommentsForItem(db, item.id).map((comment) => comment.body).join("\n")).toMatch(/stopped because somebody asked EO to rebuild/i);
  });

  it("recovers a corrupted index with a run queued behind it, without discarding that run", async () => {
    // A queued run counts as active but holds nothing — no process, no
    // claim on the checkout — and `cancelRun` cannot reach one anyway.
    // Treating it as a holder made Rebuild wait out its timeout and then
    // refuse to fix a broken index because of work that had not started.
    //
    // What stops it dispatching into a checkout mid-rebuild is the
    // claim, which the rebuild holds for the duration.
    const { db, repository, item } = seed();
    await serviceFor(db).ensureIndexed({ workspaceId: repository.id, itemId: item.id, workspacePath: workspace });

    const agent = createAgent(db, { name: "reviewer", role: "reviewer", provider: "claude", instructions: "read it" });
    const waiting = createRun(db, { itemId: item.id, agentId: agent.id, action: "review", status: "queued" });

    const indexFile = join(workspace, ".codewiki", "codewiki.db");
    writeFileSync(indexFile, "");

    const lock = createItemLock();
    const recovered = await rebuildRepositoryIndexCommand(db, { ...context(), itemLock: lock }, { id: only(db).id });

    expect({ ok: recovered.ok, problem: recovered.problem }).toEqual({ ok: true, problem: null });
    expect(only(db).status).toBe("ready");
    expect(statSync(indexFile).size).toBeGreaterThan(0);
    expect(Object.keys(JSON.parse(readFileSync(indexFile, "utf8")).files)).toContain(join("src", "alpha.ts"));

    // The queued run is untouched and still waiting its turn, and the
    // item is free again for it to be dispatched into.
    expect(listRunsForItem(db, item.id).find((run) => run.id === waiting.id)?.status).toBe("queued");
    expect(lock.isHeld(item.id)).toBe(false);
    // Nothing was stopped, so nothing was announced. The seeded comment
    // is the fixture's own; what must not be there is a note claiming a
    // run was ended.
    expect(listCommentsForItem(db, item.id).map((comment) => comment.body).join("\n")).not.toMatch(/stopped because somebody asked EO to rebuild/i);
  });

  it("refuses when the checkout it describes is no longer on disk, rather than indexing an empty folder", async () => {
    const { db, repository, item } = seed();
    await serviceFor(db).ensureIndexed({ workspaceId: repository.id, itemId: item.id, workspacePath: workspace });

    const id = only(db).id;
    rmSync(workspace, { recursive: true, force: true });

    const refused = await rebuildRepositoryIndexCommand(db, context(), { id });

    expect(refused.ok).toBe(false);
    expect(refused.problem).toContain("no longer on disk");
    // And it did not helpfully recreate the directory on its way past.
    expect(existsSync(workspace)).toBe(false);
  });
});
