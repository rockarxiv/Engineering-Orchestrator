import { developerType, type Item, type Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import { createItem, getProject, getProjectItemOnStep } from "../db/repos/index.js";

/**
 * A thread for each project (EO-471, `ARCHITECTURE.md`, "One channel").
 *
 * Comments are the only channel (invariant 4), and every comment sits on
 * an item. That left nowhere to say something that belongs to a project
 * rather than to any one piece of work on it — a proposed skill, a note
 * about the repository. So each project gets one off-board item as its
 * thread, as each job does (`jobs/thread.ts`, "What a job records"),
 * created the first time something needs to post there.
 *
 * Its comments are ordinary comments. A mention on one reaches the inbox
 * and the `!` count exactly as it would anywhere else, because neither
 * learns anything new.
 */

/**
 * The step a project thread sits on — migration 0119.
 *
 * Its own off-board step on `discussions`, for `JOB_THREAD_STEP`'s
 * reason: the step is what the code keys on. Off-board keeps it out of
 * every column, the board and the archive listing; not terminal keeps
 * the archive sweep from finding it finished.
 */
export const PROJECT_THREAD_STEP = "project-thread";

/**
 * The thread's key: the project's own prefix and `NOTES` — `SHOP-NOTES`.
 *
 * Not a number from a sequence, as `DISC` and `JOB` threads have. A
 * counter is one database's, and this thread is made by whichever record
 * owns the project — a desktop for one kept local, the organisation's
 * server for one it holds — and travels between them when a project is
 * moved. Two counters each starting at 1 hand two projects' threads the
 * same key in one desktop's replica, where `items.key` is unique. There
 * is exactly one thread per project and a project's prefix is unique and
 * never renamed, so the key can be the project's own; and every work key
 * ends in a number, so no item numbered from that prefix can be it.
 */
export function projectThreadKey(keyPrefix: string): string {
  return `${keyPrefix}-NOTES`;
}

/** What a person sees it called, in settings and as the thread's title. */
export const PROJECT_THREAD_TITLE = "Project notes";

export type ProjectThreadAnswer = { ok: true; item: Item } | { ok: false; problem: string };

/** Whether this item is a project's thread. */
export function isProjectThread(item: Pick<Item, "stepId">): boolean {
  return item.stepId === PROJECT_THREAD_STEP;
}

/** The project's thread if it has one yet, without making one. */
export function findProjectThread(db: Db, projectId: Uuid): Item | undefined {
  return getProjectItemOnStep(db, projectId, PROJECT_THREAD_STEP);
}

/**
 * The project's thread, made here if it has none yet.
 *
 * **On this database's own tables**, which is right where this database
 * is the record for the project: a solo desktop, a project kept local,
 * and the organisation's server answering `record:projectThread`. A
 * desktop holding a project the organisation owns does not make one —
 * the thread belongs to the record like the project's other items, so
 * `ItemRecord.projectThread` is the accessor everything else calls, and
 * it sends that case to the record.
 *
 * Read and written in one transaction, so two callers in this process
 * get one item between them. `idx_items_project_thread` makes the same
 * true across two connections to one file: the loser's insert is
 * refused, and it reads the winner's row instead.
 *
 * A refusal rather than a throw, unlike `openJobThread`: a job thread is
 * made with the job, by a person who can be told; this one is made by
 * whatever first needed to post, which has its own sentence to write
 * about not being able to.
 */
export function openProjectThread(db: Db, projectId: Uuid): ProjectThreadAnswer {
  const project = getProject(db, projectId);
  if (project === undefined) return { ok: false, problem: "That project no longer exists, so it has no thread." };
  if (project.adoptingAt !== null) {
    // A thread made mid-move could miss the pages already sent, and be
    // an item the organisation's record never receives.
    return { ok: false, problem: `${project.name} is moving to your organisation's record. Its notes open once the move has finished.` };
  }

  try {
    return db.transaction((): ProjectThreadAnswer => {
      const existing = findProjectThread(db, projectId);
      if (existing !== undefined) return { ok: true, item: existing };
      const created = createItem(db, {
        // A container type, for `openJobThread`'s reason: it gives a
        // thread item the read-only shape — the repository itself rather
        // than a worktree, no branch, no pull request — inherited rather
        // than special-cased. Nothing is ever dispatched against it.
        type: developerType("feature"),
        title: PROJECT_THREAD_TITLE,
        stepId: PROJECT_THREAD_STEP,
        projectId,
        key: projectThreadKey(project.keyPrefix),
      });
      if (!created.ok) return { ok: false, problem: `${project.name} has no notes thread yet, and one could not be made: ${created.problem}` };
      return { ok: true, item: created.item };
    });
  } catch (error) {
    // Another connection made it between this one's read and its write,
    // and the unique index said so. Theirs is the thread.
    const existing = findProjectThread(db, projectId);
    if (existing !== undefined) return { ok: true, item: existing };
    throw error;
  }
}
