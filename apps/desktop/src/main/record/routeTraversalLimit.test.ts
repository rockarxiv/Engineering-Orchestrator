import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecordCommandSchema, type IpcPayload, type Item, type Uuid } from "@eo/core";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AttachmentStorage } from "../attachments/storage.js";
import type { DbHandle } from "../db/client.js";
import { issueDevice } from "../db/repos/devicesRepo.js";
import { createPerson } from "../db/repos/peopleRepo.js";
import { createProject, getItem } from "../db/repos/index.js";
import { stepRoutes, transitions } from "../db/schema.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { buildTickInput } from "../supervisor/buildTickInput.js";
import { createDeviceRecord, type DeviceRecord } from "./deviceRecord.js";
import { createLocalRecord, type LocalItemRecord } from "./localRecord.js";
import { serveApply, serveChanges, serveWork, type ServeRecordContext } from "./serveRecord.js";
import type { RecordTransport } from "./syncStatus.js";

/**
 * A route's traversal limit on a project the organisation's record holds
 * (EO-921). The record runs the only scheduler for its items, so it has to
 * count the moves a desktop made: each move's result key travels with its
 * command, and the record writes it on its own audit row.
 */

const LIMITS = { globalConcurrency: 10, perAgentConcurrency: 10, perRepositoryConcurrency: 10 };

let recordDb: DbHandle;
let theRecord: LocalItemRecord;
let serving: ServeRecordContext;
let desktopDb: DbHandle;
let desktop: DeviceRecord;
let deviceId: string;
let root: string;
let clock: number;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  clock = Date.UTC(2026, 10, 26, 9, 0, 0);
  vi.setSystemTime(clock);
  root = mkdtempSync(join(tmpdir(), "eo route limits record "));
  recordDb = openMigratedTestDb();
  theRecord = createLocalRecord(recordDb.db);
  serving = {
    db: recordDb.db,
    record: theRecord,
    attachments: new AttachmentStorage(join(root, "record-files")),
    offerWork: (asking, capacity) => theRecord.offerWork({ deviceId: asking, capacity, tickInput: buildTickInput(recordDb.db, LIMITS, false) }),
  };
  const person = createPerson(recordDb.db, { name: "Anna", email: "anna@example.com" });
  deviceId = issueDevice(recordDb.db, { personId: person.id, name: "anna-desk", tokenHash: "hash-of-anna-desk", secretsKeyHash: null }).id;
  desktopDb = openMigratedTestDb();
  const transport: RecordTransport = {
    async request(channel, payload) {
      if (channel === "record:apply") return { ok: true, data: (await serveApply(serving, { ...(payload as IpcPayload<"record:apply">), deviceId })) as never };
      if (channel === "record:changes") return { ok: true, data: serveChanges(serving, payload as IpcPayload<"record:changes">) as never };
      return { ok: false, error: { message: `EO has no channel called "${channel}".` } };
    },
  };
  desktop = createDeviceRecord({ db: desktopDb.db, deviceId: () => deviceId, transport: () => transport, pullPageSize: 500 });
  for (const handle of [recordDb, desktopDb]) {
    handle.db.update(stepRoutes).set({ traversalLimit: 1 }).where(and(eq(stepRoutes.fromStepId, "review"), eq(stepRoutes.resultKey, "approved"))).run();
  }
});

afterEach(() => {
  desktop.stop();
  desktopDb.close();
  recordDb.close();
  rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
});

async function move(item: Item, toStepId: string, resultKey?: string): Promise<void> {
  clock += 1_000;
  vi.setSystemTime(clock);
  desktop.applyTransition({ itemId: item.id as Uuid, toStepId, toPipelineId: "default" as Uuid, actor: "engine", ...(resultKey === undefined ? {} : { resultKey }) });
  await desktop.sync();
  expect(getItem(recordDb.db, item.id)?.stepId).toBe(toStepId);
}

describe("a route's traversal limit on a record-held project", () => {
  it("reaches the record with each move's result, and the record's scheduler holds the item past the limit", async () => {
    const project = createProject(recordDb.db, { name: "Support", keyPrefix: "SUP", managed: true });
    const item = createTestItem(recordDb.db, { type: "story", title: "Loops", stepId: "review", projectId: project.id });
    await desktop.sync();
    expect(getItem(desktopDb.db, item.id)).toBeDefined();

    const offered = async () => (await serveWork(serving, { deviceId, capacity: 10 })).offers.map((offer) => offer.itemId);
    await move(item, "merge_request", "approved");
    expect(await offered()).toContain(item.id);
    const lease = theRecord.leaseFor(item.id);
    if (lease !== null) await theRecord.releaseLease(lease);

    await move(item, "review");
    await move(item, "merge_request", "approved");
    expect(recordDb.db.select({ resultKey: transitions.resultKey }).from(transitions).where(eq(transitions.itemId, item.id)).all().map((row) => row.resultKey)).toEqual(["approved", null, "approved"]);
    // The record writes the version each move left from its own item, the
    // one it routes by, so a route into another pipeline is read there.
    const left = recordDb.db.select({ version: transitions.fromPipelineVersionId }).from(transitions).where(eq(transitions.itemId, item.id)).all();
    expect(new Set(left.map((row) => row.version))).toEqual(new Set([getItem(recordDb.db, item.id)?.pipelineVersionId]));
    expect(await offered()).not.toContain(item.id);
  });

  it("still takes a move from a device that predates the field, counting it towards no limit", () => {
    const parsed = RecordCommandSchema.parse({ kind: "transition", id: "c-1", transitionId: "t-1", itemId: "i-1", fromStepId: "review", toStepId: "todo", actor: "engine" });
    expect(parsed).toMatchObject({ kind: "transition" });
    expect("resultKey" in parsed ? parsed.resultKey : undefined).toBeUndefined();
  });
});
