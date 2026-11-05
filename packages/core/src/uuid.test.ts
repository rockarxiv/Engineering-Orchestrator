import { describe, expect, it } from "vitest";
import { uuidv7 } from "./uuid.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("uuidv7", () => {
  it("produces a well-formed v7 uuid — version 7, RFC 4122 variant", () => {
    expect(uuidv7()).toMatch(UUID_PATTERN);
  });

  it("encodes the current time in the leading bits", () => {
    const before = Date.now();
    const timestamp = Number.parseInt(uuidv7().replace(/-/g, "").slice(0, 12), 16);

    expect(timestamp).toBeGreaterThanOrEqual(before);
    expect(timestamp).toBeLessThanOrEqual(Date.now());
  });

  it("is unique across a large batch", () => {
    const ids = Array.from({ length: 50_000 }, uuidv7);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("sorts in creation order even within a single millisecond", () => {
    // The regression this guards: with rand_a left purely random, ids
    // minted in the same millisecond sorted in coin-flip order (~50% of
    // adjacent pairs inverted). Several queries order by (timestamp
    // column, id) and lean on the id to break ties — comment threads,
    // the inbox, "which run is newest" — so they silently returned the
    // wrong order on a machine fast enough to mint two ids per
    // millisecond. Caught as an ordering test failing only on the macOS
    // CI runner.
    const ids = Array.from({ length: 20_000 }, uuidv7);

    const sameMillisecondPairs = ids.filter((id, index) => index > 0 && id.slice(0, 13) === ids[index - 1]!.slice(0, 13)).length;
    expect(sameMillisecondPairs).toBeGreaterThan(100); // the case actually got exercised

    expect(ids).toEqual([...ids].sort());
  });

  it("stays monotonic across a counter overflow within one millisecond", () => {
    // More than 4096 ids in a millisecond exhausts rand_a's counter; it
    // must borrow from the next millisecond rather than wrap backwards.
    const ids = Array.from({ length: 10_000 }, uuidv7);
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(ids.length);
  });
});
