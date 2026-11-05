import { afterEach, describe, expect, it, vi } from "vitest";
import { startInterval, type IntervalLoop, type IntervalLoopOptions } from "./interval.js";

/**
 * The loop the Jira pull and the archive sweep both run on (EO-303).
 *
 * What used to be asserted twice — once through five minutes of Jira,
 * once through a day of archiving — is asserted here against a tick that
 * does nothing but count, so an overlap or a missed launch reads as
 * itself rather than as a Jira request that did not arrive. What stays
 * in `jira/pullSchedule.test.ts` and `archive/sweep.test.ts` is what
 * those ticks *do*.
 */

/** Every loop a test starts, stopped afterwards — a stray tick is a confusing crash, not a failure. */
const running: IntervalLoop[] = [];

function start(options: IntervalLoopOptions): IntervalLoop {
  const loop = startInterval(options);
  running.push(loop);
  return loop;
}

afterEach(() => {
  for (const loop of running.splice(0)) loop.stop();
});

/** A counting tick and its count, which is most of what these tests need. */
function counter(): { tick: () => void; count: () => number } {
  let count = 0;
  return {
    tick: (): void => {
      count += 1;
    },
    count: () => count,
  };
}

/**
 * A tick that does not finish until the test says so, so "while a tick
 * is running" is a state a test can sit in and assert from.
 */
function gated(): { tick: () => Promise<void>; started: () => number; release: () => void } {
  let started = 0;
  const waiting: Array<() => void> = [];
  return {
    tick: (): Promise<void> => {
      started += 1;
      return new Promise<void>((resolve) => waiting.push(resolve));
    },
    started: () => started,
    release: (): void => {
      for (const resolve of waiting.splice(0)) resolve();
    },
  };
}

describe("the shared interval loop", () => {
  it("ticks at launch, not only after the first interval", () => {
    // A desktop app closed every evening would otherwise never reach a
    // daily tick. Synchronously, too: the launch tick has already
    // happened by the time `startInterval` returns, which is what let
    // the archive sweep run before the window opened.
    const counting = counter();

    start({ name: "test", tick: counting.tick, readIntervalMs: () => 60_000 });

    expect(counting.count()).toBe(1);
  });

  it("does not tick at launch when it is asked not to", () => {
    const counting = counter();

    start({ name: "test", tick: counting.tick, readIntervalMs: () => 60_000, runAtLaunch: false });

    expect(counting.count()).toBe(0);
  });

  it("keeps ticking on the timer", async () => {
    const counting = counter();

    start({ name: "test", tick: counting.tick, readIntervalMs: () => 1 });

    await vi.waitFor(() => expect(counting.count()).toBeGreaterThan(2));
  });

  it("reads the interval again for every tick rather than capturing it", async () => {
    // Why this is a re-armed timeout and not `setInterval`: a setting
    // changed at 10:00 takes effect on the next tick instead of the next
    // launch, and a job's next occurrence is not the same distance away
    // as its last one was.
    let asked = 0;

    start({
      name: "test",
      tick: () => {},
      readIntervalMs: () => {
        asked += 1;
        return 1;
      },
    });

    await vi.waitFor(() => expect(asked).toBeGreaterThan(2));
  });

  it("refuses to overlap: a tick still in flight holds the timer's next one off", async () => {
    // The flag is held until the promise settles, so a tick slower than
    // its interval delays the next one rather than running beside it.
    const slow = gated();

    start({ name: "test", tick: slow.tick, readIntervalMs: () => 1 });
    expect(slow.started()).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(slow.started(), "the timer fired many times and every one was refused").toBe(1);

    slow.release();
    await vi.waitFor(() => expect(slow.started()).toBeGreaterThan(1));
    slow.release();
  });

  it("kicks while idle: the tick happens now rather than on the next expiry", () => {
    // A minute between ticks, so the kick is the only thing that can
    // have ticked.
    const counting = counter();
    const loop = start({ name: "test", tick: counting.tick, readIntervalMs: () => 60_000, runAtLaunch: false });

    loop.kick();

    expect(counting.count()).toBe(1);
  });

  it("drops a kick that arrives while a tick is running", async () => {
    // Dropped, not queued. A kick is only ever an optimisation: whatever
    // asked for it left its marker in the database, and the next tick
    // drains it. Queueing would turn a burst of writes into a burst of
    // round trips.
    const slow = gated();
    const loop = start({ name: "test", tick: slow.tick, readIntervalMs: () => 60_000 });
    expect(slow.started()).toBe(1);

    loop.kick();
    loop.kick();
    expect(slow.started()).toBe(1);

    // And the loop takes a kick again once the tick it refused for settles.
    slow.release();
    await vi.waitFor(() => expect(slow.started()).toBe(1));
    await Promise.resolve();
    loop.kick();
    expect(slow.started()).toBe(2);
    slow.release();
  });

  it("does not reset the timer when it is kicked", async () => {
    // The timer keeps its own rhythm; a kick is beside it, not instead
    // of it. Somebody kicking constantly must not starve the tick.
    const counting = counter();
    const loop = start({ name: "test", tick: counting.tick, readIntervalMs: () => 5, runAtLaunch: false });
    const kicking = setInterval(() => loop.kick(), 1);

    try {
      await vi.waitFor(() => expect(counting.count()).toBeGreaterThan(5));
    } finally {
      clearInterval(kicking);
    }
  });

  it("stops: nothing ticks after stop, on the timer or on a kick", async () => {
    const counting = counter();
    const loop = start({ name: "test", tick: counting.tick, readIntervalMs: () => 1 });
    await vi.waitFor(() => expect(counting.count()).toBeGreaterThan(1));

    loop.stop();
    const final = counting.count();
    loop.kick();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(counting.count()).toBe(final);
  });

  it("can be stopped twice", () => {
    // Disposal runs on a path that also runs when the app is already
    // trying to exit; it must not be the thing that throws there.
    const loop = start({ name: "test", tick: () => {}, readIntervalMs: () => 60_000 });
    loop.stop();

    expect(() => loop.stop()).not.toThrow();
  });

  it("survives a tick that throws, and ticks again", async () => {
    // A timer is never the reason the app falls over — and a tick that
    // threw must not leave the non-overlap flag up for ever.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    let ticks = 0;

    start({
      name: "counting loop",
      tick: () => {
        ticks += 1;
        throw new Error("boom");
      },
      readIntervalMs: () => 1,
    });

    await vi.waitFor(() => expect(ticks).toBeGreaterThan(2));
    expect(logged.mock.calls[0]?.[0]).toBe("[eo] counting loop failed:");
    logged.mockRestore();
  });

  it("survives a tick that rejects, and ticks again", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    let ticks = 0;

    start({
      name: "counting loop",
      tick: async () => {
        ticks += 1;
        await Promise.resolve();
        throw new Error("boom");
      },
      readIntervalMs: () => 1,
    });

    await vi.waitFor(() => expect(ticks).toBeGreaterThan(2));
    expect(logged.mock.calls[0]?.[0]).toBe("[eo] counting loop failed:");
    logged.mockRestore();
  });
});
