import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IpcPayload, RecordAdoptCounts, Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AttachmentStorage } from "../attachments/storage.js";
import type { DbHandle } from "../db/client.js";
import { issueDevice } from "../db/repos/devicesRepo.js";
import { createPerson } from "../db/repos/peopleRepo.js";
import { createProject, getItem, getProject, listItemsForProject } from "../db/repos/index.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { findProjectThread, isProjectThread } from "../projects/projectThread.js";
import { createDeviceRecord, type DeviceRecord } from "./deviceRecord.js";
import { createLocalRecord } from "./localRecord.js";
import { moveProjectToRecord } from "./adopt.js";
import { serveAdopt, serveChanges, serveProjectThread, type ServeRecordContext } from "./serveRecord.js";
import type { RecordTransport } from "./syncStatus.js";

/**
 * A project's thread where the project is the organisation's (EO-471,
 * ARCHITECTURE.md, "One channel", "The record").
 *
 * The thread belongs to the record like the project's other items. A
 * desktop that made one on its replica would hold an item the record
 * never receives — every comment on it refused there, and a second
 * desktop making a second thread. So the desktop asks, and these tests
 * look at the *record's* database for how many there are.
 */

interface Desktop {
  handle: DbHandle;
  record: DeviceRecord;
  online: boolean;
}

let recordDb: DbHandle;
let serving: ServeRecordContext;
let anna: Desktop;
let laptop: Desktop;
let annaPersonId: Uuid;
let annaDeviceId: string;
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "eo project thread record "));
  recordDb = openMigratedTestDb();
  serving = {
    db: recordDb.db,
    record: createLocalRecord(recordDb.db),
    attachments: new AttachmentStorage(join(root, "record-files")),
    offerWork: async () => [],
  };
  annaPersonId = createPerson(recordDb.db, { name: "Anna", email: "anna@example.com" }).id;
  annaDeviceId = issueDevice(recordDb.db, { personId: annaPersonId, name: "anna-desk", tokenHash: "h1", secretsKeyHash: null }).id;
  anna = desktop(openMigratedTestDb(), annaDeviceId);
  laptop = desktop(openMigratedTestDb());
});

afterEach(() => {
  for (const machine of [anna, laptop]) {
    machine.record.stop();
    machine.handle.close();
  }
  recordDb.close();
  rmSync(root, { recursive: true, force: true });
});

function desktop(handle: DbHandle, deviceId = "device"): Desktop {
  const machine: Desktop = { handle, online: true, record: undefined as unknown as DeviceRecord };
  const transport: RecordTransport = {
    async request(channel, payload) {
      if (!machine.online) return { ok: false, error: { message: "EO could not reach https://eo.example: fetch failed" } };
      if (channel === "record:projectThread") return { ok: true, data: (await serveProjectThread(serving, payload as IpcPayload<"record:projectThread">)) as never };
      if (channel === "record:changes") return { ok: true, data: serveChanges(serving, payload as IpcPayload<"record:changes">) as never };
      return { ok: false, error: { message: `EO has no channel called "${channel}".` } };
    },
  };
  machine.record = createDeviceRecord({ db: handle.db, deviceId: () => deviceId, transport: () => transport, pullPageSize: 500 });
  return machine;
}

/** A project on the record, pulled down to both desktops. */
async function organisationProject(): Promise<Uuid> {
  const project = createProject(recordDb.db, { name: "Support", keyPrefix: "SUP", managed: true });
  await anna.record.sync();
  await laptop.record.sync();
  if (getProject(anna.handle.db, project.id) === undefined) throw new Error("the project did not reach the desktop");
  return project.id;
}

describe("a project the organisation holds", () => {
  it("has its thread made by the record, and copied into the desktop that asked", async () => {
    const projectId = await organisationProject();

    const answer = await anna.record.projectThread(projectId);

    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    const onTheRecord = findProjectThread(recordDb.db, projectId);
    expect(onTheRecord?.id).toBe(answer.item.id);
    expect(getItem(anna.handle.db, answer.item.id)).toMatchObject({ key: onTheRecord?.key, projectId, stepId: "project-thread" });
  });

  it("makes one thread on the record when two desktops ask at once", async () => {
    const projectId = await organisationProject();

    const [fromAnna, fromLaptop] = await Promise.all([anna.record.projectThread(projectId), laptop.record.projectThread(projectId)]);

    expect(fromAnna.ok && fromLaptop.ok).toBe(true);
    if (!fromAnna.ok || !fromLaptop.ok) return;
    expect(fromLaptop.item.id).toBe(fromAnna.item.id);
    expect(listItemsForProject(recordDb.db, projectId).filter(isProjectThread)).toHaveLength(1);
  });

  it("makes none on the desktop when the record cannot be reached, and says so", async () => {
    const projectId = await organisationProject();
    anna.online = false;

    const answer = await anna.record.projectThread(projectId);

    expect(answer.ok).toBe(false);
    expect(answer.ok ? "" : answer.problem).toMatch(/on your organisation's record, which could not be reached/);
    expect(findProjectThread(anna.handle.db, projectId)).toBeUndefined();
    expect(findProjectThread(recordDb.db, projectId)).toBeUndefined();
  });

  it("makes none on a desktop that has signed out, because a moved project stays the record's", async () => {
    const projectId = await organisationProject();
    anna.record.stop();
    anna.record = createDeviceRecord({ db: anna.handle.db, deviceId: () => "device", transport: () => null });

    const answer = await anna.record.projectThread(projectId);

    expect(answer.ok).toBe(false);
    expect(findProjectThread(anna.handle.db, projectId)).toBeUndefined();
  });

  it("answers the replica's copy once it has one, without asking again", async () => {
    const projectId = await organisationProject();
    const first = await anna.record.projectThread(projectId);
    anna.online = false;

    const again = await anna.record.projectThread(projectId);

    expect(again.ok && first.ok && again.item.id === first.item.id).toBe(true);
  });
});

describe("a project kept on this desktop", () => {
  it("has its thread made here, and the record never hears of it", async () => {
    const kept = createProject(anna.handle.db, { name: "Mine", keyPrefix: "MINE" });

    const answer = await anna.record.projectThread(kept.id);

    expect(answer.ok).toBe(true);
    expect(findProjectThread(anna.handle.db, kept.id)).toBeDefined();
    expect(findProjectThread(recordDb.db, kept.id)).toBeUndefined();
  });
});

/**
 * Keys across the two authorities (EO-471, review).
 *
 * A desktop holds threads it made itself, for projects kept here, beside
 * threads the record made, for projects it holds. `items.key` is unique
 * in that one replica, so a key handed out by a counter on each side —
 * both starting at 1 — would be two threads with one key. These open
 * both kinds in both orders, and move a project whose thread exists.
 */
describe("thread keys on a desktop holding both kinds of project", () => {
  async function bothOpen(first: "kept" | "organisation") {
    const kept = createProject(anna.handle.db, { name: "Mine", keyPrefix: "MINE" });
    const theirs = await organisationProject();
    const open = (which: "kept" | "organisation") => anna.record.projectThread(which === "kept" ? kept.id : theirs);

    const one = await open(first);
    const two = await open(first === "kept" ? "organisation" : "kept");

    const [keptAnswer, theirAnswer] = first === "kept" ? [one, two] : [two, one];
    expect(keptAnswer.ok && theirAnswer.ok).toBe(true);
    if (!keptAnswer.ok || !theirAnswer.ok) return;
    expect(keptAnswer.item).toMatchObject({ key: "MINE-NOTES", projectId: kept.id });
    expect(theirAnswer.item).toMatchObject({ key: "SUP-NOTES", projectId: theirs });
    expect(findProjectThread(recordDb.db, theirs)?.id).toBe(theirAnswer.item.id);
    // …and both are still the answer, from the replica, on the next ask.
    expect((await open("kept")).ok && (await open("organisation")).ok).toBe(true);
  }

  it("opens a kept project's notes and then an organisation project's", async () => {
    await bothOpen("kept");
  });

  it("opens an organisation project's notes and then a kept project's", async () => {
    await bothOpen("organisation");
  });

  it("carries a thread made here to the record when the project moves, and the record answers with it", async () => {
    const project = createProject(anna.handle.db, { name: "Mine", keyPrefix: "MINE" });
    const made = await anna.record.projectThread(project.id);
    if (!made.ok) throw new Error(made.problem);

    const moved = await moveProjectToRecord({
      db: anna.handle.db,
      projectId: project.id,
      personId: annaPersonId,
      personName: "Anna",
      send: async (request) => {
        const served = (await serveAdopt(serving, {
          deviceId: annaDeviceId,
          project: request.project,
          keyNextValue: request.keyNextValue,
          final: request.final,
          abandon: request.abandon,
          page: request.page,
        })) as { accepted: RecordAdoptCounts; problem: string | null };
        return served.problem !== null ? { ok: false, problem: served.problem } : { ok: true, accepted: served.accepted };
      },
    });
    if (!moved.ok) throw new Error(moved.problem);

    // The record has the same thread, under the same key, and does not
    // make a second when asked.
    expect(findProjectThread(recordDb.db, project.id)).toMatchObject({ id: made.item.id, key: "MINE-NOTES" });
    const asked = await serveProjectThread(serving, { projectId: project.id });
    expect(asked.item?.id).toBe(made.item.id);
    expect(listItemsForProject(recordDb.db, project.id).filter(isProjectThread)).toHaveLength(1);

    // Another desktop, holding a thread of its own project, takes it
    // down beside that one and opens it.
    const its = createProject(laptop.handle.db, { name: "Laptop's", keyPrefix: "LAP" });
    const own = await laptop.record.projectThread(its.id);
    await laptop.record.sync();
    const opened = await laptop.record.projectThread(project.id);
    expect(own.ok && opened.ok).toBe(true);
    if (!own.ok || !opened.ok) return;
    expect(opened.item).toMatchObject({ id: made.item.id, key: "MINE-NOTES" });
    expect(own.item.key).toBe("LAP-NOTES");
  });
});
