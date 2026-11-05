import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Agent, Item } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { createStep, listAgents, listCommentsForItem, listPipelineSteps } from "../db/repos/index.js";
import { leaseFor, listLeases } from "../db/repos/leasesRepo.js";
import { listTransitionsForItem } from "../db/repos/transitionsRepo.js";
import { buildTickInput } from "../supervisor/buildTickInput.js";
import { createLocalRecord, recordFor, type LocalItemRecord } from "./localRecord.js";

/**
 * The record, in the one process it shares with its device (EO-322,
 * `ARCHITECTURE.md`, "The record").
 *
 * What is asserted here is the record's own contract: it picks, it
 * grants, it releases what expired and says so, and it is the one thing
 * that writes where an item sits. What the *supervisor* does with all
 * of that — claim before preflight, report a refusal, hand the claim
 * back — is asserted against real dispatches in
 * `supervisor/recordDevice.test.ts`.
 */

const LIMITS = { globalConcurrency: 1, perAgentConcurrency: 1, perRepositoryConcurrency: 1 };
const TTL = 60_000;

let handle: DbHandle;
let item: Item;
let implementer: Agent;
/** The record's clock, held still so an expiry is a decision rather than a wait. */
let clock: number;
let record: LocalItemRecord;

beforeEach(() => {
  handle = openMigratedTestDb();
  item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo" });
  implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
  clock = 1_700_000_000_000;
  record = createLocalRecord(handle.db, { now: () => clock, leaseTtlMs: TTL });
});

afterEach(() => {
  handle.close();
});

function picked(): string[] {
  return record.pick(buildTickInput(handle.db, LIMITS, false)).map((dispatch) => dispatch.item.id);
}

describe("the record picks what may be dispatched", () => {
  it("offers an item, the step it sits on, and the role that staffs it", () => {
    const dispatches = record.pick(buildTickInput(handle.db, LIMITS, false));

    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]!.item.id).toBe(item.id);
    expect(dispatches[0]!.stepId).toBe("todo");
    expect(dispatches[0]!.agent?.id).toBe(implementer.id);
  });

  it("does not offer an item a device has already claimed", () => {
    expect(record.grantLease({ itemId: item.id, deviceId: "laptop" })).not.toBeNull();

    // The lease's whole job: a second machine asking the record what to
    // do next is not told to start on work somebody is already doing.
    expect(picked()).toEqual([]);
  });

  it("offers it again once the claim is given back", async () => {
    const lease = record.grantLease({ itemId: item.id, deviceId: "laptop" })!;

    await record.releaseLease(lease);

    expect(picked()).toEqual([item.id]);
  });

  it("offers it once the claim has run out, even before the sweep", () => {
    record.grantLease({ itemId: item.id, deviceId: "laptop" });

    clock += TTL + 1;

    expect(picked()).toEqual([item.id]);
  });
});

describe("the record's tick", () => {
  it("releases a claim whose device stopped saying it was still working, and names the device", () => {
    record.grantLease({ itemId: item.id, deviceId: "anna-laptop" });
    clock += TTL + 1;

    const released = record.tick();

    expect(released.map((lease) => lease.deviceId)).toEqual(["anna-laptop"]);
    expect(leaseFor(handle.db, item.id)).toBeNull();
    // Invariant #8: nothing silently drops work on the floor. A device
    // that vanished mid-dispatch is work nobody finished and nobody was
    // told about, and which machine went quiet is the only thing on a
    // managed record that says where to look.
    const body = listCommentsForItem(handle.db, item.id).at(-1)!.body;
    expect(body).toContain("anna-laptop");
    expect(body).toContain("released");
  });

  it("leaves a claim that still stands alone, and says nothing about it", () => {
    record.grantLease({ itemId: item.id, deviceId: "anna-laptop" });
    const before = listCommentsForItem(handle.db, item.id).length;

    clock += TTL - 1;

    expect(record.tick()).toEqual([]);
    expect(leaseFor(handle.db, item.id)).not.toBeNull();
    expect(listCommentsForItem(handle.db, item.id)).toHaveLength(before);
  });

  it("releases a claim its own device tried to renew after the deadline", () => {
    const lease = record.grantLease({ itemId: item.id, deviceId: "anna-laptop" })!;

    // The stall this exists for: the machine slept for longer than the
    // whole term and woke up believing it was still working. The
    // renewal is refused, so the sweep that follows it on the same tick
    // finds the row and says what happened.
    clock += TTL + 1;
    expect(record.renewLease(lease)).toBeNull();

    expect(record.tick().map((released) => released.deviceId)).toEqual(["anna-laptop"]);
    expect(leaseFor(handle.db, item.id)).toBeNull();
    expect(listCommentsForItem(handle.db, item.id).at(-1)!.body).toContain("anna-laptop");
  });

  it("releases a claim that reached its deadline exactly", () => {
    record.grantLease({ itemId: item.id, deviceId: "anna-laptop" });

    clock += TTL;

    expect(record.tick()).toHaveLength(1);
    expect(picked()).toEqual([item.id]);
  });

  it("keeps a renewed claim standing for as long as its device keeps saying so", () => {
    const lease = record.grantLease({ itemId: item.id, deviceId: "anna-laptop" })!;

    // A long run is not a dead device. The one this stands in for is a
    // dispatch that takes an hour: its device renews on every tick, and
    // nothing about the length of the work releases the item.
    for (let elapsed = 0; elapsed < TTL * 5; elapsed += TTL / 2) {
      clock += TTL / 2;
      record.renewLease(record.leaseFor(item.id) ?? lease);
      expect(record.tick()).toEqual([]);
    }

    expect(leaseFor(handle.db, item.id)?.deviceId).toBe("anna-laptop");
  });
});

describe("the record applies a transition command", () => {
  it("moves the item and records the move", () => {
    const review = listPipelineSteps(handle.db).find((step) => step.id === "review")!;

    const moved = record.applyTransition({
      itemId: item.id,
      toStepId: review.id,
      toPipelineId: review.pipelineId,
      actor: "human",
      reason: "moved on the project",
    });

    expect(moved.stepId).toBe(review.id);
    expect(listTransitionsForItem(handle.db, item.id).at(-1)).toMatchObject({
      toStepId: review.id,
      actor: "human",
      reason: "moved on the project",
    });
  });
});

describe("one record per database", () => {
  it("answers with the same record twice, because the record is the database's item state", () => {
    // The supervisor that ran the agent and the IPC command behind a
    // drag have to be talking to one record; two would make invariant
    // #1 true of each of them separately and of neither together.
    expect(recordFor(handle.db)).toBe(recordFor(handle.db));
  });
});

describe("work no cap holds back (EO-616)", () => {
  const steward = (): void => {
    createStep(handle.db, { id: "ask", pipelineId: "default" as never, position: -1, name: "Intake", type: "agent", ownerRole: "system", entryAction: "intake" });
  };
  const input = () => buildTickInput(handle.db, LIMITS, false, {}, clock, Number.POSITIVE_INFINITY, null, false, new Set(), new Set(["system"]));

  it("is offered at a capacity of nought, and other work is not", async () => {
    steward();
    const own = createTestItem(handle.db, { type: "feature", title: "The system agent's", stepId: "ask" });

    const offers = await record.offerWork({ deviceId: "laptop", capacity: 0, tickInput: input() });

    expect(offers.map((offer) => offer.dispatch.item.id)).toEqual([own.id]);
    expect(leaseFor(handle.db, item.id)).toBeNull();
  });

  it("does not need a slot behind work that took the last one", async () => {
    steward();
    const own = createTestItem(handle.db, { type: "feature", title: "The system agent's", stepId: "ask" });

    const offers = await record.offerWork({ deviceId: "laptop", capacity: 1, tickInput: input() });

    expect(offers.map((offer) => offer.dispatch.item.id).sort()).toEqual([item.id, own.id].sort());
  });

  it("is not offered to a process that can run nothing, whose ask still sweeps", async () => {
    steward();
    createTestItem(handle.db, { type: "feature", title: "The system agent's", stepId: "ask" });
    record.grantLease({ itemId: item.id, deviceId: "gone" });
    clock += TTL + 1;

    expect(await record.offerWork({ deviceId: "server", capacity: null, tickInput: input() })).toEqual([]);

    expect(listLeases(handle.db)).toEqual([]);
    expect(listCommentsForItem(handle.db, item.id).map((comment) => comment.body).join("\n")).toContain("gone");
  });
});
