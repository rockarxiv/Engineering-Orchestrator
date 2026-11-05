import { getTableConfig } from "drizzle-orm/sqlite-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Uuid } from "@eo/core";
import type { DbHandle } from "./client.js";
import { appendSyncedRunEvents, createRun, listActiveRuns, listRunsForItem, listTransitionsForItem, stepEntryTimes } from "./repos/index.js";
import { listRunEventsSince } from "./repos/runEventsRepo.js";
import { itemDeps, items, runs, transitions } from "./schema.js";
import { createTestItem, openMigratedTestDb } from "./testHelpers.js";

/**
 * The reads every handler and every tick makes go through an index rather
 * than walking a whole table (EO-555, migration 0140).
 *
 * Each statement is the one the repo function actually prepares, caught
 * at the connection drizzle prepares on — the seam runAnalysis.test.ts
 * watches — so a rewrite of the query that stops using the index fails
 * here rather than in a 475 MB database.
 */

interface Prepared {
  all: (...params: unknown[]) => unknown[];
}

interface Client {
  prepare: (source: string) => Prepared;
}

function clientOf(handle: DbHandle): Client {
  return (handle.db as unknown as { $client: Client }).$client;
}

/** Every statement `read` prepares, in order. */
function statementsOf(handle: DbHandle, read: () => void): string[] {
  const client = clientOf(handle);
  const prepare = client.prepare.bind(client);
  const seen: string[] = [];
  client.prepare = (source: string) => {
    seen.push(source);
    return prepare(source);
  };
  try {
    read();
  } finally {
    client.prepare = prepare;
  }
  return seen;
}

/**
 * The plan SQLite chooses for `statement`. Every `?` is bound to null:
 * the plan depends on the shape of the query, not on the values.
 */
function planOf(handle: DbHandle, statement: string): string[] {
  const placeholders = statement.split("?").length - 1;
  const rows = clientOf(handle)
    .prepare(`EXPLAIN QUERY PLAN ${statement}`)
    .all(...Array.from({ length: placeholders }, () => null)) as { detail: string }[];
  return rows.map((row) => row.detail);
}

function onlyStatement(handle: DbHandle, table: string, read: () => void): string {
  const statements = statementsOf(handle, read).filter((source) => source.includes(`from "${table}"`));
  expect(statements).toHaveLength(1);
  return statements[0]!;
}

describe("query plans (EO-555)", () => {
  let handle: DbHandle;
  const itemId = "019a0000-0000-7000-8000-000000000001" as Uuid;

  beforeEach(() => {
    handle = openMigratedTestDb();
  });

  afterEach(() => {
    handle.close();
  });

  it("finds an item's runs through idx_runs_item, whether it asks for all of them or the newest few", () => {
    for (const read of [() => listRunsForItem(handle.db, itemId), () => listRunsForItem(handle.db, itemId, 5)]) {
      const plan = planOf(handle, onlyStatement(handle, "runs", read));
      expect(plan.join("\n")).toMatch(/SEARCH runs USING INDEX idx_runs_item \(item_id=\?\)/);
      expect(plan.filter((detail) => detail.startsWith("SCAN"))).toEqual([]);
    }
  });

  it("finds the runs in flight through idx_runs_status", () => {
    const plan = planOf(handle, onlyStatement(handle, "runs", () => listActiveRuns(handle.db)));
    expect(plan.join("\n")).toMatch(/SEARCH runs USING INDEX idx_runs_status \(status=\?\)/);
    expect(plan.filter((detail) => detail.startsWith("SCAN"))).toEqual([]);
  });

  it("finds an item's transitions through idx_transitions_item", () => {
    const plan = planOf(handle, onlyStatement(handle, "transitions", () => listTransitionsForItem(handle.db, itemId)));
    expect(plan.join("\n")).toMatch(/SEARCH transitions USING INDEX idx_transitions_item \(item_id=\?\)/);
    expect(plan.filter((detail) => detail.startsWith("SCAN"))).toEqual([]);
  });

  it("reads when each card entered its step through idx_transitions_item (EO-570)", () => {
    const plan = planOf(handle, onlyStatement(handle, "transitions", () => stepEntryTimes(handle.db, [itemId, itemId])));
    expect(plan.join("\n")).toMatch(/SEARCH transitions USING INDEX idx_transitions_item \(item_id=\?\)/);
    expect(plan.filter((detail) => detail.startsWith("SCAN"))).toEqual([]);
  });

  it("reads the record's transcript feed, and where it ends, through idx_run_events_feed (EO-618)", () => {
    const feed = statementsOf(handle, () => {
      listRunEventsSince(handle.db, { ts: 0, runId: "", seq: -1 }, 10);
    });
    expect(planOf(handle, feed[0]!).join("\n")).toContain("idx_run_events_feed");

    const item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo" });
    const run = createRun(handle.db, { itemId: item.id, agentId: null, action: "wait_until" });
    const append = statementsOf(handle, () => {
      appendSyncedRunEvents(handle.db, run.id, "anna", [{ seq: 1, ts: 1, type: "output", payload: {} }]);
    });
    const head = append.find((statement) => statement.includes("coalesce") && statement.startsWith("select"));
    expect(planOf(handle, head!).join("\n")).toContain("idx_run_events_feed");
    expect(planOf(handle, head!).join("\n")).not.toContain("TEMP B-TREE");
  });

  it("has an index on each column the hot reads filter by, as schema.ts declares them", () => {
    const indexes = clientOf(handle)
      .prepare("SELECT name, tbl_name AS tableName FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'")
      .all() as { name: string; tableName: string }[];
    const columnsOf = (name: string): string[] =>
      (clientOf(handle).prepare(`PRAGMA index_info(${name})`).all() as { name: string }[]).map((column) => column.name);
    const byName = new Map(indexes.map((index) => [index.name, { table: index.tableName, columns: columnsOf(index.name) }]));

    expect(byName.get("idx_runs_item")).toEqual({ table: "runs", columns: ["item_id"] });
    expect(byName.get("idx_runs_status")).toEqual({ table: "runs", columns: ["status"] });
    expect(byName.get("idx_transitions_item")).toEqual({ table: "transitions", columns: ["item_id"] });
    expect(byName.get("idx_items_project")).toEqual({ table: "items", columns: ["project_id"] });
    expect(byName.get("idx_items_parent")).toEqual({ table: "items", columns: ["parent_id"] });
    expect(byName.get("idx_item_deps_depends_on")).toEqual({ table: "item_deps", columns: ["depends_on_id"] });

    // And schema.ts says the same, so a query written against the Drizzle
    // tables and the database the migrations build agree on what exists.
    const declared = [items, itemDeps, runs, transitions].flatMap((table) => {
      const config = getTableConfig(table);
      return config.indexes.map((index) => ({
        name: index.config.name,
        table: config.name,
        columns: index.config.columns.map((column) => (column as { name: string }).name),
      }));
    });
    for (const name of ["idx_runs_item", "idx_runs_status", "idx_transitions_item", "idx_items_project", "idx_items_parent", "idx_item_deps_depends_on"]) {
      const index = declared.find((entry) => entry.name === name);
      expect(index, name).toBeDefined();
      expect({ table: index!.table, columns: index!.columns }).toEqual(byName.get(name));
    }
  });
});
