import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HANDLED_MESSAGE_RETENTION_MS, LOCAL_PERSON_ID, type Message, uuidv7 } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import { createProject, deleteProject, getMessage, insertMessage, listOpenMessages, markMessageHandled, sweepHandledMessages } from "../db/repos/index.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { listInbox } from "../ipc/domainQueries.js";
import { onPush } from "../ipc/push.js";
import { answerMessageCommand, dismissMessageCommand, messageRecipientsFor, resolveMessage, sendMessage } from "./messages.js";

let handle: DbHandle;

beforeEach(() => {
  handle = openMigratedTestDb();
});

afterEach(() => {
  handle.close();
});

const DAY = 24 * 60 * 60 * 1000;
const ANNA = uuidv7();

function send(overrides: Partial<Parameters<typeof insertMessage>[1]> = {}, at?: number): Message {
  return insertMessage(handle.db, { recipientId: LOCAL_PERSON_ID, source: "template_conflict", body: "Keep or take?", options: ["Keep", "Take"], ...overrides }, at);
}

describe("the messages table", () => {
  it("keeps every field it was sent with, open, under a UUIDv7 id", () => {
    const project = createProject(handle.db, { name: "Site", keyPrefix: "SITE" });
    const message = send({ projectId: project.id, options: ["Keep", { kind: "open", label: "Fix with assistant", opens: { type: "updateConflictChat", conflictId: "c1" } }] }, 1_000);

    expect(message.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(getMessage(handle.db, message.id)).toEqual({
      id: message.id,
      recipientId: LOCAL_PERSON_ID,
      projectId: project.id,
      jobId: null,
      source: "template_conflict",
      body: "Keep or take?",
      options: ["Keep", { kind: "open", label: "Fix with assistant", opens: { type: "updateConflictChat", conflictId: "c1" } }],
      createdAt: 1_000,
      handledAt: null,
      handledHow: null,
      answer: null,
    });
  });

  it("lists a person's open messages newest first, and nobody else's", () => {
    const older = send({}, 1_000);
    const newer = send({}, 2_000);
    send({ recipientId: ANNA }, 3_000);
    markMessageHandled(handle.db, send({}, 4_000).id, "dismissed");

    expect(listOpenMessages(handle.db, [LOCAL_PERSON_ID]).map((message) => message.id)).toEqual([newer.id, older.id]);
  });

  it("goes with the project it is about", () => {
    const project = createProject(handle.db, { name: "Site", keyPrefix: "SITE" });
    const message = send({ projectId: project.id });
    deleteProject(handle.db, project.id);
    expect(getMessage(handle.db, message.id)).toBeUndefined();
  });
});

describe("sending and handling", () => {
  it("sends a message and tells the windows", () => {
    const heard: unknown[] = [];
    const off = onPush("messages:changed", (payload) => heard.push(payload));
    try {
      const message = sendMessage(handle.db, { recipientId: LOCAL_PERSON_ID, source: "job_guard", body: "Run it now?" });
      expect(getMessage(handle.db, message.id)?.handledAt).toBeNull();
      expect(heard).toHaveLength(1);
    } finally {
      off();
    }
  });

  it("records an answer with the option chosen", () => {
    const message = send();
    const { message: answered } = answerMessageCommand(handle.db, { messageId: message.id, answer: "Take" }, 5_000);
    expect(answered).toMatchObject({ handledAt: 5_000, handledHow: "answered", answer: "Take" });
    expect(listOpenMessages(handle.db, [LOCAL_PERSON_ID])).toEqual([]);
  });

  it("refuses an answer the message did not offer, and an action's label", () => {
    const message = send({ options: ["Keep", { kind: "open", label: "Fix", opens: { type: "updateConflictChat", conflictId: "c1" } }] });
    expect(() => answerMessageCommand(handle.db, { messageId: message.id, answer: "Whatever" })).toThrow(/not one of the answers/);
    expect(() => answerMessageCommand(handle.db, { messageId: message.id, answer: "Fix" })).toThrow(/not one of the answers/);
    expect(getMessage(handle.db, message.id)?.handledAt).toBeNull();
  });

  it("records a dismissal", () => {
    const message = send();
    const { message: dismissed } = dismissMessageCommand(handle.db, { messageId: message.id }, 6_000);
    expect(dismissed).toMatchObject({ handledAt: 6_000, handledHow: "dismissed", answer: null });
  });

  it("records EO resolving it, once", () => {
    const message = send();
    expect(resolveMessage(handle.db, message.id, 7_000)).toMatchObject({ handledAt: 7_000, handledHow: "resolved" });
    expect(resolveMessage(handle.db, message.id, 8_000)).toBeUndefined();
    expect(getMessage(handle.db, message.id)?.handledAt).toBe(7_000);
  });

  it("refuses to handle a message twice", () => {
    const message = send();
    dismissMessageCommand(handle.db, { messageId: message.id });
    expect(() => answerMessageCommand(handle.db, { messageId: message.id, answer: "Keep" })).toThrow(/already dismissed/);
    expect(() => dismissMessageCommand(handle.db, { messageId: message.id })).toThrow(/already dismissed/);
  });

  it("refuses somebody who is not its recipient", () => {
    const message = send({ recipientId: ANNA });
    expect(() => dismissMessageCommand(handle.db, { messageId: message.id })).toThrow(/not one of yours/);
    // An operator's key is nobody, and has no messages.
    expect(messageRecipientsFor(handle.db, null)).toEqual([]);
    expect(() => dismissMessageCommand(handle.db, { messageId: send().id, actingDeviceId: null })).toThrow(/not one of yours/);
  });
});

describe("in the inbox", () => {
  it("lists open messages beside item questions and counts them", () => {
    const message = send();
    const inbox = listInbox(handle.db);
    expect(inbox.messages.map((entry) => entry.id)).toEqual([message.id]);
    expect(inbox.summary.openCount).toBe(1);
    expect(inbox.summary.blockingCount).toBe(0);

    dismissMessageCommand(handle.db, { messageId: message.id });
    expect(listInbox(handle.db).messages).toEqual([]);
    expect(listInbox(handle.db).summary.openCount).toBe(0);
  });

  it("keeps, on a project's read, the messages about that project and about none", () => {
    const site = createProject(handle.db, { name: "Site", keyPrefix: "SITE" });
    const docs = createProject(handle.db, { name: "Docs", keyPrefix: "DOCS" });
    const aboutSite = send({ projectId: site.id }, 1_000);
    send({ projectId: docs.id }, 2_000);
    const aboutNone = send({}, 3_000);

    expect(listInbox(handle.db, site.id).messages.map((entry) => entry.id)).toEqual([aboutNone.id, aboutSite.id]);
    expect(listInbox(handle.db).messages).toHaveLength(3);
  });

  it("lists only the reader's own when a door named one", () => {
    send();
    const anna = send({ recipientId: ANNA });
    expect(listInbox(handle.db, undefined, ANNA).messages.map((entry) => entry.id)).toEqual([anna.id]);
  });
});

describe("the retention sweep", () => {
  const now = 100 * DAY;

  it("deletes a handled message 7 days after it was handled, and not before", () => {
    const old = send({}, 0);
    markMessageHandled(handle.db, old.id, "dismissed", null, now - HANDLED_MESSAGE_RETENTION_MS);
    const recent = send({}, 0);
    markMessageHandled(handle.db, recent.id, "answered", "Keep", now - HANDLED_MESSAGE_RETENTION_MS + 1);

    expect(sweepHandledMessages(handle.db, now)).toBe(1);
    expect(getMessage(handle.db, old.id)).toBeUndefined();
    expect(getMessage(handle.db, recent.id)).toBeDefined();
  });

  it("never deletes an unhandled message by age", () => {
    const ancient = send({}, 0);
    expect(sweepHandledMessages(handle.db, now + 365 * DAY)).toBe(0);
    expect(getMessage(handle.db, ancient.id)?.handledAt).toBeNull();
  });

  it("keeps at most 100 handled messages per person, the oldest handled going first", () => {
    const handled = Array.from({ length: 103 }, (_, index) => {
      // Created in the opposite order to being handled, so the cap is by handling and not by sending.
      const message = send({}, 1_000 - index);
      markMessageHandled(handle.db, message.id, "dismissed", null, now - DAY + index);
      return message;
    });
    const open = Array.from({ length: 5 }, () => send({}, 0));
    const annas = Array.from({ length: 3 }, (_, index) => {
      const message = send({ recipientId: ANNA }, 0);
      markMessageHandled(handle.db, message.id, "resolved", null, now - 2 * DAY + index);
      return message;
    });

    expect(sweepHandledMessages(handle.db, now)).toBe(3);
    // The three handled first are gone; the 100 handled since are kept.
    for (const message of handled.slice(0, 3)) expect(getMessage(handle.db, message.id)).toBeUndefined();
    for (const message of handled.slice(3)) expect(getMessage(handle.db, message.id)).toBeDefined();
    // Open ones do not count against the cap, and another person's are their own.
    for (const message of [...open, ...annas]) expect(getMessage(handle.db, message.id)).toBeDefined();
  });
});
