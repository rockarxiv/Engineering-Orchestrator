import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type DbHandle } from "./client.js";
import { getSchemaVersion, runMigrations } from "./migrate.js";
import { pipelineSteps } from "./schema.js";

const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), "migrations");

describe("db client", () => {
  let handle: DbHandle;

  beforeEach(() => {
    handle = openDb(":memory:");
  });

  afterEach(() => {
    handle.close();
  });

  it("applies migrations and reports a schema version", () => {
    runMigrations(handle.db, migrationsFolder);

    const version = getSchemaVersion(handle.db);
    expect(version.migrationsApplied).toBeGreaterThan(0);
    expect(version.latestMigrationAt).not.toBeNull();
  });

  it("writes and reads a row through the Db interface", () => {
    runMigrations(handle.db, migrationsFolder);

    handle.db.insert(pipelineSteps).values({ id: "test_state", pipelineId: "default", position: 99, name: "Test", isTerminal: false }).run();
    const rows = handle.db.select().from(pipelineSteps).where(eq(pipelineSteps.id, "test_state")).all();

    expect(rows).toEqual([
      {
        id: "test_state",
        pipelineId: "default",
        position: 99,
        name: "Test",
        type: "agent",
        ownerRole: null,
        entryAction: null,
        instructionsSummary: null,
        isTerminal: false,
        planMode: false,
        // A branch of its own, which is what every step did before there
        // was a choice about it (EO-296).
        workspaceMode: "isolated",
        // And the ticket's own workspace, which is likewise what every
        // step did before a step could pick one (EO-301).
        workspaceId: null,
        offBoard: false,
        // The column's own default: a step configures nothing until
        // somebody sets a value for one of its module's inputs (EO-78).
        inputs: {},
        // And nothing for how long it may run (EO-162): NULL is "EO's
        // default", which is what every step means until one is raised.
        timeoutMs: null,
        // And it runs once (EO-456): both keep-checking columns NULL is
        // what every step means until somebody sets it to keep checking.
        watchEveryMinutes: null,
        watchGiveUpHours: null,
        watchNeverGivesUp: false,
        // Nobody named on it (EO-302): a step that names neither a
        // person nor a group waits for whoever is there, which is what
        // every step did before either column existed.
        ownerPersonId: null,
        ownerGroupId: null,
        // And nothing for a person to decide (EO-310): a step declares
        // results only once somebody is standing there to press one.
        results: [],
        // Part of the current version, which is what a step is until a
        // save removes it (EO-327).
        retiredVersion: null,
        // And no module version pinned (EO-770): only a module step pins one.
        moduleVersion: null,
      },
    ]);
  });

  it("is a no-op on a second run against the same DB", () => {
    runMigrations(handle.db, migrationsFolder);
    const first = getSchemaVersion(handle.db);

    expect(() => runMigrations(handle.db, migrationsFolder)).not.toThrow();
    const second = getSchemaVersion(handle.db);

    expect(second).toEqual(first);
  });

  it("opens every connection with a working cache: 64 MB of pages, temp tables in memory, 256 MB mapped (EO-555)", () => {
    // A file, not `:memory:`: a database with no file has nothing to map,
    // and the pragma would read back as whatever SQLite does with that
    // rather than what the connection asked for.
    const dir = mkdtempSync(join(tmpdir(), "eo-db-client-"));
    const onDisk = openDb(join(dir, "eo.db"));
    try {
      expect(onDisk.db.get<{ cache_size: number }>(sql`PRAGMA cache_size`)?.cache_size).toBe(-65536);
      // 2 is MEMORY (0 DEFAULT, 1 FILE).
      expect(onDisk.db.get<{ temp_store: number }>(sql`PRAGMA temp_store`)?.temp_store).toBe(2);
      expect(onDisk.db.get<{ mmap_size: number }>(sql`PRAGMA mmap_size`)?.mmap_size).toBe(268435456);
      // And what was already set is still set.
      expect(onDisk.db.get<{ journal_mode: string }>(sql`PRAGMA journal_mode`)?.journal_mode).toBe("wal");
      expect(onDisk.db.get<{ timeout: number }>(sql`PRAGMA busy_timeout`)?.timeout).toBe(5000);
    } finally {
      onDisk.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
