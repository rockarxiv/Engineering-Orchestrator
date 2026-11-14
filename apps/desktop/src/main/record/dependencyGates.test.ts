import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IpcPayload, Item, Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AttachmentStorage } from "../attachments/storage.js";
import type { DbHandle } from "../db/client.js";
import { issueDevice } from "../db/repos/devicesRepo.js";
import { createPerson } from "../db/repos/peopleRepo.js";
import { addDependency, createProject, getItem, listCommentsForItem, listDependencies, updateItem } from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { getItemDetail, listItemSummaries } from "../ipc/domainQueries.js";
import { buildTickInput } from "../supervisor/buildTickInput.js";
import { watchDependencyRegressions } from "../supervisor/dependencyGates.js";
import { createDeviceRecord, type DeviceRecord } from "./deviceRecord.js";
import { createLocalRecord, type LocalItemRecord } from "./localRecord.js";
import { serveApply, serveChanges, serveWork, type ServeRecordContext } from "./serveRecord.js";
import type { RecordTransport } from "./syncStatus.js";

/**
 * A `reached` edge on a project the organisation's record holds (EO-778,
 * EO-775).
 *
 * The record runs the only scheduler for its items, so it is the record
 * that works out from its own `transitions` whether a dependency has
 * arrived at the step its dependent waits for — a move made on a desktop
 * counts once the record has applied it. And the comment saying a
 * dependency went back is the record's to post, once, for every desktop:
 * each of them pulls it rather than writing its own.
 *
 * The seeded Delivery pipeline: Worktree → Index → To Do → Review →
 * Merge Request → Watching pull request → Done.
 */

const LIMITS = { globalConcurrency: 10, perAgentConcurrency: 10, perRepositoryConcurrency: 10 };

interface Desktop {
  handle: DbHandle;
  record: DeviceRecord;
  deviceId: string;
}

let recordDb: DbHandle;
let theRecord: LocalItemRecord;
let serving: ServeRecordContext;
let anna: Desktop;
let dana: Desktop;
let root: string;
const stopWatching: (() => void)[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "eo dependency gates record "));
  recordDb = openMigratedTestDb();
  theRecord = createLocalRecord(recordDb.db);
  serving = {
    db: recordDb.db,
    record: theRecord,
    attachments: new AttachmentStorage(join(root, "record-files")),
    // The record's own scheduler: a tick input built from the record's
    // tables, as the server's engine builds it.
    offerWork: (deviceId, capacity) => theRecord.offerWork({ deviceId, capacity, tickInput: buildTickInput(recordDb.db, LIMITS, false) }),
  };
  anna = desktop(openMigratedTestDb(), deviceFor("Anna", "anna@example.com", "anna-desk"));
  dana = desktop(openMigratedTestDb(), deviceFor("Dana", "dana@example.com", "dana-desk"));
  // Every process watches its own moves, as its supervisor does.
  for (const handle of [recordDb, anna.handle, dana.handle]) stopWatching.push(watchDependencyRegressions(handle.db));
});

afterEach(() => {
  for (const stop of stopWatching.splice(0)) stop();
  anna.record.stop();
  dana.record.stop();
  anna.handle.close();
  dana.handle.close();
  recordDb.close();
  rmSync(root, { recursive: true, force: true });
});

function deviceFor(name: string, email: string, machine: string): string {
  const person = createPerson(recordDb.db, { name, email });
  return issueDevice(recordDb.db, { personId: person.id, name: machine, tokenHash: `hash-of-${machine}`, secretsKeyHash: null }).id;
}

function desktop(handle: DbHandle, deviceId: string): Desktop {
  const transport: RecordTransport = {
    async request(channel, payload) {
      // Stamped at the server's door with the device the credential is for.
      if (channel === "record:apply") return { ok: true, data: (await serveApply(serving, { ...(payload as IpcPayload<"record:apply">), deviceId })) as never };
      if (channel === "record:changes") return { ok: true, data: serveChanges(serving, payload as IpcPayload<"record:changes">) as never };
      return { ok: false, error: { message: `EO has no channel called "${channel}".` } };
    },
  };
  return { handle, deviceId, record: createDeviceRecord({ db: handle.db, deviceId: () => deviceId, transport: () => transport, pullPageSize: 500 }) };
}

/** A dependency and an item waiting for it to reach Review, on a project the record holds, on both desktops. */
async function gatedPair(): Promise<{ dependency: Item; waiting: Item }> {
  const project = createProject(recordDb.db, { name: "Support", keyPrefix: "SUP", managed: true });
  const dependency = createTestItem(recordDb.db, { type: "story", title: "Goes first", stepId: "worktree", projectId: project.id });
  const waiting = createTestItem(recordDb.db, { type: "story", title: "Waits for its review", stepId: "todo", projectId: project.id });
  addDependency(recordDb.db, waiting.id as Uuid, dependency.id as Uuid, { wait: "reached", stepId: "review" });
  updateItem(recordDb.db, waiting.id as Uuid, {});
  await anna.record.sync();
  await dana.record.sync();
  for (const machine of [anna, dana]) {
    if (getItem(machine.handle.db, waiting.id) === undefined) throw new Error("the items did not reach the desktop");
  }
  return { dependency, waiting };
}

/** What the record's scheduler offers a device, by item id. */
async function offered(): Promise<string[]> {
  const answer = await serveWork(serving, { deviceId: anna.deviceId, capacity: 10 });
  return answer.offers.map((offer) => offer.itemId);
}

/** A move made on a desktop, sent to the record, which applies it. */
async function moveOn(machine: Desktop, item: Item, toStepId: string): Promise<void> {
  machine.record.applyTransition({ itemId: item.id as Uuid, toStepId, actor: "human" });
  await machine.record.sync();
  expect(getItem(recordDb.db, item.id)?.stepId).toBe(toStepId);
}

const wentBack = (handle: DbHandle, item: Item) => listCommentsForItem(handle.db, item.id).filter((comment) => comment.authorType === "engine" && comment.body.includes("has gone back"));

describe("a record-held item waiting for its dependency to reach a step", () => {
  it("is carried to each desktop with its gate, which the board and the item page say", async () => {
    const { dependency, waiting } = await gatedPair();

    for (const machine of [anna, dana]) {
      expect(listDependencies(machine.handle.db, waiting.id as Uuid)).toEqual([{ itemId: waiting.id, dependsOnId: dependency.id, wait: "reached", waitStepId: "review" }]);
      const card = listItemSummaries(machine.handle.db, waiting.projectId).items.find((entry) => entry.id === waiting.id);
      expect(card?.openDependencyGates).toEqual([`Waits for ${dependency.key} to reach Review (now at Worktree)`]);
      expect(getItemDetail(machine.handle.db, { itemId: waiting.id })?.dependsOn).toEqual([
        expect.objectContaining({ key: dependency.key, wait: "reached", waitStepId: "review", waitStepName: "Review" }),
      ]);
    }
  });

  it("is released by the record's scheduler when the dependency arrives at the gate step, and not before", async () => {
    const { dependency, waiting } = await gatedPair();

    expect(await offered()).not.toContain(waiting.id);
    await moveOn(anna, dependency, "todo");
    expect(await offered()).not.toContain(waiting.id);

    await moveOn(anna, dependency, "review");
    expect(await offered()).toContain(waiting.id);
  });

  it("stays released when the dependency goes back, and the record says so once, which every desktop pulls", async () => {
    const { dependency, waiting } = await gatedPair();
    await moveOn(anna, dependency, "todo");
    await moveOn(anna, dependency, "review");
    expect(await offered()).toContain(waiting.id);
    // Given back, so the next offer is a fresh one.
    const lease = theRecord.leaseFor(waiting.id);
    if (lease !== null) await theRecord.releaseLease(lease);

    // Sent back to To Do, a step it stood on before it first reached Review.
    await moveOn(anna, dependency, "todo");
    await anna.record.sync();
    await dana.record.sync();

    const said = wentBack(recordDb, waiting);
    expect(said).toHaveLength(1);
    expect(said[0]?.body).toContain(`${dependency.key} has gone back to "To Do"`);
    // The same comment on each desktop, copied rather than written again.
    for (const machine of [anna, dana]) expect(wentBack(machine.handle, waiting).map((comment) => comment.id)).toEqual([said[0]?.id]);
    // The latch holds: nothing is held again.
    expect(await offered()).toContain(waiting.id);
  });
});
