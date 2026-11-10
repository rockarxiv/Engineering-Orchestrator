import type { Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import { postComment } from "../db/repos/commentsRepo.js";
import { listProjects, projectMovedToTheRecord } from "../db/repos/projectsRepo.js";
import { getSkill, getSkillBySlug, listHeldSkillCopies, markHeldSkillCopyTold, skillOwner, type HeldSkillCopy } from "../db/repos/skillsRepo.js";
import { findProjectThread, openProjectThread } from "../projects/projectThread.js";

/**
 * Telling a person that a lock of theirs kept the organisation's copy of
 * a skill out (EO-714).
 *
 * The copy is held, not dropped (`holdSkillCopy`), and written the moment
 * the lock no longer stands in its way. What a person needs is to know
 * that it is waiting and what lets it in, which is a comment (invariants
 * 4 and 8): an escalation that mentions the person, so it reaches their
 * inbox and lights `!`, kept on this machine (`staysHere`) because the
 * lock is this machine's and nobody else is waiting on it.
 *
 * On a project's thread, since that is where something about a project
 * rather than one piece of its work is said: the project the record gave
 * the copy; else the project the locked skill here belongs to; else, for
 * one global skill held out by another, every project on this machine —
 * a global skill reaches every one of them. A thread this machine is the
 * record for is opened if it has none yet; a record-held project's is
 * the record's to make, so it is told only once its thread has arrived.
 * A copy no thread could be found for stays untold and is tried again on
 * the next pull, rather than marked told with nobody having read it.
 */
export function tellHeldSkillCopies(db: Db, at: number = Date.now()): number {
  let told = 0;
  for (const held of listHeldSkillCopies(db)) {
    if (held.toldAt !== null) continue;
    const threads = threadsFor(db, held);
    for (const itemId of threads) {
      postComment(db, {
        itemId,
        author: { type: "engine" },
        kind: "escalation",
        mentions: [{ type: "human" }],
        body: held.problem,
        parseBodyMentions: false,
        staysHere: true,
      });
    }
    if (threads.length === 0) continue;
    markHeldSkillCopyTold(db, held.skill.id, at);
    told += 1;
  }
  return told;
}

/** The project threads a held copy is told on — see `tellHeldSkillCopies`. */
function threadsFor(db: Db, held: HeldSkillCopy): Uuid[] {
  return projectsFor(db, held).flatMap((projectId) => {
    if (projectMovedToTheRecord(db, projectId)) {
      const thread = findProjectThread(db, projectId);
      return thread === undefined ? [] : [thread.id as Uuid];
    }
    const thread = openProjectThread(db, projectId);
    return thread.ok ? [thread.item.id as Uuid] : [];
  });
}

function projectsFor(db: Db, held: HeldSkillCopy): Uuid[] {
  if (held.projectId !== null) return [held.projectId as Uuid];
  // The locked skill here: the same row a newer copy was refused for, or
  // the one holding the slug a published skill wanted.
  const locked = getSkill(db, held.skill.id) ?? getSkillBySlug(db, held.skill.slug);
  const owner = locked === undefined ? undefined : skillOwner(db, locked.id);
  if (owner?.projectId != null) return [owner.projectId as Uuid];
  return listProjects(db)
    .filter((project) => project.archivedAt === null && project.adoptingAt === null)
    .map((project) => project.id);
}
