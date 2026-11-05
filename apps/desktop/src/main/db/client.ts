// The only file in this codebase allowed to import better-sqlite3 (F-03
// acceptance criteria) — every other module talks to the DB through the
// `Db` type this file exports.
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";
import { FOLD_CASE_SQL_FUNCTION, foldCase } from "./textFold.js";

export type Db = BetterSQLite3Database<typeof schema>;

export interface DbHandle {
  db: Db;
  close: () => void;
}

/** The page cache each connection may grow to, in KiB: 64 MB (EO-555). Negative, as `cache_size` reads it. */
export const DB_CACHE_SIZE_KIB = -64 * 1024;
/** How much of the database file is memory-mapped, in bytes: 256 MB (EO-555). */
export const DB_MMAP_SIZE_BYTES = 256 * 1024 * 1024;

export function openDb(dbPath: string): DbHandle {
  const sqlite = new Database(dbPath);

  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("synchronous = NORMAL");
  // A working cache (EO-555). SQLite's default page cache is 2 MB, which
  // a database of hundreds of MB churns through on every read that
  // touches more than a few pages. `cache_size` is negative to mean KiB
  // rather than pages, so it holds whatever the page size is; it is a
  // ceiling, filled as pages are read, not memory taken up front. Mapping
  // the first 256 MB of the file lets reads come from the OS page cache
  // without a copy, and temporary b-trees (an ORDER BY no index answers)
  // stay in memory rather than going to a temp file.
  sqlite.pragma(`cache_size = ${DB_CACHE_SIZE_KIB}`);
  sqlite.pragma("temp_store = MEMORY");
  sqlite.pragma(`mmap_size = ${DB_MMAP_SIZE_BYTES}`);
  // Case-insensitive text matching that holds beyond ASCII (EO-539), for
  // the filters that run in a query. Deterministic, so SQLite may use it
  // anywhere an expression is allowed; anything not text answers null,
  // as `lower()` does.
  sqlite.function(FOLD_CASE_SQL_FUNCTION, { deterministic: true }, (value: unknown) => (typeof value === "string" ? foldCase(value) : null));

  const db = drizzle(sqlite, { schema });

  return {
    db,
    close: () => sqlite.close(),
  };
}
