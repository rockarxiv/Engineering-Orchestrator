import type { Db } from "./db/client.js";
import { clearSetting, getSetting, setSetting } from "./db/repos/index.js";

/** The user preference. Runtime-only drains deliberately never write this key. */
export const ENGINE_PAUSED_KEY = "engine.paused";

export function isEnginePausePreferred(db: Db): boolean {
  return getSetting(db, ENGINE_PAUSED_KEY, false);
}

export function persistEnginePause(db: Db): void {
  setSetting(db, ENGINE_PAUSED_KEY, true);
}

export function clearEnginePausePreference(db: Db): void {
  clearSetting(db, ENGINE_PAUSED_KEY);
}
