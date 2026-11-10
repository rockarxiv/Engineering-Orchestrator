import { LOCAL_PERSON_ID, type IpcChannel } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { listAgents, postComment } from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { listInbox } from "../ipc/domainQueries.js";
import { clearHandlerRegistry, dispatchIpc, registerHandler } from "../ipc/registry.js";
import { sendMessage } from "../messages/messages.js";
import { TOOLS, type Dispatch } from "./catalog.js";

/** `inbox_list` and EO's messages (EO-725): listed beside the questions on items, and marked as messages. */

const opts = { exposeErrorDetails: true };
const dispatch: Dispatch = (channel: IpcChannel, payload: unknown) => dispatchIpc(channel, payload);
let handle: DbHandle;

beforeEach(() => {
  handle = openMigratedTestDb();
  registerHandler("inbox:list", () => listInbox(handle.db), opts);
});

afterEach(() => {
  clearHandlerRegistry();
  handle.close();
});

const inboxList = () => TOOLS.find((candidate) => candidate.name === "inbox_list")!;

describe("inbox_list", () => {
  it("returns open messages, told apart from the questions on items", async () => {
    const item = createTestItem(handle.db, { type: "story", title: "Rate limiting", stepId: "todo" });
    const implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
    postComment(handle.db, { itemId: item.id, author: { type: "agent", agentId: implementer.id }, body: "Which limit?", mentions: [{ type: "human" }], kind: "question" });
    const message = sendMessage(handle.db, { recipientId: LOCAL_PERSON_ID, source: "template_conflict", body: "The template update could not be applied.", options: ["Keep mine"] });

    const outcome = await inboxList().run(dispatch, {});

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.text).toContain("2 open");
    expect(outcome.text).toContain(`MESSAGE from EO (no ticket; template_conflict`);
    expect(outcome.text).toContain("The template update could not be applied.");
    expect(outcome.text).toContain("Offered answers: Keep mine");
    expect(outcome.text).toContain(`Message id ${message.id}`);
    expect(outcome.text).toContain(`${item.key} — Rate limiting`);
  });

  it("says nothing is waiting only when there is neither", async () => {
    sendMessage(handle.db, { recipientId: LOCAL_PERSON_ID, source: "job_guard", body: "Run it now?" });
    const outcome = await inboxList().run(dispatch, {});
    expect(outcome.ok && outcome.text).not.toContain("Nothing is waiting");
  });
});
