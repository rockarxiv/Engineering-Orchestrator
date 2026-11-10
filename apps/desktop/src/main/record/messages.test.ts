import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HANDLED_MESSAGE_RETENTION_MS, type IpcPayload, type Message, type MessageSend, type Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AttachmentStorage } from "../attachments/storage.js";
import type { DbHandle } from "../db/client.js";
import { issueDevice } from "../db/repos/devicesRepo.js";
import { createPerson } from "../db/repos/peopleRepo.js";
import { createProject, getMessage, getProject, listOpenMessages, markMessageHandled, sweepHandledMessages } from "../db/repos/index.js";
import { setSetting } from "../db/repos/settingsRepo.js";
import { messages } from "../db/schema.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { MANAGED_PERSON_ID_KEY } from "../identity/viewer.js";
import { clearPublishedView } from "../ipc/currentView.js";
import { listInbox } from "../ipc/domainQueries.js";
import { clearHandlerRegistry, dispatchIpc } from "../ipc/registry.js";
import { fakePlatform } from "../testing/platform.js";
import { createDeviceRecord, type DeviceRecord } from "./deviceRecord.js";
import { createLocalRecord } from "./localRecord.js";
import { serveChanges, serveHandleMessage, serveMessages, serveSendMessage, type ServeRecordContext } from "./serveRecord.js";
import type { RecordTransport } from "./syncStatus.js";

/**
 * Messages about a project the organisation's record holds (EO-726,
 * ARCHITECTURE.md §7.1).
 *
 * The record is where they live: sent there, one to each admin, pulled by
 * each recipient's desktops on a cursor of their own, and answered or
 * dismissed there, so a press on one of a person's desktops reaches the
 * others. These look at the record's own table for what was written and
 * at each desktop's for what it was given.
 */

interface Desktop {
  handle: DbHandle;
  record: DeviceRecord;
  online: boolean;
}

let recordDb: DbHandle;
let serving: ServeRecordContext;
let root: string;
let annaId: Uuid;
let benId: Uuid;
let carlId: Uuid;
/** Anna's two desktops, Ben's one — both admins — and Carl's, who is not one. */
let annaDesk: Desktop;
let annaLaptop: Desktop;
let ben: Desktop;
let carl: Desktop;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "eo messages record "));
  recordDb = openMigratedTestDb();
  serving = {
    db: recordDb.db,
    record: createLocalRecord(recordDb.db),
    attachments: new AttachmentStorage(join(root, "record-files")),
    offerWork: async () => [],
  };
  annaId = createPerson(recordDb.db, { name: "Anna", email: "anna@example.com", isAdmin: true }).id;
  benId = createPerson(recordDb.db, { name: "Ben", email: "ben@example.com", isAdmin: true }).id;
  carlId = createPerson(recordDb.db, { name: "Carl", email: "carl@example.com" }).id;
  annaDesk = desktop(annaId, "anna-desk");
  annaLaptop = desktop(annaId, "anna-laptop");
  ben = desktop(benId, "ben-desk");
  carl = desktop(carlId, "carl-desk");
});

afterEach(() => {
  clearHandlerRegistry();
  clearPublishedView();
  for (const machine of [annaDesk, annaLaptop, ben, carl]) {
    machine.record.stop();
    machine.handle.close();
  }
  recordDb.close();
  rmSync(root, { recursive: true, force: true });
});

/** A desktop signed in as this person, its device known to the record, its door stamping that device as the server's does. */
function desktop(personId: Uuid, name: string): Desktop {
  const deviceId = issueDevice(recordDb.db, { personId, name, tokenHash: `hash-${name}`, secretsKeyHash: null }).id;
  const handle = openMigratedTestDb();
  setSetting(handle.db, MANAGED_PERSON_ID_KEY, personId);
  const machine: Desktop = { handle, online: true, record: undefined as unknown as DeviceRecord };
  const transport: RecordTransport = {
    async request(channel, payload) {
      if (!machine.online) return { ok: false, error: { message: "EO could not reach https://eo.example: fetch failed" } };
      switch (channel) {
        case "record:changes":
          return { ok: true, data: serveChanges(serving, payload as IpcPayload<"record:changes">) as never };
        case "record:sendMessage":
          return { ok: true, data: serveSendMessage(serving, { ...(payload as IpcPayload<"record:sendMessage">), deviceId }) as never };
        case "record:handleMessage":
          return { ok: true, data: serveHandleMessage(serving, { ...(payload as IpcPayload<"record:handleMessage">), deviceId }) as never };
        case "record:messages":
          return { ok: true, data: serveMessages(serving, { ...(payload as IpcPayload<"record:messages">), deviceId }) as never };
        default:
          return { ok: false, error: { message: `EO has no channel called "${channel}".` } };
      }
    },
  };
  machine.record = createDeviceRecord({ db: handle.db, deviceId: () => deviceId, transport: () => transport, pullPageSize: 3 });
  return machine;
}

async function syncAll(): Promise<void> {
  for (const machine of [annaDesk, annaLaptop, ben, carl]) await machine.record.sync();
}

/** A project on the record, pulled down to every desktop. */
async function organisationProject(): Promise<Uuid> {
  const project = createProject(recordDb.db, { name: "Support", keyPrefix: "SUP", managed: true });
  await syncAll();
  for (const machine of [annaDesk, annaLaptop, ben, carl]) {
    if (getProject(machine.handle.db, project.id) === undefined) throw new Error("the project did not reach a desktop");
  }
  return project.id;
}

function question(projectId: Uuid, recipientId: string): MessageSend {
  return {
    recipientId,
    projectId,
    source: "template_conflict",
    body: "The template update could not be applied.",
    options: ["Keep mine", "Take theirs"],
  };
}

function onTheRecord(): Message[] {
  return recordDb.db
    .select()
    .from(messages)
    .all()
    .map((row) => getMessage(recordDb.db, row.id))
    .filter((message): message is Message => message !== undefined);
}

function heldOn(machine: Desktop): string[] {
  return machine.handle.db
    .select({ id: messages.id })
    .from(messages)
    .all()
    .map((row) => row.id);
}

describe("a message about a project the organisation's record holds", () => {
  it("is written on the record, one to each admin, and never only on the desktop that sent it", async () => {
    const projectId = await organisationProject();

    const sent = await carl.record.sendMessage(question(projectId, "whoever-carl-is-here"));

    expect(sent).toEqual({ ok: true, messages: [] });
    const written = onTheRecord();
    expect(written.map((message) => message.recipientId).sort()).toEqual([annaId, benId].sort());
    expect(written.every((message) => message.projectId === projectId && message.handledAt === null)).toBe(true);
    // Carl is not an admin: nothing for him, here or on his desktop.
    expect(heldOn(carl)).toEqual([]);
  });

  it("is kept at once on a recipient's desktop that sent it, as the record's own copy", async () => {
    const projectId = await organisationProject();

    const sent = await annaDesk.record.sendMessage(question(projectId, "local"));

    expect(sent.ok).toBe(true);
    const annas = onTheRecord().find((message) => message.recipientId === annaId);
    expect(sent.ok && sent.messages.map((message) => message.id)).toEqual([annas?.id]);
    expect(heldOn(annaDesk)).toEqual([annas?.id]);
  });

  it("reaches each recipient's desktops through the sync and their Inbox, and no other desktop", async () => {
    const projectId = await organisationProject();
    await carl.record.sendMessage(question(projectId, "local"));

    await syncAll();

    const annas = onTheRecord().find((message) => message.recipientId === annaId);
    const bens = onTheRecord().find((message) => message.recipientId === benId);
    for (const machine of [annaDesk, annaLaptop]) {
      expect(listInbox(machine.handle.db).messages.map((message) => message.id)).toEqual([annas?.id]);
      expect(listInbox(machine.handle.db).summary.openCount).toBe(1);
    }
    expect(listInbox(ben.handle.db).messages.map((message) => message.id)).toEqual([bens?.id]);
    expect(heldOn(carl)).toEqual([]);
    expect(listInbox(carl.handle.db).messages).toEqual([]);
  });

  it("is answered on the record when a person answers on a desktop, and the change reaches their other desktop", async () => {
    const projectId = await organisationProject();
    await carl.record.sendMessage(question(projectId, "local"));
    await syncAll();
    const annas = onTheRecord().find((message) => message.recipientId === annaId) as Message;
    // Anna's desk answers its own channels with its device record, as the app does.
    const { registerAllHandlers } = await import("../ipc/handlers.js");
    registerAllHandlers(annaDesk.handle.db, undefined, { platform: fakePlatform(), record: annaDesk.record });

    const answered = await dispatchIpc("messages:answer", { messageId: annas.id, answer: "Take theirs" });

    expect(answered.ok).toBe(true);
    expect(getMessage(recordDb.db, annas.id)).toMatchObject({ handledHow: "answered", answer: "Take theirs" });
    expect(listInbox(annaDesk.handle.db).messages).toEqual([]);
    // The laptop still shows it until it syncs, and then does not.
    expect(listInbox(annaLaptop.handle.db).messages).toHaveLength(1);
    await annaLaptop.record.sync();
    expect(getMessage(annaLaptop.handle.db, annas.id)).toMatchObject({ handledHow: "answered", answer: "Take theirs" });
    expect(listInbox(annaLaptop.handle.db).messages).toEqual([]);
    // Ben's own copy is his to answer, and still open.
    expect(onTheRecord().find((message) => message.recipientId === benId)?.handledAt).toBeNull();
  });

  it("is dismissed on the record from a desktop, through the record", async () => {
    const projectId = await organisationProject();
    await carl.record.sendMessage(question(projectId, "local"));
    await syncAll();
    const bens = onTheRecord().find((message) => message.recipientId === benId) as Message;

    const dismissed = await ben.record.handleMessage({ messageId: bens.id, how: "dismissed", answer: null });

    expect(dismissed.ok).toBe(true);
    expect(getMessage(recordDb.db, bens.id)?.handledHow).toBe("dismissed");
    expect(getMessage(ben.handle.db, bens.id)?.handledHow).toBe("dismissed");
  });

  it("takes the record's word when the message was handled there first", async () => {
    const projectId = await organisationProject();
    await carl.record.sendMessage(question(projectId, "local"));
    await syncAll();
    const annas = onTheRecord().find((message) => message.recipientId === annaId) as Message;
    // Answered on the laptop; the desk has not synced since.
    await annaLaptop.record.handleMessage({ messageId: annas.id, how: "answered", answer: "Keep mine" });

    const late = await annaDesk.record.handleMessage({ messageId: annas.id, how: "dismissed", answer: null });

    expect(late.ok).toBe(false);
    expect(late.ok ? "" : late.problem).toMatch(/already answered/);
    expect(getMessage(annaDesk.handle.db, annas.id)).toMatchObject({ handledHow: "answered", answer: "Keep mine" });
  });

  it("cannot be handled by a desktop that is not its recipient's", async () => {
    const projectId = await organisationProject();
    await carl.record.sendMessage(question(projectId, "local"));
    const annas = onTheRecord().find((message) => message.recipientId === annaId) as Message;

    const asked = serveHandleMessage(serving, { deviceId: issueDevice(recordDb.db, { personId: benId, name: "ben-2", tokenHash: "x", secretsKeyHash: null }).id, messageId: annas.id, how: "dismissed", answer: null });

    expect(asked).toEqual({ message: null, problem: expect.stringMatching(/not one of yours/) });
    expect(getMessage(recordDb.db, annas.id)?.handledAt).toBeNull();
  });

  it("is not sent, here or there, when the record cannot be reached — and the sender is told", async () => {
    const projectId = await organisationProject();
    annaDesk.online = false;

    const sent = await annaDesk.record.sendMessage(question(projectId, "local"));

    expect(sent.ok).toBe(false);
    expect(sent.ok ? "" : sent.problem).toMatch(/could not be reached/);
    expect(onTheRecord()).toEqual([]);
    expect(heldOn(annaDesk)).toEqual([]);
  });

  it("leaves a message open when the record cannot be reached to take the press", async () => {
    const projectId = await organisationProject();
    await carl.record.sendMessage(question(projectId, "local"));
    await syncAll();
    const annas = onTheRecord().find((message) => message.recipientId === annaId) as Message;
    annaDesk.online = false;

    const pressed = await annaDesk.record.handleMessage({ messageId: annas.id, how: "dismissed", answer: null });

    expect(pressed.ok).toBe(false);
    expect(getMessage(annaDesk.handle.db, annas.id)?.handledAt).toBeNull();
    expect(getMessage(recordDb.db, annas.id)?.handledAt).toBeNull();
  });

  it("pages through more messages than one pull carries", async () => {
    const projectId = await organisationProject();
    for (let index = 0; index < 7; index += 1) await carl.record.sendMessage(question(projectId, "local"));

    await annaDesk.record.sync();

    expect(listOpenMessages(annaDesk.handle.db, [annaId])).toHaveLength(7);
  });
});

describe("a message on the record itself", () => {
  it("goes to each admin without a round trip", async () => {
    const project = createProject(recordDb.db, { name: "Support", keyPrefix: "SUP", managed: true });
    const server = createDeviceRecord({ db: recordDb.db, deviceId: () => "server", transport: () => null, isTheRecord: true });
    try {
      const sent = await server.sendMessage(question(project.id, "local"));
      expect(sent.ok && sent.messages.map((message) => message.recipientId).sort()).toEqual([annaId, benId].sort());
    } finally {
      server.stop();
    }
  });
});

describe("a message on a desktop with no organisation in it", () => {
  it("is written in the desktop's own table, to the recipient it names, and the record never hears of it", async () => {
    const kept = createProject(annaDesk.handle.db, { name: "Mine", keyPrefix: "MINE" });

    const sent = await annaDesk.record.sendMessage(question(kept.id, annaId));

    expect(sent.ok && sent.messages.map((message) => message.recipientId)).toEqual([annaId]);
    expect(heldOn(annaDesk)).toHaveLength(1);
    expect(onTheRecord()).toEqual([]);
    const id = heldOn(annaDesk)[0] as string;
    expect(await annaDesk.record.handleMessage({ messageId: id, how: "dismissed", answer: null })).toMatchObject({ ok: true });
  });
});

describe("the record's retention", () => {
  async function handledOnTheRecord(count: number, handledAt: number): Promise<void> {
    const project = createProject(recordDb.db, { name: "Support", keyPrefix: "SUP", managed: true });
    for (let index = 0; index < count; index += 1) {
      serveSendMessage(serving, { deviceId: issueDevice(recordDb.db, { personId: carlId, name: `carl-${String(index)}`, tokenHash: `c${String(index)}`, secretsKeyHash: null }).id, message: question(project.id, "local") });
    }
    onTheRecord().forEach((message, index) => markMessageHandled(recordDb.db, message.id, "dismissed", null, handledAt + index));
  }

  it("deletes a handled message 7 days after it was handled, and keeps an open one", async () => {
    const project = createProject(recordDb.db, { name: "Support", keyPrefix: "SUP", managed: true });
    const asking = issueDevice(recordDb.db, { personId: carlId, name: "carl-2", tokenHash: "c2", secretsKeyHash: null }).id;
    serveSendMessage(serving, { deviceId: asking, message: question(project.id, "local") });
    const [handled, open] = onTheRecord() as [Message, Message];
    markMessageHandled(recordDb.db, handled.id, "dismissed", null, 1_000);

    expect(sweepHandledMessages(recordDb.db, 1_000 + HANDLED_MESSAGE_RETENTION_MS - 1)).toBe(0);
    expect(sweepHandledMessages(recordDb.db, 1_000 + HANDLED_MESSAGE_RETENTION_MS)).toBe(1);
    expect(onTheRecord().map((message) => message.id)).toEqual([open.id]);
  });

  it("keeps at most 100 handled messages per person, the oldest handled going first", async () => {
    await handledOnTheRecord(101, 10_000);
    const annasOldest = onTheRecord()
      .filter((message) => message.recipientId === annaId)
      .sort((a, b) => (a.handledAt ?? 0) - (b.handledAt ?? 0))[0] as Message;

    expect(sweepHandledMessages(recordDb.db, 10_000)).toBe(2);

    expect(onTheRecord().filter((message) => message.recipientId === annaId)).toHaveLength(100);
    expect(onTheRecord().filter((message) => message.recipientId === benId)).toHaveLength(100);
    expect(getMessage(recordDb.db, annasOldest.id)).toBeUndefined();
  });
});
