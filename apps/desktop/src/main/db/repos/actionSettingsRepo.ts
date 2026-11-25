import { and, asc, eq } from "drizzle-orm";
import { uuidv7 } from "@eo/core";
import type { Db } from "../client.js";
import { actionSettings } from "../schema.js";

/**
 * What people set on a role's actions (EO-911): whether a run of it is
 * followed by a learning review. What it means — a setting over what the
 * pack ships — is `actionLearningReviewed`'s in `packages/core`; this is
 * the record.
 */

export interface ActionSettingRow {
  role: string;
  action: string;
  learningReview: boolean;
}

export function listActionSettings(db: Db): ActionSettingRow[] {
  return db
    .select({ role: actionSettings.role, action: actionSettings.action, learningReview: actionSettings.learningReview })
    .from(actionSettings)
    .orderBy(asc(actionSettings.role), asc(actionSettings.action))
    .all();
}

/** The setting on the pair, or undefined where nobody set one. */
export function getActionLearningReview(db: Db, role: string, action: string): boolean | undefined {
  return db
    .select({ learningReview: actionSettings.learningReview })
    .from(actionSettings)
    .where(and(eq(actionSettings.role, role), eq(actionSettings.action, action)))
    .get()?.learningReview;
}

/** Sets whether the pair's runs get a learning review: the one write. */
export function setActionLearningReview(db: Db, role: string, action: string, learningReview: boolean, now: number = Date.now()): void {
  db.insert(actionSettings)
    .values({ id: uuidv7(), role, action, learningReview, updatedAt: now })
    .onConflictDoUpdate({ target: [actionSettings.role, actionSettings.action], set: { learningReview, updatedAt: now } })
    .run();
}

/** Forgets the pair's setting, so it is as its pack ships it again. */
export function clearActionSetting(db: Db, role: string, action: string): void {
  db.delete(actionSettings).where(and(eq(actionSettings.role, role), eq(actionSettings.action, action))).run();
}
