import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import type { Db } from "./client.js";

/**
 * Applies pending migrations inside a single transaction — if any statement
 * fails, drizzle rolls the whole batch back, so a broken migration never
 * leaves a half-migrated DB. Call this before anything else touches the DB.
 *
 * Foreign keys are off for the duration, which is SQLite's own documented
 * recipe for the twelve-step table rebuild (create new, copy, drop old,
 * rename). 0028 needs it: `items` is referenced by `runs`, `comments`,
 * `transitions`, `item_deps`, `attachments`, `comment_mentions` and
 * `outbox`, so dropping it mid-rebuild trips every one of them even though
 * the rename that follows makes them all valid again.
 *
 * `PRAGMA foreign_keys` is a no-op inside a transaction, so it has to be set
 * out here rather than in the migration file. `foreign_key_check` afterwards
 * is what keeps this honest: a migration that genuinely orphaned a row now
 * fails loudly instead of being waved through by the pragma that was meant
 * to let a rebuild finish.
 */
export function runMigrations(db: Db, migrationsFolder: string): void {
  db.run(sql`PRAGMA foreign_keys = OFF`);
  try {
    migrate(db, { migrationsFolder });
    const violations = db.all(sql`PRAGMA foreign_key_check`);
    if (violations.length > 0) {
      throw new Error(`migration left ${violations.length} dangling foreign key reference(s): ${JSON.stringify(violations.slice(0, 5))}`);
    }
  } finally {
    db.run(sql`PRAGMA foreign_keys = ON`);
  }
}

/**
 * Is this a database EO is creating, rather than one it is upgrading?
 *
 * Asked *before* `runMigrations`, because that is the only moment the
 * two are distinguishable: a millisecond later both hold the same
 * schema, and nothing in the file says which of them it was born as.
 *
 * The test is drizzle's own bookkeeping table. Its absence means no
 * migration has ever run here — a file `openDb` created seconds ago, on
 * an installation that has never been anything. Anything else, including
 * an installation somebody has used for a year without ever opening
 * Settings, has it.
 *
 * EO-211 is what wants to know. A default guard applied to an
 * installation that ran without one is news; the same default on a
 * database being born with it is not, and only this call can tell them
 * apart.
 */
export function isNewDatabase(db: Db): boolean {
  const row = db.get<{ count: number }>(
    sql`select count(*) as count from sqlite_master where type = 'table' and name = '__drizzle_migrations'`,
  );
  return (row?.count ?? 0) === 0;
}

export interface SchemaVersion {
  migrationsApplied: number;
  latestMigrationAt: number | null;
}

/** Reads the state drizzle's migrator itself recorded, after runMigrations(). */
export function getSchemaVersion(db: Db): SchemaVersion {
  const row = db.get<{ count: number; latest: number | null }>(
    sql`select count(*) as count, max(created_at) as latest from __drizzle_migrations`,
  );
  return {
    migrationsApplied: row?.count ?? 0,
    latestMigrationAt: row?.latest ?? null,
  };
}
