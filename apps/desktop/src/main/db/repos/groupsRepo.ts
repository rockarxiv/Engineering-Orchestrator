import { asc, eq, inArray, sql } from "drizzle-orm";
import { uuidv7, type GroupView, type Uuid } from "@eo/core";
import type { Db } from "../client.js";
import { groupMembers, groups, pipelineSteps } from "../schema.js";

/**
 * Groups — "Support team · anyone claims" (EO-323,
 * `ARCHITECTURE.md`, "Identity").
 *
 * A group is who a human step's work is offered to. It carries no
 * rights: there is one admin flag on a person and no per-project role,
 * so membership decides what a column head says and what the assignee
 * picker offers, and nothing else.
 *
 * Members come back as ids rather than as people, because every caller
 * that wants names already has the people list beside it — the picker,
 * the admin's section — and joining here would mean this file deciding
 * what a person looks like on a screen.
 */

function view(db: Db, row: typeof groups.$inferSelect): GroupView {
  return { id: row.id, name: row.name, memberIds: memberIdsOf(db, row.id) };
}

function memberIdsOf(db: Db, groupId: string): string[] {
  return db.select({ personId: groupMembers.personId }).from(groupMembers).where(eq(groupMembers.groupId, groupId)).all().map((row) => row.personId);
}

/** Every group, by name, which is the order a picker reads in. */
export function listGroups(db: Db): GroupView[] {
  return db
    .select()
    .from(groups)
    .orderBy(asc(sql`lower(${groups.name})`))
    .all()
    .map((row) => view(db, row));
}

export function getGroup(db: Db, id: string): GroupView | undefined {
  const row = db.select().from(groups).where(eq(groups.id, id)).get();
  return row === undefined ? undefined : view(db, row);
}

/** The group of this name, or nothing. Case-insensitive, like `idx_groups_name`. */
export function findGroupByName(db: Db, name: string): GroupView | undefined {
  const row = db
    .select()
    .from(groups)
    .where(sql`lower(${groups.name}) = ${name.trim().toLowerCase()}`)
    .get();
  return row === undefined ? undefined : view(db, row);
}

export interface SaveGroupInput {
  /** Absent creates; present renames the group of that id and replaces its members. */
  id?: string;
  name: string;
  /**
   * Who is in it, in full.
   *
   * The whole set rather than an add and a remove, because the screen
   * that edits a group edits a list of checkboxes and submits what it
   * shows — and "add A, remove B" from two clients is how a membership
   * ends up as neither of the two things either of them meant.
   */
  memberIds: readonly string[];
}

/**
 * Creates or replaces one group, and its membership with it.
 *
 * Inside a transaction, because a group whose name was saved and whose
 * members were not is a team that exists and is empty — and the screen
 * that wrote it would show it as saved.
 */
export function saveGroup(db: Db, input: SaveGroupInput): GroupView {
  const id = input.id ?? (uuidv7() as string);
  const name = input.name.trim();

  db.transaction((tx) => {
    tx.insert(groups)
      .values({ id, name, createdAt: Date.now() })
      .onConflictDoUpdate({ target: groups.id, set: { name } })
      .run();
    tx.delete(groupMembers).where(eq(groupMembers.groupId, id)).run();
    const members = [...new Set(input.memberIds)];
    if (members.length > 0) {
      tx.insert(groupMembers)
        .values(members.map((personId) => ({ groupId: id, personId })))
        .run();
    }
  });

  const saved = getGroup(db, id);
  if (saved === undefined) throw new Error(`group ${id} vanished between its own write and its read`);
  return saved;
}

/**
 * Deletes a group, and unnames it wherever a step was waiting on it.
 *
 * The second half is what makes the first safe. `pipeline_steps.owner_group_id`
 * carries no foreign key (see schema.ts for why), so nothing in SQLite
 * would clear it — a deleted group would leave a column head naming a
 * team that does not exist, which reads as "Nobody assigned" only if you
 * know to look it up. Cleared here instead, in the same transaction, so
 * those steps go back to what an unowned step has always been: it waits
 * for whoever is there.
 */
export function deleteGroup(db: Db, id: string): void {
  db.transaction((tx) => {
    tx.update(pipelineSteps).set({ ownerGroupId: null }).where(eq(pipelineSteps.ownerGroupId, id)).run();
    tx.delete(groups).where(eq(groups.id, id)).run();
  });
}

/** The groups these people are in, for a picker that wants to say "in 2 groups". */
export function groupsForPeople(db: Db, personIds: readonly Uuid[]): Map<string, string[]> {
  const byPerson = new Map<string, string[]>();
  if (personIds.length === 0) return byPerson;
  for (const row of db.select().from(groupMembers).where(inArray(groupMembers.personId, [...personIds])).all()) {
    byPerson.set(row.personId, [...(byPerson.get(row.personId) ?? []), row.groupId]);
  }
  return byPerson;
}
