import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { uuidv7, type Uuid } from "@eo/core";
import type { Db } from "../client.js";
import { copyItemTypesToProject } from "./itemTypesRepo.js";
import { agents, items, memories, people, pipelines, pipelineSteps, projects, skills, workspaces } from "../schema.js";
import { getWorkspace, workspaceLabel, type Workspace } from "./workspacesRepo.js";

/**
 * Projects, and the workspaces they span (KAN-17, KAN-130).
 *
 * A project used to *be* a repository. It is its own thing now, holding
 * the workspaces work happens in, because one application is often
 * several repositories and a feature lands across more than one of them.
 *
 * Membership was a `project_repositories` row until KAN-130 and is the
 * workspace's own `project_id` now: a repository was shareable between
 * projects, a workspace belongs to the project it is attached to
 * (ARCHITECTURE.md, "A workspace is a kind, attached to the project"). What that costs is the
 * ability to
 * span one checkout from two projects; what it buys is that "which
 * project's binding does this run mirror through" has exactly one answer.
 *
 * The rule that survives all of it: a **story** still targets exactly
 * one workspace. A project spanning three produces stories that each
 * name one, which is what keeps one worktree, one branch, one
 * verification run and one pull request per story. Only a *feature* is
 * project-owned, and only when its project holds more than one workspace.
 */

export interface Project {
  id: Uuid;
  name: string;
  /**
   * Every item on this project keys from here — `<prefix>-<n>`.
   *
   * The only prefix there is since KAN-128. It was the repository's, and
   * a project spanning two repositories therefore minted keys from two
   * counters for work that was one project's.
   */
  keyPrefix: string;
  /**
   * When the record took this project, or null while it is this
   * machine's (EO-325, ARCHITECTURE.md, "The record").
   *
   * The one question every write about an item on it has to answer:
   * does what just happened belong to the organisation, or to the
   * person sitting here. See `onTheRecord`.
   */
  managedAt: number | null;
  /**
   * When the person answered the keep-or-move sheet with "keep".
   *
   * Only ever interesting beside `managedAt` being null, where it is
   * the difference between a project somebody kept and one nobody has
   * been asked about yet. Both behave identically; only the sheet reads
   * them apart.
   */
  keptLocalAt: number | null;
  /** Whose it is on the record. Null while it is local. */
  ownerId: Uuid | null;
  /**
   * When a transfer of this project started, while it is still in
   * flight (EO-325).
   *
   * The middle of a move. On the record it means the project is not
   * live yet; here it means nothing new should start on it. Null on
   * every project that is not moving.
   */
  adoptingAt: number | null;
  /**
   * When somebody put this project away, or null while it is live
   * (EO-347).
   *
   * Its items pause while it is set — the scheduler leaves them out of
   * its input — and carry on from the step they were on when it is
   * cleared. Nothing about them is written either way.
   */
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

interface ProjectRow {
  id: string;
  name: string;
  keyPrefix: string;
  managedAt: number | null;
  keptLocalAt: number | null;
  ownerId: string | null;
  adoptingAt: number | null;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

function toDomain(row: ProjectRow): Project {
  return {
    id: row.id as Uuid,
    name: row.name,
    keyPrefix: row.keyPrefix,
    managedAt: row.managedAt,
    keptLocalAt: row.keptLocalAt,
    ownerId: (row.ownerId as Uuid | null) ?? null,
    adoptingAt: row.adoptingAt,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface CreateProjectInput {
  name: string;
  keyPrefix: string;
  /** Members, in order. */
  workspaceIds?: Uuid[];
  /**
   * Whether the record already holds it (EO-325).
   *
   * **Almost never true, and never inferred.** It read
   * `isReplica(db)` at first — whether this machine has a record
   * elsewhere — on the reasoning that a project made after somebody
   * signed in is their organisation's because they made it *there*.
   * The reasoning is right about intent and wrong about fact: writing
   * this column says the record *has* the project, and nothing about
   * creating a row locally makes that so. The outbound queue carries
   * moves, comments and runs; there is no create-a-project command and
   * a project is not one, which is why it has an adoption protocol of
   * its own. So a project was born claiming to be somewhere it had
   * never been sent, and every write on it afterwards was queued for a
   * server that would answer "this record no longer has that item".
   *
   * A project is therefore born where it was made, and reaches the
   * record the one way anything reaches it — by being handed over.
   * `createProjectCommand` does that immediately on a signed-in
   * desktop, so the intent is kept and the column is not written until
   * it is true. Set here only by the record itself, writing a project
   * it has just been handed.
   */
  managed?: boolean;
}

export function createProject(db: Db, input: CreateProjectInput): Project {
  const now = Date.now();
  const managed = input.managed ?? false;
  return db.transaction(() => {
    const row = db
      .insert(projects)
      .values({
        id: uuidv7(),
        name: input.name,
        keyPrefix: input.keyPrefix,
        managedAt: managed ? now : null,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();

    // Attaching a workspace *is* the membership now, so the order named
    // here becomes each one's position — the same numbering the
    // membership rows carried.
    (input.workspaceIds ?? []).forEach((workspaceId, position) => {
      updateWorkspaceProject(db, workspaceId, row.id as Uuid, position);
    });

    // Its own copy of the item types the installation has (KAN-129), in
    // the same transaction as the row: a project whose first item is
    // refused for want of a `story` type would be a project that exists
    // and cannot be used. Copied rather than shared so the design's editor can
    // rename a type here without renaming it everywhere.
    copyItemTypesToProject(db, row.id as Uuid);

    return toDomain(row);
  });
}

/**
 * The project made for a repository that has no real project to join.
 *
 * It carries the workspace's name, and the prefix the person asked for
 * when they attached it — derived from that name when they asked for
 * nothing. The prefix is the project's own now (KAN-128), so this is the
 * row that holds it rather than a copy of one the workspace kept.
 */
export function createDefaultProject(db: Db, workspace: Workspace, keyPrefix: string): Project {
  return createProject(db, { name: workspaceLabel(workspace), keyPrefix, workspaceIds: [workspace.id] });
}

/**
 * The one write that says where a workspace is attached, and where it
 * sits in the list.
 *
 * And the one place the workspace's memory follows it (EO-482): an entry
 * of a workspace is that workspace's project's, so moving the workspace
 * moves whose memory it is — which decides what travels when a project is
 * handed to a record, and which record a write to it is asked of. A
 * workspace that had no project, and one that is taken off its project,
 * go the same way.
 *
 * Its skills follow it for the same reason (EO-513): a workspace's skill
 * is that workspace's project's, and that decides what travels with the
 * project. Not stamped as changed — the skill itself has not.
 */
function updateWorkspaceProject(db: Db, workspaceId: Uuid, projectId: Uuid | null, position: number): void {
  db.update(workspaces).set({ projectId, position, updatedAt: Date.now() }).where(eq(workspaces.id, workspaceId)).run();
  db.update(memories)
    .set({ projectId })
    .where(and(eq(memories.scopeKind, "workspace"), eq(memories.scopeId, workspaceId)))
    .run();
  db.update(skills)
    .set({ projectId })
    .where(and(eq(skills.scope, "workspace"), eq(skills.scopeId, workspaceId)))
    .run();
}

export function listProjects(db: Db): Project[] {
  return db.select().from(projects).orderBy(asc(projects.createdAt)).all().map(toDomain);
}

export function getProject(db: Db, id: Uuid): Project | undefined {
  const row = db.select().from(projects).where(eq(projects.id, id)).get();
  return row ? toDomain(row) : undefined;
}

/**
 * The projects one person has work on (EO-326, `ARCHITECTURE.md`,
 * "Identity").
 *
 * Three ways the record already knows a project expects somebody, and
 * no fourth table to keep true: they filed an item on it, an item on it
 * is assigned to them, or one of its steps waits on them or on a group
 * they are in. `identity/acting.ts` is where the choice to derive this
 * rather than store it is argued; this is only the query.
 *
 * A step's project is its *pipeline's* — steps carry no project of their
 * own — and a pipeline with no project is EO's seeded one, which belongs
 * to no project and so puts nobody in this answer.
 *
 * Items are matched on `created_by` and `assignee_id` including
 * archived ones, on purpose: a project whose work is finished is still a
 * project that person worked on, and a switcher that dropped it the
 * moment the last item was archived would hide their own history from
 * them.
 */
export function projectIdsForPerson(db: Db, personId: Uuid, groupIds: readonly string[]): Set<string> {
  const visible = new Set<string>();

  const mine = db
    .selectDistinct({ projectId: items.projectId })
    .from(items)
    .where(and(isNotNull(items.projectId), or(eq(items.createdBy, personId), eq(items.assigneeId, personId))))
    .all();
  for (const row of mine) if (row.projectId !== null) visible.add(row.projectId);

  const waitingOnMe = db
    .selectDistinct({ projectId: pipelines.projectId })
    .from(pipelineSteps)
    .innerJoin(pipelines, eq(pipelines.id, pipelineSteps.pipelineId))
    .where(
      and(
        isNotNull(pipelines.projectId),
        groupIds.length === 0
          ? eq(pipelineSteps.ownerPersonId, personId)
          : or(eq(pipelineSteps.ownerPersonId, personId), inArray(pipelineSteps.ownerGroupId, [...groupIds])),
      ),
    )
    .all();
  for (const row of waitingOnMe) if (row.projectId !== null) visible.add(row.projectId);

  return visible;
}

/**
 * The workspaces a project spans, in the order they were added.
 *
 * Tie-broken on id, for the reason an item's runs and transitions are:
 * position alone is not a total order. The insert rule cannot mint a
 * duplicate — but a reader that decides where a `discuss` dispatch runs
 * and where a feature's worktree is cut should not be relying on that
 * having gone perfectly. The tie-break costs nothing and makes the
 * answer the same on every machine.
 */
export function projectWorkspaceList(db: Db, projectId: Uuid): Workspace[] {
  return db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.projectId, projectId))
    .orderBy(asc(workspaces.position), asc(workspaces.id))
    .all()
    .flatMap((row) => getWorkspace(db, row.id as Uuid) ?? []);
}

/**
 * The project a workspace is attached to, or undefined for one whose
 * project was deleted.
 *
 * One answer, not a list: a repository could sit on several projects,
 * a workspace is the project's (KAN-130). Every caller that used to take
 * the first of a list is asking this question.
 */
export function projectForWorkspace(db: Db, workspaceId: Uuid): Project | undefined {
  const workspace = getWorkspace(db, workspaceId);
  if (!workspace?.projectId) return undefined;
  return getProject(db, workspace.projectId);
}

/**
 * Attaches a workspace to a project.
 *
 * A **move** rather than a second membership: a workspace belongs to one
 * project now, so attaching one another project holds takes it off that
 * one. Nothing on disk is touched either way — this says which project's
 * items may name it.
 */
export function addWorkspaceToProject(db: Db, projectId: Uuid, workspaceId: Uuid): void {
  const workspace = getWorkspace(db, workspaceId);
  if (!workspace || workspace.projectId === projectId) return;

  // Appended, not inserted: the order is the order they were added, and
  // renumbering on every join would churn rows for no reader's benefit.
  //
  // One past the highest, not the number of rows. Detaching a workspace
  // leaves a gap, so counting hands out a position something already
  // holds — remove the first of two and the next one added collides with
  // the survivor. `projectWorkspaceList` then orders the two by id, which
  // is arbitrary, and that order is not cosmetic: it names the workspace
  // a `discuss` dispatch starts in and the one a feature's worktree is
  // cut from.
  const members = db.select({ position: workspaces.position }).from(workspaces).where(eq(workspaces.projectId, projectId)).all();
  const position = members.reduce((highest, row) => Math.max(highest, row.position + 1), 0);
  updateWorkspaceProject(db, workspaceId, projectId, position);
}

/**
 * Takes a workspace off a project without deleting it.
 *
 * Detached rather than removed: the disk is still there and items still
 * name it, which is the state a repository was left in when its last
 * project was deleted.
 */
export function removeWorkspaceFromProject(db: Db, projectId: Uuid, workspaceId: Uuid): void {
  const workspace = getWorkspace(db, workspaceId);
  if (workspace?.projectId !== projectId) return;
  updateWorkspaceProject(db, workspaceId, null, 0);
}

export interface UpdateProjectInput {
  name?: string;
}

export function updateProject(db: Db, id: Uuid, patch: UpdateProjectInput): Project | undefined {
  const row = db
    .update(projects)
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      updatedAt: Date.now(),
    })
    .where(eq(projects.id, id))
    .returning()
    .get();
  return row ? toDomain(row) : undefined;
}

/**
 * Puts a project away, or brings it back (EO-347).
 *
 * The one column and nothing else. What archiving *means* — no
 * dispatch, no board, no inbox — is derived from it where each of
 * those is read, so there is nothing on the items to undo afterwards.
 * `updatedAt` is left alone, for `setItemArchived`'s reason: putting
 * something away is not an edit to it.
 */
export function setProjectArchived(db: Db, id: Uuid, archivedAt: number | null): void {
  db.update(projects).set({ archivedAt }).where(eq(projects.id, id)).run();
}

/**
 * The items on an archived project, as a set (EO-347).
 *
 * `itemsMidAdoption`'s shape and its reason: the scheduler asks it of
 * every candidate at once, and a query per item would be a query per
 * item. Read by `buildEligibilityInput`, so every door that decides
 * whether something may run — the tick, the record's offer, the
 * explanation on an item — agrees about it.
 */
export function itemsOnArchivedProjects(db: Db): Set<string> {
  const rows = db
    .select({ id: items.id })
    .from(items)
    .innerJoin(projects, eq(projects.id, items.projectId))
    .where(isNotNull(projects.archivedAt))
    .all();
  return new Set(rows.map((row) => row.id));
}

/** The archived project this item is on, or undefined while its project is live or it has none (EO-347). */
export function archivedProjectOf(db: Db, itemId: Uuid): Project | undefined {
  const row = db
    .select({ project: projects })
    .from(items)
    .innerJoin(projects, eq(projects.id, items.projectId))
    .where(and(eq(items.id, itemId), isNotNull(projects.archivedAt)))
    .get();
  return row ? toDomain(row.project) : undefined;
}

export function deleteProject(db: Db, id: Uuid): void {
  // Its workspaces are detached rather than deleted (`ON DELETE SET
  // NULL`) — the disk outlives the project, and an item resolves its
  // run through the workspace. Its connector bindings do go, by cascade:
  // a binding is the project mirrored somewhere, and there is no project
  // left to mirror. Its items do not go and are not detached:
  // `items.project_id` has no ON DELETE rule and foreign keys are on, so
  // deleting a project that still has items — archived ones included —
  // fails on the key. A caller removes them first (`projects:delete`,
  // EO-346).
  //
  // Its own agents are archived, not deleted (EO-476): every row stays
  // whole — name, role, instructions, config and attachments — because
  // it is what its runs, the comments it wrote and the mentions that
  // named it are read back by (invariant #3), and a project going is not
  // a person asking for what its agents did to be forgotten. An agent
  // archived or deleted before keeps its own stamp, being the true one.
  //
  // Then detached, since `agents.project_id` has no ON DELETE rule and
  // an agent row can never be cascaded away. Detaching an archived agent
  // makes it global in name only: archived is not dispatchable, archiving
  // is one-way, and the project it was for no longer exists.
  //
  // One transaction with the project's own delete, because the delete
  // can still fail on the key above, and a project that survives a
  // refused delete keeps its agents exactly as they were — live, scoped
  // and attached.
  db.transaction((tx) => {
    const at = Date.now();
    tx.update(agents)
      .set({ archivedAt: sql`coalesce(${agents.archivedAt}, ${at})`, projectId: null, updatedAt: at, revision: sql`${agents.revision} + 1` })
      .where(eq(agents.projectId, id))
      .run();
    tx.delete(projects).where(eq(projects.id, id)).run();
  });
}

/**
 * Every key prefix already spoken for.
 *
 * One table asked, since KAN-128: projects hold the prefix and nothing
 * else does. `projects.key_prefix` is unique in the database too, so this
 * is not what makes a collision impossible — it is what makes one a
 * refusal rather than a thrown constraint. Making a project for a
 * repository writes two rows, the workspace and the project, and the
 * project is second: an unchecked prefix used to insert the workspace, hit the
 * constraint on the project, and leave a workspace behind with no
 * project and an exception where the answer should have been.
 */
export function takenKeyPrefixes(db: Db): Set<string> {
  return new Set(db.select({ keyPrefix: projects.keyPrefix }).from(projects).all().map((row) => row.keyPrefix));
}

/**
 * A key prefix nobody is using yet, derived from a name: "my-api" ->
 * "MYAPI", disambiguated with a number if taken.
 *
 * Suggested, not enforced — the person can type their own. It exists
 * because a prefix has to be unique (it is what keeps item keys, and
 * therefore worktree directories, from colliding) and asking someone to
 * invent a unique string is a worse first-run experience than offering
 * one that already works.
 */
export function suggestKeyPrefix(db: Db, name: string): string {
  const letters = name.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const base = (letters.slice(0, 4) || "EO").replace(/^[0-9]+/, "") || "EO";

  const taken = takenKeyPrefixes(db);
  if (!taken.has(base)) return base;

  for (let suffix = 2; ; suffix++) {
    const candidate = `${base}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// ── Whose a project is, and whose its work is (EO-325) ──────────────

/**
 * Projects the keep-or-move sheet has still to ask about (ARCHITECTURE.md, "What a person sees
 * first",
 * "Identity").
 *
 * Neither column set: nobody has said to keep it and the record has not
 * taken it. On a solo desktop that is every project and the sheet never
 * opens; on the desktop that has just signed in it is exactly the work
 * that predates the sign-in, which is the whole of what the design says
 * a person was told nothing about.
 */
export function listUndecidedProjects(db: Db): Project[] {
  return db
    .select()
    .from(projects)
    .where(and(isNull(projects.managedAt), isNull(projects.keptLocalAt)))
    .orderBy(asc(projects.createdAt))
    .all()
    .map(toDomain);
}

/**
 * The person's answer of "keep this one here".
 *
 * Refuses a project the record already has, which is the one-way street
 * this version is honest about: the rows are on the server, other
 * desktops have them, and a local copy declaring itself the original
 * again would be two records for one project. The sheet and the
 * settings screen both say so before offering the choice; this is the
 * same refusal where it cannot be talked around.
 */
export function keepProjectLocal(db: Db, id: Uuid, at: number = Date.now()): Project | undefined {
  const project = getProject(db, id);
  if (project === undefined || project.managedAt !== null) return undefined;
  db.update(projects).set({ keptLocalAt: at, updatedAt: at }).where(eq(projects.id, id)).run();
  return getProject(db, id);
}

/**
 * The record has it, and whose it is there.
 *
 * Written *after* the rows have landed and never before — see
 * `record/adopt.ts`. The column is what routes every later write on
 * this project to the organisation, so a project marked before its
 * history arrived would be one whose next comment reached a server that
 * had never heard of the item it was about.
 */
export function markProjectOnTheRecord(db: Db, id: Uuid, ownerId: Uuid, at: number = Date.now()): Project | undefined {
  if (getProject(db, id) === undefined) return undefined;
  // …and the transfer is over, whichever side of it this is. The two
  // columns are exclusive by construction: a project is moving or it is
  // somewhere, never both.
  db.update(projects).set({ managedAt: at, keptLocalAt: null, adoptingAt: null, ownerId, updatedAt: at }).where(eq(projects.id, id)).run();
  return getProject(db, id);
}

/**
 * The middle of a move begins (EO-325, the review's second finding).
 *
 * On the machine sending it, this is what takes the project's items out
 * of the local scheduler: a move is a paged conversation lasting
 * seconds or minutes, and an agent dispatched into the middle of one
 * writes rows that are neither in the snapshot already sent nor queued
 * for a record that does not yet own the project.
 *
 * Refuses a project that is already the record's, and one that is
 * already moving — the second is what stops two Move presses from
 * interleaving two transfers of the same rows.
 */
export function beginAdoption(db: Db, id: Uuid, at: number = Date.now()): Project | undefined {
  const project = getProject(db, id);
  if (project === undefined || project.managedAt !== null || project.adoptingAt !== null) return undefined;
  db.update(projects).set({ adoptingAt: at, updatedAt: at }).where(eq(projects.id, id)).run();
  return getProject(db, id);
}

/**
 * …and ends without having finished.
 *
 * The project goes back to exactly what it was: local, undecided, on
 * the sheet, and scheduled here again. Nothing else was written, so
 * there is nothing else to undo.
 */
export function abandonAdoption(db: Db, id: Uuid, at: number = Date.now()): void {
  db.update(projects).set({ adoptingAt: null, updatedAt: at }).where(eq(projects.id, id)).run();
}

/** Whether a transfer of this project is in flight. */
export function isAdopting(db: Db, id: Uuid): boolean {
  return getProject(db, id)?.adoptingAt !== null && getProject(db, id) !== undefined;
}

/**
 * Whether the record for this item's rows is somewhere other than this
 * project (EO-325).
 *
 * **The question the whole story turns on**, asked once here so that
 * the queue, the replica flag, the scheduler and the tracker push
 * cannot come to four different answers about one item.
 *
 * An item with no project at all is the record's. That is not a
 * fallback, it is what such an item *is*: nothing keeps it local,
 * because keeping is a property of a project and it is on none. It is
 * also every item in managed mode that arrived from the record before
 * its project did — `upsertReplicaItem` nulls a project this replica
 * has not got yet — and treating those as local would be a desktop
 * quietly refusing to sync the organisation's own work.
 */
export function onTheRecord(db: Db, itemId: Uuid): boolean {
  const row = db
    .select({ projectId: items.projectId, managedAt: projects.managedAt })
    .from(items)
    .leftJoin(projects, eq(projects.id, items.projectId))
    .where(eq(items.id, itemId))
    .get();
  // An item this database has never heard of: the record's, for the
  // same reason. A command about it is one the record must judge.
  if (row === undefined) return true;
  return row.projectId === null || row.managedAt !== null;
}

/**
 * Whether this item's project was *handed over* — whatever this machine
 * can reach today (EO-325).
 *
 * The narrower half of `onTheRecord`, and the difference between them
 * is the whole of what signing out may and may not undo. `onTheRecord`
 * asks "does the record own these rows", and answers yes for an item on
 * no project at all — which is right on a desktop that has a record and
 * meaningless on one that never had. This asks something a desktop can
 * answer on its own and that no credential changes: *did somebody move
 * this project*. `managed_at` is a point of no return, written by the
 * transfer that put the rows there, and a token being forgotten does
 * not bring them back.
 *
 * Read wherever the answer must survive a sign-out: the scheduler, the
 * outbound queue, the replica flag. A desktop that signed out of its
 * organisation stops being offered a moved project's work, goes on
 * queueing anything written on it, and goes on leaving its tracker
 * alone — because the record is still the writer, and this machine
 * having lost its key does not make it one.
 */
export function movedToTheRecord(db: Db, itemId: Uuid): boolean {
  const row = db
    .select({ managedAt: projects.managedAt })
    .from(items)
    .innerJoin(projects, eq(projects.id, items.projectId))
    .where(eq(items.id, itemId))
    .get();
  return row !== undefined && row.managedAt !== null;
}

/**
 * `movedToTheRecord`, asked of a project rather than of one of its
 * items (EO-471) — for a question asked before the item exists.
 */
export function projectMovedToTheRecord(db: Db, projectId: Uuid): boolean {
  return (getProject(db, projectId)?.managedAt ?? null) !== null;
}

/**
 * The items on a project somebody moved, as a set.
 *
 * The same question `movedToTheRecord` answers, asked of every
 * candidate at once, because the tick asks it of all of them and a
 * query per item would be a query per item.
 */
export function itemsOnMovedProjects(db: Db): Set<string> {
  const rows = db
    .select({ id: items.id })
    .from(items)
    .innerJoin(projects, eq(projects.id, items.projectId))
    .where(sql`${projects.managedAt} is not null`)
    .all();
  return new Set(rows.map((row) => row.id));
}

/**
 * The items this machine still schedules for itself.
 *
 * The other half of `onTheRecord`, as a set rather than a question,
 * because the tick asks it of every candidate at once and a query per
 * item would be a query per item.
 */
export function locallyScheduledItemIds(db: Db): Set<string> {
  const rows = db
    .select({ id: items.id })
    .from(items)
    .innerJoin(projects, eq(projects.id, items.projectId))
    // …and not one that is on its way somewhere (EO-325). A project
    // mid-transfer is still local — it is not the record's until the
    // record says it has everything — and it must still not be
    // dispatched, or an agent writes rows into the gap between the
    // snapshot and the commit.
    .where(and(isNull(projects.managedAt), isNull(projects.adoptingAt)))
    .all();
  return new Set(rows.map((row) => row.id));
}

/** The projects a transfer is still arriving into, so nothing of theirs is sent on. */
export function projectsMidAdoption(db: Db): Set<string> {
  return new Set(
    db
      .select({ id: projects.id })
      .from(projects)
      .where(sql`${projects.adoptingAt} is not null`)
      .all()
      .map((row) => row.id),
  );
}

/**
 * Items the scheduler must not be offered because their project is
 * mid-transfer (EO-325).
 *
 * The record's half of the same rule. A project arriving here exists so
 * that foreign keys resolve and pages can land; dispatching one of its
 * items before the last page has arrived is dispatching work whose
 * thread, whose runs and whose acceptance criteria may still be on
 * somebody's laptop.
 *
 * Read by `buildEligibilityInput`, so it applies to every tick on
 * either side rather than to a branch somebody has to remember.
 */
export function itemsMidAdoption(db: Db): Set<string> {
  const rows = db
    .select({ id: items.id })
    .from(items)
    .innerJoin(projects, eq(projects.id, items.projectId))
    .where(sql`${projects.adoptingAt} is not null`)
    .all();
  return new Set(rows.map((row) => row.id));
}

/** A person this machine has a row for, or nobody. See `upsertReplicaProject`. */
function knownPerson(db: Db, id: Uuid | null): Uuid | null {
  if (id === null) return null;
  return db.select({ id: people.id }).from(people).where(eq(people.id, id)).get() === undefined ? null : id;
}

/** Whether any project on this machine is still the person's own. */
export function hasLocalProjects(db: Db): boolean {
  return db.select({ id: projects.id }).from(projects).where(isNull(projects.managedAt)).get() !== undefined;
}

/**
 * Projects the record has, paged for a replica catching up (EO-325).
 *
 * `updatedAt` and the id, the pair every other list in `record:changes`
 * is read by — see `RecordCursorSchema` for why a timestamp alone is
 * not a cursor.
 */
/**
 * `within` scopes the page to one project (EO-325, review).
 *
 * The move does not restamp what it transfers — a comment written in
 * March is a comment written in March — so a desktop whose cursors had
 * already run past March saw the project row arrive and none of its
 * history behind it. It asks for that history here, on cursors of its
 * own, and the keyset is the same one: the scope narrows, nothing else
 * about the paging changes.
 */
export function listProjectsUpdatedSince(db: Db, cursor: { ts: number; id: string }, limit: number, within?: string): Project[] {
  return db
    .select()
    .from(projects)
    // Never one that is still arriving (EO-325). A project half way
    // through a transfer is not something another desktop should draw
    // a board from: it would show a project with some of its items,
    // some of its threads and none of its files, and then quietly grow
    // the rest.
    .where(
      and(
        sql`(${projects.updatedAt}, ${projects.id}) > (${cursor.ts}, ${cursor.id})`,
        isNull(projects.adoptingAt),
        within === undefined ? undefined : eq(projects.id, within),
      ),
    )
    .orderBy(asc(projects.updatedAt), asc(projects.id))
    .limit(limit)
    .all()
    .map(toDomain);
}

/**
 * One project from the record, into this replica.
 *
 * Idempotent and, like `upsertReplicaItem`, guarded on `updatedAt` so
 * an out-of-order page cannot write an older name over a newer one.
 *
 * `managedAt` is forced rather than copied: a project arriving over the
 * record contract is on the record by definition, and a replica that
 * took a null here would decide the organisation's project was its own
 * and stop sending anything about it. `keyPrefix` is the one field that
 * can collide — it is unique, and it numbers the item keys — so a
 * replica that already has that prefix under another id leaves the
 * project out rather than renaming somebody's counter.
 *
 * The owner is held as nobody where this machine has no row for them.
 * The people list syncs on its own channel (EO-323) and may be behind
 * this pull; `upsertReplicaItem` makes the same trade for an assignee,
 * and for the same reason — a dangling person id is a foreign key
 * error rather than a screen that says "somebody".
 */
export function upsertReplicaProject(db: Db, project: Project): "inserted" | "updated" | "skipped" {
  const existing = getProject(db, project.id);
  const managedAt = project.managedAt ?? project.createdAt;
  const ownerId = knownPerson(db, project.ownerId);
  if (existing === undefined) {
    const clash = db.select({ id: projects.id }).from(projects).where(eq(projects.keyPrefix, project.keyPrefix)).get();
    if (clash !== undefined) return "skipped";
    db.insert(projects)
      .values({
        id: project.id,
        name: project.name,
        keyPrefix: project.keyPrefix,
        managedAt,
        keptLocalAt: null,
        adoptingAt: null,
        ownerId,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      })
      .onConflictDoNothing()
      .run();
    // The types this project's items resolve against arrive on their
    // own list, with the ids the record holds them by — see
    // `record:changes` and `upsertReplicaItemType` (EO-325).
    //
    // They used to be *invented* here, by copying whatever this
    // installation happened to have. That worked by coincidence for a
    // project whose types were EO's own and failed silently for any
    // other: a moved project's `case` arrived as no type at all and its
    // items were dropped, and a moved `story` arrived as a second row
    // with the same word — which `resolveItemType` refuses to choose
    // between, so every item of that type stopped resolving on both.
    return "inserted";
  }
  if (existing.updatedAt > project.updatedAt) return "skipped";
  db.update(projects)
    .set({ name: project.name, managedAt, ownerId, updatedAt: project.updatedAt })
    .where(eq(projects.id, project.id))
    .run();
  return "updated";
}
