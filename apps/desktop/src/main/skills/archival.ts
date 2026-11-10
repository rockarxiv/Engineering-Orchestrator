import { skillDueForArchive, type Comment, type SectionLock, type Skill, type SkillAgeing, type SkillAuthor, type Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import { postComment, type PostCommentInput } from "../db/repos/commentsRepo.js";
import { projectMovedToTheRecord } from "../db/repos/projectsRepo.js";
import { getSetting, setSetting } from "../db/repos/settingsRepo.js";
import { archiveSkill, listSkills, skillOwner } from "../db/repos/skillsRepo.js";
import { skillsGivenToRunsInFlight, skillUsageById, usageOfSkill } from "../db/repos/skillUsageRepo.js";
import { emitPush } from "../ipc/push.js";
import { sectionLockFor } from "../managed/locks.js";
import type { ProjectThreadAnswer } from "../projects/projectThread.js";

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
 * A pass is about one project, because its note goes on that project's
 * thread. The guardrails are read for each pass, so a person changing
 * them changes the next one. **Each skill is archived where it is
 * written** (`archiveReachOf`): the organisation's record archives the
 * skills of a project it holds, and its own global ones, when a device's
 * run reaches it settled (`serveApply`); a desktop archives its own
 * global skills after a run on any project, and a project's and its
 * workspaces' skills only for a project it holds itself — never a
 * record-held project's, which the record's next copy would bring back.
 *
 * Only settled runs age a skill (`skillDeliveriesQuery`), and a skill a
 * run that may yet load it was given — one still going, or one whose
 * transcript is still arriving — is not archived meanwhile
 * (`skillsGivenToRunsInFlight`).
 *
 * The archives and the one note naming them are written in one
 * transaction: a note that could not be written leaves every skill as it
 * was, still due, for the next pass. Each archive is a `skill_versions`
 * row authored by EO, and restoring an earlier version brings the skill
 * back with its stretch started again (`skillDeliveriesQuery`).
 *
 * A pass that cannot archive what is due says so too (invariant 8): an
 * organisation's published section, which keeps skill writes on the
 * record, is said once on the project's thread — again only when another
 * skill falls due under it. A thread that cannot be opened, which happens
 * only while the project is moving to the record or is gone, archives
 * nothing and writes nothing: the skills stay live, nothing is dropped,
 * and the next pass asks again.
 */

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
  /** The project of the run that moved the counts: whose skills are looked at, and whose thread is told. */
  projectId: Uuid;
  /** Which of the project's reach this installation archives (`archiveReachOf`). */
  reach: ArchiveReach;
  /** The guardrails in force for this pass. */
  ageing: SkillAgeing;
  /** `ItemRecord.projectThread`. */
  projectThread: (projectId: Uuid) => Promise<ProjectThreadAnswer>;
  /**
   * `ItemRecord.postComment`, so a note on a record-held project's thread
   * reaches the record. Synchronous, and called inside the transaction
   * that archives. This database's own `postComment` where absent.
   */
  postComment?: (input: PostCommentInput) => Comment;
  now?: () => number;
}

export type ArchiveUnusedSkillsResult =
  | { archived: Skill[]; noteId: string | null }
  /** Some were due and none was archived: why, and the comment that said so, where one was written now. */
  | { archived: []; noteId: string | null; problem: string };

/** The live skills of this project's reach that are due to be archived now. */
function dueSkills(db: Db, projectId: Uuid, reach: ArchiveReach, ageing: SkillAgeing, now: number): Skill[] {
  const usage = skillUsageById(db);
  const inFlight = skillsGivenToRunsInFlight(db, now);
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
  if (dueSkills(db, projectId, reach, ageing, (input.now ?? Date.now)()).length === 0) return { archived: [], noteId: null };

  let thread: ProjectThreadAnswer;
  try {
    thread = await input.projectThread(projectId);
  } catch (error) {
    thread = { ok: false, problem: error instanceof Error ? error.message : String(error) };
  }
  if (!thread.ok) return { archived: [], noteId: null, problem: `The project thread to say so on could not be opened, so nothing was archived and the next pass will try again: ${thread.problem}` };
  const threadItemId = thread.item.id as Uuid;
  const now = input.now ?? Date.now;
  const post = input.postComment ?? ((comment: PostCommentInput) => postComment(db, comment));

  // Asked again after the await, and inside the transaction that writes:
  // a person may have loaded, restored, locked or archived one meanwhile.
  const result = db.transaction((): ArchiveUnusedSkillsResult => {
    const due = dueSkills(db, projectId, reach, ageing, now());
    if (due.length === 0) return { archived: [], noteId: null };

    const lock = sectionLockFor(db, "skills:archive");
    if (lock) return tellRefusal(db, post, projectId, threadItemId, due, lock);

    const archived: Skill[] = [];
    for (const skill of due) {
      const written = archiveSkill(db, skill.id, now(), EO_SKILL_AUTHOR);
      if (written.ok) archived.push(written.skill);
    }
    if (archived.length === 0) return { archived: [], noteId: null };
    // A throw here undoes every archive above with it.
    const noteId = note(post, threadItemId, archiveNote(archived, ageing));
    return { archived, noteId };
  });
  if (result.archived.length > 0) emitPush("config:changed", {});
  return result;
}

function note(post: (input: PostCommentInput) => Comment, itemId: Uuid, body: string): string {
  return post({
    itemId,
    author: { type: "engine" },
    kind: "note",
    body,
    // EO's own sentence, naming skills agents wrote: nothing in it summons anyone.
    parseBodyMentions: false,
  }).id;
}

/**
 * The published section that kept due skills from being archived, said on
 * the project's thread — once for these skills, and again only when one
 * falls due that was not among those told of.
 */
function tellRefusal(db: Db, post: (input: PostCommentInput) => Comment, projectId: Uuid, threadItemId: Uuid, due: readonly Skill[], lock: SectionLock): ArchiveUnusedSkillsResult {
  const problem = `Your organisation has published the ${lock.section} section${lock.publishedBy ? ` (${lock.publishedBy})` : ""}, so skills are changed there and EO archived nothing here.`;
  const told = new Set(getSetting<string[]>(db, refusalToldKey(projectId), []));
  if (due.every((skill) => told.has(skill.id))) return { archived: [], noteId: null, problem };
  const which = due.length === 1 ? "An agent-written skill is" : `${due.length} agent-written skills are`;
  const body = [
    `${which} due to be archived — given to runs in a row without one of them loading ${due.length === 1 ? "it" : "them"} — but ${problem.charAt(0).toLowerCase()}${problem.slice(1)}`,
    "",
    ...due.map((skill) => `- **${skill.name}** (\`${skill.slug}\`)`),
    "",
    `${due.length === 1 ? "It is" : "They are"} still delivered. An admin can archive ${due.length === 1 ? "it" : "them"} where the section is published.`,
  ].join("\n");
  const noteId = note(post, threadItemId, body);
  setSetting(db, refusalToldKey(projectId), due.map((skill) => skill.id));
  return { archived: [], noteId, problem };
}

/** The one note a pass that archived anything posts: every skill it archived, and how to bring one back. */
export function archiveNote(archived: readonly Skill[], ageing: SkillAgeing): string {
  const which = archived.length === 1 ? "an agent-written skill" : `${archived.length} agent-written skills`;
  return [
    `EO archived ${which} that ${archived.length === 1 ? "was" : "were"} given to ${ageing.archiveAfterRuns} runs in a row without one of them loading ${archived.length === 1 ? "it" : "them"}. ${archived.length === 1 ? "It is" : "They are"} no longer delivered to any agent.`,
    "",
    ...archived.map((skill) => `- **${skill.name}** (\`${skill.slug}\`)`),
    "",
    "To bring one back, open the Skills screen, show the archived skills, open its History and press Restore on the version before \"Archived by EO\". It is delivered again from the next run, and its count of runs without a load starts again from zero. Lock a skill there to keep EO from archiving it; the counts are guardrails you can change under Settings → Guardrails.",
  ].join("\n");
}
