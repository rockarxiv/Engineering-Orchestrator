import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  normalizeServerAddress,
  SIGNED_OUT_BY_ORGANISATION_LINE,
  type SessionStatus,
} from "@eo/core";
import type { Db } from "../db/client.js";
import { clearSetting, getSetting, setSetting } from "../db/repos/settingsRepo.js";
import { forgetPublishedSections } from "../db/repos/publishedSectionsRepo.js";
import type { SecretStore } from "../secrets/store.js";
import { LOCAL_DEVICE_ID } from "../record/device.js";
import { MANAGED_PERSON_ID_KEY, MANAGED_PERSON_NAME_KEY } from "../identity/viewer.js";

/**
 * This machine's sign-in to an organisation server (EO-323,
 * `ARCHITECTURE.md`, "Identity").
 *
 * Two halves, kept apart on purpose:
 *
 *  - **what it is** — the address, the email, who signed in and which
 *    device row this machine is — lives in `app_settings`, because it is
 *    a preference of this installation and the screens read it on every
 *    render. None of it is secret; all of it is uninteresting to anybody
 *    who already has the database;
 *  - **the token** — lives where every other secret EO holds lives: a
 *    file under `userData`, encrypted with the OS keychain's key
 *    (the original design, "Secrets: OS keychain, never the DB"). It is the
 *    credential that speaks for this machine to the organisation, which
 *    makes it exactly as sensitive as the MCP host's bearer token and it
 *    is kept exactly the same way.
 *
 * The third state is what the story asks for and what a boolean could
 * not hold. A device whose token an admin revoked is not signed out the
 * way a fresh installation is: the person did nothing, and EO says so —
 * "signed out by your organisation". The flag is set by whatever meets
 * the 401, and cleared by the next successful sign-in.
 */

const ADDRESS_KEY = "managed.serverAddress";
const EMAIL_KEY = "managed.email";
/**
 * Spelled in `identity/viewer.ts` rather than here (EO-325).
 *
 * Because it stopped being this file's private business: "which person
 * is this machine" is what the inbox, the `!` marker and every human
 * mention now resolve against, and a repo function cannot take a
 * keychain-backed session store as an argument. One key, one reader,
 * one spelling.
 */
const PERSON_ID_KEY = MANAGED_PERSON_ID_KEY;
const PERSON_NAME_KEY = MANAGED_PERSON_NAME_KEY;
const IS_ADMIN_KEY = "managed.isAdmin";
const DEVICE_ID_KEY = "managed.deviceId";
const DEVICE_NAME_KEY = "managed.deviceName";
/**
 * Whether the organisation turned this device out.
 *
 * Kept when the token is forgotten, because it is the *reason* the token
 * is gone, and a reason that disappears with what it explains leaves a
 * person looking at an empty sign-in screen wondering what they did.
 */
const REVOKED_KEY = "managed.revoked";

export interface SessionStoreOptions {
  db: Db;
  /** `app.getPath("userData")/managed` in production. */
  directory: string;
  store: SecretStore;
}

function tokenFile(directory: string): string {
  return join(directory, "device-token.bin");
}

/**
 * Where this machine keeps the credential that opens
 * `ORGANISATION_SECRETS_PATH` (EO-328, ARCHITECTURE.md, "Secrets").
 *
 * Its own file beside the token, encrypted the same way, and — the whole
 * point — reachable from the main process alone. A renderer never sees
 * it: the desktop's window is handed no credential at all, and the
 * browser a server serves is issued none in the first place (see
 * `SignInRequest.runsWork`). So the credential in a renderer's
 * `sessionStorage` opens nothing, which is what makes "no query the
 * renderer can make returns an organisation secret" a property of the
 * route rather than of every channel remembering.
 *
 * A separate file rather than a second field in the token's, so that a
 * device whose key was withdrawn — signing in again from a browser, say
 * — loses exactly this and keeps its session.
 */
function secretsKeyFile(directory: string): string {
  return join(directory, "organisation-secrets-key.bin");
}

/** What the desktop is signed in as, as the screens read it. */
export function sessionStatus(options: SessionStoreOptions): SessionStatus {
  const { db } = options;
  const address = getSetting<string>(db, ADDRESS_KEY, "");
  const email = getSetting<string>(db, EMAIL_KEY, "");
  if (address === "" || email === "") return { state: "signed-out" };

  if (getSetting<boolean>(db, REVOKED_KEY, false)) {
    return { state: "revoked", address, email, line: SIGNED_OUT_BY_ORGANISATION_LINE };
  }

  // The token is the thing that makes a session a session. Settings that
  // say signed-in with no readable token — a keychain reset, a copied
  // profile directory — is a machine that will meet a 401 on its first
  // request, and saying so now is better than saying it then.
  if (readToken(options) === null) return { state: "signed-out" };

  return {
    state: "signed-in",
    address,
    email,
    personId: getSetting<string>(db, PERSON_ID_KEY, ""),
    personName: getSetting<string>(db, PERSON_NAME_KEY, ""),
    isAdmin: getSetting<boolean>(db, IS_ADMIN_KEY, false),
    deviceId: getSetting<string>(db, DEVICE_ID_KEY, ""),
    deviceName: getSetting<string>(db, DEVICE_NAME_KEY, ""),
  };
}

export interface RememberedSession {
  address: string;
  email: string;
  token: string;
  /**
   * The organisation-secrets key this sign-in earned, or null (EO-328).
   *
   * Null where the server issued none — an older server, or a sign-in
   * that did not ask to run work — and the file is removed rather than
   * left, because a key the record has stopped honouring is a credential
   * worth not holding.
   *
   * Optional as well as nullable: a server older than this feature
   * answers without the member, and `ServerClient` passes the body
   * through unparsed.
   */
  secretsKey?: string | null;
  personId: string;
  personName: string;
  isAdmin: boolean;
  deviceId: string;
  deviceName: string;
}

export type RememberResult = { ok: true } | { ok: false; problem: string };

/**
 * Remembers a sign-in that worked.
 *
 * The token is written first. If the keychain refuses — no keyring on
 * this Linux box, `basic_text` in disguise — nothing else is written
 * either, because a session recorded without the credential it needs is
 * a desktop that believes it is signed in and cannot prove it to
 * anybody.
 */
export function rememberSession(options: SessionStoreOptions, session: RememberedSession): RememberResult {
  const written = writeToken(options, session.token);
  if (!written.ok) return written;

  // After the token and on the same terms: the keychain has already
  // proved itself writable, so this cannot half-succeed in a way the
  // sentence above does not already cover.
  // `?? null` rather than `=== null`, because a server older than this
  // feature answers a sign-in with no `secretsKey` member at all and
  // `ServerClient` hands the body over without parsing it. Absent and
  // null are one thing here: this device was issued no key, so it holds
  // none.
  const secretsKey = session.secretsKey ?? null;
  if (secretsKey === null) rmSync(secretsKeyFile(options.directory), { force: true });
  else writeFileSync(secretsKeyFile(options.directory), options.store.encryptString(secretsKey), { mode: 0o600 });

  const { db } = options;
  setSetting(db, ADDRESS_KEY, normalizeServerAddress(session.address));
  setSetting(db, EMAIL_KEY, session.email);
  setSetting(db, PERSON_ID_KEY, session.personId);
  setSetting(db, PERSON_NAME_KEY, session.personName);
  setSetting(db, IS_ADMIN_KEY, session.isAdmin);
  setSetting(db, DEVICE_ID_KEY, session.deviceId);
  setSetting(db, DEVICE_NAME_KEY, session.deviceName);
  // A fresh sign-in is the answer to a revocation, so the flag goes.
  clearSetting(db, REVOKED_KEY);
  return { ok: true };
}

/**
 * The organisation's list as this machine last read it — ids and names
 * only (EO-367, review).
 *
 * The picker reads `people:list` from the server, and a person can pick
 * a colleague from that list after the network has gone. An assignment
 * is shown on the card the moment it is made (ARCHITECTURE.md, "The record"), and showing it
 * needs a row naming the colleague under the record's id — which, with
 * the server unreachable, nothing could supply. So the last list the
 * server answered is kept here, and the assignment names the colleague
 * from it.
 *
 * A setting rather than `people` rows, on purpose: the list is not
 * copied down wholesale (`identityCommands.ts`, `adopt`), and a row is
 * written only for the one colleague somebody actually picks. Forgotten
 * with the rest of the sign-in.
 */
const ORGANISATION_PEOPLE_KEY = "managed.organisationPeople";

export interface RememberedPerson {
  id: string;
  name: string;
}

/** Keeps the list the organisation just answered with. */
export function rememberOrganisationPeople(db: Db, people: readonly RememberedPerson[]): void {
  setSetting(
    db,
    ORGANISATION_PEOPLE_KEY,
    people.map((person) => ({ id: person.id, name: person.name })),
  );
}

/** One colleague off the last list the organisation answered with, or undefined. */
export function rememberedOrganisationPerson(db: Db, id: string): RememberedPerson | undefined {
  const list = getSetting<unknown>(db, ORGANISATION_PEOPLE_KEY, []);
  if (!Array.isArray(list)) return undefined;
  for (const entry of list as unknown[]) {
    if (typeof entry !== "object" || entry === null) continue;
    const { id: entryId, name } = entry as { id?: unknown; name?: unknown };
    if (entryId === id && typeof name === "string" && name !== "") return { id, name };
  }
  return undefined;
}

/**
 * Forgets this machine's sign-in, at the person's own request.
 *
 * The device row on the server is left alone. This end cannot prove to
 * the server that it is the machine giving the token up, and a call that
 * let it would be a way for anybody holding a stolen token to erase the
 * row naming the machine it was stolen from. Revocation is the admin's,
 * which is the whole point of the Devices list.
 */
export function forgetSession(options: SessionStoreOptions): void {
  const { db } = options;
  for (const key of [
    ADDRESS_KEY,
    EMAIL_KEY,
    PERSON_ID_KEY,
    PERSON_NAME_KEY,
    IS_ADMIN_KEY,
    DEVICE_ID_KEY,
    DEVICE_NAME_KEY,
    REVOKED_KEY,
    ORGANISATION_PEOPLE_KEY,
  ]) {
    clearSetting(db, key);
  }
  // And the locks that came with it (EO-329, ARCHITECTURE.md, "Publish, lock and versions"). A
  // published section
  // is the organisation saying "this is managed"; a machine that has
  // left the organisation is managed by nobody, and a lock outliving
  // the link that justified it would be a configuration no person on
  // earth could unlock — not the admin, who is never asked about this
  // machine again, and not the person sitting at it.
  forgetPublishedSections(db);
  forgetToken(options);
}

/**
 * Records that the organisation turned this device out.
 *
 * The token is destroyed — it is a dead credential and keeping it only
 * means presenting it again — and the address and email stay, so the
 * sign-in screen comes back pre-filled with the sentence above it. The
 * device id stays too: signing in again re-issues onto the same row
 * rather than growing a second one in the admin's list.
 *
 * **Answers whether this was the moment it happened**, which is what
 * makes it safe to hang a notification off. Several requests can be in
 * flight when an admin presses Revoke, and every one of them comes back
 * 401; without this they would each announce the same event, and a
 * screen would be told five times that it had been signed out. `false`
 * means either that this machine was never signed in — a solo desktop,
 * where a 401 is somebody else's problem — or that it already knew.
 */
export function markRevoked(options: SessionStoreOptions): boolean {
  if (getSetting<string>(options.db, ADDRESS_KEY, "") === "") return false;
  if (getSetting<boolean>(options.db, REVOKED_KEY, false)) return false;
  setSetting(options.db, REVOKED_KEY, true);
  forgetToken(options);
  return true;
}

/**
 * Which device this machine is, as the record knows it (EO-324, ARCHITECTURE.md, "The record").
 *
 * The row the organisation's Devices list holds for this machine while
 * it is signed in, and `local` otherwise — a solo desktop is its own
 * record, and there is exactly one machine for a lease to belong to.
 *
 * Deliberately not `rememberedDeviceId`, which answers the last id this
 * machine held whether or not it still holds it. A revoked device
 * claiming leases under the id an admin has just turned off would be
 * the admin's action having no effect on the one thing it was for.
 */
export function deviceIdentity(options: SessionStoreOptions): string {
  const status = sessionStatus(options);
  return status.state === "signed-in" && status.deviceId !== "" ? status.deviceId : LOCAL_DEVICE_ID;
}

/** The device id this machine last held, so a new sign-in re-uses its row. */
export function rememberedDeviceId(options: SessionStoreOptions): string | undefined {
  const id = getSetting<string>(options.db, DEVICE_ID_KEY, "");
  return id === "" ? undefined : id;
}

/** The token, or null when there is none this machine can read. */
export function readToken(options: SessionStoreOptions): string | null {
  let encrypted: Buffer;
  try {
    encrypted = readFileSync(tokenFile(options.directory));
  } catch {
    return null;
  }
  try {
    return options.store.decryptString(encrypted);
  } catch {
    // Written by another machine, another OS user, or before a keychain
    // reset. Unreadable is the same as absent: the person signs in again.
    return null;
  }
}

function writeToken(options: SessionStoreOptions, token: string): RememberResult {
  if (!options.store.isEncryptionAvailable()) {
    return {
      ok: false,
      problem:
        "This machine has no OS keychain available, so EO cannot store your organisation's device token safely. " +
        "On Linux that usually means no keyring is running (gnome-keyring or kwallet).",
    };
  }
  if (options.store.getSelectedStorageBackend?.() === "basic_text") {
    return {
      ok: false,
      problem:
        "This machine's keychain is unlocked storage in disguise: Electron fell back to its `basic_text` backend, " +
        "which uses a fixed password, so anything running as you could read your device token. " +
        "Start a keyring (gnome-keyring or kwallet) and sign in again.",
    };
  }

  // 0o700 on the directory and 0o600 on the file, as `mcpHost/token.ts`
  // does: the mode is what protects the ciphertext from the other
  // accounts on this machine.
  mkdirSync(options.directory, { recursive: true, mode: 0o700 });
  writeFileSync(tokenFile(options.directory), options.store.encryptString(token), { mode: 0o600 });
  return { ok: true };
}

function forgetToken(options: SessionStoreOptions): void {
  rmSync(tokenFile(options.directory), { force: true });
  // The organisation's key goes with the organisation's token, always.
  // It is the credential that fetches their secrets, and a machine that
  // has been signed out or turned out has no business holding one.
  rmSync(secretsKeyFile(options.directory), { force: true });
}

/**
 * The credential `policy/sync.ts` presents on the one request that is
 * not a channel (EO-328, ARCHITECTURE.md, "Secrets").
 *
 * Null on a machine that has none — a solo desktop, a device signed in
 * to a server too old to mint one, a browser — and a null is simply a
 * device that collects no organisation secrets. Unreadable is null for
 * `readToken`'s reason: the person signs in again.
 */
export function readSecretsKey(options: SessionStoreOptions): string | null {
  let encrypted: Buffer;
  try {
    encrypted = readFileSync(secretsKeyFile(options.directory));
  } catch {
    return null;
  }
  try {
    return options.store.decryptString(encrypted);
  } catch {
    return null;
  }
}
