import {
  type AcceptInvitationRequest,
  type AcceptInvitationResponse,
  type CredentialKind,
  type Person,
  type SignInRequest,
  type SignInResponse,
} from "@eo/core";
import type { Db } from "../db/client.js";
import { issueDevice } from "../db/repos/devicesRepo.js";
import {
  createPerson,
  findPersonByEmail,
  getPerson,
  normalizeEmail,
  pendingInvitations,
  personCredentials,
  updatePerson,
} from "../db/repos/peopleRepo.js";
import { hashPassword, hashSecret, INVITATION_LIFETIME_MS, mintSecret, passwordMatches, secretMatches } from "./secrets.js";

/**
 * The organisation's front door: invite, accept, sign in (EO-323,
 * `ARCHITECTURE.md`, "Identity").
 *
 * Three transitions and nothing else. An admin **invites** an email
 * address, which writes a person with an outstanding code; that person
 * **accepts** through the link, which sets a credential and records
 * which kind; and their desktop **signs in**, which issues that machine
 * a token the admin can revoke. Everything before the server — the
 * people table, the local person, mentions targeting a person — is phase
 * 5's and is untouched.
 *
 * Results rather than throws, all the way through, because every refusal
 * here is somebody's situation and not a programmer error: an expired
 * link, a password typed wrong, an invitation that was already used. The
 * sentences are the ones the person reads.
 *
 * **What is deliberately not here.** EO sends no email. It has no SMTP
 * configuration, no sender identity and no way to prove it is not spam,
 * and inventing one inside this story would be scope nobody asked for.
 * So `invitePerson` returns the link and the admin's screen shows it to
 * be copied into whatever their organisation already sends mail with.
 * The link is what the story specifies — "invitation by email link
 * containing a one-time code" — and the code in it is exactly as
 * one-time either way.
 */

export type DirectoryResult<T> = { ok: true; value: T } | { ok: false; problem: string };

export interface InviteInput {
  email: string;
  /** What to call them until they correct it themselves on the accept screen. */
  name?: string;
  isAdmin?: boolean;
}

export interface Invitation {
  person: Person;
  /**
   * The code, said once.
   *
   * The row keeps a SHA-256 of it, so this is the only moment the
   * plaintext exists anywhere but in the link. An admin who loses it
   * re-invites, which mints a fresh one and invalidates this.
   */
  code: string;
  expiresAt: number;
}

/**
 * Invites somebody, or re-invites somebody whose link went unanswered.
 *
 * Re-inviting is the same call on purpose. An admin whose colleague
 * never got the mail types the address again, and the honest answer is a
 * fresh code on the same row rather than a second row for one person —
 * which `idx_people_email` would refuse anyway, with a message about a
 * unique index that means nothing to anybody.
 *
 * Somebody who has already accepted is refused, and that refusal is the
 * boundary of this story: EO has no "reset my password" flow, because
 * one is a credential-bearing email EO cannot send (see the file
 * comment). An admin whose colleague is locked out has an answer that
 * works today — delete nothing, and note it as the first thing single
 * sign-on removes the need for.
 */
export function invitePerson(db: Db, input: InviteInput, at: number = Date.now()): DirectoryResult<Invitation> {
  const email = normalizeEmail(input.email);
  if (email === null) return { ok: false, problem: "An invitation needs an email address to go to." };
  if (!email.includes("@")) return { ok: false, problem: `"${input.email.trim()}" is not an email address.` };

  const code = mintSecret();
  const expiresAt = at + INVITATION_LIFETIME_MS;
  const existing = findPersonByEmail(db, email);

  if (existing !== undefined) {
    if (existing.acceptedAt !== null) {
      return { ok: false, problem: `${email} is already on this organisation's list and has accepted their invitation.` };
    }
    updatePerson(db, existing.id, {
      // The admin may be correcting the name as well as re-sending, and
      // an empty name field is not a request to blank it.
      ...(input.name !== undefined && input.name.trim().length > 0 ? { name: input.name.trim() } : {}),
      ...(input.isAdmin === undefined ? {} : { isAdmin: input.isAdmin }),
      invitedAt: at,
      inviteCodeHash: hashSecret(code),
      inviteExpiresAt: expiresAt,
    });
    const refreshed = getPerson(db, existing.id);
    if (refreshed === undefined) throw new Error(`person ${existing.id} vanished between its own write and its read`);
    return { ok: true, value: { person: refreshed, code, expiresAt } };
  }

  const person = createPerson(db, {
    // The local part, until they say otherwise: a list of email
    // addresses is unreadable, and "Anna" is what an admin recognises in
    // a picker on the day they invite three people.
    name: input.name?.trim() || (email.split("@")[0] ?? email),
    email,
    isAdmin: input.isAdmin ?? false,
    invitedAt: at,
    inviteCodeHash: hashSecret(code),
    inviteExpiresAt: expiresAt,
  });
  return { ok: true, value: { person, code, expiresAt } };
}

/**
 * Accepting: the code becomes a credential.
 *
 * Every refusal answers the same sentence, and that is not laziness. A
 * code that never existed, a code that has expired and a code somebody
 * already used are one thing from where the person stands — "this link
 * does not work, ask for another" — and three sentences would be three
 * ways for a stranger with a list of guesses to learn which of them are
 * real.
 *
 * The password is hashed here and `credential_kind` records what was
 * actually stored — which is a password, because a password is the only
 * credential this version's front door can verify. `CredentialKind` is
 * where the argument for that lives; the short version is that a column
 * saying "passkey" about an account with no passkey answers the one
 * question it exists for incorrectly.
 */
export function acceptInvitation(db: Db, request: AcceptInvitationRequest, at: number = Date.now()): DirectoryResult<AcceptInvitationResponse> {
  const unusable = { ok: false, problem: "That invitation link is not one this server is waiting for. Ask your admin to send a new one." } as const;

  const match = pendingInvitations(db).find((row) => secretMatches(request.code, row.inviteCodeHash));
  if (match === undefined) return unusable;
  if (match.inviteExpiresAt !== null && match.inviteExpiresAt <= at) return unusable;
  if (match.person.email === null) return unusable;

  // Written here rather than taken from the request: what this column
  // says is what this function stored, and this function stores a
  // password. A caller cannot tell EO that an account has a credential
  // EO did not create.
  const credentialKind: CredentialKind = "password";
  updatePerson(db, match.person.id, {
    ...(request.name !== undefined && request.name.trim().length > 0 ? { name: request.name.trim() } : {}),
    acceptedAt: at,
    credentialKind,
    passwordHash: hashPassword(request.password),
    // Cleared, which is what makes the code one-time: the same link
    // opened twice finds no pending invitation the second time and is
    // told what every dead link is told.
    inviteCodeHash: null,
    inviteExpiresAt: null,
  });

  const accepted = getPerson(db, match.person.id);
  if (accepted === undefined) throw new Error(`person ${match.person.id} vanished between its own write and its read`);
  return { ok: true, value: { personId: accepted.id, name: accepted.name, email: match.person.email, credentialKind } };
}

/**
 * Signing in: a person and a machine become a device with a token.
 *
 * One sentence for every failure, for `acceptInvitation`'s reason and
 * one more: "no such person" and "wrong password" told apart is a way to
 * enumerate an organisation's staff from outside it.
 *
 * The password is verified even when there is no person, and that is
 * deliberate — `passwordMatches` against a null hash returns false
 * immediately, so a miss would answer in a microsecond where a hit takes
 * scrypt's hundred milliseconds. `DECOY_HASH` is what closes that: an
 * unknown address costs the same as a known one.
 */
export function signIn(db: Db, request: SignInRequest, at: number = Date.now()): DirectoryResult<SignInResponse> {
  const refused = { ok: false, problem: "That email address and password do not match anybody on this server." } as const;

  const person = findPersonByEmail(db, request.email);
  const credentials = person === undefined ? undefined : personCredentials(db, person.id);
  const matched = passwordMatches(request.password, credentials?.passwordHash ?? decoyHash());
  if (person === undefined || !matched) return refused;
  if (person.acceptedAt === null) {
    // Reachable only with a correct password, which an unaccepted row
    // has no way to have: nothing writes `password_hash` but
    // `acceptInvitation`, which writes `accepted_at` in the same
    // statement. Said plainly rather than left as a state nobody
    // considered.
    return { ok: false, problem: "That invitation has not been accepted yet. Open the link your admin sent you first." };
  }

  const token = mintSecret();
  // The second credential, and only for a client that says it runs work
  // (EO-328, ARCHITECTURE.md, "Secrets"). A browser is issued none, so the route that serves
  // organisation secret values is opened by nothing a renderer holds —
  // see `SignInRequest.runsWork` for why the device token could not be
  // that credential.
  const secretsKey = request.runsWork ? mintSecret() : null;
  const device = issueDevice(
    db,
    {
      personId: person.id,
      name: request.deviceName.trim(),
      tokenHash: hashSecret(token),
      // Written either way, including the null: signing in from a
      // browser onto a device row that used to run work has to *take
      // away* the key that row held rather than leave it live.
      secretsKeyHash: secretsKey === null ? null : hashSecret(secretsKey),
      ...(request.deviceId === undefined ? {} : { deviceId: request.deviceId }),
    },
    at,
  );

  return {
    ok: true,
    value: {
      token,
      secretsKey,
      deviceId: device.id,
      person: personView(person),
    },
  };
}

/** A `Person` as the wire carries it. The hashes are not on `Person` at all — see `personCredentials`. */
export function personView(person: Person): SignInResponse["person"] {
  return {
    id: person.id as string,
    name: person.name,
    email: person.email,
    isAdmin: person.isAdmin,
    invitedAt: person.invitedAt,
    acceptedAt: person.acceptedAt,
    credentialKind: person.credentialKind,
  };
}

/**
 * A hash of a password nobody has, computed once per process.
 *
 * Its only job is to make `scryptSync` run for the same time on an
 * address that is not on the list as on one that is. Computed lazily so
 * that importing this module costs nothing, and cached so that the cost
 * is a sign-in's rather than a module load's.
 */
let decoy: string | null = null;
function decoyHash(): string {
  decoy ??= hashPassword(mintSecret());
  return decoy;
}
