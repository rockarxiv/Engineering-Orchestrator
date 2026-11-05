import { eq } from "drizzle-orm";
import type { Db } from "../client.js";
import { appSettings } from "../schema.js";

/** Reads a preference, or `fallback` if it has never been set. */
export function getSetting<T>(db: Db, key: string, fallback: T): T {
  const row = db.select().from(appSettings).where(eq(appSettings.key, key)).get();
  return row ? (row.value as T) : fallback;
}

/**
 * Forgets a preference entirely.
 *
 * Distinct from setting it to null: the value column is NOT NULL, and a
 * sentinel like "" would be a value the readers all have to know about.
 */
export function clearSetting(db: Db, key: string): void {
  db.delete(appSettings).where(eq(appSettings.key, key)).run();
}

export function setSetting<T>(db: Db, key: string, value: T): void {
  db.insert(appSettings)
    .values({ key, value, updatedAt: Date.now() })
    .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: Date.now() } })
    .run();
}
