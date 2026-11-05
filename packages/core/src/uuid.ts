import type { Uuid } from "./index.js";

// This package's tsconfig deliberately has neither "dom" nor "node" in its
// lib (it must stay typecheckable from main, preload, and renderer alike),
// so globalThis.crypto isn't ambiently declared. This is the minimal slice
// of the Web Crypto API this file needs — structurally compatible with
// both lib.dom.d.ts's Crypto and @types/node's, so it merges cleanly
// wherever this package is actually consumed.
declare global {
  interface Crypto {
    getRandomValues: <T extends ArrayBufferView>(array: T) => T;
  }
  var crypto: Crypto;
}

// The 12 bits of rand_a, used as a monotonic counter rather than
// randomness (RFC 9562 §6.2, "Replace Leftmost Random Bits with an
// Increased Clock Precision").
const MAX_COUNTER = 0xfff;

let lastTimestamp = -1;
let counter = 0;

/** Seeded in the low half so there's always headroom to increment within a millisecond. */
function seedCounter(rand: Uint8Array): number {
  return ((rand[0]! & 0x0f) << 8 | rand[1]!) >>> 1;
}

// Uses globalThis.crypto (Web Crypto), not node:crypto — this file must
// stay usable from main, preload, and renderer alike (the original design: "UUIDv7 ids,
// generated client-side").
//
// Monotonic within a millisecond, which matters more here than it might
// look: several queries order by (timestamp column, id) and rely on the
// id to break ties — comment threads, the inbox, and "which run is
// newest" all do. Left purely random, ids minted in the same
// millisecond sort in coin-flip order, and those queries silently
// return the wrong order on a fast machine. So rand_a carries a counter
// instead: same millisecond means previous id + 1, and lexicographic
// order always matches creation order.
export function uuidv7(): Uuid {
  const rand = new Uint8Array(10);
  globalThis.crypto.getRandomValues(rand);

  const now = Date.now();
  if (now > lastTimestamp) {
    lastTimestamp = now;
    counter = seedCounter(rand);
  } else {
    // Same millisecond, or the wall clock went backwards (NTP, DST on a
    // misconfigured host). Either way, never emit an id that sorts
    // before one already handed out.
    counter += 1;
    if (counter > MAX_COUNTER) {
      lastTimestamp += 1; // borrow from the next millisecond rather than wrap
      counter = seedCounter(rand);
    }
  }

  const ts = lastTimestamp;
  const bytes = new Uint8Array(16);

  // bytes 0-5: 48-bit big-endian unix timestamp in ms
  bytes[0] = Math.floor(ts / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(ts / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(ts / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(ts / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(ts / 2 ** 8) & 0xff;
  bytes[5] = ts & 0xff;

  bytes[6] = 0x70 | ((counter >>> 8) & 0x0f); // version 0111, high 4 bits of the counter
  bytes[7] = counter & 0xff; // low 8 bits of the counter
  bytes[8] = 0x80 | (rand[2]! & 0x3f); // variant 10, high 6 bits of rand_b
  bytes.set(rand.slice(3), 9); // remaining 56 bits of rand_b — still random, for uniqueness across processes

  return formatUuid(bytes);
}

function formatUuid(bytes: Uint8Array): Uuid {
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` as Uuid;
}
