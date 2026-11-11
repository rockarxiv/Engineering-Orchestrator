import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { specFields, type IpcPayload, type SpecFieldDraft, type Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AttachmentStorage } from "../attachments/storage.js";
import type { DbHandle } from "../db/client.js";
import { issueDevice } from "../db/repos/devicesRepo.js";
import { createPerson } from "../db/repos/peopleRepo.js";
import { createProject } from "../db/repos/index.js";
import { getItemType, itemTypesFor, listItemTypes, type ItemType } from "../db/repos/itemTypesRepo.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { createDeviceRecord, type DeviceRecord } from "./deviceRecord.js";
import { createLocalRecord } from "./localRecord.js";
import { serveChanges, serveUpdateItemType, UPDATE_ITEM_TYPE_NOT_AN_ADMIN, type ServeRecordContext } from "./serveRecord.js";
import type { RecordTransport } from "./syncStatus.js";

/**
 * A project's own fields on a pack's type, where the organisation's
 * record holds the project (EO-735).
 *
 * The type is the record's: a desktop asks the record to change it, the
 * record judges it against its own items and writes it, the asking
 * desktop copies the answer, and every other desktop takes it on its
 * next pull — so their forms and modules read the same shape.
 */

interface Desktop {
  handle: DbHandle;
  record: DeviceRecord;
  online: boolean;
}

let recordDb: DbHandle;
let serving: ServeRecordContext;
let anna: Desktop;
let ben: Desktop;
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "eo item type record "));
  recordDb = openMigratedTestDb();
  serving = { db: recordDb.db, record: createLocalRecord(recordDb.db), attachments: new AttachmentStorage(join(root, "record-files")), offerWork: async () => [] };
  const admin = createPerson(recordDb.db, { name: "Anna", email: "anna@example.com", isAdmin: true });
  const member = createPerson(recordDb.db, { name: "Ben", email: "ben@example.com" });
  anna = desktop(openMigratedTestDb(), issueDevice(recordDb.db, { personId: admin.id, name: "anna-desk", tokenHash: "h1", secretsKeyHash: null }).id);
  ben = desktop(openMigratedTestDb(), issueDevice(recordDb.db, { personId: member.id, name: "ben-desk", tokenHash: "h2", secretsKeyHash: null }).id);
});

afterEach(() => {
  for (const machine of [anna, ben]) {
    machine.record.stop();
    machine.handle.close();
  }
  recordDb.close();
  rmSync(root, { recursive: true, force: true });
});

function desktop(handle: DbHandle, deviceId: string): Desktop {
  const machine: Desktop = { handle, online: true, record: undefined as unknown as DeviceRecord };
  const transport: RecordTransport = {
    async request(channel, payload) {
      if (!machine.online) return { ok: false, error: { message: "EO could not reach https://eo.example: fetch failed" } };
      // Stamped at the server's door with the device the credential is for.
      if (channel === "record:updateItemType") {
        return { ok: true, data: (await serveUpdateItemType(serving, { ...(payload as IpcPayload<"record:updateItemType">), deviceId })) as never };
      }
      if (channel === "record:changes") return { ok: true, data: serveChanges(serving, payload as IpcPayload<"record:changes">) as never };
      return { ok: false, error: { message: `EO has no channel called "${channel}".` } };
    },
  };
  machine.record = createDeviceRecord({ db: handle.db, deviceId: () => deviceId, transport: () => transport, pullPageSize: 500 });
  return machine;
}

const AUTOMERGE: SpecFieldDraft = { name: "automerge", kind: "boolean", required: false };

/** The pack's story type on a project the record holds, pulled down to both desktops. */
async function organisationType(): Promise<{ projectId: Uuid; type: ItemType }> {
  const project = createProject(recordDb.db, { name: "Support", keyPrefix: "SUP", managed: true });
  const type = listItemTypes(recordDb.db, project.id).find((row) => row.packSlug === "developer" && row.slug === "story")!;
  await anna.record.sync();
  await ben.record.sync();
  if (getItemType(anna.handle.db, type.id) === undefined || getItemType(ben.handle.db, type.id) === undefined) throw new Error("the type did not reach the desktops");
  return { projectId: project.id, type };
}

function withField(type: ItemType, ...added: SpecFieldDraft[]): IpcPayload<"itemTypes:update"> {
  const own = specFields(type.specShape)
    .filter((field) => !field.added)
    .map(({ name, kind, required }) => ({ name, kind, required }));
  return { id: type.id, fields: [...own, ...added] };
}

const addedOn = (handle: DbHandle, id: Uuid): string[] =>
  specFields(getItemType(handle.db, id)!.specShape)
    .filter((field) => field.added)
    .map((field) => field.name);

describe("an added field on a type the organisation's record holds", () => {
  it("is written by the record, copied into the asking desktop, and reaches another desktop on its next pull", async () => {
    const { projectId, type } = await organisationType();

    const answer = await anna.record.updateItemType(withField(type, AUTOMERGE));

    expect(answer.problem).toBeNull();
    expect(addedOn(recordDb, type.id)).toEqual(["automerge"]);
    expect(addedOn(anna.handle, type.id)).toEqual(["automerge"]);
    expect(answer.type?.specShape.properties).toHaveProperty("automerge");

    // Ben held the type already; the edit pages to him again.
    expect(addedOn(ben.handle, type.id)).toEqual([]);
    await ben.record.sync();
    expect(addedOn(ben.handle, type.id)).toEqual(["automerge"]);
    // What his forms and the hand-over doors read.
    expect(itemTypesFor(ben.handle.db, projectId).get("developer:story")!.specShape.properties).toHaveProperty("automerge");
  });

  it("is refused for a device whose person is not an admin, and nothing changes anywhere", async () => {
    const { type } = await organisationType();

    const answer = await ben.record.updateItemType(withField(type, AUTOMERGE));

    expect(answer.type).toBeNull();
    expect(answer.problem).toContain(UPDATE_ITEM_TYPE_NOT_AN_ADMIN);
    expect(addedOn(recordDb, type.id)).toEqual([]);
    expect(addedOn(ben.handle, type.id)).toEqual([]);
  });

  it("changes nothing when the record cannot be reached, and says so", async () => {
    const { type } = await organisationType();
    anna.online = false;

    const answer = await anna.record.updateItemType(withField(type, AUTOMERGE));

    expect(answer.type).toBeNull();
    expect(answer.problem).toContain("could not be reached, so it was not changed");
    expect(addedOn(anna.handle, type.id)).toEqual([]);
    expect(addedOn(recordDb, type.id)).toEqual([]);
  });

  it("is judged against the record's items: a field one of them holds a value for is not removed", async () => {
    const { projectId, type } = await organisationType();
    await anna.record.updateItemType(withField(type, AUTOMERGE));
    // Filed on the record, and not yet pulled to Anna's desktop.
    createTestItem(recordDb.db, { type: "story", title: "Merges itself", stepId: "todo", projectId, spec: { acceptance_criteria: ["It merges"], automerge: false } });

    const answer = await anna.record.updateItemType(withField(getItemType(anna.handle.db, type.id)!));

    expect(answer.type).toBeNull();
    expect(answer.problem).toContain("1 story holds a value for “automerge”");
    expect(addedOn(recordDb, type.id)).toEqual(["automerge"]);
  });

  it("stays this desktop's own on a project it keeps", async () => {
    const project = createProject(anna.handle.db, { name: "Mine", keyPrefix: "MINE" });
    const type = listItemTypes(anna.handle.db, project.id).find((row) => row.packSlug === "developer" && row.slug === "story")!;

    const answer = await anna.record.updateItemType(withField(type, AUTOMERGE));

    expect(answer.problem).toBeNull();
    expect(addedOn(anna.handle, type.id)).toEqual(["automerge"]);
    expect(getItemType(recordDb.db, type.id)).toBeUndefined();
  });
});
