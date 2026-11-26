import type { Skill, SkillFile, SkillsDeliveredChanges } from "@eo/core";
import type { Db } from "../db/client.js";
import { getSkill, skillsDeliveredTo, skillVersionsAround } from "../db/repos/index.js";
import { oneLine } from "./skillsPrompt.js";

/**
 * What changed in an agent's skills between the run a thread last had and
 * the turn that carries it on (EO-919).
 *
 * A change to skills alone no longer ends an item's conversation: both
 * backends read a skill's body when the agent loads it, and EO writes the
 * current ones where each reads them before every resumed turn. What goes
 * stale is the list in the prompt that opened the thread, so the resumed
 * turn is told what is different, and this is how EO works that out.
 *
 * Derived every time, never stored (invariant 6): from the previous run's
 * `skills_delivered` event — which skills it was given, and when — the
 * skills' versions, which say what each said at that moment, and the
 * skills this turn is given.
 */

/** One skill as the listing names it. */
export interface ListedSkill {
  slug: string;
  name: string;
  description: string;
}

export interface SkillChanges {
  /** Given now and not to the previous run. */
  added: ListedSkill[];
  /** Given to both, and edited since the previous run was given it — its body, description or files. */
  changed: ListedSkill[];
  /** Given to the previous run and not now: archived, disabled, detached, scoped elsewhere, or deleted. */
  removed: ListedSkill[];
}

export const NO_SKILL_CHANGES: SkillChanges = { added: [], changed: [], removed: [] };

export function hasSkillChanges(changes: SkillChanges): boolean {
  return changes.added.length + changes.changed.length + changes.removed.length > 0;
}

/** The slugs, as the run's `skills_delivered` event records the change. */
export function skillChangeSlugs(changes: SkillChanges): SkillsDeliveredChanges {
  const slugs = (skills: readonly ListedSkill[]) => skills.map((skill) => skill.slug);
  return { added: slugs(changes.added), changed: slugs(changes.changed), removed: slugs(changes.removed) };
}

const listed = (skill: Pick<Skill, "slug" | "name" | "description">): ListedSkill => ({ slug: skill.slug, name: skill.name, description: skill.description });

/** Files by path, for the reason the fingerprint sorts them: the same directory in another order is the same directory. */
const filesKey = (files: readonly SkillFile[]): string => JSON.stringify([...files].sort((a, b) => a.path.localeCompare(b.path)).map((file) => [file.path, file.content]));

/**
 * Whether a skill now says something other than it did at `at`.
 *
 * Read off its versions, which every write files whole: the newest
 * written by `at` is what the previous run was given, and the skill as it
 * stands is compared with it, so a save that rewrote the same words is no
 * change. A skill with no version that old — one from before EO kept them
 * (EO-714) — has changed if anything was written since.
 */
function editedSince(db: Db, skill: Skill, at: number): boolean {
  const { asOf, writtenSince } = skillVersionsAround(db, skill.id, at);
  if (asOf === undefined) return writtenSince;
  return asOf.body !== skill.body || asOf.description !== skill.description || filesKey(asOf.files) !== filesKey(skill.files);
}

/**
 * The change between what `previousRunId` was given and `given`, the
 * skills this turn is given — already narrowed to its scope and to the
 * ones a model may invoke (`deliverableSkills`).
 *
 * By slug, since that is what the agent knows a skill by: a slug that
 * now names another skill was removed and added in the same breath, and
 * is listed as changed. A previous run with no `skills_delivered` was
 * given nothing, so everything given now is added.
 */
export function skillChangesSince(db: Db, previousRunId: string, given: readonly Skill[]): SkillChanges {
  const delivered = skillsDeliveredTo(db, previousRunId);
  const before = new Map<string, string>();
  delivered?.slugs.forEach((slug, index) => {
    const id = delivered.skillIds[index];
    if (id !== undefined) before.set(slug, id);
  });
  const now = new Map(given.map((skill) => [skill.slug, skill]));

  const added: ListedSkill[] = [];
  const changed: ListedSkill[] = [];
  for (const skill of [...now.values()].sort((a, b) => a.slug.localeCompare(b.slug))) {
    const id = before.get(skill.slug);
    if (id === undefined) added.push(listed(skill));
    else if (id !== skill.id || editedSince(db, skill, delivered?.at ?? 0)) changed.push(listed(skill));
  }
  const removed: ListedSkill[] = [];
  for (const [slug, id] of [...before].sort(([a], [b]) => a.localeCompare(b))) {
    if (now.has(slug)) continue;
    const row = getSkill(db, id);
    removed.push(row === undefined ? { slug, name: slug, description: "" } : listed({ ...row, slug }));
  }
  return { added, changed, removed };
}

function bullet(skill: ListedSkill): string {
  const description = oneLine(skill.description);
  return `- \`${skill.slug}\` (${oneLine(skill.name)})${description === "" ? "" : ` — ${description}`}`;
}

/**
 * The section a resumed turn's first message ends with when its skills
 * changed, or an empty string when they did not.
 *
 * One wording for both backends (invariant 12): it says to load a skill
 * again, not which tool does it — the Skills section each backend's
 * opening prompt carried says that in its own words.
 */
export function skillChangesSection(changes: SkillChanges): string {
  if (!hasSkillChanges(changes)) return "";
  const lines = [
    "## Your skills have changed",
    "",
    "EO has changed the skills it gives you since your last run on this item, so the list you were given when this conversation began is out of date. This is what changed:",
  ];
  if (changes.added.length > 0) lines.push("", "Added — you can load these now, the way you load any of EO's skills:", ...changes.added.map(bullet));
  if (changes.changed.length > 0) {
    lines.push("", "Changed — what you may have read of these is out of date. Load a changed skill again to see its current text before you follow it:", ...changes.changed.map(bullet));
  }
  if (changes.removed.length > 0) lines.push("", "Removed — these are no longer available, and loading one will not work:", ...changes.removed.map(bullet));
  return lines.join("\n");
}

/** A message with the section after it, when there is one. */
export function withSkillChanges(message: string, changes: SkillChanges): string {
  const section = skillChangesSection(changes);
  return section === "" ? message : `${message}\n\n${section}`;
}
