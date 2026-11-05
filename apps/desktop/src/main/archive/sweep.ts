import { archivableItems, type ArchiveCandidate } from "@eo/engine";
import type { Db } from "../db/client.js";
import {
  getSetting,
  lastEntryIntoStates,
  listItems,
  finishedItemIds,
  listPipelineSteps,
  postComment,
  setSetting,
  setItemArchived,
} from "../db/repos/index.js";
import { isProjectThread } from "../projects/projectThread.js";

/** How long an item stays on the project after it is finished. Days. */
export const ARCHIVE_AFTER_DAYS_KEY = "project.archiveAfterDays";

/**
 * Two weeks. Long enough that a finished feature is still there on the
 * Monday after the Friday it shipped, short enough that a busy project
 * does not become a museum.
 */
export const DEFAULT_ARCHIVE_AFTER_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The configured delay, or `null` when archiving is off.
 *
 * `0` is a real value and means "as soon as it is done" — which is why
 * off has to be `null` rather than 0, and why this can never be written
 * as a falsy check.
 *
 * Wrapped in an object because `app_settings.value` is NOT NULL, so a
 * bare `null` cannot be stored at all. `{ days: null }` is a value that
 * says "off"; an absent row means "never configured", which is what
 * gives the default.
 */
export function archiveAfterDays(db: Db): number | null {
  return getSetting<{ days: number | null }>(db, ARCHIVE_AFTER_DAYS_KEY, { days: DEFAULT_ARCHIVE_AFTER_DAYS }).days;
}

export function setArchiveAfterDays(db: Db, days: number | null): void {
  setSetting(db, ARCHIVE_AFTER_DAYS_KEY, { days });
}

export interface SweepResult {
  archived: number;
  /** True when the setting is off, so a caller can say "nothing to do" rather than "nothing qualified". */
  disabled: boolean;
}

/**
 * Puts away everything that has been finished long enough (KAN-33).
 *
 * Reads the live project, asks `archivableItems` — which holds the rule
 * and no database — and writes what it says. Nothing is deleted:
 * comments, runs, run_events, cost and the Jira link all stay, which is
 * what makes unarchiving a restore rather than a rebuild.
 *
 * Safe to run whenever. An already-archived item is not in the live
 * set, so a second sweep over the same project finds nothing.
 */
export function sweepArchive(db: Db, now = Date.now()): SweepResult {
  const days = archiveAfterDays(db);
  if (days === null) return { archived: 0, disabled: true };

  // Which items are finished, **each by the version it entered on**
  // (EO-327, ARCHITECTURE.md, "Publish, lock and versions"). Not one set of terminal step ids for
  // the whole
  // sweep: whether a step is terminal is a property of a version, so an
  // item that entered before a save marked its step terminal is not
  // finished and an item that finished on a step a later save unmarked
  // still is. Getting this wrong does not draw something oddly — it puts
  // live work in the Archive, or leaves finished work on the board for
  // ever.
  // Never a project's thread (EO-471). It is on a step that is not
  // terminal, so it is never finished — but it is somewhere the project
  // keeps saying things for as long as it exists, and that is a reason
  // of its own rather than a consequence of how its step is set.
  const rows = listItems(db).filter((item) => !isProjectThread(item));
  const finished = finishedItemIds(db, rows);

  // The clock, which is a different question: *when* an item entered the
  // step it is standing on. Asked of every step that counts as terminal
  // for at least one of these items — the live ones plus whatever an
  // older version still calls terminal — because a transition into a
  // step no current version calls terminal is still the moment that
  // item's work ended.
  const terminalStepIds = new Set([
    ...listPipelineSteps(db)
      .filter((state) => state.isTerminal)
      .map((state) => state.id),
    ...rows.flatMap((item) => (item.stepId !== null && finished.has(item.id) ? [item.stepId] : [])),
  ]);
  const finishedAt = lastEntryIntoStates(db, [...terminalStepIds]);

  const candidates: ArchiveCandidate[] = rows.map((item) => ({
    item,
    terminalSince: finishedAt.get(item.id) ?? null,
    finished: finished.has(item.id),
  }));

  const doomed = archivableItems({ candidates, delayMs: days * DAY_MS, now });

  /**
   * When this item's work actually finished.
   *
   * A feature is off the pipeline (ARCHITECTURE.md, "One work entity"), so it has no step, no
   * transition into a terminal one, and no entry in `finishedAt` — it is
   * finished when the last of its stories is, which is the clock
   * `archivableItems` measured it by when it chose the item. Reading
   * the map alone and falling back to `now` made every archived feature
   * announce itself as "finished 0 days ago, past the 14-day limit",
   * contradicting the limit in the same sentence.
   */
  const finishedAtFor = (item: (typeof candidates)[number]["item"]): number | null => {
    const own = finishedAt.get(item.id);
    if (own !== undefined) return own;
    const children = candidates.filter((candidate) => candidate.item.parentId === item.id).map((candidate) => candidate.terminalSince);
    if (children.length === 0 || children.some((at) => at === null)) return null;
    return Math.max(...(children as number[]));
  };

  for (const item of doomed) {
    // The comment first, so an item that vanishes can always say why.
    // Nobody is mentioned: this is a record, not a request, and an
    // inbox that pings for routine tidying stops being worth opening.
    const finishedDaysAgo = Math.floor((now - (finishedAtFor(item) ?? now)) / DAY_MS);
    postComment(db, {
      itemId: item.id,
      author: { type: "engine" },
      kind: "note",
      body:
        `Archived: finished ${finishedDaysAgo} day${finishedDaysAgo === 1 ? "" : "s"} ago, past the ${days}-day limit. ` +
        `Nothing was deleted — restore it from the archive to put it back on the project.`,
    });
    setItemArchived(db, item.id, now);
  }

  return { archived: doomed.length, disabled: false };
}
