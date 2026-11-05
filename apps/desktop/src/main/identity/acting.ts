import { LOCAL_PERSON_ID, type Person, type Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import { getDevice } from "../db/repos/devicesRepo.js";
import { groupsForPeople } from "../db/repos/groupsRepo.js";
import { getPerson, isSoloMode, localPerson } from "../db/repos/peopleRepo.js";
import { listProjects, projectIdsForPerson } from "../db/repos/projectsRepo.js";

/**
 * Who a request is acting as, on this side of the door (EO-326,
 * `ARCHITECTURE.md`, "Identity").
 *
 * `server/http.ts` decides *which device* a request came from and stamps
 * it into the payload; this turns that id back into the two facts a
 * handler actually asks: which person, and whether they may see the
 * whole organisation. One place, so that eight handlers cannot each
 * invent their own reading of a missing id.
 *
 * The three shapes `actingDeviceId` arrives in are all real, and this is
 * where each is given its answer:
 *
 *  - **absent** — a desktop, or the MCP host on one. Nothing
 *    authenticated because nothing had to: the person at the keyboard
 *    owns the machine and its database (which is `ADMIN_ONLY_CHANNELS`'
 *    own argument for why it is enforced at a server's door and nowhere
 *    else). So the acting person is the local one, and they see
 *    everything on their own installation;
 *  - **null** — the operator's key. Not a member of the organisation it
 *    administers: there is no laptop behind it and no person row, so
 *    `person` is null and `admin` is true;
 *  - **an id** — a signed-in device. Its row names the person, and the
 *    person's flag says whether they are an admin.
 *
 * A device id that resolves to nothing — revoked between the door and
 * here, or a row deleted underneath it — is nobody and not an admin.
 * That is the one case where the answer is narrower than any of the
 * three above, which is the right direction for it to fail in.
 */
export interface ActingCaller {
  /** The person this request is, or null for a key that is not one. */
  person: Person | null;
  /**
   * The device row this request came from, where one did.
   *
   * Kept beside the person because a transition records the *device* —
   * `transitions.device_id` is the column that joins a move to a name,
   * and resolving the person here only to throw the id away would mean
   * the audit row could not answer "whose move was that" the way
   * `whoMovedIt` already asks it.
   */
  deviceId: string | null;
  /** May they see every project on this record (the design's one admin flag)? */
  admin: boolean;
  /**
   * Whether anybody authenticated to get here.
   *
   * What separates "a browser served by the organisation's server" from
   * "the desktop in front of somebody", which is the difference the
   * renderer draws its admin surface on. False on a desktop, always.
   */
  served: boolean;
}

/** Who is acting, from whatever the door stamped. */
export function actingCaller(db: Db, actingDeviceId: string | null | undefined): ActingCaller {
  if (actingDeviceId === undefined) return { person: localPerson(db), deviceId: null, admin: true, served: false };
  if (actingDeviceId === null) return { person: null, deviceId: null, admin: true, served: true };

  const device = getDevice(db, actingDeviceId);
  if (device === undefined) return { person: null, deviceId: null, admin: false, served: true };
  const person = getPerson(db, device.personId as Uuid);
  return { person: person ?? null, deviceId: actingDeviceId, admin: person?.isAdmin ?? false, served: true };
}

/**
 * The person a write is filed under, for a handler that must name one.
 *
 * `localPerson` where nobody authenticated, which is every desktop and
 * is exactly what these handlers did before this story existed. The
 * operator's key falls here too, and deliberately: it is the credential
 * the container was started with, held by the person who runs the
 * server, and attributing their move to the record's own local-person
 * row is what EO already did with it. Refusing them instead would take
 * away the only way into a server that has nobody on its people list,
 * to buy an attribution nobody was asking for.
 */
export function actingPersonId(db: Db, actingDeviceId: string | null | undefined): Uuid {
  return (actingCaller(db, actingDeviceId).person?.id ?? LOCAL_PERSON_ID) as Uuid;
}

/**
 * Which projects this caller may be shown (EO-326, ARCHITECTURE.md, "Identity").
 *
 * `null` means every one of them, and is the answer for a desktop and
 * for an admin — "the admin sees every project's board and inbox,
 * because the record syncs up". Everybody else sees **the projects they
 * have work on**.
 *
 * That phrase is the whole decision, so it is worth being exact about
 * what it means and what it does not. There is no membership table and
 * this story does not add one: the original design defers per-project roles ("with the
 * first customer who asks, not before"), and a `project_members` row
 * would be that decision made early and quietly. So membership is
 * *derived*, from the three ways the record already knows a project
 * expects somebody — they filed an item on it, an item on it is theirs,
 * or one of its steps waits on them or on a group they are in.
 *
 * It is a **visibility** rule, not an access boundary, and the
 * difference matters enough to say out loud. `items:get` still answers
 * for any id a signed-in caller names, because deciding who may read one
 * item is the permission model the design defers. What this rule settles is
 * what a person is *shown* — which projects are in their switcher, which
 * mentions are in their list — so that a colleague signing in to the
 * browser lands in their own work rather than in the whole
 * organisation's. A server that needs the stronger thing needs the model
 * that was deferred, and will not find half of it hidden here.
 */
export function visibleProjectIds(db: Db, caller: ActingCaller): Set<string> | null {
  if (!caller.served || caller.admin) return null;
  if (caller.person === null) return new Set();
  // A solo installation has one person and nothing to narrow to. Asked
  // before the queries rather than after, so the common case does not
  // pay for a rule that cannot change its answer.
  if (isSoloMode(db)) return null;

  const groupIds = groupsForPeople(db, [caller.person.id]).get(caller.person.id) ?? [];
  return projectIdsForPerson(db, caller.person.id, groupIds);
}

/** Every project id this caller may be shown, as a concrete list. */
export function visibleProjects(db: Db, caller: ActingCaller): string[] {
  const allowed = visibleProjectIds(db, caller);
  // Never an archived one (EO-347): this is the fallback a board is
  // scoped to, and an archived project has no board to fall back on.
  const every = listProjects(db)
    .filter((project) => project.archivedAt === null)
    .map((project) => project.id as string);
  return allowed === null ? every : every.filter((id) => allowed.has(id));
}

/**
 * The author to post a human comment as.
 *
 * A comment written by somebody EO can name carries their person id; one
 * written where there is only ever one person carries nothing, and the
 * column stays null as it has since comments existed. Spelled as an
 * absent key rather than an explicit null so a desktop's insert is
 * byte-for-byte the insert it already made.
 */
export function humanAuthor(caller: ActingCaller): { type: "human"; personId?: Uuid } {
  return caller.person === null || !caller.served ? { type: "human" } : { type: "human", personId: caller.person.id };
}

/**
 * The device half of a transition, for a move somebody asked for.
 *
 * Spread into a `TransitionCommand`, and absent where no device asked —
 * which is every desktop, whose transitions have always recorded none.
 */
export function actingDevice(caller: ActingCaller): { deviceId?: string } {
  return caller.deviceId === null ? {} : { deviceId: caller.deviceId };
}

/**
 * The project a board read should answer for (EO-326, ARCHITECTURE.md, "Identity").
 *
 * `items:list`, `items:listArchived` and `inbox:list` each take a
 * project and fall back to "whichever this installation is showing",
 * which is a setting in `app_settings` — one per installation, and on a
 * server therefore one shared by everybody who opens it. That was
 * harmless while a server had one kind of visitor. It is not harmless
 * now: a colleague whose switcher lists two projects would have been
 * handed the board of a third, narrowed in the list and not in the
 * cards, with nothing on screen explaining why.
 *
 * So a requested project the caller cannot see falls back to one they
 * can, and an admin and a desktop keep the setting they had. What it
 * does **not** do is refuse: this is the same visibility rule
 * `visibleProjectIds` states, and refusing here would be half of the
 * access model the design defers, arriving on three channels out of thirty.
 *
 * Two admins on one server still share the setting, and switching
 * project in one browser still moves the other's board. That is the
 * shape this setting has had since a browser could reach it at all, and
 * making it per-caller means giving a server somewhere to keep a
 * per-caller view — which is a thing to store, and this story stores
 * nothing.
 */
export function scopedProjectId(db: Db, caller: ActingCaller, requested: string | null): string | null {
  const allowed = visibleProjectIds(db, caller);
  if (allowed === null || (requested !== null && allowed.has(requested))) return requested;
  return visibleProjects(db, caller)[0] ?? null;
}

/**
 * The person a *read* should answer for, or nobody in particular.
 *
 * `actingPersonId`'s counterpart, and the difference matters. A write
 * has to be filed under somebody, so that one falls back to the local
 * person. A read must not: on a desktop the honest answer to "whose
 * inbox" is not one person but `viewerFor`'s per-item question, which
 * answers the local person on a kept project and the organisation's on a
 * managed one (EO-325). Naming a single person here would override it
 * and empty a managed project's inbox with nothing looking broken.
 *
 * So: the caller's person where a door stamped one, and `undefined`
 * everywhere else.
 */
export function actingReader(db: Db, actingDeviceId: string | null | undefined): Uuid | undefined {
  const caller = actingCaller(db, actingDeviceId);
  return caller.served ? (caller.person?.id as Uuid | undefined) : undefined;
}
