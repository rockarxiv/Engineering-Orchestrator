import type { Agent, MemoryScope, MemorySource, Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../client.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../testHelpers.js";
import { listAgents } from "./agentsRepo.js";
import { deleteItem } from "./itemsRepo.js";
import {
  activeMemoriesIn,
  addMemory,
  countActiveMemories,
  editMemory,
  getMemory,
  listMemories,
  noteMemory,
  recordMemories,
  restoreMemory,
  retireMemory,
  writeArrivedMemory,
} from "./memoriesRepo.js";
import { createRun } from "./runsRepo.js";

const PERSON = { type: "person", personId: null } as const;
const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("memory entries (EO-478)", () => {
  let handle: DbHandle;
  let project: MemoryScope;
  let workspace: MemoryScope;
  let other: MemoryScope;

  beforeEach(() => {
    handle = openMigratedTestDb();
    const w = attachWorkspace(handle.db, { keyPrefix: "P", name: "app", repoPath: "/tmp/app" });
    const w2 = attachWorkspace(handle.db, { keyPrefix: "Q", name: "other", repoPath: "/tmp/other" });
    project = { kind: "project", id: w.projectId! };
    workspace = { kind: "workspace", id: w.id };
    other = { kind: "workspace", id: w2.id };
  });

  afterEach(() => handle.close());

  function add(scope: MemoryScope, body: string, now: number) {
    const written = addMemory(handle.db, { scope, body, source: PERSON, now });
    if (!written.ok) throw new Error(written.problem);
    return written.entry;
  }

  it("writes an active entry with a client-side UUIDv7 id and its source", () => {
    const entry = add(project, "  Run pnpm install before the tests.  ", 1_000);

    expect(entry.id).toMatch(UUIDV7);
    expect(entry).toMatchObject({ scope: project, body: "Run pnpm install before the tests.", source: PERSON, createdAt: 1_000, updatedAt: 1_000, retiredAt: null, retiredReason: null, consolidationId: null });
    expect(getMemory(handle.db, entry.id)).toEqual(entry);
  });

  it("records a run and its item as the source of an agent's entry, and keeps the entry when the item is deleted", () => {
    const item = createTestItem(handle.db, { type: "story", title: "A", stepId: "todo", projectId: project.id as Uuid });
    const agent = listAgents(handle.db).find((candidate: Agent) => candidate.role === "implementer")!;
    const run = createRun(handle.db, { itemId: item.id, agentId: agent.id, action: "implement", status: "succeeded" });
    const written = addMemory(handle.db, { scope: workspace, body: "The e2e suite needs a display.", source: { type: "run", runId: run.id, itemId: item.id } });
    if (!written.ok) throw new Error(written.problem);
    expect(written.entry.source).toEqual({ type: "run", runId: run.id, itemId: item.id });

    deleteItem(handle.db, item.id);

    expect(getMemory(handle.db, written.entry.id)?.source).toEqual({ type: "run", runId: null, itemId: null });
  });

  it("refuses an empty body and a scope that names nothing", () => {
    expect(addMemory(handle.db, { scope: project, body: "   ", source: PERSON })).toMatchObject({ ok: false });
    expect(addMemory(handle.db, { scope: { kind: "project", id: "nope" }, body: "x", source: PERSON })).toMatchObject({ ok: false, problem: expect.stringContaining("nope") });
  });

  it("lists a scope's active entries newest first, and its retired ones after them when asked", () => {
    const older = add(project, "older", 1_000);
    const newer = add(project, "newer", 2_000);
    add(workspace, "the workspace's", 3_000);
    retireMemory(handle.db, older.id, { now: 4_000 });

    expect(listMemories(handle.db, project).map((entry) => entry.body)).toEqual(["newer"]);
    expect(listMemories(handle.db, project, { includeRetired: true }).map((entry) => entry.id)).toEqual([newer.id, older.id]);
    expect(countActiveMemories(handle.db, project)).toBe(1);
  });

  it("edits by retiring the old row as edited and inserting a new one, so history is kept", () => {
    const original = add(project, "Tests need Postgres 15.", 1_000);
    const edited = editMemory(handle.db, original.id, "Tests need Postgres 16.", PERSON, 2_000);
    if (!edited.ok) throw new Error(edited.problem);

    expect(edited.entry.id).not.toBe(original.id);
    expect(edited.entry).toMatchObject({ scope: project, body: "Tests need Postgres 16.", retiredAt: null, createdAt: 2_000 });
    expect(getMemory(handle.db, original.id)).toMatchObject({ body: "Tests need Postgres 15.", retiredAt: 2_000, retiredReason: "edited" });
    expect(listMemories(handle.db, project).map((entry) => entry.body)).toEqual(["Tests need Postgres 16."]);
    expect(listMemories(handle.db, project, { includeRetired: true })).toHaveLength(2);
  });

  it("refuses to edit or retire a retired entry, or restore an active one", () => {
    const entry = add(project, "x", 1_000);
    expect(restoreMemory(handle.db, entry.id)).toMatchObject({ ok: false });
    retireMemory(handle.db, entry.id);
    expect(editMemory(handle.db, entry.id, "y", PERSON)).toMatchObject({ ok: false });
    expect(retireMemory(handle.db, entry.id)).toMatchObject({ ok: false });
    expect(editMemory(handle.db, "missing", "y", PERSON)).toMatchObject({ ok: false });
  });

  it("retires with a reason and restores whatever retired it", () => {
    const entry = add(project, "x", 1_000);
    expect(retireMemory(handle.db, entry.id, { now: 2_000 })).toMatchObject({ ok: true, entry: { retiredAt: 2_000, retiredReason: "retired" } });
    expect(restoreMemory(handle.db, entry.id, 3_000)).toMatchObject({ ok: true, entry: { retiredAt: null, retiredReason: null, updatedAt: 3_000 } });

    retireMemory(handle.db, entry.id, { reason: "consolidated", consolidationId: "c-1" });
    expect(getMemory(handle.db, entry.id)).toMatchObject({ retiredReason: "consolidated", consolidationId: "c-1" });
    expect(restoreMemory(handle.db, entry.id)).toMatchObject({ ok: true, entry: { retiredAt: null } });
  });

  it("reads the active entries of exactly the scopes asked for, never a retired one", () => {
    add(project, "p", 1_000);
    add(workspace, "w", 2_000);
    add(other, "another workspace", 3_000);
    const retired = add(workspace, "retired", 4_000);
    retireMemory(handle.db, retired.id);

    expect(activeMemoriesIn(handle.db, [project, workspace]).map((entry) => entry.body)).toEqual(["w", "p"]);
    expect(activeMemoriesIn(handle.db, [project]).map((entry) => entry.body)).toEqual(["p"]);
    expect(activeMemoriesIn(handle.db, [])).toEqual([]);
  });
});

/**
 * A note that names the entries it corrects or repeats (EO-594): they are
 * retired as superseded in the transaction that writes it, the new entry
 * names them, and a refusal of any one writes nothing at all.
 */
describe("a note that replaces entries (EO-594)", () => {
  let handle: DbHandle;
  let project: MemoryScope;
  let workspace: MemoryScope;
  let other: MemoryScope;
  let source: { type: "run"; runId: Uuid; itemId: Uuid };

  beforeEach(() => {
    handle = openMigratedTestDb();
    const w = attachWorkspace(handle.db, { keyPrefix: "P", name: "app", repoPath: "/tmp/app" });
    const w2 = attachWorkspace(handle.db, { keyPrefix: "Q", name: "other", repoPath: "/tmp/other" });
    project = { kind: "project", id: w.projectId! };
    workspace = { kind: "workspace", id: w.id };
    other = { kind: "workspace", id: w2.id };
    const item = createTestItem(handle.db, { type: "story", title: "A", stepId: "todo", projectId: project.id as Uuid });
    const run = createRun(handle.db, { itemId: item.id, agentId: null, action: "implement", status: "running" });
    source = { type: "run", runId: run.id, itemId: item.id };
  });

  afterEach(() => handle.close());

  function write(scope: MemoryScope, body: string, from: MemorySource, now: number) {
    const written = addMemory(handle.db, { scope, body, source: from, now });
    if (!written.ok) throw new Error(written.problem);
    return written.entry;
  }

  function rows() {
    return [project, workspace, other].flatMap((scope) => listMemories(handle.db, scope, { includeRetired: true }));
  }

  it("retires every entry it names as superseded and writes itself naming them, in one stroke", () => {
    const gap = write(project, "Known gap: the record checks only a person's press.", source, 1_000);
    const again = write(workspace, "The record checks only a person's press.", { ...source, extracted: true }, 1_500);
    const untouched = write(project, "Use pnpm.", source, 1_600);

    const written = noteMemory(handle.db, {
      scope: project,
      body: "The record checks every press on a group step, a person's or an agent's.",
      source,
      now: 2_000,
      replaces: [gap.id, again.id],
      scopes: [project, workspace],
    });
    if (!written.ok) throw new Error(written.problem);

    expect(written.entry).toMatchObject({ scope: project, retiredAt: null, createdAt: 2_000 });
    for (const id of [gap.id, again.id]) expect(getMemory(handle.db, id)).toMatchObject({ retiredAt: 2_000, retiredReason: "superseded", updatedAt: 2_000 });
    expect(getMemory(handle.db, untouched.id)?.retiredAt).toBeNull();
    // The new entry says what it replaced, and so does the row a replica is sent.
    expect(recordMemories(handle.db, [written.entry.id])[0]).toMatchObject({ supersededIds: [gap.id, again.id], replacesId: null });
    expect(activeMemoriesIn(handle.db, [project, workspace]).map((entry) => entry.id).sort()).toEqual([written.entry.id, untouched.id].sort());
  });

  it("is a plain note where it names nothing", () => {
    const written = noteMemory(handle.db, { scope: project, body: "A fact.", source, replaces: [], scopes: [] });
    expect(written).toMatchObject({ ok: true });
    expect(recordMemories(handle.db, [written.ok ? written.entry.id : ""])[0]?.supersededIds).toEqual([]);
  });

  it("refuses a person's entry, a retired one, one in a scope the run does not work in, and an id that names nothing — and writes nothing", () => {
    const agents = write(project, "An agent's fact.", source, 1_000);
    const persons = write(project, "A person's fact.", { type: "person", personId: null }, 1_100);
    const retired = write(project, "A retired fact.", source, 1_200);
    retireMemory(handle.db, retired.id, { now: 1_300 });
    const elsewhere = write(other, "Another workspace's fact.", source, 1_400);
    const before = rows();

    const cases: [string, RegExp][] = [
      [persons.id, /written by a person, and a note never replaces a person's entry/],
      [retired.id, /already retired/],
      [elsewhere.id, /not in a scope this run works in/],
      ["missing", /No memory entry has the id "missing"/],
    ];
    for (const [id, problem] of cases) {
      // The agent's own entry first, so a refusal is seen to undo nothing it would have retired.
      const refused = noteMemory(handle.db, { scope: project, body: "A correction.", source, now: 2_000, replaces: [agents.id, id], scopes: [project, workspace] });
      expect(refused, id).toEqual({ ok: false, problem: expect.stringMatching(problem) });
      expect(refused.ok ? "" : refused.problem, id).toContain("not written");
    }
    expect(rows()).toEqual(before);
  });

  it("is undone a piece at a time: a restore returns a superseded entry to active, and the note still names it", () => {
    const wrong = write(project, "Tests need Postgres 15.", source, 1_000);
    const written = noteMemory(handle.db, { scope: project, body: "Tests need Postgres 16.", source, now: 2_000, replaces: [wrong.id], scopes: [project] });
    if (!written.ok) throw new Error(written.problem);

    expect(restoreMemory(handle.db, wrong.id, 3_000)).toMatchObject({ ok: true, entry: { retiredAt: null, retiredReason: null, updatedAt: 3_000 } });
    expect(recordMemories(handle.db, [written.entry.id])[0]?.supersededIds).toEqual([wrong.id]);
  });

  it("keeps what a note superseded when a replica is sent its row again by a record that does not say", () => {
    const wrong = write(project, "Old.", source, 1_000);
    const written = noteMemory(handle.db, { scope: project, body: "New.", source, now: 2_000, replaces: [wrong.id], scopes: [project] });
    if (!written.ok) throw new Error(written.problem);
    const row = recordMemories(handle.db, [written.entry.id])[0]!;

    writeArrivedMemory(handle.db, { ...row, updatedAt: 3_000, supersededIds: [] });

    expect(recordMemories(handle.db, [written.entry.id])[0]).toMatchObject({ updatedAt: 3_000, supersededIds: [wrong.id] });
  });
});
