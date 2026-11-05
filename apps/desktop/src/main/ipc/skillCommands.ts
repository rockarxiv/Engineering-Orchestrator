import type { IpcPayload, IpcResponse, SkillScope, Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import { archiveSkill, getProject, getSkill, getWorkspace, listSkills, saveSkill, setSkillEnabled } from "../db/repos/index.js";

/**
 * The skill catalogue, over IPC (EO-105).
 *
 * Nothing here dispatches anything. A skill saved through these channels
 * reaches no agent until it is attached to one (EO-106) and written into
 * a plugin directory a provider reads (EO-107) — this is the record,
 * landed first so the shape is settled while it is cheap to change.
 *
 * Every refusal is a sentence. The repository applies the same pure
 * check `readSkillDraft` that this boundary would, so there is exactly
 * one account of what is wrong with a skill and both callers get it.
 */

export function listSkillsCommand(db: Db, input: IpcPayload<"skills:list">): IpcResponse<"skills:list"> {
  return { skills: listSkills(db, input.includeArchived ?? false) };
}

/**
 * Creates or edits a skill.
 *
 * Every way of getting it wrong — a slug that is not one, a slug another
 * skill has, a supporting file that climbs out of the skill's folder, a
 * missing description — comes back as `problem`. Nothing on this path
 * throws: the refusals are things a person typed, and the boundary's job
 * is to say so where they can see it (F-04).
 *
 * The problems are joined into one sentence-per-line string rather than
 * sent as a list, because that is the shape every other `problem` on
 * this contract has and a screen that has learned to render one has
 * learned to render all of them.
 */
export function saveSkillCommand(db: Db, input: IpcPayload<"skills:save">): IpcResponse<"skills:save"> {
  const scopeProblem = input.scope === undefined ? null : missingScope(db, input.scope);
  if (scopeProblem !== null) return { saved: false, skill: null, problem: scopeProblem };
  const result = saveSkill(db, input);
  if (!result.ok) return { saved: false, skill: null, problem: result.problems.join("\n") };
  return { saved: true, skill: result.skill, problem: null };
}

/**
 * Why a scope a person just picked cannot be saved, or null (EO-470).
 *
 * Asked here, at the boundary somebody picks a scope through — the
 * Skills screen and `skill_save` both arrive on this channel — rather
 * than in the repository, whose `scope_id` deliberately outlives the
 * project or workspace it named. Picking one that is already gone is a
 * race with another window, and saving it would make a skill that
 * reaches no run while reading as though it reaches one.
 */
function missingScope(db: Db, scope: SkillScope): string | null {
  if (scope.kind === "project" && getProject(db, scope.projectId as Uuid) === undefined) return "That project no longer exists — pick another scope for this skill.";
  if (scope.kind === "workspace" && getWorkspace(db, scope.workspaceId as Uuid) === undefined) return "That workspace no longer exists — pick another scope for this skill.";
  return null;
}

export function setSkillEnabledCommand(db: Db, input: IpcPayload<"skills:setEnabled">): IpcResponse<"skills:setEnabled"> {
  if (!setSkillEnabled(db, input.id, input.enabled)) return { skill: null, problem: "That skill no longer exists." };
  const skill = getSkill(db, input.id);
  return skill === undefined ? { skill: null, problem: "That skill no longer exists." } : { skill, problem: null };
}

/** Archives a skill. Still listable with `includeArchived`, and still what an attachment points at. */
export function archiveSkillCommand(db: Db, input: IpcPayload<"skills:archive">): IpcResponse<"skills:archive"> {
  if (!archiveSkill(db, input.id)) return { archived: false, problem: "That skill no longer exists." };
  return { archived: true, problem: null };
}
