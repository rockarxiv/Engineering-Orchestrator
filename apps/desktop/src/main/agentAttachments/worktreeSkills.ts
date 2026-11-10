import { lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { renderSkillMarkdown, type Skill } from "@eo/core";
import { isDeliverable, skillFiles, type PluginFile } from "./pluginDirectory.js";
import { skillsPromptSection } from "./skillsPrompt.js";

/**
 * How a skill reaches an agent whose backend has no idea what one is
 * (EO-207).
 *
 * A skill was delivered to a Claude agent and to nobody else:
 * `writeAgentToolDirectory` renders it into a generated plugin
 * directory, and the SDK is told which skills that directory holds. Codex
 * has no plugin loader to point at, so a skill ticked onto a Codex agent
 * was attached, was shown as attached, and reached no turn. That is
 * invariant 12 — a capability reaches both backends, or names the one it
 * does not — and until this shipped EO said so in a comment rather than
 * fixing it.
 *
 * **Files in the worktree, choices in the prompt.** The files go to
 * `.agent/skills/<slug>/SKILL.md`, the same shape the generated
 * repository index already uses: a directory EO writes into the working
 * tree, which an agent finds by looking rather than by following a
 * per-run absolute path it was handed. One location, discovery by
 * listing, and a prompt section
 * that is a sentence instead of a path. It is a convenience rather than
 * a capability — the sandbox runs at `danger-full-access`, so a Codex
 * agent could already read the generated directory under `userData` — and
 * `workspace/excludes.ts` is what keeps it out of `git status`.
 *
 * **Skills only. The generated directory as a whole does not move.** It
 * also holds `.mcp.json`, which carries `Authorization: Bearer
 * ${EO_ADMIN_TOKEN}` and the admin listener's URL. That is a credential
 * in a checkout, one `git add -A` from a commit. Skill markdown is inert
 * and can live in the tree; the MCP configuration stays where it is.
 *
 * **The bodies are not inlined, and that is the point.** `SkillSchema`
 * splits a skill deliberately: `description` is what the model reads to
 * decide whether this skill is the one, `body` is what it reads once it
 * has chosen, and `files` are read after that again. Pasting every
 * attached body into the prompt would collapse that — every body and
 * every supporting file in the context of every turn, whether or not the
 * turn is about any of them — and it is why a person can attach several
 * skills without paying for all of them. So the prompt lists slug and
 * description and says where to read; the model chooses from
 * descriptions and opens the file only once it has chosen. The same two
 * steps Claude's SDK drives, driven by the prompt instead.
 *
 * **One worktree, several agents, one delivery.** Every action on an
 * item shares a checkout, so `.agent/skills` holds whatever the last
 * dispatch put there rather than a folder per agent. Each delivery
 * sweeps the skill folders EO wrote and lays down its own, which is what
 * stops a directory accumulating skills nobody attached — and it is why
 * a *resumed* turn writes its skills again (`providers/codex.ts`)
 * instead of trusting what the turn that opened its thread wrote.
 *
 * **Nothing here follows a link.** `.agent` and `.agent/skills` are
 * directories in a checkout the repository controls, and every path
 * question below them is asked with `lstat` rather than `stat` for that
 * reason: a `.agent` symlinked out of the worktree would otherwise take
 * both the write *and* the sweep somewhere EO was never given — deleting
 * another checkout's delivery, since the marked folders there look
 * exactly like this one's. A link at either level refuses the delivery
 * whole and says so.
 *
 * **The two flags keep the meanings they already had.**
 * `disableModelInvocation` is "present on disk, absent from what the
 * model is choosing between", which maps exactly: written to
 * `.agent/skills`, left out of the prompt's list, so a skill a person
 * names deliberately still resolves. `enabled` and `archivedAt` are
 * answered by `isDeliverable` — the same predicate the generated
 * directory asks, not a second rule that gets to disagree with it.
 */

/** The directory EO owns inside a worktree, and the only one a skill is written under. */
export const WORKTREE_AGENT_DIRECTORY = ".agent";

/** Where the skills sit inside it — the same `skills/<slug>/` shape the generated directory uses. */
export const WORKTREE_SKILLS_SUBDIRECTORY = "skills";

/** `.agent/skills`, as a reader of the prompt would type it. */
export const WORKTREE_SKILLS_PATH = `${WORKTREE_AGENT_DIRECTORY}/${WORKTREE_SKILLS_SUBDIRECTORY}`;

/**
 * The file that makes a skill folder EO's, written inside the folder
 * itself.
 *
 * This is the whole of how the delivery stays honest about a directory
 * it does not own. `.agent` is a plausible name for a repository to have
 * chosen itself, and `.agent/skills/pr-review` is a plausible thing for
 * it to keep there — so "remove and rewrite `.agent/skills`" would
 * delete somebody's tracked files on every dispatch, and "overwrite
 * `<slug>/SKILL.md`" would replace their skill with EO's under a name
 * they chose first. Neither is EO's to do; it is the same rule
 * `worktrees.test.ts` already holds EO to one directory over, where a
 * `vendor/` namesake of the generated index is left exactly where it is
 * because EO did not put it there.
 *
 * **Ownership is proven in place rather than remembered.** An earlier
 * draft of this kept one list of delivered slugs at the top of
 * `.agent/skills`; that file is inside a checkout the agent can write
 * to, so a slug appearing in it was enough to have EO recursively delete
 * whatever stood at that name — a list is a claim about a directory, and
 * the directory never got to answer. A marker inside the folder is the
 * answer: EO removes a folder because *that folder* says EO made it, and
 * a folder EO found says nothing and is left alone.
 *
 * Written before the skill's own files rather than after. An
 * interrupted write then leaves a folder EO still owns and will replace
 * next dispatch; the other order leaves one EO disowns, which would
 * conflict with its own slug forever.
 *
 * **The claim is the content, not the filename.** A file merely *called*
 * `.eo-delivered` is not EO saying anything — a repository is free to
 * have one, and treating its existence as proof would put the previous
 * draft's bug back in a smaller box: an arbitrary file in a checkout
 * deciding that EO may recursively delete the folder around it. So the
 * marker opens with a sentinel line EO writes and this module checks
 * for, and a file that does not start with it is somebody's file rather
 * than EO's claim.
 *
 * That is proof against coincidence rather than against forgery, and it
 * is worth being exact about which. An agent with write access to the
 * checkout could copy the sentinel into a folder and have EO clear it
 * away — but the same agent can delete the folder itself, at
 * `danger-full-access`, without EO's help. What this defends is the case
 * that actually happens: a repository that keeps its own material at a
 * name EO also wants.
 */
const OWNERSHIP_MARKER = ".eo-delivered";

/**
 * The first line of a marker EO wrote, and the whole of what makes it
 * one.
 *
 * Versioned, so that a later change to what a marker means can tell an
 * old one apart from a new one instead of guessing.
 */
const OWNERSHIP_SENTINEL = "EO-DELIVERED-SKILL-FOLDER v1";

/** Said in the file too, because the person who finds it is owed the sentence. */
const OWNERSHIP_MARKER_CONTENT =
  `${OWNERSHIP_SENTINEL}\n` +
  "EO wrote this folder from a skill attached to one of its agents, and replaces or removes it on the next dispatch.\n" +
  "Delete this file and EO will leave the folder alone.\n";

/**
 * The largest marker EO will read.
 *
 * The file being read is one EO found in a checkout, and the question
 * asked of it is answered by its first line — so a multi-megabyte file
 * that happens to carry the name is a file to decline rather than to
 * load. EO's own marker is three lines.
 */
const OWNERSHIP_MARKER_MAX_BYTES = 4096;

/**
 * Is this a skill folder EO wrote, rather than one it found?
 *
 * Only the sentinel answers yes. Everything else — no marker, a marker
 * that is somebody's own file, a marker too large to be one of EO's, a
 * directory by that name, a *link* to a marker somewhere else, an
 * unreadable path — answers no, which is the answer that leaves the
 * folder alone.
 *
 * `lstat` rather than `stat`, for the reason every other path check in
 * this file uses it: a symbolic link pointing at a real marker is the
 * checkout borrowing EO's words about a folder EO never wrote.
 */
export function eoOwnsSkillDirectory(directory: string): boolean {
  const marker = join(directory, OWNERSHIP_MARKER);
  try {
    const found = lstatSync(marker);
    if (!found.isFile() || found.size > OWNERSHIP_MARKER_MAX_BYTES) return false;
    return readFileSync(marker, "utf8").startsWith(`${OWNERSHIP_SENTINEL}\n`);
  } catch {
    return false;
  }
}

/**
 * What is at this exact path, without following a link to somewhere
 * else.
 *
 * `lstat` everywhere, and that is the whole point of this pair. Every
 * other question in this module — may EO write here, may EO delete this
 * — is asked about a path inside a checkout an agent can write to, and
 * `stat` answers about the *target* of a link rather than about the link
 * a repository put there. A `.agent` symlinked to somewhere outside the
 * worktree, answered with `stat`, is a directory EO would happily write
 * skills into and sweep marked folders out of — outside the tree it was
 * given, with no bound on where.
 */
function pathKind(path: string): "absent" | "directory" | "symlink" | "other" {
  let found;
  try {
    found = lstatSync(path);
  } catch {
    return "absent";
  }
  if (found.isSymbolicLink()) return "symlink";
  return found.isDirectory() ? "directory" : "other";
}

/** Is something there at all, link or not? A broken link still occupies the name. */
function occupied(path: string): boolean {
  return pathKind(path) !== "absent";
}

/**
 * Why EO will not deliver into this worktree at all, or null.
 *
 * `.agent` and `.agent/skills` are the two directories EO descends
 * through to reach a skill folder, and neither is EO's until EO makes
 * it. If either is a symbolic link the repository put there, every path
 * below it resolves somewhere EO was not given: the write lands outside
 * the worktree, and — worse — the sweep that removes EO-marked folders
 * runs there too, so a delivery made into some *other* checkout can be
 * deleted by this one. If either is a plain file, there is nothing to
 * descend into.
 *
 * Refused whole rather than per skill, because the fault is the path
 * rather than any one slug: nothing under it can be written, so every
 * attached skill comes back undelivered with this as the reason.
 */
function undeliverableRoot(root: string, skillsRoot: string): string | null {
  for (const [path, name] of [
    [root, WORKTREE_AGENT_DIRECTORY],
    [skillsRoot, WORKTREE_SKILLS_PATH],
  ] as const) {
    const kind = pathKind(path);
    // Absent is the ordinary case and the one EO creates. It also ends
    // the walk: nothing can be below a directory that is not there.
    if (kind === "absent") return null;
    if (kind === "symlink") {
      return `${name} in the checkout is a symbolic link rather than a directory, and EO does not follow one — it is not a directory EO made, and writing through it would put the skills outside the worktree`;
    }
    if (kind === "other") {
      return `${name} in the checkout is a file rather than a directory, so there is nothing for EO to write into`;
    }
  }
  return null;
}

/**
 * Every skill folder under here that EO wrote, whatever this dispatch is
 * delivering.
 *
 * Read off the disk rather than from a record, so the answer is about
 * what is actually there. One worktree is dispatched to by several
 * agents with different attachments, and each of them sweeps what the
 * last one left: that is why a resumed turn has to write its own skills
 * back (`providers/codex.ts`), and why the sweep cannot be narrowed to
 * "the slugs this agent has".
 */
function eoOwnedSkillDirectories(skillsRoot: string): string[] {
  let entries;
  try {
    entries = readdirSync(skillsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  // `isDirectory` on a `Dirent` is `lstat`'s answer, so a symbolic link
  // to a directory is not one here — which is the answer wanted: a link
  // the checkout placed is not a folder EO wrote, whatever it points at.
  return entries.filter((entry) => entry.isDirectory() && eoOwnsSkillDirectory(join(skillsRoot, entry.name))).map((entry) => entry.name);
}

/** Removes a directory only if it is empty, which is `rmdir`'s own rule. */
function removeIfEmpty(path: string): void {
  try {
    rmdirSync(path);
  } catch {
    // Somebody else's, or already gone. Both are fine.
  }
}

/**
 * The skills this delivery actually carries, in a stable order.
 *
 * `isDeliverable` and nothing else decides which — see the note above on
 * why there is no second rule. Sorted by slug so two dispatches of the
 * same attachment set write the same bytes and produce the same prompt.
 */
export function deliverableSkills(skills: readonly Skill[]): Skill[] {
  return [...skills].filter(isDeliverable).sort((a, b) => a.slug.localeCompare(b.slug));
}

/**
 * A skill's `SKILL.md` as Codex is given it: the plugin directory's file,
 * with the skill's id under `metadata` (EO-715). Codex has no skill tool,
 * so a load is told by what a command shows of the file, and the id is
 * the part of it no other file holds — whatever command read it.
 */
export function worktreeSkillMarkdown(skill: Skill): string {
  return renderSkillMarkdown({ ...skill, skillIdMarker: skill.id });
}

/**
 * Every file the worktree's `.agent` directory holds, as content rather
 * than as writes — paths relative to `.agent`.
 *
 * `skillFiles` is reused verbatim from the generated directory, which is
 * what makes a supporting file work here for free: it lands beside its
 * `SKILL.md` because that function puts it there, and a body that says
 * "see `checklist.md`" resolves as a sibling on disk either way.
 */
export function worktreeSkillFiles(skills: readonly Skill[]): PluginFile[] {
  return deliverableSkills(skills)
    .flatMap((skill) => skillFiles(skill, worktreeSkillMarkdown(skill)))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** One skill that was attached and is not on disk, and why. */
export interface UndeliveredSkill {
  slug: string;
  /** A sentence, because it is written into a warning a person reads. */
  reason: string;
}

/** What one delivery managed, and what it did not. */
export interface WorktreeSkillDelivery {
  /**
   * The skills actually on disk after this call, and therefore the only
   * ones the prompt may offer.
   */
  delivered: Skill[];
  /**
   * Everything attached and deliverable that is *not* on disk — a name
   * EO would not write over, or a write that failed.
   *
   * Carried out rather than logged in here, because this module has no
   * business deciding how loud a dropped capability is. But it is
   * carried, and that is invariant #8: this whole story exists because a
   * skill was attached, was shown as attached, and reached no turn with
   * nothing saying so. Answering a filesystem failure with an empty list
   * and no reason would have rebuilt exactly that.
   */
  undelivered: UndeliveredSkill[];
}

/**
 * Writes `.agent/skills` into the worktree, or takes EO's own skills
 * back out of it when there is nothing to deliver, and answers what is
 * there afterwards.
 *
 * Three things happen, in this order. Every skill folder EO previously
 * wrote is removed — including one written for a *different* agent on
 * the same item, which is what makes the delivery a statement about
 * this turn rather than an accumulation. Then any remaining folder
 * standing under a slug this dispatch wants is one EO did not write, so
 * that skill is not delivered and is named in `undelivered` rather than
 * written over. Then what is left is written, marker first.
 *
 * Never throws, and never swallows either. A read-only checkout or a
 * file sitting where `.agent` goes is a reason to dispatch without the
 * skills rather than a reason for the dispatch to fail — but it is not a
 * reason to say nothing, so the failure comes back against every skill
 * it cost. What is reported as delivered is what was *written*, so the
 * prompt cannot offer a skill whose file is not there.
 */
export function writeWorktreeSkills(worktreePath: string, skills: readonly Skill[]): WorktreeSkillDelivery {
  const root = join(worktreePath, WORKTREE_AGENT_DIRECTORY);
  const skillsRoot = join(root, WORKTREE_SKILLS_SUBDIRECTORY);
  // Computed before the try, so the failure path below can say which
  // skills a filesystem error actually cost.
  const deliverable = deliverableSkills(skills).filter((skill) => skillFiles(skill).length > 0);

  // Asked before anything is read, swept or written, because everything
  // below this line walks *through* those two directories: a link at
  // either would take the sweep and the write somewhere EO was never
  // given.
  const refusal = undeliverableRoot(root, skillsRoot);
  if (refusal) return { delivered: [], undelivered: deliverable.map((skill) => ({ slug: skill.slug, reason: refusal })) };

  try {
    for (const slug of eoOwnedSkillDirectories(skillsRoot)) rmSync(join(skillsRoot, slug), { recursive: true, force: true });

    // Anything still standing under one of these names is not EO's:
    // EO's own went a line above.
    const undelivered: UndeliveredSkill[] = [];
    const delivered: Skill[] = [];
    for (const skill of deliverable) {
      // `occupied` rather than `existsSync`: a broken symbolic link
      // holds the name without resolving to anything, and answering
      // "nothing there" would have EO try to create the folder and fail
      // on EEXIST instead of leaving what the checkout put there.
      if (occupied(join(skillsRoot, skill.slug))) {
        undelivered.push({
          slug: skill.slug,
          reason: `${WORKTREE_SKILLS_PATH}/${skill.slug} is already in the checkout and EO did not write it, so EO left it alone`,
        });
        continue;
      }
      delivered.push(skill);
    }
    const files = worktreeSkillFiles(delivered);

    if (files.length === 0) {
      removeIfEmpty(skillsRoot);
      removeIfEmpty(root);
      return { delivered: [], undelivered };
    }

    for (const skill of delivered) {
      const directory = join(skillsRoot, skill.slug);
      mkdirSync(directory, { recursive: true });
      // Before the skill's own files — see `OWNERSHIP_MARKER` on why
      // this order and not the other one.
      writeFileSync(join(directory, OWNERSHIP_MARKER), OWNERSHIP_MARKER_CONTENT, "utf8");
    }
    for (const file of files) {
      const target = join(root, file.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.content, "utf8");
    }
    return { delivered, undelivered };
  } catch (error) {
    // Every deliverable skill, not only the one the write was on. A
    // failure can land part-way through, and EO cannot say which files
    // survived it — so nothing is reported as delivered, the prompt
    // offers none of them, and the sentence names them all. Whatever did
    // reach disk carries a marker and is swept by the next dispatch.
    const reason = `EO could not write ${WORKTREE_SKILLS_PATH} in the worktree: ${error instanceof Error ? error.message : String(error)}`;
    return { delivered: [], undelivered: deliverable.map((skill) => ({ slug: skill.slug, reason })) };
  }
}

/**
 * Everything under `.agent` that EO cannot prove it wrote, relative to
 * the worktree.
 *
 * For the one caller that has to know before it destroys something:
 * `workspace/worktrees.ts` releases a settled item's checkout, and
 * until EO-207 git refused that removal over an untracked `.agent`
 * because git could see it. EO's own exclusion is what stopped git
 * seeing it — so the protection that exclusion removed has to be given
 * back by the party that removed it, narrowed to the one directory this
 * story made invisible.
 *
 * `.agent/skills/<slug>` with EO's marker in it is EO's, and derived:
 * it goes with the worktree and nobody loses anything. Everything else
 * under `.agent` — a file at the top of it, a folder beside `skills`, a
 * skill folder EO did not write — is somebody's, and a settled item is
 * not a reason to delete it.
 *
 * An absent `.agent` is nothing to report rather than an error, which is
 * the ordinary case: most worktrees never had one.
 */
export function unmanagedAgentEntries(worktreePath: string): string[] {
  const root = join(worktreePath, WORKTREE_AGENT_DIRECTORY);
  // A `.agent` that is a link or a file is somebody's, and it is not
  // walked: `readdir` through a link lists the target, so a worktree
  // pointing at somebody else's directory would be reported as holding
  // nothing of theirs and then removed. Reported by name and left
  // exactly where it is.
  const kind = pathKind(root);
  if (kind === "symlink" || kind === "other") return [WORKTREE_AGENT_DIRECTORY];

  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const unmanaged: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name !== WORKTREE_SKILLS_SUBDIRECTORY) {
      unmanaged.push(`${WORKTREE_AGENT_DIRECTORY}/${entry.name}`);
      continue;
    }
    let inside;
    try {
      inside = readdirSync(join(root, entry.name), { withFileTypes: true });
    } catch (error) {
      // A directory EO cannot read is a directory EO cannot vouch for,
      // and invariant #5 says a look that failed establishes nothing.
      unmanaged.push(`${WORKTREE_SKILLS_PATH} (could not be read: ${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    for (const skill of inside) {
      if (skill.isDirectory() && eoOwnsSkillDirectory(join(root, entry.name, skill.name))) continue;
      unmanaged.push(`${WORKTREE_SKILLS_PATH}/${skill.name}`);
    }
  }
  return unmanaged.sort();
}

/**
 * The section a Codex turn starts with, or an empty string when there is
 * nothing to choose between. Rendered by `skillsPromptSection`, which
 * Claude's shares (EO-602); what is Codex's own is opening a skill by
 * reading its file.
 *
 * Slug and description only. The body is deliberately absent — see the
 * note at the top of this file, and `worktreeSkills.test.ts`, which
 * attaches a skill with a distinctive body string and asserts that
 * string never reaches the turn.
 *
 * A skill carrying `disableModelInvocation` is on disk and not in here,
 * which is what that flag has always meant. When every delivered skill
 * carries it there is no section at all rather than a heading with
 * nothing under it — the same rule as an agent with nothing attached.
 */
export function worktreeSkillsPromptSection(delivered: readonly Skill[]): string {
  const offered = delivered.filter((skill) => !skill.disableModelInvocation).map((skill) => ({ name: skill.slug, description: skill.description }));
  return skillsPromptSection(offered, `When one of them fits what you are doing, read \`${WORKTREE_SKILLS_PATH}/<slug>/SKILL.md\` and follow it;`);
}
