import { skillAuthorFromActingAgent, type IpcPayload, type IpcResponse, type SkillScope, type Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import { archiveSkill, getProject, getSkill, getWorkspace, listSkills, listSkillVersions, restoreSkillVersion, saveSkill, setSkillEnabled, setSkillLocked } from "../db/repos/index.js";
import { releaseHeldSkillCopies } from "../db/repos/skillsRepo.js";

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
  // Who is writing (EO-714): a system agent the administrative MCP host
  // named, whose write a lock refuses, or else the person.
  const { actingAgentId, ...draft } = input;
  const result = saveSkill(db, draft, Date.now(), skillAuthorFromActingAgent(actingAgentId));
  if (!result.ok) return { saved: false, skill: null, problem: result.problems.join("\n") };
  // A rename can free the slug a held copy from the record wanted (EO-714).
  releaseHeldSkillCopies(db);
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
  const result = setSkillEnabled(db, input.id, input.enabled, Date.now(), skillAuthorFromActingAgent(input.actingAgentId));
  return result.ok ? { skill: result.skill, problem: null } : { skill: null, problem: result.problem };
}

/** Archives a skill. Still listable with `includeArchived`, still what an attachment points at, and a version in its history (EO-714). */
export function archiveSkillCommand(db: Db, input: IpcPayload<"skills:archive">): IpcResponse<"skills:archive"> {
  const result = archiveSkill(db, input.id, Date.now(), skillAuthorFromActingAgent(input.actingAgentId));
  return result.ok ? { archived: true, problem: null } : { archived: false, problem: result.problem };
}

/** Locks or unlocks a skill (EO-714) — a person's act, which every door but the administrative MCP host's carries. */
export function setSkillLockedCommand(db: Db, input: IpcPayload<"skills:setLocked">): IpcResponse<"skills:setLocked"> {
  const result = setSkillLocked(db, input.id, input.locked);
  // Unlocked, it no longer keeps out what the record sent while it was
  // locked (EO-714): that is written now, not on the next pull.
  if (result.ok && !input.locked) releaseHeldSkillCopies(db);
  return result.ok ? { skill: result.skill, problem: null } : { skill: null, problem: result.problem };
}

/** Every write to one skill, newest first (EO-714). */
export function listSkillVersionsCommand(db: Db, input: IpcPayload<"skills:versions">): IpcResponse<"skills:versions"> {
  if (getSkill(db, input.id) === undefined) return { versions: [], problem: "That skill no longer exists." };
  return { versions: listSkillVersions(db, input.id), problem: null };
}

/** Puts an earlier version back, as a new version naming whoever restored it (EO-714). */
export function restoreSkillVersionCommand(db: Db, input: IpcPayload<"skills:restoreVersion">): IpcResponse<"skills:restoreVersion"> {
  const result = restoreSkillVersion(db, input.id, input.versionId, Date.now(), skillAuthorFromActingAgent(input.actingAgentId));
  return result.ok ? { skill: result.skill, problem: null } : { skill: null, problem: result.problem };
}
