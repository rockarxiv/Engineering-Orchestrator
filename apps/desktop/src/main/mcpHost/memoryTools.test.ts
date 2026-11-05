import { ipcContract, MemorySearchRequestSchema, type Agent, type MemoryConsolidateNowResult, type MemoryEntryView, type MemoryScope, type MemorySource, type Uuid } from "@eo/core";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../db/client.js";
import { addMemory, applyConsolidation, createRun, editMemory, listAgents, noteMemory, projectForWorkspace, restoreConsolidation, startConsolidation } from "../db/repos/index.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { resolveItemKey } from "../ipc/domainQueries.js";
import { consolidateNowCommand, getMemoryCommand, listConsolidationsCommand, searchMemoryCommand } from "../ipc/memoryCommands.js";
import { clearHandlerRegistry, registerHandler } from "../ipc/registry.js";
import { recordFor } from "../record/localRecord.js";
import { TOOLS, type ToolSpec } from "./catalog.js";
import { guideNamed } from "./guides.js";
import { RESOLVE_KEY_CHANNEL } from "./itemKeys.js";
import { NARROWING_KEYS } from "./narrow.js";
import { answerToolCall } from "./server.js";

/**
 * `memories_search`, `memory_get` and `memory_consolidations_list`
 * (EO-545), through the door every client's call comes in by: read-only
 * tools over their own IPC channels, with the shared narrowing
 * parameters, an item's key where they take an item, and the answers in
 * the boundary's spelling.
 */

const PERSON: MemorySource = { type: "person", personId: null };
const CAPS = { maxEntries: 200, maxChars: 40_000 };

let handle: DbHandle;
let project: MemoryScope;
let workspace: MemoryScope;
let itemId: Uuid;
let runId: Uuid;

beforeEach(() => {
  handle = openMigratedTestDb();
  const record = recordFor(handle.db);
  const opts = { exposeErrorDetails: true };
  registerHandler("memory:search", (payload) => searchMemoryCommand(handle.db, payload), opts);
  registerHandler("memory:get", (payload) => getMemoryCommand(handle.db, record, payload), opts);
  registerHandler("memory:consolidations", (payload) => listConsolidationsCommand(record, payload), opts);
  registerHandler("items:resolveKey", (payload) => resolveItemKey(handle.db, payload), opts);

  const w = attachWorkspace(handle.db, { name: "app", keyPrefix: "APP", repoPath: "/tmp/app" });
  const projectId = projectForWorkspace(handle.db, w.id)!.id as Uuid;
  project = { kind: "project", id: projectId };
  workspace = { kind: "workspace", id: w.id };
  itemId = createTestItem(handle.db, { type: "story", title: "Fix Windows CI", stepId: "todo", projectId, workspaceId: w.id }).id;
  const agent = listAgents(handle.db).find((candidate: Agent) => candidate.role === "implementer")!;
  runId = createRun(handle.db, { itemId, agentId: agent.id, action: "implement", status: "succeeded" }).id;
});

afterEach(() => {
  clearHandlerRegistry();
  handle.close();
});

function add(scope: MemoryScope, body: string, now: number, source: MemorySource = PERSON): MemoryEntryView {
  const written = addMemory(handle.db, { scope, body, source, now });
  if (!written.ok) throw new Error(written.problem);
  return written.entry;
}

function tool(name: string): ToolSpec {
  const found = TOOLS.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`no tool named ${name}`);
  return found;
}

function call(name: string, args: Record<string, unknown>) {
  return answerToolCall({ name, arguments: args }, "admin", true);
}

function textOf(result: Awaited<ReturnType<typeof call>>): string {
  const first = result.content[0];
  return first?.type === "text" ? first.text : "";
}

function propertiesOf(spec: ToolSpec): string[] {
  return Object.keys((spec.inputSchema["properties"] ?? {}) as Record<string, unknown>);
}

describe("the three memory tools in the catalogue", () => {
  it.each([
    ["memories_search", "memory:search", "entries"],
    ["memory_get", "memory:get", undefined],
    ["memory_consolidations_list", "memory:consolidations", "consolidations"],
  ] as const)("%s is a read over %s, offered to every client, with the shared parameters", (name, channel, list) => {
    const spec = tool(name);
    expect(spec.kind).toBe("read");
    expect(spec.adminOnly).toBeUndefined();
    expect(spec.annotations).toEqual({ readOnlyHint: true, idempotentHint: true, openWorldHint: false });
    expect(spec.channels.filter((candidate) => candidate !== RESOLVE_KEY_CHANNEL)).toEqual([channel]);
    expect(spec.list).toBe(list);
    // Every narrowing parameter on a list, and fields on the one read with no single list.
    const properties = propertiesOf(spec);
    for (const key of list === undefined ? ["fields"] : NARROWING_KEYS) expect(properties, key).toContain(key);
  });

  it("dispatches through channels whose schemas are packages/core's", () => {
    for (const channel of ["memory:search", "memory:get", "memory:consolidations"] as const) expect(ipcContract[channel]).toBeDefined();
    // The channel holds a call to the core schema's rules.
    expect(ipcContract["memory:search"].request.safeParse({ query: "windo", state: "active" }).success).toBe(true);
    expect(ipcContract["memory:search"].request.safeParse({ state: "gone" }).success).toBe(false);
    expect(MemorySearchRequestSchema.safeParse({ query: "CI" }).success).toBe(false);
    expect(ipcContract["memory:search"].request.safeParse({ query: "CI" }).success).toBe(false);
  });

  it("offers memories_search every filter, and the item in EO's own word, a key accepted", () => {
    const spec = tool("memories_search");
    const properties = propertiesOf(spec);
    for (const filter of [
      "query",
      "scopeKind",
      "scopeId",
      "scopeName",
      "projectId",
      "sourceKind",
      "runId",
      "itemId",
      "extracted",
      "state",
      "contradictsRepositoryFile",
      "createdSince",
      "createdUntil",
      "updatedSince",
      "updatedUntil",
    ]) {
      expect(properties, filter).toContain(filter);
    }
    expect(properties).not.toContain("ticketId");
    expect(spec.channels).toContain(RESOLVE_KEY_CHANNEL);
    const state = ((spec.inputSchema["properties"] ?? {}) as Record<string, { enum?: string[] }>)["state"];
    expect(state?.enum).toEqual(["active", "retired", "consolidated"]);
  });
});

describe("memories_search", () => {
  beforeEach(() => {
    add(project, "Use pnpm, not npm.", 1000);
    add(workspace, "The test-windows shards on CI are flaky; reruns usually pass.", 2000, { type: "run", runId, itemId });
    add(workspace, "Lint before pushing.", 3000);
  });

  it("finds by approximate text, with a score, and answers in the boundary's spelling", async () => {
    const result = await call("memories_search", { query: "windo" });
    expect(result.isError).toBe(false);
    const entries = (result.structuredContent as { entries: Record<string, unknown>[] }).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      body: "The test-windows shards on CI are flaky; reruns usually pass.",
      scope: { kind: "workspace", id: workspace.id, name: "app" },
      source: { type: "run", runId, ticketId: itemId, ticketKey: "APP-1" },
      extracted: false,
      state: "active",
      contradictsRepositoryFile: false,
      score: expect.any(Number),
    });
    expect(textOf(result)).toContain("1 entry, best match first.");
    expect(textOf(result)).toContain("a run's note on APP-1");
    expect(textOf(result)).toContain("score ");
  });

  it("takes an item's key in itemId", async () => {
    const result = await call("memories_search", { itemId: "APP-1" });
    expect((result.structuredContent as { entries: unknown[] }).entries).toHaveLength(1);
    const unknown = await call("memories_search", { itemId: "APP-99" });
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toContain("APP-99");
  });

  it("narrows with fields, where, sort, limit and offset", async () => {
    const narrowed = await call("memories_search", { where: [{ path: "scope.kind", op: "eq", value: "workspace" }], sort: { path: "createdAt", direction: "asc" }, fields: ["entries.body"], limit: 1 });
    expect(narrowed.structuredContent).toEqual({ entries: [{ body: "The test-windows shards on CI are flaky; reruns usually pass." }], total: 2, returned: 1, nextOffset: 1 });
    const next = await call("memories_search", { where: [{ path: "scope.kind", op: "eq", value: "workspace" }], sort: { path: "createdAt", direction: "asc" }, fields: ["entries.body"], limit: 1, offset: 1 });
    expect(next.structuredContent).toMatchObject({ entries: [{ body: "Lint before pushing." }], nextOffset: null });
  });

  it("refuses a query with no word long enough to search on, and says what to do instead", async () => {
    const result = await call("memories_search", { query: "CI" });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("contains on body");
  });

  it("says so when nothing matches", async () => {
    const result = await call("memories_search", { query: "kubernetes" });
    expect(result.structuredContent).toEqual({ entries: [] });
    expect(textOf(result)).toBe("No memory entries match.");
  });
});

describe("memory_get", () => {
  it("answers an entry with the versions its edits replaced", async () => {
    const first = add(project, "Tests need Postgres 15.", 1000);
    const second = editMemory(handle.db, first.id, "Tests need Postgres 16.", PERSON, 2000);
    if (!second.ok) throw new Error(second.problem);

    const result = await call("memory_get", { id: second.entry.id });
    expect(result.isError).toBe(false);
    const data = result.structuredContent as { ok: boolean; entry: Record<string, unknown>; replaced: Record<string, unknown>[]; producedBy: unknown; retiredBy: unknown };
    expect(data.ok).toBe(true);
    expect(data.entry).toMatchObject({ id: second.entry.id, body: "Tests need Postgres 16.", state: "active" });
    expect(data.replaced.map((entry) => [entry["id"], entry["retiredReason"]])).toEqual([[first.id, "edited"]]);
    expect(data.producedBy).toBeNull();
    expect(data.retiredBy).toBeNull();
    expect(textOf(result)).toContain("Earlier versions it replaced through edits");
    expect(textOf(result)).toContain("Tests need Postgres 15.");
  });

  it("answers the consolidation that retired an entry, and the one that produced its replacement", async () => {
    const a = add(project, "CI on Windows is flaky.", 1000, { type: "run", runId, itemId });
    const b = add(project, "Windows shards need a rerun.", 1100, { type: "run", runId, itemId });
    const started = startConsolidation(handle.db, { scope: project, trigger: "cap", now: 2000 });
    const applied = applyConsolidation(handle.db, {
      id: started.id,
      sent: [a, b],
      answer: { retire: [], merge: [{ body: "Windows CI is flaky; rerun its shards once.", from: [a.id, b.id], contradictsRepositoryFile: false }], rewrite: [] },
      note: null,
      caps: CAPS,
      now: 2000,
    });
    if (!applied.ok) throw new Error(applied.problem);
    const writtenId = applied.consolidation.writtenIds[0]!;

    const retired = (await call("memory_get", { id: a.id })).structuredContent as Record<string, unknown>;
    expect(retired).toMatchObject({
      ok: true,
      entry: { id: a.id, state: "consolidated", consolidationId: started.id },
      producedBy: null,
      retiredBy: { id: started.id, replacedCount: 2, producedCount: 1, restored: false },
    });

    const produced = (await call("memory_get", { id: writtenId })).structuredContent as Record<string, unknown>;
    expect(produced).toMatchObject({ ok: true, replaced: [], producedBy: { id: started.id }, retiredBy: null });

    // Restored: the entry is back, and the consolidation that retired it says it was undone.
    expect(restoreConsolidation(handle.db, started.id, { caps: CAPS, now: 3000 }).ok).toBe(true);
    const back = (await call("memory_get", { id: a.id })).structuredContent as Record<string, unknown>;
    expect(back).toMatchObject({ entry: { state: "active" }, retiredBy: { id: started.id, restored: true, restoredAt: 3000 } });
  });

  it("answers a note with the entries it superseded, as it named them, and a plain entry with none (EO-594)", async () => {
    const gap = add(project, "Known gap: the record checks only a person's press.", 1000, { type: "run", runId, itemId });
    const twice = add(workspace, "The record checks only a person's press.", 1100, { type: "run", runId, itemId });
    const note = noteMemory(handle.db, {
      scope: project,
      body: "The record checks every press on a group step.",
      source: { type: "run", runId, itemId },
      now: 2000,
      replaces: [gap.id, twice.id],
      scopes: [project, workspace],
    });
    if (!note.ok) throw new Error(note.problem);

    const result = await call("memory_get", { id: note.entry.id });
    const data = result.structuredContent as { entry: Record<string, unknown>; replaced: unknown[]; superseded: Record<string, unknown>[] };
    expect(data.entry).toMatchObject({ supersededIds: [gap.id, twice.id], replacesId: null });
    expect(data.replaced).toEqual([]);
    expect(data.superseded.map((entry) => [entry["id"], entry["retiredReason"], entry["state"]])).toEqual([
      [gap.id, "superseded", "retired"],
      [twice.id, "superseded", "retired"],
    ]);
    expect(textOf(result)).toContain("Entries it superseded as a note, as it named them:");
    expect(textOf(result)).toContain("Known gap: the record checks only a person's press.");

    const plain = await call("memory_get", { id: twice.id });
    expect(plain.structuredContent).toMatchObject({ entry: { state: "retired", retiredReason: "superseded", supersededIds: [] }, superseded: [] });
    expect(textOf(plain)).toContain("It superseded no entry.");
  });

  it("narrows with fields, and says so when the id names no entry", async () => {
    const entry = add(project, "Use pnpm.", 1000);
    const narrowed = await call("memory_get", { id: entry.id, fields: ["entry.body"] });
    expect(narrowed.structuredContent).toEqual({ entry: { body: "Use pnpm." } });

    const missing = await call("memory_get", { id: "no-such-entry" });
    expect(textOf(missing)).toBe('No memory entry has the id "no-such-entry".');
  });
});

describe("memory_consolidations_list", () => {
  it("answers a scope's consolidations newest first, with their counts and whether each was restored", async () => {
    const a = add(project, "One.", 1000, { type: "run", runId, itemId });
    const b = add(project, "Two.", 1100, { type: "run", runId, itemId });
    const first = startConsolidation(handle.db, { scope: project, trigger: "cap", now: 2000 });
    const applied = applyConsolidation(handle.db, { id: first.id, sent: [a, b], answer: { retire: [], merge: [{ body: "One and two.", from: [a.id, b.id], contradictsRepositoryFile: false }], rewrite: [] }, note: null, caps: CAPS, now: 2000 });
    if (!applied.ok) throw new Error(applied.problem);
    expect(restoreConsolidation(handle.db, first.id, { caps: CAPS, now: 2500 }).ok).toBe(true);
    const second = startConsolidation(handle.db, { scope: project, trigger: "schedule", now: 3000 });

    const result = await call("memory_consolidations_list", { scope: project });
    expect(result.isError).toBe(false);
    const consolidations = (result.structuredContent as { consolidations: Record<string, unknown>[] }).consolidations;
    expect(consolidations.map((row) => [row["id"], row["status"], row["replacedCount"], row["producedCount"], row["restored"]])).toEqual([
      [second.id, "running", 0, 0, false],
      [first.id, "restored", 2, 1, true],
    ]);
    expect(consolidations[1]).toMatchObject({ startedAt: 2000, finishedAt: 2000, restoredAt: 2500, trigger: "cap" });
    expect(textOf(result)).toContain("replaced 2, produced 1 · restored");

    const narrowed = await call("memory_consolidations_list", { scope: project, where: [{ path: "restored", op: "eq", value: true }], fields: ["consolidations.id"] });
    expect(narrowed.structuredContent).toMatchObject({ consolidations: [{ id: first.id }], total: 1 });
  });

  it("answers every one of a scope's consolidations, not the newest 200 — paged, filtered, and an old entry's links found", async () => {
    const old = add(project, "Old.", 1, { type: "run", runId, itemId });
    const oldest = startConsolidation(handle.db, { scope: project, trigger: "cap", now: 10 });
    const applied = applyConsolidation(handle.db, { id: oldest.id, sent: [old], answer: { retire: [], merge: [], rewrite: [{ id: old.id, body: "Old, merged.", contradictsRepositoryFile: false }] }, note: null, caps: CAPS, now: 10 });
    if (!applied.ok) throw new Error(applied.problem);
    for (let at = 1; at <= 250; at += 1) startConsolidation(handle.db, { scope: project, trigger: "schedule", now: 100 + at });

    const last = await call("memory_consolidations_list", { scope: project, fields: ["consolidations.id", "consolidations.startedAt"], limit: 10, offset: 245 });
    const page = last.structuredContent as { consolidations: { id: string; startedAt: number }[]; total: number; returned: number; nextOffset: number | null };
    expect(page.total).toBe(251);
    expect(page.returned).toBe(6);
    expect(page.nextOffset).toBeNull();
    expect(page.consolidations.map((row) => row.startedAt)).toEqual([105, 104, 103, 102, 101, 10]);
    expect(page.consolidations[5]!.id).toBe(oldest.id);

    // Narrowed over the whole list: the one that replaced anything is the oldest of all.
    const filtered = await call("memory_consolidations_list", { scope: project, where: [{ path: "replacedCount", op: "gt", value: 0 }], fields: ["consolidations.id"] });
    expect(filtered.structuredContent).toMatchObject({ consolidations: [{ id: oldest.id }], total: 1 });

    // And an entry it retired, and the one it wrote, still name it.
    expect((await call("memory_get", { id: old.id })).structuredContent).toMatchObject({ retiredBy: { id: oldest.id, replacedCount: 1, producedCount: 1 } });
    expect((await call("memory_get", { id: applied.consolidation.writtenIds[0]! })).structuredContent).toMatchObject({ producedBy: { id: oldest.id } });
  });

  it("says so for a scope never consolidated", async () => {
    const result = await call("memory_consolidations_list", { scope: workspace });
    expect(textOf(result)).toBe("This scope has never been consolidated.");
  });
});

describe("memory_consolidate_now (EO-589)", () => {
  /** An engine whose consolidator answers `answer`, and remembers what it was asked. */
  function engineAnswering(answer: MemoryConsolidateNowResult) {
    const consolidateMemoryNow = vi.fn((_scope: MemoryScope) => answer);
    registerHandler("memory:consolidateNow", (payload) => consolidateNowCommand({ consolidateMemoryNow }, payload), { exposeErrorDetails: true });
    return consolidateMemoryNow;
  }

  it("is a write over memory:consolidateNow, beside memory_consolidations_list in the host's tool list", () => {
    const spec = tool("memory_consolidate_now");
    expect(spec.kind).toBe("write");
    expect(spec.channels).toEqual(["memory:consolidateNow"]);
    expect(ipcContract["memory:consolidateNow"]).toBeDefined();
    expect(propertiesOf(spec)).toContain("scope");
    const names = TOOLS.map((candidate) => candidate.name);
    expect(names.indexOf("memory_consolidate_now")).toBe(names.indexOf("memory_consolidations_list") + 1);
  });

  it("asks the channel with the scope as memories_search answers it, renders the answer's sentence and points to memory_consolidations_list", async () => {
    const asked = engineAnswering({ outcome: "queued", behind: "pipeline", message: 'Consolidation of the project "app" is queued behind pipeline work.' });
    const result = await call("memory_consolidate_now", { scope: project });
    expect(asked).toHaveBeenCalledWith(project);
    expect(result.isError).toBe(false);
    expect(textOf(result)).toContain('Consolidation of the project "app" is queued behind pipeline work.');
    expect(textOf(result)).toContain("memory_consolidations_list");
    expect(result.structuredContent).toMatchObject({ outcome: "queued", behind: "pipeline" });
  });

  it("renders a refusal as its sentence alone", async () => {
    engineAnswering({ outcome: "refused", reason: "paused", message: "EO is paused, and no consolidation starts while it is, so none was queued. Resume EO and ask again." });
    const result = await call("memory_consolidate_now", { scope: workspace });
    expect(textOf(result)).toBe("EO is paused, and no consolidation starts while it is, so none was queued. Resume EO and ask again.");
  });

  it("is refused where no engine runs", async () => {
    registerHandler("memory:consolidateNow", (payload) => consolidateNowCommand(undefined, payload), { exposeErrorDetails: true });
    const result = await call("memory_consolidate_now", { scope: workspace });
    expect(textOf(result)).toContain("No engine runs in this EO process");
  });
});

describe("all three are read-only", () => {
  it("leave every entry and consolidation exactly as they were", async () => {
    const entry = add(project, "Windows CI is flaky.", 1000);
    startConsolidation(handle.db, { scope: project, trigger: "cap", now: 2000 });
    const snapshot = () =>
      handle.db.all(
        sql`select (select group_concat(id || ':' || updated_at || ':' || coalesce(retired_at, '')) from memories) as entries, (select group_concat(id || ':' || status) from memory_consolidations) as consolidations, (select count(*) from memories_fts) as indexed`,
      );
    const before = snapshot();
    await call("memories_search", { query: "windows" });
    await call("memories_search", { state: "active", fields: ["entries.id"] });
    await call("memory_get", { id: entry.id });
    await call("memory_consolidations_list", { scope: project });
    expect(snapshot()).toEqual(before);
  });
});

describe("the eo_orient guide", () => {
  it("describes the three tools, the filters and approximate search", () => {
    const flat = (guideNamed("eo_orient")?.body ?? "").replace(/\s+/g, " ");
    for (const name of ["memories_search", "memory_get", "memory_consolidations_list"]) expect(flat, name).toContain(`\`${name}\``);
    for (const term of [
      "query",
      "score",
      "scopeKind",
      "scopeId",
      "scopeName",
      "projectId",
      "sourceKind",
      "runId",
      "itemId",
      "extracted",
      "state",
      "contradictsRepositoryFile",
      "createdSince",
      "createdUntil",
      "updatedSince",
      "updatedUntil",
      "replacedCount",
      "producedCount",
      "restored",
    ]) {
      expect(flat, term).toContain(`\`${term}\``);
    }
    expect(flat).toContain("bm25");
  });
});
