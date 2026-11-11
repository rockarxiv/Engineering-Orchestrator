import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { gitStateOf, jiraStateOf, adminToolsEnabled, configToolsEnabled, fullThreadEnabled, memoryNoteEnabled, reusesThreadPerItem, LOCAL_PERSON_ID, LOCAL_PERSON_NAME, type Uuid } from "@eo/core";
import { registry } from "../registry.js";
import { openDb, type DbHandle } from "./client.js";
import { getSchemaVersion, isNewDatabase, runMigrations } from "./migrate.js";
import { listAgents } from "./repos/agentsRepo.js";
import { listMcpServers } from "./repos/mcpServersRepo.js";
import { getRun } from "./repos/runsRepo.js";
import { getModule } from "./repos/modulesRepo.js";
import { getModuleVersion, listModuleVersions } from "./repos/moduleVersionsRepo.js";
import { getComment, listCommentsForItem, needsAttention, openMentionsForHuman, postComment } from "./repos/commentsRepo.js";
import { listPeople, localPerson } from "./repos/peopleRepo.js";
import { listDependencies } from "./repos/itemDepsRepo.js";
import { listTransitionsForItem } from "./repos/transitionsRepo.js";
import { getItem, isJiraPullPending, listArchivedItems, listJiraPullPending, listItemsIncludingArchived } from "./repos/itemsRepo.js";
import { getJiraBinding, listJiraBindings } from "./repos/connectorBindingsRepo.js";
import { getWorkspace, listWorkspaces } from "./repos/workspacesRepo.js";
import { projectForWorkspace, projectWorkspaceList } from "./repos/projectsRepo.js";
import { listRepositoryIndexes } from "./repos/repositoryIndexesRepo.js";
import { getItemByKey } from "./repos/itemsRepo.js";
import { applyDiscussionProposal } from "../roles/discussion.js";

import { createTestItem } from "./testHelpers.js";
import { getPipeline, listRoutesForPipeline, listStepsForPipeline, replacePipelineGraph } from "./repos/pipelineStepsRepo.js";
import { ensureCurrentVersion, graphForItem, listPipelineVersions, stepForItem, versionGraph, versionSnapshot } from "./repos/pipelineVersionsRepo.js";
// Hand-written instead of drizzle-kit-generated: this set intentionally
// contains a broken second migration, to prove a failure rolls back the
// whole batch rather than leaving a half-migrated DB.
function writeBrokenMigrationSet(dir: string): void {
  mkdirSync(join(dir, "meta"), { recursive: true });
  writeFileSync(
    join(dir, "meta", "_journal.json"),
    JSON.stringify({
      version: "7",
      dialect: "sqlite",
      entries: [
        { idx: 0, version: "6", when: 1, tag: "0000_good", breakpoints: true },
        { idx: 1, version: "6", when: 2, tag: "0001_bad", breakpoints: true },
      ],
    }),
  );
  writeFileSync(join(dir, "0000_good.sql"), "CREATE TABLE ok (id text primary key);");
  writeFileSync(join(dir, "0001_bad.sql"), "THIS IS NOT VALID SQL AT ALL;");
}

/**
 * The migration set as it stood before the last migration — what an
 * existing user's database was migrated with on their previous launch.
 */
/**
 * The migration set as it stood before `stopBefore` — a tag fragment,
 * not a count. A count was wrong the moment another migration landed
 * after the one a test cares about.
 */
function writeMigrationSetBefore(dir: string, stopBefore: string): void {
  const source = join(dirname(fileURLToPath(import.meta.url)), "migrations");
  const journal = JSON.parse(readFileSync(join(source, "meta", "_journal.json"), "utf8")) as { entries: { idx: number; tag: string }[] };
  const stopAt = journal.entries.findIndex((entry) => entry.tag.includes(stopBefore));
  if (stopAt === -1) throw new Error(`no migration tagged "${stopBefore}"`);

  const kept = journal.entries.slice(0, stopAt);
  mkdirSync(join(dir, "meta"), { recursive: true });
  writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: kept }));
  for (const entry of kept) {
    writeFileSync(join(dir, `${entry.tag}.sql`), readFileSync(join(source, `${entry.tag}.sql`), "utf8"));
  }
}

/**
 * Step rows as they read once 0123 has run over them (EO-461): Done one
 * position along, to make room for the pull request watch before it.
 *
 * For the tests of earlier migrations that replay every later one and
 * then hold the rows they did not mean to touch to what was there before.
 * 0123 does touch one of them, on purpose, and this says by how much
 * rather than leaving `ready_to_merge` out of the comparison.
 */
function afterThePullRequestWatch(rows: unknown[]): unknown[] {
  return rows.map((row) =>
    typeof row === "object" && row !== null && "id" in row && row.id === "ready_to_merge" && "position" in row && typeof row.position === "number"
      ? { ...row, position: row.position + 1 }
      : row,
  );
}

/**
 * The upgrade stopped before 0168, which retired the project and job
 * threads (EO-730): for the tests of 0078 and 0119, which added the steps
 * 0168 removes again.
 */
function runMigrationsBeforeTheThreadsRetired(db: DbHandle["db"]): void {
  const dir = mkdtempSync(join(tmpdir(), "eo-before-0168-"));
  try {
    writeMigrationSetBefore(dir, "0168_retire_threads");
    runMigrations(db, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Step rows as they read once 0168 has run over them (EO-730): the
 * project and job threads' steps gone. For the tests of earlier
 * migrations that replay every later one.
 */
function withoutThreadSteps(rows: unknown[]): unknown[] {
  return rows.filter((row) => !(typeof row === "object" && row !== null && "id" in row && (row.id === "job-thread" || row.id === "project-thread")));
}

/**
 * Step rows as they read once 0141 has run over them (EO-571): every one
 * has `watch_never_gives_up`, and it is 0, so every watch keeps the
 * deadline it had. For the tests of earlier migrations that replay every
 * later one and hold the step rows to what was there before.
 */
function afterNeverGivingUp(rows: unknown[]): unknown[] {
  return rows.map((row) => (typeof row === "object" && row !== null ? { ...row, watch_never_gives_up: 0 } : row));
}

/**
 * Agent rows as they read once 0126 and 0148 have run over them (EO-479,
 * EO-593): every agent holds the `memory_note` grant — appended to an
 * allowlist it had, or as the whole of one it did not — but a preview
 * agent, and one whose `allowedTools` is not a list. 0126 granted the
 * implementer, the reviewer and the system agent; 0148 every other role.
 *
 * For the tests of earlier migrations that replay every later one and
 * hold the agent rows to what was there before, in the way
 * `afterThePullRequestWatch` is for steps: those two touch these rows on
 * purpose, and this says by how much.
 */
function afterTheMemoryNoteGrant<T extends { role: string; config: Record<string, unknown> }>(rows: T[]): T[] {
  return rows.map((row) => {
    if (row.config["eoPreviewAgent"] === true) return row;
    const allowed = row.config["allowedTools"];
    if (allowed === undefined) return { ...row, config: { ...row.config, allowedTools: ["mcp__eo__memory_note"] } };
    if (!Array.isArray(allowed) || allowed.includes("mcp__eo__memory_note")) return row;
    return { ...row, config: { ...row.config, allowedTools: [...(allowed as unknown[]), "mcp__eo__memory_note"] } };
  });
}

/**
 * `afterTheMemoryNoteGrant`, and then 0157 (EO-633): `repository_checkout`
 * appended once to every allowlist naming `attachment_read`. The order is
 * the migrations', so an allowlist reads as it would after both.
 */
function afterTheRepositoryCheckoutGrant<T extends { role: string; config: Record<string, unknown> }>(rows: T[]): T[] {
  return afterTheMemoryNoteGrant(rows).map((row) => {
    const allowed = row.config["allowedTools"];
    if (!Array.isArray(allowed) || !allowed.includes("mcp__eo__attachment_read") || allowed.includes("mcp__eo__repository_checkout")) return row;
    return { ...row, config: { ...row.config, allowedTools: [...(allowed as unknown[]), "mcp__eo__repository_checkout"] } };
  });
}

function writePreviousMigrationSet(dir: string, dropLast = 1): { droppedTag: string } {
  const source = join(dirname(fileURLToPath(import.meta.url)), "migrations");
  const journal = JSON.parse(readFileSync(join(source, "meta", "_journal.json"), "utf8")) as {
    entries: { idx: number; tag: string }[];
  };
  const kept = journal.entries.slice(0, -dropLast);
  const dropped = journal.entries.at(-dropLast)!;

  mkdirSync(join(dir, "meta"), { recursive: true });
  writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: kept }));
  for (const entry of kept) {
    writeFileSync(join(dir, `${entry.tag}.sql`), readFileSync(join(source, `${entry.tag}.sql`), "utf8"));
  }
  return { droppedTag: dropped.tag };
}

/**
 * The `agents` table as an older schema holds it (EO-186).
 *
 * `listAgents` selects every column the *code* knows about, so the
 * moment `agents` grows one it can no longer read a database migrated
 * only as far as some earlier point — which is precisely what a
 * before-and-after migration test holds in its hands. Raw SQL, narrowed
 * once here, is how the "before" half is read; the "after" half goes on
 * using the repository, because by then the schema is the current one.
 */
function agentRowsOn(handle: DbHandle): { id: string; role: string; enabled: number; instructions: string; config: Record<string, unknown> }[] {
  return handle.db
    .all<{ id: string; role: string; enabled: number; instructions: string; config: string }>(
      sql`SELECT id, role, enabled, instructions, config FROM agents`,
    )
    .map((row) => ({ ...row, config: JSON.parse(row.config) as Record<string, unknown> }));
}

describe("runMigrations", () => {
  let handle: DbHandle;
  let tempDir: string;

  afterEach(() => {
    handle.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("upgrades a database that already has data in it, without losing any", () => {
    // Every other test migrates from empty, which is the one case a
    // real user is never in. This is the actual upgrade path: a
    // database migrated by the previous release, opened by this one.
    handle = openDb(":memory:");
    tempDir = mkdtempSync(join(tmpdir(), "eo-previous-migrations-"));
    const { droppedTag } = writePreviousMigrationSet(tempDir);

    runMigrations(handle.db, tempDir);
    const before = getSchemaVersion(handle.db).migrationsApplied;

    // An item and a run, written by the previous version of the app —
    // in that version's shape, which is what makes this the upgrade path
    // rather than a fresh install. `state` became `pipeline_id`/`step_id`
    // in 0028, `type` became a `type_id` foreign key in 0069 and the Jira
    // columns left in 0071, so this follows whatever the previous set
    // left behind: a row on the type row that set seeded, and no Jira
    // columns to name.
    handle.db.run(
      sql`INSERT INTO items (id, key, type_id, title, pipeline_id, step_id, priority, created_at, updated_at)
          SELECT 't1', 'EO-1', id, 'Existing work', 'default', 'todo', 0, 1, 1
          FROM item_types WHERE slug = 'story' AND project_id IS NULL LIMIT 1`,
    );
    handle.db.run(
      sql`INSERT INTO runs (id, item_id, agent_id, action, status, attempt)
          SELECT 'r1', 't1', id, 'implement', 'awaiting_input', 1 FROM agents LIMIT 1`,
    );

    runMigrations(handle.db, join(dirname(fileURLToPath(import.meta.url)), "migrations"));

    expect(getSchemaVersion(handle.db).migrationsApplied, `${droppedTag} did not apply`).toBe(before + 1);
    const rows = handle.db.all<{ key: string; title: string; stepId: string; status: string; heldAt: number | null }>(
      sql`SELECT items.key AS key, items.title AS title, items.step_id AS stepId,
                 runs.status AS status, items.held_at AS heldAt
          FROM runs JOIN items ON items.id = runs.item_id`,
    );
    expect(rows).toEqual([{ key: "EO-1", title: "Existing work", stepId: "todo", status: "awaiting_input", heldAt: null }]);
  });

  /**
   * The rename, on a database that had things in it (KAN-145).
   *
   * 0068 is the largest rename EO has done — two tables, seven columns
   * and five indexes — and the thing that could go wrong is not that it
   * fails. A rename that fails is loud. A rename that quietly takes a
   * row's foreign key with it, or leaves a stored key nothing reads any
   * more, is the failure worth a test: the app still opens, the board is
   * just emptier than it was.
   *
   * So this seeds one of every kind of row that names an item — the
   * item, its dependency, its run, its comment, its attachment, its
   * transition, its outbox entry and its repository index — plus the
   * three JSON documents that spell the word in a key, and reads every
   * one of them back through the new names afterwards. Seeded in the
   * *old* shape, because that is what a database being upgraded holds;
   * `writeMigrationSetBefore` is what makes that the schema in hand.
   */
  it("carries every row and every stored setting through the items-to-items rename", () => {
    handle = openDb(":memory:");
    tempDir = mkdtempSync(join(tmpdir(), "eo-items-rename-"));
    writeMigrationSetBefore(tempDir, "0068_tickets_are_items");
    runMigrations(handle.db, tempDir);

    handle.db.run(sql`INSERT INTO repositories (id, name, repo_path, created_at, updated_at) VALUES ('repo1', 'The repo', '/tmp/repo', 1, 1)`);
    handle.db.run(sql`INSERT INTO projects (id, name, key_prefix, created_at, updated_at) VALUES ('proj1', 'The project', 'ACME', 1, 1)`);
    handle.db.run(
      sql`INSERT INTO tickets (id, key, type, repository_id, project_id, title, pipeline_id, step_id, priority, held_at, created_at, updated_at)
          VALUES ('t1', 'ACME-1', 'story', 'repo1', 'proj1', 'The first', 'default', 'todo', 0, 4242, 1, 1),
                 ('t2', 'ACME-2', 'story', 'repo1', 'proj1', 'The second', 'default', 'todo', 0, NULL, 1, 1)`,
    );
    // The dependency is the one row whose *table* is renamed as well as
    // its column, so it is the one that proves the two passes agree.
    handle.db.run(sql`INSERT INTO ticket_deps (ticket_id, depends_on_id) VALUES ('t2', 't1')`);
    handle.db.run(
      sql`INSERT INTO runs (id, ticket_id, agent_id, action, status, attempt)
          SELECT 'run1', 't1', id, 'implement', 'succeeded', 1 FROM agents LIMIT 1`,
    );
    handle.db.run(
      sql`INSERT INTO comments (id, ticket_id, run_id, author_type, body, kind, created_at)
          VALUES ('c1', 't1', 'run1', 'human', 'Said something', 'note', 7)`,
    );
    handle.db.run(
      sql`INSERT INTO attachments (id, ticket_id, comment_id, storage_path, name, mime_type, size, created_at)
          VALUES ('a1', 't1', 'c1', '/tmp/x.png', 'x.png', 'image/png', 3, 8)`,
    );
    handle.db.run(
      sql`INSERT INTO transitions (id, ticket_id, from_step_id, to_step_id, actor, run_id, ts)
          VALUES ('tr1', 't1', 'todo', 'review', 'human', 'run1', 9)`,
    );
    handle.db.run(
      sql`INSERT INTO outbox (id, ticket_id, repository_id, kind, payload, next_attempt_at, created_at)
          VALUES ('o1', 't1', 'repo1', 'status', '{}', 10, 10)`,
    );
    handle.db.run(
      sql`INSERT INTO repository_indexes (id, repository_id, ticket_id, provider, index_path, status)
          VALUES ('ri1', 'repo1', 't1', 'codewiki', '/tmp/index', 'ready')`,
    );
    // The three stored documents, in the spelling the code used to read.
    handle.db.run(
      sql`INSERT INTO app_settings (key, value, updated_at)
          VALUES ('engine.guards', '{"perTicketBudgetCents":2500,"perTicketAttemptLimit":7,"dailyBudgetCents":5000}', 1)`,
    );
    handle.db.run(
      sql`INSERT INTO agents (id, name, role, provider, model, instructions, config, enabled)
          VALUES ('019fb8c6-de91-7cdd-b0c6-000000014501', 'Tester', 'tester', 'fake', NULL, 'Mine.', '{"reuseThreadPerTicket":true,"effort":"high"}', 1)`,
    );
    handle.db.run(
      sql`INSERT INTO modules (id, slug, name, description, code, manifest, created_at, updated_at)
          VALUES ('019fb8c6-de91-7cdd-b0c6-000000014502', 'notes', 'Release notes', 'Writes them.', 'export default () => {};',
                  '{"name":"Release notes","description":"Writes them.","inputs":{},"needs":{"bin":[],"env":[],"network":false,"ticket":true,"comment":false},"results":["written"]}', 1, 1)`,
    );

    runMigrations(handle.db, join(dirname(fileURLToPath(import.meta.url)), "migrations"));

    // Nothing orphaned: the rename rewrote the REFERENCES clauses of
    // every table that pointed at `tickets`, and this is what proves it
    // rather than the absence of a thrown error.
    expect(handle.db.all(sql`PRAGMA foreign_key_check`)).toEqual([]);

    // Every item, read through the repository rather than through SQL,
    // so the code's own column names are exercised too.
    expect(listItemsIncludingArchived(handle.db).map((item) => item.key).sort()).toEqual(["ACME-1", "ACME-2"]);
    const first = getItem(handle.db, "t1" as Uuid)!;
    expect(first.title).toBe("The first");
    // A hold is on the one column whose index had to be dropped and
    // remade under a new name, so it is worth reading back.
    expect(first.heldAt).toBe(4242);

    expect(listDependencies(handle.db, "t2" as Uuid).map((dep) => dep.dependsOnId)).toEqual(["t1"]);
    expect(getRun(handle.db, "run1" as Uuid)?.itemId).toBe("t1");
    expect(listCommentsForItem(handle.db, "t1" as Uuid).map((comment) => comment.body)).toEqual(["Said something"]);
    expect(listTransitionsForItem(handle.db, "t1" as Uuid).map((entry) => entry.toStepId)).toEqual(["review"]);
    expect(
      handle.db.all<{ id: string; item_id: string }>(sql`SELECT id, item_id FROM attachments`),
    ).toEqual([{ id: "a1", item_id: "t1" }]);
    expect(handle.db.all<{ id: string; item_id: string }>(sql`SELECT id, item_id FROM outbox`)).toEqual([{ id: "o1", item_id: "t1" }]);
    expect(
      handle.db.all<{ id: string; item_id: string | null }>(sql`SELECT id, item_id FROM repository_indexes`),
    ).toEqual([{ id: "ri1", item_id: "t1" }]);

    // The three documents say the same thing under the new keys. A
    // budget somebody set is the one that would have gone unnoticed:
    // its default is "no ceiling", so losing it removes a limit rather
    // than reporting one.
    const guards = handle.db.get<{ value: string }>(sql`SELECT value FROM app_settings WHERE key = 'engine.guards'`)!.value;
    expect(JSON.parse(guards)).toEqual({ perItemBudgetCents: 2500, perItemAttemptLimit: 7, dailyBudgetCents: 5000 });

    const agent = listAgents(handle.db).find((candidate) => candidate.role === "tester")!;
    // With the `memory_note` grant 0148 gives every role (EO-593).
    expect(agent.config).toEqual({ reuseThreadPerItem: true, effort: "high", allowedTools: ["mcp__eo__memory_note"] });
    expect(reusesThreadPerItem(registry, agent)).toBe(true);

    const manifest = handle.db.get<{ manifest: string }>(sql`SELECT manifest FROM modules WHERE slug = 'notes'`)!.manifest;
    expect((JSON.parse(manifest) as { needs: Record<string, unknown> }).needs).toEqual({
      bin: [],
      env: [],
      network: false,
      item: true,
      comment: false,
    });

    // And the word is gone from the schema itself, which is the part a
    // later migration would otherwise trip over.
    const named = handle.db.all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE name LIKE '%ticket%'`);
    expect(named).toEqual([]);
  });

  /**
   * The type stops being a word on the item (KAN-129).
   *
   * The migration has to hold in three cases that are easy to write past.
   * An item on a project takes that project's row; an item written before
   * any repository was attached — `items.project_id` is nullable and
   * `adoptProjectlessItems` is what later claims one — takes the
   * installation's; and an item calling itself something EO never
   * shipped, which `items:update` has always been able to write, takes a
   * row invented for it rather than leaving a NOT NULL column unfillable
   * and an app that will not open.
   *
   * Seeded in the *old* shape, because that is what a database being
   * upgraded holds.
   */
  it("puts every item on a type row, whatever it called itself and whatever project it was on", () => {
    handle = openDb(":memory:");
    tempDir = mkdtempSync(join(tmpdir(), "eo-item-types-"));
    writeMigrationSetBefore(tempDir, "0069_item_types");
    runMigrations(handle.db, tempDir);

    handle.db.run(sql`INSERT INTO projects (id, name, key_prefix, created_at, updated_at) VALUES ('proj1', 'The project', 'ACME', 1, 1)`);
    handle.db.run(
      sql`INSERT INTO items (id, key, type, project_id, title, pipeline_id, step_id, priority, created_at, updated_at)
          VALUES ('t1', 'ACME-1', 'feature', 'proj1', 'A container', NULL, NULL, 0, 1, 1),
                 ('t2', 'ACME-2', 'story', 'proj1', 'Some work', 'default', 'todo', 0, 1, 1),
                 ('t3', 'ACME-3', 'bug', 'proj1', 'Something broken', 'default', 'todo', 0, 1, 1),
                 ('t4', 'ACME-4', 'epic', 'proj1', 'A word EO never shipped', 'default', 'todo', 0, 1, 1),
                 ('t5', 'EO-1', 'story', NULL, 'Before any repository', 'default', 'todo', 0, 1, 1)`,
    );

    runMigrations(handle.db, join(dirname(fileURLToPath(import.meta.url)), "migrations"));

    // Nothing orphaned: `runMigrations` checks this itself, and saying so
    // here is what makes the failure read as this migration's.
    expect(handle.db.all(sql`PRAGMA foreign_key_check`)).toEqual([]);

    expect(
      handle.db.all<{ key: string; slug: string; scope: string | null; container: number; pack: string }>(
        sql`SELECT items.key AS key, item_types.slug AS slug, item_types.project_id AS scope,
                   item_types.container AS container, item_types.pack_slug AS pack
            FROM items JOIN item_types ON item_types.id = items.type_id
            ORDER BY items.key`,
      ),
    ).toEqual([
      { key: "ACME-1", slug: "feature", scope: "proj1", container: 1, pack: "developer" },
      { key: "ACME-2", slug: "story", scope: "proj1", container: 0, pack: "developer" },
      { key: "ACME-3", slug: "bug", scope: "proj1", container: 0, pack: "developer" },
      { key: "ACME-4", slug: "epic", scope: "proj1", container: 0, pack: "developer" },
      { key: "EO-1", slug: "story", scope: null, container: 0, pack: "developer" },
    ]);

    // The spec shape travelled with the labels, since KAN-147 composes
    // the intake schema from it and validates a new item's spec against
    // it — a row without it would ask for nothing and accept anything.
    // 0069 wrote it as a list of names; 0070 rewrote it as the JSON Schema
    // both of those readers take.
    const story = handle.db.get<{ spec_shape: string; label: string; plural: string }>(
      sql`SELECT spec_shape, label, plural FROM item_types WHERE slug = 'story' AND project_id = 'proj1'`,
    )!;
    expect(story).toMatchObject({ label: "Story", plural: "Stories" });
    expect(JSON.parse(story.spec_shape)).toMatchObject({
      type: "object",
      required: ["acceptance_criteria"],
      properties: { acceptance_criteria: { type: "array", minItems: 1, "x-eo-criteria": true } },
    });

    // And refine's two shapes, which five branches said in code
    // (ARCHITECTURE.md, "An item type is data") and the rows have said as data from the day
    // the table existed — KAN-163 reads them, and a migration that wrote
    // NULL would leave every upgraded installation without them.
    const overrides = Object.fromEntries(
      handle.db
        .all<{ slug: string; action_overrides: string }>(sql`SELECT slug, action_overrides FROM item_types WHERE project_id = 'proj1'`)
        .map((row) => [row.slug, JSON.parse(row.action_overrides)]),
    );
    expect(overrides.feature).toEqual({ refine: { schema: "refine", resultKey: "decomposed", poster: "refine_proposal" } });
    const clarifies = { refine: { schema: "clarify", resultKey: "clarified", poster: "clarification_note" } };
    expect(overrides.story).toEqual(clarifies);
    expect(overrides.bug).toEqual(clarifies);
    // The invented type is a leaf, so it inherits the leaf answer —
    // which is what the branch it replaces already did with a word that
    // was not "feature".
    expect(overrides.epic).toEqual(clarifies);

    // And the column itself is gone, which is the half a later story
    // reading `items.type` would otherwise get away with.
    const columns = handle.db.all<{ name: string }>(sql`SELECT name FROM pragma_table_info('items')`).map((column) => column.name);
    expect(columns).toContain("type_id");
    expect(columns).not.toContain("type");

    // Read back through the repository as well, because what every
    // caller holds is `Item.type` — still the word, now from the join.
    expect(listItemsIncludingArchived(handle.db).find((item) => item.key === "ACME-3")?.type).toBe("bug");
  });

  /**
   * A spec shape becomes a JSON Schema (KAN-147).
   *
   * 0069 wrote `[{"name":...,"required":...}]`, which nothing read. What
   * reads it now validates an item's spec against it and composes the
   * intake schema from it, and both want a document — so an installation
   * upgraded through 0069 has rows in a form neither can use, and a row
   * whose shape does not parse is read as a type that demands nothing.
   * Silent, safe, and wrong about a field somebody declared.
   *
   * Two halves. The three the developer pack ships are set to the
   * documents it ships, kinds and annotations included, because EO knows
   * what those fields are. Anything else is converted generically — every
   * field a string, `required` preserved — because a shape is data a pack
   * wrote and the old form never said what a field was. Seeded here on a
   * pack of this test's own, which is the only way to exercise the half
   * that no shipped row takes.
   */
  it("rewrites every spec shape as a JSON Schema, generically where it cannot know better", () => {
    handle = openDb(":memory:");
    tempDir = mkdtempSync(join(tmpdir(), "eo-spec-shapes-"));
    writeMigrationSetBefore(tempDir, "0070_spec_shape_is_a_schema");
    runMigrations(handle.db, tempDir);

    handle.db.run(
      sql`INSERT INTO item_types (id, project_id, pack_slug, slug, label, plural, container, spec_shape, action_overrides, created_at)
          VALUES ('it1', NULL, 'support', 'case', 'Case', 'Cases', 0,
                  '[{"name":"customer","required":true},{"name":"channel","required":false}]', '{}', 1)`,
    );

    runMigrations(handle.db, join(dirname(fileURLToPath(import.meta.url)), "migrations"));

    const shapeOf = (slug: string): Record<string, unknown> =>
      JSON.parse(handle.db.get<{ spec_shape: string }>(sql`SELECT spec_shape FROM item_types WHERE slug = ${slug} AND project_id IS NULL`)!.spec_shape);

    // What EO knows: the kinds, and the two keywords that say which field
    // holds the criteria and which may be offered as one.
    expect(shapeOf("story")).toMatchObject({
      required: ["acceptance_criteria"],
      properties: { acceptance_criteria: { type: "array", items: { type: "string" }, "x-eo-criteria": true } },
    });
    expect(shapeOf("bug")).toMatchObject({
      required: ["steps_to_reproduce", "expected", "actual", "environment"],
      properties: { expected: { type: "string", "x-eo-criteria-offer": true } },
    });
    // A container demands nothing, and that is a document rather than an
    // absence: an empty array read as a shape is a shape that does not
    // parse.
    expect(shapeOf("feature")).toEqual({ type: "object", properties: {}, required: [] });

    // And what it does not: every field a string, and only the ones the
    // old form called required still required.
    expect(shapeOf("case")).toEqual({
      type: "object",
      properties: { customer: { type: "string" }, channel: { type: "string" } },
      required: ["customer"],
    });
  });

  /**
   * A proposal somebody has been shown but not yet approved (KAN-145).
   *
   * The rename reached further than the schema: a `discuss` or `assist`
   * turn's stored result names the item an `amend` is about, that field
   * was `ticket`, and the card it produced is still on the screen.
   * `applyDiscussionProposal` re-reads the run's result when Approve is
   * clicked rather than trusting the card, so without 0068 rewriting it
   * the person is told "the run behind this proposal no longer has a
   * readable result" about work they were in the middle of — while the
   * run, the comment and the card itself all survived perfectly well.
   *
   * Seeded at index 1 of a two-proposal turn, deliberately. A turn posts
   * one comment per proposal and `proposalOfComment` finds which
   * proposal a card is *by its position*, so a migration that rebuilt
   * the array in a different order would not fail — it would apply the
   * wrong proposal. Approving the second card here has to amend EO-1 and
   * not create a story.
   */
  it("leaves an unapproved proposal approvable across the rename", () => {
    handle = openDb(":memory:");
    tempDir = mkdtempSync(join(tmpdir(), "eo-proposal-rename-"));
    writeMigrationSetBefore(tempDir, "0068_tickets_are_items");
    runMigrations(handle.db, tempDir);

    // The work the amendment is about, and two assistant chats it could
    // have been proposed in, one result in each shape a turn has written.
    // (Discussions shared `DiscussionProposalSchema` and the breakage
    // until EO-526 removed it; its cards are no longer approvable.)
    handle.db.run(
      sql`INSERT INTO tickets (id, key, type, title, pipeline_id, step_id, priority, created_at, updated_at)
          VALUES ('t-target', 'EO-1', 'story', 'Rate limit the import', 'default', 'todo', 0, 1, 1),
                 ('t-other', 'EO-2', 'story', 'Something else', 'default', 'todo', 0, 1, 1),
                 ('c-disc', 'ASK-2', 'story', 'How should this work?', 'discussions', 'assist', 0, 1, 1),
                 ('c-assist', 'ASK-1', 'story', 'Help', 'discussions', 'assist', 0, 1, 1)`,
    );

    // In the shape a turn wrote before the rename: `ticket`, not `item`.
    // `raw` and `parsed` carry the same thing, which is what an action
    // whose schema validated cleanly leaves behind.
    const discussed = {
      raw: {
        message: "Two things.",
        proposals: [
          { action: "new_story", title: "A follow-up", body: "later", acceptance_criteria: ["It is done."] },
          { action: "amend", ticket: "EO-1", why: "the cap was wrong", title: "Rate limit the import at 100/min" },
        ],
      },
      parsed: {
        message: "Two things.",
        proposals: [
          { action: "new_story", title: "A follow-up", body: "later", acceptance_criteria: ["It is done."] },
          { action: "amend", ticket: "EO-1", why: "the cap was wrong", title: "Rate limit the import at 100/min" },
        ],
      },
    };
    // The other chat's, and deliberately in the older shape: a result
    // written before A-02 *is* the parsed value, with no wrapper at all,
    // and `parsedResultOf` still reads it.
    const assisted = { message: "One thing.", proposals: [{ action: "amend", ticket: "EO-2", why: "clearer", title: "Something else entirely" }] };

    handle.db.run(
      sql`INSERT INTO runs (id, ticket_id, agent_id, action, status, attempt, result)
          SELECT 'r-disc', 'c-disc', id, 'assist', 'succeeded', 1, ${JSON.stringify(discussed)} FROM agents LIMIT 1`,
    );
    handle.db.run(
      sql`INSERT INTO runs (id, ticket_id, agent_id, action, status, attempt, result)
          SELECT 'r-assist', 'c-assist', id, 'assist', 'succeeded', 1, ${JSON.stringify(assisted)} FROM agents LIMIT 1`,
    );
    // One comment per proposal, in the order the turn posted them —
    // which is what makes the second card the amendment.
    handle.db.run(
      sql`INSERT INTO comments (id, ticket_id, run_id, author_type, author_id, kind, body, created_at)
          SELECT 'cm-story', 'c-disc', 'r-disc', 'agent', id, 'decision', 'A follow-up', 10 FROM agents LIMIT 1`,
    );
    handle.db.run(
      sql`INSERT INTO comments (id, ticket_id, run_id, author_type, author_id, kind, body, created_at)
          SELECT 'cm-amend', 'c-disc', 'r-disc', 'agent', id, 'decision', 'Amend EO-1', 11 FROM agents LIMIT 1`,
    );
    handle.db.run(
      sql`INSERT INTO comments (id, ticket_id, run_id, author_type, author_id, kind, body, created_at)
          SELECT 'cm-assist', 'c-assist', 'r-assist', 'agent', id, 'decision', 'Amend EO-2', 12 FROM agents LIMIT 1`,
    );

    runMigrations(handle.db, join(dirname(fileURLToPath(import.meta.url)), "migrations"));

    // Approved the way the button does it, through the same function the
    // card calls — not by re-parsing the row, which would prove only
    // that the migration wrote what the migration wrote.
    const conversation = getItem(handle.db, "c-disc" as Uuid)!;
    const applied = applyDiscussionProposal(handle.db, conversation, "cm-amend" as Uuid);

    expect(applied.ok, applied.ok ? "" : applied.reason).toBe(true);
    expect(getItemByKey(handle.db, "EO-1")?.title).toBe("Rate limit the import at 100/min");
    // The second card was the amendment, so nothing was created: an
    // array rebuilt out of order would have run the `new_story` here.
    expect(applied.ok && applied.created).toEqual([]);

    // And the result in the older shape, which shared the bug.
    const room = getItem(handle.db, "c-assist" as Uuid)!;
    const fromAssist = applyDiscussionProposal(handle.db, room, "cm-assist" as Uuid);

    expect(fromAssist.ok, fromAssist.ok ? "" : fromAssist.reason).toBe(true);
    expect(getItemByKey(handle.db, "EO-2")?.title).toBe("Something else entirely");

    // What the agent actually said is left exactly as it said it. The
    // two halves of `runs.result` disagree after this, on purpose: only
    // the half EO acts on is EO's to restate.
    const stored = handle.db.get<{ result: string }>(sql`SELECT result FROM runs WHERE id = 'r-disc'`)!.result;
    const both = JSON.parse(stored) as { raw: { proposals: Record<string, unknown>[] }; parsed: { proposals: Record<string, unknown>[] } };
    expect(both.raw.proposals[1]).toHaveProperty("ticket");
    expect(both.raw.proposals[1]).not.toHaveProperty("item");
    expect(both.parsed.proposals[1]).toHaveProperty("item");
    expect(both.parsed.proposals[1]).not.toHaveProperty("ticket");
    // And a proposal that never named an item is untouched rather than
    // given an `"item": null` it never had.
    expect(both.parsed.proposals[0]).toEqual({ action: "new_story", title: "A follow-up", body: "later", acceptance_criteria: ["It is done."] });
  });

  /**
   * Which of the two a database is, asked in the one moment it can be
   * (EO-211).
   *
   * A default guard applied to an installation that ran without one is
   * news; the same default on a database being born with it is not. The
   * guards row cannot tell them apart — an installation nobody ever
   * configured has no row, and neither does a brand-new one — so this is
   * what does, and it only answers before the migrations run.
   */
  it("tells a database it is creating from one it is upgrading, before the migrations blur them", () => {
    handle = openDb(":memory:");
    tempDir = mkdtempSync(join(tmpdir(), "eo-new-database-"));
    // Only so `afterEach` has something to remove; this test's answer
    // comes from the database, not the migration set.
    mkdirSync(tempDir, { recursive: true });

    expect(isNewDatabase(handle.db)).toBe(true);

    runMigrations(handle.db, join(dirname(fileURLToPath(import.meta.url)), "migrations"));

    // The same file a moment later. Nothing in it now says which it was,
    // which is the whole reason the question is asked when it is.
    expect(isNewDatabase(handle.db)).toBe(false);
  });

  it("does not call a database migrated by the previous release new", () => {
    // The actual upgrade path, and the installation EO-211 is about: one
    // that has been in use — here without ever saving guardrails, which
    // is what leaves it indistinguishable from a fresh install by every
    // other measure.
    handle = openDb(":memory:");
    tempDir = mkdtempSync(join(tmpdir(), "eo-existing-installation-"));
    writePreviousMigrationSet(tempDir);
    runMigrations(handle.db, tempDir);

    expect(isNewDatabase(handle.db)).toBe(false);
    expect(handle.db.all(sql`select key from app_settings where key = 'engine.guards'`)).toEqual([]);
  });

  it("reads a run written before the instructions-hash column as null", () => {
    // EO-87 records what each run's thread was started with. Every row
    // that predates the column has no answer to that, and the absence
    // has to map — silently, as null — rather than break every read of
    // an existing database.
    handle = openDb(":memory:");
    tempDir = mkdtempSync(join(tmpdir(), "eo-instructions-hash-migration-"));
    writeMigrationSetBefore(tempDir, "0042_run_instructions_hash");
    runMigrations(handle.db, tempDir);
    handle.db.run(
      sql`INSERT INTO tickets (id, key, type, title, pipeline_id, step_id, priority, created_at, updated_at)
          VALUES ('t1', 'EO-1', 'story', 'Older work', 'default', 'todo', 0, 1, 1)`,
    );
    handle.db.run(
      sql`INSERT INTO runs (id, ticket_id, agent_id, action, status, attempt)
          SELECT 'r1', 't1', id, 'implement', 'succeeded', 1 FROM agents LIMIT 1`,
    );

    runMigrations(handle.db, join(dirname(fileURLToPath(import.meta.url)), "migrations"));

    // Through the repo rather than as a raw row: mapping is what a null
    // column could break.
    expect(getRun(handle.db, "r1" as Uuid)?.instructionsHash).toBeNull();
  });

  it("reads a run written before the attachments column as null, and the empty tool surface", () => {
    // EO-106 records the servers and skills each run's thread was born
    // with. Every row that predates the column has none — nothing could
    // be attached to anything before this migration, so the absence maps
    // as null, and `findReusableThread` is where that null is read as
    // the *empty* surface rather than as an unknown one.
    handle = openDb(":memory:");
    tempDir = mkdtempSync(join(tmpdir(), "eo-agent-attachments-migration-"));
    writeMigrationSetBefore(tempDir, "0052_agent_attachments");
    runMigrations(handle.db, tempDir);
    handle.db.run(
      sql`INSERT INTO tickets (id, key, type, title, pipeline_id, step_id, priority, created_at, updated_at)
          VALUES ('t1', 'EO-1', 'story', 'Older work', 'default', 'todo', 0, 1, 1)`,
    );
    handle.db.run(
      sql`INSERT INTO runs (id, ticket_id, agent_id, action, status, thread_id, attempt)
          SELECT 'r1', 't1', id, 'implement', 'succeeded', 'session-1', 1 FROM agents LIMIT 1`,
    );

    runMigrations(handle.db, join(dirname(fileURLToPath(import.meta.url)), "migrations"));

    // Through the repo rather than as a raw row: mapping is what a null
    // column could break.
    expect(getRun(handle.db, "r1" as Uuid)?.agentAttachmentsHash).toBeNull();
  });

  it("reads a run written before the thread-lost column as a thread nobody has found missing", () => {
    // EO-93 marks a thread the backend turned out not to have. Every row
    // that predates the column was written when no such question was
    // being asked, and has to keep meaning what it always meant — a
    // false here, never a null and never a true, since the marker is
    // what stops a thread being offered again.
    handle = openDb(":memory:");
    tempDir = mkdtempSync(join(tmpdir(), "eo-thread-lost-migration-"));
    writeMigrationSetBefore(tempDir, "0043_run_thread_lost");
    runMigrations(handle.db, tempDir);
    handle.db.run(
      sql`INSERT INTO tickets (id, key, type, title, pipeline_id, step_id, priority, created_at, updated_at)
          VALUES ('t1', 'EO-1', 'story', 'Older work', 'default', 'todo', 0, 1, 1)`,
    );
    handle.db.run(
      sql`INSERT INTO runs (id, ticket_id, agent_id, action, status, thread_id, attempt)
          SELECT 'r1', 't1', id, 'implement', 'succeeded', 'session-1', 1 FROM agents LIMIT 1`,
    );

    runMigrations(handle.db, join(dirname(fileURLToPath(import.meta.url)), "migrations"));

    // Through the repo rather than as a raw row: mapping is what a new
    // column could break.
    expect(getRun(handle.db, "r1" as Uuid)?.threadLost).toBe(false);
    expect(getRun(handle.db, "r1" as Uuid)?.threadId).toBe("session-1");
  });

  /**
   * EO-117: an MCP server written before the authentication kind is a
   * header-authenticated one.
   *
   * Not a fallback and not a guess. An explicit `Authorization` header is
   * exactly what a person configuring a remote server had to write when
   * this row was saved — the catalogue could express nothing else — so
   * `header` is what that row *is*, and it goes on working untouched. The
   * migration reaches that answer with a column default and without
   * reading a single header string, which is the thing the pinned
   * decision rules out.
   */
  it("reads an MCP server written before the authentication kind as a header-authenticated one", () => {
    handle = openDb(":memory:");
    tempDir = mkdtempSync(join(tmpdir(), "eo-mcp-server-auth-migration-"));
    writeMigrationSetBefore(tempDir, "0053_mcp_server_auth");
    runMigrations(handle.db, tempDir);

    // The row in the shape that set could write: no auth_kind column
    // existed, and the token was named by a header carrying `${VAR}`.
    handle.db.run(
      sql`INSERT INTO mcp_servers (id, name, transport, url, headers, env_names, enabled, created_at, updated_at)
          VALUES ('019fb8c6-de91-7cdd-b0c6-0000000000f1', 'linear', 'http', 'https://mcp.linear.app/mcp',
                  '{"Authorization":"Bearer \${LINEAR_TOKEN}"}', '["LINEAR_TOKEN"]', 1, 1, 1)`,
    );

    runMigrations(handle.db, join(dirname(fileURLToPath(import.meta.url)), "migrations"));

    // Through the repository rather than as a raw row: mapping is what a
    // new column could break, and the catalogue being listable at all is
    // half of "keeps working".
    const [server] = listMcpServers(handle.db);
    expect(server?.config).toEqual({
      transport: "http",
      url: "https://mcp.linear.app/mcp",
      // The header is untouched, which is the other half: this server
      // still authenticates exactly as it did.
      headers: { Authorization: "Bearer ${LINEAR_TOKEN}" },
      auth: { kind: "header" },
    });
    expect(server?.envNames).toEqual(["LINEAR_TOKEN"]);
    // Nothing was invented to go with it: `header` needs no variable of
    // its own, and a name here would be one nothing refers to.
    const row = handle.db.get<{ bearerTokenEnvName: string | null }>(
      sql`SELECT bearer_token_env_name AS bearerTokenEnvName FROM mcp_servers WHERE name = 'linear'`,
    );
    expect(row?.bearerTokenEnvName).toBeNull();
  });

  /**
   * EO-122: every item written before the switch existed goes on
   * talking to Jira exactly as it did.
   *
   * The migration reaches that with a column default and reads nothing.
   * Before it, "is this item mirrored" was `jira_key IS NOT NULL` and
   * nothing else, so a mirrored item must come out of this with sync
   * on — anything else silently stops a Jira somebody relies on, on the
   * launch that applies the migration. An unmirrored item takes the
   * same default and it costs nothing: the `AND jira_key` half of every
   * gate is what decides that one, before and after.
   */
  it("reads every item written before the Jira switch as one that still syncs", () => {
    handle = openDb(":memory:");
    tempDir = mkdtempSync(join(tmpdir(), "eo-jira-link-migration-"));
    writeMigrationSetBefore(tempDir, "0054_jira_link");
    runMigrations(handle.db, tempDir);

    // Two rows in the shape that set could write, with no `jira_sync`
    // column to name: one mirrored to a Jira issue, one not.
    handle.db.run(
      sql`INSERT INTO tickets (id, key, type, title, pipeline_id, step_id, priority, jira_key, jira_id, created_at, updated_at)
          VALUES ('t1', 'EO-1', 'story', 'Mirrored work', 'default', 'todo', 0, 'ACME-7', '10001', 1, 1)`,
    );
    handle.db.run(
      sql`INSERT INTO tickets (id, key, type, title, pipeline_id, step_id, priority, created_at, updated_at)
          VALUES ('t2', 'EO-2', 'story', 'Local work', 'default', 'todo', 0, 1, 1)`,
    );

    runMigrations(handle.db, join(dirname(fileURLToPath(import.meta.url)), "migrations"));

    // Through the repo rather than as a raw row: mapping is what a new
    // column could break, and the switch is a boolean on the way out —
    // read off the `jira` extension since KAN-148, where 0071 put it.
    expect(jiraStateOf(getItem(handle.db, "t1" as Uuid)!)).toMatchObject({ sync: true, key: "ACME-7" });
    expect(jiraStateOf(getItem(handle.db, "t2" as Uuid)!).sync).toBe(true);
    // Not one item by luck: nothing in that database may come back off.
    expect(listItemsIncludingArchived(handle.db).every((item) => jiraStateOf(item).sync)).toBe(true);
  });

  /**
   * KAN-148: the Jira columns leave the item row, value for value.
   *
   * Four items in the shape 0069 left behind, covering the four things
   * those columns could say: mirrored and syncing, mirrored and silenced
   * with a pull outstanding, mirrored with only the switch off, and an
   * item Jira has never heard of. Plus a comment and a file carrying the
   * two dedupe keys, which do not become JSON — a unique index is the
   * whole reason they stay columns, in side tables of their own.
   *
   * What it proves is the migration's contract in both directions:
   * every item that had something to say has a `jira` row holding
   * exactly what its columns held, an item that had nothing to say has
   * no row at all — because the accessor's defaults are what an absent
   * row means, `sync: true` included — and the columns themselves are
   * gone from all three tables.
   */
  it("moves every mirrored item's Jira columns into a jira extension row, and drops the columns", () => {
    handle = openDb(":memory:");
    tempDir = mkdtempSync(join(tmpdir(), "eo-item-extensions-migration-"));
    writeMigrationSetBefore(tempDir, "0071_item_extensions");
    runMigrations(handle.db, tempDir);

    // In the shape that set could write: `type_id` rather than the word
    // (0069), and the four Jira columns still on the row.
    const seed = (id: string, key: string, jiraColumns: string): void => {
      handle.db.run(
        sql`INSERT INTO items (id, key, type_id, title, pipeline_id, step_id, priority, jira_key, jira_id, jira_sync, jira_pull_pending, created_at, updated_at)
            SELECT ${id}, ${key}, item_types.id, ${`Item ${key}`}, 'default', 'todo', 0, ${sql.raw(jiraColumns)}, 1, 1
              FROM item_types WHERE project_id IS NULL AND slug = 'story' LIMIT 1`,
      );
    };
    seed("t1", "EO-1", "'ACME-7', '10001', 1, 0"); // mirrored and syncing
    seed("t2", "EO-2", "'ACME-8', NULL, 0, 1"); // mirrored, silenced, with a backfill outstanding
    seed("t3", "EO-3", "NULL, NULL, 0, 0"); // silenced, and attached to no issue at all
    seed("t4", "EO-4", "NULL, NULL, 1, 0"); // never been near Jira

    handle.db.run(
      sql`INSERT INTO comments (id, item_id, author_type, body, kind, attachments, pinned, jira_comment_id, created_at)
          VALUES ('c1', 't1', 'human', 'Said in Jira', 'note', '[]', 0, '10501', 1)`,
    );
    handle.db.run(
      sql`INSERT INTO attachments (id, item_id, comment_id, storage_path, name, mime_type, size, managed, jira_attachment_id, created_at)
          VALUES ('a1', 't1', 'c1', '/tmp/a1', 'diagram.png', 'image/png', 12, 1, 'remote-1', 1)`,
    );

    runMigrations(handle.db, join(dirname(fileURLToPath(import.meta.url)), "migrations"));

    // Read through the accessor, which is how every caller reads it now.
    expect(jiraStateOf(getItem(handle.db, "t1" as Uuid)!)).toEqual({ key: "ACME-7", id: "10001", sync: true, pullPending: false });
    expect(jiraStateOf(getItem(handle.db, "t2" as Uuid)!)).toEqual({ key: "ACME-8", id: null, sync: false, pullPending: true });
    expect(jiraStateOf(getItem(handle.db, "t3" as Uuid)!)).toEqual({ key: null, id: null, sync: false, pullPending: false });
    expect(jiraStateOf(getItem(handle.db, "t4" as Uuid)!)).toEqual({ key: null, id: null, sync: true, pullPending: false });
    // And the marker still drains, which is the one of the four that a
    // stored `true` has to survive as a real JSON boolean rather than
    // as the integer SQLite would have written.
    expect(listJiraPullPending(handle.db).map((item) => item.key)).toEqual(["EO-2"]);

    // A row for the three that had something to say, and none for the
    // item that never touched Jira.
    const rows = handle.db.all<{ itemId: string; extension: string }>(sql`SELECT item_id AS itemId, extension FROM item_extensions`);
    expect(rows.map((row) => row.itemId).sort()).toEqual(["t1", "t2", "t3"]);
    expect(rows.every((row) => row.extension === "jira")).toBe(true);

    // The dedupe keys, in their own tables and still on their own rows.
    expect(listCommentsForItem(handle.db, "t1" as Uuid)[0]?.jiraCommentId).toBe("10501");
    expect(handle.db.all(sql`SELECT * FROM jira_attachment_links WHERE attachment_id = 'a1' AND jira_attachment_id = 'remote-1'`)).toHaveLength(1);

    // The columns themselves are gone.
    const columns = (table: string): string[] =>
      handle.db.all<{ name: string }>(sql.raw(`PRAGMA table_info(${table})`)).map((row) => row.name);
    expect(columns("items")).not.toContain("jira_key");
    expect(columns("items")).not.toContain("jira_id");
    expect(columns("items")).not.toContain("jira_sync");
    expect(columns("items")).not.toContain("jira_pull_pending");
    expect(columns("comments")).not.toContain("jira_comment_id");
    expect(columns("attachments")).not.toContain("jira_attachment_id");
  });

  /**
   * KAN-169: the branch and the pull request leave the item row, value
   * for value (`ARCHITECTURE.md`, "One work entity").
   *
   * Four items in the shape 0074 left behind, covering everything the
   * two columns could say between them: a branch with a pull request
   * open, a branch with none yet, a pull request with no branch — which
   * is a state EO does not write but a database can hold, and dropping
   * it would lose the only link to an open pull request — and an item no
   * git workspace has ever touched.
   *
   * The contract in both directions: every item that had either column
   * set has a `git` row holding exactly what the columns held, an item
   * that had neither has no row at all because the accessor's defaults
   * are what an absent row means, and the columns are gone.
   */
  it("moves every item's branch and pull request into a git extension row, and drops the columns", () => {
    handle = openDb(":memory:");
    tempDir = mkdtempSync(join(tmpdir(), "eo-git-extension-migration-"));
    writeMigrationSetBefore(tempDir, "0075_git_item_extension");
    runMigrations(handle.db, tempDir);

    // In the shape that set could write: `type_id` rather than the word
    // (0069), no Jira columns (0071), and `branch` and `pr_url` still on
    // the row.
    const seed = (id: string, key: string, gitColumns: string): void => {
      handle.db.run(
        sql`INSERT INTO items (id, key, type_id, title, pipeline_id, step_id, priority, branch, pr_url, created_at, updated_at)
            SELECT ${id}, ${key}, item_types.id, ${`Item ${key}`}, 'default', 'todo', 0, ${sql.raw(gitColumns)}, 1, 1
              FROM item_types WHERE project_id IS NULL AND slug = 'story' LIMIT 1`,
      );
    };
    seed("t1", "EO-1", "'eo/EO-1', 'https://github.com/acme/api/pull/7'"); // cut, and open
    seed("t2", "EO-2", "'eo/EO-2', NULL"); // cut, no pull request yet
    seed("t3", "EO-3", "NULL, 'https://github.com/acme/api/pull/9'"); // a link EO must not drop
    seed("t4", "EO-4", "NULL, NULL"); // never near a git workspace

    runMigrations(handle.db, join(dirname(fileURLToPath(import.meta.url)), "migrations"));

    // Read through the accessor, which is how every caller reads it now.
    expect(gitStateOf(getItem(handle.db, "t1" as Uuid)!)).toEqual({ branch: "eo/EO-1", pullRequest: "https://github.com/acme/api/pull/7", baseBranch: null, namedBranch: false, attachedAt: null, reference: null });
    expect(gitStateOf(getItem(handle.db, "t2" as Uuid)!)).toEqual({ branch: "eo/EO-2", pullRequest: null, baseBranch: null, namedBranch: false, attachedAt: null, reference: null });
    expect(gitStateOf(getItem(handle.db, "t3" as Uuid)!)).toEqual({ branch: null, pullRequest: "https://github.com/acme/api/pull/9", baseBranch: null, namedBranch: false, attachedAt: null, reference: null });
    expect(gitStateOf(getItem(handle.db, "t4" as Uuid)!)).toEqual({ branch: null, pullRequest: null, baseBranch: null, namedBranch: false, attachedAt: null, reference: null });

    // A row for the three that had something to say, under the `git`
    // extension, and none for the item that never had a branch — beside
    // whatever `jira` rows the seed left, which this does not disturb.
    const rows = handle.db.all<{ itemId: string }>(sql`SELECT item_id AS itemId FROM item_extensions WHERE extension = 'git'`);
    expect(rows.map((row) => row.itemId).sort()).toEqual(["t1", "t2", "t3"]);

    // The columns themselves are gone.
    const columns = handle.db.all<{ name: string }>(sql.raw("PRAGMA table_info(items)")).map((row) => row.name);
    expect(columns).not.toContain("branch");
    expect(columns).not.toContain("pr_url");
  });

  /**
   * EO-127: nobody's board is pending on the launch that applies this.
   *
   * The column exists so an item attached *from now on* reads its issue
   * in. An item attached before it existed has had every scheduled pull
   * since to catch up, so marking the whole board would send one
   * `getIssue` per mirrored item for a backfill nobody asked for — and
   * would rewrite titles and descriptions across a project on an upgrade
   * that was meant to change nothing.
   */
  it("reads every item written before the pull marker as one with no pull outstanding", () => {
    handle = openDb(":memory:");
    tempDir = mkdtempSync(join(tmpdir(), "eo-jira-pull-pending-migration-"));
    writeMigrationSetBefore(tempDir, "0055_jira_pull_pending");
    runMigrations(handle.db, tempDir);

    // In the shape that set could write: mirrored, syncing, and with no
    // `jira_pull_pending` column to name.
    handle.db.run(
      sql`INSERT INTO tickets (id, key, type, title, pipeline_id, step_id, priority, jira_key, jira_sync, created_at, updated_at)
          VALUES ('t1', 'EO-1', 'story', 'Mirrored work', 'default', 'todo', 0, 'ACME-7', 1, 1, 1)`,
    );

    runMigrations(handle.db, join(dirname(fileURLToPath(import.meta.url)), "migrations"));

    expect(isJiraPullPending(handle.db, "t1" as Uuid)).toBe(false);
    // Not one item by luck: the drain must find an empty queue.
    expect(listJiraPullPending(handle.db)).toEqual([]);
  });

  it("gives the whole-thread read to whoever already had it, and to the architect", () => {
    // 0047 is where `ticket_detail` stops meaning "the item and every
    // comment on it". Anyone whose allowlist named it was reading whole
    // threads and must go on doing so under the new name — and that grant
    // is also what decides the *prompt*, so losing it would silently seed
    // the product owner in Discussions, where the thread is the work.
    handle = openDb(":memory:");
    tempDir = mkdtempSync(join(tmpdir(), "eo-thread-read-migration-"));
    writeMigrationSetBefore(tempDir, "0047_thread_read_tool");
    runMigrations(handle.db, tempDir);

    const owner = agentRowsOn(handle).find((agent) => agent.role === "product_owner")!;
    expect(owner.config["allowedTools"]).toContain("mcp__eo__ticket_detail");
    expect(owner.config["allowedTools"]).not.toContain("mcp__eo__thread_read");

    runMigrations(handle.db, join(dirname(fileURLToPath(import.meta.url)), "migrations"));

    const after = listAgents(handle.db);
    // On `system` and no longer on `product_owner`: 0062 renamed the row
    // this grant landed on, and a grant that did not travel with it would
    // be a tool advertised to an agent that had lost it.
    expect(after.find((agent) => agent.role === "system")!.config["allowedTools"]).toContain("mcp__eo__thread_read");
    // …and the search, which every `ticket_detail` answer now recommends:
    // an allowlist that omits it is a tool advertised, recommended and
    // then refused.
    expect(after.find((agent) => agent.role === "system")!.config["allowedTools"]).toContain("mcp__eo__comment_search");
    // The architect held no item read at all, and a configure chat *is*
    // a thread — it gets both. Read off the row 0062 retired rather than
    // deleted, which keeps its config exactly as this migration left it.
    const architect = after.find((agent) => agent.role === "pipeline_architect")!;
    expect(architect.config["allowedTools"]).toContain("mcp__eo__thread_read");
    expect(architect.config["allowedTools"]).toContain("mcp__eo__ticket_detail");
    // The implementer and reviewer ship with no allowlist, which already
    // permits every advertised tool — and they stay seeded, which is the
    // point. The one entry they gain is a later grant of a tool that is
    // only ever listed for a grant (0126, EO-479), not this one.
    expect(after.find((agent) => agent.role === "implementer")!.config["allowedTools"]).toEqual(["mcp__eo__memory_note"]);
  });

  it("turns thread reuse on for the implementer without overriding anyone's choice", () => {
    // 0048 ships the switch on for the role it was written for. An
    // implementer dispatched twice on one item is doing the same work in
    // the same worktree, and a fresh conversation re-reads the codebase to
    // get back where the last one already was.
    handle = openDb(":memory:");
    tempDir = mkdtempSync(join(tmpdir(), "eo-implementer-thread-reuse-"));
    writeMigrationSetBefore(tempDir, "0048_implementer_thread_reuse");
    runMigrations(handle.db, tempDir);

    const seeded = agentRowsOn(handle).find((agent) => agent.role === "implementer")!;
    // The stored key, not `reusesThreadPerItem` — which answers from
    // the role since EO-178 and would say "on" before 0048 had run.
    expect(seeded.config["reuseThreadPerTicket"]).toBeUndefined();

    // A second implementer whose owner deliberately turned reuse off — the
    // one case a default must not overrule. The extra key is here so that
    // rewriting the row at all, rather than only its value, would show.
    const mine = `{"reuseThreadPerTicket":false,"effort":"high"}`;
    handle.db.run(
      sql`INSERT INTO agents (id, name, role, provider, model, instructions, config, enabled)
          VALUES ('019fb8c6-de91-7cdd-b0c6-000000000094', 'My Implementer', 'implementer', 'fake', NULL, 'Mine.', ${mine}, 1)`,
    );

    // Through 0048 and no further. 0061 supersedes its restraint — thread
    // reuse is the role's answer now rather than a checkbox, so a stored
    // `false` on an implementer is a preference nothing can act on — and
    // running the whole folder here would be testing that instead of this.
    writeMigrationSetBefore(tempDir, "0061_pinned_agent_settings");
    runMigrations(handle.db, tempDir);

    const after = agentRowsOn(handle);
    expect(reusesThreadPerItem(registry, after.find((agent) => agent.id === seeded.id)!)).toBe(true);
    // Off stays off, byte for byte: the guard skips the row rather than
    // letting json_insert reformat a config nobody asked it to touch.
    const kept = handle.db.get<{ config: string }>(
      sql`SELECT config FROM agents WHERE id = '019fb8c6-de91-7cdd-b0c6-000000000094'`,
    );
    expect(kept!.config).toBe(mine);
    // Keyed on the role, so nobody else acquires a default this story does
    // not claim for them. Read off the raw config rather than through
    // `reusesThreadPerItem`, which answers from the role now and would
    // say "off" whether or not 0048 had written anything.
    for (const agent of after.filter((candidate) => candidate.role !== "implementer")) {
      expect(agent.config["reuseThreadPerTicket"], agent.role).toBeUndefined();
    }

    // Idempotent: the second launch re-runs nothing, and a re-run would find
    // the key present and skip it anyway.
    runMigrations(handle.db, tempDir);
    expect(reusesThreadPerItem(registry, agentRowsOn(handle).find((agent) => agent.id === seeded.id)!)).toBe(true);
  });

  /**
   * 0061 makes the stored configs say what the code now does (EO-178).
   *
   * Three settings stopped being anybody's choice — `permissionMode`,
   * `sandboxMode` and `approvalPolicy` are written where the process is
   * spawned, with no `config` read at all — and thread reuse stopped
   * being a choice on the four roles EO ships. Not cosmetic: a row that
   * still carries `"permissionMode":"plan"` while the process runs on
   * bypass lies to the next person who reads it.
   */
  it("strips the settings that stopped being settings, and pins thread reuse to the role", () => {
    handle = openDb(":memory:");
    tempDir = mkdtempSync(join(tmpdir(), "eo-pinned-agent-settings-"));
    writeMigrationSetBefore(tempDir, "0061_pinned_agent_settings");
    runMigrations(handle.db, tempDir);

    // What an install that predates this looks like: an implementer whose
    // owner turned reuse off, a reviewer who turned it on, and settings
    // chosen from dropdowns that no longer exist.
    const OFF_IMPLEMENTER = "019fb8c6-de91-7cdd-b0c6-0000000061a1";
    const ON_REVIEWER = "019fb8c6-de91-7cdd-b0c6-0000000061a2";
    const OWNER = "019fb8c6-de91-7cdd-b0c6-0000000061a3";
    const ARCHITECT = "019fb8c6-de91-7cdd-b0c6-0000000061a4";
    // A role somebody invented: EO has no opinion about its threads, so
    // the key it carries is still its owner's and has to survive.
    const INVENTED = "019fb8c6-de91-7cdd-b0c6-0000000061a5";
    const rows: [string, string, string][] = [
      [OFF_IMPLEMENTER, "implementer", `{"reuseThreadPerTicket":false,"permissionMode":"plan","effort":"high"}`],
      [ON_REVIEWER, "reviewer", `{"reuseThreadPerTicket":true,"sandboxMode":"read-only"}`],
      [OWNER, "product_owner", `{"approvalPolicy":"on-request"}`],
      [ARCHITECT, "pipeline_architect", `{"reuseThreadPerTicket":true}`],
      [INVENTED, "tester", `{"reuseThreadPerTicket":true,"permissionMode":"acceptEdits","model":"gpt-5-codex"}`],
    ];
    for (const [id, role, config] of rows) {
      handle.db.run(
        sql`INSERT INTO agents (id, name, role, provider, model, instructions, config, enabled)
            VALUES (${id}, ${role}, ${role}, 'fake', NULL, 'Mine.', ${config}, 1)`,
      );
    }

    runMigrations(handle.db, join(dirname(fileURLToPath(import.meta.url)), "migrations"));

    const after = listAgents(handle.db);
    const byId = (id: string) => after.find((agent) => agent.id === id)!;

    // Every implementer is on, including the one that had been turned
    // off: the checkbox is gone for this role, so a stored `false` is a
    // preference nothing can act on and nobody can see.
    for (const agent of after.filter((candidate) => candidate.role === "implementer")) {
      expect(agent.config["reuseThreadPerItem"], agent.id).toBe(true);
      expect(reusesThreadPerItem(registry, agent), agent.id).toBe(true);
    }
    // …and the other three shipped roles carry no key at all, which is
    // what an agent nobody has considered the question for looks like.
    // `system` rather than `product_owner`: 0062 runs after 0061 in this
    // batch and renames the row, so this is where the fixture ends up.
    for (const agent of after.filter((candidate) => ["system", "reviewer", "pipeline_architect"].includes(candidate.role))) {
      expect(agent.config["reuseThreadPerItem"], agent.id).toBeUndefined();
      expect(reusesThreadPerItem(registry, agent), agent.id).toBe(false);
    }
    // The invented role keeps its owner's answer, which EO has no
    // opinion about.
    expect(byId(INVENTED).config["reuseThreadPerItem"]).toBe(true);
    expect(reusesThreadPerItem(registry, byId(INVENTED))).toBe(true);

    // The three pinned settings are gone from every agent, whatever its
    // role and whatever its provider — the pin is keyed on neither.
    for (const agent of after) {
      expect(agent.config["permissionMode"], agent.id).toBeUndefined();
      expect(agent.config["sandboxMode"], agent.id).toBeUndefined();
      expect(agent.config["approvalPolicy"], agent.id).toBeUndefined();
    }
    // Nothing else was touched on the way past.
    expect(byId(OFF_IMPLEMENTER).config["effort"]).toBe("high");
    expect(byId(INVENTED).config["model"]).toBe("gpt-5-codex");

    // Idempotent, and a row it has nothing left to do with is left byte
    // for byte alone rather than reformatted by a json_remove that had
    // nothing to remove.
    const settled = handle.db.get<{ config: string }>(sql`SELECT config FROM agents WHERE id = ${OWNER}`)!.config;
    runMigrations(handle.db, join(dirname(fileURLToPath(import.meta.url)), "migrations"));
    expect(handle.db.get<{ config: string }>(sql`SELECT config FROM agents WHERE id = ${OWNER}`)!.config).toBe(settled);
  });

  it("merges the two conversational agents into one and retires the other row, deleting nothing", () => {
    // 0062. The product owner and the pipeline architect were siblings in
    // everything but subject, and neither owned a pipeline step, so one
    // agent answers both rooms. What must survive the merge is everything
    // the two rooms are made of — the steps, the key prefixes and the
    // conversations already on them — because none of it is the agent.
    handle = openDb(":memory:");
    tempDir = mkdtempSync(join(tmpdir(), "eo-system-agent-"));
    writeMigrationSetBefore(tempDir, "0062_system_agent");
    runMigrations(handle.db, tempDir);

    const ARCHITECT = "019fb8c6-de92-7a41-9c33-4471f0c2b1de";
    const before = agentRowsOn(handle);
    const owner = before.find((agent) => agent.role === "product_owner")!;
    expect(before.find((agent) => agent.id === ARCHITECT)!.enabled).toBe(1);

    // A conversation already open in each room, with a message in it.
    // These are the rows a person would lose if the merge reached past
    // the agents table.
    handle.db.run(
      sql`INSERT INTO tickets (id, key, type, title, pipeline_id, step_id, priority, created_at, updated_at)
          VALUES ('c-arch', 'ARCH-1', 'story', 'How should review work?', 'discussions', 'architecture', 0, 1, 1),
                 ('c-disc', 'DISC-1', 'story', 'Rate limiting', 'discussions', 'discussion', 0, 1, 1)`,
    );
    handle.db.run(
      sql`INSERT INTO comments (id, ticket_id, author_type, author_id, kind, body, created_at)
          VALUES ('cm-arch', 'c-arch', 'agent', ${ARCHITECT}, 'message', 'Here is the graph as it stands.', 1)`,
    );
    // The DISC counter is created lazily on the first discussion rather
    // than seeded, so an install that has used the room is what this has
    // to be. ARCH is already there from 0036.
    handle.db.run(sql`INSERT INTO key_counters (prefix, next_value) VALUES ('DISC', 4)`);
    handle.db.run(sql`UPDATE key_counters SET next_value = 2 WHERE prefix = 'ARCH'`);
    // A step somebody hand-wired onto one of the old roles. No pipeline
    // EO ships has one — 0030 deleted the last of them — so this is the
    // case the rename exists for.
    handle.db.run(
      sql`INSERT INTO pipeline_steps (id, pipeline_id, position, name, type, owner_role, entry_action, is_terminal, off_board)
          VALUES ('their_intake', 'default', 90, 'Intake', 'agent', 'product_owner', 'intake', 0, 0)`,
    );

    runMigrations(handle.db, join(dirname(fileURLToPath(import.meta.url)), "migrations"));

    const after = listAgents(handle.db);
    // Nothing was deleted. `runs.agent_id` references the architect row,
    // so switching it off was the only way 0062 had of taking it out of
    // service without taking its runs with it — `agents` had no
    // `archived_at` until 0065, which is the test below.
    expect(after).toHaveLength(before.length);

    // The product owner's row *is* the system agent — same id, so every
    // run, comment and mention that ever pointed at it still does.
    const system = after.find((agent) => agent.role === "system")!;
    expect(system.id).toBe(owner.id);
    expect(system.name).toBe("System");
    expect(system.enabled).toBe(true);
    // `instructions` are left for `syncRolePrompts` to handle on the next
    // boot, so a prompt somebody edited is reported as customised rather
    // than overwritten by SQL that cannot tell the difference.
    expect(system.instructions).toBe(owner.instructions);
    // As able as the two it replaces, and no more: an allowlist is
    // exhaustive, and `configToolsEnabled` answers from exactly these
    // names — without them a `configure` turn is not narrower but inert.
    for (const tool of ["mcp__eo__pipeline_list", "mcp__eo__pipeline_read", "mcp__eo__agents_list", "mcp__eo__agent_read", "mcp__eo__runtimes_list"]) {
      expect(system.config["allowedTools"], tool).toContain(tool);
    }
    // …and it keeps its own half.
    expect(system.config["allowedTools"]).toContain("mcp__eo__comment_search");
    expect(new Set(system.config["allowedTools"] as string[]).size).toBe((system.config["allowedTools"] as string[]).length);

    // The architect row is switched off and otherwise untouched — still
    // on its old role, so `syncRolePrompts` finds no file for it and
    // leaves its text alone rather than rewriting a retired row with a
    // prompt for a job it is not doing. (0065 archives it as well; that
    // is a later test's business, and the switch stays where 0062 put it
    // either way.)
    const architect = after.find((agent) => agent.id === ARCHITECT)!;
    expect(architect.enabled).toBe(false);
    expect(architect.role).toBe("pipeline_architect");

    // Both rooms survive as they were: their steps, their key counters
    // and the conversations already on them.
    const steps = handle.db.all<{ id: string; owner_role: string | null; type: string }>(
      sql`SELECT id, owner_role, type FROM pipeline_steps WHERE id IN ('discussion', 'architecture') ORDER BY id`,
    );
    expect(steps).toEqual([
      { id: "architecture", owner_role: null, type: "user" },
      { id: "discussion", owner_role: null, type: "user" },
    ]);
    // Both counters, at the values they were on: a merged agent must not
    // renumber anybody's conversations.
    expect(handle.db.all(sql`SELECT prefix, next_value FROM key_counters WHERE prefix IN ('DISC', 'ARCH') ORDER BY prefix`)).toEqual([
      { prefix: "ARCH", next_value: 2 },
      { prefix: "DISC", next_value: 4 },
    ]);
    expect(getItem(handle.db, "c-arch" as Uuid)?.stepId).toBe("architecture");
    expect(getItem(handle.db, "c-disc" as Uuid)?.stepId).toBe("discussion");
    // The history in the architecture room still names who wrote it —
    // which is what keeping the row buys.
    expect(handle.db.get<{ author_id: string }>(sql`SELECT author_id FROM comments WHERE id = 'cm-arch'`)!.author_id).toBe(ARCHITECT);

    // The hand-wired step follows the rename. Left behind it would name a
    // role with no enabled agent and park every item that reached it.
    expect(handle.db.get<{ owner_role: string }>(sql`SELECT owner_role FROM pipeline_steps WHERE id = 'their_intake'`)!.owner_role).toBe("system");

    // Idempotent: the tool grants are guarded on their own absence, so a
    // second pass adds no duplicates and changes nothing.
    const settled = handle.db.get<{ config: string }>(sql`SELECT config FROM agents WHERE id = ${owner.id}`)!.config;
    runMigrations(handle.db, join(dirname(fileURLToPath(import.meta.url)), "migrations"));
    expect(handle.db.get<{ config: string }>(sql`SELECT config FROM agents WHERE id = ${owner.id}`)!.config).toBe(settled);
  });

  it("grants the system agent EO's administrative server, rebuilding an allowlist a partial save wiped", () => {
    // 0063. EO-182 built the `eo_admin` server, `adminToolsEnabled` and
    // the delivery that writes the server into a dispatch — and nothing
    // ever wrote the grant that turns any of it on, so a shipped feature
    // had never once run outside the test that granted it to itself.
    handle = openDb(":memory:");
    tempDir = mkdtempSync(join(tmpdir(), "eo-admin-grant-"));
    writeMigrationSetBefore(tempDir, "0063_system_agent_admin_grant");
    runMigrations(handle.db, tempDir);

    const seeded = agentRowsOn(handle).find((agent) => agent.role === "system")!;
    // Everything 0021, 0026, 0038, 0047 and 0062 built up between them,
    // captured here so the repair below can be checked against it rather
    // than against a list copied out of the migration it is testing.
    const built = seeded.config["allowedTools"] as string[];
    expect(built).toContain("mcp__eo__thread_read");
    expect(built).toContain("mcp__eo__runtimes_list");
    expect(adminToolsEnabled(seeded)).toBe(false);

    // The wholesale replace, reproduced: something saved this agent
    // holding a reasoning effort and nothing else, and `config` — an
    // open record that defaulted to `{}` — took the rest with it. This
    // is the row on a real installation, byte for byte.
    handle.db.run(sql`UPDATE agents SET config = '{"effort":"xhigh","reasoningEffort":"xhigh"}' WHERE id = ${seeded.id}`);
    // A second system agent somebody staffed and narrowed themselves.
    // The healthy path: it has a list, so it needs the grant appended
    // and nothing else — a migration that rebuilt this one would be
    // overwriting somebody's own answer.
    const THEIRS = "019fb8c6-0000-7a41-9c33-000000000063";
    handle.db.run(
      sql`INSERT INTO agents (id, name, role, provider, model, instructions, config, enabled)
          VALUES (${THEIRS}, 'Theirs', 'system', 'claude', NULL, 'Mine.',
                  '{"allowedTools":["Read","mcp__eo__thread_read"],"effort":"high"}', 1)`,
    );

    runMigrations(handle.db, join(dirname(fileURLToPath(import.meta.url)), "migrations"));

    const after = listAgents(handle.db);
    const repaired = after.find((agent) => agent.id === seeded.id)!;

    // The grant, asked the only way that decides anything: `adminDelivery`
    // returns null for an agent this answers false about, and the server
    // is then never written into the generated `.mcp.json`.
    expect(adminToolsEnabled(repaired)).toBe(true);
    // Exactly the chain of migrations that came before, plus the grant.
    // Not "contains the tools it needs": the point of the repair is that
    // the row is put back where it was, and an allowlist is exhaustive,
    // so a name quietly missing here is a tool advertised and refused.
    //
    // …and then the one tool a later migration appends to every list
    // that names `attachment_read`, this one included (0112, EO-412).
    // And the memory grant 0126 gives the system agent (EO-479), and
    // `repository_checkout`, which 0157 appends where 0112 did (EO-633).
    expect(repaired.config["allowedTools"]).toEqual([...built, "mcp__eo_admin", "mcp__eo__attachment_add", "mcp__eo__memory_note", "mcp__eo__repository_checkout"]);
    // …and with it the capabilities that answer from named entries. An
    // agent with no list is not an unrestricted agent but an inert one:
    // `configToolsEnabled` is what decides whether the `eo` server
    // serves the configuration reads at all, so a `configure` turn had
    // nothing to read the pipeline with.
    expect(fullThreadEnabled(repaired)).toBe(true);
    expect(configToolsEnabled(repaired)).toBe(true);
    // Added to the config rather than substituted for it: whatever else
    // the row was carrying is still there.
    expect(repaired.config["effort"]).toBe("xhigh");
    expect(repaired.config["reasoningEffort"]).toBe("xhigh");

    // The list somebody narrowed is widened by one entry and otherwise
    // left as they wrote it.
    const theirs = after.find((agent) => agent.id === THEIRS)!;
    // (Then 0126 appends the memory grant, as it does to every system agent.)
    expect(theirs.config["allowedTools"]).toEqual(["Read", "mcp__eo__thread_read", "mcp__eo_admin", "mcp__eo__memory_note"]);
    expect(theirs.config["effort"]).toBe("high");

    // Nobody else is touched, in either direction. The implementer has no
    // allowlist and must keep having none — for every role but this one,
    // absent means "every advertised tool is permitted" and writing a
    // list would be a narrowing nobody asked for. The one list it does
    // gain later is 0126's memory grant alone (EO-479), which narrows
    // nothing under EO's pinned permission mode.
    expect(after.find((agent) => agent.role === "implementer")!.config["allowedTools"]).toEqual(["mcp__eo__memory_note"]);
    // And the architect row 0062 retired stays retired and ungranted: it
    // was deliberately left on its old role so that nothing keyed on the
    // new one would reach it again.
    const architect = after.find((agent) => agent.role === "pipeline_architect")!;
    expect(architect.enabled).toBe(false);
    expect(adminToolsEnabled(architect)).toBe(false);

    // Idempotent: the rebuild is guarded on the key being absent and the
    // grant on its own absence, so a second pass finds nothing to do.
    const settledConfigs = handle.db.all(sql`SELECT id, config FROM agents ORDER BY id`);
    runMigrations(handle.db, join(dirname(fileURLToPath(import.meta.url)), "migrations"));
    expect(handle.db.all(sql`SELECT id, config FROM agents ORDER BY id`)).toEqual(settledConfigs);
  });

  it("leaves an unparseable config alone rather than aborting the grant in 0063", () => {
    // The guard 0061 and 0062 carry, for their reason: `config` is an
    // open bag anyone can write, and one row nobody can parse must be
    // that row's problem rather than a migration that rolls back and an
    // app that will not open.
    handle = openDb(":memory:");
    tempDir = mkdtempSync(join(tmpdir(), "eo-admin-grant-unparseable-"));
    writeMigrationSetBefore(tempDir, "0063_system_agent_admin_grant");
    runMigrations(handle.db, tempDir);

    // Read before the unparseable rows exist, because a row's `config`
    // is parsed as JSON and cannot survive one of them.
    const seeded = agentRowsOn(handle).find((agent) => agent.role === "system")!;

    const BROKEN = "019fb8c6-0000-7a41-9c33-000000000064";
    handle.db.run(
      sql`INSERT INTO agents (id, name, role, provider, model, instructions, config, enabled)
          VALUES (${BROKEN}, 'Broken', 'system', 'claude', NULL, 'Mine.', 'not json', 1)`,
    );
    // An `allowedTools` written as a string is a mistake in somebody's
    // own config and theirs to correct. Overwriting it from a migration
    // would be this fix performing the whole-object replace it exists to
    // repair, so it is left exactly as written.
    const MISTYPED = "019fb8c6-0000-7a41-9c33-000000000065";
    handle.db.run(
      sql`INSERT INTO agents (id, name, role, provider, model, instructions, config, enabled)
          VALUES (${MISTYPED}, 'Mistyped', 'system', 'claude', NULL, 'Mine.', '{"allowedTools":"Read"}', 1)`,
    );

    expect(() => runMigrations(handle.db, join(dirname(fileURLToPath(import.meta.url)), "migrations"))).not.toThrow();

    expect(handle.db.get<{ config: string }>(sql`SELECT config FROM agents WHERE id = ${BROKEN}`)!.config).toBe("not json");
    expect(handle.db.get<{ config: string }>(sql`SELECT config FROM agents WHERE id = ${MISTYPED}`)!.config).toBe('{"allowedTools":"Read"}');
    // The row the migration is actually for still got its grant: one bad
    // neighbour narrows the batch, it does not stop it.
    const config = JSON.parse(handle.db.get<{ config: string }>(sql`SELECT config FROM agents WHERE id = ${seeded.id}`)!.config) as Record<
      string,
      unknown
    >;
    expect(adminToolsEnabled({ config })).toBe(true);
  });

  it("adds the assist room as a third off-board step, keeping both the rooms already there", () => {
    // 0064. The help widget's conversations live on a step of their own,
    // for the reason the architect's do: `findPendingResponses` reads the
    // action off the step, and `listConversations` scopes the Discussions
    // sidebar by it. What must survive is both existing rooms — their
    // steps, their counters and the conversations on them — because this
    // adds a room rather than rearranging any.
    handle = openDb(":memory:");
    tempDir = mkdtempSync(join(tmpdir(), "eo-assist-room-"));
    writeMigrationSetBefore(tempDir, "0064_assist_room");
    runMigrations(handle.db, tempDir);

    handle.db.run(
      sql`INSERT INTO tickets (id, key, type, title, pipeline_id, step_id, priority, created_at, updated_at)
          VALUES ('c-arch', 'ARCH-1', 'story', 'How should review work?', 'discussions', 'architecture', 0, 1, 1),
                 ('c-disc', 'DISC-1', 'story', 'Rate limiting', 'discussions', 'discussion', 0, 1, 1)`,
    );
    handle.db.run(sql`INSERT INTO key_counters (prefix, next_value) VALUES ('DISC', 4)`);
    const stepsBefore = handle.db.all(sql`SELECT id FROM pipeline_steps`).length;

    runMigrations(handle.db, join(dirname(fileURLToPath(import.meta.url)), "migrations"));

    // Off-board and human-owned: `tick()` skips it, so no capacity slot
    // is ever spent on a chat, and nothing arrives here by transition.
    expect(
      handle.db.get(
        sql`SELECT pipeline_id, type, owner_role, entry_action, is_terminal, off_board
            FROM pipeline_steps WHERE id = 'assist'`,
      ),
    ).toEqual({ pipeline_id: "discussions", type: "user", owner_role: null, entry_action: null, is_terminal: 0, off_board: 1 });
    // Its own sequence, so one thread per page does not put holes in the
    // numbers people read and quote.
    expect(handle.db.get(sql`SELECT next_value FROM key_counters WHERE prefix = 'ASK'`)).toEqual({ next_value: 1 });

    // Nothing deleted: steps more than there was, both other rooms
    // untouched, and the conversations already on them where they were.
    // Three because this replays every migration after 0064: 0108 adds
    // the scenario chat's step (EO-356) — an off-board step added is what
    // this assertion is for, and a room added later is one more of
    // exactly that — and 0123 the shipped pipeline's pull request watch
    // (EO-461), on the board. 0078's `job-thread` and 0119's
    // `project-thread` came and went again with 0168 (EO-730).
    expect(handle.db.all(sql`SELECT id FROM pipeline_steps`)).toHaveLength(stepsBefore + 3);
    expect(handle.db.all(sql`SELECT id FROM pipeline_steps WHERE id IN ('discussion', 'architecture') ORDER BY id`)).toEqual([
      { id: "architecture" },
      { id: "discussion" },
    ]);
    expect(handle.db.all(sql`SELECT prefix, next_value FROM key_counters WHERE prefix IN ('DISC', 'ARCH') ORDER BY prefix`)).toEqual([
      { prefix: "ARCH", next_value: 1 },
      { prefix: "DISC", next_value: 4 },
    ]);
    expect(getItem(handle.db, "c-arch" as Uuid)?.stepId).toBe("architecture");
    expect(getItem(handle.db, "c-disc" as Uuid)?.stepId).toBe("discussion");
  });

  it("archives the retired architect rather than leaving it looking like somebody's own agent, and deletes none of its history", () => {
    // 0065. `enabled = 0` said "not right now" about a row that is never
    // coming back, and with no `archived_at` on `agents` the Agents
    // screen had nowhere to put it: the role is no longer one EO ships,
    // so `isBuiltinRole` says false and the screen drew it as one of the
    // person's own custom agents.
    //
    // What must survive is everything the row was kept for. Its runs,
    // the comments it wrote and the mentions that named it are the whole
    // reason it was not deleted in the first place (invariant #3), so
    // they are all here before the migration and all read back after it.
    handle = openDb(":memory:");
    tempDir = mkdtempSync(join(tmpdir(), "eo-agent-archived-at-"));
    writeMigrationSetBefore(tempDir, "0065_agent_archived_at");
    runMigrations(handle.db, tempDir);

    const ARCHITECT = "019fb8c6-de92-7a41-9c33-4471f0c2b1de";
    const before = agentRowsOn(handle);
    expect(before.find((agent) => agent.id === ARCHITECT)).toBeDefined();

    // A conversation the architect answered: two runs, a comment of its
    // own, and a mention that named it.
    handle.db.run(
      sql`INSERT INTO tickets (id, key, type, title, pipeline_id, step_id, priority, created_at, updated_at)
          VALUES ('c-arch', 'ARCH-1', 'story', 'How should review work?', 'discussions', 'architecture', 0, 1, 1)`,
    );
    handle.db.run(
      sql`INSERT INTO runs (id, ticket_id, agent_id, action, status, attempt)
          VALUES ('r-arch-1', 'c-arch', ${ARCHITECT}, 'configure', 'succeeded', 1),
                 ('r-arch-2', 'c-arch', ${ARCHITECT}, 'configure', 'succeeded', 2)`,
    );
    handle.db.run(
      sql`INSERT INTO comments (id, ticket_id, author_type, author_id, kind, body, created_at)
          VALUES ('cm-them', 'c-arch', 'human', NULL, 'message', 'What do you think, @architect?', 1),
                 ('cm-arch', 'c-arch', 'agent', ${ARCHITECT}, 'message', 'Here is the graph as it stands.', 2)`,
    );
    handle.db.run(
      sql`INSERT INTO comment_mentions (comment_id, target_type, target_id, status)
          VALUES ('cm-them', 'agent', ${ARCHITECT}, 'addressed')`,
    );
    // Somebody's own agent on the same dead role. Theirs to keep: 0036
    // seeded exactly one row, and this migration acts on that id alone.
    handle.db.run(
      sql`INSERT INTO agents (id, name, role, provider, model, instructions, config, enabled)
          VALUES ('019fb8c6-de91-7cdd-b0c6-000000000065', 'My Architect', 'pipeline_architect', 'fake', NULL, 'Mine.', '{}', 1)`,
    );

    runMigrations(handle.db, join(dirname(fileURLToPath(import.meta.url)), "migrations"));

    const after = listAgents(handle.db);
    // Nothing was removed, here or anywhere it is pointed at.
    expect(after).toHaveLength(before.length + 1);

    const architect = after.find((agent) => agent.id === ARCHITECT)!;
    expect(architect.archivedAt).not.toBeNull();
    // Switched off *and* archived: the two say different things, and
    // rewriting 0062's switch would erase what it recorded.
    expect(architect.enabled).toBe(false);
    expect(architect.role).toBe("pipeline_architect");

    // The history the row was kept for, all still readable — and the
    // comment still shows the architect as its author, which is the
    // whole of the argument against deleting it.
    expect(handle.db.all(sql`SELECT id FROM runs WHERE agent_id = ${ARCHITECT} ORDER BY id`)).toEqual([{ id: "r-arch-1" }, { id: "r-arch-2" }]);
    expect(handle.db.get<{ author_id: string }>(sql`SELECT author_id FROM comments WHERE id = 'cm-arch'`)!.author_id).toBe(ARCHITECT);
    expect(handle.db.get<{ target_id: string }>(sql`SELECT target_id FROM comment_mentions WHERE comment_id = 'cm-them'`)!.target_id).toBe(ARCHITECT);

    // Somebody else's architect is left alone: archiving it is their
    // decision, and this migration is about the row EO seeded.
    expect(after.find((agent) => agent.name === "My Architect")!.archivedAt).toBeNull();

    // What the Agents screen shows afterwards: the three roles EO ships,
    // plus the one this person made. Nothing retired.
    expect(after.filter((agent) => agent.archivedAt === null).map((agent) => agent.role).sort()).toEqual([
      "implementer",
      "pipeline_architect",
      "reviewer",
      "system",
    ]);

    // Idempotent, and more than trivially: the UPDATE is guarded on
    // `archived_at IS NULL`, so a second pass leaves the timestamp it
    // already wrote rather than restamping it.
    const stamped = architect.archivedAt;
    runMigrations(handle.db, join(dirname(fileURLToPath(import.meta.url)), "migrations"));
    expect(listAgents(handle.db).find((agent) => agent.id === ARCHITECT)!.archivedAt).toBe(stamped);
  });

  it("steps over an agent whose config will not parse rather than aborting 0061", () => {
    // The guard 0048 carries, for the reason it carries it: `config` is
    // an open bag anyone can write, and without `json_valid` one
    // unparseable row aborts the migration and the app will not open.
    handle = openDb(":memory:");
    tempDir = mkdtempSync(join(tmpdir(), "eo-pinned-agent-settings-invalid-"));
    writeMigrationSetBefore(tempDir, "0061_pinned_agent_settings");
    runMigrations(handle.db, tempDir);
    handle.db.run(
      sql`INSERT INTO agents (id, name, role, provider, model, instructions, config, enabled)
          VALUES ('019fb8c6-de91-7cdd-b0c6-0000000061b1', 'Broken', 'implementer', 'fake', NULL, 'Mine.', 'not json', 1)`,
    );
    handle.db.run(
      sql`INSERT INTO agents (id, name, role, provider, model, instructions, config, enabled)
          VALUES ('019fb8c6-de91-7cdd-b0c6-0000000061b2', 'Also broken', 'reviewer', 'fake', NULL, 'Mine.', '{oops', 1)`,
    );

    // Raw SQL throughout: `listAgents` parses `config`, so it cannot read
    // the rows this test is about.
    expect(() => runMigrations(handle.db, join(dirname(fileURLToPath(import.meta.url)), "migrations"))).not.toThrow();

    const rows = handle.db.all<{ id: string; config: string }>(sql`SELECT id, config FROM agents`);
    expect(rows.find((row) => row.id.endsWith("61b1"))!.config).toBe("not json");
    expect(rows.find((row) => row.id.endsWith("61b2"))!.config).toBe("{oops");
    // …and the rest of the batch still applied over them. Raw again:
    // `listAgents` would throw on the two rows above before reaching
    // the ones this asserts about.
    const parsed = rows
      .filter((row) => !row.id.endsWith("61b1") && !row.id.endsWith("61b2"))
      .map((row) => JSON.parse(row.config) as Record<string, unknown>);
    const implementers = handle.db
      .all<{ id: string; config: string }>(sql`SELECT id, config FROM agents WHERE role = 'implementer' AND id NOT LIKE '%61b1'`)
      .map((row) => JSON.parse(row.config) as Record<string, unknown>);
    expect(implementers.length).toBeGreaterThan(0);
    expect(implementers.every((config) => config["reuseThreadPerItem"] === true)).toBe(true);
    expect(parsed.every((config) => config["permissionMode"] === undefined)).toBe(true);
  });

  it("steps over an agent whose config will not parse rather than failing the batch", () => {
    // `config` is an open bag anyone can write, so 0048 guards on
    // `json_valid`: without it one unparseable row aborts the migration and
    // the app will not open at all.
    handle = openDb(":memory:");
    tempDir = mkdtempSync(join(tmpdir(), "eo-implementer-thread-reuse-invalid-"));
    writeMigrationSetBefore(tempDir, "0048_implementer_thread_reuse");
    runMigrations(handle.db, tempDir);
    handle.db.run(
      sql`INSERT INTO agents (id, name, role, provider, model, instructions, config, enabled)
          VALUES ('019fb8c6-de91-7cdd-b0c6-000000000bad', 'Broken', 'implementer', 'fake', NULL, 'Mine.', 'not json', 1)`,
    );

    // Raw SQL throughout: `listAgents` parses `config`, so it cannot read
    // the row this test is about.
    expect(() => runMigrations(handle.db, join(dirname(fileURLToPath(import.meta.url)), "migrations"))).not.toThrow();

    const rows = handle.db.all<{ id: string; config: string }>(sql`SELECT id, config FROM agents WHERE role = 'implementer'`);
    expect(rows.find((row) => row.id.endsWith("bad"))!.config).toBe("not json");
    // …and the rest of the batch still applied over it.
    const parsed = rows.filter((row) => !row.id.endsWith("bad")).map((row) => JSON.parse(row.config) as Record<string, unknown>);
    expect(parsed.every((config) => config["reuseThreadPerItem"] === true)).toBe(true);
  });

  it("reads a run written before the step column as having none, rather than as a match", () => {
    handle = openDb(":memory:");
    tempDir = mkdtempSync(join(tmpdir(), "eo-run-step-migration-"));
    writeMigrationSetBefore(tempDir, "0046_run_step_id");
    runMigrations(handle.db, tempDir);
    handle.db.run(
      sql`INSERT INTO tickets (id, key, type, title, pipeline_id, step_id, priority, created_at, updated_at)
          VALUES ('t1', 'EO-1', 'story', 'Older work', 'default', 'todo', 0, 1, 1)`,
    );
    handle.db.run(
      sql`INSERT INTO runs (id, ticket_id, agent_id, action, status, attempt)
          SELECT 'r1', 't1', id, 'implement', 'succeeded', 1 FROM agents LIMIT 1`,
    );

    runMigrations(handle.db, join(dirname(fileURLToPath(import.meta.url)), "migrations"));

    // Null, not "todo": nothing recorded where that run was dispatched
    // from, and guessing it from where the item sits now would place
    // its comments at a step it may never have been at.
    expect(getRun(handle.db, "r1" as Uuid)?.stepId).toBeNull();
  });

  it("reads a run written before the usage-detail columns as having said nothing about them", () => {
    // 0044 records how much of a run's input came out of the prompt
    // cache and over how many model turns. A row written before it made
    // no such claim, and must not come back as a run with a cold cache
    // and no turns — zero is an answer and these rows have none. The
    // narrow `tokens_in` they do carry keeps its old, smaller meaning.
    handle = openDb(":memory:");
    tempDir = mkdtempSync(join(tmpdir(), "eo-usage-detail-migration-"));
    writeMigrationSetBefore(tempDir, "0044_run_usage_detail");
    runMigrations(handle.db, tempDir);
    handle.db.run(
      sql`INSERT INTO tickets (id, key, type, title, pipeline_id, step_id, priority, created_at, updated_at)
          VALUES ('t1', 'EO-1', 'story', 'Older work', 'default', 'todo', 0, 1, 1)`,
    );
    handle.db.run(
      sql`INSERT INTO runs (id, ticket_id, agent_id, action, status, tokens_in, tokens_out, cost_cents, attempt)
          SELECT 'r1', 't1', id, 'implement', 'succeeded', 251, 4000, 1773, 1 FROM agents LIMIT 1`,
    );

    runMigrations(handle.db, join(dirname(fileURLToPath(import.meta.url)), "migrations"));

    // Through the repo rather than as a raw row: mapping is what a new
    // column could break.
    const run = getRun(handle.db, "r1" as Uuid);
    expect(run?.cacheReadTokens).toBeNull();
    expect(run?.cacheWriteTokens).toBeNull();
    expect(run?.turns).toBeNull();
    expect(run?.tokensIn).toBe(251);
  });

  it("promotes existing path-only Consult attachments into durable rows", () => {
    handle = openDb(":memory:");
    tempDir = mkdtempSync(join(tmpdir(), "eo-attachment-migration-"));
    writeMigrationSetBefore(tempDir, "0024_durable_attachments");
    runMigrations(handle.db, tempDir);
    handle.db.run(sql`INSERT INTO tickets (id, key, type, title, state, priority, created_at, updated_at)
      VALUES ('chat1', 'CHAT-1', 'feature', 'Consult', 'consult', 0, 10, 10)`);
    const legacy = JSON.stringify([{ kind: "image", path: "/old/discussions/screen.png", name: "screen.png", mimeType: "image/png", size: 42 }]);
    handle.db.run(sql`INSERT INTO comments (id, ticket_id, author_type, body, kind, attachments, pinned, created_at)
      VALUES ('comment1', 'chat1', 'human', 'Look', 'note', ${legacy}, 0, 11)`);

    runMigrations(handle.db, join(dirname(fileURLToPath(import.meta.url)), "migrations"));

    const rows = handle.db.all<{ id: string; item_id: string; comment_id: string; storage_path: string; name: string; mime_type: string; size: number; managed: number }>(
      sql`SELECT id, item_id, comment_id, storage_path, name, mime_type, size, managed FROM attachments`,
    );
    expect(rows).toEqual([
      expect.objectContaining({ item_id: "chat1", comment_id: "comment1", storage_path: "/old/discussions/screen.png", name: "screen.png", mime_type: "image/png", size: 42, managed: 0 }),
    ]);
    expect(rows[0]!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(Number.parseInt(rows[0]!.id.replace(/-/g, "").slice(0, 12), 16)).toBe(11);
  });

  it("collapses two repositories on one Jira site into a single connection", () => {
    // The 0017 upgrade path, and the reason the change exists: two
    // repositories on one site used to carry the site — and its token —
    // twice each.
    handle = openDb(":memory:");
    tempDir = mkdtempSync(join(tmpdir(), "eo-connections-migration-"));
    writeMigrationSetBefore(tempDir, "0017_jira_connections");
    runMigrations(handle.db, tempDir);

    // Two on one site, one on another, one not connected at all.
    for (const [id, name, prefix, base, email] of [
      ["p1", "api", "API", "https://acme.atlassian.net", "me@acme.com"],
      ["p2", "web", "WEB", "https://acme.atlassian.net", "me@acme.com"],
      ["p3", "ops", "OPS", "https://ops.example.internal", null],
    ] as const) {
      handle.db.run(
        sql`INSERT INTO projects (id, name, key_prefix, repo_path, base_branch, jira_base_url, jira_flavour, jira_email, jira_project_key, created_at, updated_at)
            VALUES (${id}, ${name}, ${prefix}, ${"/tmp/" + name}, 'main', ${base}, 'cloud', ${email}, 'K', 1, 1)`,
      );
    }
    handle.db.run(
      sql`INSERT INTO projects (id, name, key_prefix, repo_path, base_branch, created_at, updated_at)
          VALUES ('p4', 'solo', 'SOL', '/tmp/solo', 'main', 1, 1)`,
    );

    runMigrations(handle.db, join(dirname(fileURLToPath(import.meta.url)), "migrations"));

    const connections = handle.db.all<{ id: string; name: string; base_url: string; email: string | null }>(
      sql`SELECT id, name, base_url, email FROM jira_connections ORDER BY base_url`,
    );
    expect(connections, "one per site, not one per repository").toHaveLength(2);
    expect(connections.map((row) => row.base_url)).toEqual(["https://acme.atlassian.net", "https://ops.example.internal"]);
    // Named after the host, which is what a person calls a site.
    expect(connections[0]!.name).toBe("acme.atlassian.net");

    // Read off the bindings rather than the repositories, because by the
    // end of the chain 0072 has moved the eight Jira columns onto each
    // repository's project — the workspace keeps the repository's id, so
    // these are still the same four things under the same names.
    const bindingFor = (workspaceId: string) => getJiraBinding(handle.db, projectForWorkspace(handle.db, workspaceId as Uuid)!.id)?.config;

    // The two on one site share a connection.
    expect(bindingFor("p1")!.connectionId).toBe(bindingFor("p2")!.connectionId);
    expect(bindingFor("p1")!.connectionId).toBe(connections[0]!.id);
    expect(bindingFor("p3")!.connectionId).toBe(connections[1]!.id);
    // Never connected stays that way, and keeps nothing it did not have
    // — which after 0072 means no binding row at all.
    expect(bindingFor("p4")).toBeUndefined();
    // What belongs to the Jira *project* travelled with the connection.
    expect(bindingFor("p1")!.projectKey).toBe("K");
  });

  it("puts an existing repository's items onto a default project, keeping their keys", () => {
    // The 0016 upgrade path. A project used to be a repository, so every
    // repository that already exists must come out the other side owning
    // one — otherwise an upgraded database opens to an empty project and
    // every item looks lost.
    handle = openDb(":memory:");
    tempDir = mkdtempSync(join(tmpdir(), "eo-projects-migration-"));
    writeMigrationSetBefore(tempDir, "0016_boards");
    runMigrations(handle.db, tempDir);

    handle.db.run(
      sql`INSERT INTO projects (id, name, key_prefix, repo_path, base_branch, created_at, updated_at)
          VALUES ('p1', 'api', 'API', '/tmp/api', 'main', 1, 1)`,
    );
    handle.db.run(
      sql`INSERT INTO tickets (id, key, type, project_id, title, state, priority, created_at, updated_at)
          VALUES ('t1', 'API-1', 'story', 'p1', 'Existing work', 'todo', 0, 1, 1)`,
    );
    // Written before any repo was attached: no repository, so no project.
    handle.db.run(
      sql`INSERT INTO tickets (id, key, type, title, state, priority, created_at, updated_at)
          VALUES ('t2', 'EO-1', 'feature', 'Onboarding work', 'intake', 0, 1, 1)`,
    );

    runMigrations(handle.db, join(dirname(fileURLToPath(import.meta.url)), "migrations"));

    const projects = handle.db.all<{ id: string; name: string; key_prefix: string }>(sql`SELECT id, name, key_prefix FROM projects`);
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({ name: "api", key_prefix: "API" });
    // Distinct from the repository's id on purpose: reusing it would have
    // made every upgraded database work and every fresh one differ.
    expect(projects[0]!.id).not.toBe("p1");

    // The membership, which 0072 turns into the workspace's own
    // `project_id` — same pair, one row instead of two.
    expect(getWorkspace(handle.db, "p1" as Uuid)).toMatchObject({ projectId: projects[0]!.id });

    const items = handle.db.all<{ key: string; project_id: string | null }>(sql`SELECT key, project_id FROM items ORDER BY key`);
    expect(items).toEqual([
      { key: "API-1", project_id: projects[0]!.id },
      { key: "EO-1", project_id: null },
    ]);
  });

  it("keeps every existing key when the prefix moves from the repository to the project", () => {
    // The 0067 upgrade path (KAN-128). The prefix stops being the
    // repository's, and the one thing that must not move with it is a key
    // already minted: an item's key is written into its branch name, its
    // worktree path, its pull request and whatever a person has quoted it
    // in. A project spanning two repositories of different prefixes is
    // the case where a renumbering would show — its items carry both.
    handle = openDb(":memory:");
    tempDir = mkdtempSync(join(tmpdir(), "eo-key-prefix-migration-"));
    writeMigrationSetBefore(tempDir, "project_key_prefix");
    runMigrations(handle.db, tempDir);

    handle.db.run(
      sql`INSERT INTO repositories (id, name, key_prefix, repo_path, base_branch, created_at, updated_at)
          VALUES ('r1', 'api', 'API', '/tmp/api', 'main', 1, 1), ('r2', 'web', 'WEB', '/tmp/web', 'main', 1, 1)`,
    );
    handle.db.run(
      sql`INSERT INTO projects (id, name, key_prefix, jira_project_id, created_at, updated_at)
          VALUES ('p1', 'Shop', 'SHOP', 'r1', 1, 1)`,
    );
    handle.db.run(sql`INSERT INTO project_repositories (project_id, repository_id, position) VALUES ('p1', 'r1', 0), ('p1', 'r2', 1)`);
    handle.db.run(
      sql`INSERT INTO tickets (id, key, type, repository_id, project_id, title, pipeline_id, step_id, priority, created_at, updated_at)
          VALUES ('t1', 'API-1', 'story', 'r1', 'p1', 'In the api', 'default', 'todo', 0, 1, 1),
                 ('t2', 'API-2', 'story', 'r1', 'p1', 'Also the api', 'default', 'todo', 0, 1, 1),
                 ('t3', 'WEB-1', 'story', 'r2', 'p1', 'In the web', 'default', 'todo', 0, 1, 1),
                 ('t4', 'SHOP-1', 'feature', NULL, 'p1', 'Across both', NULL, NULL, 0, 1, 1)`,
    );
    // The counter holds the last number handed out, so these are the
    // rows behind the four keys above.
    handle.db.run(sql`INSERT INTO key_counters (prefix, next_value) VALUES ('API', 2), ('WEB', 1), ('SHOP', 1)`);

    runMigrations(handle.db, join(dirname(fileURLToPath(import.meta.url)), "migrations"));

    // Every key exactly as it was, both prefixes, on one project.
    expect(handle.db.all<{ key: string }>(sql`SELECT key FROM items ORDER BY key`).map((row) => row.key)).toEqual([
      "API-1",
      "API-2",
      "SHOP-1",
      "WEB-1",
    ]);
    // And the counters behind them, including the two that will mint
    // nothing more: the count is what says how many keys have existed,
    // and resetting one would hand out a key an item already has. Only
    // these three — the Discussions, assist and architect rooms number
    // themselves apart and have counters of their own.
    expect(
      handle.db
        .all<{ prefix: string; next_value: number }>(sql`SELECT prefix, next_value FROM key_counters ORDER BY prefix`)
        .filter((row) => ["API", "SHOP", "WEB"].includes(row.prefix)),
    ).toEqual([
      { prefix: "API", next_value: 2 },
      { prefix: "SHOP", next_value: 1 },
      { prefix: "WEB", next_value: 1 },
    ]);

    // The project keeps the prefix it already had — a repository's is not
    // copied over one, which would have renumbered the whole project.
    expect(handle.db.all(sql`SELECT id, key_prefix FROM projects`)).toEqual([{ id: "p1", key_prefix: "SHOP" }]);
    expect(handle.db.all<{ name: string }>(sql`PRAGMA table_info("repositories")`).map((row) => row.name)).not.toContain("key_prefix");

    // What the next item is called, in either repository: the
    // project's sequence, carrying on from where it was.
    const next = createTestItem(handle.db, { type: "story", title: "New work", stepId: "todo", workspaceId: "r2" as Uuid, projectId: "p1" as Uuid });
    expect(next.key).toBe("SHOP-2");
  });

  it("gives a repository no project spans one carrying its prefix", () => {
    // Every repository arrives with a project, but a membership can be
    // taken off again — and a repository with none would have nowhere for
    // its prefix to go and would start minting EO-1 after a year of
    // LONE-n. It gets the project it should have had.
    handle = openDb(":memory:");
    tempDir = mkdtempSync(join(tmpdir(), "eo-orphan-repository-migration-"));
    writeMigrationSetBefore(tempDir, "project_key_prefix");
    runMigrations(handle.db, tempDir);

    handle.db.run(
      sql`INSERT INTO repositories (id, name, key_prefix, repo_path, base_branch, created_at, updated_at)
          VALUES ('r1', 'lone', 'LONE', '/tmp/lone', 'main', 7, 7)`,
    );
    handle.db.run(
      sql`INSERT INTO tickets (id, key, type, repository_id, title, pipeline_id, step_id, priority, created_at, updated_at)
          VALUES ('t1', 'LONE-1', 'story', 'r1', 'Already numbered', 'default', 'todo', 0, 1, 1)`,
    );
    handle.db.run(sql`INSERT INTO key_counters (prefix, next_value) VALUES ('LONE', 1)`);

    runMigrations(handle.db, join(dirname(fileURLToPath(import.meta.url)), "migrations"));

    const projects = handle.db.all<{ id: string; name: string; key_prefix: string }>(sql`SELECT id, name, key_prefix FROM projects`);
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({ name: "lone", key_prefix: "LONE" });
    // And 0072 then makes that membership the workspace's own project,
    // which is what a later `createTestItem` resolves the prefix
    // through. Read as a workspace rather than as the two rows this
    // originally asserted, because by the end of the chain that is what
    // the repository has become — with the same id.
    expect(getWorkspace(handle.db, "r1" as Uuid)).toMatchObject({ projectId: projects[0]!.id });

    // The sequence carries on rather than restarting somewhere else.
    expect(createTestItem(handle.db, { type: "story", title: "Next", stepId: "todo", workspaceId: "r1" as Uuid }).key).toBe("LONE-2");
  });

  it("turns an existing single-repo database into one repository, keeping its items", () => {
    // The D-04 upgrade path, which is the one that moves data rather
    // than just adding a column: the configured workspace becomes the
    // first repository and every item is attached to it. Getting this
    // wrong empties the project for anyone who was already using EO.
    handle = openDb(":memory:");
    tempDir = mkdtempSync(join(tmpdir(), "eo-pre-repositories-"));
    writeMigrationSetBefore(tempDir, "projects");

    runMigrations(handle.db, tempDir);
    handle.db.run(
      sql`INSERT INTO workspaces (id, repo_path, base_branch, test_command, lint_command, build_command, created_at, updated_at)
          VALUES ('w1', '/home/dev/code/my-api', 'develop', 'pnpm test', NULL, NULL, 1, 1)`,
    );
    handle.db.run(
      sql`INSERT INTO tickets (id, key, type, title, state, priority, created_at, updated_at)
          VALUES ('t1', 'EO-1', 'story', 'Existing work', 'todo', 0, 1, 1)`,
    );

    runMigrations(handle.db, join(dirname(fileURLToPath(import.meta.url)), "migrations"));

    const [workspace] = listWorkspaces(handle.db);
    // Named for the repo's directory, not its whole path. Read as the
    // `git-worktree` workspace the repository became in 0072, which is
    // where those four values live now.
    expect(workspace?.config).toMatchObject({
      name: "my-api",
      repoPath: "/home/dev/code/my-api",
      baseBranch: "develop",
      testCommand: "pnpm test",
    });

    // The prefix ends up on the project (0067). Existing keys are EO-n,
    // so whichever row holds it, it has to go on minting them.
    expect(handle.db.all<{ key_prefix: string }>(sql`SELECT key_prefix FROM projects`)).toEqual([{ key_prefix: "EO" }]);

    const [item] = handle.db.all<{ key: string; workspace_id: string }>(sql`SELECT key, workspace_id FROM items`);
    expect(item).toEqual({ key: "EO-1", workspace_id: workspace!.id });
  });

  it("leaves a database that never had a repo configured with no workspaces", () => {
    // EO is usable before a repo is attached, so an empty workspaces
    // table is a normal state — not one to invent a repository for.
    handle = openDb(":memory:");
    tempDir = mkdtempSync(join(tmpdir(), "eo-no-workspace-"));
    writeMigrationSetBefore(tempDir, "projects");
    runMigrations(handle.db, tempDir);
    handle.db.run(
      sql`INSERT INTO tickets (id, key, type, title, state, priority, created_at, updated_at)
          VALUES ('t1', 'EO-1', 'story', 'Written during onboarding', 'intake', 0, 1, 1)`,
    );

    runMigrations(handle.db, join(dirname(fileURLToPath(import.meta.url)), "migrations"));

    expect(listWorkspaces(handle.db)).toEqual([]);
    // The item survives, unattached — the first workspace adopts it.
    const [item] = handle.db.all<{ key: string; workspace_id: string | null }>(sql`SELECT key, workspace_id FROM items`);
    expect(item).toEqual({ key: "EO-1", workspace_id: null });
  });

  it("permits comment_read only for an agent that could already read the item", () => {
    handle = openDb(":memory:");
    tempDir = mkdtempSync(join(tmpdir(), "eo-comment-read-tool-"));
    writeMigrationSetBefore(tempDir, "0038_comment_read_tool");
    runMigrations(handle.db, tempDir);

    runMigrations(handle.db, join(dirname(fileURLToPath(import.meta.url)), "migrations"));

    const allowed = (role: string): string[] => {
      const row = handle.db.get<{ config: string }>(sql`SELECT config FROM agents WHERE role = ${role}`);
      const config = JSON.parse(row!.config) as { allowedTools?: string[] };
      return config.allowedTools ?? [];
    };

    // It reads a subtree of a thread this one can already read whole.
    // Under `system` after 0062, which is the row it was granted on.
    expect(allowed("system")).toContain("mcp__eo__comment_read");
    // The architect reads the configuration and no item, and this must
    // not be what changes that.
    expect(allowed("pipeline_architect")).not.toContain("mcp__eo__comment_read");
    // Nobody has narrowed the implementer, so it is not narrowed here
    // either — an empty config means every tool, including this one. What
    // it holds later is the memory grant alone (0126, EO-479).
    expect(allowed("implementer")).toEqual(["mcp__eo__memory_note"]);
  });

  /**
   * EO-412: `attachment_add` is permitted wherever `attachment_read`
   * already is, and named once.
   *
   * An allowlist is exhaustive, so the tool would otherwise be listed
   * for an allowlisted agent and refused when called.
   */
  it("names attachment_add once in every allowlist that names attachment_read, and in no other", () => {
    handle = openDb(":memory:");
    tempDir = mkdtempSync(join(tmpdir(), "eo-attachment-add-tool-"));
    writeMigrationSetBefore(tempDir, "0112_attachment_add_tool");
    runMigrations(handle.db, tempDir);

    const READS = "018f0000-0000-7000-8000-00000000a412";
    const ALREADY = "018f0000-0000-7000-8000-00000000b412";
    const NO_READ = "018f0000-0000-7000-8000-00000000c412";
    const insert = (id: string, name: string, config: string): void => {
      handle.db.run(sql`INSERT INTO agents (id, name, role, provider, model, instructions, config, enabled) VALUES (${id}, ${name}, 'custom', 'claude', NULL, 'Mine.', ${config}, 1)`);
    };
    insert(READS, "Reads files", '{"allowedTools":["Read","mcp__eo__attachment_read"]}');
    // Somebody typed it in by hand before upgrading.
    insert(ALREADY, "Already has it", '{"allowedTools":["mcp__eo__attachment_add","mcp__eo__attachment_read"]}');
    insert(NO_READ, "Reads no files", '{"allowedTools":["Read"]}');
    const before = handle.db
      .all<{ id: string; config: string }>(sql`SELECT id, config FROM agents`)
      .filter((agent) => ((JSON.parse(agent.config) as { allowedTools?: unknown }).allowedTools as string[] | undefined)?.includes("mcp__eo__attachment_read"));
    // The seeded system agent is one of them, so this is not only about the rows above.
    expect(before.length).toBeGreaterThan(2);

    const migrations = join(dirname(fileURLToPath(import.meta.url)), "migrations");
    runMigrations(handle.db, migrations);

    const allowed = (id: string): string[] | undefined => (JSON.parse(handle.db.get<{ config: string }>(sql`SELECT config FROM agents WHERE id = ${id}`)!.config) as { allowedTools?: string[] }).allowedTools;
    for (const agent of before) {
      expect(allowed(agent.id)!.filter((tool) => tool === "mcp__eo__attachment_add"), agent.id).toHaveLength(1);
    }
    // Each with the `memory_note` grant 0148 gives every role after it
    // (EO-593), and the `repository_checkout` 0157 gives the same lists (EO-633).
    expect(allowed(READS)).toEqual(["Read", "mcp__eo__attachment_read", "mcp__eo__attachment_add", "mcp__eo__memory_note", "mcp__eo__repository_checkout"]);
    expect(allowed(ALREADY)).toEqual(["mcp__eo__attachment_add", "mcp__eo__attachment_read", "mcp__eo__memory_note", "mcp__eo__repository_checkout"]);
    expect(allowed(NO_READ)).toEqual(["Read", "mcp__eo__memory_note"]);
  });

  it("names repository_checkout once in every allowlist that names attachment_read, twice run or not, and touches no other agent (EO-633)", () => {
    handle = openDb(":memory:");
    tempDir = mkdtempSync(join(tmpdir(), "eo-repository-checkout-tool-"));
    writeMigrationSetBefore(tempDir, "0157_repository_checkout_tool");
    runMigrations(handle.db, tempDir);

    const READS = "018f0000-0000-7000-8000-00000000a633";
    const ALREADY = "018f0000-0000-7000-8000-00000000b633";
    const NO_READ = "018f0000-0000-7000-8000-00000000c633";
    const NO_LIST = "018f0000-0000-7000-8000-00000000d633";
    const insert = (id: string, name: string, config: string): void => {
      handle.db.run(sql`INSERT INTO agents (id, name, role, provider, model, instructions, config, enabled) VALUES (${id}, ${name}, 'custom', 'claude', NULL, 'Mine.', ${config}, 1)`);
    };
    insert(READS, "Reads files", '{"allowedTools":["Read","mcp__eo__attachment_read"]}');
    // Somebody typed it in by hand before upgrading.
    insert(ALREADY, "Already has it", '{"allowedTools":["mcp__eo__repository_checkout","mcp__eo__attachment_read"]}');
    insert(NO_READ, "Reads no files", '{"allowedTools":["Read"]}');
    insert(NO_LIST, "No list", '{"effort":"high"}');
    const config = (id: string): string => handle.db.get<{ config: string }>(sql`SELECT config FROM agents WHERE id = ${id}`)!.config;
    const allowed = (id: string): string[] | undefined => (JSON.parse(config(id)) as { allowedTools?: string[] }).allowedTools;
    const reading = handle.db
      .all<{ id: string; config: string }>(sql`SELECT id, config FROM agents`)
      .filter((agent) => ((JSON.parse(agent.config) as { allowedTools?: unknown }).allowedTools as string[] | undefined)?.includes("mcp__eo__attachment_read"));
    // The seeded system agent is one of them, so this is not only about the rows above.
    expect(reading.length).toBeGreaterThan(2);
    const noListBefore = config(NO_LIST);

    const migration = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "migrations", "0157_repository_checkout_tool.sql"), "utf8");
    runMigrations(handle.db, join(dirname(fileURLToPath(import.meta.url)), "migrations"));
    // And again, by hand, over lists that already name it.
    handle.db.run(sql.raw(migration));

    for (const agent of reading) {
      expect(allowed(agent.id)!.filter((tool) => tool === "mcp__eo__repository_checkout"), agent.id).toHaveLength(1);
    }
    expect(allowed(READS)).toEqual(["Read", "mcp__eo__attachment_read", "mcp__eo__repository_checkout"]);
    expect(allowed(ALREADY)).toEqual(["mcp__eo__repository_checkout", "mcp__eo__attachment_read"]);
    expect(allowed(NO_READ)).toEqual(["Read"]);
    expect(config(NO_LIST)).toBe(noListBefore);
  });

  it("seeds a fresh install with attachment_add beside attachment_read, and leaves an agent with no allowlist without one", () => {
    handle = openDb(":memory:");
    runMigrations(handle.db, join(dirname(fileURLToPath(import.meta.url)), "migrations"));

    const agents = handle.db.all<{ role: string; config: string }>(sql`SELECT role, config FROM agents`).map((agent) => ({ role: agent.role, allowed: (JSON.parse(agent.config) as { allowedTools?: string[] }).allowedTools }));
    const reading = agents.filter((agent) => agent.allowed?.includes("mcp__eo__attachment_read"));
    expect(reading.length).toBeGreaterThan(0);
    for (const agent of reading) expect(agent.allowed!.filter((tool) => tool === "mcp__eo__attachment_add"), agent.role).toHaveLength(1);
    // Not narrowed, so not listed: no allowlist means every tool, this one
    // included. The implementer's list is the memory grant alone (0126).
    expect(agents.find((agent) => agent.role === "implementer")?.allowed).toEqual(["mcp__eo__memory_note"]);
  });

  /**
   * EO-193: the `ASK-` threads keyed on a page are put away, not
   * rewritten and not deleted.
   *
   * Every one of them was opened on a page and is keyed on it, because
   * EO-189 preloaded that page into every turn. There is one thread now,
   * so leaving them live would mean the first thing somebody sees after
   * upgrading is whichever of them sorted first — a conversation about a
   * screen they are not on, resumed for a reason that no longer exists.
   *
   * Archiving rather than deleting is invariant #3, and it is what keeps
   * them readable: the comments and the runs stay exactly where they
   * were, and each thread shows up in the archive.
   */
  it("archives the assist threads that were keyed on a page, and deletes none of them", () => {
    handle = openDb(":memory:");
    tempDir = mkdtempSync(join(tmpdir(), "eo-one-assist-thread-migration-"));
    writeMigrationSetBefore(tempDir, "0066_one_assist_thread");
    runMigrations(handle.db, tempDir);

    // Three threads in the shape 0064 gave them: a conversation is a
    // item on the `assist` step, keyed in `spec` on the page it was
    // opened from.
    for (const [id, key, pageKey] of [
      ["a1", "ASK-1", "settings"],
      ["a2", "ASK-2", "ticket:019fb8c6-de92-7a41-9c33-4471f0c2b1de"],
      ["a3", "ASK-3", "pipeline:default"],
    ]) {
      handle.db.run(
        sql`INSERT INTO tickets (id, key, type, title, spec, pipeline_id, step_id, priority, created_at, updated_at)
            VALUES (${id}, ${key}, 'feature', 'Assistance', ${JSON.stringify({ assist: { pageKey } })}, 'discussions', 'assist', 0, 1, 1)`,
      );
      handle.db.run(
        sql`INSERT INTO comments (id, ticket_id, author_type, body, kind, created_at)
            VALUES (${`c-${id}`}, ${id}, 'human', ${`asked on ${pageKey ?? ""}`}, 'note', 2)`,
      );
    }
    // Somebody's actual work, which this must not touch.
    handle.db.run(
      sql`INSERT INTO tickets (id, key, type, title, pipeline_id, step_id, priority, created_at, updated_at)
          VALUES ('t1', 'EO-1', 'story', 'Existing work', 'default', 'todo', 0, 1, 1)`,
    );

    runMigrations(handle.db, join(dirname(fileURLToPath(import.meta.url)), "migrations"));

    const assist = listItemsIncludingArchived(handle.db).filter((item) => item.stepId === "assist");
    expect(assist.map((item) => item.key).sort()).toEqual(["ASK-1", "ASK-2", "ASK-3"]);
    // Put away, every one of them — so the next opening of the widget
    // starts the single thread rather than resuming one of these.
    expect(assist.filter((item) => item.archivedAt === null)).toEqual([]);
    // And readable in the archive, with what was said still on them.
    const archived = listArchivedItems(handle.db).map((item) => item.id);
    for (const item of assist) {
      expect(archived).toContain(item.id);
      expect(listCommentsForItem(handle.db, item.id).map((comment) => comment.body)).toHaveLength(1);
    }

    // Work is not a conversation: the sweep is scoped to the one step.
    expect(getItem(handle.db, "t1" as Uuid)?.archivedAt).toBeNull();
  });

  it("starts every existing module's history at v1, holding its code, manifest and cases, approved only if it is", () => {
    // 0109 (EO-360).
    handle = openDb(":memory:");
    tempDir = mkdtempSync(join(tmpdir(), "eo-module-versions-"));
    writeMigrationSetBefore(tempDir, "0109_module_versions");
    runMigrations(handle.db, tempDir);

    const manifest = { name: "Deploy", description: "Deploys.", inputs: {}, needs: { bin: [], env: [], network: false, item: false, comment: false, attach: false, create: false }, results: ["done"] };
    handle.db.run(
      sql`INSERT INTO modules (id, slug, name, description, code, manifest, source, approved_at, created_at, updated_at, archived_at)
          VALUES ('m-approved', 'approved', 'Approved', 'Approved one.', 'code a', ${JSON.stringify(manifest)}, 'user', 50, 10, 40, NULL),
                 ('m-unapproved', 'unapproved', 'Unapproved', 'Unapproved one.', 'code b', ${JSON.stringify(manifest)}, 'import', NULL, 10, 60, NULL),
                 ('m-archived', 'archived', 'Archived', 'Archived one.', 'code c', ${JSON.stringify(manifest)}, 'user', NULL, 10, 70, 80)`,
    );
    handle.db.run(
      sql`INSERT INTO module_tests (id, module_id, description, source, created_at, updated_at)
          VALUES ('t-2', 'm-approved', 'second', 'src 2', 30, 31),
                 ('t-1', 'm-approved', 'first', 'src 1', 20, 21)`,
    );

    runMigrations(handle.db, join(dirname(fileURLToPath(import.meta.url)), "migrations"));

    expect(getModuleVersion(handle.db, "m-approved", 1)).toEqual({
      number: 1,
      createdAt: 40,
      approvedAt: 50,
      approved: true,
      current: true,
      testCount: 2,
      name: "Approved",
      description: "Approved one.",
      code: "code a",
      manifest,
      tests: [
        { id: "t-1", description: "first", source: "src 1", createdAt: 20, updatedAt: 21 },
        { id: "t-2", description: "second", source: "src 2", createdAt: 30, updatedAt: 31 },
      ],
    });
    // The snapshot itself, not only the live rows a current version reads.
    expect(JSON.parse(handle.db.get<{ tests: string }>(sql`SELECT tests FROM module_versions WHERE module_id = 'm-approved'`)!.tests)).toHaveLength(2);
    expect(getModuleVersion(handle.db, "m-unapproved", 1)).toMatchObject({ approved: false, code: "code b", tests: [] });
    expect(JSON.parse(handle.db.get<{ tests: string }>(sql`SELECT tests FROM module_versions WHERE module_id = 'm-unapproved'`)!.tests)).toEqual([]);
    expect(listModuleVersions(handle.db, "m-archived").map((version) => version.number)).toEqual([1]);
    expect(handle.db.get<{ id: string }>(sql`SELECT id FROM module_versions WHERE module_id = 'm-approved'`)!.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("refuses to start on a broken migration and leaves no half-migrated schema", () => {
    handle = openDb(":memory:");
    tempDir = mkdtempSync(join(tmpdir(), "eo-broken-migrations-"));
    writeBrokenMigrationSet(tempDir);

    expect(() => runMigrations(handle.db, tempDir)).toThrow();

    // The first migration in the batch was valid SQL on its own — if it had
    // taken effect, this table would exist. It must not, because the whole
    // batch runs in one transaction.
    const tables = handle.db.all<{ name: string }>(
      sql`select name from sqlite_master where type = 'table' and name = 'ok'`,
    );
    expect(tables).toHaveLength(0);
  });
});

/**
 * What the migrator will actually apply, which is not what the folder
 * looks like (KAN-148).
 *
 * Drizzle decides what is pending by *timestamp alone*: it reads the
 * largest `created_at` in `__drizzle_migrations` and runs every journal
 * entry whose `when` is strictly greater. It never compares the hashes it
 * stores against the files it just read. So two migrations that share a
 * `when` are not a collision the migrator notices — the second one is
 * simply never applied, on any database that already applied the first,
 * and `getSchemaVersion` still counts it as one of the applied
 * migrations because the count is rows in that table.
 *
 * This is not hypothetical. It is what took this story's first pull
 * request red. Two branches off the same commit each minted "the next
 * migration" as the previous `when` plus a day, so `0070_spec_shape_is_a_schema`
 * and this branch's `0070_item_extensions` both claimed 1789833600000.
 * The other landed first; every database that had run it — a developer's,
 * and the self-hosted runner's, whose home directory survives between
 * jobs — then skipped `item_extensions` while reporting that 71
 * migrations had been applied. The app started against a database with no
 * `item_extensions` table, the first `listItems` threw `no such table`
 * inside the async start path, no window was ever created, and the two
 * e2e specs that boot the real app failed on a 30-second timeout naming
 * none of it.
 *
 * A guard at startup would be worse than this one: it would fire on the
 * user's machine, long after the mistake, and it could not tell a genuine
 * collision from a migration file somebody edited a comment in. This
 * fires in the unit suite of whichever branch rebases second, which is
 * the moment the two numbers first exist together.
 */
describe("the migration journal", () => {
  const folder = join(dirname(fileURLToPath(import.meta.url)), "migrations");
  const journal = JSON.parse(readFileSync(join(folder, "meta", "_journal.json"), "utf8")) as {
    entries: { idx: number; when: number; tag: string }[];
  };

  it("gives every migration a `when` of its own, in the order they are numbered", () => {
    // Strictly increasing rather than merely distinct: equal timestamps
    // are the silent skip above, and a *lower* one on a later entry is
    // the same bug with an extra step — it applies on a fresh database
    // and is skipped on every existing one.
    const outOfOrder = journal.entries
      .map((entry, index) => ({ entry, previous: journal.entries[index - 1] }))
      .filter(({ entry, previous }) => previous !== undefined && entry.when <= previous.when)
      .map(({ entry, previous }) => `${entry.tag} (${entry.when}) after ${previous!.tag} (${previous!.when})`);

    expect(outOfOrder, "two migrations sharing a timestamp: the second is never applied to a database that ran the first").toEqual([]);
  });

  it("numbers each entry the way its file is named", () => {
    // `idx` is what orders the entries and the prefix is what a person
    // reads; a rebase that renumbers the file and forgets the entry
    // leaves the folder looking correct and ordering itself wrongly.
    const mismatched = journal.entries.filter((entry) => entry.idx !== Number(entry.tag.slice(0, 4)));

    expect(mismatched.map((entry) => `${entry.tag} at idx ${entry.idx}`)).toEqual([]);
  });

  it("names a file for every entry, and an entry for every file", () => {
    // `readMigrationFiles` throws on the first missing file, which is a
    // fine failure; the other direction is the quiet one — a `.sql` in
    // the folder that no entry names is never applied and never missed.
    const tags = new Set(journal.entries.map((entry) => entry.tag));
    const files = new Set(
      readdirSync(folder)
        .filter((name) => name.endsWith(".sql"))
        .map((name) => name.replace(/\.sql$/, "")),
    );

    expect([...tags].filter((tag) => !files.has(tag)), "journal entries with no file").toEqual([]);
    expect([...files].filter((file) => !tags.has(file)), "migration files no journal entry names").toEqual([]);
  });
});

/**
 * `repositories` split four ways (KAN-130, ARCHITECTURE.md, "A workspace is a kind, attached to the
 * project").
 *
 * The migration this proves is the one that cannot be re-run: it reads
 * `repositories` and `project_repositories` and then drops them, so
 * every question about whether it carried something across has to be
 * asked here, against a database seeded in the old shape.
 *
 * The seed is deliberately the awkward one — a project spanning two
 * repositories, one of them connected to Jira and one not, with items,
 * an outbox entry and an index note pointing at both — because the
 * single-repository case cannot tell a workspace that kept its id from
 * one that was renumbered and had its readers updated to match.
 */
describe("0072: workspaces, connector bindings, and the ids that do not change", () => {
  let handle: DbHandle;
  let tempDir: string;

  afterEach(() => {
    handle.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** The schema as it stood before the split, with a project spanning two repositories in it. */
  function seedTwoRepositoryProject(): void {
    handle = openDb(":memory:");
    tempDir = mkdtempSync(join(tmpdir(), "eo-workspaces-"));
    writeMigrationSetBefore(tempDir, "0072_workspaces_and_bindings");
    runMigrations(handle.db, tempDir);

    handle.db.run(
      sql`INSERT INTO jira_connections (id, name, base_url, flavour, email, created_at, updated_at)
          VALUES ('conn-1', 'Acme', 'https://acme.atlassian.net', 'cloud', 'a@acme.test', 10, 10)`,
    );
    handle.db.run(
      sql`INSERT INTO repositories (id, name, description, repo_path, base_branch, test_command, lint_command, build_command,
                                    jira_connection_id, jira_project_key, jira_feature_issue_type, jira_story_issue_type,
                                    jira_fields, jira_status_map, jira_transition_fields, jira_create_by_default,
                                    forge_open_pr, forge_kind, forge_remote, forge_draft, forge_template_path, created_at, updated_at)
          VALUES ('repo-ui', 'ui', 'the React app', '/tmp/ui', 'main', 'pnpm test', 'pnpm lint', NULL,
                  'conn-1', 'ACME', 'Epic', 'Story',
                  '{"customfield_1":"x"}', '{"review":"In Review"}', '{"Done":{"requires":[],"values":{"resolution":"Fixed"}}}', 1,
                  1, 'github', 'origin', 0, NULL, 20, 21)`,
    );
    handle.db.run(
      sql`INSERT INTO repositories (id, name, description, repo_path, base_branch, test_command, lint_command, build_command,
                                    jira_create_by_default, forge_open_pr, forge_remote, forge_draft, created_at, updated_at)
          VALUES ('repo-api', 'api', NULL, '/tmp/api', 'trunk', 'go test', NULL, 'go build', 0, 0, 'upstream', 1, 30, 31)`,
    );
    handle.db.run(
      sql`INSERT INTO projects (id, name, key_prefix, jira_project_id, created_at, updated_at)
          VALUES ('proj-1', 'Acme', 'ACME', 'repo-ui', 40, 40)`,
    );
    handle.db.run(sql`INSERT INTO project_repositories (project_id, repository_id, position) VALUES ('proj-1', 'repo-ui', 0), ('proj-1', 'repo-api', 1)`);
    handle.db.run(
      sql`INSERT INTO item_types (id, project_id, pack_slug, slug, label, plural, container, spec_shape, action_overrides, created_at)
          VALUES ('type-story', 'proj-1', 'developer', 'story', 'Story', 'Stories', 0, '{}', '{}', 41)`,
    );
    handle.db.run(
      sql`INSERT INTO items (id, key, type_id, repository_id, project_id, title, priority, created_at, updated_at)
          VALUES ('item-ui', 'ACME-1', 'type-story', 'repo-ui', 'proj-1', 'In the UI', 0, 50, 50),
                 ('item-api', 'ACME-2', 'type-story', 'repo-api', 'proj-1', 'In the API', 0, 51, 51)`,
    );
    handle.db.run(
      sql`INSERT INTO outbox (id, item_id, repository_id, channel, kind, payload, attempts, next_attempt_at, created_at)
          VALUES ('out-1', 'item-ui', 'repo-ui', 'jira', 'comment', '{}', 0, 60, 60)`,
    );
    handle.db.run(
      sql`INSERT INTO repository_indexes (id, repository_id, item_id, provider, index_path, status)
          VALUES ('idx-1', 'repo-api', NULL, 'codewiki', '/tmp/api/.codewiki', 'ready')`,
    );
  }

  /** The raw setting 0072 writes for the startup rekey, or undefined if it wrote none. */
  function legacyTokenOwnersJson(): string | undefined {
    return handle.db.get<{ value: string }>(sql`SELECT value FROM app_settings WHERE key = 'jira.legacyTokenOwners'`)?.value;
  }

  function migrateToHead(): void {
    runMigrations(handle.db, join(dirname(fileURLToPath(import.meta.url)), "migrations"));
  }

  it("gives the project two git workspaces, each keeping the id its repository had", () => {
    seedTwoRepositoryProject();
    migrateToHead();

    const workspaces = projectWorkspaceList(handle.db, "proj-1" as Uuid);

    // In membership order, which is what decides where a `discuss`
    // dispatch runs and which one a feature's worktree is cut from.
    expect(workspaces.map((workspace) => [workspace.id, workspace.kind, workspace.position])).toEqual([
      ["repo-ui", "git-worktree", 0],
      ["repo-api", "git-worktree", 1],
    ]);

    // The commands and the forge settings are the `git-worktree` kind's
    // config, spelled as the columns were so the two can be read against
    // each other. The booleans are booleans, not the integers SQLite
    // stored them as.
    expect(workspaces[0]!.config).toEqual({
      name: "ui",
      description: "the React app",
      repoPath: "/tmp/ui",
      baseBranch: "main",
      testCommand: "pnpm test",
      lintCommand: "pnpm lint",
      buildCommand: null,
      forgeOpenPr: true,
      forgeKind: "github",
      forgeRemote: "origin",
      forgeDraft: false,
      forgeTemplatePath: null,
      // No column ever held it: the schema's default, read onto a row
      // written before the field existed (EO-741).
      forgeReviewers: [],
    });
    expect(workspaces[1]!.config).toMatchObject({ baseBranch: "trunk", buildCommand: "go build", forgeRemote: "upstream", forgeDraft: true });
  });

  it("collapses the eight Jira columns into one binding on the project", () => {
    seedTwoRepositoryProject();
    migrateToHead();

    // One row, not one per repository: which issue type a feature
    // becomes in Jira was never a fact about a checkout, and the two
    // copies a project spanning two repositories kept could disagree.
    expect(listJiraBindings(handle.db).map((binding) => binding.projectId)).toEqual(["proj-1"]);
    expect(getJiraBinding(handle.db, "proj-1" as Uuid)!.config).toEqual({
      connectionId: "conn-1",
      projectKey: "ACME",
      featureIssueType: "Epic",
      storyIssueType: "Story",
      fields: { customfield_1: "x" },
      statusMap: { review: "In Review" },
      transitionFields: { Done: { requires: [], values: { resolution: "Fixed" } } },
      createByDefault: true,
    });
  });

  it("leaves every item pointing at the same place it pointed at before", () => {
    seedTwoRepositoryProject();
    const before = handle.db.all<{ id: string; repository_id: string }>(sql`SELECT id, repository_id FROM items ORDER BY id`);
    migrateToHead();

    const after = handle.db.all<{ id: string; workspace_id: string }>(sql`SELECT id, workspace_id FROM items ORDER BY id`);

    // The whole reason a workspace keeps its repository's id: a run in
    // flight, a worktree on disk and every historical row go on meaning
    // what they meant.
    expect(after).toEqual(before.map((row) => ({ id: row.id, workspace_id: row.repository_id })));
    expect(getItem(handle.db, "item-api" as Uuid)?.workspaceId).toBe("repo-api");
  });

  it("rekeys the outbox and the index notes onto the same ids", () => {
    seedTwoRepositoryProject();
    migrateToHead();

    expect(handle.db.get<{ workspace_id: string }>(sql`SELECT workspace_id FROM outbox WHERE id = 'out-1'`)?.workspace_id).toBe("repo-ui");
    expect(listRepositoryIndexes(handle.db, "repo-api").map((index) => index.id)).toEqual(["idx-1"]);
  });

  it("drops both old tables and the column that named a repository's Jira", () => {
    seedTwoRepositoryProject();
    migrateToHead();

    const gone = handle.db.all<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('repositories', 'project_repositories')`,
    );
    expect(gone).toEqual([]);
    // `jira_project_id` named which member's Jira received the project's
    // features, which is only a question while every repository carries
    // its own. It is not moved; it stops being one.
    expect(handle.db.all<{ name: string }>(sql`PRAGMA table_info(projects)`).map((column) => column.name)).not.toContain("jira_project_id");
  });

  it("takes the nominated repository's Jira where two members are connected", () => {
    seedTwoRepositoryProject();
    // The second member connected too, to a different Jira project. One
    // binding can only hold one, and the one the person chose as the
    // features' home beats the accident of insertion order.
    handle.db.run(sql`UPDATE repositories SET jira_connection_id = 'conn-1', jira_project_key = 'OTHER' WHERE id = 'repo-api'`);
    handle.db.run(sql`UPDATE projects SET jira_project_id = 'repo-api' WHERE id = 'proj-1'`);
    migrateToHead();

    expect(getJiraBinding(handle.db, "proj-1" as Uuid)!.config.projectKey).toBe("OTHER");
  });

  it("writes no binding for a project that mirrors nowhere", () => {
    seedTwoRepositoryProject();
    handle.db.run(sql`UPDATE repositories SET jira_connection_id = NULL, jira_project_key = NULL WHERE id = 'repo-ui'`);
    handle.db.run(sql`UPDATE projects SET jira_project_id = NULL WHERE id = 'proj-1'`);
    migrateToHead();

    // No row at all rather than one asserting silence, so "never
    // connected" has a single spelling — the call KAN-148 made for item
    // extensions.
    expect(listJiraBindings(handle.db)).toEqual([]);
  });

  /**
   * The seed above, but with the two repositories on *different* Jira
   * accounts and the project nominating the second one.
   *
   * This is the shape that exposes the credential bug: the surviving
   * binding is `repo-api`'s, and `repo-api` is second in membership
   * order, so anything that walks the project's workspaces meets
   * `repo-ui` — whose token is for another account entirely — first.
   */
  function connectBothToDifferentJiras(): void {
    handle.db.run(
      sql`INSERT INTO jira_connections (id, name, base_url, flavour, email, created_at, updated_at)
          VALUES ('conn-2', 'Other', 'https://other.atlassian.net', 'cloud', 'b@other.test', 11, 11)`,
    );
    handle.db.run(sql`UPDATE repositories SET jira_connection_id = 'conn-2', jira_project_key = 'OTHER' WHERE id = 'repo-api'`);
    handle.db.run(sql`UPDATE projects SET jira_project_id = 'repo-api' WHERE id = 'proj-1'`);
  }

  it("writes down which connection each repository's token was actually for", () => {
    seedTwoRepositoryProject();
    connectBothToDifferentJiras();
    migrateToHead();

    // Both pairs, not just the surviving binding's. A token file is
    // named after the repository that held it, and after this migration
    // nothing else in the schema can say which account it authenticated
    // against — `repo-ui`'s connection is dropped with the table.
    //
    // Read as SQL rather than through the jira pack's own reader: the
    // core's migration test says what the migration wrote, and the pack
    // is what reads it (invariant 13). `legacyTokenOwners.test.ts` pins
    // the other half, against this exact JSON.
    expect(JSON.parse(legacyTokenOwnersJson() ?? "null")).toEqual([
      { repositoryId: "repo-ui", connectionId: "conn-1" },
      { repositoryId: "repo-api", connectionId: "conn-2" },
    ]);
  });

  it("writes nothing down for a database that never connected Jira", () => {
    seedTwoRepositoryProject();
    handle.db.run(sql`UPDATE repositories SET jira_connection_id = NULL, jira_project_key = NULL`);
    migrateToHead();

    // Not an empty list written as a setting — no setting at all. There
    // was never a token to move, and the reader treats the absence and
    // the empty list as the same instruction.
    expect(legacyTokenOwnersJson()).toBeUndefined();
  });

  /**
   * A second project spanning a repository the first one already spans.
   *
   * `project_repositories` was a join table, so this was expressible,
   * and the two projects each have their own items on the shared
   * checkout — with their own key prefixes, which is what makes moving
   * an item between them the wrong repair.
   */
  function shareRepoUiWithASecondProject(): void {
    handle.db.run(sql`INSERT INTO projects (id, name, key_prefix, jira_project_id, created_at, updated_at) VALUES ('proj-2', 'Beta', 'BETA', NULL, 42, 42)`);
    handle.db.run(sql`INSERT INTO project_repositories (project_id, repository_id, position) VALUES ('proj-2', 'repo-ui', 0)`);
    handle.db.run(
      sql`INSERT INTO item_types (id, project_id, pack_slug, slug, label, plural, container, spec_shape, action_overrides, created_at)
          VALUES ('type-story-2', 'proj-2', 'developer', 'story', 'Story', 'Stories', 0, '{}', '{}', 43)`,
    );
    handle.db.run(
      sql`INSERT INTO items (id, key, type_id, repository_id, project_id, title, priority, created_at, updated_at)
          VALUES ('item-beta', 'BETA-1', 'type-story-2', 'repo-ui', 'proj-2', 'On the shared checkout', 0, 52, 52)`,
    );
    handle.db.run(
      sql`INSERT INTO outbox (id, item_id, repository_id, channel, kind, payload, attempts, next_attempt_at, created_at)
          VALUES ('out-beta', 'item-beta', 'repo-ui', 'jira', 'comment', '{}', 0, 61, 61)`,
    );
  }

  /**
   * Every item, with the project it says it is on and the project its
   * workspace is attached to. These must agree: Jira *pull* resolves a
   * binding from `item.projectId` and the outbox *sender* resolves one
   * from the workspace's project, so an item where they differ pulls
   * from one Jira account and pushes to another.
   */
  function routingDisagreements(): { id: string; itemProject: string | null; workspaceProject: string | null }[] {
    return handle.db
      .all<{ id: string; itemProject: string | null; workspaceProject: string | null }>(
        sql`SELECT i.id AS id, i.project_id AS itemProject, w.project_id AS workspaceProject
            FROM items i LEFT JOIN workspaces w ON w.id = i.workspace_id`,
      )
      .filter((row) => row.itemProject !== row.workspaceProject);
  }

  it("gives each project spanning a shared repository its own workspace on the same checkout", () => {
    seedTwoRepositoryProject();
    shareRepoUiWithASecondProject();
    migrateToHead();

    // `proj-1` keeps the id, being first. `proj-2` cannot share the row
    // — a workspace belongs to one project (ARCHITECTURE.md, "A workspace is a kind, attached to
    // the project") — so it gets its own,
    // pointed at the same checkout.
    expect(getWorkspace(handle.db, "repo-ui" as Uuid)?.projectId).toBe("proj-1");

    const [betaWorkspace] = projectWorkspaceList(handle.db, "proj-2" as Uuid);
    expect(betaWorkspace, "the second project keeps a workspace of its own").toBeDefined();
    expect(betaWorkspace!.id).not.toBe("repo-ui");
    expect(betaWorkspace!.config).toMatchObject({ repoPath: "/tmp/ui", baseBranch: "main" });
  });

  it("leaves no item pulling from one Jira and pushing to another", () => {
    seedTwoRepositoryProject();
    shareRepoUiWithASecondProject();
    migrateToHead();

    // The whole point of the split above. `item-beta` is on `proj-2`;
    // if its workspace stayed `proj-1`'s, the sender would resolve
    // `proj-1`'s binding while the pull resolved `proj-2`'s.
    expect(routingDisagreements()).toEqual([]);
    expect(getItem(handle.db, "item-beta" as Uuid)?.workspaceId).toBe(projectWorkspaceList(handle.db, "proj-2" as Uuid)[0]!.id);

    // The outbox is denormalised on the same id, so a queued push has to
    // move with the item or it would still resolve the old binding.
    expect(handle.db.get<{ workspace_id: string }>(sql`SELECT workspace_id FROM outbox WHERE id = 'out-beta'`)?.workspace_id).toBe(
      projectWorkspaceList(handle.db, "proj-2" as Uuid)[0]!.id,
    );
  });

  it("leaves the ordinary case with every item still on the id its repository had", () => {
    seedTwoRepositoryProject();
    migrateToHead();

    // No sharing, so nothing is split and the id guarantee is absolute.
    expect(routingDisagreements()).toEqual([]);
    expect(getItem(handle.db, "item-ui" as Uuid)?.workspaceId).toBe("repo-ui");
    expect(getItem(handle.db, "item-api" as Uuid)?.workspaceId).toBe("repo-api");
  });

  it("keeps a repository no project spans, as a workspace attached to none", () => {
    seedTwoRepositoryProject();
    // What deleting a project already left behind: the membership row
    // cascaded and the repository did not. Its items still name it, so
    // the row has to survive the split.
    handle.db.run(sql`DELETE FROM project_repositories WHERE repository_id = 'repo-api'`);
    migrateToHead();

    expect(getWorkspace(handle.db, "repo-api" as Uuid)).toMatchObject({ projectId: null });
    expect(getItem(handle.db, "item-api" as Uuid)?.workspaceId).toBe("repo-api");
  });
});

describe("0073: the run's directory stops being named after one kind of workspace", () => {
  let handle: DbHandle;
  let tempDir: string;

  afterEach(() => {
    handle.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("renames worktree_path to cwd, keeping what every historical run worked in", () => {
    // A rename rather than a new column and a backfill, and this is
    // what that buys: a run interrupted by the upgrade resumes in the
    // directory it started in, because the value never moved (EO-295).
    handle = openDb(":memory:");
    tempDir = mkdtempSync(join(tmpdir(), "eo-run-cwd-"));
    writeMigrationSetBefore(tempDir, "0073_runs_cwd");
    runMigrations(handle.db, tempDir);

    // Whatever the seeded `story` type's id is on this schema: what
    // this test is about is a column, and an item is only here to hang
    // two runs off.
    const storyType = handle.db.get<{ id: string }>(sql`SELECT id FROM item_types WHERE slug = 'story' LIMIT 1`)!.id;
    handle.db.run(
      sql`INSERT INTO items (id, key, type_id, title, priority, created_at, updated_at)
          VALUES ('item-1', 'EO-1', ${storyType}, 'A story', 0, 10, 10)`,
    );
    handle.db.run(
      sql`INSERT INTO runs (id, item_id, action, status, worktree_path, attempt, thread_lost, dry_run)
          VALUES ('run-worked', 'item-1', 'implement', 'awaiting_input', '/home/dev/.eo/worktrees/EO-1', 1, 0, 0),
                 ('run-nowhere', 'item-1', 'intake', 'succeeded', NULL, 1, 0, 0)`,
    );

    runMigrations(handle.db, join(dirname(fileURLToPath(import.meta.url)), "migrations"));

    const rows = handle.db.all<{ id: string; cwd: string | null }>(sql`SELECT id, cwd FROM runs ORDER BY id`);
    expect(rows).toEqual([
      { id: "run-nowhere", cwd: null },
      { id: "run-worked", cwd: "/home/dev/.eo/worktrees/EO-1" },
    ]);
    // And nothing is left answering to the old name, so no reader can
    // quietly keep using it.
    expect(handle.db.all<{ name: string }>(sql.raw(`PRAGMA table_info("runs")`)).map((row) => row.name)).not.toContain("worktree_path");
  });

  /**
   * EO-353: the module dry run is gone, and nothing it left is rewritten.
   *
   * A module approved before the change keeps its approval — editing
   * its code is what clears it, so the tests are asked for at its next
   * approval rather than sprung on it by an upgrade. And a run flagged
   * `dry_run` is history: the flag and the run stay exactly as they were.
   */
  it("keeps a module's approval and every dry-run run when the module's dry-run mark goes", () => {
    handle = openDb(":memory:");
    tempDir = mkdtempSync(join(tmpdir(), "eo-dry-run-retired-"));
    writeMigrationSetBefore(tempDir, "0107_module_dry_run_retired");
    runMigrations(handle.db, tempDir);

    const manifest = JSON.stringify({ name: "Deploy", description: "Deploys.", inputs: {}, needs: { bin: [], env: [], network: false, item: false, comment: false, attach: false, create: false }, results: ["deployed"] });
    handle.db.run(
      sql`INSERT INTO modules (id, slug, name, description, code, manifest, original_script, source, approved_at, dry_run_at, created_at, updated_at, archived_at)
          VALUES ('m-approved', 'deploy', 'Deploy', 'Deploys.', 'export default async () => ({ ok: true, result: "deployed" })', ${manifest}, NULL, 'architect', 500, 400, 1, 1, NULL),
                 ('m-pending', 'tag', 'Tag', 'Tags.', 'export default async () => ({ ok: true, result: "deployed" })', ${manifest}, NULL, 'user', NULL, 400, 1, 1, NULL)`,
    );
    const storyType = handle.db.get<{ id: string }>(sql`SELECT id FROM item_types WHERE slug = 'story' LIMIT 1`)!.id;
    handle.db.run(sql`INSERT INTO items (id, key, type_id, title, priority, created_at, updated_at) VALUES ('item-1', 'EO-1', ${storyType}, 'A story', 0, 10, 10)`);
    handle.db.run(
      sql`INSERT INTO runs (id, item_id, action, status, attempt, thread_lost, dry_run, provider)
          VALUES ('run-dry', 'item-1', 'm-approved', 'succeeded', 1, 0, 1, 'module')`,
    );

    runMigrations(handle.db, join(dirname(fileURLToPath(import.meta.url)), "migrations"));

    expect(getModule(handle.db, "m-approved")?.approvedAt).toBe(500);
    expect(getModule(handle.db, "m-pending")?.approvedAt).toBeNull();
    expect(handle.db.all<{ name: string }>(sql.raw(`PRAGMA table_info("modules")`)).map((row) => row.name)).not.toContain("dry_run_at");
    expect(getRun(handle.db, "run-dry" as Uuid)).toMatchObject({ dryRun: true, provider: "module", status: "succeeded" });
  });

  /**
   * EO-356: a module's scenario chat gets a step of its own, off every
   * board, and nothing already there moves.
   */
  it("adds the scenario chat's off-board step and its key sequence, disturbing none of the rooms already there", () => {
    handle = openDb(":memory:");
    tempDir = mkdtempSync(join(tmpdir(), "eo-scenario-room-"));
    writeMigrationSetBefore(tempDir, "0108_scenario_room");
    runMigrations(handle.db, tempDir);
    const before = handle.db.all(sql`SELECT id, pipeline_id, position, off_board FROM pipeline_steps ORDER BY id`);

    runMigrations(handle.db, join(dirname(fileURLToPath(import.meta.url)), "migrations"));

    expect(
      handle.db.get(
        sql`SELECT pipeline_id, type, owner_role, entry_action, is_terminal, off_board
            FROM pipeline_steps WHERE id = 'scenario'`,
      ),
    ).toEqual({ pipeline_id: "discussions", type: "user", owner_role: null, entry_action: null, is_terminal: 0, off_board: 1 });
    expect(handle.db.get(sql`SELECT next_value FROM key_counters WHERE prefix = 'SCN'`)).toEqual({ next_value: 1 });
    // 0123's pull request watch (EO-461) is added on the way past, and
    // moves Done one along; 0168 removes 0078's `job-thread` (EO-730).
    expect(
      handle.db.all(sql`SELECT id, pipeline_id, position, off_board FROM pipeline_steps WHERE id NOT IN ('scenario', 'pull_request_watch') ORDER BY id`),
    ).toEqual(afterThePullRequestWatch(withoutThreadSteps(before)));
  });

  /**
   * EO-302: every human mention gets the person it always meant.
   *
   * `comment_mentions.target_id` was NULL on every human row, which made
   * the inbox and the `!` marker queries for an *absence* — and an
   * absence has no name, so nothing could say which person was being
   * waited on. 0077 creates the one implicit local person and rewrites
   * those rows onto it.
   *
   * What this proves is the migration's whole contract: the person
   * exists and is "you", not one human mention is left pointing at
   * nobody, an agent mention is untouched — its target was never the
   * missing one — and the statuses survive, because an addressed
   * mention rewritten as open would put an answered question back in
   * somebody's inbox on the launch that upgrades them.
   *
   * The two mentions on `c-doubled` are the case the schema permitted
   * and nothing wrote: SQLite counts NULLs in a unique index as
   * distinct, so the old primary key `(comment_id, target_type,
   * target_id)` did not stop a comment carrying two human mentions.
   * Filling both in with one UPDATE would trip the key and refuse the
   * whole batch — a database that will not open — so the one still
   * waiting for an answer survives and its duplicate goes.
   */
  it("gives every human mention the local person, and creates the person to give them", () => {
    handle = openDb(":memory:");
    tempDir = mkdtempSync(join(tmpdir(), "eo-people-"));
    writeMigrationSetBefore(tempDir, "0077_people");
    runMigrations(handle.db, tempDir);

    const storyType = handle.db.get<{ id: string }>(sql`SELECT id FROM item_types WHERE slug = 'story' LIMIT 1`)!.id;
    handle.db.run(
      sql`INSERT INTO items (id, key, type_id, title, priority, created_at, updated_at)
          VALUES ('item-1', 'EO-1', ${storyType}, 'A story', 0, 10, 10)`,
    );
    handle.db.run(
      sql`INSERT INTO comments (id, item_id, author_type, body, kind, attachments, pinned, created_at)
          VALUES ('c-open', 'item-1', 'agent', '@user which environment?', 'escalation', '[]', 0, 11),
                 ('c-answered', 'item-1', 'agent', '@user is this right?', 'question', '[]', 0, 12),
                 ('c-agent', 'item-1', 'human', '@reviewer take another look', 'note', '[]', 0, 13),
                 ('c-doubled', 'item-1', 'agent', '@user @human same question twice', 'escalation', '[]', 0, 14)`,
    );
    const reviewer = handle.db.get<{ id: string }>(sql`SELECT id FROM agents WHERE role = 'reviewer' LIMIT 1`)!.id;
    handle.db.run(
      sql`INSERT INTO comment_mentions (comment_id, target_type, target_id, status, addressed_by)
          VALUES ('c-open', 'human', NULL, 'open', NULL),
                 ('c-answered', 'human', NULL, 'addressed', 'c-agent'),
                 ('c-agent', 'agent', ${reviewer}, 'open', NULL),
                 ('c-doubled', 'human', NULL, 'addressed', 'c-agent'),
                 ('c-doubled', 'human', NULL, 'open', NULL)`,
    );

    runMigrations(handle.db, join(dirname(fileURLToPath(import.meta.url)), "migrations"));

    // One person, and it is the one the code names.
    expect(localPerson(handle.db)).toMatchObject({ id: LOCAL_PERSON_ID, name: LOCAL_PERSON_NAME, email: null });
    expect(listPeople(handle.db).map((person) => person.id)).toEqual([LOCAL_PERSON_ID]);

    // The acceptance criterion, asked of the table rather than of the
    // rows this test happens to have seeded: nothing is left pointing
    // at nobody.
    expect(handle.db.all(sql`SELECT 1 FROM comment_mentions WHERE target_id IS NULL`)).toEqual([]);

    const mentions = handle.db.all<{ comment_id: string; target_type: string; target_id: string; status: string; addressed_by: string | null }>(
      sql`SELECT comment_id, target_type, target_id, status, addressed_by FROM comment_mentions ORDER BY comment_id, status`,
    );
    expect(mentions).toEqual([
      // An agent mention already named its target and is untouched.
      { comment_id: "c-agent", target_type: "agent", target_id: reviewer, status: "open", addressed_by: null },
      { comment_id: "c-answered", target_type: "human", target_id: LOCAL_PERSON_ID, status: "addressed", addressed_by: "c-agent" },
      // Of the two the schema let through, the one still waiting is the
      // one that survives: losing it would take a question out of the
      // inbox that nobody ever answered.
      { comment_id: "c-doubled", target_type: "human", target_id: LOCAL_PERSON_ID, status: "open", addressed_by: null },
      { comment_id: "c-open", target_type: "human", target_id: LOCAL_PERSON_ID, status: "open", addressed_by: null },
    ]);

    // And the escalation still reads as one: `!` is derived from this
    // query, so a rewrite that missed would take the marker off an item
    // nobody has answered (invariant #6).
    expect(needsAttention(handle.db, "item-1" as Uuid)).toBe(true);
    expect(openMentionsForHuman(handle.db).map((open) => open.comment.id)).toEqual(["c-doubled", "c-open"]);
  });

  /**
   * The other half of 0077: the columns, and what they say about rows
   * written before they existed.
   *
   * Not backfilled with the local person, deliberately. An item created
   * before EO had a concept of people was created by *somebody*, and
   * asserting it was this row would be inventing a fact rather than
   * recording one — the same reason `pipeline_steps.workspace_id` was
   * left null by 0076 rather than frozen onto whichever workspace
   * happened to be first.
   */
  it("leaves every existing item and step saying nothing about who owns it", () => {
    handle = openDb(":memory:");
    tempDir = mkdtempSync(join(tmpdir(), "eo-people-columns-"));
    writeMigrationSetBefore(tempDir, "0077_people");
    runMigrations(handle.db, tempDir);

    const storyType = handle.db.get<{ id: string }>(sql`SELECT id FROM item_types WHERE slug = 'story' LIMIT 1`)!.id;
    handle.db.run(
      sql`INSERT INTO items (id, key, type_id, title, priority, created_at, updated_at)
          VALUES ('item-1', 'EO-1', ${storyType}, 'Work that predates people', 0, 10, 10)`,
    );

    runMigrations(handle.db, join(dirname(fileURLToPath(import.meta.url)), "migrations"));

    const item = getItem(handle.db, "item-1" as Uuid)!;
    expect(item.createdBy).toBeNull();
    expect(item.assigneeId).toBeNull();

    const steps = handle.db.all<{ owner_person_id: string | null; owner_group_id: string | null }>(
      sql`SELECT owner_person_id, owner_group_id FROM pipeline_steps`,
    );
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.every((step) => step.owner_person_id === null && step.owner_group_id === null)).toBe(true);
  });

  /**
   * 0078: the two job tables, and the off-board step a job's thread
   * lives on (EO-304, ARCHITECTURE.md, "What a job records").
   *
   * What has to be true of an installation that upgrades into it:
   * nothing it already had moved, the new step is off-board and on the
   * Discussions pipeline so it is neither a column nor a place work can
   * be filed, and `job-thread` has a key sequence of its own so threads
   * do not put holes in the numbers people quote.
   */
  it("adds the job tables and a fourth off-board step, disturbing none of the rooms already there", () => {
    handle = openDb(":memory:");
    tempDir = mkdtempSync(join(tmpdir(), "eo-jobs-"));
    writeMigrationSetBefore(tempDir, "0078_jobs");
    runMigrations(handle.db, tempDir);

    const storyType = handle.db.get<{ id: string }>(sql`SELECT id FROM item_types WHERE slug = 'story' LIMIT 1`)!.id;
    handle.db.run(
      sql`INSERT INTO items (id, key, type_id, title, pipeline_id, step_id, priority, created_at, updated_at)
          VALUES ('c-disc', 'DISC-1', ${storyType}, 'Rate limiting', 'discussions', 'discussion', 0, 1, 1)`,
    );
    const stepsBefore = handle.db.all(sql`SELECT id FROM pipeline_steps`).length;

    // As far as the release before 0168, which retired the job threads
    // again (EO-730).
    runMigrationsBeforeTheThreadsRetired(handle.db);

    expect(
      handle.db.get(
        sql`SELECT pipeline_id, type, owner_role, entry_action, is_terminal, off_board
            FROM pipeline_steps WHERE id = 'job-thread'`,
      ),
    ).toEqual({ pipeline_id: "discussions", type: "user", owner_role: null, entry_action: null, is_terminal: 0, off_board: 1 });
    expect(handle.db.get(sql`SELECT next_value FROM key_counters WHERE prefix = 'JOB'`)).toEqual({ next_value: 1 });

    // One step more, the conversation still where it was — four, since
    // 0108 adds the scenario chat's step (EO-356), 0119 the project
    // thread's (EO-471) and 0123 the shipped pipeline's pull request watch
    // (EO-461) on the way past.
    expect(handle.db.all(sql`SELECT id FROM pipeline_steps`)).toHaveLength(stepsBefore + 4);
    expect(getItem(handle.db, "c-disc" as Uuid)?.stepId).toBe("discussion");

    // Both tables, empty: an installation that upgrades has no jobs
    // until somebody makes one.
    expect(handle.db.all(sql`SELECT id FROM jobs`)).toEqual([]);
    expect(handle.db.all(sql`SELECT id FROM job_occurrences`)).toEqual([]);
  });
});

/**
 * Seeding the pack's own default without editing anybody's pipeline
 * (EO-310).
 *
 * `0082` gives the developer pipeline's human step the two decisions it
 * always implied — Approve, and Send back with the reason. A migration
 * that seeds a *default* has to be able to tell that default from what
 * somebody has made of it, and the id cannot: `ready_to_merge` is the id
 * of whatever now stands in that column, which on a project a year old
 * may be "Waiting on legal", may no longer be terminal, and may be
 * exactly the deliberately quiet human step its owner wanted.
 *
 * These are the upgrade path rather than a fresh install, because the
 * question only exists on the upgrade: a database being born has nothing
 * anybody has customised.
 */
describe("0082: the developer pipeline's decision, seeded only where it is still the pack's", () => {
  let handle: DbHandle;
  let tempDir: string;

  /** A database as the release before this one left it, ready to be customised. */
  function upgradeFrom(): void {
    handle = openDb(":memory:");
    tempDir = mkdtempSync(join(tmpdir(), "eo-step-results-"));
    writeMigrationSetBefore(tempDir, "0082_step_results");
    runMigrations(handle.db, tempDir);
  }

  /** And then the release that adds the decision. */
  function upgrade(): void {
    runMigrations(handle.db, join(dirname(fileURLToPath(import.meta.url)), "migrations"));
  }

  function doneStep(): { name: string; results: string } {
    return handle.db.get<{ name: string; results: string }>(sql`SELECT name, results FROM pipeline_steps WHERE id = 'ready_to_merge'`)!;
  }

  function routesOutOfDone(): { result_key: string; target: string }[] {
    return handle.db.all<{ result_key: string; target: string }>(sql`SELECT result_key, target FROM step_routes WHERE from_step_id = 'ready_to_merge' ORDER BY position`);
  }

  afterEach(() => {
    handle.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("gives the untouched shipped step its two decisions and their routes", () => {
    upgradeFrom();
    upgrade();

    expect(JSON.parse(doneStep().results)).toEqual([
      { key: "approved", label: "Approve", tone: "success", requiresComment: false },
      { key: "send_back", label: "Send back", tone: "warning", requiresComment: true },
    ]);
    expect(routesOutOfDone()).toEqual([
      { result_key: "approved", target: "terminal" },
      { result_key: "send_back", target: "todo" },
    ]);
  });

  /**
   * The case the review named. A rename is the cheapest thing anybody
   * does to a column and the clearest statement that the step is theirs
   * now — and it is invisible to a guard that matches on the id.
   */
  it("leaves a renamed step alone, decisions and routes both", () => {
    upgradeFrom();
    handle.db.run(sql`UPDATE pipeline_steps SET name = 'Waiting on legal' WHERE id = 'ready_to_merge'`);

    upgrade();

    expect(doneStep()).toMatchObject({ name: "Waiting on legal", results: "[]" });
    expect(routesOutOfDone()).toEqual([]);
  });

  /**
   * And the other customisations the same guard has to see. Each is one
   * thing the configuration screen can do to that step, and each changes
   * what approving there would mean — `approved` routes to `terminal`,
   * so a step that is no longer terminal would approve to somewhere
   * else entirely.
   */
  it("leaves a step whose shape somebody changed alone", () => {
    for (const change of [
      sql`UPDATE pipeline_steps SET is_terminal = 0 WHERE id = 'ready_to_merge'`,
      sql`UPDATE pipeline_steps SET type = 'agent', owner_role = 'reviewer', entry_action = 'review' WHERE id = 'ready_to_merge'`,
      sql`UPDATE pipeline_steps SET off_board = 1 WHERE id = 'ready_to_merge'`,
      sql`UPDATE pipeline_steps SET instructions_summary = 'Check the invoice first' WHERE id = 'ready_to_merge'`,
    ]) {
      upgradeFrom();
      handle.db.run(change);

      upgrade();

      expect(doneStep().results).toBe("[]");
      expect(routesOutOfDone()).toEqual([]);
      handle.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
    // The loop closed the last one; `afterEach` needs something to
    // close and something to remove.
    upgradeFrom();
  });

  /** A branch drawn out of it is somebody having wired the step themselves. */
  it("leaves a step somebody has already routed alone", () => {
    upgradeFrom();
    handle.db.run(
      sql`INSERT INTO step_routes (id, pipeline_id, from_step_id, result_key, label, tone, target, position)
          VALUES ('r_mine', 'default', 'ready_to_merge', 'shipped', 'Shipped', 'success', 'todo', 0)`,
    );

    upgrade();

    expect(doneStep().results).toBe("[]");
    expect(routesOutOfDone()).toEqual([{ result_key: "shipped", target: "todo" }]);
  });

  /**
   * Both halves or neither. The send-back means "back to be written
   * again", which is true of the implementer's column and of nothing
   * else — and declaring the result without its route would leave the
   * shipped pipeline failing its own validator, put there by an upgrade.
   */
  it("writes nothing at all when the step the send-back means is not there", () => {
    upgradeFrom();
    handle.db.run(sql`UPDATE pipeline_steps SET type = 'user', owner_role = NULL, entry_action = NULL WHERE id = 'todo'`);

    upgrade();

    expect(doneStep().results).toBe("[]");
    expect(routesOutOfDone()).toEqual([]);
  });

  /**
   * The customisations that are *not* disqualifying, which matter as
   * much as the ones that are: refusing these would withhold the buttons
   * from people who had said out loud that they want somebody to press
   * one.
   */
  it("still seeds a pipeline somebody has added a step to, or named an approver on", () => {
    upgradeFrom();
    // A QA column inserted before Done, which renumbers it.
    handle.db.run(
      sql`INSERT INTO pipeline_steps (id, pipeline_id, position, name, type, owner_role, entry_action, instructions_summary, is_terminal, plan_mode, off_board)
          VALUES ('qa', 'default', 5, 'QA', 'agent', 'reviewer', 'review', NULL, 0, 0, 0)`,
    );
    handle.db.run(sql`UPDATE pipeline_steps SET position = 6 WHERE id = 'ready_to_merge'`);
    // And the person who approves here (EO-302).
    handle.db.run(sql`UPDATE pipeline_steps SET owner_person_id = ${LOCAL_PERSON_ID} WHERE id = 'ready_to_merge'`);

    upgrade();

    expect(JSON.parse(doneStep().results)).toHaveLength(2);
    expect(routesOutOfDone()).toHaveLength(2);
  });
});

/**
 * The check drizzle-kit used to do for us, and no longer can.
 *
 * The generated snapshots under `meta/` stopped being updated at 0012
 * while the migrations kept going to 0036 — every one since has been
 * hand-written SQL. That is a reasonable way to work (several of them do
 * things drizzle-kit cannot express), but it costs the guarantee
 * `drizzle-kit generate` gave for free: that `schema.ts` and the
 * migrations describe the same database. `generate` cannot even be run
 * now without being asked to reconcile a table it thinks was renamed.
 *
 * Nothing else notices the gap. Adding a column to `schema.ts` and
 * forgetting its migration typechecks perfectly and fails at runtime, on
 * whichever query happens to name it first, with `no such column` — and
 * only against a real user's database, since a test that never touches
 * that column never asks.
 */
describe("schema.ts and the migrations describe the same database", () => {
  it("declares no table or column the migrations do not create", async () => {
    const { getTableConfig } = await import("drizzle-orm/sqlite-core");
    const schema = await import("./schema.js");

    const migrated = openDb(":memory:");
    try {
      runMigrations(migrated.db, join(dirname(fileURLToPath(import.meta.url)), "migrations"));

      const missing: string[] = [];
      for (const exported of Object.values(schema)) {
        let table;
        try {
          table = getTableConfig(exported as never);
        } catch {
          continue; // an enum, a type, a helper — not a table
        }

        const columns = new Set(
          migrated.db.all<{ name: string }>(sql.raw(`PRAGMA table_info("${table.name}")`)).map((row) => row.name),
        );
        if (columns.size === 0) {
          missing.push(`table ${table.name}`);
          continue;
        }
        for (const column of table.columns) {
          if (!columns.has(column.name)) missing.push(`${table.name}.${column.name}`);
        }
      }

      expect(missing).toEqual([]);
    } finally {
      migrated.close();
    }
  });
});

/**
 * The two results the pull request step sends back, routed in the shipped
 * pipeline (EO-429) — on the upgrade path, because that is the only place
 * a guard has anything to guard against.
 */
describe("0114: uncommitted changes and a diverged branch go back to the implementer", () => {
  let handle: DbHandle;
  let tempDir: string;

  const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "migrations");

  function upgradeFrom(): void {
    handle = openDb(":memory:");
    tempDir = mkdtempSync(join(tmpdir(), "eo-pull-request-routes-"));
    writeMigrationSetBefore(tempDir, "0114_pull_request_return_routes");
    runMigrations(handle.db, tempDir);
  }

  function upgrade(): void {
    runMigrations(handle.db, MIGRATIONS);
  }

  function routesOutOfMergeRequest(): { id: string; result_key: string; target: string; position: number }[] {
    return handle.db.all<{ id: string; result_key: string; target: string; position: number }>(
      sql`SELECT id, result_key, target, position FROM step_routes WHERE from_step_id = 'merge_request' ORDER BY position, id`,
    );
  }

  afterEach(() => {
    handle.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("adds both routes to the shipped pipeline, after the three it already had", () => {
    upgradeFrom();
    const before = routesOutOfMergeRequest();
    expect(before.map((route) => route.result_key)).toEqual(["opened", "skipped", "failed"]);

    upgrade();

    expect(routesOutOfMergeRequest()).toEqual([
      // 0123 runs on the way past and sends `opened` through the pull
      // request watch (EO-461); the other two are as they were.
      ...before.map((route) => (route.result_key === "opened" ? { ...route, target: "pull_request_watch" } : route)),
      { id: "r_merge_uncommitted", result_key: "uncommitted_changes", target: "todo", position: 3 },
      { id: "r_merge_diverged", result_key: "remote_diverged", target: "todo", position: 4 },
    ]);
    expect(handle.db.all(sql`SELECT pipeline_id, label, tone FROM step_routes WHERE id IN ('r_merge_uncommitted', 'r_merge_diverged') ORDER BY position`)).toEqual([
      { pipeline_id: "default", label: "Uncommitted changes", tone: "warning" },
      { pipeline_id: "default", label: "Remote branch diverged", tone: "warning" },
    ]);
  });

  it("leaves a key somebody has already routed where they sent it, and still adds the other", () => {
    upgradeFrom();
    handle.db.run(
      sql`INSERT INTO step_routes (id, pipeline_id, from_step_id, result_key, label, tone, target, position)
          VALUES ('r_mine', 'default', 'merge_request', 'remote_diverged', 'Ask me', 'danger', 'user_attention', 3)`,
    );

    upgrade();

    const added = routesOutOfMergeRequest().filter((route) => route.result_key === "remote_diverged" || route.result_key === "uncommitted_changes");
    expect(added).toEqual([
      { id: "r_merge_uncommitted", result_key: "uncommitted_changes", target: "todo", position: 3 },
      { id: "r_mine", result_key: "remote_diverged", target: "user_attention", position: 3 },
    ]);
  });

  it("changes nothing when run against a database that already has both", () => {
    upgradeFrom();
    upgrade();
    const all = () => handle.db.all(sql`SELECT * FROM step_routes ORDER BY id`);
    const before = all();

    // The migration's own statements, a second time: the journal would
    // never do this, which is exactly why the guard is tested without it.
    const statements = readFileSync(join(MIGRATIONS, "0114_pull_request_return_routes.sql"), "utf8").split("--> statement-breakpoint");
    expect(statements).toHaveLength(2);
    for (const statement of statements) handle.db.run(sql.raw(statement));

    expect(all()).toEqual(before);
  });

  it("adds neither when the implementer's step is not there to send them to", () => {
    upgradeFrom();
    handle.db.run(sql`DELETE FROM step_routes WHERE target = 'todo' OR from_step_id = 'todo'`);
    handle.db.run(sql`UPDATE pipelines SET entry_step_id = NULL WHERE entry_step_id = 'todo'`);
    handle.db.run(sql`DELETE FROM pipeline_steps WHERE id = 'todo'`);

    upgrade();

    expect(routesOutOfMergeRequest().map((route) => route.result_key)).toEqual(["opened", "skipped", "failed"]);
  });

  it("adds neither when the pull request step is gone, or retired", () => {
    upgradeFrom();
    handle.db.run(sql`UPDATE pipeline_steps SET retired_version = 1 WHERE id = 'merge_request'`);
    const before = routesOutOfMergeRequest();

    upgrade();

    expect(routesOutOfMergeRequest()).toEqual(before);
  });
});

/**
 * The shipped pipeline watches the pull request it opened (EO-461) — on
 * the upgrade path, against both shapes the guard tells apart: a
 * Delivery whose Merge Request still hands a pull request to Done, and
 * one whose owner sent it somewhere of their own.
 */
describe("0123: the pull request is watched after Merge Request opens it", () => {
  let handle: DbHandle;
  let tempDir: string;

  const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "migrations");

  function upgradeFrom(): void {
    handle = openDb(":memory:");
    tempDir = mkdtempSync(join(tmpdir(), "eo-pull-request-watch-"));
    writeMigrationSetBefore(tempDir, "0123_pull_request_watch_step");
    runMigrations(handle.db, tempDir);
  }

  function upgrade(): void {
    runMigrations(handle.db, MIGRATIONS);
  }

  const graph = () => ({
    steps: handle.db.all(sql`SELECT * FROM pipeline_steps ORDER BY id`),
    routes: handle.db.all(sql`SELECT * FROM step_routes ORDER BY id`),
  });

  function routesFrom(stepId: string): { id: string; result_key: string; label: string; tone: string; target: string; position: number }[] {
    return handle.db.all(sql`SELECT id, result_key, label, tone, target, position FROM step_routes WHERE from_step_id = ${stepId} ORDER BY position, id`);
  }

  afterEach(() => {
    handle.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("puts a step that keeps checking after Merge Request, and sends Merge Request's success through it", () => {
    upgradeFrom();
    const positions = () => handle.db.all<{ id: string; position: number }>(sql`SELECT id, position FROM pipeline_steps WHERE pipeline_id = 'default' AND off_board = 0 ORDER BY position`);
    expect(positions().map((step) => step.id)).toEqual(["worktree", "repository_index", "todo", "review", "merge_request", "ready_to_merge"]);

    upgrade();

    expect(positions()).toEqual([
      { id: "worktree", position: 0 },
      { id: "repository_index", position: 1 },
      { id: "todo", position: 2 },
      { id: "review", position: 3 },
      { id: "merge_request", position: 4 },
      { id: "pull_request_watch", position: 5 },
      { id: "ready_to_merge", position: 6 },
    ]);
    expect(
      handle.db.get(sql`SELECT pipeline_id, name, type, owner_role, entry_action, is_terminal, watch_every_minutes, watch_give_up_hours, retired_version FROM pipeline_steps WHERE id = 'pull_request_watch'`),
    ).toEqual({
      pipeline_id: "default",
      name: "Watching pull request",
      type: "builtin",
      owner_role: null,
      entry_action: "watch_pull_request",
      is_terminal: 0,
      watch_every_minutes: 5,
      watch_give_up_hours: 168,
      retired_version: null,
    });
    expect(routesFrom("pull_request_watch").map((route) => [route.result_key, route.target])).toEqual([
      ["merged", "ready_to_merge"],
      ["checks_failed", "todo"],
      ["changes_requested", "todo"],
      ["conflict", "todo"],
      ["closed", "user_attention"],
      ["ready", "user_attention"],
      ["failed", "user_attention"],
    ]);
    expect(routesFrom("merge_request").find((route) => route.result_key === "opened")?.target).toBe("pull_request_watch");
    // A pull request nobody opened still goes straight to Done: there is
    // nothing to watch.
    expect(routesFrom("merge_request").find((route) => route.result_key === "skipped")?.target).toBe("ready_to_merge");
  });

  it("leaves a pipeline whose Merge Request routes its success elsewhere exactly as it was", () => {
    upgradeFrom();
    // EO's own Delivery: an opened pull request is handed to a pipeline
    // that merges it.
    handle.db.run(sql`INSERT INTO pipelines (id, name, created_at, updated_at) VALUES ('merge', 'Merge', 1, 1)`);
    handle.db.run(
      sql`INSERT INTO pipeline_steps (id, pipeline_id, position, name, type, owner_role, entry_action, is_terminal, off_board)
          VALUES ('merge-it', 'merge', 0, 'Merge it', 'module', NULL, NULL, 0, 0)`,
    );
    handle.db.run(sql`UPDATE step_routes SET target = 'merge-it' WHERE from_step_id = 'merge_request' AND result_key = 'opened'`);
    const before = graph();

    upgrade();

    expect(graph()).toEqual({ ...before, steps: afterNeverGivingUp(withoutThreadSteps(before.steps)) });
  });

  it("changes nothing when Merge Request, Done or To Do is retired", () => {
    for (const retired of ["merge_request", "ready_to_merge", "todo"]) {
      upgradeFrom();
      handle.db.run(sql`UPDATE pipeline_steps SET retired_version = 1 WHERE id = ${retired}`);
      const before = graph();

      upgrade();

      expect(graph(), retired).toEqual({ ...before, steps: afterNeverGivingUp(withoutThreadSteps(before.steps)) });
      handle.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
    // For `afterEach`, which closes one more.
    upgradeFrom();
  });

  it("changes nothing when run against a database that already has the watch", () => {
    upgradeFrom();
    upgrade();
    const before = graph();

    // The migration's own statements, a second time: the journal would
    // never do this, which is exactly why the guard is tested without it.
    const statements = readFileSync(join(MIGRATIONS, "0123_pull_request_watch_step.sql"), "utf8").split("--> statement-breakpoint");
    expect(statements).toHaveLength(4);
    for (const statement of statements) handle.db.run(sql.raw(statement));

    expect(graph()).toEqual(before);
  });

  /**
   * 0123 writes the live rows and files no version (EO-514). An item on
   * the current version reads the live rows, so it is routed through the
   * watch from the moment the migration lands — and the person's next
   * publish is what would make it read the version's stale document,
   * which has no "Watching pull request" and no route for `merged`.
   */
  it("keeps an item standing on the watch routed by it across the person's next publish", () => {
    upgradeFrom();
    // A version filed before 0123, as every installation that had saved
    // or filed an item has one. Filed by today's repository, which reads
    // a column 0141 adds (EO-571), so the column is there for the filing
    // and gone again before the upgrade adds it — the build that filed
    // it had never heard of it.
    handle.db.run(sql`ALTER TABLE pipeline_steps ADD watch_never_gives_up integer DEFAULT 0 NOT NULL`);
    // And the same for the two 0155 adds (EO-610).
    handle.db.run(sql`ALTER TABLE pipelines ADD entry_rules text DEFAULT '[]' NOT NULL`);
    handle.db.run(sql`ALTER TABLE pipeline_versions ADD entry_rules text DEFAULT '[]' NOT NULL`);
    // And the one 0166 adds (EO-728).
    handle.db.run(sql`ALTER TABLE pipeline_versions ADD release_notes text`);
    const before = ensureCurrentVersion(handle.db, "default")!;
    handle.db.run(sql`ALTER TABLE pipeline_steps DROP COLUMN watch_never_gives_up`);
    handle.db.run(sql`ALTER TABLE pipelines DROP COLUMN entry_rules`);
    handle.db.run(sql`ALTER TABLE pipeline_versions DROP COLUMN entry_rules`);
    handle.db.run(sql`ALTER TABLE pipeline_versions DROP COLUMN release_notes`);
    upgrade();

    const watching = createTestItem(handle.db, { type: "story", title: "Its pull request is open", stepId: "pull_request_watch" });
    const opening = createTestItem(handle.db, { type: "story", title: "About to open one", stepId: "merge_request" });
    expect(getItem(handle.db, watching.id)?.pipelineVersionId).toBe(before.id);

    // The publish: Done renamed, nothing else.
    const steps = listStepsForPipeline(handle.db, "default").map((step) => (step.id === "ready_to_merge" ? { ...step, name: "Shipped" } : step));
    const routes = listRoutesForPipeline(handle.db, "default");
    expect(replacePipelineGraph(handle.db, "default", steps, routes)).toMatchObject({ replaced: true });

    // A version of the graph the items were standing in was written, and
    // they are bound to it rather than to the stale one.
    const versions = listPipelineVersions(handle.db, "default");
    expect(versions.map((version) => version.number)).toEqual([before.number, before.number + 1, before.number + 2]);
    const caughtUp = versions[1]!;
    for (const item of [watching, opening]) expect(getItem(handle.db, item.id)?.pipelineVersionId).toBe(caughtUp.id);
    expect(versionGraph(handle.db, before.id)?.steps.some((step) => step.id === "pull_request_watch")).toBe(false);

    const routeOut = (itemId: Uuid, stepId: string, resultKey: string) =>
      graphForItem(handle.db, getItem(handle.db, itemId)!).routes.find((route) => route.fromStepId === stepId && route.resultKey === resultKey)?.target;
    expect(routeOut(watching.id, "pull_request_watch", "merged")).toBe("ready_to_merge");
    expect(routeOut(watching.id, "pull_request_watch", "checks_failed")).toBe("todo");
    expect(routeOut(opening.id, "merge_request", "opened")).toBe("pull_request_watch");
    // And it finishes on that version: Done is still "Done" to it.
    expect(stepForItem(handle.db, { ...getItem(handle.db, watching.id)!, stepId: "ready_to_merge" })?.name).toBe("Done");
  });
});

describe("0118: skills gain a scope, and every existing one is global", () => {
  let handle: DbHandle;
  let tempDir: string;

  afterEach(() => {
    handle.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("makes every skill that existed before it global, and changes nothing else about it", () => {
    handle = openDb(":memory:");
    tempDir = mkdtempSync(join(tmpdir(), "eo-skill-scopes-"));
    writeMigrationSetBefore(tempDir, "0118_skill_scopes");
    runMigrations(handle.db, tempDir);
    handle.db.run(
      sql`INSERT INTO skills (id, slug, name, description, body, files, disable_model_invocation, enabled, created_at, updated_at, archived_at)
          VALUES ('s-1', 'pr-review', 'PR review', 'How we review.', 'Read the diff.', '[]', 0, 1, 1, 1, NULL),
                 ('s-2', 'e2e', 'E2E', 'How to run the e2e suite.', 'Use xvfb.', '[]', 0, 0, 2, 2, 3)`,
    );

    runMigrations(handle.db, join(dirname(fileURLToPath(import.meta.url)), "migrations"));

    expect(handle.db.all(sql`SELECT id, slug, enabled, archived_at, scope, scope_id FROM skills ORDER BY id`)).toEqual([
      { id: "s-1", slug: "pr-review", enabled: 1, archived_at: null, scope: "global", scope_id: null },
      { id: "s-2", slug: "e2e", enabled: 0, archived_at: 3, scope: "global", scope_id: null },
    ]);
  });
});

describe("0119: a thread for each project", () => {
  let handle: DbHandle;
  let tempDir: string;

  afterEach(() => {
    handle.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("adds the project thread's off-board step and holds each project to one, disturbing no step already there", () => {
    handle = openDb(":memory:");
    tempDir = mkdtempSync(join(tmpdir(), "eo-project-threads-"));
    writeMigrationSetBefore(tempDir, "0119_project_threads");
    runMigrations(handle.db, tempDir);
    const before = handle.db.all(sql`SELECT id, pipeline_id, position, off_board, is_terminal FROM pipeline_steps ORDER BY id`);

    // As far as the release before 0168, which retired the project
    // threads again (EO-730).
    runMigrationsBeforeTheThreadsRetired(handle.db);

    expect(
      handle.db.get(
        sql`SELECT pipeline_id, type, owner_role, entry_action, is_terminal, off_board
            FROM pipeline_steps WHERE id = 'project-thread'`,
      ),
    ).toEqual({ pipeline_id: "discussions", type: "user", owner_role: null, entry_action: null, is_terminal: 0, off_board: 1 });
    // Bar 0123, run on the way past: the pull request watch (EO-461), and
    // Done one position along to make room for it.
    expect(
      handle.db.all(sql`SELECT id, pipeline_id, position, off_board, is_terminal FROM pipeline_steps WHERE id NOT IN ('project-thread', 'pull_request_watch') ORDER BY id`),
    ).toEqual(afterThePullRequestWatch(before));

    const featureType = handle.db.get<{ id: string }>(sql`SELECT id FROM item_types WHERE slug = 'feature' LIMIT 1`)!.id;
    handle.db.run(sql`INSERT INTO projects (id, name, key_prefix, created_at, updated_at) VALUES ('p-1', 'Shop', 'SHOP', 1, 1)`);
    const thread = (id: string, key: string) =>
      sql`INSERT INTO items (id, key, type_id, title, project_id, step_id, priority, created_at, updated_at)
          VALUES (${id}, ${key}, ${featureType}, 'Project notes', 'p-1', 'project-thread', 0, 1, 1)`;
    handle.db.run(thread("t-1", "NOTE-1"));
    // Drizzle wraps the driver's error; the constraint is named in its cause.
    const refusal = (() => {
      try {
        handle.db.run(thread("t-2", "NOTE-2"));
        return "inserted";
      } catch (error) {
        return String((error as { cause?: unknown }).cause ?? error);
      }
    })();
    expect(refusal).toMatch(/UNIQUE constraint failed: items\.project_id/);
  });
});

describe("0120: agents gain a project, and every existing one is global", () => {
  let handle: DbHandle;
  let tempDir: string;

  afterEach(() => {
    handle.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("leaves every agent that existed before it global, and holds a scope to a project that exists", () => {
    handle = openDb(":memory:");
    tempDir = mkdtempSync(join(tmpdir(), "eo-agent-projects-"));
    writeMigrationSetBefore(tempDir, "0120_agent_projects");
    runMigrations(handle.db, tempDir);
    handle.db.run(
      sql`INSERT INTO agents (id, name, role, provider, model, instructions, config, enabled)
          VALUES ('a-custom', 'Writer', 'writer', 'fake', NULL, 'Write.', '{}', 1)`,
    );
    const before = agentRowsOn(handle);

    runMigrations(handle.db, join(dirname(fileURLToPath(import.meta.url)), "migrations"));

    const agents = listAgents(handle.db);
    expect(agents.length).toBe(before.length);
    expect(agents.every((agent) => agent.projectId === null)).toBe(true);
    expect(agentRowsOn(handle)).toEqual(afterTheRepositoryCheckoutGrant(before));

    // A real foreign key: a scope naming no project is refused by the
    // database, not merely by the save command.
    const refusal = (() => {
      try {
        handle.db.run(sql`UPDATE agents SET project_id = 'no-such-project' WHERE id = 'a-custom'`);
        return "updated";
      } catch (error) {
        return String((error as { cause?: unknown }).cause ?? error);
      }
    })();
    expect(refusal).toMatch(/FOREIGN KEY constraint failed/);
  });
});

describe("0121: agents gain the stamp a replica pages them on", () => {
  let handle: DbHandle;
  let tempDir: string;

  afterEach(() => {
    handle.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("stamps every agent that existed before it as older than any cursor, and changes nothing else", () => {
    handle = openDb(":memory:");
    tempDir = mkdtempSync(join(tmpdir(), "eo-agent-updated-at-"));
    writeMigrationSetBefore(tempDir, "0121_agent_updated_at");
    runMigrations(handle.db, tempDir);
    handle.db.run(
      sql`INSERT INTO agents (id, name, role, provider, model, instructions, config, enabled)
          VALUES ('a-custom', 'Writer', 'writer', 'fake', NULL, 'Write.', '{}', 1)`,
    );
    const before = agentRowsOn(handle);

    runMigrations(handle.db, join(dirname(fileURLToPath(import.meta.url)), "migrations"));

    expect(agentRowsOn(handle)).toEqual(afterTheRepositoryCheckoutGrant(before));
    const stamps = handle.db.all<{ updatedAt: number }>(sql`SELECT updated_at AS updatedAt FROM agents`);
    expect(stamps.length).toBe(before.length);
    expect(stamps.every((row) => row.updatedAt === 0)).toBe(true);
  });
});

describe("0122: agents gain a revision, and the record's revision of the copy a replica holds", () => {
  let handle: DbHandle;
  let tempDir: string;

  afterEach(() => {
    handle.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("starts every agent that existed before it at revision zero, unstamped, so any copy from the record may write over it", () => {
    handle = openDb(":memory:");
    tempDir = mkdtempSync(join(tmpdir(), "eo-agent-record-stamp-"));
    writeMigrationSetBefore(tempDir, "0122_agent_record_stamp");
    runMigrations(handle.db, tempDir);
    handle.db.run(
      sql`INSERT INTO agents (id, name, role, provider, model, instructions, config, enabled)
          VALUES ('a-custom', 'Writer', 'writer', 'fake', NULL, 'Write.', '{}', 1)`,
    );
    const before = agentRowsOn(handle);

    runMigrations(handle.db, join(dirname(fileURLToPath(import.meta.url)), "migrations"));

    expect(agentRowsOn(handle)).toEqual(afterTheRepositoryCheckoutGrant(before));
    const stamps = handle.db.all<{ recordStamp: number | null; revision: number }>(sql`SELECT record_stamp AS recordStamp, revision FROM agents`);
    expect(stamps.length).toBe(before.length);
    expect(stamps.every((row) => row.recordStamp === null && row.revision === 0)).toBe(true);
  });
});

describe("0126: the memory_note grant, and entries marked as extracted", () => {
  let handle: DbHandle;
  let tempDir: string;

  afterEach(() => {
    handle.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  const allowedOf = (id: string): unknown =>
    (JSON.parse(handle.db.get<{ config: string }>(sql`SELECT config FROM agents WHERE id = ${id}`)!.config) as { allowedTools?: unknown }).allowedTools;

  it("grants the shipped implementer, reviewer and system agent memory_note, once, and no other role", () => {
    handle = openDb(":memory:");
    tempDir = mkdtempSync(join(tmpdir(), "eo-memory-note-"));
    writeMigrationSetBefore(tempDir, "0126_memory_note");
    runMigrations(handle.db, tempDir);
    handle.db.run(
      sql`INSERT INTO agents (id, name, role, provider, model, instructions, config, enabled)
          VALUES ('a-custom', 'Writer', 'writer', 'fake', NULL, 'Write.', '{"allowedTools":["Read"]}', 1)`,
    );
    // Somebody named it by hand before upgrading, in the bare spelling.
    handle.db.run(
      sql`INSERT INTO agents (id, name, role, provider, model, instructions, config, enabled)
          VALUES ('a-reviewer-2', 'Second reviewer', 'reviewer', 'fake', NULL, 'Review.', '{"allowedTools":["memory_note"]}', 1)`,
    );
    const shipped = handle.db.all<{ id: string; role: string }>(sql`SELECT id, role FROM agents WHERE role IN ('implementer', 'reviewer', 'system') AND id != 'a-reviewer-2'`);
    expect(shipped.map((agent) => agent.role).sort()).toEqual(["implementer", "reviewer", "system"]);

    // Up to 0148, which grants every other role (EO-593): what is held
    // here is 0126's own reach.
    const upTo0148 = mkdtempSync(join(tmpdir(), "eo-memory-note-0126-"));
    try {
      writeMigrationSetBefore(upTo0148, "0148_memory_note_every_role");
      runMigrations(handle.db, upTo0148);
    } finally {
      rmSync(upTo0148, { recursive: true, force: true });
    }

    for (const agent of shipped) {
      const allowed = allowedOf(agent.id) as string[];
      expect(allowed.filter((tool) => tool === "mcp__eo__memory_note"), agent.role).toHaveLength(1);
      expect(memoryNoteEnabled({ config: { allowedTools: allowed } }), agent.role).toBe(true);
    }
    // The two that had no list have the grant and nothing else: no other
    // capability EO keys on a grant comes with it.
    const implementer = shipped.find((agent) => agent.role === "implementer")!;
    expect(allowedOf(implementer.id)).toEqual(["mcp__eo__memory_note"]);
    const config = { allowedTools: allowedOf(implementer.id) };
    expect(fullThreadEnabled({ config })).toBe(false);
    expect(configToolsEnabled({ config })).toBe(false);
    expect(adminToolsEnabled({ config })).toBe(false);
    // Not a shipped role, so not granted; already named, so not named twice.
    expect(allowedOf("a-custom")).toEqual(["Read"]);
    expect(allowedOf("a-reviewer-2")).toEqual(["memory_note"]);

    // Idempotent.
    const settled = handle.db.all(sql`SELECT id, config FROM agents ORDER BY id`);
    const again = mkdtempSync(join(tmpdir(), "eo-memory-note-0126-"));
    try {
      writeMigrationSetBefore(again, "0148_memory_note_every_role");
      runMigrations(handle.db, again);
    } finally {
      rmSync(again, { recursive: true, force: true });
    }
    expect(handle.db.all(sql`SELECT id, config FROM agents ORDER BY id`)).toEqual(settled);
  });

  it("marks every entry written before it as not extracted", () => {
    handle = openDb(":memory:");
    tempDir = mkdtempSync(join(tmpdir(), "eo-memory-extracted-"));
    writeMigrationSetBefore(tempDir, "0126_memory_note");
    runMigrations(handle.db, tempDir);
    // `scope_id` carries no foreign key, so the entry needs no project row.
    handle.db.run(
      sql`INSERT INTO memories (id, scope_kind, scope_id, body, source_kind, created_at, updated_at) VALUES ('m-1', 'project', 'p-1', 'Settlements are in UTC.', 'person', 0, 0)`,
    );

    runMigrations(handle.db, join(dirname(fileURLToPath(import.meta.url)), "migrations"));

    expect(handle.db.get<{ extracted: number }>(sql`SELECT extracted FROM memories WHERE id = 'm-1'`)).toEqual({ extracted: 0 });
  });
});

describe("0148: memory_note for every role (EO-593)", () => {
  let handle: DbHandle;
  let tempDir: string;

  afterEach(() => {
    handle.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  const allowedOf = (id: string): unknown =>
    (JSON.parse(handle.db.get<{ config: string }>(sql`SELECT config FROM agents WHERE id = ${id}`)!.config) as { allowedTools?: unknown }).allowedTools;
  const insert = (id: string, role: string, config: string, deletedAt: number | null = null) =>
    handle.db.run(
      sql`INSERT INTO agents (id, name, role, provider, model, instructions, config, enabled, deleted_at)
          VALUES (${id}, ${id}, ${role}, 'fake', NULL, 'Work.', ${config}, 1, ${deletedAt})`,
    );

  it("grants every agent of another role memory_note, once, and leaves a grant a person took from the three 0126 granted taken", () => {
    handle = openDb(":memory:");
    tempDir = mkdtempSync(join(tmpdir(), "eo-memory-note-every-role-"));
    writeMigrationSetBefore(tempDir, "0148_memory_note_every_role");
    runMigrations(handle.db, tempDir);
    insert("a-writer", "writer", "{}");
    insert("a-editor", "editor", '{"allowedTools":["Read"],"effort":"high"}');
    insert("a-named", "translator", '{"allowedTools":["memory_note"]}');
    insert("a-odd", "translator", '{"allowedTools":"everything"}');
    insert("a-preview", "writer", '{"eoPreviewAgent":true}');
    insert("a-gone", "writer", "{}", 1);
    // A reviewer somebody took the grant from after 0126 gave it.
    insert("a-reviewer-2", "reviewer", '{"allowedTools":["Read"]}');

    runMigrations(handle.db, join(dirname(fileURLToPath(import.meta.url)), "migrations"));

    expect(allowedOf("a-writer")).toEqual(["mcp__eo__memory_note"]);
    expect(allowedOf("a-editor")).toEqual(["Read", "mcp__eo__memory_note"]);
    expect(allowedOf("a-named")).toEqual(["memory_note"]);
    expect(allowedOf("a-odd")).toBe("everything");
    expect(allowedOf("a-preview")).toBeUndefined();
    expect(allowedOf("a-gone")).toBeUndefined();
    expect(allowedOf("a-reviewer-2")).toEqual(["Read"]);
    // The rest of a config is left as it was.
    expect(JSON.parse(handle.db.get<{ config: string }>(sql`SELECT config FROM agents WHERE id = 'a-editor'`)!.config)).toMatchObject({ effort: "high" });
    // The grant and nothing else: no other capability EO keys on one comes with it.
    const config = { allowedTools: allowedOf("a-writer") };
    expect(memoryNoteEnabled({ config })).toBe(true);
    expect(fullThreadEnabled({ config })).toBe(false);
    expect(configToolsEnabled({ config })).toBe(false);
    expect(adminToolsEnabled({ config })).toBe(false);
    // Every seeded agent, of whatever role, holds it.
    for (const row of agentRowsOn(handle).filter((agent) => !agent.id.startsWith("a-"))) {
      expect(memoryNoteEnabled(row), row.role).toBe(true);
    }
  });
});

describe("0131: a side call's cost to the micro-cent (EO-510)", () => {
  it("carries a call recorded in whole cents over as that many cents", () => {
    const handle = openDb(":memory:");
    const tempDir = mkdtempSync(join(tmpdir(), "eo-side-call-microcents-"));
    try {
      writeMigrationSetBefore(tempDir, "0131_side_call_microcents");
      runMigrations(handle.db, tempDir);
      handle.db.run(
        sql`INSERT INTO side_calls (id, purpose, backend, tokens_in, tokens_out, cost_cents, started_at, duration_ms, outcome) VALUES ('s-1', 'memory_select', 'claude', 3401, 352, 3, 1, 400, 'succeeded')`,
      );

      runMigrations(handle.db, join(dirname(fileURLToPath(import.meta.url)), "migrations"));

      expect(handle.db.get<{ cost_microcents: number }>(sql`SELECT cost_microcents FROM side_calls WHERE id = 's-1'`)).toEqual({ cost_microcents: 3_000_000 });
      const columns = handle.db.all<{ name: string }>(sql`pragma table_info(side_calls)`).map((column) => column.name);
      expect(columns).not.toContain("cost_cents");
    } finally {
      handle.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("0154: follow-ups are gone", () => {
  // From a database at 0153, and from one at 0151, the last a release shipped.
  it.each(["0154_drop_follow_ups", "0152_follow_up_chat"])("closes their questions and buttons, keeps what they said, leaves other questions alone, and drops the tables, stopping before %s", (stopBefore) => {
    const handle = openDb(":memory:");
    const tempDir = mkdtempSync(join(tmpdir(), "eo-drop-follow-ups-"));
    try {
      writeMigrationSetBefore(tempDir, stopBefore);
      runMigrations(handle.db, tempDir);
      // Filed by today's repository, which reads columns 0155 adds (EO-610), and the one 0166 adds (EO-728).
      handle.db.run(sql`ALTER TABLE pipelines ADD entry_rules text DEFAULT '[]' NOT NULL`);
      handle.db.run(sql`ALTER TABLE pipeline_versions ADD entry_rules text DEFAULT '[]' NOT NULL`);
      handle.db.run(sql`ALTER TABLE pipeline_versions ADD release_notes text`);
      // …and the column 0167 adds to item types (EO-735).
      handle.db.run(sql`ALTER TABLE item_types ADD updated_at integer`);
      const finished = createTestItem(handle.db, { type: "story", title: "A finished story", stepId: "todo" });
      const waiting = createTestItem(handle.db, { type: "story", title: "A story with a question", stepId: "todo" });
      handle.db.run(sql`ALTER TABLE pipelines DROP COLUMN entry_rules`);
      handle.db.run(sql`ALTER TABLE pipeline_versions DROP COLUMN entry_rules`);
      handle.db.run(sql`ALTER TABLE pipeline_versions DROP COLUMN release_notes`);
      handle.db.run(sql`ALTER TABLE item_types DROP COLUMN updated_at`);
      const ask = (itemId: string, body: string, options: string[]) => postComment(handle.db, { itemId: itemId as Uuid, author: { type: "engine" }, kind: "question", body, options, mentions: [{ type: "human" }], parseBodyMentions: false });
      const filed = ask(finished.id, "**A follow-up to file: One**\n\nWhy.", ["File it", "Discard"]);
      const writeUp = ask(finished.id, "**A follow-up to write up: Two**\n\nWhy.", ["Discard"]);
      const shared = ask(finished.id, "**Follow-ups to write up**\n\n**Three**\n\nWhy.", ["Discard"]);
      const other = ask(waiting.id, "Which colour?", ["Red", "Discard"]);
      handle.db.run(sql`INSERT INTO comments (id, item_id, author_type, kind, body, options, created_at) SELECT 'brief', item_id, 'engine', 'note', 'A brief.', '[{"kind":"open","label":"Write it up","opens":{"type":"followUpChat","followUpId":"f1"}}]', created_at FROM comments WHERE id = ${filed.id}`);
      handle.db.run(sql`INSERT INTO follow_up_proposals (id, item_id, title, title_key, reason, status, comment_id, created_at) VALUES ('f1', ${finished.id}, 'One', 'one', 'Why.', 'open', ${filed.id}, 1)`);
      expect(needsAttention(handle.db, finished.id as Uuid)).toBe(true);

      runMigrations(handle.db, join(dirname(fileURLToPath(import.meta.url)), "migrations"));

      for (const followUp of [filed, writeUp, shared]) {
        expect(getComment(handle.db, followUp.id)).toMatchObject({ body: followUp.body, options: null });
      }
      expect(getComment(handle.db, "brief" as Uuid)?.options).toBeNull();
      expect(needsAttention(handle.db, finished.id as Uuid)).toBe(false);
      expect(getComment(handle.db, other.id)?.options).toEqual(["Red", "Discard"]);
      expect(needsAttention(handle.db, waiting.id as Uuid)).toBe(true);
      expect(handle.db.all(sql`SELECT name FROM sqlite_master WHERE name LIKE 'follow_up%' OR name LIKE 'idx_follow_up%'`)).toEqual([]);
    } finally {
      handle.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("0132: the project a scoped skill belongs to (EO-513)", () => {
  it("is the scope for a project's skill, the workspace's project for a workspace's, and nothing for a global one", () => {
    const handle = openDb(":memory:");
    const tempDir = mkdtempSync(join(tmpdir(), "eo-skill-project-"));
    try {
      writeMigrationSetBefore(tempDir, "0132_skill_project");
      runMigrations(handle.db, tempDir);
      handle.db.run(sql`INSERT INTO projects (id, name, key_prefix, created_at, updated_at) VALUES ('proj1', 'The project', 'ACME', 1, 1)`);
      handle.db.run(sql`INSERT INTO workspaces (id, project_id, kind, config, created_at, updated_at) VALUES ('ws1', 'proj1', 'folder', '{}', 1, 1)`);
      handle.db.run(sql`INSERT INTO workspaces (id, project_id, kind, config, created_at, updated_at) VALUES ('ws2', NULL, 'folder', '{}', 1, 1)`);
      for (const [id, scope, scopeId] of [
        ["s-global", "global", null],
        ["s-project", "project", "proj1"],
        ["s-workspace", "workspace", "ws1"],
        ["s-loose", "workspace", "ws2"],
      ] as const) {
        handle.db.run(
          sql`INSERT INTO skills (id, slug, name, description, body, scope, scope_id, created_at, updated_at) VALUES (${id}, ${id}, ${id}, 'd', 'b', ${scope}, ${scopeId}, 1, 1)`,
        );
      }

      runMigrations(handle.db, join(dirname(fileURLToPath(import.meta.url)), "migrations"));

      const rows = handle.db.all<{ id: string; project_id: string | null; local_changed_at: number }>(sql`SELECT id, project_id, local_changed_at FROM skills ORDER BY id`);
      // …and the stamp the record's feed pages on starts as the row's own version.
      expect(rows).toEqual([
        { id: "s-global", project_id: null, local_changed_at: 1 },
        { id: "s-loose", project_id: null, local_changed_at: 1 },
        { id: "s-project", project_id: "proj1", local_changed_at: 1 },
        { id: "s-workspace", project_id: "proj1", local_changed_at: 1 },
      ]);
    } finally {
      handle.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("0155: entry rules", () => {
  it("gives every pipeline and every version that exists an empty list", () => {
    const handle = openDb(":memory:");
    const tempDir = mkdtempSync(join(tmpdir(), "eo-entry-rules-"));
    try {
      writeMigrationSetBefore(tempDir, "0155_entry_rules");
      runMigrations(handle.db, tempDir);
      handle.db.run(sql`INSERT INTO pipeline_versions (id, pipeline_id, number, steps, routes, entry_step_id, created_at) VALUES ('v1', 'default', 1, '[]', '[]', NULL, 1)`);
      handle.db.run(sql`INSERT INTO pipelines (id, name, created_at, updated_at) VALUES ('another', 'Another', 1, 1)`);

      runMigrations(handle.db, join(dirname(fileURLToPath(import.meta.url)), "migrations"));

      expect(handle.db.all(sql`SELECT DISTINCT entry_rules FROM pipelines`)).toEqual([{ entry_rules: "[]" }]);
      expect(handle.db.all(sql`SELECT entry_rules FROM pipeline_versions WHERE id = 'v1'`)).toEqual([{ entry_rules: "[]" }]);
      expect(getPipeline(handle.db, "another")?.entryRules).toEqual([]);
      expect(versionSnapshot(handle.db, "v1")?.entryRules).toEqual([]);
    } finally {
      handle.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("0158: an attachment owned by the item (EO-702)", () => {
  it("keeps every comment's file on its comment and lets a file belong to no comment", () => {
    const handle = openDb(":memory:");
    const tempDir = mkdtempSync(join(tmpdir(), "eo-item-attachments-"));
    try {
      writeMigrationSetBefore(tempDir, "0158_item_attachments");
      runMigrations(handle.db, tempDir);
      // Filed by today's repository, which reads the column 0166 adds (EO-728)
      // and the one 0167 adds to item types (EO-735).
      handle.db.run(sql`ALTER TABLE pipeline_versions ADD release_notes text`);
      handle.db.run(sql`ALTER TABLE item_types ADD updated_at integer`);
      const item = createTestItem(handle.db, { type: "story", title: "Has a file", stepId: "todo" });
      handle.db.run(sql`ALTER TABLE pipeline_versions DROP COLUMN release_notes`);
      handle.db.run(sql`ALTER TABLE item_types DROP COLUMN updated_at`);
      const comment = postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Here is the mock." });
      handle.db.run(
        sql`INSERT INTO attachments (id, item_id, comment_id, storage_path, name, mime_type, size, managed, created_at, jira_sync_error)
            VALUES ('a1', ${item.id}, ${comment.id}, '/files/a1.png', 'mock.png', 'image/png', 42, 0, 7, 'Jira said no')`,
      );
      handle.db.run(sql`INSERT INTO jira_attachment_links (attachment_id, jira_attachment_id) VALUES ('a1', 'remote-1')`);
      const before = handle.db.all(sql`SELECT * FROM attachments`);
      // Not yet: before 0158 a file has to hang on a comment.
      expect(() =>
        handle.db.run(sql`INSERT INTO attachments (id, item_id, comment_id, storage_path, name, mime_type, size, created_at) VALUES ('early', ${item.id}, NULL, '/x', 'x', 'text/plain', 1, 1)`),
      ).toThrow();

      runMigrations(handle.db, join(dirname(fileURLToPath(import.meta.url)), "migrations"));

      // Every row exactly as it was, its Jira link with it, and still on its comment.
      expect(handle.db.all(sql`SELECT * FROM attachments`)).toEqual(before);
      expect(handle.db.all(sql`SELECT * FROM jira_attachment_links`)).toEqual([{ attachment_id: "a1", jira_attachment_id: "remote-1" }]);
      expect(listCommentsForItem(handle.db, item.id)[0]?.attachments?.map((file) => file.id)).toEqual(["a1"]);
      expect(handle.db.all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'attachments' AND name NOT LIKE 'sqlite_%' ORDER BY name`).map((row) => row.name)).toEqual([
        "idx_attachments_comment",
        "idx_attachments_item",
      ]);

      // And a file may now belong to the item itself.
      handle.db.run(sql`INSERT INTO attachments (id, item_id, comment_id, storage_path, name, mime_type, size, created_at) VALUES ('own', ${item.id}, NULL, '/x', 'spec.pdf', 'application/pdf', 1, 8)`);
      expect(handle.db.all(sql`SELECT comment_id FROM attachments WHERE id = 'own'`)).toEqual([{ comment_id: null }]);
      expect(handle.db.all(sql`SELECT count(*) AS n FROM attachment_removals`)).toEqual([{ n: 0 }]);
    } finally {
      handle.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("0160: skill ownership, history and lock (EO-714)", () => {
  it("makes every existing skill a person's and unlocked, and starts each history with what it says now", () => {
    const handle = openDb(":memory:");
    const tempDir = mkdtempSync(join(tmpdir(), "eo-skill-versions-"));
    try {
      writeMigrationSetBefore(tempDir, "0160_skill_versions");
      runMigrations(handle.db, tempDir);
      handle.db.run(
        sql`INSERT INTO skills (id, slug, name, description, body, files, created_at, updated_at, archived_at)
            VALUES ('s-new', 'fresh', 'Fresh', 'Never edited.', 'One.', '[]', 10, 10, NULL),
                   ('s-edited', 'edited', 'Edited', 'Edited once.', 'Two.', '[{"path":"a.md","content":"a"}]', 10, 20, NULL),
                   ('s-gone', 'gone', 'Gone', 'Archived.', 'Three.', '[]', 10, 30, 30)`,
      );

      runMigrations(handle.db, join(dirname(fileURLToPath(import.meta.url)), "migrations"));

      expect(handle.db.all(sql`SELECT id, created_by, locked FROM skills ORDER BY id`)).toEqual([
        { id: "s-edited", created_by: "person", locked: 0 },
        { id: "s-gone", created_by: "person", locked: 0 },
        { id: "s-new", created_by: "person", locked: 0 },
      ]);
      expect(
        handle.db.all(sql`SELECT skill_id, action, description, body, files, author_kind, author_id, restored_from, created_at FROM skill_versions ORDER BY skill_id`),
      ).toEqual([
        { skill_id: "s-edited", action: "edit", description: "Edited once.", body: "Two.", files: '[{"path":"a.md","content":"a"}]', author_kind: "person", author_id: null, restored_from: null, created_at: 20 },
        { skill_id: "s-gone", action: "archive", description: "Archived.", body: "Three.", files: "[]", author_kind: "person", author_id: null, restored_from: null, created_at: 30 },
        { skill_id: "s-new", action: "create", description: "Never edited.", body: "One.", files: "[]", author_kind: "person", author_id: null, restored_from: null, created_at: 10 },
      ]);
      // uuidv7-shaped ids, stamped with the moment of the write they record.
      const ids = handle.db.all<{ id: string }>(sql`SELECT id FROM skill_versions`).map((row) => row.id);
      for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    } finally {
      handle.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
