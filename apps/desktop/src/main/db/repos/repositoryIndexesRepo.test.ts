import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Uuid } from "@eo/core";
import type { DbHandle } from "../client.js";
import { attachWorkspace, createTestItem, openMigratedTestDb, openMigratedTestDbAt } from "../testHelpers.js";
import { deleteWorkspace } from "./workspacesRepo.js";
import {
  deleteRepositoryIndex,
  deleteRepositoryIndexesForItem,
  getRepositoryIndex,
  getRepositoryIndexById,
  listRepositoryIndexes,
  recordRepositoryIndex,
  setRepositoryIndexStatus,
} from "./repositoryIndexesRepo.js";
import { deleteItem } from "./itemsRepo.js";

/**
 * The rows behind `repository_indexes` (EO-145).
 *
 * Against the real migrations in an in-memory database, so a column
 * this repository writes and a column the migrations create cannot
 * drift apart without a test noticing — `workspace_id` is the one that
 * moved, renamed from `repository_id` by 0072 while every value stayed
 * exactly where it was.
 */

let handle: DbHandle;

beforeEach(() => {
  handle = openMigratedTestDb();
});

afterEach(() => {
  handle.close();
});

function repository(name = "api", keyPrefix = "API") {
  return attachWorkspace(handle.db, { name, keyPrefix, repoPath: `/tmp/${name}`, baseBranch: "main" });
}

function item(workspaceId: Uuid, title = "A story") {
  return createTestItem(handle.db, { type: "story", title, stepId: "todo", workspaceId });
}

describe("recordRepositoryIndex", () => {
  it("writes a note about an item's index and reads it back whole", () => {
    const repo = repository();
    const story = item(repo.id);

    const recorded = recordRepositoryIndex(
      handle.db,
      {
        workspaceId: repo.id,
        itemId: story.id,
        provider: "example",
        indexPath: "/tmp/worktrees/API-1/.index",
        status: "not_indexed",
        providerVersion: "1.0.0",
      },
      1_000,
    );

    expect(getRepositoryIndex(handle.db, { workspaceId: repo.id, itemId: story.id })).toEqual({
      id: recorded.id,
      workspaceId: repo.id,
      itemId: story.id,
      provider: "example",
      indexPath: "/tmp/worktrees/API-1/.index",
      status: "not_indexed",
      indexedCommitSha: null,
      indexedAt: null,
      updatedAt: 1_000,
      providerVersion: "1.0.0",
      errorMessage: null,
      lastSyncDurationMs: null,
      lastSyncChangedFiles: null,
      lastIndexDurationMs: null,
      indexSizeBytes: null,
    });
  });

  /**
   * The rule the table has no UNIQUE index for.
   *
   * SQLite treats NULLs as distinct in a unique index, so the baseline
   * rows this table is shaped to accept later could not be constrained
   * by one. This function is the enforcement instead, which makes it
   * worth a test of its own: a second note for a target EO already
   * knows about must rewrite the note rather than grow a duplicate
   * nothing could then choose between.
   */
  it("rewrites the note for a target it already has, rather than adding a second", () => {
    const repo = repository();
    const story = item(repo.id);
    const key = { workspaceId: repo.id, itemId: story.id };

    const first = recordRepositoryIndex(handle.db, { ...key, provider: "example", indexPath: "/old", status: "ready" }, 1_000);
    const second = recordRepositoryIndex(handle.db, { ...key, provider: "other", indexPath: "/new", status: "not_indexed" }, 2_000);

    expect(second.id).toBe(first.id);
    expect(listRepositoryIndexes(handle.db, repo.id)).toHaveLength(1);
    expect(second).toMatchObject({ provider: "other", indexPath: "/new", status: "not_indexed", updatedAt: 2_000 });
  });

  /**
   * `item_id` is nullable, and the lookup has to survive that.
   *
   * Nothing writes a baseline row in this version — the column exists
   * so that adding one later is an INSERT rather than a migration. What
   * is tested here is that the day it does, the row is findable:
   * `= NULL` is never true in SQL, so a lookup written the obvious way
   * would return nothing for every baseline and look exactly like an
   * index that was never built.
   */
  it("tells the repository's own baseline apart from an item's index", () => {
    const repo = repository();
    const story = item(repo.id);

    const baseline = recordRepositoryIndex(handle.db, { workspaceId: repo.id, itemId: null, provider: "example", indexPath: "/base", status: "ready" });
    const perItem = recordRepositoryIndex(handle.db, { workspaceId: repo.id, itemId: story.id, provider: "example", indexPath: "/story", status: "ready" });

    expect(baseline.id).not.toBe(perItem.id);
    expect(getRepositoryIndex(handle.db, { workspaceId: repo.id, itemId: null })?.indexPath).toBe("/base");
    expect(getRepositoryIndex(handle.db, { workspaceId: repo.id, itemId: story.id })?.indexPath).toBe("/story");
    expect(listRepositoryIndexes(handle.db, repo.id)).toHaveLength(2);
  });
});

describe("setRepositoryIndexStatus", () => {
  it("writes only the fields it is given, and moves updated_at on every write", () => {
    const repo = repository();
    const story = item(repo.id);
    const row = recordRepositoryIndex(
      handle.db,
      { workspaceId: repo.id, itemId: story.id, provider: "example", indexPath: "/idx", status: "indexing", providerVersion: "1.0.0" },
      1_000,
    );

    const updated = setRepositoryIndexStatus(handle.db, row.id, { status: "ready", indexedCommitSha: "abc123", indexedAt: 2_000 }, 2_000);

    expect(updated).toMatchObject({
      status: "ready",
      indexedCommitSha: "abc123",
      indexedAt: 2_000,
      updatedAt: 2_000,
      // Untouched, because the patch said nothing about it.
      providerVersion: "1.0.0",
      indexPath: "/idx",
    });
  });

  /**
   * The provider travels with a successful build, because the row has
   * to name what the directory now holds rather than what built it
   * last time.
   */
  it("rewrites the provider when it is given one", () => {
    const repo = repository();
    const row = recordRepositoryIndex(
      handle.db,
      { workspaceId: repo.id, itemId: null, provider: "somebody-else", indexPath: "/idx", status: "indexing" },
      1_000,
    );

    expect(setRepositoryIndexStatus(handle.db, row.id, { status: "ready", provider: "example" }, 2_000)).toMatchObject({
      provider: "example",
      status: "ready",
    });
  });

  it("answers with undefined for a row that is not there, rather than writing one", () => {
    expect(setRepositoryIndexStatus(handle.db, "nothing-by-that-id", { status: "ready" })).toBeUndefined();
    expect(listRepositoryIndexes(handle.db)).toEqual([]);
  });
});

describe("forgetting an index", () => {
  it("deletes the note on request", () => {
    const repo = repository();
    const row = recordRepositoryIndex(handle.db, { workspaceId: repo.id, itemId: null, provider: "example", indexPath: "/idx", status: "ready" });

    deleteRepositoryIndex(handle.db, row.id);

    expect(getRepositoryIndexById(handle.db, row.id)).toBeUndefined();
  });

  /**
   * Both foreign keys cascade, and the reason is the same for each: a
   * note about an index whose repository or item EO no longer knows
   * about is a note nobody can act on. It is not history being
   * rewritten — this table records the state of a cache.
   */
  it("goes with the repository", () => {
    const repo = repository();
    recordRepositoryIndex(handle.db, { workspaceId: repo.id, itemId: null, provider: "example", indexPath: "/idx", status: "ready" });

    deleteWorkspace(handle.db, repo.id);

    expect(listRepositoryIndexes(handle.db)).toEqual([]);
  });

  it("goes with the item", () => {
    const repo = repository();
    const story = item(repo.id);
    recordRepositoryIndex(handle.db, { workspaceId: repo.id, itemId: story.id, provider: "example", indexPath: "/idx", status: "ready" });

    deleteItem(handle.db, story.id);

    expect(listRepositoryIndexes(handle.db)).toEqual([]);
  });
});

/**
 * Forgetting by item, which is how a released worktree forgets its
 * index (EO-174).
 *
 * The caller is `workspace/dispatchWorkspace.ts`, which holds an item
 * and not a row id: releasing a checkout knows whose it was, and the
 * note it deletes is the one describing what was inside it.
 */
describe("deleteRepositoryIndexesForItem", () => {
  it("forgets that item's note and answers with how many there were", () => {
    const repo = repository();
    const story = item(repo.id);
    const other = item(repo.id, "Another story");
    recordRepositoryIndex(handle.db, { workspaceId: repo.id, itemId: story.id, provider: "example", indexPath: "/idx", status: "ready" });
    recordRepositoryIndex(handle.db, { workspaceId: repo.id, itemId: other.id, provider: "example", indexPath: "/idx2", status: "ready" });

    expect(deleteRepositoryIndexesForItem(handle.db, story.id)).toBe(1);

    expect(listRepositoryIndexes(handle.db).map((row) => row.itemId)).toEqual([other.id]);
  });

  it("leaves the repository's baseline note alone", () => {
    // `item_id` is null there, and SQL's `= NULL` is never true — but
    // the rule is worth pinning rather than inheriting from the
    // comparison's spelling.
    const repo = repository();
    const story = item(repo.id);
    recordRepositoryIndex(handle.db, { workspaceId: repo.id, itemId: null, provider: "example", indexPath: "/baseline", status: "ready" });
    recordRepositoryIndex(handle.db, { workspaceId: repo.id, itemId: story.id, provider: "example", indexPath: "/idx", status: "ready" });

    expect(deleteRepositoryIndexesForItem(handle.db, story.id)).toBe(1);

    expect(listRepositoryIndexes(handle.db).map((row) => row.itemId)).toEqual([null]);
  });

  it("answers zero for an item EO has no note about, and writes nothing", () => {
    const repo = repository();
    const story = item(repo.id);

    expect(deleteRepositoryIndexesForItem(handle.db, story.id)).toBe(0);
    expect(listRepositoryIndexes(handle.db)).toEqual([]);
  });
});

/**
 * The claim this table exists to make good on (EO-145).
 *
 * The index itself is disposable and lives on disk; the note saying it
 * exists is the part that has to survive a quit. On a file-backed
 * database rather than `:memory:`, because a handle that is closed and
 * reopened is the only way to demonstrate that the bytes were written
 * and not merely remembered.
 */
describe("across an application restart", () => {
  it("reads the row back identically from a reopened database", () => {
    const dir = mkdtempSync(join(tmpdir(), "eo-repository-indexes-"));
    const dbPath = join(dir, "eo.db");
    try {
      const first = openMigratedTestDbAt(dbPath);
      const repo = attachWorkspace(first.db, { name: "api", keyPrefix: "API", repoPath: "/tmp/api", baseBranch: "main" });
      const story = createTestItem(first.db, { type: "story", title: "A story", stepId: "todo", workspaceId: repo.id });
      const written = recordRepositoryIndex(
        first.db,
        { workspaceId: repo.id, itemId: story.id, provider: "example", indexPath: "/tmp/idx", status: "indexing", providerVersion: "1.0.0" },
        1_000,
      );
      const complete = setRepositoryIndexStatus(first.db, written.id, { status: "ready", indexedCommitSha: "abc123", indexedAt: 2_000 }, 2_000);
      first.close();

      const second = openMigratedTestDbAt(dbPath);
      try {
        expect(getRepositoryIndex(second.db, { workspaceId: repo.id, itemId: story.id })).toEqual(complete);
      } finally {
        second.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
