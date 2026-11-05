import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SecretStore } from "../secrets/store.js";

/**
 * The values behind the names an organisation publishes (EO-328,
 * `ARCHITECTURE.md`, "Secrets").
 *
 * A third sibling of `modules/secrets.ts` and `mcp/serverSecrets.ts`,
 * written out rather than generalised for the reason the second of those
 * gives at length: each of the three has a different scoping rule, and
 * folding them together would mean making the interesting half of each
 * one a flag. What they share is `SecretStore`, imported as a type only,
 * so `safeStorage` still has exactly one import site in this app.
 *
 * ## What is different about this one
 *
 * **It is written by a sync, not by a person.** Every other secret store
 * in EO is filled in by somebody typing into a field on this machine.
 * These arrive from the organisation's record, and the whole set arrives
 * together — so `replaceOrganisationSecrets` is the ordinary write and
 * the per-name setter is what the *record* uses on itself. A name an
 * admin cleared has to disappear from the device, and a store that only
 * ever gained names would leave a withdrawn credential working on every
 * desktop that had ever held it.
 *
 * **What EO promises about it is narrower than it looks.** The design is
 * explicit about the reason: a module receives
 * these as environment variables and an agent with a shell can read its
 * own environment, so "never readable" would be a claim EO cannot keep.
 * What it can keep — and what `ORGANISATION_SECRET_LINE` says on the
 * screen — is that EO does not display it: nothing here is reachable
 * from a channel, the values are on disk under the machine's own
 * keychain, and the only thing ever handed one is the process being
 * spawned.
 *
 * The directory is its own, beside the others, so clearing one kind of
 * secret cannot disturb another — and so that signing out of an
 * organisation can forget all of these and none of the person's.
 */

export interface OrganisationSecretsOptions {
  /** `app.getPath("userData")/organisation-secrets` in production. */
  directory: string;
  store: SecretStore;
}

const PREFIX = "secret-";
const SUFFIX = ".bin";

/**
 * A secret's name is part of a path, so it is checked rather than
 * escaped — the same rule, and the same regular expression, the module
 * and server stores hold a name to. The IPC channel that accepts one
 * holds the same shape at the boundary, which is what keeps this throw
 * unreachable from outside.
 */
function fileFor(directory: string, name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`refusing to build a secret path from ${JSON.stringify(name)}`);
  return join(directory, `${PREFIX}${name}${SUFFIX}`);
}

export type StoreOrganisationSecretResult = { ok: true } | { ok: false; reason: string };

export function storeOrganisationSecret(options: OrganisationSecretsOptions, name: string, value: string): StoreOrganisationSecretResult {
  // Writing in the clear would quietly break the one promise this file
  // can keep, so it refuses and says why — as every other store does.
  if (!options.store.isEncryptionAvailable()) {
    return {
      ok: false,
      reason:
        "This machine has nowhere safe to keep an organisation secret, so EO did not store it. " +
        "On a desktop that usually means no keyring is running (gnome-keyring or kwallet); on a server it means EO_SECRET_KEY is not configured.",
    };
  }
  mkdirSync(options.directory, { recursive: true });
  writeFileSync(fileFor(options.directory, name), options.store.encryptString(value), { mode: 0o600 });
  return { ok: true };
}

/**
 * What is behind a name.
 *
 * "Unreadable" is a third answer rather than a kind of absent, for
 * `modules/secrets.ts`'s reason: the file is there and was written
 * before a keychain reset, and folding it into absent is what lets a
 * missing organisation value fall through to a personal one of the same
 * name — which is the one substitution this story says must not happen.
 */
export type OrganisationSecretRead = { state: "value"; value: string } | { state: "absent" } | { state: "unreadable" };

export function readOrganisationSecretEntry(options: OrganisationSecretsOptions, name: string): OrganisationSecretRead {
  // Outside the try, deliberately: the catch below means "no such file",
  // and a name that is not a name is a programmer error that must not be
  // reported as an unset secret.
  const path = fileFor(options.directory, name);
  let encrypted: Buffer;
  try {
    encrypted = readFileSync(path);
  } catch {
    return { state: "absent" };
  }
  try {
    return { state: "value", value: options.store.decryptString(encrypted) };
  } catch {
    return { state: "unreadable" };
  }
}

/** The value, or null for either kind of nothing. */
export function readOrganisationSecret(options: OrganisationSecretsOptions, name: string): string | null {
  const read = readOrganisationSecretEntry(options, name);
  return read.state === "value" ? read.value : null;
}

/**
 * Which names are set, by name only.
 *
 * Names, never values — this is what the policy publishes and what a
 * screen renders `ORGANISATION_SECRET_LINE` from. A file that no longer
 * decrypts is not listed, for `listSecretNames`' reason: "set" means a
 * run would get a value, and a name that cannot be read is one a run
 * will not be given.
 */
export function listOrganisationSecretNames(options: OrganisationSecretsOptions): string[] {
  let entries: string[];
  try {
    entries = readdirSync(options.directory);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.startsWith(PREFIX) && entry.endsWith(SUFFIX))
    .map((entry) => entry.slice(PREFIX.length, entry.length - SUFFIX.length))
    .filter((name) => readOrganisationSecretEntry(options, name).state === "value")
    .sort();
}

export function clearOrganisationSecret(options: OrganisationSecretsOptions, name: string): void {
  rmSync(fileFor(options.directory, name), { force: true });
}

/**
 * Makes this machine's copy exactly what the record has.
 *
 * The whole set rather than an update, because a withdrawal is the case
 * that matters: an admin who clears `FLY_API_TOKEN` is taking a
 * credential away, and a device that only ever learned new names would
 * go on injecting it for as long as it was installed. So anything not
 * named here is removed.
 *
 * A machine with no keychain removes what it should remove and stores
 * nothing, and says which names it could not keep. That is the right way
 * round: failing to *forget* a secret is a security answer, failing to
 * *gain* one is an inconvenience, and the caller reports the second.
 */
export function replaceOrganisationSecrets(
  options: OrganisationSecretsOptions,
  values: Readonly<Record<string, string>>,
): { stored: string[]; refused: string[] } {
  for (const name of listOrganisationSecretNames(options)) {
    if (!Object.hasOwn(values, name)) clearOrganisationSecret(options, name);
  }
  const stored: string[] = [];
  const refused: string[] = [];
  for (const [name, value] of Object.entries(values)) {
    const result = storeOrganisationSecret(options, name, value);
    (result.ok ? stored : refused).push(name);
  }
  return { stored: stored.sort(), refused: refused.sort() };
}

/** Forgets every one of them — what signing out of an organisation owes. */
export function forgetOrganisationSecrets(options: OrganisationSecretsOptions): void {
  rmSync(options.directory, { force: true, recursive: true });
}

/**
 * Every name and its value, for the one caller that is allowed one.
 *
 * **This is the only function in EO that hands out organisation secret
 * values in bulk**, and it exists for exactly one reader: the record's
 * own HTTP route (`ORGANISATION_SECRETS_PATH`), which delivers them to
 * the devices that will inject them. It is deliberately not reachable
 * from a channel, a push frame or an MCP tool — see that constant for
 * why the separation is the story's third acceptance criterion rather
 * than a preference.
 *
 * A name whose file no longer decrypts is left out rather than sent as
 * an empty string, on `listOrganisationSecretNames`' reasoning: a
 * variable set to nothing at all is a credential that is present and
 * wrong.
 */
export function organisationSecretValues(options: OrganisationSecretsOptions): Record<string, string> {
  const values: Record<string, string> = {};
  for (const name of listOrganisationSecretNames(options)) {
    const read = readOrganisationSecretEntry(options, name);
    if (read.state === "value") values[name] = read.value;
  }
  return values;
}
