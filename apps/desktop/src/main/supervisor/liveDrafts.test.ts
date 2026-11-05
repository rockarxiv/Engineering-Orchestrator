import type { IpcPushPayload } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLiveDrafts } from "./liveDrafts.js";

/**
 * The words a run is writing, held between the first delta and the stored
 * block (`liveDrafts.ts`). What is asserted is what a window would see: the
 * pieces it is pushed, and the drafts a view of the run lists.
 */
describe("live drafts", () => {
  let pushes: IpcPushPayload<"runs:delta">[];

  beforeEach(() => {
    vi.useFakeTimers();
    pushes = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function store() {
    const drafts = createLiveDrafts({ coalesceMs: 16 });
    drafts.onDelta((push) => pushes.push(push));
    return drafts;
  }

  it("coalesces the deltas of one block into one push per frame, saying where in the draft it starts", () => {
    const drafts = store();
    drafts.append("run-1", "item-1", "text", "All ");
    drafts.append("run-1", "item-1", "text", "do");
    expect(pushes).toEqual([]);
    vi.advanceTimersByTime(16);
    drafts.append("run-1", "item-1", "text", "ne.");
    vi.advanceTimersByTime(16);

    expect(pushes).toEqual([
      { runId: "run-1", itemId: "item-1", draft: { id: 1, stream: "text" }, offset: 0, text: "All do" },
      { runId: "run-1", itemId: "item-1", draft: { id: 1, stream: "text" }, offset: 6, text: "ne." },
    ]);
    expect(drafts.snapshot("run-1", -1)).toEqual([{ id: 1, stream: "text", text: "All done." }]);
  });

  it("starts a new draft when the stream changes, sending the end of the last one first", () => {
    const drafts = store();
    drafts.append("run-1", "item-1", "reasoning", "Thinking");
    drafts.append("run-1", "item-1", "text", "Answer");
    vi.advanceTimersByTime(16);

    expect(pushes.map((push) => [push.draft.id, push.draft.stream, push.text])).toEqual([
      [1, "reasoning", "Thinking"],
      [2, "text", "Answer"],
    ]);
  });

  it("keeps a settled draft until the database holds the row that finished it, and then forgets it", () => {
    const drafts = store();
    drafts.append("run-1", "item-1", "text", "Found it.");
    drafts.settle("run-1", 7, "text");
    // Settling sends what was waiting rather than holding it for the timer.
    expect(pushes.map((push) => push.text)).toEqual(["Found it."]);

    expect(drafts.snapshot("run-1", 6)).toEqual([{ id: 1, stream: "text", text: "Found it." }]);
    expect(drafts.snapshot("run-1", 7)).toEqual([]);
    // Forgotten: an older read cannot bring it back.
    expect(drafts.snapshot("run-1", 6)).toEqual([]);
  });

  it("opens a new draft after a settled one even on the same stream", () => {
    const drafts = store();
    drafts.append("run-1", "item-1", "text", "First.");
    drafts.settle("run-1", 3, "text");
    drafts.append("run-1", "item-1", "text", "Second");
    expect(drafts.snapshot("run-1", 2)).toEqual([
      { id: 1, stream: "text", text: "First." },
      { id: 2, stream: "text", text: "Second" },
    ]);
  });

  it("settling with nothing open is nothing", () => {
    const drafts = store();
    drafts.settle("run-1", 3, "text");
    expect(drafts.snapshot("run-1", -1)).toEqual([]);
    expect(pushes).toEqual([]);
  });

  it("settles the draft on the stream that finished, not merely the newest", () => {
    const drafts = store();
    drafts.append("run-1", "item-1", "reasoning", "Weighing it");
    drafts.append("run-1", "item-1", "text", "So: ");
    drafts.settle("run-1", 4, "reasoning");
    expect(drafts.snapshot("run-1", 4)).toEqual([{ id: 2, stream: "text", text: "So: " }]);
    // An error ends whatever was being written.
    drafts.settle("run-1", 5, null);
    expect(drafts.snapshot("run-1", 5)).toEqual([]);
  });

  it("drops what a turn left unfinished when it ends, so the next turn's words start a draft of their own", () => {
    const drafts = store();
    drafts.append("run-1", "item-1", "text", "Done.");
    drafts.settle("run-1", 2, "text");
    drafts.append("run-1", "item-1", "text", "Half a sent");
    drafts.endTurn("run-1");
    // The finished one waits for its row; the half-written one is gone.
    expect(drafts.snapshot("run-1", 1)).toEqual([{ id: 1, stream: "text", text: "Done." }]);
    drafts.append("run-1", "item-1", "text", "Corrected.");
    expect(drafts.snapshot("run-1", 2)).toEqual([{ id: 3, stream: "text", text: "Corrected." }]);
  });

  it("does not let a failing push reach the run", () => {
    const drafts = createLiveDrafts({ coalesceMs: 16 });
    drafts.onDelta(() => {
      throw new Error("schema");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    drafts.append("run-1", "item-1", "text", "x");
    expect(() => drafts.settle("run-1", 1, "text")).not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("keeps runs apart", () => {
    const drafts = store();
    drafts.append("run-1", "item-1", "text", "one");
    drafts.append("run-2", "item-2", "text", "two");
    vi.advanceTimersByTime(16);
    expect(drafts.snapshot("run-1", -1)).toEqual([{ id: 1, stream: "text", text: "one" }]);
    expect(drafts.snapshot("run-2", -1)).toEqual([{ id: 1, stream: "text", text: "two" }]);
    expect(pushes.map((push) => push.runId).sort()).toEqual(["run-1", "run-2"]);
  });

  it("clears a run that ended, sending what it had not yet sent, and numbers the next run's drafts from one", () => {
    const drafts = store();
    drafts.append("run-1", "item-1", "text", "Last words");
    drafts.clear("run-1");
    expect(pushes.map((push) => push.text)).toEqual(["Last words"]);
    expect(drafts.snapshot("run-1", -1)).toEqual([]);
    drafts.append("run-1", "item-1", "text", "again");
    expect(drafts.snapshot("run-1", -1)[0]?.id).toBe(1);
  });

  it("ignores an empty piece", () => {
    const drafts = store();
    drafts.append("run-1", "item-1", "text", "");
    vi.advanceTimersByTime(16);
    expect(drafts.snapshot("run-1", -1)).toEqual([]);
    expect(pushes).toEqual([]);
  });
});
