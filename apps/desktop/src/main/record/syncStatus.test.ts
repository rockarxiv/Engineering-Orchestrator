import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { enqueueCommand } from "../db/repos/recordCommandsRepo.js";
import { forgetSyncState, markOffline, markOnline, syncStatus } from "./syncStatus.js";

/**
 * "Offline since 09:12" (EO-324, `ARCHITECTURE.md`, "The record").
 *
 * The state behind one line of text, and the behaviour worth pinning is
 * about *which* outage it names. A timestamp that moved on every failed
 * request would say "offline since a moment ago" forever — which is the
 * one thing a person cannot act on, because the length of an outage is
 * the whole of what the line is for.
 */

const NINE_TWELVE = new Date(2026, 2, 14, 9, 12).getTime();
const NINE_THIRTEEN = NINE_TWELVE + 60_000;

let handle: DbHandle;

beforeEach(() => {
  handle = openMigratedTestDb();
});

afterEach(() => {
  handle.close();
});

describe("a desktop signed in to an organisation", () => {
  it("is online until something fails", () => {
    expect(syncStatus(handle.db, true)).toMatchObject({ state: "online", offlineSince: null, problem: null });
  });

  it("names the moment the outage started, not the moment of the last attempt", () => {
    markOffline(handle.db, NINE_TWELVE, "EO could not reach https://eo.example");
    markOffline(handle.db, NINE_THIRTEEN, "EO could not reach https://eo.example");

    expect(syncStatus(handle.db, true)).toMatchObject({ state: "offline", offlineSince: NINE_TWELVE });
  });

  it("keeps the newest reason, because an outage can change its mind about what is wrong", () => {
    markOffline(handle.db, NINE_TWELVE, "connection refused");
    markOffline(handle.db, NINE_THIRTEEN, "certificate expired");

    expect(syncStatus(handle.db, true)).toMatchObject({ offlineSince: NINE_TWELVE, problem: "certificate expired" });
  });

  it("announces the transition once, so five failing requests are one event", () => {
    expect(markOffline(handle.db, NINE_TWELVE, "down")).toBe(true);
    expect(markOffline(handle.db, NINE_THIRTEEN, "down")).toBe(false);
    expect(markOnline(handle.db)).toBe(true);
    expect(markOnline(handle.db)).toBe(false);
  });

  it("starts a fresh clock on the next outage rather than remembering the last one", () => {
    markOffline(handle.db, NINE_TWELVE, "down");
    markOnline(handle.db);
    markOffline(handle.db, NINE_THIRTEEN, "down again");

    expect(syncStatus(handle.db, true)).toMatchObject({ offlineSince: NINE_THIRTEEN });
  });

  it("counts what is waiting, and names the items a card has to draw as provisional", () => {
    const item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo" });
    enqueueCommand(
      handle.db,
      {
        kind: "transition",
        id: "01a0-move",
        transitionId: "01a0-t",
        itemId: item.id,
        fromStepId: "todo",
        toStepId: "review",
        toPipelineId: null,
        actor: "human",
        runId: null,
        reason: null,
      },
      item.id,
      NINE_TWELVE,
    );
    enqueueCommand(
      handle.db,
      {
        kind: "comment",
        id: "01a0-said",
        itemId: item.id,
        commentId: "01a0-c",
        authorType: "human",
        authorId: null,
        runId: null,
        parentId: null,
        body: "and a note",
        kindOfComment: "note",
        options: null,
        mentions: [],
        pinned: false,
        attachments: [],
        createdAt: NINE_TWELVE,
      },
      item.id,
      NINE_TWELVE,
    );

    const status = syncStatus(handle.db, true);
    // Both are waiting, and the banner counts both.
    expect(status.queued).toBe(2);
    // Only the move makes the card provisional. A comment in the queue
    // is something that has been said and will arrive; drawing a dashed
    // card for it would be saying the item might not be where it looks.
    expect(status.queuedItemIds).toEqual([item.id]);
  });
});

describe("a desktop signed in to nothing", () => {
  it("is solo rather than online, because there is no record to be online with", () => {
    expect(syncStatus(handle.db, false)).toMatchObject({ state: "solo", offlineSince: null, problem: null });
  });

  it("forgets an outage it is no longer having, when the sign-in goes", () => {
    markOffline(handle.db, NINE_TWELVE, "down");

    forgetSyncState(handle.db);

    // Signing out and then in again must not come back to a line about
    // an outage that ended with the relationship it was about.
    expect(syncStatus(handle.db, true)).toMatchObject({ state: "online", offlineSince: null });
  });
});
