import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { LOCAL_PERSON_ID, uuidv7, type IpcResponse, type Message, type MessageSend } from "@eo/core";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { getMessage, insertMessage } from "../db/repos/index.js";
import { messages } from "../db/schema.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { clearHandlerRegistry, dispatchIpc } from "../ipc/registry.js";
import { fakePlatform } from "../testing/platform.js";
import { toolsFor } from "./gate.js";
import { renderInbox } from "./render.js";
import { answerToolCall } from "./server.js";

/**
 * `message_answer` and `message_dismiss` (EO-918): an outside client of
 * EO's MCP server and EO's assistant answer or dismiss the person's
 * messages through the `messages:*` commands the Inbox presses, with the
 * same checks, and the message records which of the three pressed.
 */

let handle: DbHandle;
const ANNA = uuidv7();
const ASSISTANT = "the-system-agent";

beforeEach(async () => {
  handle = openMigratedTestDb();
  const { registerAllHandlers } = await import("../ipc/handlers.js");
  registerAllHandlers(handle.db, undefined, { platform: fakePlatform() });
});

afterEach(() => {
  clearHandlerRegistry();
  handle.close();
});

function send(overrides: Partial<MessageSend> = {}): Message {
  return insertMessage(handle.db, { recipientId: LOCAL_PERSON_ID, source: "runtime_limit", body: "Claude's plan limit was reached.", options: ["Carry on now"], ...overrides });
}

/** From outside: a client of EO's external MCP server. */
function fromOutside(name: string, args: Record<string, unknown>) {
  return answerToolCall({ name, arguments: args }, "external", false);
}

/** From the assistant: a system agent's turn on `eo_admin`, which the host names. */
function fromTheAssistant(name: string, args: Record<string, unknown>) {
  return answerToolCall({ name, arguments: args }, "admin", false, undefined, undefined, ASSISTANT);
}

function textOf(result: CallToolResult): string {
  return result.content.map((part) => ("text" in part ? part.text : "")).join("");
}

describe("where the message tools are offered", () => {
  it("offers both on the outside server and on eo_admin", () => {
    for (const audience of ["external", "admin"] as const) {
      const names = toolsFor(false, audience).map((tool) => tool.name);
      expect(names, audience).toEqual(expect.arrayContaining(["message_answer", "message_dismiss"]));
    }
  });
});

describe("answering", () => {
  it("answers from outside, through messages:answer, and records an outside MCP client", async () => {
    const message = send();

    const result = await fromOutside("message_answer", { messageId: message.id, answer: "Carry on now" });

    expect(result.isError).toBe(false);
    expect(textOf(result)).toContain("Answered Carry on now · by an outside MCP client");
    expect(getMessage(handle.db, message.id)).toMatchObject({ handledHow: "answered", answer: "Carry on now", handledBy: { kind: "mcp_client" } });
  });

  it("answers for the assistant, recording the system agent by its id", async () => {
    const message = send();

    const result = await fromTheAssistant("message_answer", { messageId: message.id, answer: "Carry on now" });

    expect(textOf(result)).toContain("Answered Carry on now · by the assistant");
    expect(getMessage(handle.db, message.id)?.handledBy).toEqual({ kind: "assistant", agentId: ASSISTANT });
  });

  it("records the person for a press in the Inbox", async () => {
    const message = send();

    const pressed = await dispatchIpc("messages:answer", { messageId: message.id, answer: "Carry on now" });

    expect(pressed.ok && (pressed.data as IpcResponse<"messages:answer">).message?.handledBy).toEqual({ kind: "person" });
  });

  it("is never told who it is by the client: a claim to be the assistant, or not an MCP client, is taken off", async () => {
    const message = send();

    await fromOutside("message_answer", { messageId: message.id, answer: "Carry on now", actingAgentId: ASSISTANT, actingMcpClient: false });

    expect(getMessage(handle.db, message.id)?.handledBy).toEqual({ kind: "mcp_client" });
  });
});

describe("dismissing", () => {
  it("dismisses from outside and for the assistant, saying who", async () => {
    const outside = send();
    const assistant = send();

    const first = await fromOutside("message_dismiss", { messageId: outside.id });
    const second = await fromTheAssistant("message_dismiss", { messageId: assistant.id });

    expect(textOf(first)).toContain("Dismissed · by an outside MCP client");
    expect(textOf(second)).toContain("Dismissed · by the assistant");
    expect(getMessage(handle.db, outside.id)).toMatchObject({ handledHow: "dismissed", answer: null, handledBy: { kind: "mcp_client" } });
    expect(getMessage(handle.db, assistant.id)).toMatchObject({ handledHow: "dismissed", handledBy: { kind: "assistant", agentId: ASSISTANT } });
  });
});

describe("refusals", () => {
  it("refuses a message already handled, as a successful call that says who handled it", async () => {
    const message = send();
    await fromTheAssistant("message_answer", { messageId: message.id, answer: "Carry on now" });

    const again = await fromOutside("message_dismiss", { messageId: message.id });

    expect(again.isError).toBe(false);
    expect(textOf(again)).toBe("That message was already answered by the assistant.");
    expect(getMessage(handle.db, message.id)).toMatchObject({ handledHow: "answered", handledBy: { kind: "assistant", agentId: ASSISTANT } });
  });

  it("refuses one the person already handled in the Inbox in the Inbox's words", async () => {
    const message = send();
    await dispatchIpc("messages:dismiss", { messageId: message.id });

    expect(textOf(await fromTheAssistant("message_answer", { messageId: message.id, answer: "Carry on now" }))).toBe("That message was already dismissed.");
  });

  it("refuses a message addressed to somebody else, and one that does not exist", async () => {
    const annas = send({ recipientId: ANNA });

    for (const messageId of [annas.id, uuidv7()]) {
      const result = await fromOutside("message_answer", { messageId, answer: "Carry on now" });
      expect(result.isError).toBe(false);
      expect(textOf(result)).toBe("That message is not one of yours, or it has been deleted.");
    }
    expect(getMessage(handle.db, annas.id)?.handledAt).toBeNull();
  });

  it("refuses an answer the message does not offer", async () => {
    const message = send();

    const result = await fromTheAssistant("message_answer", { messageId: message.id, answer: "Run it now" });

    expect(result.isError).toBe(false);
    expect(textOf(result)).toBe('"Run it now" is not one of the answers this message offers.');
    expect(getMessage(handle.db, message.id)?.handledAt).toBeNull();
  });
});

describe("inbox_list", () => {
  it("gives an open message's id, its answers and the tools, and who handled the recent ones", async () => {
    const open = send({ body: "Codex's plan limit was reached." });
    const handled = send();
    await fromTheAssistant("message_answer", { messageId: handled.id, answer: "Carry on now" });

    const listed = await fromOutside("inbox_list", {});
    const text = textOf(listed);

    expect(text).toContain(`Answer it with message_answer (messageId ${open.id}, answer one of: "Carry on now")`);
    expect(text).toContain(`message_dismiss (messageId ${open.id})`);
    expect(text).not.toContain("Inbox, not with comment_post");
    expect(text).toContain("## Recently handled messages");
    expect(text).toContain(`Claude's plan limit was reached. — Answered Carry on now · by the assistant`);
    expect(listed.structuredContent).toMatchObject({ handledMessages: [{ id: handled.id, handledBy: { kind: "assistant", agentId: ASSISTANT } }] });
  });

  it("says a message handled before handlers were recorded was the person's", () => {
    const message = send();
    handle.db.update(messages).set({ handledAt: 5, handledHow: "dismissed", handledBy: null }).where(eq(messages.id, message.id)).run();

    const read = getMessage(handle.db, message.id)!;
    expect(read.handledBy).toEqual({ kind: "person" });
    expect(renderInbox({ items: [], messages: [], handledMessages: [read], summary: { openCount: 0, blockingCount: 0, everythingBlocked: false } })).toContain(
      "Dismissed · by the person",
    );
  });
});
