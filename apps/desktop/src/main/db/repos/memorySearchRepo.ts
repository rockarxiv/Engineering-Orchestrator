import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, ne, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import {
  containerScopeName,
  memoryEntryState,
  type MemoryRetirementReason,
  type MemoryScopeKind,
  type MemorySearchEntry,
  type MemorySearchRequest,
  type MemoryUsage,
} from "@eo/core";
import { bodyMatches, prepareQuery } from "../approximateSearch.js";
import type { Db } from "../client.js";
import { items, memories, projects, workspaces } from "../schema.js";
import { foldCase } from "../textFold.js";
import { memoryUsageByEntry, usageOf } from "./memoryUseRepo.js";
import { listWorkspaces, workspaceLabel } from "./workspacesRepo.js";

/**
 * Finding memory entries across every scope this database holds (EO-545,
 * the `memories_search` and `memory_get` tools). Read-only: the writes
 * are `memoriesRepo.ts`'s.
 *
 * Every filter is applied in the query and combined with AND. A text
 * query is asked of `memories_fts` (migration 0139) and ranked by bm25 —
 * see `approximateSearch.ts` for how a query becomes trigrams and which
 * candidates are kept.
 */

/**
 * The project an entry belongs to, as `memoryEntryProjectId` reads it: a
 * project's own id, a workspace's project where this database holds the
 * workspace, and what the entry itself says where it does not — a record
 * holding a workspace's memory without the workspace — and a container's,
 * whose project the entry carries (EO-596).
 */
const entryProjectId = sql<string | null>`case when ${memories.scopeKind} = 'project' then ${memories.scopeId} when ${workspaces.id} is not null then ${workspaces.projectId} else ${memories.projectId} end`;

/** The container item a container scope names (EO-596), beside the item an entry's run was on. */
const containerItems = alias(items, "container_item");

function selectEntries(db: Db) {
  return db
    .select({
      row: memories,
      projectName: projects.name,
      workspaceId: workspaces.id,
      projectId: entryProjectId,
      itemKey: items.key,
      containerKey: containerItems.key,
      containerTitle: containerItems.title,
    })
    .from(memories)
    .leftJoin(projects, and(eq(memories.scopeKind, "project"), eq(projects.id, memories.scopeId)))
    .leftJoin(workspaces, and(eq(memories.scopeKind, "workspace"), eq(workspaces.id, memories.scopeId)))
    .leftJoin(containerItems, and(eq(memories.scopeKind, "container"), eq(containerItems.id, memories.scopeId)))
    .leftJoin(items, eq(items.id, memories.sourceItemId));
}

function scopeName(selected: Selected, names: Map<string, string>): string | null {
  const kind = selected.row.scopeKind as MemoryScopeKind;
  if (kind === "project") return selected.projectName;
  if (kind === "container") return selected.containerKey === null || selected.containerTitle === null ? null : containerScopeName({ key: selected.containerKey, title: selected.containerTitle });
  return names.get(selected.row.scopeId) ?? null;
}

type Selected = Awaited<ReturnType<ReturnType<typeof selectEntries>["all"]>>[number];

/** What each workspace is called where a person sees it, by id. */
function workspaceNames(db: Db): Map<string, string> {
  return new Map(listWorkspaces(db).map((workspace) => [workspace.id, workspaceLabel(workspace)]));
}

function toEntry(selected: Selected, names: Map<string, string>, usage: ReadonlyMap<string, MemoryUsage>): MemorySearchEntry {
  const { row } = selected;
  const retiredReason = (row.retiredReason as MemoryRetirementReason | null) ?? null;
  const kind = row.scopeKind as MemoryScopeKind;
  return {
    id: row.id,
    scope: { kind, id: row.scopeId, name: scopeName(selected, names) },
    projectId: selected.projectId,
    body: row.body,
    source:
      row.sourceKind === "run"
        ? { type: "run", runId: row.sourceRunId, itemId: row.sourceItemId, itemKey: selected.itemKey }
        : { type: "person", personId: row.sourcePersonId },
    extracted: row.extracted,
    state: memoryEntryState({ retiredAt: row.retiredAt, retiredReason }),
    retiredAt: row.retiredAt,
    retiredReason,
    consolidationId: row.consolidationId,
    contradictsRepositoryFile: row.contradictsRepositoryFile,
    replacesId: row.replacesId,
    supersededIds: row.supersededIds,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...usageOf(usage, row.id),
  };
}

/**
 * The scopes whose name is `name`, ignoring case in every script: the
 * projects called that, and the workspaces EO shows under it.
 */
function scopesNamed(db: Db, name: string, workspaceLabels: Map<string, string>): SQL | null {
  const wanted = foldCase(name.trim());
  const projectIds = db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .all()
    .filter((project) => foldCase(project.name) === wanted)
    .map((project) => project.id);
  const workspaceIds = [...workspaceLabels].filter(([, label]) => foldCase(label) === wanted).map(([id]) => id);
  const clauses = [
    projectIds.length > 0 ? and(eq(memories.scopeKind, "project"), inArray(memories.scopeId, projectIds)) : undefined,
    workspaceIds.length > 0 ? and(eq(memories.scopeKind, "workspace"), inArray(memories.scopeId, workspaceIds)) : undefined,
  ].filter((clause): clause is SQL => clause !== undefined);
  return clauses.length === 0 ? null : or(...clauses)!;
}

function stateIs(state: NonNullable<MemorySearchRequest["state"]>): SQL {
  switch (state) {
    case "active":
      return isNull(memories.retiredAt);
    case "consolidated":
      return and(isNotNull(memories.retiredAt), eq(memories.retiredReason, "consolidated"))!;
    case "retired":
      return and(isNotNull(memories.retiredAt), or(isNull(memories.retiredReason), ne(memories.retiredReason, "consolidated")))!;
  }
}

/**
 * Entries matching every filter given, newest first — or, with a query,
 * best match first, each with its score.
 */
export function searchMemories(db: Db, request: MemorySearchRequest): MemorySearchEntry[] {
  const names = workspaceNames(db);
  const usage = memoryUsageByEntry(db);
  const clauses: (SQL | undefined)[] = [];
  if (request.scopeKind !== undefined) clauses.push(eq(memories.scopeKind, request.scopeKind));
  if (request.scopeId !== undefined) clauses.push(eq(memories.scopeId, request.scopeId));
  if (request.scopeName !== undefined) {
    const named = scopesNamed(db, request.scopeName, names);
    if (named === null) return [];
    clauses.push(named);
  }
  if (request.projectId !== undefined) clauses.push(sql`${entryProjectId} = ${request.projectId}`);
  if (request.sourceKind !== undefined) clauses.push(eq(memories.sourceKind, request.sourceKind));
  if (request.runId !== undefined) clauses.push(eq(memories.sourceRunId, request.runId));
  if (request.itemId !== undefined) clauses.push(eq(memories.sourceItemId, request.itemId));
  if (request.extracted !== undefined) clauses.push(eq(memories.extracted, request.extracted));
  if (request.state !== undefined) clauses.push(stateIs(request.state));
  if (request.contradictsRepositoryFile !== undefined) clauses.push(eq(memories.contradictsRepositoryFile, request.contradictsRepositoryFile));
  if (request.createdSince !== undefined) clauses.push(gte(memories.createdAt, request.createdSince));
  if (request.createdUntil !== undefined) clauses.push(lt(memories.createdAt, request.createdUntil));
  if (request.updatedSince !== undefined) clauses.push(gte(memories.updatedAt, request.updatedSince));
  if (request.updatedUntil !== undefined) clauses.push(lt(memories.updatedAt, request.updatedUntil));

  const prepared = request.query === undefined ? null : prepareQuery(request.query);
  // The schema refuses a query with no word long enough to match on;
  // one that arrives here anyway matches nothing rather than everything.
  if (prepared !== null && prepared.match === "") return [];
  if (prepared !== null) clauses.push(sql`${memories.id} in (select id from memories_fts where memories_fts match ${prepared.match})`);

  const rows = selectEntries(db)
    .where(and(...clauses))
    .orderBy(desc(memories.createdAt), desc(memories.id))
    .all();
  if (prepared === null) return rows.map((row) => toEntry(row, names, usage));

  // bm25 is lower for a better match; the score is it negated, so a
  // reader sorting on it sorts best first.
  const ranks = new Map(
    db.all<{ id: string; rank: number }>(sql`select id, bm25(memories_fts) as rank from memories_fts where memories_fts match ${prepared.match}`).map((hit) => [hit.id, hit.rank]),
  );
  return rows
    .filter((row) => bodyMatches(prepared, row.row.body))
    .map((row, at) => ({ entry: toEntry(row, names, usage), rank: ranks.get(row.row.id) ?? 0, at }))
    // Stable on the newest-first order the query read them in.
    .sort((a, b) => a.rank - b.rank || a.at - b.at)
    .map(({ entry, rank }) => ({ ...entry, score: -rank }));
}

/** One entry, as a search answers it, or undefined where no entry has the id. */
export function getMemorySearchEntry(db: Db, id: string): MemorySearchEntry | undefined {
  const row = selectEntries(db).where(eq(memories.id, id)).get();
  return row === undefined ? undefined : toEntry(row, workspaceNames(db), memoryUsageByEntry(db));
}

/** How many ids one statement reads at a time: well under SQLite's limit on bound parameters. */
const READ_CHUNK = 500;

/**
 * The earlier versions an entry replaced through edits, newest first:
 * the version its edit replaced, the version that one's edit replaced,
 * and so on back to the first — every one of them.
 *
 * Read off `replaces_id`, which `editMemory` writes on the new row in the
 * same transaction as it retires the old one, and which nothing changes
 * afterwards: a version restored since is still one this entry replaced.
 * A version this database has not been sent — a replica a page behind
 * its record — ends the chain where it is missing, since only its row
 * says what it replaced in turn.
 */
export function editedPredecessors(db: Db, entry: MemorySearchEntry): MemorySearchEntry[] {
  // Bounded by how many rows there are, so a cycle no edit can make
  // still cannot keep the walk going.
  const chain = db.all<{ id: string; depth: number }>(sql`
    with recursive chain(id, depth) as (
      select ${memories.replacesId}, 1 from ${memories} where ${memories.id} = ${entry.id} and ${memories.replacesId} is not null
      union all
      select m.replaces_id, chain.depth + 1 from chain join memories m on m.id = chain.id
      where m.replaces_id is not null and chain.depth < (select count(*) from memories)
    )
    select id, depth from chain order by depth
  `);
  const ids = [...new Set(chain.map((link) => link.id))].filter((id) => id !== entry.id);
  const names = workspaceNames(db);
  const usage = memoryUsageByEntry(db);
  const byId = new Map<string, MemorySearchEntry>();
  for (let at = 0; at < ids.length; at += READ_CHUNK) {
    for (const row of selectEntries(db).where(inArray(memories.id, ids.slice(at, at + READ_CHUNK))).all()) byId.set(row.row.id, toEntry(row, names, usage));
  }
  return ids.flatMap((id) => byId.get(id) ?? []);
}

/**
 * The entries a note superseded (EO-594), in the order it named them —
 * every one this database holds, a restore of one since included, since
 * `superseded_ids` is written with the note and never changed. One a
 * replica has not been sent yet is left out.
 */
export function supersededEntries(db: Db, entry: MemorySearchEntry): MemorySearchEntry[] {
  const ids = entry.supersededIds.filter((id) => id !== entry.id);
  if (ids.length === 0) return [];
  const names = workspaceNames(db);
  const usage = memoryUsageByEntry(db);
  const byId = new Map<string, MemorySearchEntry>();
  for (let at = 0; at < ids.length; at += READ_CHUNK) {
    for (const row of selectEntries(db).where(inArray(memories.id, ids.slice(at, at + READ_CHUNK))).all()) byId.set(row.row.id, toEntry(row, names, usage));
  }
  return ids.flatMap((id) => byId.get(id) ?? []);
}

/** How much of an entry's body its neighbours are looked up by: enough to say what it is about, short enough to keep the query small. */
const NEIGHBOUR_QUERY_CHARS = 600;

/**
 * For each of `entries`, the others among them whose bodies are most like
 * its own, best first, at most `limit` of them (EO-574): what batches a
 * scope's consolidation so related entries tend to share a batch.
 *
 * Asked of `memories_fts` (migration 0139) as a search is: the start of
 * the entry's body as the query, its words' trigrams joined with OR and
 * ranked by bm25, so entries sharing its rarer pieces come first. Only
 * the given entries are candidates — never another scope's, never a
 * retired one. An entry with no word long enough to match on has none.
 * Throws where the index cannot be asked; the caller then groups by age.
 */
export function similarMemoryNeighbours(db: Db, entries: readonly { id: string; body: string }[], limit = 8): Map<string, string[]> {
  const ids = JSON.stringify(entries.map((entry) => entry.id));
  const neighbours = new Map<string, string[]>();
  for (const entry of entries) {
    const prepared = prepareQuery(entry.body.slice(0, NEIGHBOUR_QUERY_CHARS));
    if (prepared.match === "") {
      neighbours.set(entry.id, []);
      continue;
    }
    const hits = db.all<{ id: string }>(sql`
      select id from memories_fts
      where memories_fts match ${prepared.match}
        and id in (select value from json_each(${ids}))
        and id <> ${entry.id}
      order by bm25(memories_fts), id
      limit ${limit}
    `);
    neighbours.set(entry.id, hits.map((hit) => hit.id));
  }
  return neighbours;
}
