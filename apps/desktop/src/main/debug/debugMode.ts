import type { Db } from "../db/client.js";
import { getSetting, setSetting } from "../db/repos/settingsRepo.js";

/**
 * Whether debug mode is on (EO-392).
 *
 * Its own key rather than a field on the `settings:get` preference
 * object, for the reason `ASSIST_EXPIRY_DAYS_KEY` in `roles/assist.ts`
 * gives: that object is written whole by whichever screen is showing
 * part of it, so a screen showing Do Not Disturb would switch this off
 * on its way past.
 */
export const DEBUG_MODE_KEY = "engine.debugMode";

/**
 * Debug mode as it stands right now.
 *
 * Read where it is used — by the supervisor at each send, by the
 * handler that opens the window — rather than once at startup, so
 * turning it on applies to the next dispatch instead of the next launch.
 *
 * Off unless the stored value is exactly `true`. Anything else, a junk
 * row included, reads as off: this decides whether prompts are written
 * down, and the safe reading of something unreadable is "no".
 */
export function readDebugMode(db: Db): boolean {
  return getSetting<unknown>(db, DEBUG_MODE_KEY, false) === true;
}

/** Writes it, and answers with what is stored now. */
export function writeDebugMode(db: Db, enabled: boolean): boolean {
  setSetting(db, DEBUG_MODE_KEY, enabled);
  return readDebugMode(db);
}
