import type { Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../client.js";
import { createTestItem, openMigratedTestDb } from "../testHelpers.js";
import { addDependency, listDependencies, removeDependency } from "./itemDepsRepo.js";

describe("itemDepsRepo", () => {
  let handle: DbHandle;

  beforeEach(() => {
    handle = openMigratedTestDb();
  });

  afterEach(() => {
    handle.close();
  });

  it("adds, lists, and removes a dependency edge", () => {
    const a = createTestItem(handle.db, { type: "story", title: "A", stepId: "todo" });
    const b = createTestItem(handle.db, { type: "story", title: "B", stepId: "todo" });

    addDependency(handle.db, a.id, b.id);
    expect(listDependencies(handle.db, a.id)).toEqual([{ itemId: a.id, dependsOnId: b.id }]);

    removeDependency(handle.db, a.id, b.id);
    expect(listDependencies(handle.db, a.id)).toEqual([]);
  });

  it("enforces the depends_on_id foreign key", () => {
    const a = createTestItem(handle.db, { type: "story", title: "A", stepId: "todo" });
    expect(() => addDependency(handle.db, a.id, "not-a-real-item-id" as Uuid)).toThrow();
  });

  it("refuses to persist an edge that would create a direct cycle", () => {
    const a = createTestItem(handle.db, { type: "story", title: "A", stepId: "todo" });
    const b = createTestItem(handle.db, { type: "story", title: "B", stepId: "todo" });

    addDependency(handle.db, a.id, b.id); // a depends on b
    expect(() => addDependency(handle.db, b.id, a.id)).toThrow(/cycle/i);
    expect(listDependencies(handle.db, b.id)).toEqual([]);
  });

  it("refuses to persist an edge that would create an indirect cycle through a third item", () => {
    const a = createTestItem(handle.db, { type: "story", title: "A", stepId: "todo" });
    const b = createTestItem(handle.db, { type: "story", title: "B", stepId: "todo" });
    const c = createTestItem(handle.db, { type: "story", title: "C", stepId: "todo" });

    addDependency(handle.db, a.id, b.id); // a -> b
    addDependency(handle.db, b.id, c.id); // b -> c

    // c -> a would close the loop a -> b -> c -> a.
    expect(() => addDependency(handle.db, c.id, a.id)).toThrow(/cycle/i);
    expect(listDependencies(handle.db, c.id)).toEqual([]);
  });
});
