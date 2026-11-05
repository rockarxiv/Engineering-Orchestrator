import { describe, expect, it } from "vitest";
import { blockedByActiveRunRefusal, createItemLock, ITEM_BUSY_REASON } from "./itemLock.js";

/**
 * The per-item mutex on its own (EO-132).
 *
 * These are about the lock's own contract — refuse rather than queue,
 * release lets the next one in, and a throw does not strand an item.
 * What the supervisor and the IPC side do with it is asserted against
 * real runs in `itemExclusion.test.ts`.
 */

const ITEM = "019fb8c6-0000-7000-8000-0000000000a1";
const OTHER = "019fb8c6-0000-7000-8000-0000000000a2";

describe("the per-item lock", () => {
  it("hands the first acquirer a hold and refuses the second immediately", () => {
    const lock = createItemLock();

    const first = lock.acquire(ITEM);
    const second = lock.acquire(ITEM);

    expect(first).not.toBeNull();
    // Not a promise that resolves later: losing is an answer, not a wait.
    expect(second).toBeNull();
    expect(lock.isHeld(ITEM)).toBe(true);
  });

  it("locks one item without locking any other", () => {
    const lock = createItemLock();
    lock.acquire(ITEM);

    expect(lock.acquire(OTHER)).not.toBeNull();
    expect(lock.isHeld(OTHER)).toBe(true);
  });

  it("releasing lets the next acquirer in", () => {
    const lock = createItemLock();
    const hold = lock.acquire(ITEM)!;

    hold();

    expect(lock.isHeld(ITEM)).toBe(false);
    expect(lock.acquire(ITEM)).not.toBeNull();
  });

  it("a hold released twice cannot evict whoever claimed the item in between", () => {
    const lock = createItemLock();
    const stale = lock.acquire(ITEM)!;
    stale();
    lock.acquire(ITEM); // somebody else now holds it

    stale(); // the late second release

    expect(lock.isHeld(ITEM)).toBe(true);
  });

  it("run() holds the item for the whole of the body and gives it back after", async () => {
    const lock = createItemLock();
    let heldDuring = false;

    const outcome = await lock.run(ITEM, async () => {
      heldDuring = lock.isHeld(ITEM);
      return "done";
    });

    expect(heldDuring).toBe(true);
    expect(outcome).toEqual({ claimed: true, value: "done" });
    expect(lock.isHeld(ITEM)).toBe(false);
  });

  it("run() refuses without calling the body at all when the item is held", async () => {
    const lock = createItemLock();
    lock.acquire(ITEM);
    let called = false;

    const outcome = await lock.run(ITEM, async () => {
      called = true;
    });

    expect(outcome).toEqual({ claimed: false });
    expect(called).toBe(false);
  });

  it("a throw inside the critical section still releases the lock", async () => {
    const lock = createItemLock();

    // The failure a lock with no timeout has to be built not to have: one
    // dispatch that throws would otherwise strand its item for the
    // lifetime of the process.
    await expect(
      lock.run(ITEM, async () => {
        throw new Error("the provider fell over");
      }),
    ).rejects.toThrow("the provider fell over");

    expect(lock.isHeld(ITEM)).toBe(false);
    expect(lock.acquire(ITEM)).not.toBeNull();
  });

  it("two run() calls on one item cannot overlap", async () => {
    const lock = createItemLock();
    let inside = 0;
    let peak = 0;
    const body = async (): Promise<void> => {
      inside += 1;
      peak = Math.max(peak, inside);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inside -= 1;
    };

    const outcomes = await Promise.all([lock.run(ITEM, body), lock.run(ITEM, body)]);

    expect(peak).toBe(1);
    expect(outcomes.filter((outcome) => outcome.claimed)).toHaveLength(1);
  });

  describe("the refusal it produces", () => {
    /**
     * The `blockedByActiveRun` wording, whole.
     *
     * Asserted as complete strings rather than by fragments, because the
     * point of having one formatter is that there is one sentence: a
     * test that only checked for "an agent is working on it" would pass
     * against a second wording that happened to quote the first.
     */
    it("is the sentence item_move has always answered with", () => {
      expect(blockedByActiveRunRefusal("move the ticket", { tool: "ticket_move" })).toBe(
        "EO did not move the ticket: an agent is working on it right now. Call ticket_move again with " +
          "cancelActiveRun: true to interrupt that agent and discard what it has not finished, or wait for the run " +
          "to end and try again. Nothing has changed.",
      );
    });

    it("is the same sentence without the affordance a caller does not have", () => {
      // A dry run has no agent of its own to interrupt, so there is
      // nothing to offer `cancelActiveRun` against. Everything else —
      // the opening clause, the condition, the close — is identical.
      expect(blockedByActiveRunRefusal("run this module against this ticket")).toBe(
        "EO did not run this module against this ticket: an agent is working on it right now. Wait for the run to " +
          "end and try again. Nothing has changed.",
      );
    });

    it("always names what was refused, and always closes on nothing having changed", () => {
      for (const refusal of [
        blockedByActiveRunRefusal("hold the ticket", { tool: "ticket_hold" }),
        blockedByActiveRunRefusal("run this module against this ticket"),
        blockedByActiveRunRefusal("pick this ticket back up after your reply"),
      ]) {
        expect(refusal.startsWith("EO did not ")).toBe(true);
        expect(refusal).toContain(ITEM_BUSY_REASON);
        // What a model reading this has to be able to rely on.
        expect(refusal.endsWith("Nothing has changed.")).toBe(true);
      }
    });
  });
});
