import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { openDb, type DbHandle } from "./client.js";
import { runMigrations } from "./migrate.js";

/**
 * Migration 0170 (EO-770): every module step and module entry rule, in the
 * live graph and in every stored pipeline version, pinned to the newest
 * approved version of its module — or its newest version, where none was
 * approved, which leaves the step blocked as it was.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "migrations");

let handles: DbHandle[] = [];
let tempDirs: string[] = [];

afterEach(() => {
  for (const handle of handles) handle.close();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  handles = [];
  tempDirs = [];
});

/** A database as it stood on the launch before 0170. */
function beforeTheMigration(): DbHandle {
  const handle = openDb(":memory:");
  handles.push(handle);
  const dir = mkdtempSync(join(tmpdir(), "eo-module-pins-"));
  tempDirs.push(dir);
  const journal = JSON.parse(readFileSync(join(MIGRATIONS, "meta", "_journal.json"), "utf8")) as { entries: { tag: string }[] };
  const kept = journal.entries.slice(0, journal.entries.findIndex((entry) => entry.tag.startsWith("0170_")));
  mkdirSync(join(dir, "meta"), { recursive: true });
  writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: kept }));
  for (const entry of kept) writeFileSync(join(dir, `${entry.tag}.sql`), readFileSync(join(MIGRATIONS, `${entry.tag}.sql`), "utf8"));
  runMigrations(handle.db, dir);
  return handle;
}

const MANIFEST = JSON.stringify({ name: "M", description: "M.", inputs: {}, needs: { bin: [], env: [], network: false, item: false, comment: false, attach: false, create: false }, results: ["done"] });

/**
 * Two modules: `approved` has v1 and v3 approved and v4 an edit nobody
 * approved, so it pins v3; `draft` has v1 and v2 and neither approved, so
 * it pins v2. A pipeline runs both on steps, asks both at its door, and
 * has a stored version holding both.
 */
function seed(db: DbHandle["db"]): void {
  db.run(sql`INSERT INTO modules (id, slug, name, description, code, manifest, source, approved_at, created_at, updated_at, archived_at)
             VALUES ('approved', 'approved', 'Approved', 'x', 'v4', ${MANIFEST}, 'user', NULL, 1, 1, NULL),
                    ('draft', 'draft', 'Draft', 'x', 'v2', ${MANIFEST}, 'user', NULL, 1, 1, NULL)`);
  db.run(sql`INSERT INTO module_versions (id, module_id, number, name, description, code, manifest, tests, approved_at, created_at)
             VALUES ('a1', 'approved', 1, 'Approved', 'x', 'v1', ${MANIFEST}, '[]', 10, 1),
                    ('a3', 'approved', 3, 'Approved', 'x', 'v3', ${MANIFEST}, '[]', 30, 3),
                    ('a4', 'approved', 4, 'Approved', 'x', 'v4', ${MANIFEST}, '[]', NULL, 4),
                    ('d1', 'draft', 1, 'Draft', 'x', 'v1', ${MANIFEST}, '[]', NULL, 1),
                    ('d2', 'draft', 2, 'Draft', 'x', 'v2', ${MANIFEST}, '[]', NULL, 2)`);
  const rules = JSON.stringify([
    { kind: "description" },
    { kind: "module", module: "approved", timeoutMs: 5000 },
    { kind: "module", module: "draft" },
    { kind: "module", module: "nowhere" },
  ]);
  db.run(sql`INSERT INTO pipelines (id, name, position, entry_rules, created_at, updated_at) VALUES ('p', 'Delivery', 0, ${rules}, 1, 1)`);
  db.run(sql`INSERT INTO pipeline_steps (id, pipeline_id, position, name, type, entry_action)
             VALUES ('s-approved', 'p', 0, 'Ship', 'module', 'approved'),
                    ('s-draft', 'p', 1, 'Check', 'module', 'draft'),
                    ('s-agent', 'p', 2, 'Review', 'agent', 'review'),
                    ('s-gone', 'p', 3, 'Old', 'module', 'nowhere')`);
  const steps = JSON.stringify([
    { id: "s-approved", pipelineId: "p", position: 0, name: "Ship", type: "module", ownerRole: null, entryAction: "approved", instructionsSummary: null, isTerminal: false, planMode: false },
    { id: "s-draft", pipelineId: "p", position: 1, name: "Check", type: "module", ownerRole: null, entryAction: "draft", instructionsSummary: null, isTerminal: false, planMode: false },
    { id: "s-agent", pipelineId: "p", position: 2, name: "Review", type: "agent", ownerRole: "reviewer", entryAction: "review", instructionsSummary: null, isTerminal: false, planMode: false },
  ]);
  db.run(sql`INSERT INTO pipeline_versions (id, pipeline_id, number, steps, routes, entry_step_id, entry_rules, created_at)
             VALUES ('v1', 'p', 1, ${steps}, '[]', 's-approved', ${rules}, 1)`);
}

function migrated(): DbHandle["db"] {
  const handle = beforeTheMigration();
  seed(handle.db);
  runMigrations(handle.db, MIGRATIONS);
  return handle.db;
}

describe("migration 0170, pinning module versions", () => {
  it("pins every live module step to its module's newest approved version, or its newest where none is approved", () => {
    const db = migrated();
    const pins = db.all<{ id: string; module_version: number | null }>(sql`SELECT id, module_version FROM pipeline_steps WHERE pipeline_id = 'p' ORDER BY position`);
    expect(pins).toEqual([
      { id: "s-approved", module_version: 3 },
      { id: "s-draft", module_version: 2 },
      // Not a module step, and a module with no version at all: no pin.
      { id: "s-agent", module_version: null },
      { id: "s-gone", module_version: null },
    ]);
  });

  it("pins every live module entry rule the same way, in place, and leaves every other rule as it was", () => {
    const db = migrated();
    const row = db.get<{ entry_rules: string }>(sql`SELECT entry_rules FROM pipelines WHERE id = 'p'`);
    expect(JSON.parse(row!.entry_rules)).toEqual([
      { kind: "description" },
      { kind: "module", module: "approved", timeoutMs: 5000, moduleVersion: 3 },
      { kind: "module", module: "draft", moduleVersion: 2 },
      // Never a null: a rule naming a module with no version stays unpinned.
      { kind: "module", module: "nowhere" },
    ]);
  });

  it("pins the steps and the entry rules of every stored pipeline version, in order", () => {
    const db = migrated();
    const row = db.get<{ steps: string; entry_rules: string }>(sql`SELECT steps, entry_rules FROM pipeline_versions WHERE id = 'v1'`);
    const steps = JSON.parse(row!.steps) as { id: string; moduleVersion?: number }[];
    expect(steps.map((step) => [step.id, step.moduleVersion ?? null])).toEqual([
      ["s-approved", 3],
      ["s-draft", 2],
      ["s-agent", null],
    ]);
    expect(JSON.parse(row!.entry_rules)).toEqual([
      { kind: "description" },
      { kind: "module", module: "approved", timeoutMs: 5000, moduleVersion: 3 },
      { kind: "module", module: "draft", moduleVersion: 2 },
      { kind: "module", module: "nowhere" },
    ]);
  });
});
