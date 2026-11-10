import { LOCAL_PERSON_ID, skillDueForArchive, type MessageSend, type SectionLock, type Skill, type SkillAgeing, type SkillAuthor, type Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import { projectMovedToTheRecord } from "../db/repos/projectsRepo.js";
import { getSetting, setSetting } from "../db/repos/settingsRepo.js";
import { archiveSkill, listSkills, skillOwner } from "../db/repos/skillsRepo.js";
import { skillsGivenToRunsInFlight, skillUsageById, usageOfSkill } from "../db/repos/skillUsageRepo.js";
import { emitPush } from "../ipc/push.js";
import { sectionLockFor } from "../managed/locks.js";
import { sendMessage as sendMessageHere, type MessageSendAnswer } from "../messages/messages.js";

/**
 * Archiving the agent skills nobody loads (EO-720, ARCHITECTURE.md §13.3).
 *
 * Counted in runs, not days, so an idle project ages nothing: an
 * agent-written, unlocked skill given to `archiveAfterRuns` runs in a row
 * without one of them loading it — since its last load or restore — is
 * archived, and from then on delivered to nobody. A person's skill and a
 * locked one are never archived here, whatever their counts; the Skills
 * screen only reports them.
 *
 * A pass is about one project: the run that moved the counts was on it,
 * and a refusal is said in a message about it. The guardrails are read for each pass, so a person changing
 * them changes the next one. **Each skill is archived where it is
 * written** (`archiveReachOf`): the organisation's record archives the
 * skills of a project it holds, and its own global ones, when a device's
 * run reaches it settled (`serveApply`); a desktop archives its own
 * global skills after a run on any project, and a project's and its
 * workspaces' skills only for a project it holds itself — never a
 * record-held project's, which the record's next copy would bring back.
 *
 * Only settled runs age a skill (`skillDeliveriesQuery`), and a skill
 * given to a run that has not settled — one still going, or one whose
 * transcript is still arriving — is not archived meanwhile
 * (`skillsGivenToRunsInFlight`), however long that takes.
 *
 * Nothing is posted for what is archived (EO-728): it asks nothing of
 * anyone. Each archive is a `skill_versions` row authored by EO that
 * keeps how many runs the skill was given without a load, which the
 * Skills screen shows on the archived skill beside its Restore; restoring
 * brings it back with its stretch started again (`skillDeliveriesQuery`).
 *
 * A pass that cannot archive what is due says so too (invariant 8): an
 * organisation's published section, which keeps skill writes on the
 * record, is said once in a message about the project (EO-727) — again
 * only when another skill falls due under it — and a message that could
 * not be sent is tried again on the next pass.
 */

/** The source of the message saying a published section kept EO from archiving skills (EO-727). */
export const ARCHIVAL_HELD_SOURCE = "skill_archival_held";

export const EO_SKILL_AUTHOR: SkillAuthor = { kind: "eo" };

/**
 * Which skills of a project's reach a pass here may archive: all of them —
 * the project's, its workspaces' and the global ones — or only the global
 * ones, this installation's own, where the project's are the record's.
 */
export type ArchiveReach = "all" | "global";

/**
 * The reach of a pass on this installation for a project: everything on
 * the record and for a project held here; only this installation's global
 * skills on a desktop for a project it moved to the record.
 */
export function archiveReachOf(db: Db, projectId: Uuid, onTheRecord: boolean): ArchiveReach {
  return onTheRecord || !projectMovedToTheRecord(db, projectId) ? "all" : "global";
}

export interface ArchiveUnusedSkillsInput {
  db: Db;
  /** The project of the run that moved the counts: whose skills are looked at, and what a refusal's message is about. */
  projectId: Uuid;
  /** Which of the project's reach this installation archives (`archiveReachOf`). */
  reach: ArchiveReach;
  /** The guardrails in force for this pass. */
  ageing: SkillAgeing;
  /**
   * `ItemRecord.sendMessage`, so the message saying a published section
   * kept skills from being archived about a record-held project is
   * written on the record, to each admin (EO-727). This database's own
   * table, to this machine's person, where absent.
   */
  sendMessage?: (input: MessageSend) => Promise<MessageSendAnswer>;
  now?: () => number;
}

export type ArchiveUnusedSkillsResult =
  | { archived: Skill[] }
  /** Some were due and none was archived: why, and whether a message saying so was sent now. */
  | { archived: []; told: boolean; problem: string };

/** The live skills of this project's reach that are due to be archived now. */
function dueSkills(db: Db, projectId: Uuid, reach: ArchiveReach, ageing: SkillAgeing): Skill[] {
  const usage = skillUsageById(db);
  const inFlight = skillsGivenToRunsInFlight(db);
  return listSkills(db).filter((skill) => {
    if (inFlight.has(skill.id) || !skillDueForArchive(skill, usageOfSkill(usage, skill.id), ageing)) return false;
    const owner = skillOwner(db, skill.id)?.projectId ?? null;
    return owner === null || (reach === "all" && owner === projectId);
  });
}

/** Where the skills a published section kept from being archived were last told of, per project — so the same refusal is not said after every run. */
function refusalToldKey(projectId: Uuid): string {
  return `skills.archiveRefusalTold.${projectId}`;
}

export async function archiveUnusedSkills(input: ArchiveUnusedSkillsInput): Promise<ArchiveUnusedSkillsResult> {
  const { db, projectId, reach, ageing } = input;
  const dueNow = dueSkills(db, projectId, reach, ageing);
  if (dueNow.length === 0) return { archived: [] };

  // Skill writes are the record's under a published section: nothing is
  // archived here.
  const held = sectionLockFor(db, "skills:archive");
  if (held) return tellRefusal(input, dueNow, held);

  const now = input.now ?? Date.now;
  const usage = skillUsageById(db);
  // Each archive is its own version, saying after how many runs without a
  // load (EO-728); one transaction, so a pass archives all it found due or none.
  const archived = db.transaction((): Skill[] => {
    const written: Skill[] = [];
    for (const skill of dueNow) {
      const runsWithoutLoad = usageOfSkill(usage, skill.id).deliveriesSinceLoad;
      const result = archiveSkill(db, skill.id, now(), EO_SKILL_AUTHOR, { kind: "unused", runsWithoutLoad });
      if (result.ok) written.push(result.skill);
    }
    return written;
  });
  if (archived.length > 0) emitPush("config:changed", {});
  return { archived };
}

function refusalProblem(lock: SectionLock): string {
  return `Your organisation has published the ${lock.section} section${lock.publishedBy ? ` (${lock.publishedBy})` : ""}, so skills are changed there and EO archived nothing here.`;
}

/**
 * The published section that kept due skills from being archived, said in
 * a message about the project (EO-727) — once for these skills, and again
 * only when one falls due that was not among those told of. Remembered as
 * told only once the message is written.
 */
async function tellRefusal(input: ArchiveUnusedSkillsInput, due: readonly Skill[], lock: SectionLock): Promise<ArchiveUnusedSkillsResult> {
  const { db, projectId } = input;
  const problem = refusalProblem(lock);
  const told = new Set(getSetting<string[]>(db, refusalToldKey(projectId), []));
  if (due.every((skill) => told.has(skill.id))) return { archived: [], told: false, problem };
  const which = due.length === 1 ? "An agent-written skill is" : `${due.length} agent-written skills are`;
  const body = [
    `${which} due to be archived — given to runs in a row without one of them loading ${due.length === 1 ? "it" : "them"} — but ${problem.charAt(0).toLowerCase()}${problem.slice(1)}`,
    "",
    ...due.map((skill) => `- **${skill.name}** (\`${skill.slug}\`)`),
    "",
    `${due.length === 1 ? "It is" : "They are"} still delivered. An admin can archive ${due.length === 1 ? "it" : "them"} where the section is published.`,
  ].join("\n");
  const send = input.sendMessage ?? ((message: MessageSend): Promise<MessageSendAnswer> => Promise.resolve({ ok: true, messages: [sendMessageHere(db, message)] }));
  let sent: MessageSendAnswer;
  try {
    sent = await send({ recipientId: LOCAL_PERSON_ID, projectId, source: ARCHIVAL_HELD_SOURCE, body });
  } catch (error) {
    sent = { ok: false, problem: error instanceof Error ? error.message : String(error) };
  }
  if (!sent.ok) return { archived: [], told: false, problem: `${problem} The message saying so could not be sent, and the next pass will try again: ${sent.problem}` };
  setSetting(db, refusalToldKey(projectId), due.map((skill) => skill.id));
  return { archived: [], told: true, problem };
}
