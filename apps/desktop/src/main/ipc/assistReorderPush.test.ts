import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../db/client.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { fakePlatform } from "../testing/platform.js";
import { bridgePushChannels } from "./push.js";
import { clearHandlerRegistry, dispatchIpc } from "./registry.js";

let handle: DbHandle;
let directory: string;

beforeEach(async () => {
  handle = openMigratedTestDb();
  const platform = fakePlatform();
  directory = platform.userDataPath;
  const { registerAllHandlers } = await import("./handlers.js");
  registerAllHandlers(handle.db, undefined, { platform });
});

afterEach(() => {
  clearHandlerRegistry();
  handle.close();
  rmSync(directory, { recursive: true, force: true });
});

/**
 * EO-439. A move is the chat lists' business and nobody else's: it used
 * to push `items:changed`, and every window refetched the conversation,
 * the project's items, the inbox and the board for a chat moved one place.
 */
describe("what moving a chat tells the windows", () => {
  it("pushes assist:changed, and not items:changed, whether the move is stored or refused", async () => {
    const started = await dispatchIpc("assist:new", undefined);
    if (!started.ok) throw new Error(JSON.stringify(started));
    const chat = (started.data as { conversation: { id: string } }).conversation.id;
    const send = vi.fn();
    const dispose = bridgePushChannels({ send });

    try {
      const moved = await dispatchIpc("assist:reorder", { conversationId: chat, index: 0 });
      expect(moved).toMatchObject({ ok: true, data: { problem: null, conversations: [{ id: chat, live: true }] } });
      const refused = await dispatchIpc("assist:reorder", { conversationId: "no-such-chat", index: 0 });
      expect(refused).toMatchObject({ ok: true, data: { problem: "That chat is not open any more, so it was not moved." } });

      expect(send.mock.calls.map(([channel]) => channel)).toEqual(["push:assist:changed", "push:assist:changed"]);
    } finally {
      dispose();
    }
  });
});
