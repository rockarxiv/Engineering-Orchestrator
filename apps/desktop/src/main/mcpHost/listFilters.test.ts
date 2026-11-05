import { ArchivedItemListFiltersSchema, ItemListFiltersSchema } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { setItemArchived } from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { listArchivedSummaries, listItemSummaries } from "../ipc/domainQueries.js";
import { clearHandlerRegistry, registerHandler } from "../ipc/registry.js";
import { TOOLS } from "./catalog.js";
import { answerToolCall } from "./server.js";

/** The item lists' own filters (EO-539), as a client sees and calls them. */

const FILTERS = ["stepId", "stepName", "pipelineId", "type", "parentKey", "keys", "text", "createdSince", "updatedSince"];

let handle: DbHandle;

beforeEach(() => {
  handle = openMigratedTestDb();
  registerHandler("items:list", (payload) => listItemSummaries(handle.db, null, ItemListFiltersSchema.parse(payload)), { exposeErrorDetails: true });
  registerHandler("items:listArchived", (payload) => listArchivedSummaries(handle.db, null, ArchivedItemListFiltersSchema.parse(payload)), { exposeErrorDetails: true });
});

afterEach(() => {
  clearHandlerRegistry();
  handle.close();
});

function properties(name: string): Record<string, unknown> {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`no tool named ${name}`);
  return (tool.inputSchema["properties"] ?? {}) as Record<string, unknown>;
}

function keysOf(result: Awaited<ReturnType<typeof answerToolCall>>): string[] {
  return ((result.structuredContent as { tickets: { key: string }[] }).tickets ?? []).map((row) => row.key).sort();
}

describe("the item lists' filters", () => {
  it("are advertised by both lists under both of their names, atTerminalStep on the live list only", () => {
    for (const name of ["tickets_list", "items_list"]) {
      for (const filter of [...FILTERS, "atTerminalStep"]) expect(properties(name), `${name}.${filter}`).toHaveProperty(filter);
    }
    for (const name of ["tickets_list_archived", "items_list_archived"]) {
      for (const filter of FILTERS) expect(properties(name), `${name}.${filter}`).toHaveProperty(filter);
      expect(properties(name), name).not.toHaveProperty("atTerminalStep");
    }
  });

  it("answer only the matching items, and compose with the host's own narrowing", async () => {
    const todo = createTestItem(handle.db, { type: "story", title: "Rate limit the import", stepId: "todo" });
    const bug = createTestItem(handle.db, { type: "bug", title: "Import crashes", stepId: "todo" });
    const review = createTestItem(handle.db, { type: "story", title: "Retry the export", stepId: "review" });

    for (const name of ["tickets_list", "items_list"]) {
      expect(keysOf(await answerToolCall({ name, arguments: { stepName: "To Do" } }, "admin", true)), name).toEqual([todo.key, bug.key].sort());
      expect(keysOf(await answerToolCall({ name, arguments: { stepId: "review" } }, "admin", true)), name).toEqual([review.key]);
      expect(keysOf(await answerToolCall({ name, arguments: { text: "IMPORT", type: "bug" } }, "admin", true)), name).toEqual([bug.key]);

      const narrowed = await answerToolCall({ name, arguments: { stepId: "todo", fields: ["tickets.key"] } }, "admin", true);
      expect(narrowed.structuredContent, name).toEqual({ tickets: [{ key: todo.key }, { key: bug.key }], total: 2, returned: 2, nextOffset: null });
    }

    setItemArchived(handle.db, review.id, Date.now());
    setItemArchived(handle.db, bug.id, Date.now());
    for (const name of ["tickets_list_archived", "items_list_archived"]) {
      expect(keysOf(await answerToolCall({ name, arguments: { type: "bug" } }, "admin", true)), name).toEqual([bug.key]);
    }
  });

  it("refuse a filter of the wrong shape, as the channel's own validation does", async () => {
    const result = await answerToolCall({ name: "items_list", arguments: { createdSince: "yesterday" } }, "admin", true);

    expect(result.isError).toBe(true);
  });
});
