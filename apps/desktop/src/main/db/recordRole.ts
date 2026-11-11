import type { Uuid } from "@eo/core";
import type { Db } from "./client.js";

/**
 * Whether this database is the record or a copy of one (EO-324,
 * `ARCHITECTURE.md`, "The record").
 *
 * One question, asked by the two writes that have a *side effect
 * outside EO*: moving an item pushes a status to the tracker, and
 * posting a comment pushes a comment to it. Both belong to whoever owns
 * the item's state, and in managed mode that is the record.
 *
 * ### The failure this closes
 *
 * A move on a signed-in desktop is provisional until the record accepts
 * it (ARCHITECTURE.md, "The record"). The tracker push is not: an outbox row is a promise to
 * tell Jira, and Jira has no notion of provisional. So a desktop that
 * pushed its own moves would tell the tracker about a move the record
 * then refused as superseded — an item that is one place on the board,
 * another in Jira, and nothing left on either side saying why.
 *
 * The mirror image is as bad and quieter: the record's accepted move
 * comes back to *every* signed-in desktop on the next pull, and each of
 * them would enqueue the same status change again. One move, N pushes,
 * where N is however many people have EO open.
 *
 * ### Why a fact about the database rather than a flag on the call
 *
 * Because it is a fact about the database. Whether these tables are the
 * organisation's record or one machine's copy of it is true of every
 * row in them, and threading it through `transitionItem` and the
 * hundred and twenty-eight callers of `postComment` would be the same
 * mistake `outbound.ts` already argues against — with the same
 * consequence, one call site at a time.
 *
 * A function rather than a boolean, and read at each write, because a
 * person signs in and out without relaunching: a desktop that owned the
 * tracker this morning does not at lunchtime.
 *
 * Unset — a solo desktop, the server, every test that is not about this
 * — answers false. Which is the truth in all three: each of them *is*
 * the record for the rows it holds, and each of them should tell the
 * tracker what happened.
 */
/**
 * ### And why the question takes an item (EO-325)
 *
 * Because after the first sign-in it is no longer true of every row.
 * A person who kept a project local kept *all* of it: those items are
 * still this machine's, their moves are still this machine's to tell a
 * tracker about, and the record has never heard of them. The rows
 * beside them, on a project that was moved, are the record's.
 *
 * So the predicate is asked about an item, and the two callers that
 * have one — the transition writer and the comment writer — pass it.
 * Asked with no item at all, it answers the coarser question this
 * started as: does this machine have a record elsewhere. That is what
 * `createProject` wants, because a project being born has no item to
 * ask about and the honest answer is about the installation.
 */
const replicas = new WeakMap<Db, (itemId?: Uuid) => boolean>();
const projectReplicas = new WeakMap<Db, (projectId: Uuid | null) => boolean>();

/**
 * Says this database is a replica while the predicate answers true.
 *
 * Returns a disposer. Called by `createDeviceRecord`, which is the one
 * thing that knows both halves: which database, and whether this
 * machine has a record elsewhere.
 */
export function markReplica(db: Db, isReplica: (itemId?: Uuid) => boolean, isProjectReplica?: (projectId: Uuid | null) => boolean): () => void {
  replicas.set(db, isReplica);
  if (isProjectReplica === undefined) projectReplicas.delete(db);
  else projectReplicas.set(db, isProjectReplica);
  return () => {
    if (replicas.get(db) === isReplica) replicas.delete(db);
    if (isProjectReplica !== undefined && projectReplicas.get(db) === isProjectReplica) projectReplicas.delete(db);
  };
}

/**
 * Whether the record for these rows lives somewhere else.
 *
 * The one thing that reads it is a *side effect outside EO*. Everything
 * within EO — the item, the thread, the audit row — is written on a
 * replica exactly as it is on the record, because that is what makes it
 * a replica.
 *
 * With an item, it is that item's question: a kept project's rows are
 * this machine's however many other projects the organisation owns.
 * Without one, it is the installation's.
 */
export function isReplica(db: Db, itemId?: Uuid): boolean {
  return replicas.get(db)?.(itemId) === true;
}

/**
 * `isReplica`, asked of an item on this project — or on none, for null —
 * before there is an item to ask about (EO-730): whether a job's next
 * item would be the record's to file. A job used to ask it of its thread
 * item, which sat on the job's project.
 *
 * Where only the item predicate was registered, it is asked without an
 * item: the installation's answer.
 */
export function isProjectReplica(db: Db, projectId: Uuid | null): boolean {
  const forProject = projectReplicas.get(db);
  return forProject !== undefined ? forProject(projectId) : isReplica(db);
}
