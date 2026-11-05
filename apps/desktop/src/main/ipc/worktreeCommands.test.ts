import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { createRun, listAgents, listRepositoryIndexes, recordRepositoryIndex, updateRun } from "../db/repos/index.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { setBranchPrefix } from "../packs/developer/workspace/branchPrefix.js";
import { branchExists } from "../packs/developer/workspace/git.js";
import { createWorktree, worktreePathFor } from "../packs/developer/workspace/worktrees.js";
import { listWorktreesCommand, releaseWorktreeCommand } from "./worktreeCommands.js";
import { run } from "../testing/git.js";

let scratch: string;
let repoPath: string;
let worktreeRoot: string;
let handle: DbHandle;

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), "eo worktree ipc "));
  repoPath = join(scratch, "the repo");
  worktreeRoot = join(scratch, "work trees");
  mkdirSync(repoPath, { recursive: true });
  await run(["init", "-b", "main"], repoPath);
  await run(["config", "user.email", "eo@example.com"], repoPath);
  await run(["config", "user.name", "EO Test"], repoPath);
  await run(["config", "commit.gpgsign", "false"], repoPath);
  await run(["config", "tag.gpgsign", "false"], repoPath);
  writeFileSync(join(repoPath, "README.md"), "# fixture\n");
  await run(["add", "-A"], repoPath);
  await run(["commit", "-m", "initial"], repoPath);

  handle = openMigratedTestDb();
  // Hermetic: without this, the branch prefix seeds itself from whatever
  // `git config --global user.email` happens to be on the machine
  // running the tests, not from the fixed "eo" every assertion expects.
  setBranchPrefix(handle.db, "eo");
});

afterEach(() => {
  handle.close();
  rmSync(scratch, { recursive: true, force: true });
});

function config() {
  return { repoPath, baseBranch: "main", worktreeRoot };
}

/** The repository every item in these tests belongs to. */
function repository() {
  return attachWorkspace(handle.db, { name: "the repo", keyPrefix: "EO", repoPath, baseBranch: "main" });
}

/** Every repository's worktrees — what the Settings screen asks for when nothing is filtered. */
const ALL = { repositoryId: null };

describe("worktrees:list", () => {
  it("says so in place when no repository is configured, rather than failing", async () => {
    const result = await listWorktreesCommand(handle.db, ALL, worktreeRoot);

    expect(result.worktrees).toEqual([]);
    expect(result.problem).toContain("No repository");
  });

  it("reports each tree with its item state, size and whether a run holds it", async () => {
    const eo = repository();
    const busy = createTestItem(handle.db, { type: "story", title: "Working", stepId: "todo", workspaceId: eo.id });
    const idle = createTestItem(handle.db, { type: "story", title: "Finished", stepId: "ready_to_merge", workspaceId: eo.id });
    await createWorktree(config(), busy.key);
    await createWorktree(config(), idle.key);

    const agent = listAgents(handle.db).find((entry) => entry.role === "implementer")!;
    const active = createRun(handle.db, { itemId: busy.id, agentId: agent.id, action: "implement", status: "queued" });
    updateRun(handle.db, active.id, { status: "running", startedAt: Date.now() });

    const { worktrees, problem } = await listWorktreesCommand(handle.db, ALL, worktreeRoot);

    expect(problem).toBeNull();
    const held = new Map(worktrees.map((entry) => [entry.itemKey, entry]));
    expect(held.get(busy.key)).toMatchObject({ inUse: true, itemState: "todo", uncommittedChanges: 0 });
    expect(held.get(idle.key)).toMatchObject({ inUse: false, itemState: "ready_to_merge" });
    expect(held.get(idle.key)!.sizeBytes).toBeGreaterThan(0); // a real checkout, so it costs something
  });

  it("reports a tree whose item is gone, since that is exactly the one nobody will clean up", async () => {
    repository();
    await createWorktree(config(), "EO-404");

    const { worktrees } = await listWorktreesCommand(handle.db, ALL, worktreeRoot);

    expect(worktrees.map((entry) => entry.itemKey)).toEqual(["EO-404"]);
    expect(worktrees[0]?.itemState).toBeNull();
  });
});

describe("worktrees:release", () => {
  it("releases a clean tree and keeps its branch", async () => {
    const eo = repository();
    await createWorktree(config(), "EO-1");

    const result = await releaseWorktreeCommand(handle.db, { itemKey: "EO-1", force: false, repositoryId: eo.id }, worktreeRoot);

    expect(result).toEqual({ released: true, reason: null });
    expect(existsSync(worktreePathFor("EO-1", worktreeRoot))).toBe(false);
    expect(await branchExists(repoPath, "eo/EO-1")).toBe(true); // the commits are the deliverable
  });

  it("refuses while a run is using it", async () => {
    const eo = repository();
    const item = createTestItem(handle.db, { type: "story", title: "Busy", stepId: "todo", workspaceId: eo.id });
    await createWorktree(config(), item.key);
    const agent = listAgents(handle.db).find((entry) => entry.role === "implementer")!;
    const active = createRun(handle.db, { itemId: item.id, agentId: agent.id, action: "implement", status: "queued" });
    updateRun(handle.db, active.id, { status: "running", startedAt: Date.now() });

    const result = await releaseWorktreeCommand(handle.db, { itemKey: item.key, force: false, repositoryId: eo.id }, worktreeRoot);

    expect(result.released).toBe(false);
    expect(result.reason).toContain("run in progress");
    expect(existsSync(worktreePathFor(item.key, worktreeRoot))).toBe(true); // an agent is writing here
  });

  /**
   * The record goes with the checkout, on this path too (EO-174).
   *
   * The index sits inside the worktree and is deleted with it, so a
   * note left behind here would go on saying `ready` — with a Refresh
   * and a Rebuild beside it — about a directory this very command has
   * just removed. This is the release a person watches happen, so it is
   * the one where a surviving row would be seen.
   */
  it("forgets what EO recorded about the index that was inside it", async () => {
    const eo = repository();
    const item = createTestItem(handle.db, { type: "story", title: "Finished", stepId: "todo", workspaceId: eo.id });
    await createWorktree(config(), item.key);
    recordRepositoryIndex(handle.db, {
      workspaceId: eo.id,
      itemId: item.id,
      provider: "example",
      indexPath: join(worktreePathFor(item.key, worktreeRoot), ".an-index"),
      status: "ready",
      providerVersion: "1.0.0",
    });

    const result = await releaseWorktreeCommand(handle.db, { itemKey: item.key, force: false, repositoryId: eo.id }, worktreeRoot);

    expect(result).toEqual({ released: true, reason: null });
    expect(listRepositoryIndexes(handle.db)).toEqual([]);
  });

  it("keeps the record when it refuses, because the index is still in there", async () => {
    const eo = repository();
    const item = createTestItem(handle.db, { type: "story", title: "Unsaved", stepId: "todo", workspaceId: eo.id });
    const created = await createWorktree(config(), item.key);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    writeFileSync(join(created.value.path, "unsaved.txt"), "the only copy\n");
    recordRepositoryIndex(handle.db, {
      workspaceId: eo.id,
      itemId: item.id,
      provider: "example",
      indexPath: join(created.value.path, ".an-index"),
      status: "ready",
      providerVersion: "1.0.0",
    });

    const refused = await releaseWorktreeCommand(handle.db, { itemKey: item.key, force: false, repositoryId: eo.id }, worktreeRoot);

    expect(refused.released).toBe(false);
    expect(listRepositoryIndexes(handle.db).map((row) => row.itemId)).toEqual([item.id]);
  });

  it("will not discard uncommitted work unless the user forces it", async () => {
    const eo = repository();
    const created = await createWorktree(config(), "EO-2");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    writeFileSync(join(created.value.path, "unsaved.txt"), "the only copy\n");

    const refused = await releaseWorktreeCommand(handle.db, { itemKey: "EO-2", force: false, repositoryId: eo.id }, worktreeRoot);
    expect(refused.released).toBe(false);
    expect(refused.reason).toContain("uncommitted");
    expect(existsSync(created.value.path)).toBe(true);

    const forced = await releaseWorktreeCommand(handle.db, { itemKey: "EO-2", force: true, repositoryId: eo.id }, worktreeRoot);
    expect(forced.released).toBe(true);
    expect(existsSync(created.value.path)).toBe(false);
    expect(await branchExists(repoPath, "eo/EO-2")).toBe(true); // even forced, nothing committed is lost
  });
});
