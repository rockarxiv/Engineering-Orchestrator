import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IpcChannel, IpcPayload, IpcResponse, IpcResult, Item, Uuid } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { createProject, markProjectOnTheRecord } from "../db/repos/projectsRepo.js";
import { createPerson } from "../db/repos/peopleRepo.js";
import { issueDevice } from "../db/repos/devicesRepo.js";
import { createRun, getRun, personCostCentsSince } from "../db/repos/runsRepo.js";
import { listSideCalls, recordSideCall, type RecordSideCallInput } from "../db/repos/sideCallsRepo.js";
import { pendingCommands } from "../db/repos/recordCommandsRepo.js";
import { buildTickInput } from "../supervisor/buildTickInput.js";
import { createLocalRecord, type LocalItemRecord } from "./localRecord.js";
import { createDeviceRecord, type DeviceRecord } from "./deviceRecord.js";
import { serveApply, serveChanges, serveRelease, serveRenew, serveWork, type ServeRecordContext } from "./serveRecord.js";
import type { RecordTransport } from "./syncStatus.js";

/**
 * A side call's spend reaches the organisation's record (EO-514).
 *
 * The record's per-person daily budget sums its own `side_calls` rows by
 * the owner of each one's project. A side call a desktop made about a
 * record-held item — choosing the memory a run is given, writing down
 * what a run learnt — used to stay on that desktop, so the budget never
 * saw it. Two databases and the record contract between them, through
 * the same `serve*` functions the server puts behind its door, as
 * `sync.test.ts` does.
 */

const LIMITS = { globalConcurrency: 1, perAgentConcurrency: 1, perRepositoryConcurrency: 1 };
/** A tenth of a cent, in micro-cents: the sort of call a side call is. */
const TENTH_OF_A_CENT = 100_000;

let recordDb: DbHandle;
let deviceDb: DbHandle;
let serving: ServeRecordContext;
let theRecord: LocalItemRecord;
let device: DeviceRecord;
let annaId: Uuid;
let item: Item;

function transport(): RecordTransport {
  return {
    async request<K extends IpcChannel>(channel: K, payload: IpcPayload<K>): Promise<IpcResult<IpcResponse<K>>> {
      const answer = await (async (): Promise<unknown> => {
        switch (channel) {
          case "record:work":
            return serveWork(serving, payload as IpcPayload<"record:work">);
          case "record:renew":
            return serveRenew(serving, payload as IpcPayload<"record:renew">);
          case "record:release":
            return serveRelease(serving, payload as IpcPayload<"record:release">);
          case "record:apply":
            return serveApply(serving, payload as IpcPayload<"record:apply">);
          case "record:changes":
            return serveChanges(serving, payload as IpcPayload<"record:changes">);
          default:
            return null;
        }
      })();
      return answer === null ? { ok: false, error: { message: `EO has no channel called "${channel}".` } } : { ok: true, data: answer as IpcResponse<K> };
    },
  };
}

function sideCallOnDevice(input: Partial<RecordSideCallInput> = {}) {
  return recordSideCall(deviceDb.db, {
    purpose: "memory_select",
    projectId: (item.projectId as Uuid | null) ?? null,
    itemId: item.id as Uuid,
    runId: null,
    backend: "claude",
    model: "claude-haiku",
    tokensIn: 1_000,
    tokensOut: 50,
    costMicrocents: TENTH_OF_A_CENT,
    startedAt: Date.now(),
    durationMs: 900,
    outcome: "succeeded",
    reason: null,
    ...input,
  });
}

beforeEach(async () => {
  recordDb = openMigratedTestDb();
  deviceDb = openMigratedTestDb();
  theRecord = createLocalRecord(recordDb.db);
  serving = {
    db: recordDb.db,
    record: theRecord,
    offerWork: (deviceId, capacity) => theRecord.offerWork({ deviceId, capacity, tickInput: buildTickInput(recordDb.db, LIMITS, false) }),
  };
  const anna = createPerson(recordDb.db, { name: "Anna", email: "anna@example.com" });
  annaId = anna.id as Uuid;
  const deviceId = issueDevice(recordDb.db, { personId: anna.id, name: "anna-laptop", tokenHash: "hash-of-anna-laptop", secretsKeyHash: null }).id;
  const project = createProject(recordDb.db, { name: "Support", keyPrefix: "SUP" });
  markProjectOnTheRecord(recordDb.db, project.id, anna.id as Uuid);
  item = createTestItem(recordDb.db, { type: "story", title: "Answer the customer", stepId: "todo", projectId: project.id });
  device = createDeviceRecord({ db: deviceDb.db, deviceId: () => deviceId, transport: () => transport(), pullPageSize: 500 });
  // The desktop has the project and its item, as it does once it has
  // caught up with its organisation.
  await device.sync();
});

afterEach(() => {
  device.stop();
  recordDb.close();
  deviceDb.close();
});

describe("a side call about an item on an organisation's record", () => {
  it("reaches the record under the record's project, and counts in its owner's day there", async () => {
    const since = Date.now() - 60_000;
    expect(personCostCentsSince(recordDb.db, annaId, since)).toBe(0);

    // Ten calls of a tenth of a cent: a cent between them, which only
    // counts if they are summed before they are rounded.
    const made = Array.from({ length: 10 }, () => sideCallOnDevice());
    await device.sync();

    const arrived = listSideCalls(recordDb.db);
    expect(arrived.map((call) => call.id).sort()).toEqual(made.map((call) => call.id).sort());
    expect(arrived.every((call) => call.projectId === item.projectId && call.itemId === item.id && call.costMicrocents === TENTH_OF_A_CENT)).toBe(true);
    expect(personCostCentsSince(recordDb.db, annaId, since)).toBe(1);
    expect(pendingCommands(deviceDb.db)).toEqual([]);
  });

  it("carries the run it was made inside ahead of it, while that run is still going", async () => {
    const run = createRun(deviceDb.db, { itemId: item.id, agentId: null, action: "implement", stepId: "todo" });
    const call = sideCallOnDevice({ runId: run.id as Uuid });
    expect(getRun(recordDb.db, run.id)).toBeUndefined();

    await device.sync();

    expect(getRun(recordDb.db, run.id)).toBeDefined();
    expect(listSideCalls(recordDb.db)).toEqual([expect.objectContaining({ id: call.id, runId: run.id })]);
  });

  it("is written once however many times the report is replayed", async () => {
    const call = sideCallOnDevice();
    const queued = pendingCommands(deviceDb.db).map((entry) => entry.command);
    expect(queued).toEqual([expect.objectContaining({ kind: "sideCall", sideCallId: call.id })]);

    await serveApply(serving, { deviceId: "anna-laptop", commands: queued });
    await serveApply(serving, { deviceId: "anna-laptop", commands: queued });

    expect(listSideCalls(recordDb.db)).toHaveLength(1);
  });

  it("is not sent from a desktop for an item the organisation does not hold", async () => {
    const kept = createTestItem(deviceDb.db, { type: "story", title: "Mine alone", stepId: "todo" });
    sideCallOnDevice({ itemId: kept.id as Uuid, projectId: null });
    await device.sync();

    expect(pendingCommands(deviceDb.db)).toEqual([]);
    expect(listSideCalls(recordDb.db)).toEqual([]);
  });
});
