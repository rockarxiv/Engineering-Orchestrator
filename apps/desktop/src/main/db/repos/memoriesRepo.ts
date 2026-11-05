import { and, asc, desc, eq, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import {
  MEMORY_SCOPE_KINDS,
  uuidv7,
  type MemoryEntryView,
  type MemoryRetirementReason,
  type MemoryScope,
  type MemoryScopeKind,
  type MemorySource,
  type MemoryWriteResult,
  type RecordCursor,
  type RecordMemory,
  type Uuid,
} from "@eo/core";
import type { Db } from "../client.js";
import { items, itemTypes, memories, projects, workspaces } from "../schema.js";

/**
 * Memory entries (EO-478, ARCHITECTURE.md, "What an agent is given").
 *
 * The one module that writes `memories`. Every write keeps what was there
 * before it: an edit retires the old row and inserts a new one, a
 * retirement only stamps `retired_at`, and a restore only clears it. No
 * function here deletes a row.
 */

type Row = typeof memories.$inferSelect;

function toView(row: Row): MemoryEntryView {
  const source: MemorySource =
    row.sourceKind === "run"
      ? { type: "run", runId: row.sourceRunId, itemId: row.sourceItemId, ...(row.extracted ? { extracted: true as const } : {}) }
      : { type: "person", personId: row.sourcePersonId };
  return {
    id: row.id,
    scope: { kind: row.scopeKind as MemoryScopeKind, id: row.scopeId },
    body: row.body,
    source,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    retiredAt: row.retiredAt,
    retiredReason: (row.retiredReason as MemoryRetirementReason | null) ?? null,
    consolidationId: row.consolidationId,
    contradictsRepositoryFile: row.contradictsRepositoryFile,
  };
}

/** One entry as it travels between a record and a replica (EO-482). */
function toRecordMemory(row: Row): RecordMemory {
  return { ...toView(row), projectId: row.projectId, replacesId: row.replacesId, supersededIds: row.supersededIds };
}

function sourceColumns(source: MemorySource): Pick<Row, "sourceKind" | "sourcePersonId" | "sourceRunId" | "sourceItemId" | "extracted"> {
  return source.type === "run"
    ? { sourceKind: "run", sourcePersonId: null, sourceRunId: source.runId, sourceItemId: source.itemId, extracted: source.extracted === true }
    : { sourceKind: "person", sourcePersonId: source.personId, sourceRunId: null, sourceItemId: null, extracted: false };
}

function inScope(scope: MemoryScope): SQL {
  return and(eq(memories.scopeKind, scope.kind), eq(memories.scopeId, scope.id))!;
}

export function getMemory(db: Db, id: string): MemoryEntryView | undefined {
  const row = db.select().from(memories).where(eq(memories.id, id)).get();
  return row ? toView(row) : undefined;
}

/**
 * A scope's entries: the active ones newest first, and — asked for — the
 * retired ones after them, most recently retired first.
 */
export function listMemories(db: Db, scope: MemoryScope, options: { includeRetired?: boolean } = {}): MemoryEntryView[] {
  const active = db
    .select()
    .from(memories)
    .where(and(inScope(scope), isNull(memories.retiredAt)))
    .orderBy(desc(memories.createdAt), desc(memories.id))
    .all();
  if (!options.includeRetired) return active.map(toView);
  const retired = db
    .select()
    .from(memories)
    .where(and(inScope(scope), isNotNull(memories.retiredAt)))
    .orderBy(desc(memories.retiredAt), desc(memories.id))
    .all();
  return [...active, ...retired].map(toView);
}

/**
 * The active entries of several scopes at once, newest first — what a
 * dispatch's candidates are read from. Retired entries are never among
 * them.
 */
export function activeMemoriesIn(db: Db, scopes: readonly MemoryScope[]): MemoryEntryView[] {
  if (scopes.length === 0) return [];
  const byKind = (kind: MemoryScopeKind) => scopes.filter((scope) => scope.kind === kind).map((scope) => scope.id);
  const clauses = MEMORY_SCOPE_KINDS
    .map((kind) => ({ kind, ids: byKind(kind) }))
    .filter((entry) => entry.ids.length > 0)
    .map((entry) => and(eq(memories.scopeKind, entry.kind), inArray(memories.scopeId, entry.ids))!);
  return db
    .select()
    .from(memories)
    .where(and(isNull(memories.retiredAt), or(...clauses)))
    .orderBy(desc(memories.createdAt), desc(memories.id))
    .all()
    .map(toView);
}

/** How many active entries a scope holds. */
export function countActiveMemories(db: Db, scope: MemoryScope): number {
  return (
    db
      .select({ count: sql<number>`count(*)` })
      .from(memories)
      .where(and(inScope(scope), isNull(memories.retiredAt)))
      .get()?.count ?? 0
  );
}

function projectExists(db: Db, projectId: string): boolean {
  return db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).get() !== undefined;
}

/**
 * The project of the container item a container scope names (EO-596):
 * its project's id, null for a container on no project, and undefined
 * where no container item has that id — an item that is not a container
 * names no container scope.
 */
export function containerScopeProjectId(db: Db, containerId: string): string | null | undefined {
  const row = db
    .select({ projectId: items.projectId, container: itemTypes.container })
    .from(items)
    .innerJoin(itemTypes, eq(itemTypes.id, items.typeId))
    .where(eq(items.id, containerId))
    .get();
  if (row === undefined || !row.container) return undefined;
  return row.projectId;
}

/**
 * Whether a scope names a project, workspace or container item that exists.
 *
 * A workspace this database has no row for is still a scope where the
 * caller names the project it is of, and that project is here (EO-482):
 * a record holds a project's workspaces' memory without holding the
 * workspaces, which are paths on the desktops that work in them.
 */
function scopeExists(db: Db, scope: MemoryScope, projectId?: string): boolean {
  if (scope.kind === "project") return projectExists(db, scope.id);
  if (scope.kind === "container") return containerScopeProjectId(db, scope.id) !== undefined;
  if (db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, scope.id)).get() !== undefined) return true;
  return projectId !== undefined && projectExists(db, projectId);
}

/**
 * The project a scope belongs to (EO-482): the project itself, or the
 * workspace's — read off the workspace where this database has it, and
 * off the scope's own entries where it does not, which is a record
 * holding a workspace's memory. A container's is its item's (EO-596).
 * Null for a workspace or container with no project.
 */
export function memoryScopeProjectId(db: Db, scope: MemoryScope): string | null {
  if (scope.kind === "project") return scope.id;
  if (scope.kind === "container") return containerScopeProjectId(db, scope.id) ?? null;
  const workspace = db.select({ projectId: workspaces.projectId }).from(workspaces).where(eq(workspaces.id, scope.id)).get();
  if (workspace !== undefined) return workspace.projectId;
  return (
    db
      .select({ projectId: memories.projectId })
      .from(memories)
      .where(and(inScope(scope), isNotNull(memories.projectId)))
      .limit(1)
      .get()?.projectId ?? null
  );
}

/**
 * The project one entry belongs to, or undefined where there is no such
 * entry — read as `memoryScopeProjectId` reads a scope, so a workspace
 * this database holds is the authority on whose its entries are.
 */
export function memoryEntryProjectId(db: Db, id: string): string | null | undefined {
  const row = db.select({ scopeKind: memories.scopeKind, scopeId: memories.scopeId, projectId: memories.projectId }).from(memories).where(eq(memories.id, id)).get();
  if (row === undefined) return undefined;
  if (row.scopeKind === "project") return row.scopeId;
  if (row.scopeKind === "container") return containerScopeProjectId(db, row.scopeId) ?? row.projectId;
  const workspace = db.select({ projectId: workspaces.projectId }).from(workspaces).where(eq(workspaces.id, row.scopeId)).get();
  return workspace !== undefined ? workspace.projectId : row.projectId;
}

export interface AddMemoryInput {
  scope: MemoryScope;
  body: string;
  source: MemorySource;
  /** A seam for tests and for a caller holding its own clock. */
  now?: number;
  id?: Uuid;
  consolidationId?: string | null;
  /**
   * When what it says was first written, where that is earlier than
   * `now`: a consolidation merging older entries keeps the age of the
   * newest of them, so "written 12 days ago" stays true (EO-480).
   */
  createdAt?: number;
  /** Kept by a consolidation although it disagrees with the workspace's CLAUDE.md or AGENTS.md (EO-480). */
  contradictsRepositoryFile?: boolean;
  /** The entries it superseded, which `noteMemory` retires in the same transaction (EO-594). */
  supersededIds?: readonly string[];
  /**
   * The project the entry belongs to, where the caller knows it better
   * than this database does (EO-482): a record writing to a workspace it
   * holds memory for and no row of. Read from the scope otherwise.
   */
  projectId?: string;
}

/** Writes one active entry, or says why it did not. */
export function addMemory(db: Db, input: AddMemoryInput): MemoryWriteResult {
  const body = input.body.trim();
  if (body === "") return { ok: false, problem: "A memory entry needs something to say." };
  if (!scopeExists(db, input.scope, input.projectId)) return { ok: false, problem: `No ${input.scope.kind} has the id "${input.scope.id}".` };
  const at = input.now ?? Date.now();
  const row: Row = {
    id: input.id ?? (uuidv7() as Uuid),
    scopeKind: input.scope.kind,
    scopeId: input.scope.id,
    body,
    ...sourceColumns(input.source),
    createdAt: Math.min(input.createdAt ?? at, at),
    updatedAt: at,
    retiredAt: null,
    retiredReason: null,
    consolidationId: input.consolidationId ?? null,
    contradictsRepositoryFile: input.contradictsRepositoryFile ?? false,
    projectId: input.projectId ?? memoryScopeProjectId(db, input.scope),
    replacesId: null,
    supersededIds: [...(input.supersededIds ?? [])],
  };
  db.insert(memories).values(row).run();
  return { ok: true, entry: toView(row) };
}

/**
 * Why a note may not replace these entries, or null where it may
 * (EO-594): each must be an entry here, active, written by an agent's run
 * rather than a person — whose entry an agent never replaces, as
 * consolidation never rewrites one — and in one of `scopes`, the scopes
 * the run writing the note works in. One that fails refuses the note
 * whole, so the sentence says that nothing was written.
 */
export function supersedeProblem(db: Db, ids: readonly string[], scopes: readonly MemoryScope[]): string | null {
  for (const id of ids) {
    const row = db.select().from(memories).where(eq(memories.id, id)).get();
    if (row === undefined) return `No memory entry has the id "${id}", so the note naming it was not written.`;
    if (row.retiredAt !== null) return `The memory entry "${id}" is already retired, so there is nothing for the note to replace. The note was not written.`;
    if (row.sourceKind !== "run") {
      return `The memory entry "${id}" was written by a person, and a note never replaces a person's entry. The note was not written; leave it out of \`replaces\`, and say in the note's text what is true now.`;
    }
    if (!scopes.some((scope) => scope.kind === row.scopeKind && scope.id === row.scopeId)) {
      return `The memory entry "${id}" is not in a scope this run works in, so the note may not replace it. The note was not written.`;
    }
  }
  return null;
}

/**
 * An agent's note, written as an active entry, retiring the entries it
 * replaces (EO-594).
 *
 * Each id in `replaces` is held to `supersedeProblem` against `scopes`,
 * and the entries are retired as `superseded` and the note written naming
 * them, in one transaction — so there is never a moment with the
 * correction and what it corrects both active, or neither, and a refusal
 * writes nothing at all. With nothing to replace it is `addMemory`.
 */
export function noteMemory(db: Db, input: AddMemoryInput & { replaces: readonly string[]; scopes: readonly MemoryScope[] }): MemoryWriteResult {
  if (input.replaces.length === 0) return addMemory(db, input);
  return db.transaction((tx) => {
    const problem = supersedeProblem(tx as unknown as Db, input.replaces, input.scopes);
    if (problem !== null) return { ok: false as const, problem };
    const written = addMemory(tx as unknown as Db, { ...input, supersededIds: input.replaces });
    if (!written.ok) return written;
    const at = written.entry.updatedAt;
    tx.update(memories)
      .set({ retiredAt: at, retiredReason: "superseded", updatedAt: at })
      .where(inArray(memories.id, [...input.replaces]))
      .run();
    return written;
  });
}

/**
 * A new version of an active entry.
 *
 * The old row is retired as `edited` and a new row is written in the same
 * scope, sourced to whoever edited it and naming the row it replaces, in
 * one transaction — so there is never a moment with both versions active
 * or neither. Answers with the new row.
 */
export function editMemory(db: Db, id: string, body: string, source: MemorySource, now: number = Date.now()): MemoryWriteResult {
  const trimmed = body.trim();
  if (trimmed === "") return { ok: false, problem: "A memory entry needs something to say." };
  return db.transaction((tx) => {
    const current = tx.select().from(memories).where(eq(memories.id, id)).get();
    if (!current) return { ok: false as const, problem: `No memory entry has the id "${id}".` };
    if (current.retiredAt !== null) return { ok: false as const, problem: "That entry is retired. Restore it before editing it." };
    tx.update(memories).set({ retiredAt: now, retiredReason: "edited", updatedAt: now }).where(eq(memories.id, id)).run();
    const row: Row = {
      id: uuidv7() as Uuid,
      scopeKind: current.scopeKind,
      scopeId: current.scopeId,
      body: trimmed,
      ...sourceColumns(source),
      createdAt: now,
      updatedAt: now,
      retiredAt: null,
      retiredReason: null,
      consolidationId: null,
      // A person's own words now: whatever a consolidation flagged was
      // in the text this replaces.
      contradictsRepositoryFile: false,
      projectId: current.projectId,
      // Which version this replaces (EO-545), so the history says so
      // whatever later becomes of either row.
      replacesId: current.id,
      // What a note superseded stays the note's own: this version is a
      // person's, and replaced no entry but the one it edits.
      supersededIds: [],
    };
    tx.insert(memories).values(row).run();
    return { ok: true as const, entry: toView(row) };
  });
}

/**
 * Takes an active entry out of delivery. `reason` is `retired` for a
 * person; consolidation passes `consolidated` with its id. A note's
 * `superseded` is `noteMemory`'s, in the transaction that writes it.
 */
export function retireMemory(
  db: Db,
  id: string,
  options: { reason?: Exclude<MemoryRetirementReason, "edited" | "superseded">; consolidationId?: string | null; now?: number } = {},
): MemoryWriteResult {
  const current = getMemory(db, id);
  if (!current) return { ok: false, problem: `No memory entry has the id "${id}".` };
  if (current.retiredAt !== null) return { ok: false, problem: "That entry is already retired." };
  const at = options.now ?? Date.now();
  db.update(memories)
    .set({
      retiredAt: at,
      retiredReason: options.reason ?? "retired",
      updatedAt: at,
      ...(options.consolidationId === undefined ? {} : { consolidationId: options.consolidationId }),
    })
    .where(eq(memories.id, id))
    .run();
  return { ok: true, entry: getMemory(db, id)! };
}

/**
 * Puts a retired entry back into delivery, whatever retired it. Restoring
 * an edited version leaves its newer version active too: both are a
 * person's to keep or retire.
 */
export function restoreMemory(db: Db, id: string, now: number = Date.now()): MemoryWriteResult {
  const current = getMemory(db, id);
  if (!current) return { ok: false, problem: `No memory entry has the id "${id}".` };
  if (current.retiredAt === null) return { ok: false, problem: "That entry is not retired." };
  db.update(memories).set({ retiredAt: null, retiredReason: null, updatedAt: now }).where(eq(memories.id, id)).run();
  return { ok: true, entry: getMemory(db, id)! };
}

// ── Organisation mode (EO-482) ──────────────────────────────────────

/** Entries as they travel, by id, in the order asked. Ids with no row are left out. */
export function recordMemories(db: Db, ids: readonly string[]): RecordMemory[] {
  if (ids.length === 0) return [];
  const rows = new Map(
    db
      .select()
      .from(memories)
      .where(inArray(memories.id, [...ids]))
      .all()
      .map((row) => [row.id, row]),
  );
  return ids.flatMap((id) => {
    const row = rows.get(id);
    return row === undefined ? [] : [toRecordMemory(row)];
  });
}

/**
 * Every entry changed since a cursor, by when it last changed and its id
 * — strictly after the pair, as every list a record pages is (EO-482).
 * Retired entries included: a retirement is a change a replica has to
 * hear about. `within` is one project's, for a desktop catching up on a
 * project moved onto the record.
 */
export function listMemoriesUpdatedSince(db: Db, cursor: RecordCursor, limit: number, within?: string): RecordMemory[] {
  return db
    .select()
    .from(memories)
    .where(
      and(
        sql`(${memories.updatedAt} > ${cursor.ts} or (${memories.updatedAt} = ${cursor.ts} and ${memories.id} > ${cursor.id}))`,
        within === undefined ? undefined : eq(memories.projectId, within),
      ),
    )
    .orderBy(asc(memories.updatedAt), asc(memories.id))
    .limit(limit)
    .all()
    .map(toRecordMemory);
}

/** A project's memory and its workspaces', retired entries included, oldest first: what travels when it moves. */
export function readProjectMemories(db: Db, projectId: string): RecordMemory[] {
  return db
    .select()
    .from(memories)
    .where(eq(memories.projectId, projectId))
    .orderBy(asc(memories.createdAt), asc(memories.id))
    .all()
    .map(toRecordMemory);
}

/**
 * An entry as another database holds it, written here (EO-482).
 *
 * A replica copying the record's row, and a record taking a moved
 * project's: the same row by id, every column as it arrived. Newer wins
 * — a row already here that changed later than the one arriving is kept
 * — so a page read twice, or out of order, cannot take an entry back to
 * an older state.
 *
 * The run and item it names must be here already, or be named as null:
 * `source_run_id` and `source_item_id` are foreign keys, and the caller
 * holds a row whose source has not arrived rather than writing it.
 */
export function writeArrivedMemory(db: Db, entry: RecordMemory): void {
  const source = sourceColumns(entry.source as MemorySource);
  const row: Row = {
    id: entry.id,
    scopeKind: entry.scope.kind,
    scopeId: entry.scope.id,
    body: entry.body,
    ...source,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    retiredAt: entry.retiredAt,
    retiredReason: entry.retiredReason,
    consolidationId: entry.consolidationId,
    contradictsRepositoryFile: entry.contradictsRepositoryFile,
    projectId: entry.projectId,
    replacesId: entry.replacesId ?? null,
    supersededIds: [...(entry.supersededIds ?? [])],
  };
  db.insert(memories)
    .values(row)
    .onConflictDoUpdate({
      target: memories.id,
      // Every column but the id, which is what matched. Which version an
      // edit replaced never changes once known, so a row arriving from a
      // record that does not say (one from before EO-545) keeps it — and
      // so, for the same reason, do the entries a note superseded (EO-594).
      set: {
        ...row,
        id: undefined,
        replacesId: sql`coalesce(excluded.replaces_id, ${memories.replacesId})`,
        supersededIds: sql`case when excluded.superseded_ids = '[]' then ${memories.supersededIds} else excluded.superseded_ids end`,
      },
      setWhere: sql`excluded.updated_at >= ${memories.updatedAt}`,
    })
    .run();
}
