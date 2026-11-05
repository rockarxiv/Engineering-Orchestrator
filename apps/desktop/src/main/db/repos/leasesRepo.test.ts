import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Item } from "@eo/core";
import type { DbHandle } from "../client.js";
import { createTestItem, openMigratedTestDb } from "../testHelpers.js";
import { deleteItem } from "./itemsRepo.js";
import {
  grantLease,
  leaseFor,
  listExpiredLeases,
  listLeases,
  releaseDeviceLeases,
  releaseLease,
  renewLease,
} from "./leasesRepo.js";

/**
 * The lease table on its own (EO-322).
 *
 * These are about the row's contract — one claim per item, a claim that
 * refuses a second device while it stands, a renewal that cannot become
 * a claim — and not about what a lease *means*. That is the record's,
 * and it is asserted in `record/localRecord.test.ts`.
 */

const TTL = 60_000;
const NOW = 1_700_000_000_000;

let handle: DbHandle;
let item: Item;
let other: Item;

beforeEach(() => {
  handle = openMigratedTestDb();
  item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo" });
  other = createTestItem(handle.db, { type: "story", title: "Another story", stepId: "todo" });
});

afterEach(() => {
  handle.close();
});

describe("a dispatch lease", () => {
  it("grants the first device the item, with the expiry the caller asked for", () => {
    const lease = grantLease(handle.db, { itemId: item.id, deviceId: "local", now: NOW, ttlMs: TTL });

    expect(lease).toEqual({ itemId: item.id, deviceId: "local", grantedAt: NOW, expiresAt: NOW + TTL });
    expect(leaseFor(handle.db, item.id)).toEqual(lease);
  });

  it("refuses a second device while the first claim stands", () => {
    grantLease(handle.db, { itemId: item.id, deviceId: "local", now: NOW, ttlMs: TTL });

    const second = grantLease(handle.db, { itemId: item.id, deviceId: "laptop", now: NOW + 1, ttlMs: TTL });

    // Not an event: the losing device has written nothing and moved
    // nothing, and it is offered the same item on the next tick.
    expect(second).toBeNull();
    expect(leaseFor(handle.db, item.id)?.deviceId).toBe("local");
  });

  it("claims one item without claiming any other", () => {
    grantLease(handle.db, { itemId: item.id, deviceId: "local", now: NOW, ttlMs: TTL });

    expect(grantLease(handle.db, { itemId: other.id, deviceId: "laptop", now: NOW, ttlMs: TTL })).not.toBeNull();
    expect(listLeases(handle.db)).toHaveLength(2);
  });

  it("lets the holder take its own claim again, pushing the expiry out", () => {
    grantLease(handle.db, { itemId: item.id, deviceId: "local", now: NOW, ttlMs: TTL });

    const again = grantLease(handle.db, { itemId: item.id, deviceId: "local", now: NOW + 10, ttlMs: TTL });

    expect(again?.expiresAt).toBe(NOW + 10 + TTL);
    expect(listLeases(handle.db)).toHaveLength(1);
  });

  it("lets another device take a claim that has expired", () => {
    grantLease(handle.db, { itemId: item.id, deviceId: "local", now: NOW, ttlMs: TTL });

    const taken = grantLease(handle.db, { itemId: item.id, deviceId: "laptop", now: NOW + TTL + 1, ttlMs: TTL });

    expect(taken?.deviceId).toBe("laptop");
  });

  it("renews only a claim the device already holds", () => {
    grantLease(handle.db, { itemId: item.id, deviceId: "local", now: NOW, ttlMs: TTL });

    expect(renewLease(handle.db, { itemId: item.id, deviceId: "local", now: NOW + 5, ttlMs: TTL })?.expiresAt).toBe(NOW + 5 + TTL);
    // A renewal that could claim would be a device taking back an item
    // the record had already handed to somebody else.
    expect(renewLease(handle.db, { itemId: other.id, deviceId: "local", now: NOW + 5, ttlMs: TTL })).toBeNull();
    expect(leaseFor(handle.db, other.id)).toBeNull();
  });

  it("refuses to renew a claim that has already run out, and leaves the row for the sweep", () => {
    grantLease(handle.db, { itemId: item.id, deviceId: "local", now: NOW, ttlMs: TTL });

    // The machine slept, or the event loop stalled, for longer than the
    // whole term. Renewing here would make waking up indistinguishable
    // from never having stopped — and the expiry the record owes a
    // person a comment about would never be noticed by anybody.
    expect(renewLease(handle.db, { itemId: item.id, deviceId: "local", now: NOW + TTL + 1, ttlMs: TTL })).toBeNull();
    // Refused, not released: releasing is the record's to do, because
    // releasing is what has to be said out loud.
    expect(leaseFor(handle.db, item.id)?.expiresAt).toBe(NOW + TTL);
    expect(listExpiredLeases(handle.db, NOW + TTL + 1)).toHaveLength(1);
  });

  it("treats the deadline itself as expired, the same way everywhere", () => {
    grantLease(handle.db, { itemId: item.id, deviceId: "local", now: NOW, ttlMs: TTL });
    const deadline = NOW + TTL;

    // `expiresAt` is when the claim stops standing, not the last instant
    // it stands. Two comparisons that disagree by a millisecond are a
    // lease the sweep calls dead and the renewal calls live, which is
    // the whole of the bug this pins.
    expect(listExpiredLeases(handle.db, deadline).map((lease) => lease.itemId)).toEqual([item.id]);
    expect(renewLease(handle.db, { itemId: item.id, deviceId: "local", now: deadline, ttlMs: TTL })).toBeNull();
    expect(grantLease(handle.db, { itemId: item.id, deviceId: "laptop", now: deadline, ttlMs: TTL })?.deviceId).toBe("laptop");
  });

  it("releases only the claim the releasing device holds", () => {
    grantLease(handle.db, { itemId: item.id, deviceId: "local", now: NOW, ttlMs: TTL });

    // The late release: this device's claim expired, the item went to
    // another machine, and the first one finally gets round to letting
    // go. It must not take the item away from its new holder.
    expect(releaseLease(handle.db, item.id, "laptop")).toBe(false);
    expect(releaseLease(handle.db, item.id, "local")).toBe(true);
    expect(leaseFor(handle.db, item.id)).toBeNull();
  });

  it("hands back everything one device holds, which is what a restart does", () => {
    grantLease(handle.db, { itemId: item.id, deviceId: "local", now: NOW, ttlMs: TTL });
    grantLease(handle.db, { itemId: other.id, deviceId: "laptop", now: NOW, ttlMs: TTL });

    expect(releaseDeviceLeases(handle.db, "local").map((lease) => lease.itemId)).toEqual([item.id]);
    expect(listLeases(handle.db).map((lease) => lease.deviceId)).toEqual(["laptop"]);
  });

  it("keeps the claims the device says it is still working under", () => {
    grantLease(handle.db, { itemId: item.id, deviceId: "local", now: NOW, ttlMs: TTL });
    grantLease(handle.db, { itemId: other.id, deviceId: "local", now: NOW, ttlMs: TTL });

    // The asker is a live process, and one of its own dispatches is
    // mid-flight. "Left behind" is the difference between what the
    // database says this device holds and what it says it is doing —
    // anything else drops the claim over work still going on.
    const released = releaseDeviceLeases(handle.db, "local", [other.id]);

    expect(released.map((lease) => lease.itemId)).toEqual([item.id]);
    expect(leaseFor(handle.db, other.id)?.deviceId).toBe("local");
  });

  it("lists the claims whose device stopped saying it was still working", () => {
    grantLease(handle.db, { itemId: item.id, deviceId: "local", now: NOW, ttlMs: TTL });
    grantLease(handle.db, { itemId: other.id, deviceId: "laptop", now: NOW, ttlMs: TTL * 10 });

    expect(listExpiredLeases(handle.db, NOW + TTL + 1).map((lease) => lease.itemId)).toEqual([item.id]);
  });

  it("goes with the item when a person deletes it", () => {
    grantLease(handle.db, { itemId: item.id, deviceId: "local", now: NOW, ttlMs: TTL });

    // A lease is a claim on an item that exists. Unlike `run_events` it
    // is not a record of what happened, so there is nothing here for
    // invariant #3 to protect.
    deleteItem(handle.db, item.id);

    expect(leaseFor(handle.db, item.id)).toBeNull();
  });
});
