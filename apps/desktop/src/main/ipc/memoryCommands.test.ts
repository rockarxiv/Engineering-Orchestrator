import { ipcContract } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { attachWorkspace, openMigratedTestDb } from "../db/testHelpers.js";
import { recordFor } from "../record/localRecord.js";
import { addMemoryCommand, editMemoryCommand, listMemoryCommand, restoreMemoryCommand, retireMemoryCommand } from "./memoryCommands.js";

/** The `memory:*` channels (EO-478): list, add, edit, retire and restore, and nothing ever deleted. */
describe("the memory channels", () => {
  let handle: DbHandle;
  let scope: { kind: "workspace"; id: string };

  beforeEach(() => {
    handle = openMigratedTestDb();
    scope = { kind: "workspace", id: attachWorkspace(handle.db, { keyPrefix: "P", name: "api", repoPath: "/tmp/api" }).id };
  });

  afterEach(() => handle.close());

  it("adds a person's entry, edits it into a new row, retires and restores it, and lists the history", async () => {
    const record = recordFor(handle.db);
    const added = await addMemoryCommand(record, { scope, body: "Tests need Postgres 15." });
    if (!added.ok) throw new Error(added.problem);
    expect(added.entry.source).toEqual({ type: "person", personId: null });

    const edited = await editMemoryCommand(record, { id: added.entry.id, body: "Tests need Postgres 16." });
    if (!edited.ok) throw new Error(edited.problem);
    expect(edited.entry.id).not.toBe(added.entry.id);

    expect(listMemoryCommand(handle.db, { scope }).entries.map((entry) => entry.body)).toEqual(["Tests need Postgres 16."]);
    const history = listMemoryCommand(handle.db, { scope, includeRetired: true }).entries;
    expect(history.map((entry) => [entry.body, entry.retiredReason])).toEqual([
      ["Tests need Postgres 16.", null],
      ["Tests need Postgres 15.", "edited"],
    ]);

    expect(await retireMemoryCommand(record, { id: edited.entry.id })).toMatchObject({ ok: true, entry: { retiredReason: "retired" } });
    expect(listMemoryCommand(handle.db, { scope }).entries).toEqual([]);
    expect(await restoreMemoryCommand(record, { id: edited.entry.id })).toMatchObject({ ok: true, entry: { retiredAt: null } });
    expect(listMemoryCommand(handle.db, { scope, includeRetired: true }).entries).toHaveLength(2);
  });

  it("holds requests to their schemas in packages/core", () => {
    expect(ipcContract["memory:add"].request.safeParse({ scope, body: "   " }).success).toBe(false);
    expect(ipcContract["memory:add"].request.safeParse({ scope: { kind: "repository", id: "x" }, body: "x" }).success).toBe(false);
    expect(ipcContract["memory:edit"].request.safeParse({ id: "e", body: "x".repeat(4_001) }).success).toBe(false);
    expect(ipcContract["memory:list"].request.safeParse({ scope }).success).toBe(true);
    expect(ipcContract["memory:retire"].response.safeParse({ ok: false, problem: "That entry is already retired." }).success).toBe(true);
  });
});
