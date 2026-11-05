import { sectionLockedMessage, type MemoryConsolidationAnswer, type MemoryEntryView, type MemoryScope, type SectionLock, type SideCallResult, type Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../db/client.js";
import {
  addMemory,
  applyConsolidation,
  createRun,
  getMemory,
  getMemorySearchEntry,
  listAgents,
  listMemories,
  noteMemory,
  projectForWorkspace,
  retireMemory,
  startConsolidation,
} from "../db/repos/index.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import {
  addMemoryCommand,
  editMemoryCommand,
  restoreConsolidationCommand,
  restoreMemoryCommand,
  retireMemoryCommand,
  searchMemoryCommand,
} from "../ipc/memoryCommands.js";
import { clearHandlerRegistry, registerHandler } from "../ipc/registry.js";
import { MEMORY_PROPOSE_SKILLS_SYSTEM } from "../memory/consolidation.js";
import { createMemoryConsolidator } from "../memory/consolidator.js";
import { recordFor } from "../record/localRecord.js";
import type { SideCallRequest } from "../sideCalls/sideCall.js";
import { TOOLS, type ToolSpec } from "./catalog.js";
import { guideNamed } from "./guides.js";
import { answerToolCall } from "./server.js";

/**
 * `memory_add`, `memory_edit`, `memory_retire`, `memory_restore` and
 * `memory_consolidation_restore` (EO-546), through the door every
 * client's call comes in by: write tools over the memory panel's own
 * channels, writing a person's entries, each answering with what it left
 * or the sentence saying why nothing changed.
 */

const CAPS = { maxEntries: 200, maxChars: 40_000 };
const WRITE_TOOLS = [
  ["memory_add", ["memory:add"]],
  ["memory_edit", ["memory:edit"]],
  ["memory_retire", ["memory:retire"]],
  ["memory_restore", ["memory:restore"]],
  ["memory_consolidation_restore", ["memory:restoreConsolidation", "memory:search"]],
] as const;

let handle: DbHandle;
let project: MemoryScope;
let workspace: MemoryScope;
let itemId: Uuid;
let runId: Uuid;

function registerMemoryHandlers(options: { sectionLock?: () => SectionLock | null } = {}): void {
  const record = recordFor(handle.db);
  const opts = { exposeErrorDetails: true, ...(options.sectionLock ? { sectionLock: options.sectionLock } : {}) };
  registerHandler("memory:add", (payload) => addMemoryCommand(record, payload), opts);
  registerHandler("memory:edit", (payload) => editMemoryCommand(record, payload), opts);
  registerHandler("memory:retire", (payload) => retireMemoryCommand(record, payload), opts);
  registerHandler("memory:restore", (payload) => restoreMemoryCommand(record, payload), opts);
  registerHandler("memory:restoreConsolidation", (payload) => restoreConsolidationCommand(handle.db, record, payload), opts);
  registerHandler("memory:search", (payload) => searchMemoryCommand(handle.db, payload), { exposeErrorDetails: true });
}

beforeEach(() => {
  handle = openMigratedTestDb();
  const w = attachWorkspace(handle.db, { name: "app", keyPrefix: "APP", repoPath: "/tmp/eo-546-app" });
  const projectId = projectForWorkspace(handle.db, w.id)!.id as Uuid;
  project = { kind: "project", id: projectId };
  workspace = { kind: "workspace", id: w.id };
  itemId = createTestItem(handle.db, { type: "story", title: "Fix Windows CI", stepId: "todo", projectId, workspaceId: w.id }).id;
  const agent = listAgents(handle.db).find((candidate) => candidate.role === "implementer")!;
  runId = createRun(handle.db, { itemId, agentId: agent.id, action: "implement", status: "succeeded" }).id;
});

afterEach(() => {
  clearHandlerRegistry();
  handle.close();
});

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

function byAgent(scope: MemoryScope, body: string, now: number): MemoryEntryView {
  const written = addMemory(handle.db, { scope, body, source: { type: "run", runId, itemId }, now });
  if (!written.ok) throw new Error(written.problem);
  return written.entry;
}

describe("the five memory write tools in the catalogue", () => {
  it.each(WRITE_TOOLS)("%s is a write over %j, offered to every client, and warns of nothing destroyed", (name, channels) => {
    const spec = tool(name);
    expect(spec.kind).toBe("write");
    expect(spec.adminOnly).toBeUndefined();
    expect(spec.annotations.destructiveHint).toBeUndefined();
    expect(spec.annotations.readOnlyHint).toBeUndefined();
    expect(spec.channels).toEqual(channels);
    // A write takes no narrowing parameters.
    expect(spec.narrowing).toBeUndefined();
  });

  it("advertises what each takes, and the body's limit", () => {
    const properties = (name: string) => Object.keys((tool(name).inputSchema["properties"] ?? {}) as Record<string, unknown>).sort();
    expect(properties("memory_add")).toEqual(["body", "scope"]);
    expect(properties("memory_edit")).toEqual(["body", "id"]);
    expect(properties("memory_retire")).toEqual(["id"]);
    expect(properties("memory_restore")).toEqual(["id"]);
    expect(properties("memory_consolidation_restore")).toEqual(["consolidationId"]);
    const body = (tool("memory_add").inputSchema["properties"] as Record<string, { maxLength?: number }>)["body"];
    expect(body?.maxLength).toBe(4_000);
  });

  it("are described in the eo_orient guide", () => {
    const flat = (guideNamed("eo_orient")?.body ?? "").replace(/\s+/g, " ");
    for (const [name] of WRITE_TOOLS) expect(flat).toContain(`\`${name}\``);
    expect(flat).toContain("consolidation never rewrites it");
    expect(flat).toContain("at most 4,000 characters");
  });
});

describe("memory_add", () => {
  beforeEach(() => registerMemoryHandlers());

  it("writes a person's entry, and answers with it as it now stands", async () => {
    const result = await call("memory_add", { scope: workspace, body: "  Windows CI shards are flaky; rerun them once.  " });

    expect(result.isError).toBe(false);
    const entry = (result.structuredContent as { ok: boolean; entry: MemoryEntryView }).entry;
    expect(entry).toMatchObject({ scope: workspace, body: "Windows CI shards are flaky; rerun them once.", source: { type: "person", personId: null }, retiredAt: null });
    expect(getMemory(handle.db, entry.id)).toMatchObject({ source: { type: "person", personId: null } });
    expect(textOf(result)).toContain("as a person's entry");
    expect(textOf(result)).toContain(entry.id);
    expect(textOf(result)).toContain("Windows CI shards are flaky; rerun them once.");
  });

  it("refuses an unknown scope in a sentence, and writes nothing", async () => {
    const result = await call("memory_add", { scope: { kind: "project", id: "nope" }, body: "Something." });

    expect(result.isError).toBe(false);
    expect(textOf(result)).toBe('No project has the id "nope".');
    expect(result.structuredContent).toEqual({ ok: false, problem: 'No project has the id "nope".' });
  });

  it("refuses a body over 4,000 characters in a sentence, before anything is dispatched, and writes nothing", async () => {
    const result = await call("memory_add", { scope: project, body: "x".repeat(4_001) });

    expect(result.isError).toBe(false);
    expect(textOf(result)).toBe("The entry is 4,001 characters, and memory_add writes at most 4,000. Nothing was written; shorten it, or split it into more than one entry.");
    expect(result.structuredContent).toEqual({ ok: false, problem: textOf(result) });
    expect(listMemories(handle.db, project, { includeRetired: true })).toEqual([]);
  });

  it("takes exactly 4,000 characters, counted after trimming", async () => {
    const result = await call("memory_add", { scope: project, body: ` ${"x".repeat(4_000)} ` });
    expect(result.structuredContent).toMatchObject({ ok: true, entry: { body: "x".repeat(4_000) } });
  });
});

describe("memory_edit", () => {
  beforeEach(() => registerMemoryHandlers());

  it("retires the old version and writes a new person's entry that names it, answering with the new one", async () => {
    const old = byAgent(project, "Releases go out on Tuesdays.", 1000);

    const result = await call("memory_edit", { id: old.id, body: "Releases go out on Wednesdays." });

    expect(result.isError).toBe(false);
    const entry = (result.structuredContent as { entry: MemoryEntryView }).entry;
    expect(entry).toMatchObject({ body: "Releases go out on Wednesdays.", source: { type: "person", personId: null }, retiredAt: null });
    expect(getMemory(handle.db, old.id)).toMatchObject({ retiredReason: "edited" });
    expect(getMemorySearchEntry(handle.db, entry.id)?.replacesId).toBe(old.id);
    expect(textOf(result)).toContain("The old version is retired");
  });

  it("refuses an unknown id, a retired entry and an over-long body in sentences, and changes nothing", async () => {
    const entry = byAgent(project, "Use pnpm.", 1000);
    const before = listMemories(handle.db, project, { includeRetired: true });

    const unknown = await call("memory_edit", { id: "nope", body: "Use npm." });
    expect(unknown.isError).toBe(false);
    expect(textOf(unknown)).toBe('No memory entry has the id "nope".');

    const long = await call("memory_edit", { id: entry.id, body: "y".repeat(4_200) });
    expect(long.isError).toBe(false);
    expect(textOf(long)).toBe("The entry is 4,200 characters, and memory_edit writes at most 4,000. Nothing was written; shorten it, or split it into more than one entry.");
    expect(listMemories(handle.db, project, { includeRetired: true })).toEqual(before);

    await call("memory_retire", { id: entry.id });
    const retired = await call("memory_edit", { id: entry.id, body: "Use npm." });
    expect(textOf(retired)).toBe("That entry is retired. Restore it before editing it.");
  });
});

describe("memory_retire and memory_restore", () => {
  beforeEach(() => registerMemoryHandlers());

  it("retire stamps the entry and restore clears it, each answering with the entry; nothing is deleted", async () => {
    const entry = byAgent(project, "Use pnpm.", 1000);

    const retired = await call("memory_retire", { id: entry.id });
    expect(retired.isError).toBe(false);
    expect(retired.structuredContent).toMatchObject({ ok: true, entry: { id: entry.id, retiredReason: "retired" } });
    expect((retired.structuredContent as { entry: MemoryEntryView }).entry.retiredAt).not.toBeNull();
    expect(listMemories(handle.db, project, { includeRetired: true }).map((row) => row.id)).toEqual([entry.id]);

    const again = await call("memory_retire", { id: entry.id });
    expect(textOf(again)).toBe("That entry is already retired.");

    const restored = await call("memory_restore", { id: entry.id });
    expect(restored.structuredContent).toMatchObject({ ok: true, entry: { id: entry.id, retiredAt: null, retiredReason: null } });
    expect(textOf(restored)).toContain("Runs are given it again.");

    expect(textOf(await call("memory_restore", { id: entry.id }))).toBe("That entry is not retired.");
    expect(textOf(await call("memory_retire", { id: "nope" }))).toBe('No memory entry has the id "nope".');
    expect(textOf(await call("memory_restore", { id: "nope" }))).toBe('No memory entry has the id "nope".');
  });

  it("restore returns an entry a note superseded to active, and leaves the note as it is (EO-594)", async () => {
    const wrong = byAgent(project, "Tests need Postgres 15.", 1000);
    const note = noteMemory(handle.db, { scope: project, body: "Tests need Postgres 16.", source: { type: "run", runId, itemId }, now: 2000, replaces: [wrong.id], scopes: [project] });
    if (!note.ok) throw new Error(note.problem);
    expect(getMemory(handle.db, wrong.id)).toMatchObject({ retiredReason: "superseded" });

    const restored = await call("memory_restore", { id: wrong.id });
    expect(restored.structuredContent).toMatchObject({ ok: true, entry: { id: wrong.id, retiredAt: null, retiredReason: null } });
    expect(listMemories(handle.db, project).map((row) => row.id).sort()).toEqual([wrong.id, note.entry.id].sort());
    expect(getMemorySearchEntry(handle.db, note.entry.id)?.supersededIds).toEqual([wrong.id]);
  });
});

describe("memory_consolidation_restore", () => {
  beforeEach(() => registerMemoryHandlers());

  it("reactivates what the consolidation retired and retires what it produced, answering with those entries", async () => {
    const a = byAgent(project, "Windows CI shard 3 is flaky.", 1000);
    const b = byAgent(project, "Rerun test-windows once before looking.", 1001);
    const untouched = byAgent(project, "Use pnpm.", 1002);
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
    const produced = listMemories(handle.db, project).find((entry) => entry.consolidationId === started.id)!;

    const result = await call("memory_consolidation_restore", { consolidationId: started.id });

    expect(result.isError).toBe(false);
    const data = result.structuredContent as { ok: boolean; restored: number; retired: number; consolidation: { id: string; status: string }; entries: { id: string; state: string }[] };
    expect(data).toMatchObject({ ok: true, restored: 2, retired: 1, consolidation: { id: started.id, status: "restored" } });
    expect(data.entries.map((entry) => [entry.id, entry.state]).sort()).toEqual(
      [
        [a.id, "active"],
        [b.id, "active"],
        [produced.id, "retired"],
      ].sort(),
    );
    expect(data.entries.map((entry) => entry.id)).not.toContain(untouched.id);
    expect(textOf(result)).toContain(`Restored the set from before consolidation ${started.id}: 2 entries are active again, and 1 it produced is retired.`);
    expect(textOf(result)).toContain("Windows CI shard 3 is flaky.");

    // Once only.
    const again = await call("memory_consolidation_restore", { consolidationId: started.id });
    expect(again.isError).toBe(false);
    expect(textOf(again)).toBe("That consolidation has already been restored.");
  });

  it("answers with the evidence a skill it proposed took, which is in neither of its lists, and nothing else of the scope", async () => {
    const a = byAgent(project, "Windows CI shard 3 is flaky.", 1000);
    const b = byAgent(project, "Rerun test-windows once before looking.", 1001);
    const evidence = byAgent(project, "To cut a release: tag, push, then publish the notes.", 1002);
    const untouched = byAgent(project, "Use pnpm.", 1003);
    const started = startConsolidation(handle.db, { scope: project, trigger: "cap", now: 2000 });
    const applied = applyConsolidation(handle.db, {
      id: started.id,
      sent: [a, b, evidence],
      // Evidence for a proposed skill is left out of every operation, so the consolidation neither retires nor writes it.
      answer: { retire: [], merge: [{ body: "Windows CI is flaky; rerun its shards once.", from: [a.id, b.id], contradictsRepositoryFile: false }], rewrite: [] },
      note: null,
      caps: CAPS,
      now: 2000,
    });
    if (!applied.ok) throw new Error(applied.problem);
    expect(applied.consolidation.retiredIds).not.toContain(evidence.id);
    expect(applied.consolidation.writtenIds).not.toContain(evidence.id);
    // A person saved the skill: what Save does to the evidence (skillProposals.ts).
    expect(retireMemory(handle.db, evidence.id, { reason: "moved_to_skill", consolidationId: started.id, now: 2500 }).ok).toBe(true);
    const produced = listMemories(handle.db, project).find((entry) => entry.consolidationId === started.id)!;

    const result = await call("memory_consolidation_restore", { consolidationId: started.id });

    const data = result.structuredContent as { restored: number; retired: number; changedIds: string[]; entries: { id: string; state: string }[] };
    expect(data).toMatchObject({ restored: 3, retired: 1 });
    expect(data.changedIds.sort()).toEqual([a.id, b.id, evidence.id, produced.id].sort());
    expect(data.entries.map((entry) => [entry.id, entry.state]).sort()).toEqual(
      [
        [a.id, "active"],
        [b.id, "active"],
        [evidence.id, "active"],
        [produced.id, "retired"],
      ].sort(),
    );
    expect(data.entries.map((entry) => entry.id)).not.toContain(untouched.id);
    expect(textOf(result)).toContain("To cut a release: tag, push, then publish the notes.");
    expect(textOf(result)).not.toContain("Use pnpm.");
  });

  it("refuses an unknown consolidation in a sentence", async () => {
    const result = await call("memory_consolidation_restore", { consolidationId: "nope" });
    expect(result.isError).toBe(false);
    expect(textOf(result)).toBe('No consolidation has the id "nope".');
    expect(result.structuredContent).toEqual({ ok: false, problem: 'No consolidation has the id "nope".' });
  });
});

describe("a locked section", () => {
  it("answers each write with the sentence that names the section, and writes nothing", async () => {
    const lock: SectionLock = { locked: true, section: "policy", publishedBy: "Anna" };
    registerMemoryHandlers({ sectionLock: () => lock });
    const entry = byAgent(project, "Use pnpm.", 1000);
    const before = listMemories(handle.db, project, { includeRetired: true });

    for (const [name, args] of [
      ["memory_add", { scope: project, body: "Something." }],
      ["memory_edit", { id: entry.id, body: "Something else." }],
      ["memory_retire", { id: entry.id }],
      ["memory_restore", { id: entry.id }],
      ["memory_consolidation_restore", { consolidationId: "any" }],
    ] as const) {
      const result = await call(name, args);
      expect(result.isError, name).toBe(true);
      expect(textOf(result), name).toBe(sectionLockedMessage(lock));
    }
    expect(listMemories(handle.db, project, { includeRetired: true })).toEqual(before);
  });
});

describe("an entry written through MCP and consolidation", () => {
  beforeEach(() => registerMemoryHandlers());

  it("is a person's, so it is never sent to a consolidation nor retired by one", async () => {
    const at = Date.now() - 3 * 24 * 60 * 60 * 1000;
    const agents = Array.from({ length: 8 }, (_, index) => byAgent(workspace, `Agent note ${index}`, at + index));
    const added = (await call("memory_add", { scope: workspace, body: "Added through MCP." })).structuredContent as { entry: MemoryEntryView };
    const target = byAgent(workspace, "Edited later.", at + 100);
    const edited = (await call("memory_edit", { id: target.id, body: "Edited through MCP." })).structuredContent as { entry: MemoryEntryView };
    expect(added.entry.source.type).toBe("person");
    expect(edited.entry.source.type).toBe("person");

    // The consolidation, then the skill proposal call after it (EO-575), which proposes nothing.
    const sideCall = vi.fn(
      async (request: SideCallRequest<unknown>): Promise<SideCallResult<unknown>> => ({
        ok: true,
        value:
          request.system === MEMORY_PROPOSE_SKILLS_SYSTEM
            ? { skills: [] }
            : ({ retire: [], merge: [{ body: "Merged.", from: agents.map((entry) => entry.id), contradictsRepositoryFile: false }], rewrite: [] } satisfies MemoryConsolidationAnswer),
      }),
    );
    const consolidator = createMemoryConsolidator({ db: handle.db, sideCall: sideCall as never, caps: () => ({ maxEntries: 10, maxChars: 40_000 }) });
    try {
      consolidator.start();
      await consolidator.idle();
    } finally {
      consolidator.stop();
    }

    expect(sideCall).toHaveBeenCalledTimes(2);
    const input = sideCall.mock.calls[0]![0].input;
    for (const entry of agents) expect(input).toContain(entry.id);
    // Neither call is given a person's entry: not the consolidation, nor the proposal call after it.
    for (const [request] of sideCall.mock.calls) {
      expect(request.input).not.toContain(added.entry.id);
      expect(request.input).not.toContain("Added through MCP.");
      expect(request.input).not.toContain(edited.entry.id);
      expect(request.input).not.toContain("Edited through MCP.");
    }
    // Both are still active, as they were written.
    expect(getMemory(handle.db, added.entry.id)).toMatchObject({ retiredAt: null, body: "Added through MCP." });
    expect(getMemory(handle.db, edited.entry.id)).toMatchObject({ retiredAt: null, body: "Edited through MCP." });
  });
});
