import type { Uuid } from "@eo/core";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../db/client.js";
import { projectForWorkspace, transitionItem } from "../db/repos/index.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { listItemSummaries } from "../ipc/domainQueries.js";
import { bridgePushChannels } from "../ipc/push.js";
import { announceSweep, startArchiveSweep } from "./schedule.js";

/**
 * The sweep as the running app starts it (EO-384): `startMain` passes
 * `announceSweep` as `onSwept`, and these cases do the same against a
 * real transport — so what is asserted is what a window receives, not
 * that a callback was called.
 *
 * It matters because archiving is the one way an item leaves
 * `items:list` without a transition or a comment to announce it, and
 * the chat rail's finished count is added up from that list.
 */
const DAY = 24 * 60 * 60 * 1000;

let handle: DbHandle;
let projectId: Uuid;
let workspaceId: Uuid;
let sent: { wireChannel: string; payload: unknown }[];
let unbridge: () => void;
let stop: () => void;

beforeEach(() => {
  handle = openMigratedTestDb();
  workspaceId = attachWorkspace(handle.db, { name: "app", keyPrefix: "APP", repoPath: "/tmp/app" }).id;
  projectId = projectForWorkspace(handle.db, workspaceId)!.id;
  sent = [];
  unbridge = bridgePushChannels({ send: (wireChannel, payload) => sent.push({ wireChannel, payload }) });
  stop = () => {};
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  stop();
  unbridge();
  handle.close();
  vi.restoreAllMocks();
});

/** An item that reached a terminal step `daysAgo` days ago, as `sweep.test.ts` makes one. */
function finished(daysAgo: number) {
  const item = createTestItem(handle.db, { type: "story", title: "Rate limiting", stepId: "todo", projectId, workspaceId });
  transitionItem(handle.db, { itemId: item.id, toStepId: "ready_to_merge", actor: "human" });
  handle.db.run(sql`update transitions set ts = ${Date.now() - daysAgo * DAY} where item_id = ${item.id}`);
  return item;
}

const listed = () => listItemSummaries(handle.db, projectId).items.map((item) => item.id);

describe("the archive sweep, as the app runs it", () => {
  it("tells open windows their items changed when it archives one, so the rail stops counting it", () => {
    const old = finished(20);
    expect(listItemSummaries(handle.db, projectId).items.find((item) => item.id === old.id)?.atTerminalStep).toBe(true);

    // The launch tick is synchronous, so the sweep has run by the next line.
    stop = startArchiveSweep(handle.db, { onSwept: announceSweep });

    expect(listed()).not.toContain(old.id);
    expect(sent).toEqual([{ wireChannel: "push:items:changed", payload: {} }]);
  });

  it("says nothing when it archived nothing", () => {
    const fresh = finished(3);

    stop = startArchiveSweep(handle.db, { onSwept: announceSweep });

    expect(listed()).toContain(fresh.id);
    expect(sent).toEqual([]);
  });
});
