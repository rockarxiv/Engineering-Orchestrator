import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Agent, MemoryScope, MemorySearchRequest, MemorySource, Uuid } from "@eo/core";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareQuery } from "../approximateSearch.js";
import { openDb, type DbHandle } from "../client.js";
import { runMigrations } from "../migrate.js";
import { memories, projects } from "../schema.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../testHelpers.js";
import { listAgents } from "./agentsRepo.js";
import { addMemory, editMemory, getMemory, restoreMemory, retireMemory, writeArrivedMemory } from "./memoriesRepo.js";
import { editedPredecessors, getMemorySearchEntry, searchMemories, similarMemoryNeighbours } from "./memorySearchRepo.js";
import { createRun } from "./runsRepo.js";

/**
 * Finding memory entries across scopes (EO-545): every filter on its
 * own and together, and approximate search through the trigram index
 * migration 0139 keeps in step with `memories`.
 */

const PERSON: MemorySource = { type: "person", personId: null };

let handle: DbHandle;
let project: MemoryScope;
let workspace: MemoryScope;
let otherProject: MemoryScope;
let otherWorkspace: MemoryScope;
let itemId: Uuid;
let itemKey: string;
let runId: Uuid;
let otherRunId: Uuid;

beforeEach(() => {
  handle = openMigratedTestDb();
  const w = attachWorkspace(handle.db, { keyPrefix: "EO", name: "eo-app", repoPath: "/tmp/eo-app" });
  const w2 = attachWorkspace(handle.db, { keyPrefix: "OPS", name: "ops-tools", repoPath: "/tmp/ops-tools" });
  handle.db.update(projects).set({ name: "Delivery" }).where(eq(projects.id, w.projectId!)).run();
  handle.db.update(projects).set({ name: "Operations" }).where(eq(projects.id, w2.projectId!)).run();
  project = { kind: "project", id: w.projectId! };
  workspace = { kind: "workspace", id: w.id };
  otherProject = { kind: "project", id: w2.projectId! };
  otherWorkspace = { kind: "workspace", id: w2.id };
  const item = createTestItem(handle.db, { type: "story", title: "Fix CI", stepId: "todo", projectId: project.id as Uuid, workspaceId: w.id });
  itemId = item.id;
  itemKey = item.key;
  const agent = listAgents(handle.db).find((candidate: Agent) => candidate.role === "implementer")!;
  runId = createRun(handle.db, { itemId: item.id, agentId: agent.id, action: "implement", status: "succeeded" }).id;
  otherRunId = createRun(handle.db, { itemId: item.id, agentId: agent.id, action: "review", status: "succeeded" }).id;
});

afterEach(() => handle.close());

function add(scope: MemoryScope, body: string, now: number, extra: { source?: MemorySource; contradictsRepositoryFile?: boolean } = {}) {
  const written = addMemory(handle.db, { scope, body, source: extra.source ?? PERSON, now, ...(extra.contradictsRepositoryFile ? { contradictsRepositoryFile: true } : {}) });
  if (!written.ok) throw new Error(written.problem);
  return written.entry;
}

function search(request: MemorySearchRequest = {}) {
  return searchMemories(handle.db, request);
}

function bodies(request: MemorySearchRequest = {}) {
  return search(request).map((entry) => entry.body);
}

describe("memories_search's filters (EO-545)", () => {
  /**
   * One entry per thing a filter can tell apart, at times that make the
   * newest-first order and the ranges easy to read:
   *
   *   1000 project       person                      "Use pnpm, not npm."
   *   2000 workspace     run (runId, item)           "The e2e suite needs a display."
   *   3000 workspace     run (runId, item) extracted "Codegen runs before typecheck."
   *   4000 other project person, contradicts file   "Deploys go out on Tuesdays."
   *   5000 other ws      run (otherRunId, item)      "The ops box has no Docker."
   *   6000 project       person, retired at 7000     "Node 20 is required."
   *   8000 project       person, consolidated at 9000 "Prefer vitest."
   */
  beforeEach(() => {
    add(project, "Use pnpm, not npm.", 1000);
    add(workspace, "The e2e suite needs a display.", 2000, { source: { type: "run", runId, itemId } });
    add(workspace, "Codegen runs before typecheck.", 3000, { source: { type: "run", runId, itemId, extracted: true } });
    add(otherProject, "Deploys go out on Tuesdays.", 4000, { contradictsRepositoryFile: true });
    add(otherWorkspace, "The ops box has no Docker.", 5000, { source: { type: "run", runId: otherRunId, itemId } });
    retireMemory(handle.db, add(project, "Node 20 is required.", 6000).id, { now: 7000 });
    retireMemory(handle.db, add(project, "Prefer vitest.", 8000).id, { reason: "consolidated", consolidationId: "c-1", now: 9000 });
  });

  it("answers every entry in every scope, retired ones included, newest first, with no filter", () => {
    expect(bodies()).toEqual([
      "Prefer vitest.",
      "Node 20 is required.",
      "The ops box has no Docker.",
      "Deploys go out on Tuesdays.",
      "Codegen runs before typecheck.",
      "The e2e suite needs a display.",
      "Use pnpm, not npm.",
    ]);
  });

  it("carries every field the story lists on each result, and no score without a query", () => {
    const extracted = search().find((entry) => entry.body === "Codegen runs before typecheck.")!;
    expect(extracted).toEqual({
      id: expect.any(String),
      scope: { kind: "workspace", id: workspace.id, name: "eo-app" },
      projectId: project.id,
      body: "Codegen runs before typecheck.",
      source: { type: "run", runId, itemId, itemKey },
      extracted: true,
      state: "active",
      retiredAt: null,
      retiredReason: null,
      consolidationId: null,
      contradictsRepositoryFile: false,
      replacesId: null,
      supersededIds: [],
      createdAt: 3000,
      updatedAt: 3000,
      deliveries: 0,
      uses: 0,
    });
    const consolidated = search().find((entry) => entry.body === "Prefer vitest.")!;
    expect(consolidated).toMatchObject({
      scope: { kind: "project", id: project.id, name: "Delivery" },
      source: { type: "person", personId: null },
      state: "consolidated",
      retiredAt: 9000,
      retiredReason: "consolidated",
      consolidationId: "c-1",
      updatedAt: 9000,
    });
    expect(search().find((entry) => entry.body === "Deploys go out on Tuesdays.")).toMatchObject({ contradictsRepositoryFile: true });
    expect(search().every((entry) => !("score" in entry))).toBe(true);
  });

  it("filters by scope kind and by scope id", () => {
    expect(bodies({ scopeKind: "workspace" })).toEqual(["The ops box has no Docker.", "Codegen runs before typecheck.", "The e2e suite needs a display."]);
    expect(bodies({ scopeId: otherProject.id })).toEqual(["Deploys go out on Tuesdays."]);
    expect(bodies({ scopeKind: "workspace", scopeId: workspace.id })).toEqual(["Codegen runs before typecheck.", "The e2e suite needs a display."]);
  });

  it("filters by a project's or a workspace's name, ignoring case, and answers nothing for a name no scope has", () => {
    expect(bodies({ scopeName: "operations" })).toEqual(["Deploys go out on Tuesdays."]);
    expect(bodies({ scopeName: "EO-APP" })).toEqual(["Codegen runs before typecheck.", "The e2e suite needs a display."]);
    expect(bodies({ scopeName: "nowhere" })).toEqual([]);
  });

  it("filters by project, which takes in its workspaces' entries", () => {
    expect(bodies({ projectId: otherProject.id })).toEqual(["The ops box has no Docker.", "Deploys go out on Tuesdays."]);
    expect(search({ projectId: project.id })).toHaveLength(5);
  });

  it("filters by source kind, by run and by item", () => {
    expect(bodies({ sourceKind: "run" })).toEqual(["The ops box has no Docker.", "Codegen runs before typecheck.", "The e2e suite needs a display."]);
    expect(search({ sourceKind: "person" })).toHaveLength(4);
    expect(bodies({ runId: otherRunId })).toEqual(["The ops box has no Docker."]);
    expect(search({ itemId })).toHaveLength(3);
    expect(search({ itemId: "no-such-item" })).toEqual([]);
  });

  it("filters by extracted", () => {
    expect(bodies({ extracted: true })).toEqual(["Codegen runs before typecheck."]);
    expect(search({ extracted: false })).toHaveLength(6);
  });

  it("filters by state: active, retired, or retired by consolidation", () => {
    expect(search({ state: "active" })).toHaveLength(5);
    expect(bodies({ state: "retired" })).toEqual(["Node 20 is required."]);
    expect(bodies({ state: "consolidated" })).toEqual(["Prefer vitest."]);
  });

  it("filters by the contradiction flag", () => {
    expect(bodies({ contradictsRepositoryFile: true })).toEqual(["Deploys go out on Tuesdays."]);
    expect(search({ contradictsRepositoryFile: false })).toHaveLength(6);
  });

  it("filters by when an entry was created, from since and before until", () => {
    expect(bodies({ createdSince: 3000, createdUntil: 5000 })).toEqual(["Deploys go out on Tuesdays.", "Codegen runs before typecheck."]);
    expect(search({ createdSince: 8000 })).toHaveLength(1);
    expect(search({ createdUntil: 1000 })).toEqual([]);
  });

  it("filters by when an entry last changed, which a retirement moves", () => {
    // Node 20's entry was written at 6000 and retired at 7000.
    expect(bodies({ updatedSince: 6500 })).toEqual(["Prefer vitest.", "Node 20 is required."]);
    expect(bodies({ updatedSince: 6000, updatedUntil: 8000 })).toEqual(["Node 20 is required."]);
  });

  it("combines every filter given with AND", () => {
    expect(bodies({ scopeKind: "workspace", sourceKind: "run", extracted: false, projectId: project.id })).toEqual(["The e2e suite needs a display."]);
    expect(bodies({ scopeId: project.id, state: "active", createdUntil: 2000 })).toEqual(["Use pnpm, not npm."]);
    expect(search({ scopeId: project.id, contradictsRepositoryFile: true })).toEqual([]);
    expect(bodies({ query: "docker", projectId: otherProject.id, state: "active" })).toEqual(["The ops box has no Docker."]);
    expect(search({ query: "docker", projectId: project.id })).toEqual([]);
  });
});

describe("memories_search's approximate text search (EO-545)", () => {
  /** Enough unrelated entries that bm25's weighting of rare pieces of text means something. */
  function filler(from: number) {
    const lines = [
      "Use pnpm, not npm.",
      "The release branch is cut on Mondays.",
      "Lint before pushing.",
      "Storybook lives under apps/ui.",
      "Find the kind of every item in the registry.",
      "Independent reviews catch more.",
    ];
    lines.forEach((line, at) => add(project, line, from + at));
  }

  it("finds part of a word: 'windo' finds an entry about Windows CI, and not one that only shares a piece of it", () => {
    filler(1);
    const windows = add(workspace, "The test-windows shards on CI are flaky; rerun them once before failing a review.", 100);

    const found = search({ query: "windo" });
    expect(found.map((entry) => entry.id)).toEqual([windows.id]);
    expect(found[0]!.score).toBeGreaterThan(0);
  });

  it("finds another form of a word: 'rerun' finds 'reruns'", () => {
    filler(1);
    const reruns = add(workspace, "CI reruns are free; the second attempt usually passes.", 100);

    expect(search({ query: "rerun" }).map((entry) => entry.id)).toEqual([reruns.id]);
  });

  it("finds a word spelt a little wrong, through the trigrams the two share", () => {
    filler(1);
    const pipeline = add(project, "The pipeline graph is data, not code.", 100);
    const windows = add(workspace, "Windows runners need longer timeouts.", 101);

    expect(search({ query: "pipline" }).map((entry) => entry.id)).toEqual([pipeline.id]);
    expect(search({ query: "Windws" }).map((entry) => entry.id)).toEqual([windows.id]);
  });

  it("ignores case and matches any word of a query, ranking by bm25 best first", () => {
    filler(1);
    const once = add(workspace, "Windows is slow.", 100);
    const both = add(workspace, "Flaky Windows shards.", 101);
    const elsewhere = add(project, "Deploys need a flaky-test quarantine.", 102);

    const found = search({ query: "WINDOWS flaky" });
    expect(new Set(found.map((entry) => entry.id))).toEqual(new Set([once.id, both.id, elsewhere.id]));
    // In the order bm25 itself gives, and each score is bm25 negated.
    const match = handle.db.all<{ id: string; rank: number }>(
      sql`select id, bm25(memories_fts) as rank from memories_fts where memories_fts match ${prepareQuery("WINDOWS flaky").match} order by rank`,
    );
    const wanted = match.filter((hit) => found.some((entry) => entry.id === hit.id));
    expect(found.map((entry) => entry.id)).toEqual(wanted.map((hit) => hit.id));
    expect(found.map((entry) => entry.score)).toEqual(wanted.map((hit) => -hit.rank));
    // The entry holding both words is the best match.
    expect(found[0]!.id).toBe(both.id);
    const scores = found.map((entry) => entry.score!);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it("answers nothing for a query nothing resembles", () => {
    filler(1);
    expect(search({ query: "kubernetes" })).toEqual([]);
  });

  it("is kept in step with inserts, edits, retirements, restores, arrived rows and deletions", () => {
    filler(1);
    const original = add(project, "Postgres 15 runs the tests.", 100);
    expect(search({ query: "postgres" }).map((entry) => entry.id)).toEqual([original.id]);

    // An edit retires the old version and writes the new one, which is found too.
    const edited = editMemory(handle.db, original.id, "Postgres 16 runs the tests, in Docker.", PERSON, 200);
    if (!edited.ok) throw new Error(edited.problem);
    expect(search({ query: "docker" }).map((entry) => entry.id)).toEqual([edited.entry.id]);
    expect(search({ query: "postgres", state: "active" }).map((entry) => entry.id)).toEqual([edited.entry.id]);
    expect(search({ query: "postgres", state: "retired" }).map((entry) => [entry.id, entry.retiredReason])).toEqual([[original.id, "edited"]]);

    // A retirement and a restore change what a state filter answers, not what is found.
    retireMemory(handle.db, edited.entry.id, { now: 300 });
    expect(search({ query: "docker" }).map((entry) => entry.state)).toEqual(["retired"]);
    expect(search({ query: "docker", state: "active" })).toEqual([]);
    restoreMemory(handle.db, edited.entry.id, 400);
    expect(search({ query: "docker", state: "active" }).map((entry) => entry.id)).toEqual([edited.entry.id]);

    // A row arriving from a record with a body of its own is indexed under it.
    const arrived = getMemory(handle.db, edited.entry.id)!;
    writeArrivedMemory(handle.db, { ...arrived, body: "Postgres 16 runs the tests, in Podman.", updatedAt: 500, projectId: project.id, replacesId: original.id, supersededIds: [] });
    expect(search({ query: "podman" }).map((entry) => entry.id)).toEqual([edited.entry.id]);
    expect(search({ query: "docker" })).toEqual([]);

    // And a row taken out — a half-moved project's copy — leaves the index.
    handle.db.delete(memories).where(eq(memories.id, edited.entry.id)).run();
    expect(search({ query: "podman" })).toEqual([]);
    expect(handle.db.get<{ count: number }>(sql`select count(*) as count from memories_fts where id = ${edited.entry.id}`)?.count).toBe(0);
    expect(handle.db.get<{ count: number }>(sql`select count(*) as count from memories_fts`)?.count).toBe(
      handle.db.get<{ count: number }>(sql`select count(*) as count from memories`)?.count,
    );
  });

  it("finds text however its letters were composed, as the query and the index fold them the same way", () => {
    filler(1);
    // "für" typed as u and a combining diaeresis, and "Prüfung" typed precomposed.
    const decomposed = add(workspace, "Nur fu\u0308r Windows: die Shards neu starten.", 100);
    const precomposed = add(project, "Die Pr\u00fcfung l\u00e4uft nachts.", 101);
    const sharp = add(project, "Die Stra\u00dfe ist gesperrt.", 102);

    // The identical decomposed text, and the precomposed spelling of it.
    expect(search({ query: "fu\u0308r" }).map((entry) => entry.id)).toEqual([decomposed.id]);
    expect(search({ query: "f\u00fcr" }).map((entry) => entry.id)).toEqual([decomposed.id]);
    // The other way round: a decomposed query finds a precomposed body.
    expect(search({ query: "Pru\u0308fung" }).map((entry) => entry.id)).toEqual([precomposed.id]);
    // And case folded in every script, not only ASCII: ß is ss.
    expect(search({ query: "STRASSE" }).map((entry) => entry.id)).toEqual([sharp.id]);
    // The body itself is kept as it was written; only the index is folded.
    expect(getMemory(handle.db, decomposed.id)?.body).toBe("Nur fu\u0308r Windows: die Shards neu starten.");
    expect(handle.db.get<{ body: string }>(sql`select body from memories_fts where id = ${decomposed.id}`)?.body).toBe("nur f\u00fcr windows: die shards neu starten.");
  });

  it("indexes, folded, the entries a database held before the migration, and links the edits it can be sure of", () => {
    const migrations = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
    const before = mkdtempSync(join(tmpdir(), "eo-before-memory-search-"));
    try {
      mkdirSync(join(before, "meta"));
      // Everything before 0139, not everything but it: drizzle applies what
      // is newer than the last migration a database ran, so a later one
      // left in would put the database past 0139 without it (EO-555).
      for (const file of readdirSync(migrations).filter((name) => name.endsWith(".sql") && name < "0139_")) copyFileSync(join(migrations, file), join(before, file));
      const journal = JSON.parse(readFileSync(join(migrations, "meta", "_journal.json"), "utf8")) as { entries: { tag: string }[] };
      writeFileSync(join(before, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.filter((entry) => entry.tag < "0139_memory_search") }));

      const upgraded = openDb(":memory:");
      try {
        runMigrations(upgraded.db, before);
        const w = attachWorkspace(upgraded.db, { keyPrefix: "UP", name: "up", repoPath: "/tmp/up" });
        const scopeId = w.projectId!;
        // Rows as the previous release wrote them, with no `replaces_id`.
        const row = (id: string, body: string, createdAt: number, retired: { at: number; reason: string } | null, sourceKind = "person") =>
          upgraded.db.run(sql`insert into memories (id, scope_kind, scope_id, body, source_kind, created_at, updated_at, retired_at, retired_reason, project_id)
            values (${id}, 'project', ${scopeId}, ${body}, ${sourceKind}, ${createdAt}, ${retired?.at ?? createdAt}, ${retired?.at ?? null}, ${retired?.reason ?? null}, ${scopeId})`);
        // An edit the times make certain: a1 retired as edited at 200, a2 the only row written then.
        row("a1", "Windows CI needs a rerun.", 100, { at: 200, reason: "edited" });
        row("a2", "Windows CI needs two reruns.", 200, null);
        // Two edits in one millisecond: which replaced which cannot be told, so neither is linked.
        row("b1", "One.", 100, { at: 300, reason: "edited" });
        row("c1", "Two.", 101, { at: 300, reason: "edited" });
        row("b2", "One, again.", 300, null);
        row("c2", "Two, again.", 300, null);
        // A row a consolidation wrote, with the age of an entry that was edited at that moment.
        row("d1", "Three.", 100, { at: 400, reason: "edited" });
        row("d2", "Three, merged.", 400, null, "run");
        row("e1", "Four.", 102, { at: 400, reason: "edited" });
        row("e2", "Four, merged.", 400, null);
        upgraded.db.run(sql`insert into memory_consolidations (id, scope_kind, scope_id, "trigger", status, started_at, retired_ids, written_ids)
          values ('k1', 'project', ${scopeId}, 'cap', 'succeeded', 500, '[]', '["e2"]')`);
        // Text with a decomposed letter, written before the index existed.
        row("f1", "Nur fu\u0308r Linux.", 600, null);

        runMigrations(upgraded.db, migrations);

        expect(searchMemories(upgraded.db, { query: "windo" }).map((entry) => entry.id).sort()).toEqual(["a1", "a2"]);
        expect(searchMemories(upgraded.db, { query: "f\u00fcr" }).map((entry) => entry.id)).toEqual(["f1"]);
        const replaces = (id: string) => upgraded.db.get<{ replacesId: string | null }>(sql`select replaces_id as replacesId from memories where id = ${id}`)?.replacesId;
        expect(replaces("a2")).toBe("a1");
        expect([replaces("b2"), replaces("c2")]).toEqual([null, null]);
        // d2 is the only row created at 400 that no consolidation wrote, but it is a run's, and no edit writes one.
        expect([replaces("d2"), replaces("e2")]).toEqual([null, null]);
        expect(editedPredecessors(upgraded.db, getMemorySearchEntry(upgraded.db, "a2")!).map((entry) => entry.id)).toEqual(["a1"]);
      } finally {
        upgraded.close();
      }
    } finally {
      rmSync(before, { recursive: true, force: true });
    }
  });
});

describe("one entry's history (EO-545)", () => {
  function edit(id: string, body: string, now: number) {
    const edited = editMemory(handle.db, id, body, PERSON, now);
    if (!edited.ok) throw new Error(edited.problem);
    return edited.entry;
  }

  function history(id: string) {
    return editedPredecessors(handle.db, getMemorySearchEntry(handle.db, id)!).map((entry) => entry.body);
  }

  it("walks back through the versions its edits replaced, newest first, and says which one on the entry", () => {
    const first = add(project, "Tests need Postgres 14.", 100);
    const second = edit(first.id, "Tests need Postgres 15.", 200);
    const third = edit(second.id, "Tests need Postgres 16.", 300);

    expect(history(third.id)).toEqual(["Tests need Postgres 15.", "Tests need Postgres 14."]);
    expect(history(first.id)).toEqual([]);
    expect(getMemorySearchEntry(handle.db, third.id)?.replacesId).toBe(second.id);
    expect(getMemorySearchEntry(handle.db, first.id)?.replacesId).toBeNull();
  });

  it("keeps two edits made in one scope at the same moment apart, and gives an entry added then no history", () => {
    const a = add(project, "Alpha.", 100);
    const b = add(project, "Beta.", 101);
    const a2 = edit(a.id, "Alpha, edited.", 300);
    const b2 = edit(b.id, "Beta, edited.", 300);
    const added = add(project, "Gamma, new.", 300);

    expect(history(a2.id)).toEqual(["Alpha."]);
    expect(history(b2.id)).toEqual(["Beta."]);
    expect(history(added.id)).toEqual([]);
  });

  it("keeps the history when a replaced version is restored, retired and restored again", () => {
    const first = add(project, "v1", 100);
    const second = edit(first.id, "v2", 200);
    const third = edit(second.id, "v3", 300);
    restoreMemory(handle.db, first.id, 400);
    restoreMemory(handle.db, second.id, 410);
    retireMemory(handle.db, second.id, { now: 420 });
    restoreMemory(handle.db, second.id, 430);

    expect(history(third.id)).toEqual(["v2", "v1"]);
    expect(getMemory(handle.db, first.id)).toMatchObject({ retiredAt: null, retiredReason: null });
  });

  it("answers every version of a long history, not the newest hundred", () => {
    let current = add(project, "version 0", 1);
    for (let version = 1; version <= 150; version += 1) current = edit(current.id, `version ${version}`, 1 + version);

    const versions = history(current.id);
    expect(versions).toHaveLength(150);
    expect(versions[0]).toBe("version 149");
    expect(versions[149]).toBe("version 0");
  });

  it("is carried to a replica with the row, and not erased by a row from a record that does not say", () => {
    const first = add(project, "Before.", 100);
    const second = edit(first.id, "After.", 200);
    const replica = openMigratedTestDb();
    try {
      const w = attachWorkspace(replica.db, { keyPrefix: "R", name: "r", repoPath: "/tmp/r" });
      const scope = { kind: "project" as const, id: w.projectId! };
      const travelled = (id: string) => ({ ...getMemory(handle.db, id)!, scope, projectId: scope.id, supersededIds: [] });
      writeArrivedMemory(replica.db, { ...travelled(first.id), replacesId: null });
      writeArrivedMemory(replica.db, { ...travelled(second.id), replacesId: first.id });
      expect(editedPredecessors(replica.db, getMemorySearchEntry(replica.db, second.id)!).map((entry) => entry.id)).toEqual([first.id]);

      // A later change from a record of the release before, which sends no link.
      writeArrivedMemory(replica.db, { ...travelled(second.id), updatedAt: 300, retiredAt: 300, retiredReason: "retired", replacesId: null });
      expect(getMemorySearchEntry(replica.db, second.id)).toMatchObject({ state: "retired", replacesId: first.id });
    } finally {
      replica.close();
    }
  });

  it("answers undefined for an id no entry has", () => {
    expect(getMemorySearchEntry(handle.db, "nope")).toBeUndefined();
  });
});

describe("the entries most like one, for batching a consolidation (EO-574)", () => {
  it("ranks the given entries alike by the index, best first, and never names another scope's, the entry itself, or one it was not given", () => {
    const now = Date.now() - 60_000;
    const ledger = add(project, "The payments ledger settles invoices in UTC at noon.", now);
    const ledgerAgain = add(project, "Invoices in the payments ledger settle at noon, in UTC.", now + 1);
    const playwright = add(project, "Playwright suites need a display server; run them under xvfb.", now + 2);
    const somewhatLedger = add(project, "Payments are retried twice before the ledger gives up.", now + 3);
    add(otherProject, "The payments ledger settles invoices in UTC at noon.", now + 4);
    const shortOnly = add(project, "ok", now + 5);
    const given = [ledger, ledgerAgain, playwright, somewhatLedger, shortOnly];

    const neighbours = similarMemoryNeighbours(handle.db, given, 3);

    expect(neighbours.get(ledger.id)![0]).toBe(ledgerAgain.id);
    expect(neighbours.get(ledgerAgain.id)![0]).toBe(ledger.id);
    // One that shares part of what it says comes before one about something else, if that comes at all.
    const forLedger = neighbours.get(ledger.id)!;
    const rank = (id: string) => (forLedger.includes(id) ? forLedger.indexOf(id) : Infinity);
    expect(rank(somewhatLedger.id)).toBeLessThan(rank(playwright.id));
    for (const [id, alike] of neighbours) {
      expect(alike).not.toContain(id);
      expect(alike.length).toBeLessThanOrEqual(3);
      for (const other of alike) expect(given.map((entry) => entry.id)).toContain(other);
    }
    // A body with no word long enough to match on has none.
    expect(neighbours.get(shortOnly.id)).toEqual([]);
  });

  it("answers quickly for a long entry, asking by the start of its body", () => {
    const now = Date.now() - 60_000;
    const long = add(project, `${"Deployment requires the staging cluster credentials. ".repeat(70)}`, now);
    const alike = add(project, "Deployment to staging requires the cluster credentials.", now + 1);
    expect(similarMemoryNeighbours(handle.db, [long, alike]).get(long.id)).toEqual([alike.id]);
  });
});
