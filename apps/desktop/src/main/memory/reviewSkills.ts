import {
  eoToolName,
  SKILL_CREATE_TOOL_NAME,
  SKILL_FILE_REMOVE_TOOL_NAME,
  SKILL_FILE_WRITE_TOOL_NAME,
  SKILL_LOCKED_PROBLEM,
  SKILL_PATCH_TOOL_NAME,
  SKILL_VIEW_TOOL_NAME,
  SkillCreateArgsSchema,
  SkillFileRemoveArgsSchema,
  SkillFileWriteArgsSchema,
  SkillPatchArgsSchema,
  SkillViewArgsSchema,
  type AgentWriteAnswer,
  type Skill,
  type SkillAuthor,
  type SkillDraft,
  type SkillFile,
  type SkillRunScope,
  type SkillWriteTool,
} from "@eo/core";
import { deliverableSkills } from "../agentAttachments/worktreeSkills.js";
import type { Db } from "../db/client.js";
import { resolveAgentAttachmentsForRun, setAgentAttachment } from "../db/repos/agentAttachmentsRepo.js";
import { getSkillBySlug, saveSkill } from "../db/repos/skillsRepo.js";
import { emitPush } from "../ipc/push.js";
import { sectionLockFor } from "../managed/locks.js";

/**
 * The learning review's skill tools (EO-718, after Nous Research's Hermes
 * Agent): read a skill, create one, patch its body, write or remove one
 * of its files. Answered here for the review the supervisor is running —
 * `reviewWrite` in `runSupervisor.ts` routes them — and served to no
 * other turn of any agent.
 *
 * **What the review may read and change** is what the reviewed run's
 * agent is given where that run worked: the skills attached to it, in the
 * run's scope, switched on and not archived — whoever wrote them. Every
 * one of them is the agent's to improve; a skill attached to another
 * agent, or meant for another project, is not this run's to judge.
 *
 * **Read before write.** A patch, an overwrite of a file and a removal are
 * refused unless this same review read what they change — the body, or
 * that file — with `skill_view`. A review that changes text it never saw
 * writes over a person's words on a guess. A new file needs no read: there
 * is nothing there to overwrite. What the review wrote itself it has seen.
 *
 * **A lock refuses every write** (EO-714), with the sentence saying a
 * person locked it; `saveSkill` holds that too, since the author is a run.
 * An organisation's published skills are changed where they were
 * published, as consolidation's are.
 *
 * Every write goes through `saveSkill` with the run as its author, so each
 * is one `skill_versions` row naming the run, and a skill the review
 * creates is `created_by = 'agent'`.
 */

/** One review's reach and what it has read. Held by the supervisor for the span of the review. */
export interface ReviewSkillState {
  /** The reviewed run: the author of every write. */
  runId: string;
  /** The reviewed run's agent: whose skills these are, and what a new one is attached to. */
  agentId: string;
  /** Where the reviewed run worked. A new skill is scoped to its project. */
  scope: SkillRunScope;
  /** What this review has read: a skill's id for its body, `<id>/<path>` for a file. */
  read: Set<string>;
  /** The skills it wrote, each once, in the order first written. */
  written: string[];
}

export function reviewSkillState(input: { runId: string; agentId: string; scope: SkillRunScope }): ReviewSkillState {
  return { ...input, read: new Set(), written: [] };
}

/** The skills this review may read and change, by slug. */
export function reviewableSkills(db: Db, state: Pick<ReviewSkillState, "agentId" | "scope">): Skill[] {
  return deliverableSkills(resolveAgentAttachmentsForRun(db, state.agentId, state.scope).skills);
}

const VIEW = eoToolName(SKILL_VIEW_TOOL_NAME);

const fileKey = (skillId: string, path: string): string => `${skillId}/${path}`;

const refused = (code: string, problem: string): AgentWriteAnswer => ({ ok: false, code, problem });

/** One skill tool call, answered for this review. Never throws for anything the agent sent. */
export function answerReviewSkillTool(db: Db, state: ReviewSkillState, tool: SkillWriteTool, args: unknown, now: number = Date.now()): AgentWriteAnswer {
  switch (tool) {
    case SKILL_VIEW_TOOL_NAME:
      return view(db, state, args);
    case SKILL_CREATE_TOOL_NAME:
      return create(db, state, args, now);
    case SKILL_PATCH_TOOL_NAME:
      return patch(db, state, args, now);
    case SKILL_FILE_WRITE_TOOL_NAME:
      return writeFile(db, state, args, now);
    case SKILL_FILE_REMOVE_TOOL_NAME:
      return removeFile(db, state, args, now);
  }
}

/** The skill this review may read by that slug, or the refusal naming the ones it may. */
function reviewable(db: Db, state: ReviewSkillState, slug: string): { ok: true; skill: Skill } | { ok: false; answer: AgentWriteAnswer } {
  const skills = reviewableSkills(db, state);
  const skill = skills.find((candidate) => candidate.slug === slug);
  if (skill !== undefined) return { ok: true, skill };
  const which = skills.length === 0 ? "This run's agent is given no skills here" : `The skills this review may read are ${skills.map((candidate) => `\`${candidate.slug}\``).join(", ")}`;
  return { ok: false, answer: refused("SKILL_NOT_FOUND", `There is no skill called \`${slug}\` this review may read, so nothing was done. ${which}.`) };
}

/** Why no agent may write to this skill now, or null: a person's lock, or an organisation's published section. */
function writeRefusal(db: Db, skill: Skill | null): AgentWriteAnswer | null {
  if (skill?.locked === true) return refused("SKILL_LOCKED", SKILL_LOCKED_PROBLEM);
  for (const channel of ["skills:save", "agentAttachments:set"] as const) {
    const lock = sectionLockFor(db, channel);
    if (lock) return refused("SKILL_PUBLISHED", `Your organisation has published the ${lock.section} section, so skills are changed there. Nothing was written.`);
  }
  return null;
}

const notRead = (slug: string, path: string | null): AgentWriteAnswer =>
  refused(
    "SKILL_NOT_READ",
    path === null
      ? `This review has not read the skill \`${slug}\`, so nothing was written. Read it first with ${VIEW} (\`slug\` "${slug}"), then make the change.`
      : `This review has not read \`${path}\` of the skill \`${slug}\`, so nothing was written. Read it first with ${VIEW} (\`slug\` "${slug}", \`file\` "${path}"), then make the change.`,
  );

function view(db: Db, state: ReviewSkillState, args: unknown): AgentWriteAnswer {
  const parsed = SkillViewArgsSchema.safeParse(args);
  if (!parsed.success) return refused("INVALID_ARGUMENT", `${SKILL_VIEW_TOOL_NAME} takes \`slug\`, a skill's name, and optionally \`file\`, one of its files' paths, and nothing else.`);
  const found = reviewable(db, state, parsed.data.slug);
  if (!found.ok) return found.answer;
  const { skill } = found;
  const path = parsed.data.file;
  if (path !== undefined) {
    const file = skill.files.find((candidate) => candidate.path === path);
    if (file === undefined) {
      const files = skill.files.length === 0 ? "It has no files" : `Its files are ${skill.files.map((candidate) => `\`${candidate.path}\``).join(", ")}`;
      return refused("SKILL_FILE_NOT_FOUND", `The skill \`${skill.slug}\` has no file \`${path}\`, so nothing was read. ${files}.`);
    }
    state.read.add(fileKey(skill.id, path));
    return { ok: true, text: file.content, data: { slug: skill.slug, file: path } };
  }
  state.read.add(skill.id);
  const files = skill.files.length === 0 ? "none" : skill.files.map((file) => `\`${file.path}\``).join(", ");
  const head = [
    `Skill \`${skill.slug}\`: ${skill.description}`,
    `Written by ${skill.createdBy === "agent" ? "an agent" : "a person"}${skill.locked ? "; a person locked it, so it cannot be changed" : ""}. Files: ${files}.`,
    "",
    "---",
    "",
  ].join("\n");
  return { ok: true, text: `${head}${skill.body}`, data: { slug: skill.slug, locked: skill.locked, createdBy: skill.createdBy, files: skill.files.map((file) => file.path) } };
}

function create(db: Db, state: ReviewSkillState, args: unknown, now: number): AgentWriteAnswer {
  const parsed = SkillCreateArgsSchema.safeParse(args);
  if (!parsed.success) return refused("INVALID_ARGUMENT", `${SKILL_CREATE_TOOL_NAME} takes \`slug\`, \`description\` and \`body\`, and nothing else.`);
  const { slug, description, body } = parsed.data;
  // A slug already taken is never written over: a locked one says so, a
  // skill this review may read is to be patched, and anything else is
  // another skill's name.
  const taken = getSkillBySlug(db, slug);
  if (taken !== undefined) {
    if (taken.locked) return refused("SKILL_LOCKED", SKILL_LOCKED_PROBLEM);
    const mine = reviewableSkills(db, state).some((skill) => skill.id === taken.id);
    return refused(
      "SKILL_EXISTS",
      mine
        ? `A skill called \`${slug}\` already exists, so nothing was created. Read it with ${VIEW} and patch it instead.`
        : `Another skill already uses the slug \`${slug}\`, so nothing was created. Name this one for the kind of task it is about, in other words.`,
    );
  }
  const projectId = state.scope.projectId;
  if (projectId === null) return refused("NO_PROJECT", "The reviewed run's item is on no project, and a skill the review creates belongs to one. Nothing was created.");
  const blocked = writeRefusal(db, null);
  if (blocked !== null) return blocked;
  const draft: SkillDraft = { slug, name: slug, description, body, files: [], scope: { kind: "project", projectId } };
  const saved = saveSkill(db, draft, now, runAuthor(state));
  if (!saved.ok) return refused("SKILL_REFUSED", `Nothing was created. ${saved.problems.join(" ")}`);
  const attached = setAgentAttachment(db, { agentId: state.agentId, kind: "skill", id: saved.skill.id, attached: true }, now);
  wrote(state, saved.skill);
  return {
    ok: true,
    text: `EO created the skill \`${saved.skill.slug}\` for this project${attached.ok ? " and gave it to this run's agent" : `, and could not give it to this run's agent: ${attached.problem}`}. Its later runs on this project are offered it from now on.`,
    data: { skillId: saved.skill.id, slug: saved.skill.slug },
  };
}

function patch(db: Db, state: ReviewSkillState, args: unknown, now: number): AgentWriteAnswer {
  const parsed = SkillPatchArgsSchema.safeParse(args);
  if (!parsed.success) return refused("INVALID_ARGUMENT", `${SKILL_PATCH_TOOL_NAME} takes \`slug\`, \`old_text\` (text the body holds exactly once) and \`new_text\`, and nothing else.`);
  const found = reviewable(db, state, parsed.data.slug);
  if (!found.ok) return found.answer;
  const { skill } = found;
  const blocked = writeRefusal(db, skill);
  if (blocked !== null) return blocked;
  if (!state.read.has(skill.id)) return notRead(skill.slug, null);
  const { old_text: before, new_text: after } = parsed.data;
  const count = skill.body.split(before).length - 1;
  if (count !== 1) {
    return refused(
      "PATCH_NOT_FOUND",
      count === 0
        ? `The skill \`${skill.slug}\`'s body does not hold that \`old_text\`, so nothing was written. Copy it from the body exactly.`
        : `The skill \`${skill.slug}\`'s body holds that \`old_text\` ${String(count)} times, so nothing was written. Give enough of it to name one place.`,
    );
  }
  return save(db, state, skill, { body: skill.body.replace(before, () => after) }, now, `EO patched the skill \`${skill.slug}\`'s body.`);
}

function writeFile(db: Db, state: ReviewSkillState, args: unknown, now: number): AgentWriteAnswer {
  const parsed = SkillFileWriteArgsSchema.safeParse(args);
  if (!parsed.success) return refused("INVALID_ARGUMENT", `${SKILL_FILE_WRITE_TOOL_NAME} takes \`slug\`, \`path\` (relative to the skill's folder) and \`content\`, and nothing else.`);
  const found = reviewable(db, state, parsed.data.slug);
  if (!found.ok) return found.answer;
  const { skill } = found;
  const blocked = writeRefusal(db, skill);
  if (blocked !== null) return blocked;
  const { path, content } = parsed.data;
  const exists = skill.files.some((file) => file.path === path);
  if (exists && !state.read.has(fileKey(skill.id, path))) return notRead(skill.slug, path);
  const files: SkillFile[] = exists ? skill.files.map((file) => (file.path === path ? { path, content } : file)) : [...skill.files, { path, content }];
  const answer = save(db, state, skill, { files }, now, `EO ${exists ? "rewrote" : "added"} \`${path}\` in the skill \`${skill.slug}\`.`);
  if (answer.ok) state.read.add(fileKey(skill.id, path));
  return answer;
}

function removeFile(db: Db, state: ReviewSkillState, args: unknown, now: number): AgentWriteAnswer {
  const parsed = SkillFileRemoveArgsSchema.safeParse(args);
  if (!parsed.success) return refused("INVALID_ARGUMENT", `${SKILL_FILE_REMOVE_TOOL_NAME} takes \`slug\` and \`path\`, one of the skill's files, and nothing else.`);
  const found = reviewable(db, state, parsed.data.slug);
  if (!found.ok) return found.answer;
  const { skill } = found;
  const blocked = writeRefusal(db, skill);
  if (blocked !== null) return blocked;
  const { path } = parsed.data;
  if (!skill.files.some((file) => file.path === path)) return refused("SKILL_FILE_NOT_FOUND", `The skill \`${skill.slug}\` has no file \`${path}\`, so nothing was removed.`);
  if (!state.read.has(fileKey(skill.id, path))) return notRead(skill.slug, path);
  return save(db, state, skill, { files: skill.files.filter((file) => file.path !== path) }, now, `EO removed \`${path}\` from the skill \`${skill.slug}\`.`);
}

/** One edit, through `saveSkill` with the run as author: everything it does not name stays as it is. */
function save(db: Db, state: ReviewSkillState, skill: Skill, change: { body?: string; files?: SkillFile[] }, now: number, said: string): AgentWriteAnswer {
  const saved = saveSkill(
    db,
    { id: skill.id, slug: null, name: skill.name, description: skill.description, body: change.body ?? skill.body, files: change.files ?? skill.files },
    now,
    runAuthor(state),
  );
  if (!saved.ok) return refused("SKILL_REFUSED", `Nothing was written. ${saved.problems.join(" ")}`);
  wrote(state, saved.skill);
  return { ok: true, text: `${said} A person can see the change in its history and restore what it said before.`, data: { skillId: saved.skill.id, slug: saved.skill.slug } };
}

function runAuthor(state: ReviewSkillState): SkillAuthor {
  return { kind: "run", runId: state.runId };
}

/** What the review has written it has also seen; and the Skills screen is told the catalogue changed. */
function wrote(state: ReviewSkillState, skill: Skill): void {
  state.read.add(skill.id);
  if (!state.written.includes(skill.id)) state.written.push(skill.id);
  emitPush("config:changed", {});
}
