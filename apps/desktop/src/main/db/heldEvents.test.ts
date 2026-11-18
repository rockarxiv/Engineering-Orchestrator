import type { Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "./client.js";
import { notifyCommentsRemoved, onCommentsRemoved } from "./commentEvents.js";
import { eventsHeld, withEventsHeld } from "./heldEvents.js";
import { openMigratedTestDb } from "./testHelpers.js";

let handle: DbHandle;
let other: DbHandle;
beforeEach(() => {
  handle = openMigratedTestDb();
  other = openMigratedTestDb();
});
afterEach(() => {
  handle.close();
  other.close();
});

describe("holding a database's write announcements (EO-833)", () => {
  it("drops them while held, on that database only, and lets them through again after", () => {
    const heard: string[] = [];
    onCommentsRemoved(handle.db, (itemId) => heard.push(`here ${itemId}`));
    onCommentsRemoved(other.db, (itemId) => heard.push(`there ${itemId}`));

    withEventsHeld(handle.db, () => {
      notifyCommentsRemoved(handle.db, "held" as Uuid);
      notifyCommentsRemoved(other.db, "elsewhere" as Uuid);
    });
    notifyCommentsRemoved(handle.db, "after" as Uuid);

    expect(heard).toEqual(["there elsewhere", "here after"]);
  });

  it("ends with the outermost hold, and ends when the work throws", () => {
    withEventsHeld(handle.db, () => {
      withEventsHeld(handle.db, () => undefined);
      expect(eventsHeld(handle.db)).toBe(true);
    });
    expect(eventsHeld(handle.db)).toBe(false);

    expect(() =>
      withEventsHeld(handle.db, () => {
        throw new Error("taken back");
      }),
    ).toThrow("taken back");
    expect(eventsHeld(handle.db)).toBe(false);
  });
});
