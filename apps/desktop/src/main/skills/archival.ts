import { skillDueForArchive, type Skill, type SkillAgeing, type SkillAuthor, type Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import { postComment } from "../db/repos/commentsRepo.js";
import { archiveSkill, listSkills, skillOwner } from "../db/repos/skillsRepo.js";
import { skillUsageById, usageOfSkill } from "../db/repos/skillUsageRepo.js";
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
 * A pass follows a run, because a run is the only thing that moves a
 * count, and it looks at the skills within that run's project's reach:
 * the project's own, its workspaces', and the global ones. The guardrails
 * are read for each pass, so a person changing them changes the next one.
 *
 * Each archive is a `skill_versions` row authored by EO, and restoring an
 * earlier version brings the skill back with its stretch started again
 * (`skillDeliveriesQuery`). A pass that archives anything says so in one
 * note on the project's thread, naming every skill and how to bring one
 * back; a pass with no thread to say it on archives nothing — a skill
 * nobody is told was archived is not one EO archives.
 */

export const EO_SKILL_AUTHOR: SkillAuthor = { kind: "eo" };

export interface ArchiveUnusedSkillsInput {
  db: Db;
  /** The project of the run that just ended: whose skills are looked at, and whose thread is told. */
  projectId: Uuid;
  /** The guardrails in force for this pass. */
  ageing: SkillAgeing;
  /** `ItemRecord.projectThread`, so a project the organisation holds has its thread found there. */
  projectThread: (projectId: Uuid) => Promise<ProjectThreadAnswer>;
  now?: () => number;
}

export type ArchiveUnusedSkillsResult =
  | { archived: Skill[]; noteId: string | null }
  /** Some were due and none was archived: the reason, for the log. */
  | { archived: []; noteId: null; problem: string };

/** The live skills of this project's reach that are due to be archived now. */
function dueSkills(db: Db, projectId: Uuid, ageing: SkillAgeing): Skill[] {
  const usage = skillUsageById(db);
  return listSkills(db).filter((skill) => {
    if (!skillDueForArchive(skill, usageOfSkill(usage, skill.id), ageing)) return false;
    const owner = skillOwner(db, skill.id)?.projectId ?? null;
    return owner === null || owner === projectId;
  });
}

export async function archiveUnusedSkills(input: ArchiveUnusedSkillsInput): Promise<ArchiveUnusedSkillsResult> {
  const { db, projectId, ageing } = input;
  if (dueSkills(db, projectId, ageing).length === 0) return { archived: [], noteId: null };

  // Skills are the organisation's to change while it has published them,
  // as every other agent write to a skill is refused then.
  const lock = sectionLockFor(db, "skills:archive");
  if (lock) return { archived: [], noteId: null, problem: `Your organisation has published the ${lock.section} section, so skills are archived there.` };

  let thread: ProjectThreadAnswer;
  try {
    thread = await input.projectThread(projectId);
  } catch (error) {
    thread = { ok: false, problem: error instanceof Error ? error.message : String(error) };
  }
  if (!thread.ok) return { archived: [], noteId: null, problem: `The project thread to say so on could not be opened: ${thread.problem}` };

  // Asked again after the await: a person may have loaded, restored,
  // locked or archived one meanwhile. `archiveSkill` refuses a locked one
  // in its own transaction besides.
  const now = input.now ?? Date.now;
  const archived: Skill[] = [];
  for (const skill of dueSkills(db, projectId, ageing)) {
    const written = archiveSkill(db, skill.id, now(), EO_SKILL_AUTHOR);
    if (written.ok) archived.push(written.skill);
  }
  if (archived.length === 0) return { archived: [], noteId: null };

  const noteId = postComment(db, {
    itemId: thread.item.id as Uuid,
    author: { type: "engine" },
    kind: "note",
    body: archiveNote(archived, ageing),
    // EO's own sentence, naming skills agents wrote: nothing in it summons anyone.
    parseBodyMentions: false,
  }).id;
  emitPush("config:changed", {});
  return { archived, noteId };
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
