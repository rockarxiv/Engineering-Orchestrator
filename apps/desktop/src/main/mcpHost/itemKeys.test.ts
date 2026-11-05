import { canonicalToolName, type IpcChannel } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { projectForWorkspace } from "../db/repos/index.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { resolveItemKey } from "../ipc/domainQueries.js";
import { clearHandlerRegistry, registerHandler } from "../ipc/registry.js";
import { TOOLS, type ToolSpec } from "./catalog.js";
import { ITEM_ID_ARGUMENTS, itemIdArgumentsOf, KEY_ACCEPTED_SENTENCE, RESOLVE_KEY_CHANNEL } from "./itemKeys.js";
import { answerToolCall } from "./server.js";

/**
 * An item's key wherever a tool takes an item's id (EO-539), across the
 * whole catalogue and through the door a client actually calls.
 */

/**
 * Every tool that takes an item id, by EO's own name, with what else a
 * call to it must carry for its channel to accept it.
 *
 * Written down rather than inferred, so a tool that starts taking an
 * item id fails here until somebody says how to call it — and is then
 * held to accepting a key like every other.
 */
const TAKES_AN_ITEM: Record<string, Record<string, unknown>> = {
  item_get: {},
  spend_read: {},
  comment_post: { body: "Picked this up." },
  item_update: { title: "Rate limit the import, again" },
  item_move: { toStepId: "review" },
  item_decide: { resultKey: "approved" },
  item_move_to_version: { version: 2 },
  item_hold: {},
  item_resume: {},
  item_archive: { archived: true },
  jira_pull: {},
  item_delete: {},
  runs_list: {},
  runs_summary: { groupBy: "item" },
  memories_search: {},
};

const takingAnItem = TOOLS.filter((tool) => tool.itemKeys !== undefined);

function properties(tool: ToolSpec): Record<string, { description?: string }> {
  return (tool.inputSchema["properties"] ?? {}) as Record<string, { description?: string }>;
}

describe("which tools take a key", () => {
  it("is every tool that advertises an item id, under both of an aliased pair's names", () => {
    const advertising = TOOLS.filter((tool) => ITEM_ID_ARGUMENTS.some((name) => Object.hasOwn(properties(tool), name)));

    expect(takingAnItem.map((tool) => tool.name)).toEqual(advertising.map((tool) => tool.name));
    expect([...new Set(takingAnItem.map((tool) => canonicalToolName(tool.name)))].sort()).toEqual(Object.keys(TAKES_AN_ITEM).sort());
    // Both halves of every pair that has one.
    for (const name of ["ticket_get", "item_get", "ticket_update", "item_update", "ticket_move", "item_move", "ticket_hold", "item_hold", "ticket_delete", "item_delete", "comment_post"]) {
      expect(takingAnItem.map((tool) => tool.name), name).toContain(name);
    }
  });

  it("says so in each one's description and on the argument, and may reach the channel a key is resolved through", () => {
    for (const tool of takingAnItem) {
      expect(tool.description, tool.name).toContain(KEY_ACCEPTED_SENTENCE);
      expect(tool.channels, tool.name).toContain(RESOLVE_KEY_CHANNEL);
      // Resolved in both spellings, since the tool takes either; described
      // on the one it advertises.
      expect(tool.itemKeys, tool.name).toEqual(["itemId", "ticketId"]);
      for (const name of itemIdArgumentsOf(tool.inputSchema)) expect(properties(tool)[name]?.description, `${tool.name}.${name}`).toMatch(/key such as EO-486/);
    }
  });

  it("adds nothing to a tool that takes no item id", () => {
    for (const tool of TOOLS.filter((candidate) => candidate.itemKeys === undefined)) {
      expect(tool.channels, tool.name).not.toContain(RESOLVE_KEY_CHANNEL);
      expect(tool.description, tool.name).not.toContain(KEY_ACCEPTED_SENTENCE);
    }
  });
});

let handle: DbHandle;
let item: { id: string; key: string };

beforeEach(() => {
  handle = openMigratedTestDb();
  const workspace = attachWorkspace(handle.db, { name: "app", keyPrefix: "APP", repoPath: "/tmp/app" });
  const projectId = projectForWorkspace(handle.db, workspace.id)!.id;
  item = createTestItem(handle.db, { type: "story", title: "Rate limit the import", stepId: "todo", projectId, workspaceId: workspace.id });
});

afterEach(() => {
  clearHandlerRegistry();
  handle.close();
});

/**
 * Every channel the tool reaches, answered by a spy that writes down
 * what it was sent — and the real key resolution beside them.
 *
 * The spies are the proof of "nothing is changed": a tool reaches EO's
 * data through its channels and nothing else, so a call none of them
 * heard is a call that changed nothing.
 */
function spyOn(tool: ToolSpec): { channel: IpcChannel; payload: unknown }[] {
  clearHandlerRegistry();
  registerHandler("items:resolveKey", (payload) => resolveItemKey(handle.db, payload), { exposeErrorDetails: true });
  const heard: { channel: IpcChannel; payload: unknown }[] = [];
  for (const channel of tool.channels.filter((candidate) => candidate !== RESOLVE_KEY_CHANNEL)) {
    registerHandler(
      channel,
      ((payload: unknown) => {
        heard.push({ channel, payload });
        // `spend_read` reads the day before the item, so the day has to answer.
        if (channel === "costs:getDaily") return { date: "2026-10-23", costCents: 0, sideCalls: [] };
        throw new Error("spy");
      }) as never,
      { exposeErrorDetails: true },
    );
  }
  return heard;
}

/** The id under one spelling of its argument — the one the tool advertises, or the other, which it accepts too. */
async function call(tool: ToolSpec, id: string, spelling: "itemId" | "ticketId") {
  return answerToolCall({ name: tool.name, arguments: { ...TAKES_AN_ITEM[canonicalToolName(tool.name)], [spelling]: id } }, "admin", true);
}

/** Every tool that takes an item, under each spelling of its id argument. */
const EVERY_SPELLING = takingAnItem.flatMap((tool) => ITEM_ID_ARGUMENTS.map((spelling) => [`${tool.name}({ ${spelling} })`, tool, spelling] as const));

function textOf(result: Awaited<ReturnType<typeof answerToolCall>>): string {
  const first = result.content[0];
  return first?.type === "text" ? first.text : "";
}

describe("a key where an id is asked for, through answerToolCall", () => {
  it.each(EVERY_SPELLING)("%s sends its channel the same id for the key as for the UUID", async (_name, tool, spelling) => {
    const byId = spyOn(tool);
    await call(tool, item.id, spelling);
    const byKey = spyOn(tool);
    await call(tool, item.key, spelling);
    const byLowerKey = spyOn(tool);
    await call(tool, item.key.toLowerCase(), spelling);
    // And the same as the UUID under the spelling the tool advertises.
    const advertised = spyOn(tool);
    await call(tool, item.id, itemIdArgumentsOf(tool.inputSchema)[0] as "itemId" | "ticketId");

    expect(byId.length, tool.name).toBeGreaterThan(0);
    expect(byId, tool.name).toEqual(advertised);
    expect(byKey, tool.name).toEqual(byId);
    expect(byLowerKey, tool.name).toEqual(byId);
    expect(JSON.stringify(byKey), tool.name).toContain(item.id);
  });

  it.each(EVERY_SPELLING)("%s refuses a key naming nothing, or anything neither an id nor a key, names it, and reaches no channel", async (_name, tool, spelling) => {
    // Unknown keys, and malformed ones of every shape: hyphenated or not,
    // a bare number, a title, a near-UUID, nothing at all.
    for (const key of ["APP-999", "ZZ-1", "APP-12a", "APP-", "APP486", "486", "#APP-1", "Rate limit the import", "01920000-0000-7000-8000-00000000000", "", "t1"]) {
      const heard = spyOn(tool);
      const result = await call(tool, key, spelling);

      expect(result.isError, `${tool.name} ${key}`).toBe(true);
      expect(textOf(result), `${tool.name} ${key}`).toContain(`"${key}"`);
      expect(textOf(result), `${tool.name} ${key}`).toMatch(tool.kind === "read" ? /Nothing was read\.$/ : /Nothing was changed\.$/);
      expect(heard, `${tool.name} ${key}`).toEqual([]);
    }
  });

  it.each(takingAnItem.map((tool) => [tool.name, tool] as const))("%s still refuses both spellings in one call, as the tool always has, whatever they hold", async (_name, tool) => {
    for (const [itemId, ticketId] of [
      [item.id, item.id],
      [item.key, item.key],
      [item.key, item.id],
      ["APP-999", "EO486"],
    ]) {
      const heard = spyOn(tool);
      const args = { ...TAKES_AN_ITEM[canonicalToolName(tool.name)], itemId, ticketId };
      const result = await answerToolCall({ name: tool.name, arguments: args }, "admin", true);
      // What the tool itself says to the same call, with no host in front of it.
      const own = await tool.run(async () => ({ ok: false, error: { message: "unreachable" } }), args);

      expect(result.isError, `${tool.name} ${itemId} ${ticketId}`).toBe(true);
      expect(own.ok, tool.name).toBe(false);
      expect(textOf(result), `${tool.name} ${itemId} ${ticketId}`).toContain(own.ok ? "" : own.message);
      expect(textOf(result), tool.name).toMatch(/ticketId/);
      expect(heard, `${tool.name} ${itemId} ${ticketId}`).toEqual([]);
    }
  });
});
