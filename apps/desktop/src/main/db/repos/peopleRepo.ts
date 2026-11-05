import { eq, sql } from "drizzle-orm";
import { LOCAL_PERSON_ID, uuidv7, type CredentialKind, type Person, type PipelineStepType, type Uuid } from "@eo/core";
import type { Db } from "../client.js";
import { people } from "../schema.js";

function toDomain(row: typeof people.$inferSelect): Person {
  return {
    id: row.id as Uuid,
    name: row.name,
    email: row.email,
    createdAt: row.createdAt,
    isAdmin: row.isAdmin,
    invitedAt: row.invitedAt,
    acceptedAt: row.acceptedAt,
    credentialKind: (row.credentialKind as CredentialKind | null) ?? null,
  };
}

/** One person by id, or nothing if no row carries it. */
export function getPerson(db: Db, id: Uuid): Person | undefined {
  const row = db.select().from(people).where(eq(people.id, id)).get();
  return row ? toDomain(row) : undefined;
}

/**
 * The implicit local person — "you" (EO-302, ARCHITECTURE.md, "Identity").
 *
 * Migration 0077 creates the row, so this reads rather than creates: an
 * installation that has migrated has it, and an installation that has
 * not cannot have opened at all. Throws if it is missing, because a
 * database with no local person is one where the inbox targets nobody
 * and every mention EO writes points at a row that is not there — a
 * broken installation rather than a case to handle (working agreement:
 * throw only for programmer error).
 */
export function localPerson(db: Db): Person {
  const person = getPerson(db, LOCAL_PERSON_ID);
  if (!person) throw new Error("no local person row — migration 0077 creates it, so this database has not been migrated");
  return person;
}

/**
 * Everyone EO knows, oldest first.
 *
 * Exactly one row in solo mode, and the organisation's list on a server
 * (EO-323). One place to ask, whichever of the two this process is.
 */
export function listPeople(db: Db): Person[] {
  return db.select().from(people).orderBy(people.createdAt, people.id).all().map(toDomain);
}

/**
 * Is this installation solo — one person, nobody else to name (EO-305)?
 *
 * The row count, because that is what solo mode *is*: migration 0077
 * creates exactly one person and nothing else creates another until 7b's
 * server hands over the organisation's list. There is no "managed" flag
 * to read, and inventing one now would be a second thing to keep true.
 *
 * What it decides is how quiet the surface is. Solo mode shows no
 * avatars, no names and no Claim button, because every one of them would
 * be telling the one person about themselves — EO-302 settled that
 * ("the one person is 'you' and nothing new is displayed") and this is
 * where the readers ask it.
 */
export function isSoloMode(db: Db): boolean {
  return listPeople(db).length <= 1;
}

/**
 * Somebody else EO can name (EO-305).
 *
 * `invitePerson` is what fills this table on a server (EO-323). Its
 * other caller is a test of what EO does when there is more than one
 * person — which was most of what EO-305 was about, and was untestable
 * while the table could only ever hold the row a migration wrote.
 */
export function createPerson(db: Db, input: CreatePersonInput): Person {
  const row = {
    id: input.id ?? uuidv7(),
    name: input.name,
    // Lower-cased on the way in, because `idx_people_email` is on
    // `lower(email)` and sign-in looks up the same way: a row stored as
    // `Anna@example.com` would be found by a person typing either
    // spelling, and a second row spelled the other way would be refused
    // by an index the writer could not see the reason for.
    email: normalizeEmail(input.email ?? null),
    createdAt: Date.now(),
    isAdmin: input.isAdmin ?? false,
    invitedAt: input.invitedAt ?? null,
    acceptedAt: input.acceptedAt ?? null,
    credentialKind: input.credentialKind ?? null,
    passwordHash: input.passwordHash ?? null,
    inviteCodeHash: input.inviteCodeHash ?? null,
    inviteExpiresAt: input.inviteExpiresAt ?? null,
  };
  db.insert(people).values(row).run();
  return toDomain(row);
}

/**
 * A row for somebody the record named, under the record's own id
 * (EO-367).
 *
 * A replica cannot point `items.assignee_id` at a person it has no row
 * for, and the organisation's list is not copied down wholesale — it is
 * asked for live, and rows are written one at a time as something here
 * needs to name somebody (`adoptPerson`, `ensureLocalPerson`). This is
 * that for an assignee: the id and the name the screen draws, and no
 * address, so it can never collide with `idx_people_email`.
 *
 * Answers the person, existing or new. An existing row is left exactly
 * as it is: a name already here was written by something that knew more.
 */
export function ensurePerson(db: Db, id: Uuid, name: string): Person {
  return getPerson(db, id) ?? createPerson(db, { id, name });
}

export interface CreatePersonInput {
  id?: Uuid;
  name: string;
  email?: string | null;
  isAdmin?: boolean;
  invitedAt?: number | null;
  acceptedAt?: number | null;
  credentialKind?: CredentialKind | null;
  passwordHash?: string | null;
  inviteCodeHash?: string | null;
  inviteExpiresAt?: number | null;
}

/**
 * One address, one spelling (EO-323).
 *
 * Trimmed and lower-cased, which is what `idx_people_email` indexes and
 * what every lookup compares against. Exported because the sign-in and
 * accept routes normalise what somebody typed before they go looking,
 * and two normalisers is how a person comes to be unable to sign in with
 * the address their invitation was sent to.
 */
export function normalizeEmail(email: string | null): string | null {
  if (email === null) return null;
  const trimmed = email.trim().toLowerCase();
  return trimmed.length === 0 ? null : trimmed;
}

/** The person this address belongs to, or nothing. Case-insensitive, like the index. */
export function findPersonByEmail(db: Db, email: string): Person | undefined {
  const normalized = normalizeEmail(email);
  if (normalized === null) return undefined;
  const row = db.select().from(people).where(sql`lower(${people.email}) = ${normalized}`).get();
  return row ? toDomain(row) : undefined;
}

/**
 * The row as the front door needs it — with the two hashes on it
 * (EO-323).
 *
 * Deliberately not `Person`. Everything else in this file answers with
 * the domain type, which crosses IPC and is rendered; a password hash
 * and an invitation hash must not travel with it by accident, so they
 * are only ever reachable through a function whose name says what it is
 * handing over. `identity/` is the only caller.
 */
export function personCredentials(db: Db, id: Uuid): { passwordHash: string | null; inviteCodeHash: string | null; inviteExpiresAt: number | null } | undefined {
  const row = db
    .select({ passwordHash: people.passwordHash, inviteCodeHash: people.inviteCodeHash, inviteExpiresAt: people.inviteExpiresAt })
    .from(people)
    .where(eq(people.id, id))
    .get();
  return row ?? undefined;
}

/**
 * Everyone with an outstanding invitation, so a presented code can be
 * matched against the hashes.
 *
 * A scan rather than an index: an invitation carries no id — it is one
 * opaque string in a link — and the alternative is putting the person id
 * in the URL beside the code, which is a person's identity in a link
 * somebody may forward. The set is small by construction (it is the
 * people who have been invited and have not accepted) and the scan
 * happens once per acceptance, ever.
 */
export function pendingInvitations(db: Db): Array<{ person: Person; inviteCodeHash: string; inviteExpiresAt: number | null }> {
  return db
    .select()
    .from(people)
    .all()
    .flatMap((row) =>
      row.inviteCodeHash === null || row.acceptedAt !== null
        ? []
        : [{ person: toDomain(row), inviteCodeHash: row.inviteCodeHash, inviteExpiresAt: row.inviteExpiresAt }],
    );
}

/** Changes what a person's row says about them. Absent fields are left alone. */
export function updatePerson(
  db: Db,
  id: Uuid,
  patch: {
    name?: string;
    isAdmin?: boolean;
    invitedAt?: number | null;
    acceptedAt?: number | null;
    credentialKind?: CredentialKind | null;
    passwordHash?: string | null;
    inviteCodeHash?: string | null;
    inviteExpiresAt?: number | null;
  },
): void {
  db.update(people).set(patch).where(eq(people.id, id)).run();
}

/**
 * Who an item belongs to on arriving at a step (EO-305, EO-323, ARCHITECTURE.md, "The board",
 * "Identity").
 *
 * Four answers, and the order they are asked in is the whole of it:
 *
 *  - a human step naming a person — theirs, which is what turns "have
 *    Anna approve it" into a card in Anna's hands rather than a column
 *    somebody has to notice;
 *  - **a human step naming a group — nobody.** "Support team · anyone
 *    claims" is a promise about who acts, and an item that arrived
 *    already assigned would have broken it before anybody looked. Asked
 *    *before* solo mode and not after, which is the correction EO-323's
 *    review turned on: a desktop signed in to an organisation knows one
 *    person locally — itself — so every item arriving at its team's step
 *    was being handed to whoever happened to be sitting there, on a
 *    column head that said anybody could take it;
 *  - a human step naming nobody, in solo mode — the local person, since
 *    there is exactly one pair of hands and asking them to claim their
 *    own work is ceremony;
 *  - a human step naming nobody, with colleagues — nobody. The item
 *    arrives unclaimed and claimable, which is the state a triaging team
 *    needs and the one EO had no way of representing.
 *
 * `undefined` means "this arrival says nothing about the assignee",
 * which is every step that is not a human one: an agent step's assignee
 * is the agent that ran, derived from the newest run and never stored,
 * so writing null there would be overwriting one answer with a worse
 * one. The person who held it last stays on the row and is simply not
 * what the card reads while an agent has it.
 *
 * Both columns are read, and both callers hand them over — see
 * `stepFor` in itemsRepo and the destination select in transitionsRepo.
 * Reading one of two columns that answer one question is how a step's
 * owner came to be half-consulted in the first place.
 */
export function assigneeOnArrival(db: Db, step: StepOwnership | undefined): Uuid | null | undefined {
  if (step?.type !== "user") return undefined;
  if (step.ownerPersonId !== null) return step.ownerPersonId;
  if (step.ownerGroupId !== null) return null;
  return isSoloMode(db) ? LOCAL_PERSON_ID : null;
}

/**
 * What `assigneeOnArrival` has to be told about a step.
 *
 * Named rather than written inline at each call site, because it was
 * written inline at each call site and both of them forgot the same
 * field: a type for it is what makes adding a third kind of owner a
 * compile error at every place that decides an arrival.
 */
export interface StepOwnership {
  type: PipelineStepType;
  ownerPersonId: Uuid | null;
  ownerGroupId: string | null;
}
