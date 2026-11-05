import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { enqueueOutbox, listCommentsForItem, needsAttention, pendingPushesForItem } from "../db/repos/index.js";
import { outbox } from "../db/schema.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { retireForgeQueue } from "./retireForgeQueue.js";

/**
 * What happens to a pull request the old queue was still holding (EO-77).
 *
 * The first attempt deleted these rows in the migration, which is the
 * failure invariant #8 exists to prevent: the merge step had already
 * reported `opened`, so the item routed on and its thread says a pull
 * request exists — and the queue row was the only remaining trace that
 * one does not.
 */
let handle: DbHandle;

beforeEach(() => {
  handle = openMigratedTestDb();
});

afterEach(() => {
  handle.close();
});

function queued() {
  const repository = attachWorkspace(handle.db, { name: "acme-api", keyPrefix: "API", repoPath: "/tmp/eo/repo" });
  const item = createTestItem(handle.db, { type: "story", workspaceId: repository.id, title: "Outbox table", stepId: "ready_to_merge", git: { branch: "eo/API-4" } });
  enqueueOutbox(handle.db, { itemId: item.id, workspaceId: repository.id, channel: "forge", kind: "comment", payload: {} });
  return item;
}

describe("retiring what the forge queue was holding", () => {
  it("tells the item its pull request never opened, rather than dropping the row in silence", () => {
    const item = queued();

    expect(retireForgeQueue(handle.db)).toBe(1);

    const said = listCommentsForItem(handle.db, item.id).at(-1);
    expect(said?.body).toContain("no pull request open");
    expect(said?.body).toContain("eo/API-4");
    // An escalation, so it raises `!` and reaches the inbox: the person
    // believes their change is up for review, and nothing else on the
    // screen disagrees.
    expect(needsAttention(handle.db, item.id)).toBe(true);
  });

  it("empties the queue, so a second launch does not say it again", () => {
    const item = queued();

    retireForgeQueue(handle.db);
    expect(retireForgeQueue(handle.db)).toBe(0);

    expect(pendingPushesForItem(handle.db, item.id, "forge")).toEqual([]);
    expect(listCommentsForItem(handle.db, item.id)).toHaveLength(1);
  });

  it("takes a row that is sitting out a backoff, which is the likeliest one to be here", () => {
    // `duePushes` on its own would skip it — and a deferred send is
    // exactly as stranded as a due one now that nothing drains the
    // channel.
    const item = queued();
    const [entry] = pendingPushesForItem(handle.db, item.id, "forge");
    handle.db.update(outbox).set({ nextAttemptAt: Date.now() + 30 * 60_000 }).where(eq(outbox.id, entry!.id)).run();

    expect(retireForgeQueue(handle.db)).toBe(1);
  });

  it("says nothing at all when the queue was empty, which is every normal launch", () => {
    const item = queued();
    handle.db.delete(outbox).run();

    expect(retireForgeQueue(handle.db)).toBe(0);
    expect(listCommentsForItem(handle.db, item.id)).toEqual([]);
  });
});
