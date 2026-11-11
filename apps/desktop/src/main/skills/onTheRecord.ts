import type { Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import { projectMovedToTheRecord } from "../db/repos/projectsRepo.js";
import { publishedSectionRow } from "../db/repos/publishedSectionsRepo.js";
import { skillOwner } from "../db/repos/skillsRepo.js";

/**
 * Whether a skill this desktop holds is the organisation's record's
 * (EO-728): one of a project somebody moved there — its own or one of its
 * workspaces' — or one the record's published packs section carries.
 * Its versions are the record's, so restoring one is made there
 * (`ItemRecord.restoreSkillVersion`) rather than here, where the record's
 * next copy would undo it and no other desktop would hear of it. And
 * because it is made there, the packs section's lock on this machine,
 * which keeps skill writes off it, does not bind the restore
 * (`sectionLockFor`): the record judges it.
 *
 * Asked only of a replica: on the record itself every skill is its own.
 */
export function skillHeldByTheRecord(db: Db, skillId: string): boolean {
  const owner = skillOwner(db, skillId);
  if (owner === undefined) return false;
  if (owner.projectId !== null && projectMovedToTheRecord(db, owner.projectId as Uuid)) return true;
  return publishedSectionRow(db, "packs")?.document?.skills.some((skill) => skill.id === skillId) ?? false;
}
