import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { coalescePerKey } from "./coalesce.js";

/**
 * Collapsing a burst without delaying its first event (KAN-33's sibling
 * problem): one `items:changed` push costs the renderer a refetch of
 * the project, the inbox, the archive and the repository list, and an agent
 * can write five comments in a second.
 */
beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("coalescePerKey", () => {
  it("runs the first one immediately", () => {
    // Leading edge is the whole point: the first comment of a burst is
    // the one somebody is waiting to see, and a plain debounce would
    // delay exactly that.
    const run = vi.fn();
    const announce = coalescePerKey<string>(150, run);

    announce("EO-1");

    expect(run).toHaveBeenCalledWith("EO-1");
  });

  it("collapses a burst into two calls, not ten", () => {
    const run = vi.fn();
    const announce = coalescePerKey<string>(150, run);

    for (let i = 0; i < 10; i++) announce("EO-1");
    vi.advanceTimersByTime(150);

    // One leading, one trailing sweep for everything that arrived during
    // the window.
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("does not sweep when nothing arrived during the window", () => {
    const run = vi.fn();
    const announce = coalescePerKey<string>(150, run);

    announce("EO-1");
    vi.advanceTimersByTime(150);

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("never drops the last of a burst", () => {
    // A purely leading throttle would swallow it, and the last event is
    // the one carrying the final state.
    const run = vi.fn();
    const announce = coalescePerKey<string>(150, run);

    announce("EO-1");
    vi.advanceTimersByTime(100);
    announce("EO-1"); // inside the window; must still be delivered
    vi.advanceTimersByTime(50);

    expect(run).toHaveBeenCalledTimes(2);
  });

  it("keeps keys independent — one busy item does not mute another", () => {
    const run = vi.fn();
    const announce = coalescePerKey<string>(150, run);

    announce("EO-1");
    announce("EO-2");

    expect(run.mock.calls.map(([key]) => key)).toEqual(["EO-1", "EO-2"]);
  });

  it("holds a call that lands just after a sweep for the next window (EO-557)", () => {
    // The sweep opens a window of its own. Before it did, a call at the
    // boundary ran at once as a new leading edge — the same key twice in
    // one instant.
    const run = vi.fn();
    const announce = coalescePerKey<string>(150, run);

    announce("EO-1");
    announce("EO-1");
    vi.advanceTimersByTime(150); // the sweep
    announce("EO-1");

    expect(run).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(150);
    expect(run).toHaveBeenCalledTimes(3); // ...and still delivered
  });

  it("holds a call the sweep itself causes", () => {
    const calls: number[] = [];
    let reentered = false;
    const announce: (key: string) => void = coalescePerKey<string>(150, () => {
      calls.push(Date.now());
      if (calls.length === 2 && !reentered) {
        reentered = true;
        announce("EO-1");
      }
    });
    const start = Date.now();

    announce("EO-1");
    announce("EO-1");
    vi.advanceTimersByTime(600);

    expect(calls.map((at) => at - start)).toEqual([0, 150, 300]);
  });

  it("runs at most once per window through a long steady stream", () => {
    const at: number[] = [];
    const announce = coalescePerKey<string>(150, () => void at.push(Date.now()));

    for (let i = 0; i < 100; i++) {
      announce("EO-1");
      vi.advanceTimersByTime(10);
    }
    vi.advanceTimersByTime(300);

    for (let i = 1; i < at.length; i++) expect(at[i]! - at[i - 1]!).toBeGreaterThanOrEqual(150);
  });

  it("lets a call run at once after a quiet window following a sweep", () => {
    const run = vi.fn();
    const announce = coalescePerKey<string>(150, run);

    announce("EO-1");
    announce("EO-1");
    vi.advanceTimersByTime(300); // sweep at 150, nothing in the window after it
    announce("EO-1");

    expect(run).toHaveBeenCalledTimes(3);
  });

  it("opens a fresh window once the last one closed", () => {
    const run = vi.fn();
    const announce = coalescePerKey<string>(150, run);

    announce("EO-1");
    vi.advanceTimersByTime(200);
    announce("EO-1");

    expect(run).toHaveBeenCalledTimes(2);
  });
});
