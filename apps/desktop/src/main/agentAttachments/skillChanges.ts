import { createHash } from "node:crypto";
import type { SkillGivenBefore, SkillsDeliveredChanges } from "@eo/core";
import { oneLine } from "./skillsPrompt.js";

/**
 * What changed in an agent's skills between the run a thread last had and
 * the turn that carries it on (EO-919).
 *
 * A change to skills alone no longer ends an item's conversation: both
 * backends read a skill's body when the agent loads it, and EO writes the
 * current ones where each reads them before every resumed turn. What goes
 * stale is the list in the prompt that opened the thread, so the resumed
 * turn is told what is different, and this is how it is worked out.
 *
 * By the adapter, at the moment it delivers (invariant 12): each compares
 * what the run before was given — the `skills_delivered` EO recorded for
 * it, the hash of what each skill said then included — with the skills it
 * is delivering to this turn, and the change is said in the message it
 * sends and on the `skills_delivered` it reports. So the listing names
 * exactly what the turn can load, on either backend: never a skill the
 * delivery refused, never an edit that landed after the files were
 * written. Derived each time, never stored apart (invariant 6).
 */

/** One skill as a turn is given it: as the listing names it, and what it says. */
export interface DeliveredSkill {
  slug: string;
  name: string;
  description: string;
  /** `skillContentHash` of the files delivered for it: `deliveredSkillOf` on Codex, `toolDirectorySkills` on Claude. */
  contentHash: string;
}

/** One skill as the listing names it. */
export interface ListedSkill {
  slug: string;
  name: string;
  description: string;
}

export interface SkillChanges {
  /** Given now and not to the previous run. */
  added: ListedSkill[];
  /** Given to both, and not the same — its body, description, name or files. */
  changed: ListedSkill[];
  /** Given to the previous run and not now: archived, disabled, detached, scoped elsewhere, refused, or deleted. */
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

/**
 * What one skill's delivered files say, as one hash: each file's path
 * within the skill's folder and its content, in path order — the same
 * folder in another order is the same folder. `SKILL.md` is among them,
 * so its description, display name and body are too.
 */
export function skillContentHash(files: readonly { path: string; content: string }[]): string {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map((file) => [file.path, file.content]);
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

const listed = (skill: ListedSkill): ListedSkill => ({ slug: skill.slug, name: skill.name, description: skill.description });
const bySlug = (a: { slug: string }, b: { slug: string }) => a.slug.localeCompare(b.slug);

/**
 * The change from what the run before was given to what this turn is.
 *
 * By slug, since that is what the agent knows a skill by. A skill in both
 * has changed when what it says now hashes otherwise than what it was
 * delivered as — or when that delivery recorded no hash, as one from
 * before EO-919 did not, since nothing then says it is the same.
 */
export function skillChangesBetween(before: readonly SkillGivenBefore[], delivered: readonly DeliveredSkill[]): SkillChanges {
  const then = new Map(before.map((skill) => [skill.slug, skill]));
  const now = new Set(delivered.map((skill) => skill.slug));
  const added: ListedSkill[] = [];
  const changed: ListedSkill[] = [];
  for (const skill of [...delivered].sort(bySlug)) {
    const was = then.get(skill.slug);
    if (was === undefined) added.push(listed(skill));
    else if (was.contentHash !== skill.contentHash) changed.push(listed(skill));
  }
  const removed = [...before]
    .filter((skill) => !now.has(skill.slug))
    .sort(bySlug)
    .map(listed);
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
