import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HANDLED_MESSAGE_RETENTION_MS, notADesktopRefusal, type IpcPayload, type Job, type Message, type MessageSend, type Uuid } from "@eo/core";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AttachmentStorage } from "../attachments/storage.js";
import type { DbHandle } from "../db/client.js";
import { issueDevice } from "../db/repos/devicesRepo.js";
import { createPerson } from "../db/repos/peopleRepo.js";
import {
  createProject,
  getItem,
  getJob,
  getMessage,
  getProject,
  insertMessage,
  listOccurrences,
  listOpenMessages,
  markMessageHandled,
  pendingCommands,
  recordOccurrence,
  sweepHandledMessages,
} from "../db/repos/index.js";
import { getSetting, setSetting } from "../db/repos/settingsRepo.js";
import { jobs, messages, projects } from "../db/schema.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { MANAGED_PERSON_ID_KEY } from "../identity/viewer.js";
import { clearPublishedView } from "../ipc/currentView.js";
import { listInbox } from "../ipc/domainQueries.js";
import { clearHandlerRegistry, dispatchIpc } from "../ipc/registry.js";
import { RUN_NOW_OPTION } from "../jobs/answer.js";
import { pauseForBudget } from "../jobs/budget.js";
import { catchUpJob } from "../jobs/catchUp.js";
import { createJob } from "../jobs/jobs.js";
import { JOB_MESSAGE_SOURCE } from "../jobs/ownerMessage.js";
import { answerToolCall } from "../mcpHost/server.js";
import { fakePlatform } from "../testing/platform.js";
import { createDeviceRecord, type DeviceRecord } from "./deviceRecord.js";
import { createLocalRecord } from "./localRecord.js";
import { serveApply, serveChanges, serveHandleMessage, serveMessages, serveSendMessage, type ServeRecordContext } from "./serveRecord.js";
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
  /** Whether the record it talks to is older than `record:handleMessageFor` (EO-918). */
  olderRecord: boolean;
  /** Whether the record fails a press on its side, as a failed write answers (EO-918). */
  faultyRecord: boolean;
  /** Whether the record's door refuses this desktop's sign-in a delegated press, as one without a secrets key is (EO-918). */
  legacySignIn: boolean;
  /** Whether the desktop has signed out of the organisation: no record to ask at all (EO-918). */
  signedOut: boolean;
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
  const machine: Desktop = { handle, online: true, olderRecord: false, faultyRecord: false, legacySignIn: false, signedOut: false, record: undefined as unknown as DeviceRecord };
  const transport: RecordTransport = {
    async request(channel, payload) {
      if (!machine.online) return { ok: false, error: { message: "EO could not reach https://eo.example: fetch failed" } };
      switch (channel) {
        case "record:changes":
          return { ok: true, data: serveChanges(serving, payload as IpcPayload<"record:changes">) as never };
        case "record:apply":
          return { ok: true, data: (await serveApply(serving, { ...(payload as IpcPayload<"record:apply">), deviceId })) as never };
        case "record:sendMessage":
          return { ok: true, data: serveSendMessage(serving, { ...(payload as IpcPayload<"record:sendMessage">), deviceId }) as never };
        case "record:handleMessage":
          if (machine.faultyRecord) return { ok: false, error: { message: "Internal error" } };
          return { ok: true, data: serveHandleMessage(serving, { ...(payload as IpcPayload<"record:handleMessage">), deviceId }) as never };
        case "record:handleMessageFor":
          // What a record from before EO-918 answers a channel its contract has no entry for (server/http.ts, a 404).
          if (machine.olderRecord) return { ok: false, error: { message: `EO has no channel called "${channel}".` } };
          // What server/http.ts answers a sign-in it does not know runs work.
          if (machine.legacySignIn) return notADesktopRefusal(channel);
          if (machine.faultyRecord) return { ok: false, error: { message: "Internal error" } };
          return { ok: true, data: serveHandleMessage(serving, { ...(payload as IpcPayload<"record:handleMessageFor">), deviceId }) as never };
        case "record:messages":
          return { ok: true, data: serveMessages(serving, { ...(payload as IpcPayload<"record:messages">), deviceId }) as never };
        default:
          return { ok: false, error: { message: `EO has no channel called "${channel}".` } };
      }
    },
  };
  machine.record = createDeviceRecord({ db: handle.db, deviceId: () => deviceId, transport: () => (machine.signedOut ? null : transport), pullPageSize: 3 });
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

/** 0184's own backfill, as the migration file has it — everything after the ALTER that adds the column. */
const BACKFILL_0184 = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../db/migrations/0184_message_from_record.sql"), "utf8").split("--> statement-breakpoint")[1] as string;

/**
 * A desktop as a build from before 0183 left it, then upgraded (EO-918):
 * its messages cursor in the shape kept then, who handled each message
 * dropped as that build's pull dropped it, and where each lives as the
 * migration decides it — null from the ALTER, then 0184's own backfill.
 */
function upgradeFromBefore0183(machine: Desktop): void {
  const cursor = getSetting<Record<string, unknown>>(machine.handle.db, "record.messagesCursor", {});
  if (cursor.ts !== undefined) setSetting(machine.handle.db, "record.messagesCursor", { ts: cursor.ts, id: cursor.id, deviceId: cursor.deviceId });
  machine.handle.db.update(messages).set({ handledBy: null }).run();
  machine.handle.db.update(messages).set({ fromRecord: null }).run();
  machine.handle.db.run(sql.raw(BACKFILL_0184));
}

function fromRecordOn(machine: Desktop, id: string): boolean | null | undefined {
  return machine.handle.db.select({ fromRecord: messages.fromRecord }).from(messages).where(eq(messages.id, id)).get()?.fromRecord;
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

  it("is answered and dismissed on the record through EO's MCP tools, through ItemRecord.handleMessage, saying who pressed (EO-918)", async () => {
    const projectId = await organisationProject();
    await carl.record.sendMessage(question(projectId, "local"));
    await carl.record.sendMessage(question(projectId, "local"));
    await syncAll();
    const [first, second] = onTheRecord().filter((message) => message.recipientId === annaId) as [Message, Message];
    const { registerAllHandlers } = await import("../ipc/handlers.js");
    registerAllHandlers(annaDesk.handle.db, undefined, { platform: fakePlatform(), record: annaDesk.record });
    const handled = vi.spyOn(annaDesk.record, "handleMessage");

    const answered = await answerToolCall({ name: "message_answer", arguments: { messageId: first.id, answer: "Take theirs" } }, "external", false);
    const dismissed = await answerToolCall({ name: "message_dismiss", arguments: { messageId: second.id } }, "admin", false, undefined, undefined, "the-assistant");

    expect([answered.isError, dismissed.isError]).toEqual([false, false]);
    expect(handled.mock.calls.map(([request]) => request)).toEqual([
      expect.objectContaining({ messageId: first.id, how: "answered", answer: "Take theirs", by: { kind: "mcp_client" } }),
      expect.objectContaining({ messageId: second.id, how: "dismissed", by: { kind: "assistant", agentId: "the-assistant" } }),
    ]);
    expect(getMessage(recordDb.db, first.id)).toMatchObject({ handledHow: "answered", answer: "Take theirs", handledBy: { kind: "mcp_client" } });
    expect(getMessage(recordDb.db, second.id)).toMatchObject({ handledHow: "dismissed", handledBy: { kind: "assistant", agentId: "the-assistant" } });
    // And the other desktop hears who it was.
    await annaLaptop.record.sync();
    expect(getMessage(annaLaptop.handle.db, first.id)?.handledBy).toEqual({ kind: "mcp_client" });
    expect(getMessage(annaLaptop.handle.db, second.id)?.handledBy).toEqual({ kind: "assistant", agentId: "the-assistant" });
  });

  it("is left open by a record older than who pressed, rather than closed as the person's press (EO-918)", async () => {
    const projectId = await organisationProject();
    await carl.record.sendMessage(question(projectId, "local"));
    await carl.record.sendMessage(question(projectId, "local"));
    await syncAll();
    const [first, second] = onTheRecord().filter((message) => message.recipientId === annaId) as [Message, Message];
    const { registerAllHandlers } = await import("../ipc/handlers.js");
    registerAllHandlers(annaDesk.handle.db, undefined, { platform: fakePlatform(), record: annaDesk.record });
    annaDesk.olderRecord = true;

    const byClient = await answerToolCall({ name: "message_answer", arguments: { messageId: first.id, answer: "Take theirs" } }, "external", false);
    const byAssistant = await answerToolCall({ name: "message_dismiss", arguments: { messageId: second.id } }, "admin", false, undefined, undefined, "the-assistant");

    // Refused in words, and nothing closed — on the record or on the desktop.
    for (const refused of [byClient, byAssistant]) {
      expect(refused.isError).toBe(false);
      expect(JSON.stringify(refused.content)).toContain("did not take this press");
    }
    expect([getMessage(recordDb.db, first.id)?.handledAt, getMessage(recordDb.db, second.id)?.handledAt]).toEqual([null, null]);
    expect([getMessage(annaDesk.handle.db, first.id)?.handledAt, getMessage(annaDesk.handle.db, second.id)?.handledAt]).toEqual([null, null]);

    // The person's own press still goes on the channel every record takes.
    const pressed = await annaDesk.record.handleMessage({ messageId: first.id, how: "answered", answer: "Take theirs", by: { kind: "person" } });
    expect(pressed.ok).toBe(true);
    expect(getMessage(recordDb.db, first.id)).toMatchObject({ handledHow: "answered", handledBy: { kind: "person" } });
  });

  it("says only that its press was not taken when an older record refuses it on a copy handled elsewhere since (EO-918)", async () => {
    const projectId = await organisationProject();
    await carl.record.sendMessage(question(projectId, "local"));
    await syncAll();
    const mine = onTheRecord().find((message) => message.recipientId === annaId) as Message;
    // Answered from the laptop; the desk has not synced, so its copy is still open.
    const fromLaptop = await annaLaptop.record.handleMessage({ messageId: mine.id, how: "answered", answer: "Keep mine", by: { kind: "person" } });
    expect(fromLaptop.ok).toBe(true);
    expect(getMessage(annaDesk.handle.db, mine.id)?.handledAt).toBeNull();
    const { registerAllHandlers } = await import("../ipc/handlers.js");
    registerAllHandlers(annaDesk.handle.db, undefined, { platform: fakePlatform(), record: annaDesk.record });
    annaDesk.olderRecord = true;

    const refused = await answerToolCall({ name: "message_answer", arguments: { messageId: mine.id, answer: "Take theirs" } }, "external", false);

    expect(refused.isError).toBe(false);
    const said = JSON.stringify(refused.content);
    expect(said).toContain("did not take this press");
    // Never a claim about where the message stands, which this desk does not know.
    expect(said).not.toContain("still open");
    expect(said).toContain("may already have been handled");
    expect(getMessage(recordDb.db, mine.id)).toMatchObject({ handledHow: "answered", answer: "Keep mine", handledBy: { kind: "person" } });
  });

  it("is read again once by a desktop whose cursor went past a delegated press before it kept who handled it (EO-918)", async () => {
    const projectId = await organisationProject();
    await carl.record.sendMessage(question(projectId, "local"));
    await syncAll();
    const mine = onTheRecord().find((message) => message.recipientId === annaId) as Message;
    markMessageHandled(recordDb.db, mine.id, "answered", "Take theirs", Date.now() + 1_000, { kind: "assistant", agentId: "the-assistant" });
    await annaLaptop.record.sync();
    expect(getMessage(annaLaptop.handle.db, mine.id)?.handledBy).toEqual({ kind: "assistant", agentId: "the-assistant" });

    // The laptop as it stood before 0183: the press pulled with who
    // dropped, and its cursor past it in the shape it kept then.
    const cursor = getSetting<Record<string, unknown>>(annaLaptop.handle.db, "record.messagesCursor", {});
    setSetting(annaLaptop.handle.db, "record.messagesCursor", { ts: cursor.ts, id: cursor.id, deviceId: cursor.deviceId });
    annaLaptop.handle.db.update(messages).set({ handledBy: null }).where(eq(messages.id, mine.id)).run();
    // What the Inbox and inbox_list would say for good: the person's press.
    expect(getMessage(annaLaptop.handle.db, mine.id)?.handledBy).toEqual({ kind: "person" });

    await annaLaptop.record.sync();
    expect(getMessage(annaLaptop.handle.db, mine.id)?.handledBy).toEqual({ kind: "assistant", agentId: "the-assistant" });

    // Once: the cursor it keeps now is trusted, so the next pull starts where it stopped.
    annaLaptop.handle.db.update(messages).set({ handledBy: null }).where(eq(messages.id, mine.id)).run();
    await annaLaptop.record.sync();
    expect(getMessage(annaLaptop.handle.db, mine.id)?.handledBy).toEqual({ kind: "person" });
  });

  it("is not left reading as the person's on an upgraded desktop when the record swept the delegated press while it was away (EO-918)", async () => {
    const projectId = await organisationProject();
    await carl.record.sendMessage(question(projectId, "local"));
    await carl.record.sendMessage(question(projectId, "local"));
    await syncAll();
    const [delegatedPress, ownPress] = onTheRecord().filter((message) => message.recipientId === annaId) as [Message, Message];
    const at = Date.now() + 1_000;
    markMessageHandled(recordDb.db, delegatedPress.id, "answered", "Take theirs", at, { kind: "assistant", agentId: "the-assistant" });
    await annaLaptop.record.sync();

    // The laptop as it stood before 0183: the press pulled with who
    // dropped, and its cursor past it in the shape it kept then.
    const cursor = getSetting<Record<string, unknown>>(annaLaptop.handle.db, "record.messagesCursor", {});
    setSetting(annaLaptop.handle.db, "record.messagesCursor", { ts: cursor.ts, id: cursor.id, deviceId: cursor.deviceId });
    annaLaptop.handle.db.update(messages).set({ handledBy: null }).where(eq(messages.id, delegatedPress.id)).run();
    expect(listInbox(annaLaptop.handle.db, projectId).handledMessages.map((message) => message.handledBy)).toEqual([{ kind: "person" }]);

    // While it is away, a press from before who was kept (the person's,
    // for nobody else could make one then), and the record's retention
    // takes the delegated press and leaves that one.
    markMessageHandled(recordDb.db, ownPress.id, "dismissed", null, at + HANDLED_MESSAGE_RETENTION_MS);
    recordDb.db.update(messages).set({ handledBy: null }).where(eq(messages.id, ownPress.id)).run();
    sweepHandledMessages(recordDb.db, at + HANDLED_MESSAGE_RETENTION_MS + 1);
    expect(getMessage(recordDb.db, delegatedPress.id)).toBeUndefined();

    await annaLaptop.record.sync();

    // Gone, as the record has it, rather than shown as Anna's press.
    expect(getMessage(annaLaptop.handle.db, delegatedPress.id)).toBeUndefined();
    const shown = listInbox(annaLaptop.handle.db, projectId).handledMessages;
    expect(shown.map((message) => [message.id, message.handledBy])).toEqual([[ownPress.id, { kind: "person" }]]);
  });

  it("is a fault, not a refusal, when the record fails the press on its side, and claims nothing when the record cannot be reached (EO-918)", async () => {
    const projectId = await organisationProject();
    await carl.record.sendMessage(question(projectId, "local"));
    await syncAll();
    const mine = onTheRecord().find((message) => message.recipientId === annaId) as Message;
    const { registerAllHandlers } = await import("../ipc/handlers.js");
    registerAllHandlers(annaDesk.handle.db, undefined, { platform: fakePlatform(), record: annaDesk.record });

    // A record that answered with an error: on the error path, never the
    // older-record guidance, whoever pressed.
    annaDesk.faultyRecord = true;
    const byClient = await answerToolCall({ name: "message_answer", arguments: { messageId: mine.id, answer: "Take theirs" } }, "external", false);
    const byAssistant = await answerToolCall({ name: "message_dismiss", arguments: { messageId: mine.id } }, "admin", false, undefined, undefined, "the-assistant");
    for (const failed of [byClient, byAssistant]) {
      expect(failed.isError).toBe(true);
      expect(JSON.stringify(failed.content)).not.toContain("older than this desktop");
    }
    await expect(annaDesk.record.handleMessage({ messageId: mine.id, how: "dismissed", answer: null, by: { kind: "person" } })).rejects.toThrow(
      "Your organisation's record did not take that: Internal error",
    );
    annaDesk.faultyRecord = false;

    // A record that could not be reached may have taken it before the line
    // went: said as not knowing, never as "still open".
    annaDesk.online = false;
    const unreached = await answerToolCall({ name: "message_answer", arguments: { messageId: mine.id, answer: "Take theirs" } }, "external", false);
    expect(unreached.isError).toBe(false);
    const said = JSON.stringify(unreached.content);
    expect(said).toContain("cannot say whether that was taken");
    expect(said).not.toContain("still open");
    expect(getMessage(recordDb.db, mine.id)?.handledAt).toBeNull();
  });

  it("tells the caller to sign the desktop in again when the record will not take who pressed from its sign-in, in a packaged build (EO-918)", async () => {
    const projectId = await organisationProject();
    await carl.record.sendMessage(question(projectId, "local"));
    await syncAll();
    const mine = onTheRecord().find((message) => message.recipientId === annaId) as Message;
    const { registerAllHandlers } = await import("../ipc/handlers.js");
    // A packaged build, where a fault reaches the caller only as "Internal error".
    registerAllHandlers(annaDesk.handle.db, undefined, { platform: fakePlatform({ isPackaged: true }), record: annaDesk.record });
    annaDesk.legacySignIn = true;

    const byClient = await answerToolCall({ name: "message_answer", arguments: { messageId: mine.id, answer: "Take theirs" } }, "external", false);
    const byAssistant = await answerToolCall({ name: "message_dismiss", arguments: { messageId: mine.id } }, "admin", false, undefined, undefined, "the-assistant");

    for (const refused of [byClient, byAssistant]) {
      expect(refused.isError).toBe(false);
      const said = JSON.stringify(refused.content);
      expect(said).not.toContain("Internal error");
      expect(said).toContain("Sign this desktop in to the organisation again");
      expect(said).not.toContain("still open");
    }
    expect(getMessage(recordDb.db, mine.id)?.handledAt).toBeNull();
    expect(getMessage(annaDesk.handle.db, mine.id)?.handledAt).toBeNull();
  });

  it("is answered on the record through EO's MCP tools when it is about a record-held job and so has no project (EO-918)", async () => {
    const aboutAJob = insertMessage(recordDb.db, { recipientId: annaId, source: JOB_MESSAGE_SOURCE.skipped, body: "Monday report skipped a Monday.", options: ["Run now", "Leave it"] });
    await annaDesk.record.sync();
    expect(getMessage(annaDesk.handle.db, aboutAJob.id)).toMatchObject({ projectId: null, handledAt: null });
    const { registerAllHandlers } = await import("../ipc/handlers.js");
    registerAllHandlers(annaDesk.handle.db, undefined, { platform: fakePlatform(), record: annaDesk.record });

    const answered = await answerToolCall({ name: "message_answer", arguments: { messageId: aboutAJob.id, answer: "Leave it" } }, "admin", false, undefined, undefined, "the-assistant");

    expect(answered.isError).toBe(false);
    // On the record, where it lives — not only on this desktop's copy.
    expect(getMessage(recordDb.db, aboutAJob.id)).toMatchObject({ handledHow: "answered", answer: "Leave it", handledBy: { kind: "assistant", agentId: "the-assistant" } });
    expect(getMessage(annaDesk.handle.db, aboutAJob.id)).toMatchObject({ handledHow: "answered", handledBy: { kind: "assistant", agentId: "the-assistant" } });
  });

  /** A message about a record-held job, as the record writes one — about no project — to Anna. */
  function jobMessageOnTheRecord(body: string, at: number = Date.now()): Message {
    return insertMessage(recordDb.db, { recipientId: annaId, source: JOB_MESSAGE_SOURCE.skipped, body, options: ["Run now", "Leave it"] }, at);
  }

  it("asks the record about an upgraded desktop's message it cannot place before its first pull, and answers it there with who pressed (EO-918)", async () => {
    const aboutAJob = jobMessageOnTheRecord("Monday report skipped a Monday.");
    await annaDesk.record.sync();
    upgradeFromBefore0183(annaDesk);
    // About no project, on a desktop that has pulled: 0184 cannot say whose it is.
    expect(fromRecordOn(annaDesk, aboutAJob.id)).toBeNull();
    const { registerAllHandlers } = await import("../ipc/handlers.js");
    registerAllHandlers(annaDesk.handle.db, undefined, { platform: fakePlatform(), record: annaDesk.record });

    // Before the desktop has pulled since the upgrade.
    const answered = await answerToolCall({ name: "message_answer", arguments: { messageId: aboutAJob.id, answer: "Leave it" } }, "admin", false, undefined, undefined, "the-assistant");

    expect(answered.isError).toBe(false);
    expect(getMessage(recordDb.db, aboutAJob.id)).toMatchObject({ handledHow: "answered", answer: "Leave it", handledBy: { kind: "assistant", agentId: "the-assistant" } });
    expect(getMessage(annaDesk.handle.db, aboutAJob.id)).toMatchObject({ handledHow: "answered", handledBy: { kind: "assistant", agentId: "the-assistant" } });
    expect(fromRecordOn(annaDesk, aboutAJob.id)).toBe(true);
  });

  it("answers an upgraded desktop's own message here once the record says it has none such, and refuses one it cannot ask about signed out (EO-918)", async () => {
    await annaDesk.record.sync();
    // Two of the desk's own, about no project — a usage limit's, say — written here before the upgrade.
    const limit = { recipientId: annaId, source: "runtime_limit", body: "Codex hit its plan limit.", options: ["Carry on now"] };
    const first = await annaDesk.record.sendMessage(limit);
    const second = await annaDesk.record.sendMessage(limit);
    if (!first.ok || !second.ok) throw new Error("the desk did not send its own messages");
    const [carryOn] = first.messages as [Message];
    const [later] = second.messages as [Message];
    upgradeFromBefore0183(annaDesk);
    expect(fromRecordOn(annaDesk, carryOn.id)).toBeNull();

    annaDesk.signedOut = true;
    const refused = await annaDesk.record.handleMessage({ messageId: later.id, how: "dismissed", answer: null });
    expect(refused.ok).toBe(false);
    expect(refused.ok ? "" : refused.problem).toContain("not signed in to the organisation");
    expect(getMessage(annaDesk.handle.db, later.id)?.handledAt).toBeNull();
    expect(fromRecordOn(annaDesk, later.id)).toBeNull();
    annaDesk.signedOut = false;

    // The record could not be reached: nothing is claimed, nothing is settled.
    annaDesk.online = false;
    const unreached = await annaDesk.record.handleMessage({ messageId: later.id, how: "dismissed", answer: null });
    expect(unreached.ok ? "" : unreached.problem).toContain("cannot tell whether this message is this desktop's own");
    expect(fromRecordOn(annaDesk, later.id)).toBeNull();
    annaDesk.online = true;

    const pressed = await annaDesk.record.handleMessage({ messageId: carryOn.id, how: "answered", answer: "Carry on now", by: { kind: "mcp_client" } });

    expect(pressed).toMatchObject({ ok: true, message: { handledHow: "answered", answer: "Carry on now", handledBy: { kind: "mcp_client" } } });
    expect(getMessage(annaDesk.handle.db, carryOn.id)).toMatchObject({ handledHow: "answered", handledBy: { kind: "mcp_client" } });
    expect(fromRecordOn(annaDesk, carryOn.id)).toBe(false);
    expect(onTheRecord()).toEqual([]);
  });

  it("keeps what an upgraded desktop's first full re-read did not name as its own, and clears a delegated press the record swept (EO-918)", async () => {
    const eightDaysAgo = Date.now() - HANDLED_MESSAGE_RETENTION_MS - 60_000;
    const swept = jobMessageOnTheRecord("Skipped one Monday.", eightDaysAgo);
    const kept = jobMessageOnTheRecord("Skipped another.");
    markMessageHandled(recordDb.db, swept.id, "answered", "Leave it", eightDaysAgo + 1_000, { kind: "mcp_client" });
    markMessageHandled(recordDb.db, kept.id, "dismissed", null, Date.now(), { kind: "assistant", agentId: "the-assistant" });
    await annaLaptop.record.sync();
    // And the laptop's own, about no project: one Anna answered, one open.
    const own = await annaLaptop.record.sendMessage({ recipientId: annaId, source: "runtime_limit", body: "Codex hit its plan limit.", options: ["Carry on now"] });
    const ownOpen = await annaLaptop.record.sendMessage({ recipientId: annaId, source: "runtime_limit", body: "Claude hit its plan limit.", options: ["Carry on now"] });
    if (!own.ok || !ownOpen.ok) throw new Error("the laptop did not send its own messages");
    const [answeredHere] = own.messages as [Message];
    const [openHere] = ownOpen.messages as [Message];
    markMessageHandled(annaLaptop.handle.db, answeredHere.id, "answered", "Carry on now", Date.now());
    // The record's retention takes the old press while the laptop runs the old build.
    sweepHandledMessages(recordDb.db);
    expect(getMessage(recordDb.db, swept.id)).toBeUndefined();
    upgradeFromBefore0183(annaLaptop);
    for (const id of [swept.id, kept.id, answeredHere.id, openHere.id]) expect(fromRecordOn(annaLaptop, id)).toBeNull();

    await annaLaptop.record.sync();

    // Not left reading as Anna's press.
    expect(getMessage(annaLaptop.handle.db, swept.id)).toBeUndefined();
    expect(getMessage(annaLaptop.handle.db, kept.id)?.handledBy).toEqual({ kind: "assistant", agentId: "the-assistant" });
    expect(fromRecordOn(annaLaptop, kept.id)).toBe(true);
    // Its own, kept and settled as its own.
    expect(getMessage(annaLaptop.handle.db, answeredHere.id)).toMatchObject({ handledHow: "answered", handledBy: { kind: "person" } });
    expect(getMessage(annaLaptop.handle.db, openHere.id)?.handledAt).toBeNull();
    expect(fromRecordOn(annaLaptop, answeredHere.id)).toBe(false);
    expect(fromRecordOn(annaLaptop, openHere.id)).toBe(false);
  });

  it("clears from an upgraded desktop a delegated press the record's 100-handled cap took, over a re-read longer than one pass (EO-918)", async () => {
    const capped = jobMessageOnTheRecord("Skipped one Monday.", Date.now() - 60_000);
    markMessageHandled(recordDb.db, capped.id, "answered", "Leave it", Date.now() - 50_000, { kind: "mcp_client" });
    await annaLaptop.record.sync();
    // A hundred more of Anna's handled after it while the laptop was away, so the record's cap takes it.
    for (let index = 0; index < 100; index += 1) {
      const later = jobMessageOnTheRecord(`Skipped Monday ${String(index)}.`, Date.now() - 40_000);
      markMessageHandled(recordDb.db, later.id, "dismissed", null, Date.now() - 30_000 + index);
    }
    sweepHandledMessages(recordDb.db);
    expect(getMessage(recordDb.db, capped.id)).toBeUndefined();
    upgradeFromBefore0183(annaLaptop);
    expect(fromRecordOn(annaLaptop, capped.id)).toBeNull();

    // A hundred at three a page is more than one pass reads.
    await annaLaptop.record.sync();
    expect(fromRecordOn(annaLaptop, capped.id)).toBeNull();
    await annaLaptop.record.sync();

    expect(getMessage(annaLaptop.handle.db, capped.id)).toBeUndefined();
  });

  it("keeps a desktop's own messages about a project it later moved, whatever the clocks say, and answers an open one there (EO-918)", async () => {
    // Anna's own project on her desk, with two messages EO sent there
    // before it moved: one she answered, one still open.
    const own = createProject(annaDesk.handle.db, { name: "Mine", keyPrefix: "MIN" });
    const answeredHere = await annaDesk.record.sendMessage(question(own.id, annaId));
    const openHere = await annaDesk.record.sendMessage(question(own.id, annaId));
    if (!answeredHere.ok || !openHere.ok) throw new Error("the desk did not send its own messages");
    const [answered] = answeredHere.messages as [Message];
    const [stillOpen] = openHere.messages as [Message];
    expect((await annaDesk.record.handleMessage({ messageId: answered.id, how: "answered", answer: "Keep mine" })).ok).toBe(true);
    // The project moves to the record — which copies no messages — and
    // the record's clock is behind the desk's: the move reads as earlier
    // than both messages were written.
    annaDesk.handle.db
      .update(projects)
      .set({ managedAt: Date.now() - 60 * 60_000 })
      .where(eq(projects.id, own.id))
      .run();
    // And a message the record sent about a project of its own, handled
    // by the assistant there and swept while the desk ran the old build.
    const fromTheRecord = await organisationProject();
    await carl.record.sendMessage(question(fromTheRecord, "local"));
    await annaDesk.record.sync();
    const copy = onTheRecord().find((message) => message.recipientId === annaId) as Message;
    const eightDaysAgo = Date.now() - HANDLED_MESSAGE_RETENTION_MS - 60_000;
    markMessageHandled(recordDb.db, copy.id, "answered", "Take theirs", eightDaysAgo, { kind: "assistant", agentId: "the-assistant" });
    // As the old build's pull wrote the press down, then.
    annaDesk.handle.db.update(messages).set({ handledAt: eightDaysAgo, handledHow: "answered", answer: "Take theirs" }).where(eq(messages.id, copy.id)).run();
    sweepHandledMessages(recordDb.db);
    upgradeFromBefore0183(annaDesk);
    for (const id of [answered.id, stillOpen.id, copy.id]) expect(fromRecordOn(annaDesk, id)).toBeNull();

    await annaDesk.record.sync();

    // Her own answer is her history, which no pull brings back: kept.
    expect(getMessage(annaDesk.handle.db, answered.id)).toMatchObject({ handledHow: "answered", answer: "Keep mine", handledBy: { kind: "person" } });
    // The record's copy it swept is gone, as on the record.
    expect(getMessage(annaDesk.handle.db, copy.id)).toBeUndefined();
    // And the open one is answered here, where it lives, not refused by a record that never had it.
    const pressed = await annaDesk.record.handleMessage({ messageId: stillOpen.id, how: "dismissed", answer: null, by: { kind: "mcp_client" } });
    expect(pressed.ok).toBe(true);
    expect(getMessage(annaDesk.handle.db, stillOpen.id)).toMatchObject({ handledHow: "dismissed", handledBy: { kind: "mcp_client" } });
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

/**
 * A desktop that was away while a message was handled elsewhere and then
 * swept by the record's retention (EO-726, review). The handled row never
 * pages again, so the desktop learns it from the record's open set.
 */
describe("a message the record swept while a recipient's desktop was away", () => {
  async function answeredAndSweptWhileTheLaptopWasAway(sweep: (handledAt: number) => void): Promise<Message> {
    const projectId = await organisationProject();
    await carl.record.sendMessage(question(projectId, "local"));
    await syncAll();
    const annas = onTheRecord().find((message) => message.recipientId === annaId) as Message;
    expect(listInbox(annaLaptop.handle.db).messages.map((message) => message.id)).toEqual([annas.id]);
    annaLaptop.online = false;
    const answered = await annaDesk.record.handleMessage({ messageId: annas.id, how: "answered", answer: "Keep mine" });
    if (!answered.ok) throw new Error(answered.problem);
    sweep(answered.message.handledAt as number);
    expect(getMessage(recordDb.db, annas.id)).toBeUndefined();
    annaLaptop.online = true;
    return annas;
  }

  it("leaves the Inbox of that desktop when it next syncs, after the 7 days", async () => {
    const annas = await answeredAndSweptWhileTheLaptopWasAway((handledAt) => sweepHandledMessages(recordDb.db, handledAt + HANDLED_MESSAGE_RETENTION_MS));

    await annaLaptop.record.sync();

    expect(getMessage(annaLaptop.handle.db, annas.id)).toBeUndefined();
    expect(listInbox(annaLaptop.handle.db).messages).toEqual([]);
    // Ben's own copy is still open on the record, and stays on his desktop.
    await ben.record.sync();
    expect(listInbox(ben.handle.db).messages).toHaveLength(1);
  });

  it("leaves it too when the record's 100-handled cap took it", async () => {
    const annas = await answeredAndSweptWhileTheLaptopWasAway((handledAt) => {
      // A hundred of Anna's handled after it, so hers is the oldest over the cap.
      const project = createProject(recordDb.db, { name: "More", keyPrefix: "MORE", managed: true });
      for (let index = 0; index < 100; index += 1) {
        const later = insertMessage(recordDb.db, { ...question(project.id, annaId) }, handledAt);
        markMessageHandled(recordDb.db, later.id, "dismissed", null, handledAt + 1 + index);
      }
      sweepHandledMessages(recordDb.db, handledAt + 1_000);
    });

    await annaLaptop.record.sync();

    expect(getMessage(annaLaptop.handle.db, annas.id)).toBeUndefined();
    expect(listInbox(annaLaptop.handle.db).messages).toEqual([]);
  });

  it("is taken off that desktop when its person presses Dismiss on it before syncing", async () => {
    const annas = await answeredAndSweptWhileTheLaptopWasAway((handledAt) => sweepHandledMessages(recordDb.db, handledAt + HANDLED_MESSAGE_RETENTION_MS));

    const pressed = await annaLaptop.record.handleMessage({ messageId: annas.id, how: "dismissed", answer: null });

    expect(pressed.ok).toBe(false);
    expect(getMessage(annaLaptop.handle.db, annas.id)).toBeUndefined();
    expect(listInbox(annaLaptop.handle.db).messages).toEqual([]);
  });

  it("keeps an open one the record still holds open, and one about a project kept on the desktop", async () => {
    const projectId = await organisationProject();
    await carl.record.sendMessage(question(projectId, "local"));
    const kept = createProject(annaLaptop.handle.db, { name: "Mine", keyPrefix: "MINE" });
    await annaLaptop.record.sendMessage(question(kept.id, annaId));

    await annaLaptop.record.sync();
    await annaLaptop.record.sync();

    expect(listOpenMessages(annaLaptop.handle.db, [annaId])).toHaveLength(2);
  });
});

/**
 * A job's guards about a project the record holds (EO-729): written on
 * the record, to the job's owner rather than to each admin, and answered
 * there — which is where that job's occurrences are.
 */
describe("a job's guard about a project the organisation's record holds", () => {
  const MONDAY_0800 = Date.UTC(2026, 5, 1, 6, 0);

  /** A weekly job on the record's project, owned by Carl — who is no admin — and made before its Monday. */
  async function carlsJob(): Promise<Job> {
    const projectId = await organisationProject();
    const created = createJob(recordDb.db, {
      projectId,
      name: "Monday report",
      trigger: { kind: "schedule", schedule: { kind: "weekly", weekday: 1, hour: 8, minute: 0 }, timeZone: "Europe/Berlin", catchUpWithinMinutes: 180 },
      pipelineId: "default",
      template: { type: "developer:story", title: "{{job}} for {{date}}", body: null },
    });
    if (!created.ok) throw new Error(created.problem);
    recordDb.db.update(jobs).set({ ownerId: carlId, createdAt: MONDAY_0800 - 60_000 }).where(eq(jobs.id, created.job.id)).run();
    return getJob(recordDb.db, created.job.id as Uuid)!;
  }

  it("is a message on the record to the job's owner, which reaches only their desktop, and running it from there fires on the record", async () => {
    const job = await carlsJob();

    // The record's own scheduler skips the Monday it was not running for.
    catchUpJob(recordDb.db, job, { now: MONDAY_0800 + 4 * 60 * 60_000 });

    const written = onTheRecord();
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ recipientId: carlId, jobId: job.id, projectId: job.projectId, source: JOB_MESSAGE_SOURCE.skipped });
    expect(written[0]?.body).toContain("Monday report");

    await syncAll();
    expect(listInbox(carl.handle.db).messages.map((message) => message.id)).toEqual([written[0]?.id]);
    expect(heldOn(annaDesk)).toEqual([]);
    expect(heldOn(ben)).toEqual([]);

    const answered = await carl.record.handleMessage({ messageId: written[0]!.id, how: "answered", answer: RUN_NOW_OPTION });

    expect(answered.ok).toBe(true);
    expect(listOccurrences(recordDb.db, job.id as Uuid).map((occurrence) => occurrence.status)).toEqual(["fired", "skipped"]);
  });

  /** An item the job filed, on the record and pulled down to every desktop. */
  async function filedItem(job: Job) {
    const item = createTestItem(recordDb.db, { type: "story", title: "Monday report for 2026-06-01", stepId: "todo", projectId: job.projectId as Uuid });
    const occurrence = recordOccurrence(recordDb.db, { jobId: job.id as Uuid, dueAt: MONDAY_0800, status: "fired", firedAt: MONDAY_0800, itemId: item.id });
    await syncAll();
    const there = getItem(annaDesk.handle.db, item.id);
    if (there === undefined) throw new Error("the item did not reach Anna's desktop");
    return { item: there, occurrence };
  }

  it("is written on the record, to the owner, when a desktop's run trips the job's budget", async () => {
    const job = await carlsJob();
    const { item, occurrence } = await filedItem(job);

    // Anna's desktop ran the leased item and found it over budget.
    pauseForBudget(annaDesk.handle.db, { job, occurrence, budgetCents: 400, spentCents: 500 }, item);
    await annaDesk.record.sync();

    const written = onTheRecord();
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ recipientId: carlId, jobId: job.id, projectId: job.projectId, source: JOB_MESSAGE_SOURCE.budget });
    expect(written[0]?.body).toContain(`"Monday report" is paused`);
    expect(written[0]?.body).toContain(item.key);
    // Carl's, not Anna's: nothing kept on the desktop that sent it.
    expect(heldOn(annaDesk)).toEqual([]);
    await carl.record.sync();
    expect(heldOn(carl)).toEqual([written[0]?.id]);
  });

  it("still reaches the owner when the record could not be reached at the trip, once it can", async () => {
    const job = await carlsJob();
    const { item, occurrence } = await filedItem(job);
    annaDesk.online = false;

    pauseForBudget(annaDesk.handle.db, { job, occurrence, budgetCents: 400, spentCents: 500 }, item);
    await annaDesk.record.sync();

    // Nothing on the record yet, and the message is not lost: it waits in
    // the desktop's queue of commands for the record.
    expect(onTheRecord()).toEqual([]);
    expect(pendingCommands(annaDesk.handle.db).map((command) => command.kind)).toEqual(["sendMessage"]);

    annaDesk.online = true;
    await annaDesk.record.sync();
    await annaDesk.record.sync();

    const written = onTheRecord();
    expect(written.map((message) => [message.recipientId, message.source])).toEqual([[carlId, JOB_MESSAGE_SOURCE.budget]]);
    expect(pendingCommands(annaDesk.handle.db)).toEqual([]);
    await carl.record.sync();
    expect(listInbox(carl.handle.db).messages.map((message) => message.id)).toEqual([written[0]?.id]);
  });

  it("is written once, however many times a lost acknowledgement makes the desktop send it", async () => {
    const job = await carlsJob();
    const { item, occurrence } = await filedItem(job);
    annaDesk.online = false;
    pauseForBudget(annaDesk.handle.db, { job, occurrence, budgetCents: 400, spentCents: 500 }, item);
    const queued = pendingCommands(annaDesk.handle.db).map((entry) => entry.command);

    // The same command arriving twice, as it does when the first answer
    // never got back to the desktop.
    const deviceId = issueDevice(recordDb.db, { personId: annaId, name: "anna-replay", tokenHash: "hash-anna-replay", secretsKeyHash: null }).id;
    const first = await serveApply(serving, { deviceId, commands: queued });
    const second = await serveApply(serving, { deviceId, commands: queued });

    expect(first.results.map((result) => result.applied)).toEqual([true]);
    expect(second.results.map((result) => result.applied)).toEqual([true]);
    expect(onTheRecord()).toHaveLength(1);
  });

  it("is not written again by a replay that arrives after the owner handled it and retention swept it", async () => {
    const job = await carlsJob();
    const { item, occurrence } = await filedItem(job);
    annaDesk.online = false;
    pauseForBudget(annaDesk.handle.db, { job, occurrence, budgetCents: 400, spentCents: 500 }, item);
    const queued = pendingCommands(annaDesk.handle.db).map((entry) => entry.command);
    const deviceId = issueDevice(recordDb.db, { personId: annaId, name: "anna-replay", tokenHash: "hash-anna-replay", secretsKeyHash: null }).id;

    // The record writes it, and its answer never reaches Anna's desktop.
    await serveApply(serving, { deviceId, commands: queued });
    const written = onTheRecord();
    expect(written).toHaveLength(1);
    // Carl handles it on his desktop, and a week on the record sweeps it.
    await carl.record.sync();
    const dismissed = await carl.record.handleMessage({ messageId: written[0]!.id, how: "dismissed", answer: null });
    if (!dismissed.ok) throw new Error(dismissed.problem);
    sweepHandledMessages(recordDb.db, (dismissed.message.handledAt as number) + HANDLED_MESSAGE_RETENTION_MS + 1);
    expect(onTheRecord()).toEqual([]);

    // Anna's desktop comes back and the drain sends what it still holds.
    annaDesk.online = true;
    await annaDesk.record.sync();

    expect(pendingCommands(annaDesk.handle.db)).toEqual([]);
    expect(onTheRecord()).toEqual([]);
    await carl.record.sync();
    expect(listInbox(carl.handle.db).messages).toEqual([]);
  });
});
