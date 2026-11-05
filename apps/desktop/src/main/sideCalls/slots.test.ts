import { describe, expect, it, vi } from "vitest";
import { createSideCallSlots } from "./slots.js";

const never = () => new AbortController().signal;

/** The global slots a side call made on its own waits for and holds (EO-477, invariant 10). */
describe("side call slots", () => {
  it("grants a free slot at once and counts it until it is given back", async () => {
    const onRelease = vi.fn();
    const slots = createSideCallSlots({ limit: () => 1, busy: () => 0, onRelease });

    const release = await slots.acquire(never());
    expect(release).not.toBeNull();
    expect(slots.held()).toBe(1);
    expect(slots.reserved()).toBe(1);

    release!();
    release!(); // twice is once
    expect(slots.held()).toBe(0);
    expect(onRelease).toHaveBeenCalledOnce();
  });

  it("waits while runs hold every slot, is counted as reserved while it waits, and is granted when one frees", async () => {
    let busy = 1;
    const slots = createSideCallSlots({ limit: () => 1, busy: () => busy, pollMs: 5 });

    let granted = false;
    const pending = slots.acquire(never()).then((release) => {
      granted = true;
      return release;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(granted).toBe(false);
    // The tick leaves it alone: a slot the run gives back is this call's.
    expect(slots.reserved()).toBe(1);

    busy = 0;
    slots.poke();
    const release = await pending;
    expect(slots.held()).toBe(1);
    release!();
  });

  it("finds a freed slot by itself, without being poked", async () => {
    let busy = 1;
    const slots = createSideCallSlots({ limit: () => 1, busy: () => busy, pollMs: 5 });
    const pending = slots.acquire(never());
    busy = 0;
    expect(await pending).not.toBeNull();
  });

  it("holds one slot per call against the limit, and grants waiters in the order they asked", async () => {
    const slots = createSideCallSlots({ limit: () => 2, busy: () => 0, pollMs: 5 });
    const first = await slots.acquire(never());
    const second = await slots.acquire(never());
    const order: string[] = [];
    const third = slots.acquire(never()).then((release) => (order.push("third"), release));
    const fourth = slots.acquire(never()).then((release) => (order.push("fourth"), release));
    expect(slots.reserved()).toBe(4);

    first!();
    (await third)!();
    second!();
    (await fourth)!();
    expect(order).toEqual(["third", "fourth"]);
    expect(slots.reserved()).toBe(0);
  });

  it("lets a waiter go when its signal ends the wait, and gives the tick its slot back", async () => {
    const onRelease = vi.fn();
    const slots = createSideCallSlots({ limit: () => 1, busy: () => 1, pollMs: 5, onRelease });
    const controller = new AbortController();
    const pending = slots.acquire(controller.signal);

    controller.abort();

    expect(await pending).toBeNull();
    expect(slots.waiting()).toBe(0);
    expect(slots.reserved()).toBe(0);
    expect(onRelease).toHaveBeenCalledOnce();
  });

  it("follows the limit as it is now, so a raised limit frees a waiter", async () => {
    let limit = 1;
    const slots = createSideCallSlots({ limit: () => limit, busy: () => 1, pollMs: 5 });
    const pending = slots.acquire(never());
    limit = 2;
    expect(await pending).not.toBeNull();
  });
});
