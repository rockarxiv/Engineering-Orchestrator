import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHANGE_PUSH_WINDOW_MS, createChangeAnnouncers } from "./changeAnnouncers.js";
import { bridgePushChannels } from "./ipc/push.js";

/**
 * The engine's item and run pushes, coalesced per item and per run
 * (EO-557) the way comment pushes always were.
 */
let send: ReturnType<typeof vi.fn<(wireChannel: string, payload: unknown) => void>>;
let dispose: () => void;

beforeEach(() => {
  vi.useFakeTimers();
  send = vi.fn<(wireChannel: string, payload: unknown) => void>();
  dispose = bridgePushChannels({ send });
});

afterEach(() => {
  dispose();
  vi.useRealTimers();
});

function pushesOn(channel: string): unknown[] {
  return send.mock.calls.filter(([wire]) => wire === `push:${channel}`).map(([, payload]) => payload);
}

/** Ten calls spread over 100 ms, then long enough for every window to close. */
function burst(call: (i: number) => void): void {
  for (let i = 0; i < 10; i++) {
    call(i);
    vi.advanceTimersByTime(10);
  }
  vi.advanceTimersByTime(CHANGE_PUSH_WINDOW_MS * 2);
}

describe("items:changed from the engine", () => {
  it("sends at most two pushes for ten changes to one item in 100 ms", () => {
    const { announceItem } = createChangeAnnouncers();

    burst(() => announceItem("item-1"));

    const pushes = pushesOn("items:changed");
    expect(pushes.length).toBeGreaterThan(0);
    expect(pushes.length).toBeLessThanOrEqual(2);
    expect(pushes.every((payload) => (payload as { itemId?: string }).itemId === "item-1")).toBe(true);
  });

  it("sends the first one at once", () => {
    const { announceItem } = createChangeAnnouncers();

    announceItem("item-1");

    expect(pushesOn("items:changed")).toEqual([{ itemId: "item-1" }]);
  });

  it("keeps items apart: one busy item does not mute another", () => {
    const { announceItem } = createChangeAnnouncers();

    announceItem("item-1");
    announceItem("item-1");
    announceItem("item-2");

    expect(pushesOn("items:changed")).toEqual([{ itemId: "item-1" }, { itemId: "item-2" }]);
  });
});

describe("runs:changed from the engine", () => {
  it("sends at most two pushes for ten changes to one run in 100 ms", () => {
    const { announceRun } = createChangeAnnouncers();

    burst(() => announceRun("run-1", "item-1", "running"));

    const pushes = pushesOn("runs:changed");
    expect(pushes.length).toBeGreaterThan(0);
    expect(pushes.length).toBeLessThanOrEqual(2);
  });

  it("ends a burst on the run's newest status, not the first", () => {
    // The renderer lets go of a run's live drafts only on a status that
    // has ended; a sweep that repeated "running" would leave them up.
    const { announceRun } = createChangeAnnouncers();

    announceRun("run-1", "item-1", "running");
    announceRun("run-1", "item-1", "awaiting_input");
    announceRun("run-1", "item-1", "failed");
    vi.advanceTimersByTime(CHANGE_PUSH_WINDOW_MS);

    expect(pushesOn("runs:changed")).toEqual([
      { runId: "run-1", itemId: "item-1", status: "running" },
      { runId: "run-1", itemId: "item-1", status: "failed" },
    ]);
  });

  it("keeps runs apart", () => {
    const { announceRun } = createChangeAnnouncers();

    announceRun("run-1", "item-1", "running");
    announceRun("run-2", "item-1", "running");

    expect(pushesOn("runs:changed")).toHaveLength(2);
  });
});

describe("the domain-change hook", () => {
  it("is called with each push that goes out, and not with the ones folded into a window", () => {
    const onDomainChange = vi.fn();
    const { announceItem, announceRun } = createChangeAnnouncers(onDomainChange);

    burst(() => announceItem("item-1"));
    const afterItems = onDomainChange.mock.calls.length;
    burst(() => announceRun("run-1", "item-1", "running"));

    expect(afterItems).toBe(pushesOn("items:changed").length);
    expect(onDomainChange.mock.calls.length).toBe(pushesOn("items:changed").length + pushesOn("runs:changed").length);
  });
});
