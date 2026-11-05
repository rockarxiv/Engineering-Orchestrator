import { describe, expect, it, vi } from "vitest";
import { startOutboxDrain } from "./drainLoop.js";
import type { ChannelSender } from "./drain.js";
import type { Db } from "../db/client.js";


/**
 * The timer that empties the outbox (J-04, generalised in F-06).
 *
 * Only two things about it are worth pinning: it does not run on top of
 * itself, and it survives a drain that throws. Both are the difference
 * between a background loop and a source of duplicate comments.
 */
/** The loop never looks inside a sender; it only counts how often it enters one. */
const sender: ChannelSender = { send: async () => ({ ok: true, error: "" }), describe: () => "a thing", gaveUpNote: () => "" };

describe("the drain loop", () => {
  it("never starts a second drain on top of a slow one", async () => {
    // A drain that outlasts the interval would otherwise begin again
    // underneath the first and send the same comment twice.
    vi.useFakeTimers();
    let started = 0;
    let release: (() => void) | undefined;

    const db = {} as Db;

    const slowDrain = vi.fn(async () => {
      started += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { sent: 0, deferred: 0, dropped: 0, gaveUp: 0 };
    });

    const stop = startOutboxDrain(db, { jira: sender }, 1000, slowDrain);
    await vi.advanceTimersByTimeAsync(3500);

    expect(started).toBe(1);

    release?.();
    await vi.advanceTimersByTimeAsync(1000);
    expect(started).toBe(2);

    stop();
    vi.useRealTimers();
  });

  it("keeps running after a drain throws", async () => {
    // One bad drain must not end the loop for the rest of the session.
    vi.useFakeTimers();
    let calls = 0;
    const failing = vi.fn(async (): Promise<never> => {
      calls += 1;
      throw new Error("the far end exploded");
    });
    const console_error = vi.spyOn(console, "error").mockImplementation(() => {});

    const stop = startOutboxDrain({} as Db, { jira: sender }, 1000, failing);
    await vi.advanceTimersByTimeAsync(3500);

    expect(calls).toBe(3);

    stop();
    console_error.mockRestore();
    vi.useRealTimers();
  });

  it("stops when told to", async () => {
    vi.useFakeTimers();
    const drain = vi.fn(async () => ({ sent: 0, deferred: 0, dropped: 0, gaveUp: 0 }));

    const stop = startOutboxDrain({} as Db, { jira: sender }, 1000, drain);
    await vi.advanceTimersByTimeAsync(1500);
    stop();
    await vi.advanceTimersByTimeAsync(5000);

    expect(drain).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

describe("a channel with no sender", () => {
  it("is skipped rather than stopping the channels after it", async () => {
    // `senders` is a Partial, so a key present with no sender is a
    // channel this build does not drain. Breaking out of the loop there
    // took every channel after it down with it — a Jira sender that had
    // been conditionally omitted would have silently stopped pull
    // requests from ever being opened.
    const drained: string[] = [];
    const stop = startOutboxDrain(
      null as never,
      // Cast, because `exactOptionalPropertyTypes` means a typed caller
      // cannot express this — which is exactly what makes the `!sender`
      // guard defensive rather than dead. This is the shape it guards
      // against, and the guard should skip the channel, not abandon the
      // rest of them.
      { jira: undefined, forge: {} as never } as never,
      10,
      async (_db, channel) => {
        drained.push(channel);
        return { sent: 0, deferred: 0, dropped: 0, gaveUp: 0 };
      },
    );

    await vi.waitFor(() => expect(drained).toContain("forge"));
    stop();
  });
});
