import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import {
  allocateSkillSlugs,
  GLOBAL_SKILL_SCOPE,
  readSkillDraft,
  uuidv7,
  type RecordCursor,
  type RecordSkill,
  type Skill,
  type SkillDraft,
  type SkillFile,
  type SkillScope,
  type Uuid,
} from "@eo/core";
import type { Db } from "../client.js";
import { projects, skills, workspaces } from "../schema.js";

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
  };
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
export function saveSkill(db: Db, draft: SkillDraft, now: number = Date.now()): SaveSkillResult {
  const read = readSkillDraft(draft);
  if (!read.ok) return { ok: false, problems: read.problems };

  const existing = draft.id === undefined ? undefined : getSkill(db, draft.id);
  if (draft.id !== undefined && !existing) return { ok: false, problems: [`No skill ${draft.id}.`] };

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

  if (existing) {
    db.update(skills).set(values).where(eq(skills.id, existing.id)).run();
    return { ok: true, skill: getSkill(db, existing.id)! };
  }

  const row = db
    .insert(skills)
    .values({ id: uuidv7(), createdAt: now, archivedAt: null, ...values })
    .returning()
    .get();
  return { ok: true, skill: toSkill(row) };
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
 */
export function upsertReplicaSkill(db: Db, skill: Skill, projectId?: string | null): void {
  standAside(db, skill.id, skill.slug);
  // The record's word where it gave one (EO-513) — a moved workspace's
  // skill names a workspace this machine may not have — and otherwise
  // what this machine's own workspaces say.
  const here = getSkill(db, skill.id);
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
      },
    })
    .run();
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
export function writeMovedSkill(db: Db, skill: RecordSkill, projectId: string): void {
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
  };
  db.insert(skills)
    .values({ id: skill.id, createdAt: skill.createdAt, ...columns })
    .onConflictDoUpdate({ target: skills.id, set: columns })
    .run();
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
 * Does nothing in the ordinary case, which is the same row arriving
 * again by its own id.
 */
function standAside(db: Db, id: string, slug: string): void {
  const taken = db.select({ id: skills.id }).from(skills).where(eq(skills.slug, slug)).get();
  if (taken === undefined || taken.id === id) return;
  const at = Date.now();
  db.update(skills)
    .set({ slug: `${slug}-local-${taken.id.slice(-6)}`, enabled: false, archivedAt: at, updatedAt: at, localChangedAt: at })
    .where(eq(skills.id, taken.id))
    .run();
}

export function setSkillEnabled(db: Db, id: string, enabled: boolean, at: number = Date.now()): boolean {
  if (!getSkill(db, id)) return false;
  db.update(skills).set({ enabled, updatedAt: at, localChangedAt: Date.now() }).where(eq(skills.id, id)).run();
  return true;
}

/** Deleting a skill archives it — see the column's note and invariant #3. */
export function archiveSkill(db: Db, id: string, at: number = Date.now()): boolean {
  if (!getSkill(db, id)) return false;
  db.update(skills).set({ archivedAt: at, updatedAt: at, localChangedAt: Date.now() }).where(eq(skills.id, id)).run();
  return true;
}
