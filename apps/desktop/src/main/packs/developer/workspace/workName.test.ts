import { gitExtension, jiraExtension, type ItemExtensions } from "@eo/core";
import { describe, expect, it } from "vitest";
import { workNameOf } from "./workName.js";

/**
 * What names an item's work (EO-638): first match wins — its own
 * Reference, its own Jira key, its feature's Reference, its EO key.
 */
function item(key: string, { reference = null, jiraKey = null }: { reference?: string | null; jiraKey?: string | null } = {}) {
  const extensions: ItemExtensions = { ...gitExtension({ reference }), ...jiraExtension({ key: jiraKey }) };
  return { key, extensions };
}

describe("workNameOf", () => {
  it("prefers the item's own Reference over everything", () => {
    expect(workNameOf(item("EO-45", { reference: "PROJ-1", jiraKey: "KAN-9" }), item("EO-40", { reference: "PROJ-2" }))).toEqual({ kind: "reference", value: "PROJ-1" });
  });

  it("prefers the item's own Jira key over its feature's Reference", () => {
    expect(workNameOf(item("EO-45", { jiraKey: "KAN-9" }), item("EO-40", { reference: "PROJ-2" }))).toEqual({ kind: "jira", value: "KAN-9" });
  });

  it("reads the feature's Reference when the item has neither", () => {
    expect(workNameOf(item("EO-45"), item("EO-40", { reference: "PROJ-2" }))).toEqual({ kind: "reference", value: "PROJ-2" });
  });

  it("does not take the feature's Jira key", () => {
    expect(workNameOf(item("EO-45"), item("EO-40", { jiraKey: "KAN-1" }))).toEqual({ kind: "key", value: "EO-45" });
  });

  it("falls back to the EO key, with or without a parent", () => {
    expect(workNameOf(item("EO-45"), null)).toEqual({ kind: "key", value: "EO-45" });
    expect(workNameOf(item("EO-45"), item("EO-40"))).toEqual({ kind: "key", value: "EO-45" });
  });
});
