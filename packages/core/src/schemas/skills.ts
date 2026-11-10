import { z } from "zod";
import { SKILL_SLUG_MAX_LENGTH, SKILL_SLUG_PATTERN, slugifySkillName } from "../skillSlugs.js";

/**
 * A skill a person wrote, as it crosses every boundary (EO-105).
 *
 * One definition, because a skill crosses several: IPC when the
 * catalogue screen saves one (EO-109), an agent's attachment when it is
 * ticked onto a role (EO-106), and a `skills/<slug>/SKILL.md` inside a
 * generated plugin directory when it is finally dispatched (EO-107).
 * Three hand-written shapes that had to agree is the arrangement the
 * conventions rule out — the same reason `schemas/modules.ts` exists.
 *
 * A skill is a slug, a display name, a description, a body and zero or
 * more supporting files. The slug is the only one of those a model can
 * invoke; the rest of the note about that is on `skillFrontmatter`.
 */

/**
 * One file that sits beside `SKILL.md` in the skill's own directory.
 *
 * Text only, deliberately. A checklist, a template, a snippet — the
 * things a skill's body says "see `checklist.md`" about. A binary would
 * need base64 in a JSON column and a decision about size limits, and no
 * skill EO can currently deliver has one; the day one does, this is
 * where it grows a `encoding` field rather than where it quietly starts
 * holding something that is not a string.
 */
export const SkillFileSchema = z.object({
  /** Relative to the skill's directory. `readSkillDraft` is what refuses one that escapes it. */
  path: z.string(),
  content: z.string(),
});

export type SkillFile = z.infer<typeof SkillFileSchema>;

/**
 * Where a skill is delivered (EO-470, ARCHITECTURE.md §13.3).
 *
 * `global` — every run of an agent it is attached to, which is what every
 * skill was before scopes existed and what the migration made each of
 * them. `project` — only runs on items of that project. `workspace` —
 * only runs whose step works in that workspace.
 *
 * A procedure learned in one repository is noise in every other one, and
 * a skill an agent is offered is a description competing for its
 * attention on every turn, so scoping is about what reaches the model and
 * not about who may see the row: the catalogue lists every skill
 * whatever its scope.
 *
 * Attachment is still the first gate. A scope narrows the runs an
 * attached skill reaches; it never delivers a skill to an agent nobody
 * attached it to.
 */
export const SkillScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("global") }),
  z.object({ kind: z.literal("project"), projectId: z.string().min(1) }),
  z.object({ kind: z.literal("workspace"), workspaceId: z.string().min(1) }),
]);

export type SkillScope = z.infer<typeof SkillScopeSchema>;

export const GLOBAL_SKILL_SCOPE: SkillScope = { kind: "global" };

/**
 * Where one run works, as far as a skill's scope cares (EO-470).
 *
 * The item's project, and the workspace the run's step works in — the
 * step's own pick, else the item's, else the first its project spans,
 * which is the one answer `workspaceFor` gives. Either may be null: an
 * item on no project, a step that says "no disk". A null matches no
 * scope of that kind, so such a run is given its global skills only.
 */
export const SkillRunScopeSchema = z.object({
  projectId: z.string().nullable(),
  workspaceId: z.string().nullable(),
});

export type SkillRunScope = z.infer<typeof SkillRunScopeSchema>;

/** A run that is on no project and works in no workspace — global skills only. */
export const UNSCOPED_RUN: SkillRunScope = { projectId: null, workspaceId: null };

/**
 * Whether a skill's scope takes in this run (EO-470).
 *
 * The one rule, in `packages/core` because both backends' deliveries ask
 * it — the Claude plugin directory and the Codex `.agent/skills` folder
 * with the list in its prompt (invariant 12) — and two copies of a rule
 * like this is how one backend came to deliver a name the other refused
 * (EO-151). Nothing about enabled or archived is decided here; that is
 * `isDeliverable`, and the two compose.
 */
export function skillInRunScope(scope: SkillScope, run: SkillRunScope): boolean {
  switch (scope.kind) {
    case "global":
      return true;
    case "project":
      return run.projectId !== null && scope.projectId === run.projectId;
    case "workspace":
      return run.workspaceId !== null && scope.workspaceId === run.workspaceId;
  }
}

/**
 * The skills, out of those attached, whose scope takes in this run.
 *
 * Absent run scope reads as `UNSCOPED_RUN` — global skills only — rather
 * than as "everything": a caller that did not say where the run works
 * must not be handed a procedure meant for one repository.
 */
export function skillsForRun<T extends { scope: SkillScope }>(skills: readonly T[], run: SkillRunScope | undefined): T[] {
  const where = run ?? UNSCOPED_RUN;
  return skills.filter((skill) => skillInRunScope(skill.scope, where));
}

/**
 * Who created a skill (EO-714). A person editing an agent's skill does not
 * change it: it decides only whether the skill may be archived
 * automatically, which a person's never is.
 */
export const SkillOwnerSchema = z.enum(["person", "agent"]);
export type SkillOwner = z.infer<typeof SkillOwnerSchema>;

export const SkillSchema = z.object({
  id: z.string(),
  /**
   * The identifier, and the only thing a model can invoke.
   *
   * Also the directory name under `skills/`, which is why it is held to
   * a narrower shape than a display name and why two skills may not
   * share one.
   */
  slug: z.string(),
  /** What a person calls it. Never what is offered to the model. */
  name: z.string(),
  /**
   * What the model reads to decide whether this skill is the one.
   *
   * Required for that reason: a skill with no description is in the
   * list and never chosen, which reads exactly like a skill that is
   * broken.
   */
  description: z.string(),
  /** The markdown below the frontmatter — what the model reads once it has chosen. */
  body: z.string(),
  files: z.array(SkillFileSchema),
  /**
   * Present on disk, absent from what the model is choosing between.
   *
   * For a skill somebody invokes deliberately, or one that is half
   * written: a way to keep it installed without it competing for the
   * model's attention. Distinct from `enabled`, which is about whether
   * it is delivered at all.
   */
  disableModelInvocation: z.boolean(),
  /**
   * Whether this skill is offered at all.
   *
   * Distinct from archived: disabled is a switch a person flips while
   * they work out whether a skill is helping, archived is "I am done
   * with this". Attachment (EO-106) reads both.
   */
  enabled: z.boolean(),
  /**
   * Which runs it reaches (EO-470) — see `SkillScopeSchema`.
   *
   * Defaulted when absent so that an organisation's published section
   * written before scopes existed still reads, as what it meant then:
   * global.
   */
  scope: SkillScopeSchema.default(GLOBAL_SKILL_SCOPE),
  createdAt: z.number(),
  updatedAt: z.number(),
  /** Archived rather than deleted — a run that used it still points at it (invariant #3). */
  archivedAt: z.number().nullable(),
  /**
   * Who created it (EO-714) — see `SkillOwnerSchema`. Defaulted so a
   * published section or a record from before ownership reads as what
   * every skill then was: a person's.
   */
  createdBy: SkillOwnerSchema.default("person"),
  /**
   * A person's lock (EO-714): while set, every write whose author is not a
   * person is refused and nothing is written. Defaulted for `createdBy`'s
   * reason.
   */
  locked: z.boolean().default(false),
});

export type Skill = z.infer<typeof SkillSchema>;

/**
 * Who wrote one version of a skill (EO-714).
 *
 * A person; a run, by its id; a memory consolidation, by its id; one of
 * EO's system agents, by its id, writing through the administrative MCP
 * host — the turn's own credential names it, never the caller's word; or
 * the organisation's record, for a copy this machine took from it — the
 * write itself was made, and versioned, where the record is.
 */
export const SkillAuthorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("person") }),
  z.object({ kind: z.literal("run"), runId: z.string() }),
  z.object({ kind: z.literal("consolidation"), consolidationId: z.string() }),
  z.object({ kind: z.literal("agent"), agentId: z.string() }),
  z.object({ kind: z.literal("record") }),
  /** EO itself (EO-720): archiving an agent's skill nobody loads. Never a person's write, so a lock refuses it. */
  z.object({ kind: z.literal("eo") }),
]);
export type SkillAuthor = z.infer<typeof SkillAuthorSchema>;

export const PERSON_SKILL_AUTHOR: SkillAuthor = { kind: "person" };

/** Who wrote one version of a skill, as the subject of a sentence — the same words on the Skills screen and over MCP (EO-714). */
export function skillAuthorLabel(author: SkillAuthor): string {
  switch (author.kind) {
    case "person":
      return "a person";
    case "run":
      return `run ${author.runId}`;
    case "consolidation":
      return `memory consolidation ${author.consolidationId}`;
    case "agent":
      return `system agent ${author.agentId}`;
    case "record":
      return "the organisation's record";
    case "eo":
      return "EO";
  }
}

/** What one write did, as a person reads it in a skill's history (EO-714). */
export function skillVersionActionLabel(action: SkillVersionAction): string {
  switch (action) {
    case "create":
      return "Created";
    case "edit":
      return "Edited";
    case "enable":
      return "Switched on";
    case "disable":
      return "Switched off";
    case "archive":
      return "Archived";
    case "restore":
      return "Restored";
    case "lock":
      return "Locked";
    case "unlock":
      return "Unlocked";
    case "sync":
      return "Copied from the record";
  }
}

/** Whether this author is an agent — what a lock refuses (EO-714). The system agent is one, though it acts with the person's authority. */
export function isAgentSkillAuthor(author: SkillAuthor): boolean {
  return author.kind === "run" || author.kind === "consolidation" || author.kind === "agent";
}

/**
 * Who is writing, from what a door stamped on the payload (EO-714): the
 * system agent the administrative MCP host named, or else the person.
 * Every other door strips the field (`withActingAgent`), so absent means
 * the person.
 */
export function skillAuthorFromActingAgent(actingAgentId: string | undefined): SkillAuthor {
  return actingAgentId === undefined ? PERSON_SKILL_AUTHOR : { kind: "agent", agentId: actingAgentId };
}

/** The sentence every write a lock refuses comes back with (EO-714). */
export const SKILL_LOCKED_PROBLEM = "A person locked this skill, so only a person can change it. Nothing was written.";

/** What one write to a skill did (EO-714). `sync` is a copy taken from the organisation's record. */
export const SkillVersionActionSchema = z.enum(["create", "edit", "enable", "disable", "archive", "restore", "lock", "unlock", "sync"]);
export type SkillVersionAction = z.infer<typeof SkillVersionActionSchema>;

/**
 * One write to a skill, as the skill stood after it (EO-714). Append-only:
 * restoring an earlier version files a new one rather than rewriting any.
 */
export const SkillVersionSchema = z.object({
  id: z.string(),
  skillId: z.string(),
  action: SkillVersionActionSchema,
  description: z.string(),
  body: z.string(),
  files: z.array(SkillFileSchema),
  author: SkillAuthorSchema,
  /** The version a `restore` put back; null for every other action. */
  restoredFrom: z.string().nullable(),
  createdAt: z.number(),
});
export type SkillVersion = z.infer<typeof SkillVersionSchema>;

// ── Usage (EO-715) ───────────────────────────────────────────────

/**
 * The run event that records which skills a run was given: the ids, and
 * the slugs the backend offered them under. Written by the supervisor
 * from what the adapter reports it actually delivered — the plugin
 * directory's skills on Claude, the skills `writeWorktreeSkills`
 * delivered on Codex — never from what the agent says. One per run
 * that was given any.
 */
export const SKILLS_DELIVERED_EVENT = "skills_delivered";
export const SkillsDeliveredEventSchema = z.object({
  type: z.literal(SKILLS_DELIVERED_EVENT),
  skillIds: z.array(z.string()),
  slugs: z.array(z.string()),
});
export type SkillsDeliveredEvent = z.infer<typeof SkillsDeliveredEventSchema>;

/**
 * The run event that records a run loading one of the skills it was
 * given: a `Skill` call naming it on Claude, a `skill_read` call EO
 * answered on Codex (EO-721). Once per skill per run; a load of a skill the run
 * was not given records nothing.
 */
export const SKILL_LOADED_EVENT = "skill_loaded";
export const SkillLoadedEventSchema = z.object({
  type: z.literal(SKILL_LOADED_EVENT),
  skillId: z.string(),
  slug: z.string(),
});
export type SkillLoadedEvent = z.infer<typeof SkillLoadedEventSchema>;

/**
 * The run event that closes a run's skill usage (EO-720): appended once,
 * when a run that was given skills ends, after every `skill_loaded` it
 * could write. Its transcript arrives at the organisation's record in
 * order, so the record holding it holds every load of that run. Only a
 * run that has it counts towards a skill's stretch without a load.
 */
export const SKILLS_SETTLED_EVENT = "skills_settled";
export const SkillsSettledEventSchema = z.object({ type: z.literal(SKILLS_SETTLED_EVENT) });
export type SkillsSettledEvent = z.infer<typeof SkillsSettledEventSchema>;

/**
 * How a skill has been used, derived from those three events and never
 * stored (EO-715). Runs, not events.
 *
 * `deliveriesSinceLoad` is the current stretch of finished runs given
 * the skill since it was last loaded or restored — every finished run
 * that was given it, where it has been neither (EO-720). A run counts
 * once it has settled (`SKILLS_SETTLED_EVENT`), so one that may yet load
 * the skill never ages it. What staleness and automatic
 * archival count (`skillState`).
 */
export const SkillUsageSchema = z.object({
  runsDelivered: z.number().int().nonnegative(),
  runsLoaded: z.number().int().nonnegative(),
  lastLoadedAt: z.number().nullable(),
  deliveriesSinceLoad: z.number().int().nonnegative(),
});
export type SkillUsage = z.infer<typeof SkillUsageSchema>;

/** A skill never delivered and never loaded. */
export const NO_SKILL_USAGE: SkillUsage = { runsDelivered: 0, runsLoaded: 0, lastLoadedAt: null, deliveriesSinceLoad: 0 };

// ── Staleness and automatic archival (EO-720) ────────────────────

/**
 * Where a skill stands (EO-720). `archived` is the row's own `archivedAt`;
 * `stale` is derived from its usage and the guardrails each time it is
 * asked, never stored: an agent-written, unlocked skill given to
 * `staleAfterRuns` runs in a row without one loading it. Loading it, or a
 * restore, starts the stretch again, so it is `active` again.
 */
export const SkillStateSchema = z.enum(["active", "stale", "archived"]);
export type SkillState = z.infer<typeof SkillStateSchema>;

/** The two guardrails staleness and automatic archival count against, in runs rather than days: an idle project ages nothing. */
export interface SkillAgeing {
  staleAfterRuns: number;
  archiveAfterRuns: number;
}

export const DEFAULT_SKILL_STALE_AFTER_RUNS = 20;
export const DEFAULT_SKILL_ARCHIVE_AFTER_RUNS = 50;

/**
 * Whether a skill ages at all (EO-720): an agent's, and not locked. A
 * person's skill and a locked one are only reported — their usage is
 * shown like any other's — and never marked stale or archived by EO.
 */
export function skillAgesAutomatically(skill: Pick<Skill, "createdBy" | "locked">): boolean {
  return skill.createdBy === "agent" && !skill.locked;
}

/** Where a skill stands, from its row, its usage and the guardrails in force (EO-720). */
export function skillState(skill: Pick<Skill, "createdBy" | "locked" | "archivedAt">, usage: SkillUsage, ageing: SkillAgeing): SkillState {
  if (skill.archivedAt !== null) return "archived";
  return skillAgesAutomatically(skill) && usage.deliveriesSinceLoad >= ageing.staleAfterRuns ? "stale" : "active";
}

/** Whether EO archives this skill on its next pass (EO-720): a live skill that ages, given `archiveAfterRuns` runs in a row with no load. */
export function skillDueForArchive(skill: Pick<Skill, "createdBy" | "locked" | "archivedAt">, usage: SkillUsage, ageing: SkillAgeing): boolean {
  return skill.archivedAt === null && skillAgesAutomatically(skill) && usage.deliveriesSinceLoad >= ageing.archiveAfterRuns;
}

/** One skill as the catalogue lists it: the skill, its usage, and where it stands (EO-720). */
export const SkillListEntrySchema = SkillSchema.extend({ usage: SkillUsageSchema, state: SkillStateSchema });
export type SkillListEntry = z.infer<typeof SkillListEntrySchema>;

/**
 * What a supporting file's path may look like.
 *
 * A relative path in ordinary characters, one or more segments. This is
 * written under a generated directory (EO-107), so the shape is the
 * whole defence: no leading slash, no drive letter, no backslash, and —
 * with `.` and `..` refused as segments below — nothing that resolves
 * outside the skill's own directory.
 */
const SKILL_FILE_PATH_PATTERN = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

/** The one filename a supporting file may not take: the body is written there. */
const RESERVED_SKILL_FILE = "skill.md";

/**
 * What a caller sends to save a skill: flat, tolerant, and typed.
 *
 * `slug` is nullable rather than required. A person naming a skill "PR
 * review" should not have to invent `pr-review` as well, so absent means
 * "decide one for me" and `saveSkill` asks `allocateSkillSlugs` — the
 * pure half — with the slugs the catalogue has already spent. Present
 * means they chose, and a choice that is not a slug comes back as a
 * sentence rather than being silently rewritten under them.
 */
export const SkillDraftSchema = z.object({
  /** Absent creates; present edits that skill in place. */
  id: z.string().optional(),
  /** Absent on a create means "decide one"; absent on an edit means "keep the one it has". */
  slug: z.string().nullable().default(null),
  name: z.string(),
  description: z.string(),
  body: z.string(),
  files: z.array(SkillFileSchema).default([]),
  /**
   * Optional with no default, deliberately — the note on `enabled`
   * applies to this in the same way.
   */
  disableModelInvocation: z.boolean().optional(),
  /**
   * Optional with no default, deliberately.
   *
   * A `.default(true)` here is not a default at all on an edit: it makes
   * `enabled` always present, so a form that fixes a typo in the body
   * and does not think about the switch turns a skill somebody had
   * deliberately turned off back on — silently, because nothing about
   * editing a body says anything about being enabled. Absent means
   * "leave it as it is"; `saveSkill` defaults a *new* row to on.
   * `McpServerDraftSchema.enabled` carries the same note.
   */
  enabled: z.boolean().optional(),
  /**
   * Optional with no default, for `enabled`'s reason: absent on an edit
   * means "leave the scope as it is", so a form that only fixes a typo
   * cannot move a project's skill back to global. A new row is global
   * unless the caller says otherwise.
   */
  scope: SkillScopeSchema.optional(),
});

export type SkillDraft = z.infer<typeof SkillDraftSchema>;

/** A draft that is well-formed, or the sentences saying why it is not. */
export type SkillDraftResult =
  | {
      ok: true;
      /** The slug they asked for, or null for "decide one" — see `SkillDraftSchema.slug`. */
      slug: string | null;
      name: string;
      description: string;
      body: string;
      files: SkillFile[];
      disableModelInvocation: boolean | undefined;
      enabled: boolean | undefined;
      scope: SkillScope | undefined;
    }
  | { ok: false; problems: string[] };

/**
 * Everything wrong with a supporting file's path, or nothing.
 *
 * Written as a list because a path can be wrong in more than one way at
 * once, and the person fixing it should see all of them.
 */
function filePathProblems(path: string): string[] {
  const problems: string[] = [];
  if (path === "") return ["A supporting file needs a path."];

  if (!SKILL_FILE_PATH_PATTERN.test(path)) {
    problems.push(`"${path}" cannot be a supporting file's path: use a relative path in letters, digits, dots, hyphens, underscores and forward slashes.`);
  }
  // Checked separately from the pattern, which allows both as segments
  // so that this can say what is actually wrong with them. A skill's
  // files are written into a directory EO generates, and a path that
  // climbs out of it writes somewhere nobody asked for.
  if (path.split("/").some((segment) => segment === "." || segment === "..")) {
    problems.push(`"${path}" has to stay inside the skill's own folder — no "." or ".." in it.`);
  }
  if (path.toLowerCase() === RESERVED_SKILL_FILE) {
    problems.push(`"${path}" is the skill's own file — its body is what goes there. Give the supporting file another name.`);
  }
  return problems;
}

/**
 * Narrows a draft to a skill, or says everything that is wrong with it
 * (EO-105).
 *
 * Every problem at once rather than the first: a person fixing a form
 * one refusal per save is being made to play a guessing game with a
 * dialog box. Sentences rather than codes, because they are shown as
 * written.
 *
 * Pure, and in `packages/core` for that reason — the repository and the
 * IPC command both apply it, and neither should be the only place a
 * malformed skill is caught. It refuses; it never throws. Throwing is
 * for programmer error, and a person typing a path wrong is not one.
 */
export function readSkillDraft(draft: SkillDraft): SkillDraftResult {
  const problems: string[] = [];

  const name = draft.name.trim();
  if (name === "") problems.push("A skill needs a name.");

  const description = draft.description.trim();
  if (description === "") problems.push("A skill needs a description — it is what the model reads to decide whether to use it.");

  const body = draft.body;
  if (body.trim() === "") problems.push("A skill needs a body — it is what the model reads once it has picked the skill.");

  const asked = draft.slug === null ? "" : draft.slug.trim();
  let slug: string | null = null;
  if (asked !== "") {
    if (asked.length > SKILL_SLUG_MAX_LENGTH) {
      problems.push(`"${asked}" is too long for a slug — ${String(SKILL_SLUG_MAX_LENGTH)} characters at most.`);
    } else if (!SKILL_SLUG_PATTERN.test(asked)) {
      // Suggested rather than applied. The slug is what a model
      // invokes, so rewriting it under somebody who typed one is
      // changing the identifier they are about to put in a prompt.
      problems.push(`"${asked}" cannot be a slug: it is the only name a model can invoke, so use lowercase letters and digits with single hyphens between them — "${slugifySkillName(asked)}", for instance.`);
    } else {
      slug = asked;
    }
  }

  const files: SkillFile[] = [];
  const seen = new Set<string>();
  for (const file of draft.files) {
    const path = file.path.trim();
    const pathProblems = filePathProblems(path);
    if (pathProblems.length > 0) {
      problems.push(...pathProblems);
      continue;
    }
    if (seen.has(path)) {
      problems.push(`"${path}" is listed twice — one path holds one file.`);
      continue;
    }
    seen.add(path);
    files.push({ path, content: file.content });
  }

  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, slug, name, description, body, files, disableModelInvocation: draft.disableModelInvocation, enabled: draft.enabled, scope: draft.scope };
}
