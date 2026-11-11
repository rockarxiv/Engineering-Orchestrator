import type { Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { listProjects } from "../db/repos/index.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { createItemTypeCommand, listItemTypesCommand } from "../ipc/itemTypeCommands.js";
import { clearHandlerRegistry, registerHandler } from "../ipc/registry.js";
import { TOOLS } from "./catalog.js";
import { answerToolCall } from "./server.js";

/**
 * `item_types_list` (EO-523): a project's item types, read through
 * `itemTypes:list` on the one MCP host both backends' agents are served
 * — the assistant's agent on `eo_admin`, whichever backend it runs on.
 * Each type with its fields, and whether a pack ships it.
 */

let handle: DbHandle;
let projectId: Uuid;
let otherProjectId: Uuid;

beforeEach(() => {
  handle = openMigratedTestDb();
  registerHandler("itemTypes:list", (payload) => listItemTypesCommand(handle.db, payload), { exposeErrorDetails: true });
  attachWorkspace(handle.db, { name: "support", keyPrefix: "SUP", repoPath: "/tmp/eo-item-type-tools", baseBranch: "main" });
  attachWorkspace(handle.db, { name: "other", keyPrefix: "OTH", repoPath: "/tmp/eo-item-type-tools-other", baseBranch: "main" });
  [projectId, otherProjectId] = listProjects(handle.db).map((project) => project.id) as [Uuid, Uuid];
  createItemTypeCommand(handle.db, {
    projectId,
    label: "Case",
    plural: "Cases",
    container: false,
    fields: [
      { name: "Customer name", kind: "string", required: true },
      { name: "priority", kind: "number", required: false },
    ],
  });
});

afterEach(() => {
  clearHandlerRegistry();
  handle.close();
});

function call(args: Record<string, unknown>, audience: "admin" | "external" = "admin") {
  return answerToolCall({ name: "item_types_list", arguments: args }, audience, false);
}

function textOf(result: Awaited<ReturnType<typeof call>>): string {
  const first = result.content[0];
  return first?.type === "text" ? first.text : "";
}

describe("item_types_list", () => {
  it("is a read over itemTypes:list, offered without destructive operations, paging the types", () => {
    const spec = TOOLS.find((tool) => tool.name === "item_types_list");
    expect(spec?.kind).toBe("read");
    expect(spec?.channels).toEqual(["itemTypes:list"]);
    expect(spec?.list).toBe("types");
    expect(spec?.adminOnly).toBeFalsy();
    expect(Object.keys((spec?.inputSchema["properties"] ?? {}) as Record<string, unknown>)).toContain("projectId");
  });

  it("lists the project's types with their fields, and says which are a pack's", async () => {
    const result = await call({ projectId });
    expect(result.isError).toBe(false);
    const text = textOf(result);
    const made = listItemTypesCommand(handle.db, { projectId }).types.find((type) => type.slug === "case")!;

    expect(text).toContain(`- Case / Cases (id: ${made.id}, filed as \`case\`, is the work, 0 item(s) of it)`);
    expect(text).toContain("made here — its label, plural, fields and container flag can change");
    expect(text).toContain("  - field `customer_name` (string, required)");
    expect(text).toContain("  - field `priority` (number, optional)");

    const types = (result.structuredContent as { types: { packSlug: string; slug: string; specShape: unknown }[] }).types;
    expect(types.find((type) => type.slug === "case")).toMatchObject({ packSlug: "local" });
    // A pack's types, where the project has them, say what of them may change (EO-735).
    const shipped = types.filter((type) => type.packSlug !== "local");
    expect(shipped.length).toBeGreaterThan(0);
    for (const type of shipped) expect(text).toContain(
        `a ${type.packSlug} pack's type — its label and plural can change and optional fields can be added beside the pack's own; the pack's fields and its container flag cannot change, and it cannot be deleted`,
      );
  });

  it("counts the items of a type", async () => {
    createTestItem(handle.db, { type: "case", title: "Refund", stepId: "todo", projectId });
    const text = textOf(await call({ projectId }));
    expect(text).toContain("filed as `case`, is the work, 1 item(s) of it)");
  });

  it("reads one project's types and not another's", async () => {
    const other = textOf(await call({ projectId: otherProjectId }));
    expect(other).not.toContain("Case / Cases");
  });

  it("is offered to the external listener as well as the assistant's own server", async () => {
    expect((await call({ projectId }, "external")).isError).toBe(false);
  });

  it("narrows with fields and where like every other list tool", async () => {
    const result = await call({ projectId, where: [{ path: "packSlug", op: "eq", value: "local" }], fields: ["types.slug", "types.label"] });
    expect(result.structuredContent).toEqual({ types: [{ slug: "case", label: "Case" }], total: 1, returned: 1, nextOffset: null });
  });
});
