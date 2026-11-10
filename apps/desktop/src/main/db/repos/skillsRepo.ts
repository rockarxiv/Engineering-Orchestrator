import { and, asc, desc, eq, isNotNull, sql } from "drizzle-orm";
import {
  allocateSkillSlugs,
  GLOBAL_SKILL_SCOPE,
  isAgentSkillAuthor,
  PERSON_SKILL_AUTHOR,
  readSkillDraft,
  SKILL_LOCKED_PROBLEM,
  SkillSchema,
  SkillVersionActionSchema,
  uuidv7,
  type RecordCursor,
  type RecordSkill,
  type Skill,
  type SkillAuthor,
  type SkillDraft,
  type SkillFile,
  type SkillScope,
  type SkillVersion,
  type SkillVersionAction,
  type Uuid,
} from "@eo/core";
import type { Db } from "../client.js";
import { heldSkillCopies, projects, skills, skillVersions, workspaces } from "../schema.js";

/**
 * The skill catalogue's rows (EO-105).
 *
 * Nothing here dispatches, attaches or generates anything: this is the
 * record, deliberately landed first so the shape of a skill is settled
 * while it is still cheap to change — the same order the module and MCP
 * server catalogues went in.
 *
 * Every write goes through `readSkillDraft`, which is pure and lives in
 * `packages/core`. A malformed skill comes back as sentences rather than
 * as a throw, here as well as at the IPC boundary, so a caller that
 * reaches the repository directly cannot write a row that `SkillSchema`
 * would refuse to read back.
 */

/**
 * A row's supporting files, narrowed to what they are.
 *
 * A row is trusted to the extent that it was written through
 * `saveSkill`, and no further: a JSON column holding something else
 * could only come from a hand-edited database, and it is answered here
 * with no files rather than a crash, because a catalogue that cannot be
 * listed is worse than one entry that reads as empty.
 */
function toFiles(value: unknown): SkillFile[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const { path, content } = entry as { path?: unknown; content?: unknown };
    return typeof path === "string" && typeof content === "string" ? [{ path, content }] : [];
  });
}

/**
 * A row's two scope columns, as the scope they spell (EO-470).
 *
 * A scoped row with no id, or a kind this build does not know, could
 * only come from a hand-edited database or a newer EO. It reads as a
 * scope no run is in rather than as global: a procedure somebody meant
 * for one repository must not start reaching every run because its row
 * could not be read.
 */
function toScope(scope: string, scopeId: string | null): SkillScope {
  if (scope === "global") return GLOBAL_SKILL_SCOPE;
  if (scope === "project") return { kind: "project", projectId: scopeId ?? "" };
  if (scope === "workspace") return { kind: "workspace", workspaceId: scopeId ?? "" };
  return { kind: "project", projectId: "" };
}

/** A scope as the two columns that hold it. */
function scopeColumns(scope: SkillScope): { scope: string; scopeId: string | null } {
  switch (scope.kind) {
    case "global":
      return { scope: "global", scopeId: null };
    case "project":
      return { scope: "project", scopeId: scope.projectId };
    case "workspace":
      return { scope: "workspace", scopeId: scope.workspaceId };
  }
}

/**
 * The project a skill in this scope belongs to (EO-513) — the column a
 * record pages a moved project's skills by, since it never has the
 * workspace a workspace's skill names.
 *
 * A workspace this database does not have — on the record, always —
 * keeps the project the row already says, where the row is the same
 * workspace's: an edit on the record to a moved workspace's skill must
 * not take it off its project.
 */
function projectOfScope(db: Db, scope: SkillScope, existing?: { scope: SkillScope; projectId: string | null }): string | null {
  switch (scope.kind) {
    case "global":
      return null;
    case "project":
      return scope.projectId;
    case "workspace": {
      const workspace = db.select({ projectId: workspaces.projectId }).from(workspaces).where(eq(workspaces.id, scope.workspaceId)).get();
      if (workspace !== undefined) return workspace.projectId;
      return existing?.scope.kind === "workspace" && existing.scope.workspaceId === scope.workspaceId ? existing.projectId : null;
    }
  }
}

/** The project a row already says it belongs to, for `projectOfScope`. */
function projectColumnOf(db: Db, id: string): string | null {
  return db.select({ projectId: skills.projectId }).from(skills).where(eq(skills.id, id)).get()?.projectId ?? null;
}

function toSkill(row: typeof skills.$inferSelect): Skill {
  return {
    id: row.id as Uuid,
    slug: row.slug,
    name: row.name,
    description: row.description,
    body: row.body,
    files: toFiles(row.files),
    disableModelInvocation: row.disableModelInvocation,
    enabled: row.enabled,
    scope: toScope(row.scope, row.scopeId),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    archivedAt: row.archivedAt,
    // Anything but `agent` is a person's: a row this build cannot read is
    // never one an automatic archive may take (EO-714).
    createdBy: row.createdBy === "agent" ? "agent" : "person",
    locked: row.locked,
  };
}

// ── History (EO-714) ────────────────────────────────────────────────

/**
 * Files one version: the skill as it stands after a write, and who made
 * the write. The only writer of `skill_versions`, and it only inserts —
 * the table is append-only, as `run_events` is.
 */
function appendVersion(
  db: Db,
  skill: Pick<Skill, "id" | "description" | "body" | "files">,
  action: SkillVersionAction,
  author: SkillAuthor,
  at: number,
  restoredFrom: string | null = null,
): void {
  db.insert(skillVersions)
    .values({
      id: uuidv7(),
      skillId: skill.id,
      action,
      description: skill.description,
      body: skill.body,
      files: skill.files,
      authorKind: author.kind,
      authorId: authorIdOf(author),
      restoredFrom,
      createdAt: at,
    })
    .run();
}

/** The id a version row keeps beside its author's kind; null for a person and the record. */
function authorIdOf(author: SkillAuthor): string | null {
  switch (author.kind) {
    case "run":
      return author.runId;
    case "consolidation":
      return author.consolidationId;
    case "agent":
      return author.agentId;
    case "person":
    case "record":
      return null;
  }
}

/**
 * A row's author, narrowed. A kind this build does not know, or an agent
 * kind with no id, reads as the record's — never as a person's, which a
 * lock would let through.
 */
function toAuthor(kind: string, id: string | null): SkillAuthor {
  if (kind === "person") return PERSON_SKILL_AUTHOR;
  if (kind === "run" && id !== null) return { kind: "run", runId: id };
  if (kind === "consolidation" && id !== null) return { kind: "consolidation", consolidationId: id };
  if (kind === "agent" && id !== null) return { kind: "agent", agentId: id };
  return { kind: "record" };
}

function toVersion(row: typeof skillVersions.$inferSelect): SkillVersion {
  const action = SkillVersionActionSchema.safeParse(row.action);
  return {
    id: row.id,
    skillId: row.skillId,
    action: action.success ? action.data : "edit",
    description: row.description,
    body: row.body,
    files: toFiles(row.files),
    author: toAuthor(row.authorKind, row.authorId),
    restoredFrom: row.restoredFrom,
    createdAt: row.createdAt,
  };
}

/** Every write to one skill, newest first (EO-714). */
export function listSkillVersions(db: Db, skillId: string): SkillVersion[] {
  return db
    .select()
    .from(skillVersions)
    .where(eq(skillVersions.skillId, skillId))
    .orderBy(desc(skillVersions.createdAt), desc(skillVersions.id))
    .all()
    .map(toVersion);
}

/** What a write that is not a save answers with: the skill as it now stands, or the sentence saying why nothing was written. */
export type SkillWriteResult = { ok: true; skill: Skill } | { ok: false; problem: string };

/** Why this author may not write to this skill, or null (EO-714): a lock refuses every author that is not a person. */
function lockRefusal(skill: Skill, author: SkillAuthor): string | null {
  return skill.locked && author.kind !== "person" ? SKILL_LOCKED_PROBLEM : null;
}

/**
 * Every live skill, by slug.
 *
 * Archived ones are excluded here rather than by each caller, the way
 * `listModules` and `listMcpServers` do it: an archived skill is kept so
 * that whatever referred to it still has something to point at, not so
 * that it keeps appearing in a picker.
 */
export function listSkills(db: Db, includeArchived = false): Skill[] {
  const rows = db.select().from(skills).orderBy(asc(skills.slug)).all().map(toSkill);
  return includeArchived ? rows : rows.filter((skill) => skill.archivedAt === null);
}

export function getSkill(db: Db, id: string): Skill | undefined {
  const row = db.select().from(skills).where(eq(skills.id, id)).get();
  return row ? toSkill(row) : undefined;
}

export function getSkillBySlug(db: Db, slug: string): Skill | undefined {
  const row = db.select().from(skills).where(eq(skills.slug, slug)).get();
  return row ? toSkill(row) : undefined;
}

export type SaveSkillResult = { ok: true; skill: Skill } | { ok: false; problems: string[] };

/**
 * The slug this save should write, or the sentence saying why it cannot.
 *
 * Three cases, and they are genuinely different acts. A slug somebody
 * typed is a choice, so a clash is refused rather than resolved —
 * silently handing back `pr-review-2` to a person who typed `pr-review`
 * gives them an identifier they will not put in the prompt they were
 * about to write. An edit that says nothing keeps what the row has,
 * because the slug is what a model invokes and a rename is never a side
 * effect of fixing a typo in the body. And a create that says nothing
 * asks the pure allocator.
 *
 * `listSkills(db, true)` — archived included — is what the allocator is
 * told is taken, because the unique index does not care whether a row is
 * archived and neither should this.
 *
 * Note what is *not* here: what is on disk. That is the other half of
 * slug allocation, it lives in `main/skills/slugsOnDisk.ts`, and the two
 * answer different questions — this one is about the catalogue, that one
 * about a generated directory that may also hold skills EO did not put
 * there. Deciding both in one place is the gap multica still has open as
 * MUL-5550.
 */
function slugFor(db: Db, asked: string | null, name: string, existing: Skill | undefined): { ok: true; slug: string } | { ok: false; problems: string[] } {
  if (asked !== null) {
    const bySlug = getSkillBySlug(db, asked);
    if (bySlug && bySlug.id !== existing?.id) return { ok: false, problems: [`Another skill already uses the slug "${asked}".`] };
    return { ok: true, slug: asked };
  }
  if (existing) return { ok: true, slug: existing.slug };

  const taken = listSkills(db, true).map((skill) => skill.slug);
  const [allocated] = allocateSkillSlugs([{ name }], taken);
  return { ok: true, slug: allocated ?? name };
}

/**
 * Creates or edits a skill.
 *
 * A refusal is a list of sentences and never an exception: a slug
 * somebody typed, a supporting file with `..` in its path and a
 * duplicate are all things a person did, and throwing is for programmer
 * error.
 */
export function saveSkill(db: Db, draft: SkillDraft, now: number = Date.now(), author: SkillAuthor = PERSON_SKILL_AUTHOR): SaveSkillResult {
  const read = readSkillDraft(draft);
  if (!read.ok) return { ok: false, problems: read.problems };

  const existing = draft.id === undefined ? undefined : getSkill(db, draft.id);
  if (draft.id !== undefined && !existing) return { ok: false, problems: [`No skill ${draft.id}.`] };
  const locked = existing === undefined ? null : lockRefusal(existing, author);
  if (locked !== null) return { ok: false, problems: [locked] };

  const slug = slugFor(db, read.slug, read.name, existing);
  if (!slug.ok) return { ok: false, problems: slug.problems };

  const scope = read.scope ?? existing?.scope ?? GLOBAL_SKILL_SCOPE;
  const values = {
    slug: slug.slug,
    name: read.name,
    description: read.description,
    body: read.body,
    files: read.files,
    // Absent means "leave it as it is" for both switches: a save that
    // fixes a body must not quietly start offering a skill somebody had
    // turned off, or stop offering one they had left on. A new row is
    // enabled and model-invocable unless the caller said otherwise — see
    // the draft's own note.
    disableModelInvocation: read.disableModelInvocation ?? existing?.disableModelInvocation ?? false,
    enabled: read.enabled ?? existing?.enabled ?? true,
    // Absent means "leave it", for the switches' reason; a new row is
    // global, which is what every skill was before scopes (EO-470).
    ...scopeColumns(scope),
    projectId: projectOfScope(db, scope, existing === undefined ? undefined : { scope: existing.scope, projectId: projectColumnOf(db, existing.id) }),
    updatedAt: now,
    localChangedAt: Date.now(),
  };

  return db.transaction(() => {
    if (existing) {
      db.update(skills).set(values).where(eq(skills.id, existing.id)).run();
      const skill = getSkill(db, existing.id)!;
      appendVersion(db, skill, "edit", author, now);
      return { ok: true, skill };
    }

    // An agent's skill is the agent's from its first version (EO-714); a
    // person editing it later does not change that.
    const createdBy = isAgentSkillAuthor(author) ? "agent" : "person";
    const row = db
      .insert(skills)
      .values({ id: uuidv7(), createdAt: now, archivedAt: null, createdBy, locked: false, ...values })
      .returning()
      .get();
    const skill = toSkill(row);
    appendVersion(db, skill, "create", author, now);
    return { ok: true, skill };
  });
}

/**
 * Turns a skill on or off.
 *
 * Its own function rather than a field on the save, so switching one off
 * cannot change what it says in the same breath — the same reason
 * `approveModule` is separate from `saveModule`.
 */
/**
 * A skill as a pack's publisher has it, into this replica (EO-329).
 *
 * Wholesale and by the record's id, for `upsertReplicaAgent`'s reason:
 * an attachment row names a skill by id, so a copy renumbered in
 * transit would be a skill nothing is attached to.
 *
 * Not through `saveSkill`: that path decides a slug, validates a draft
 * and answers with problems for a person to read. There is no person
 * here and nothing to decide — the organisation already decided, and a
 * replica that could refuse half a publication would hold a
 * configuration nobody has.
 *
 * A local skill of the same slug stands aside — see `standAside`. The
 * slug is unique and is what a model invokes, so two rows claiming it
 * is not a state SQLite will hold or an agent could act on.
 *
 * Unless that local skill is locked (EO-714): a person's lock refuses
 * every write a person did not make, and archiving their skill to make
 * room is one. The arriving skill is then refused whole — nothing is
 * renamed, archived or written — with the sentence saying why, for the
 * caller to say where a person will see it. An agent attached to it holds
 * the attachment until it arrives, as it does for any tool not here yet.
 */
export function upsertReplicaSkill(db: Db, skill: Skill, projectId?: string | null): ReplicaSkillResult {
  return db.transaction(() => upsertReplicaSkillIn(db, skill, projectId));
}

/** A copy from the record written, or the sentence saying why nothing was (EO-714). */
export type ReplicaSkillResult = { ok: true } | { ok: false; problem: string };

function upsertReplicaSkillIn(db: Db, skill: Skill, projectId?: string | null): ReplicaSkillResult {
  const here = getSkill(db, skill.id);
  const locked = copyLockRefusal(here, skill);
  if (locked !== null) return { ok: false, problem: locked };
  const blocker = slugHolder(db, skill.id, skill.slug);
  if (blocker?.locked === true) {
    return {
      ok: false,
      problem:
        `EO did not take your organisation's skill "${skill.slug}" onto this machine: a person locked this machine's own skill "${skill.slug}", ` +
        "so it was not archived to make room, and nothing was written. The organisation's skill is held here, and arrives as soon as you " +
        "unlock or rename yours on the Skills screen.",
    };
  }
  if (blocker !== undefined) standAside(db, blocker.id, skill.slug);
  // The record's word where it gave one (EO-513) — a moved workspace's
  // skill names a workspace this machine may not have — and otherwise
  // what this machine's own workspaces say.
  const project =
    projectId !== undefined
      ? projectId
      : projectOfScope(db, skill.scope, here === undefined ? undefined : { scope: here.scope, projectId: projectColumnOf(db, here.id) });
  db.insert(skills)
    .values({
      id: skill.id,
      slug: skill.slug,
      name: skill.name,
      description: skill.description,
      body: skill.body,
      files: skill.files,
      disableModelInvocation: skill.disableModelInvocation,
      enabled: skill.enabled,
      ...scopeColumns(skill.scope),
      projectId: project,
      createdAt: skill.createdAt,
      updatedAt: skill.updatedAt,
      localChangedAt: Date.now(),
      archivedAt: skill.archivedAt,
      createdBy: skill.createdBy,
      locked: skill.locked,
    })
    .onConflictDoUpdate({
      target: skills.id,
      set: {
        slug: skill.slug,
        name: skill.name,
        description: skill.description,
        body: skill.body,
        files: skill.files,
        disableModelInvocation: skill.disableModelInvocation,
        enabled: skill.enabled,
        ...scopeColumns(skill.scope),
        projectId: project,
        updatedAt: skill.updatedAt,
        localChangedAt: Date.now(),
        archivedAt: skill.archivedAt,
        createdBy: skill.createdBy,
        locked: skill.locked,
      },
    })
    .run();
  versionCopy(db, here, skill.id);
  // Whatever was held for it is spent: this copy is the newest (EO-714).
  db.delete(heldSkillCopies).where(eq(heldSkillCopies.skillId, skill.id)).run();
  return { ok: true };
}

/**
 * Why a copy from the record may not be written over this row, or null
 * (EO-714). The record is not a person, so a lock set here refuses its
 * copy as it refuses any author that is not one.
 *
 * Except a copy that arrives locked itself. The record holds the same
 * lock and refuses every author but a person under it, so what it sends
 * locked was written by a person — refusing it would keep a person's own
 * edit, made on another machine, off this one for good.
 */
function copyLockRefusal(here: Skill | undefined, copy: Skill): string | null {
  if (here === undefined || !here.locked || copy.locked) return null;
  return (
    `EO did not write your organisation's newer copy of the skill "${here.slug}" over this machine's: a person locked it here, ` +
    "so nothing was written. The newer copy is held here, and replaces yours as soon as you unlock it on the Skills screen."
  );
}

// ── Copies a lock kept out, held rather than dropped (EO-714) ──────

/** A held copy, as the person is told of it. */
export interface HeldSkillCopy {
  skill: Skill;
  /** The project the record gave it, or null for a published section's. */
  projectId: string | null;
  problem: string;
  heldAt: number;
  toldAt: number | null;
}

function toHeld(row: typeof heldSkillCopies.$inferSelect): HeldSkillCopy | undefined {
  const skill = SkillSchema.safeParse(row.copy);
  return skill.success ? { skill: skill.data, projectId: row.projectId, problem: row.problem, heldAt: row.heldAt, toldAt: row.toldAt } : undefined;
}

/**
 * Keeps a copy the lock refused, to write once the lock no longer stands
 * in its way. A newer copy of the same skill replaces the one held; an
 * older one, read out of order, does not.
 */
export function holdSkillCopy(db: Db, skill: Skill, projectId: string | undefined, problem: string, at: number = Date.now()): void {
  const held = db.select().from(heldSkillCopies).where(eq(heldSkillCopies.skillId, skill.id)).get();
  const current = held === undefined ? undefined : toHeld(held);
  if (current !== undefined && current.skill.updatedAt > skill.updatedAt) return;
  db.insert(heldSkillCopies)
    .values({ skillId: skill.id, copy: skill, projectId: projectId ?? null, problem, heldAt: at, toldAt: null })
    .onConflictDoUpdate({ target: heldSkillCopies.skillId, set: { copy: skill, projectId: projectId ?? null, problem } })
    .run();
}

/** Every held copy, oldest first. */
export function listHeldSkillCopies(db: Db): HeldSkillCopy[] {
  return db
    .select()
    .from(heldSkillCopies)
    .orderBy(asc(heldSkillCopies.heldAt), asc(heldSkillCopies.skillId))
    .all()
    .flatMap((row) => toHeld(row) ?? []);
}

/** Says a person has been told of this held copy, so they are told once. */
export function markHeldSkillCopyTold(db: Db, skillId: string, at: number = Date.now()): void {
  db.update(heldSkillCopies).set({ toldAt: at }).where(eq(heldSkillCopies.skillId, skillId)).run();
}

/**
 * Writes every held copy the lock no longer keeps out — after a person
 * unlocks or renames their skill, and on every pull — and answers with
 * the ids written.
 *
 * Not compared with the row's `updated_at`: unlocking stamps it, so a
 * copy held before the unlock would always look older than the row it
 * was held for. A newer copy from the record needs no comparison either
 * — writing one lets the held copy go (`upsertReplicaSkillIn`).
 */
export function releaseHeldSkillCopies(db: Db): string[] {
  const released: string[] = [];
  for (const held of listHeldSkillCopies(db)) {
    if (upsertReplicaSkill(db, held.skill, held.projectId ?? undefined).ok) released.push(held.skill.id);
  }
  return released;
}

/**
 * Files a `sync` version for a copy taken from the record (EO-714), when
 * it changed anything a person reads in the history — and only then, so
 * a publication applied again, or a page read twice, adds nothing. The
 * write itself was made, and versioned, where the record is.
 */
function versionCopy(db: Db, before: Skill | undefined, id: string): void {
  const after = getSkill(db, id);
  if (after === undefined) return;
  // Every column such a copy writes that a person could see change — a
  // rename or a new scope is a write as much as a new body is.
  const same =
    before !== undefined &&
    before.slug === after.slug &&
    before.name === after.name &&
    before.description === after.description &&
    before.body === after.body &&
    JSON.stringify(before.files) === JSON.stringify(after.files) &&
    before.disableModelInvocation === after.disableModelInvocation &&
    before.enabled === after.enabled &&
    JSON.stringify(before.scope) === JSON.stringify(after.scope) &&
    before.archivedAt === after.archivedAt &&
    before.createdBy === after.createdBy &&
    before.locked === after.locked;
  if (!same) appendVersion(db, after, "sync", { kind: "record" }, Date.now());
}

// ── A project's own skills, as they travel with it (EO-513) ─────────

function toRecordSkill(row: typeof skills.$inferSelect & { projectId: string }): RecordSkill {
  return { ...toSkill(row), projectId: row.projectId };
}

function belongsToAProject(row: typeof skills.$inferSelect): row is typeof skills.$inferSelect & { projectId: string } {
  return row.projectId !== null && row.scope !== "global";
}

/**
 * The project's own skills and its workspaces', archived ones included,
 * oldest first: what travels when it moves (EO-513). Never a global
 * skill — that is the installation's, and an organisation hands those
 * out by publishing the packs section.
 */
export function readProjectSkills(db: Db, projectId: string): RecordSkill[] {
  return db
    .select()
    .from(skills)
    .where(eq(skills.projectId, projectId))
    .orderBy(asc(skills.createdAt), asc(skills.id))
    .all()
    .filter(belongsToAProject)
    .map(toRecordSkill);
}

/** A skill as the record's feed pages it: the row, and the stamp its cursor moves by. */
export interface PagedSkill {
  skill: RecordSkill;
  /** `skills.local_changed_at` — when the record last wrote it. */
  changedAt: number;
}

/**
 * The record-held projects' own skills, paged for a replica catching up
 * (EO-513), on when the record last wrote the row and its id. `within`
 * is one project's backfill, as it is for every other list.
 *
 * **A project still arriving is left out in the query, before the
 * limit** (EO-513, review). Filtered afterwards, a page filled with a
 * half-moved project's skills came back empty with the cursor where it
 * was, and every pull read the same hidden rows again while a live
 * project's skills waited behind them for ever. Left out here, the
 * cursor moves past them — and finishing the move stamps them again
 * (`writeAdoptedProject`), so they are offered once they are live.
 */
export function listProjectSkillsUpdatedSince(db: Db, cursor: RecordCursor, limit: number, within?: string): PagedSkill[] {
  return db
    .select()
    .from(skills)
    .where(
      and(
        isNotNull(skills.projectId),
        sql`${skills.scope} <> 'global'`,
        sql`${skills.projectId} not in (select ${projects.id} from ${projects} where ${projects.adoptingAt} is not null)`,
        sql`(${skills.localChangedAt}, ${skills.id}) > (${cursor.ts}, ${cursor.id})`,
        within === undefined ? undefined : eq(skills.projectId, within),
      ),
    )
    .orderBy(asc(skills.localChangedAt), asc(skills.id))
    .limit(limit)
    .all()
    .filter(belongsToAProject)
    .map((row) => ({ skill: toRecordSkill(row), changedAt: row.localChangedAt }));
}

/** Whose skill this row is, where this database holds one under the id — for the record deciding what a move may write. */
export function skillOwner(db: Db, id: string): { projectId: string | null; scope: string; updatedAt: number } | undefined {
  return db.select({ projectId: skills.projectId, scope: skills.scope, updatedAt: skills.updatedAt }).from(skills).where(eq(skills.id, id)).get();
}

/**
 * One of a moved project's skills, onto the record that takes the
 * project (EO-513).
 *
 * By the sender's id, every column as it arrived and the project as the
 * record's own, for `writeAdoptedPage`'s reason. **Not** through
 * `upsertReplicaSkill`: that makes room for the arriving row by
 * archiving whatever holds its slug, which is right on a replica taking
 * the organisation's catalogue and wrong here — on the record, the row
 * holding the slug is the organisation's own, or another project's, and
 * a move is not allowed to retire it. The caller refuses a clash by name
 * before this is reached.
 */
export function writeMovedSkill(db: Db, skill: RecordSkill, projectId: string): ReplicaSkillResult {
  const before = getSkill(db, skill.id);
  // A person's lock on the record refuses the moved copy, as it refuses
  // any author that is not a person (EO-714) — said by the caller, which
  // ends the move with the sentence.
  if (before !== undefined && before.locked && !skill.locked) {
    return { ok: false, problem: `a person locked the skill "${skill.slug}" on this record, so the moved copy was not written over it; unlock it there and move the project again` };
  }
  const columns = {
    slug: skill.slug,
    name: skill.name,
    description: skill.description,
    body: skill.body,
    files: skill.files,
    disableModelInvocation: skill.disableModelInvocation,
    enabled: skill.enabled,
    ...scopeColumns(skill.scope),
    projectId,
    // The sender's version, as it gave it: what a later page of the same
    // move is compared against.
    updatedAt: skill.updatedAt,
    localChangedAt: Date.now(),
    archivedAt: skill.archivedAt,
    createdBy: skill.createdBy,
    locked: skill.locked,
  };
  db.insert(skills)
    .values({ id: skill.id, createdAt: skill.createdAt, ...columns })
    .onConflictDoUpdate({ target: skills.id, set: columns })
    .run();
  versionCopy(db, before, skill.id);
  return { ok: true };
}

/**
 * Makes room for a published row that claims a slug this machine had
 * given to something else (EO-329).
 *
 * The organisation's catalogue wins, because on a published section it
 * is the catalogue — but the row already here is *archived* rather than
 * deleted, for the reason nothing in EO is ever deleted: an attachment,
 * a run's transcript and a comment still point at it. Its slug is moved
 * aside because a slug is unique and is what a model invokes, and an
 * archived row holding the name is a name the organisation's own row
 * cannot have.
 *
 * Only ever asked for an unlocked row: `upsertReplicaSkillIn` refuses the
 * arriving skill instead when a person has locked the one holding the
 * slug (EO-714).
 */
function standAside(db: Db, takenId: string, slug: string): void {
  const taken = { id: takenId };
  const at = Date.now();
  db.update(skills)
    .set({ slug: `${slug}-local-${taken.id.slice(-6)}`, enabled: false, archivedAt: at, updatedAt: at, localChangedAt: at })
    .where(eq(skills.id, taken.id))
    .run();
  // The organisation's catalogue archived it, which the history says (EO-714).
  const archived = getSkill(db, taken.id);
  if (archived !== undefined) appendVersion(db, archived, "archive", { kind: "record" }, at);
}

/**
 * The other skill already holding this slug, if any — none in the
 * ordinary case, which is the same row arriving again by its own id.
 */
function slugHolder(db: Db, id: string, slug: string): { id: string; locked: boolean } | undefined {
  const taken = db.select({ id: skills.id, locked: skills.locked }).from(skills).where(eq(skills.slug, slug)).get();
  return taken === undefined || taken.id === id ? undefined : taken;
}

/** The sentence for an id this database has no skill under. */
const NO_SUCH_SKILL = "That skill no longer exists.";

/**
 * One write that is not a save: the row's columns changed, and the
 * version that says so filed, in one transaction — or the sentence saying
 * why nothing was written (EO-714).
 */
function writeSkill(
  db: Db,
  id: string,
  author: SkillAuthor,
  at: number,
  action: SkillVersionAction,
  columns: Partial<typeof skills.$inferInsert>,
  restoredFrom: string | null = null,
): SkillWriteResult {
  const existing = getSkill(db, id);
  if (existing === undefined) return { ok: false, problem: NO_SUCH_SKILL };
  const locked = lockRefusal(existing, author);
  if (locked !== null) return { ok: false, problem: locked };
  return db.transaction(() => {
    db.update(skills)
      .set({ ...columns, updatedAt: at, localChangedAt: Date.now() })
      .where(eq(skills.id, id))
      .run();
    const skill = getSkill(db, id)!;
    appendVersion(db, skill, action, author, at, restoredFrom);
    return { ok: true, skill };
  });
}

export function setSkillEnabled(db: Db, id: string, enabled: boolean, at: number = Date.now(), author: SkillAuthor = PERSON_SKILL_AUTHOR): SkillWriteResult {
  return writeSkill(db, id, author, at, enabled ? "enable" : "disable", { enabled });
}

/** Deleting a skill archives it — see the column's note and invariant #3. */
export function archiveSkill(db: Db, id: string, at: number = Date.now(), author: SkillAuthor = PERSON_SKILL_AUTHOR): SkillWriteResult {
  return writeSkill(db, id, author, at, "archive", { archivedAt: at });
}

/**
 * Locks or unlocks a skill (EO-714). A person's action only, so it takes
 * no author: no agent's write reaches this function, and EO's
 * administrative MCP host refuses the tool that would.
 */
export function setSkillLocked(db: Db, id: string, locked: boolean, at: number = Date.now()): SkillWriteResult {
  return writeSkill(db, id, PERSON_SKILL_AUTHOR, at, locked ? "lock" : "unlock", { locked });
}

/**
 * Puts one of the skill's earlier versions back (EO-714): its
 * description, body and files, and the skill live again if it was
 * archived. A new version naming who restored it and which version it
 * restored — never a rewrite of either.
 */
export function restoreSkillVersion(db: Db, id: string, versionId: string, at: number = Date.now(), author: SkillAuthor = PERSON_SKILL_AUTHOR): SkillWriteResult {
  const row = db.select().from(skillVersions).where(eq(skillVersions.id, versionId)).get();
  if (row === undefined || row.skillId !== id) return { ok: false, problem: "That version is not one of this skill's." };
  const version = toVersion(row);
  return writeSkill(db, id, author, at, "restore", { description: version.description, body: version.body, files: version.files, archivedAt: null }, version.id);
}
