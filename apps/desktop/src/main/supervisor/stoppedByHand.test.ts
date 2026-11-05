import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { deleteItem } from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { clearStop, recordStop, stopStands } from "./stoppedByHand.js";

/**
 * The record behind "a person's stop is an instruction" (EO-175).
 *
 * The behaviour it produces is tested where it is visible — in
 * `dispatchAuthorisation.test.ts`, against the scheduler that must not
 * offer the step again. What is checked here is the bookkeeping those
 * tests cannot see: that one item holds one stop, that a stop names
 * the initiation it ended rather than the item at large, and that the
 * list does not grow without bound.
 */

let handle: DbHandle;

beforeEach(() => {
  handle = openMigratedTestDb();
});

afterEach(() => {
  handle.close();
});

function itemAt(step: string) {
  return createTestItem(handle.db, { type: "story", title: "A story", stepId: step });
}

describe("a stop", () => {
  it("stands only for the initiation it was taken in", () => {
    const item = itemAt("todo");
    recordStop(handle.db, item.id, "entry-1");

    expect(stopStands(handle.db, item.id, "entry-1")).toBe(true);
    // A different initiation is a different entry into a step — the
    // item has moved, by hand or by a route, and a move is a person
    // re-authorising the work.
    expect(stopStands(handle.db, item.id, "entry-2")).toBe(false);
  });

  it("is dropped the moment it is overtaken, so an item that comes back is not stopped by it", () => {
    const item = itemAt("todo");
    recordStop(handle.db, item.id, "entry-1");

    expect(stopStands(handle.db, item.id, "entry-2")).toBe(false);
    // Coming back to the same step is a new transition and so a new
    // initiation, but "entry-1" could still be asked about by a stale
    // caller. Kept, it could only ever be wrong.
    expect(stopStands(handle.db, item.id, "entry-1")).toBe(false);
  });

  it("says nothing about an item nobody stopped", () => {
    const item = itemAt("todo");
    const other = itemAt("todo");
    recordStop(handle.db, item.id, "entry-1");

    expect(stopStands(handle.db, other.id, "entry-1")).toBe(false);
  });

  it("is replaced rather than stacked when the same item is stopped again", () => {
    const item = itemAt("todo");
    recordStop(handle.db, item.id, "entry-1");
    recordStop(handle.db, item.id, "entry-2");

    expect(stopStands(handle.db, item.id, "entry-2")).toBe(true);
    // And the one it replaced is gone: asking about an initiation that
    // has been overtaken is asking about a stop that is over.
    expect(stopStands(handle.db, item.id, "entry-1")).toBe(false);
  });

  it("is cleared outright by a resume", () => {
    const item = itemAt("todo");
    recordStop(handle.db, item.id, "entry-1");

    clearStop(handle.db, item.id);

    expect(stopStands(handle.db, item.id, "entry-1")).toBe(false);
  });

  it("does not outlive the item it was about", () => {
    const gone = itemAt("todo");
    const item = itemAt("todo");
    recordStop(handle.db, gone.id, "entry-1");
    expect(stopStands(handle.db, gone.id, "entry-1")).toBe(true);

    deleteItem(handle.db, gone.id);
    // The next stop taken anywhere sweeps it: nothing else would, and a
    // list that only ever grows is a list that ends up carrying the whole
    // history of the board rather than the state of it.
    recordStop(handle.db, item.id, "entry-1");

    expect(stopStands(handle.db, gone.id, "entry-1")).toBe(false);
    expect(stopStands(handle.db, item.id, "entry-1")).toBe(true);
  });
});
