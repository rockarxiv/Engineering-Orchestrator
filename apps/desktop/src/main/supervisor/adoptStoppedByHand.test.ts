import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Agent, Item } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import {
  createRun,
  getItem,
  getSetting,
  heldByCancelOf,
  listAgents,
  listCommentsForItem,
  setItemHeld,
  setSetting,
  updateRun,
} from "../db/repos/index.js";
import { transitionItem } from "../db/repos/transitionsRepo.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { adoptStoppedByHand, STOPPED_BY_HAND_KEY } from "./adoptStoppedByHand.js";

/**
 * The stops EO-175 kept in a setting, turned into holds as EO starts
 * (EO-891): the item held where it is with the comment a cancel posts
 * now, the setting gone, and a move ending the hold as it ended the stop.
 */

const HELD_NOTE = 'Run cancelled, so this ticket is on hold at "To Do". Resume it to run the step again.';

let handle: DbHandle;
let implementer: Agent;

beforeEach(() => {
  handle = openMigratedTestDb();
  implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
});

afterEach(() => {
  handle.close();
});

/** An item whose run a person cancelled, on the step it was created on. */
function cancelledOn(title: string): { item: Item; runId: string } {
  const item = createTestItem(handle.db, { type: "story", title, stepId: "todo" });
  const run = createRun(handle.db, { itemId: item.id, agentId: implementer.id, action: "implement", status: "running" });
  updateRun(handle.db, run.id, { status: "cancelled", endedAt: Date.now() });
  return { item, runId: run.id };
}

const notes = (item: Item) => listCommentsForItem(handle.db, item.id).filter((comment) => comment.authorType === "engine").map((comment) => comment.body);

describe("a stop recorded before EO-891", () => {
  it("becomes a hold on its item, with the cancel's comment, and the setting is removed", () => {
    const { item, runId } = cancelledOn("Stopped");
    setSetting(handle.db, STOPPED_BY_HAND_KEY, [{ itemId: item.id, initiationId: `initial:${item.id}:todo` }]);

    adoptStoppedByHand(handle.db);

    expect(getItem(handle.db, item.id)).toMatchObject({ stepId: "todo", heldAt: expect.any(Number) });
    expect(heldByCancelOf(handle.db, item.id)).toBe(runId);
    expect(notes(item)).toEqual([HELD_NOTE]);
    expect(getSetting(handle.db, STOPPED_BY_HAND_KEY, null)).toBeNull();

    // Said once: a second start finds nothing left to adopt.
    adoptStoppedByHand(handle.db);
    expect(notes(item)).toEqual([HELD_NOTE]);
  });

  it("is let go by a move once it is a hold", () => {
    const { item } = cancelledOn("Stopped, then moved");
    setSetting(handle.db, STOPPED_BY_HAND_KEY, [{ itemId: item.id, initiationId: `initial:${item.id}:todo` }]);
    adoptStoppedByHand(handle.db);

    transitionItem(handle.db, { itemId: item.id, toStepId: "review", actor: "human" });

    expect(getItem(handle.db, item.id)).toMatchObject({ stepId: "review", heldAt: null });
    expect(heldByCancelOf(handle.db, item.id)).toBeNull();
  });

  it("holds nothing for a stop the item has already moved past, or an item that is gone", () => {
    const { item: moved } = cancelledOn("Moved since");
    transitionItem(handle.db, { itemId: moved.id, toStepId: "todo", actor: "human" });
    setSetting(handle.db, STOPPED_BY_HAND_KEY, [
      { itemId: moved.id, initiationId: `initial:${moved.id}:todo` },
      { itemId: "01900000-0000-7000-8000-000000000000", initiationId: "entry-1" },
    ]);

    adoptStoppedByHand(handle.db);

    expect(getItem(handle.db, moved.id)?.heldAt).toBeNull();
    expect(notes(moved)).toEqual([]);
    expect(getSetting(handle.db, STOPPED_BY_HAND_KEY, null)).toBeNull();
  });

  it("keeps a hold a person already set as theirs, and still says why the run stopped", () => {
    const { item } = cancelledOn("Held by hand too");
    setItemHeld(handle.db, item.id, 1_700_000_000_000);
    setSetting(handle.db, STOPPED_BY_HAND_KEY, [{ itemId: item.id, initiationId: `initial:${item.id}:todo` }]);

    adoptStoppedByHand(handle.db);

    expect(getItem(handle.db, item.id)?.heldAt).toBe(1_700_000_000_000);
    expect(heldByCancelOf(handle.db, item.id)).toBeNull();
    expect(notes(item)).toEqual([HELD_NOTE]);
  });
});
