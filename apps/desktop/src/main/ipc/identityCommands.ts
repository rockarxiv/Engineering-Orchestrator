import { invitationPath, type IpcChannel, type IpcPayload, type IpcResponse, type PersonView, type Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import { listDevices, revokeDevice } from "../db/repos/devicesRepo.js";
import { deleteGroup, getGroup, findGroupByName, listGroups, saveGroup } from "../db/repos/groupsRepo.js";
import { createPerson, ensurePerson, findPersonByEmail, getPerson, listPeople, updatePerson } from "../db/repos/peopleRepo.js";
import { isReplica } from "../db/recordRole.js";
import { rememberedOrganisationPerson, rememberOrganisationPeople } from "../managed/session.js";
import { getStep, setStepOwner } from "../db/repos/pipelineStepsRepo.js";
import { actingCaller } from "../identity/acting.js";
import { signedInPersonId } from "../identity/viewer.js";
import { getItem } from "../db/repos/itemsRepo.js";
import { stepForItem } from "../db/repos/pipelineVersionsRepo.js";
import { authorityFor, holderView } from "../record/stepAuthority.js";
import { acceptInvitation, invitePerson, personView, signIn } from "../identity/directory.js";
import type { ManagedDirectory } from "../managed/directory.js";

/**
 * The organisation's list, as channels (EO-323,
 * `ARCHITECTURE.md`, "Identity",
 * "The record").
 *
 * Every one of these is in the record half, and the rule that decides
 * where each of them *runs* is the one the design already states: **the record
 * owns the list, and a desktop's action on it is a command the record
 * applies.** So on a desktop signed in to an organisation, inviting
 * somebody, making somebody an admin, editing a group, listing devices
 * and revoking one all go to the server; on a solo desktop, and on the
 * server itself, they are answered here, from this process's own tables.
 * One code path, and "managed" is a question of where the record lives.
 *
 * That was not true for one review round and the split it left was
 * exactly the kind this file's comments claim cannot happen: the picker
 * on a column head was fed from the server while every write went to
 * SQLite, so the names a person could choose were names this machine
 * could not resolve. A group picked from the list was refused by its own
 * handler, an admin's Devices panel on a desktop was always empty, and
 * an invitation minted on a desktop pointed at a server that had never
 * heard of the code.
 *
 * ### The one thing that stays here, and why
 *
 * `steps:setOwner` is not forwarded. A step is not on the record in this
 * phase: pipelines are published by an admin in 7c, so until then the
 * steps a desktop draws are its own, with ids the server has never seen.
 * Forwarding would fail for every pipeline somebody made and succeed by
 * coincidence for the one EO ships, whose step ids are literals in the
 * seed migration — which is worse than either answer.
 *
 * So the step stays local and the *name* it needs comes with it: see
 * `adopt`. That is not sync, which is the next story. It is one row
 * written because a foreign key demands it and a column head has to be
 * drawable with the server unreachable (ARCHITECTURE.md, "The record").
 */

export type IdentityContext = {
  /**
   * How this installation reaches its organisation, when it has one.
   *
   * Absent on a server — which *is* the record, and has nobody to ask —
   * and inert on a solo desktop, where `client()` answers null. In both
   * of those cases every command below answers from this process's own
   * tables, which is what makes the server and the solo desktop one
   * implementation rather than two.
   */
  managed?: ManagedDirectory;
};

/**
 * Hands a command to the organisation's record, if there is one.
 *
 * `null` means this installation *is* the record — a solo desktop or the
 * server itself — and the caller should answer from its own tables. Any
 * other answer is the record's, including its refusals: an admin who is
 * told "that address is already on this organisation's list" is being
 * told something only the server knows.
 *
 * A failure to reach the server is **not** a fall back to local. These
 * are writes to a list this machine does not own, and answering them
 * from a copy would mean the person watching a group appear on their
 * screen while the organisation never heard of it. `refused` turns the
 * transport's sentence into the channel's own shape, so every one of
 * them says what went wrong in the field its screen already reads.
 */
async function onTheRecord<K extends IpcChannel>(
  context: IdentityContext,
  channel: K,
  payload: IpcPayload<K>,
  refused: (problem: string) => IpcResponse<K>,
): Promise<IpcResponse<K> | null> {
  const client = context.managed?.client() ?? null;
  if (client === null) return null;
  const answer = await client.request(channel, payload);
  return answer.ok ? answer.data : refused(answer.error.message);
}

/**
 * Everyone and every group EO can name.
 *
 * From the server when this desktop is signed in to one, and from here
 * otherwise. A server asked this answers from its own tables, which is
 * the same code path with `managed` absent.
 *
 * A server that cannot be reached falls back to the local rows rather
 * than failing, and says `fromServer: false` while doing it. This is the
 * one channel in the file that falls back, and the difference is that it
 * is a *read*: the picker then offers what this machine knows, which in
 * managed mode is at worst "you" — honest, small, and not an error
 * dialog in the middle of choosing who approves a step. The original design is the rule
 * being followed: "managed mode never stops a person from working."
 */
export async function listPeopleCommand(db: Db, context: IdentityContext = {}): Promise<IpcResponse<"people:list">> {
  const client = context.managed?.client() ?? null;
  if (client !== null) {
    const answer = await client.request("people:list", undefined);
    if (answer.ok) {
      // Kept, so a colleague picked from this list can still be named
      // once the network has gone (EO-367, review — see `knowAssignee`).
      rememberOrganisationPeople(db, answer.data.people);
      return { people: answer.data.people, groups: answer.data.groups, fromServer: true };
    }
  }
  return { people: listPeople(db).map(personView), groups: listGroups(db), fromServer: false };
}

/**
 * Who is asking, answered by whoever holds the record (EO-326, ARCHITECTURE.md, "Identity").
 *
 * The one question a browser served by a server cannot ask any other
 * way. It never signed in from a machine, so `session:status` — which is
 * about *this installation's* sign-in and is in the machine half —
 * refuses it; all it holds is a token, and nothing in the bundle knows
 * whose. So the door turns that token into a device, and this turns the
 * device back into a person.
 *
 * Not forwarded to the server the way the writes above are, and that is
 * not an omission. This channel answers "who is asking *me*", so on a
 * desktop the honest answer is the local person and their own
 * installation — forwarding would answer with the organisation's idea of
 * them, which is `session:status`'s job and already has a screen.
 *
 * `organisation` is what the renderer hangs the admin surface off,
 * rather than `person.isAdmin`. A solo desktop's one person may carry
 * the admin flag perfectly well — `people:setAdmin` is answered locally
 * when there is no server — and an "every project" view on a machine
 * with one person and one project would be a second, emptier copy of the
 * board they are already looking at.
 */
export function whoAmICommand(db: Db, payload?: IpcPayload<"people:me">): IpcResponse<"people:me"> {
  const caller = actingCaller(db, payload?.actingDeviceId);
  return {
    person: caller.person === null ? null : personView(caller.person),
    admin: caller.admin,
    organisation: caller.served,
  };
}

/** Invites somebody, and answers with the one-time path to send them. */
export async function invitePersonCommand(
  db: Db,
  payload: IpcPayload<"people:invite">,
  context: IdentityContext = {},
): Promise<IpcResponse<"people:invite">> {
  const onServer = await onTheRecord(context, "people:invite", payload, (problem) => ({
    person: null,
    invitePath: null,
    expiresAt: null,
    problem,
  }));
  if (onServer !== null) return onServer;

  const invited = invitePerson(db, {
    email: payload.email,
    ...(payload.name === undefined ? {} : { name: payload.name }),
    isAdmin: payload.isAdmin,
  });
  if (!invited.ok) return { person: null, invitePath: null, expiresAt: null, problem: invited.problem };
  return {
    person: personView(invited.value.person),
    invitePath: invitationPath(invited.value.code),
    expiresAt: invited.value.expiresAt,
    problem: null,
  };
}

/**
 * Turns the admin flag on or off.
 *
 * Refuses to take the last one away, which is the one rule an admin
 * screen needs and cannot be given back afterwards: a server with nobody
 * who may edit it is a server whose people list can never change again,
 * and the only way out would be the operator's token — which is exactly
 * the state an organisation has moved past by the time this matters.
 */
export async function setAdminCommand(
  db: Db,
  payload: IpcPayload<"people:setAdmin">,
  context: IdentityContext = {},
): Promise<IpcResponse<"people:setAdmin">> {
  const onServer = await onTheRecord(context, "people:setAdmin", payload, (problem) => ({ person: null, problem }));
  if (onServer !== null) return onServer;

  const person = getPerson(db, payload.personId as Uuid);
  if (person === undefined) return { person: null, problem: "That person is not on this server's list." };

  if (!payload.isAdmin && person.isAdmin) {
    const others = listPeople(db).filter((candidate) => candidate.isAdmin && candidate.id !== person.id);
    if (others.length === 0) {
      return { person: personView(person), problem: "This is the only administrator left. Make somebody else an administrator first." };
    }
  }

  updatePerson(db, person.id, { isAdmin: payload.isAdmin });
  const updated = getPerson(db, person.id);
  return { person: updated === undefined ? null : personView(updated), problem: null };
}

/** Accepting an invitation. One of the two channels a caller reaches without a token. */
export function acceptInvitationCommand(db: Db, payload: IpcPayload<"auth:acceptInvitation">): IpcResponse<"auth:acceptInvitation"> {
  const accepted = acceptInvitation(db, payload);
  return accepted.ok ? { accepted: accepted.value, problem: null } : { accepted: null, problem: accepted.problem };
}

/** Signing a device in. The other channel a caller reaches without a token. */
export function signInCommand(db: Db, payload: IpcPayload<"auth:signIn">): IpcResponse<"auth:signIn"> {
  const session = signIn(db, payload);
  return session.ok ? { session: session.value, problem: null } : { session: null, problem: session.problem };
}

/**
 * The admin's Devices list, revoked rows included — see `listDevices`
 * for why.
 *
 * From the organisation when there is one, and that is the whole of what
 * this list *is* on a desktop: nothing ever signs in to a laptop, so its
 * own `devices` table is empty and always will be. An unreachable server
 * says so in `problem` rather than answering with that emptiness, which
 * would be a claim about the organisation invented by a client that
 * could not ask it.
 */
export async function listDevicesCommand(db: Db, context: IdentityContext = {}): Promise<IpcResponse<"devices:list">> {
  const onServer = await onTheRecord(context, "devices:list", undefined, (problem) => ({ devices: [], problem }));
  if (onServer !== null) return onServer;
  return { devices: listDevices(db), problem: null };
}

/** Revoke. Its next request is a 401 and the desktop holding it says who signed it out. */
export async function revokeDeviceCommand(
  db: Db,
  payload: IpcPayload<"devices:revoke">,
  context: IdentityContext = {},
): Promise<IpcResponse<"devices:revoke">> {
  const onServer = await onTheRecord(context, "devices:revoke", payload, (problem) => ({ device: null, problem }));
  if (onServer !== null) return onServer;

  const device = revokeDevice(db, payload.deviceId);
  return device === undefined ? { device: null, problem: "There is no such device on this server." } : { device, problem: null };
}

/** Creates or replaces a group and its membership. */
export async function saveGroupCommand(
  db: Db,
  payload: IpcPayload<"groups:save">,
  context: IdentityContext = {},
): Promise<IpcResponse<"groups:save">> {
  const onServer = await onTheRecord(context, "groups:save", payload, (problem) => ({ group: null, problem }));
  if (onServer !== null) return onServer;

  const name = payload.name.trim();
  if (name.length === 0) return { group: null, problem: "A group needs a name — it is what a column head shows." };

  const clash = findGroupByName(db, name);
  if (clash !== undefined && clash.id !== payload.id) {
    return { group: null, problem: `There is already a group called "${clash.name}".` };
  }

  const unknown = payload.memberIds.filter((id) => getPerson(db, id as Uuid) === undefined);
  if (unknown.length > 0) return { group: null, problem: "That group names somebody who is not on this list." };

  return { group: saveGroup(db, { ...(payload.id === undefined ? {} : { id: payload.id }), name, memberIds: payload.memberIds }), problem: null };
}

/** Deletes a group, and unnames it on every step that was waiting on it (`deleteGroup`). */
export async function deleteGroupCommand(
  db: Db,
  payload: IpcPayload<"groups:delete">,
  context: IdentityContext = {},
): Promise<IpcResponse<"groups:delete">> {
  const onServer = await onTheRecord(context, "groups:delete", payload, (problem) => ({ deleted: false, problem }));
  if (onServer !== null) return onServer;

  if (getGroup(db, payload.groupId) === undefined) return { deleted: false, problem: "There is no such group." };
  deleteGroup(db, payload.groupId);
  return { deleted: true, problem: null };
}

/**
 * Who a human step waits on: a person, a group, or nobody (ARCHITECTURE.md, "Identity").
 *
 * Both named at once is refused rather than resolved, and that is the
 * point of the refusal: "Anna Ruiz · approves here" and "Support team ·
 * anyone claims" are different promises about who is expected to act,
 * and a step carrying both would have to have one of them silently
 * chosen for it by whichever renderer read it first.
 *
 * A step that is not a human one is refused too. Nothing waits at an
 * agent step — the agent runs — so an owner there would be a name on a
 * column head that means nothing, which is worse than no control at all
 * (invariant #12's spirit, one level down).
 *
 * **The step is local and the name comes to it.** Unlike everything else
 * in this file, this is not forwarded to the record: pipelines are the
 * admin's to publish in 7c, so a desktop's steps are its own and the
 * server has never seen their ids. What *is* on the record is the person
 * or group the picker offered, so the row that names them is written
 * here as they are chosen — see `adopt`.
 */
export async function setStepOwnerCommand(
  db: Db,
  payload: IpcPayload<"steps:setOwner">,
  context: IdentityContext = {},
): Promise<IpcResponse<"steps:setOwner">> {
  if (payload.personId !== null && payload.groupId !== null) {
    return { problem: "A step waits on a person or on a group, not on both." };
  }

  const step = getStep(db, payload.stepId);
  if (step === undefined) return { problem: "That step is not in this pipeline any more." };
  if (step.type !== "user") return { problem: `"${step.name}" is not a step a person waits at, so nobody waits on it.` };

  const owner = await adopt(db, context, payload);
  if ("problem" in owner) return owner;

  setStepOwner(db, step.id, owner);
  return { problem: null };
}

/**
 * Makes sure this machine can name whoever was just picked — or says it
 * cannot (EO-323).
 *
 * Returns a refusal, or null when the step may be written.
 *
 * **Why a local row is not optional.** `pipeline_steps.owner_person_id`
 * is a foreign key into `people`, so a step waiting on a colleague
 * cannot be written at all until that colleague is a row here. And the
 * column head is drawn from this database — `stepVerifications` reads
 * `getGroup` and `getPerson` — so a board with the server unreachable
 * would otherwise show "You approve here" on a step a whole team is
 * waiting at, which is the original design's "managed mode never stops a person from
 * working" failing in the quietest possible way.
 *
 * **Why this is not sync.** It copies nothing nobody asked for: one row,
 * at the moment somebody chooses it, holding the name a screen has to
 * draw. It keeps the record's own id, so when sync lands (the next
 * story) the two sides already agree about who this is rather than
 * needing to be reconciled. A group's *membership* is deliberately left
 * empty here: who is in a team is the organisation's to say, the picker
 * never asks this machine, and inventing local rows for people nobody
 * has picked would be the copying this paragraph is denying.
 */
type AdoptedOwner = { personId: Uuid | null; groupId: string | null } | { problem: string };

async function adopt(db: Db, context: IdentityContext, payload: IpcPayload<"steps:setOwner">): Promise<AdoptedOwner> {
  const owner = { personId: payload.personId as Uuid | null, groupId: payload.groupId };

  if (owner.personId !== null && getPerson(db, owner.personId) === undefined) {
    const known = await fromTheList(db, context, (list) => list.people.find((person) => person.id === owner.personId));
    if (!known.asked) return { problem: UNREACHABLE };
    if (known.found === undefined) return { problem: "That person is not on this list." };
    // The id this machine will actually point its foreign key at, which
    // is the record's own unless this colleague was already here under
    // another one — see `adoptPerson`.
    owner.personId = adoptPerson(db, known.found);
  }

  if (owner.groupId !== null && getGroup(db, owner.groupId) === undefined) {
    const known = await fromTheList(db, context, (list) => list.groups.find((group) => group.id === owner.groupId));
    if (!known.asked) return { problem: UNREACHABLE };
    if (known.found === undefined) return { problem: "That group is not on this list." };
    // A name this machine already uses for a different team. Refused
    // rather than reconciled: the person picked their organisation's
    // "Support team", and silently pointing the step at a local group
    // that happens to share its name would be a column head telling the
    // truth about a different set of people.
    const clash = findGroupByName(db, known.found.name);
    if (clash !== undefined && clash.id !== known.found.id) {
      return { problem: `This machine already has its own group called "${known.found.name}". Rename or delete it before using your organisation's.` };
    }
    saveGroup(db, { id: known.found.id, name: known.found.name, memberIds: [] });
  }

  return owner;
}

/**
 * The colleague an item is being handed to, as a row this machine can
 * point at — when the item's record is elsewhere (EO-367, review).
 *
 * `AssigneePicker` offers the organisation's list, from `people:list`,
 * and that read writes nothing here. So the person somebody just picked
 * is, as often as not, nobody this database has heard of, and the
 * assignment would have nothing to show while it waits for the record.
 * This asks the same list and writes the one row, under the record's own
 * id — the id the command carries and the record will answer with — so
 * the card names them at once and the pull that confirms it finds the
 * row already here.
 *
 * `ensurePerson` rather than `adoptPerson`, for that id: an address this
 * machine already holds under another id would make the provisional
 * assignee a different id from the one the record writes. The row
 * carries no address, so it cannot collide with one.
 *
 * When it cannot ask, it names them from the last list the organisation
 * answered with (`rememberOrganisationPeople`) — the list the picker was
 * showing. Only a colleague this machine has never been told about at
 * all leaves the item showing what it showed, drawn as queued, and the
 * record still decides — the original design's "managed mode never stops a person from
 * working".
 * A solo desktop, and a kept project, are not asked about at all.
 */
export async function knowAssignee(db: Db, payload: IpcPayload<"items:assign">, context: IdentityContext): Promise<void> {
  if (!isReplica(db, payload.itemId as Uuid)) return;
  if (getPerson(db, payload.personId as Uuid) !== undefined) return;
  const known = await fromTheList(db, context, (list) => list.people.find((person) => person.id === payload.personId));
  // …or off the last list the organisation answered with, which is the
  // list the picker is most likely still showing when the network has
  // gone between reading it and choosing.
  const found = known.found ?? rememberedOrganisationPerson(db, payload.personId);
  if (found !== undefined) ensurePerson(db, found.id as Uuid, found.name);
}

/** What a person is told when the name they picked is on a list this machine could not fetch. */
const UNREACHABLE = "EO could not reach your organisation just now, so it cannot say who that is. Try again in a moment.";

/**
 * One entry out of the organisation's list.
 *
 * `asked` is false when the record did not answer, and the two are kept
 * apart because they are different sentences about a person: "there is
 * no such colleague" and "EO could not ask" are told to somebody who has
 * just picked a name off a list, and confusing them means telling them a
 * colleague who exists does not.
 *
 * Only what the record actually answered is searched. The local rows
 * have already been looked at by the caller — that is why we are here —
 * and treating `people:list`'s offline fall back as a second chance
 * would be searching the same table twice.
 */
async function fromTheList<T>(
  db: Db,
  context: IdentityContext,
  pick: (list: IpcResponse<"people:list">) => T | undefined,
): Promise<{ asked: boolean; found: T | undefined }> {
  // A solo desktop has no record to ask and its own rows *are* the list,
  // so "not here" is the final answer rather than a failure to reach
  // anybody.
  if (context.managed?.client() == null) return { asked: true, found: undefined };
  const list = await listPeopleCommand(db, context);
  return list.fromServer ? { asked: true, found: pick(list) } : { asked: false, found: undefined };
}

/**
 * The colleague, as a row this machine can point a foreign key at.
 *
 * Their own id from the record, so the two sides already agree. An
 * address this database has already seen under another id is the same
 * human met twice — a person who existed here before this machine signed
 * in — and that row is used rather than a second one written, because
 * `idx_people_email` would refuse the second anyway and because two rows
 * for one colleague is precisely what that index exists to prevent.
 *
 * Answers the id the step should carry, which is why it is not `void`:
 * in that second case it is *this machine's* id rather than the
 * record's, and a caller that assumed otherwise would write a foreign
 * key pointing at nothing.
 */
function adoptPerson(db: Db, person: PersonView): Uuid {
  const seen = person.email === null ? undefined : findPersonByEmail(db, person.email);
  if (seen !== undefined) return seen.id;
  return createPerson(db, {
    id: person.id as Uuid,
    name: person.name,
    email: person.email,
    isAdmin: person.isAdmin,
    invitedAt: person.invitedAt,
    acceptedAt: person.acceptedAt,
    credentialKind: person.credentialKind,
  }).id;
}

/**
 * Who may act on this item where it stands, for whoever is asking
 * (EO-368, `items:authority`).
 *
 * Three places answer it, the way every identity question here is
 * answered:
 *
 * - **The record, for a browser** — the door stamped who is asking, and
 *   the record's own groups and holder answer.
 * - **A signed-in desktop, for an item on the record** — membership is
 *   the organisation's to say, so it is asked of the record, which
 *   answers for the person this device belongs to. Who *holds* the item
 *   is this machine's copy, which already shows a claim or a takeover
 *   the moment it is made: the record has not heard of it yet, and a
 *   screen that waited for it would offer Claim again under the person
 *   who has just pressed it. If the record cannot be asked, this
 *   machine's copy answers alone, and where it cannot say whether the
 *   person is in the group it assumes they are — the record refuses if
 *   not, and says why (ARCHITECTURE.md, "The record": managed mode never stops a person working).
 * - **Anything else** — a solo desktop, a project kept on this machine —
 *   is nothing gated: null, and every screen draws what it always drew.
 */
export async function itemAuthorityCommand(
  db: Db,
  payload: IpcPayload<"items:authority">,
  context: IdentityContext = {},
): Promise<IpcResponse<"items:authority">> {
  const itemId = payload.itemId as Uuid;
  const item = getItem(db, itemId);
  if (item === undefined) return { authority: null };

  if (!isReplica(db, itemId)) {
    const acting = actingCaller(db, payload.actingDeviceId);
    if (!acting.served) return { authority: null };
    return { authority: authorityFor(db, item, acting.person?.id ?? null) };
  }

  let group: { id: string; name: string } | null = null;
  let outsider = false;
  const client = context.managed?.client() ?? null;
  if (client !== null) {
    const answer = await client.request("items:authority", { itemId });
    if (answer.ok) {
      if (answer.data.authority === null) return { authority: null };
      group = answer.data.authority.group;
      outsider = answer.data.authority.you === "outsider";
    }
  }
  const you = signedInPersonId(db);
  if (group === null) {
    const step = stepForItem(db, item);
    if (step === undefined || step.type !== "user" || step.ownerGroupId === null) return { authority: null };
    const local = getGroup(db, step.ownerGroupId);
    group = { id: step.ownerGroupId, name: local?.name ?? "its group" };
    outsider = local !== undefined && !local.memberIds.includes(you);
  }
  const holder = holderView(db, item.assigneeId);
  return { authority: { group, holder, you: outsider ? "outsider" : holder !== null && holder.id === you ? "holder" : "member" } };
}
