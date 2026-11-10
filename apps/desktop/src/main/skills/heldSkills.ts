import { LOCAL_PERSON_ID, type Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import { projectMovedToTheRecord } from "../db/repos/projectsRepo.js";
import { getSkill, getSkillBySlug, listHeldSkillCopies, markHeldSkillCopyTold, skillOwner, type HeldSkillCopy } from "../db/repos/skillsRepo.js";
import { sendMessage } from "../messages/messages.js";

/** The source of the message saying a lock kept the organisation's copy of a skill out (EO-727). */
export const HELD_SKILL_COPY_SOURCE = "held_skill_copy";

/**
 * Telling a person that a lock of theirs kept the organisation's copy of
 * a skill out (EO-714, EO-727).
 *
 * The copy is held, not dropped (`holdSkillCopy`), and written the moment
 * the lock no longer stands in its way. What a person needs is to know
 * that it is waiting and what lets it in: one message to this machine's
 * person (invariant 8), naming the skill. Written in this database, never
 * the record's, because the lock is this machine's and nobody else is
 * waiting on it — so it is about a project only where that project is
 * kept here (`projectOf`); a message about a project the record holds is
 * the record's, and a replica's own copy of one would be forgotten.
 *
 * Marked told in the same transaction as the message is written, so a
 * copy is told once and never marked told with nobody having been.
 */
export function tellHeldSkillCopies(db: Db, at: number = Date.now()): number {
  let told = 0;
  for (const held of listHeldSkillCopies(db)) {
    if (held.toldAt !== null) continue;
    db.transaction(() => {
      sendMessage(db, { recipientId: LOCAL_PERSON_ID, projectId: projectOf(db, held), source: HELD_SKILL_COPY_SOURCE, body: held.problem }, at);
      markHeldSkillCopyTold(db, held.skill.id, at);
    });
    told += 1;
  }
  return told;
}

/**
 * The project a held copy is about, where there is one and it is kept on
 * this machine: the project the record gave the copy, else the project
 * the locked skill here belongs to. Null for a global skill, and for a
 * project the organisation's record holds.
 */
function projectOf(db: Db, held: HeldSkillCopy): Uuid | null {
  let projectId = held.projectId;
  if (projectId === null) {
    // The locked skill here: the same row a newer copy was refused for, or
    // the one holding the slug a published skill wanted.
    const locked = getSkill(db, held.skill.id) ?? getSkillBySlug(db, held.skill.slug);
    projectId = (locked === undefined ? undefined : skillOwner(db, locked.id))?.projectId ?? null;
  }
  return projectId === null || projectMovedToTheRecord(db, projectId as Uuid) ? null : (projectId as Uuid);
}
