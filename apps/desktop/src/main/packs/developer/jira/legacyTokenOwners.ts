import type { Db } from "../../../db/client.js";
import { clearSetting, getSetting } from "../../../db/repos/settingsRepo.js";

/**
 * Where 0072 wrote the repository-to-connection pairs down. Namespaced
 * like every other engine setting, and written by exactly one migration
 * and read by exactly one caller.
 */
const LEGACY_TOKEN_OWNERS = "jira.legacyTokenOwners";

/** A Jira token file named after a repository, and the connection it was for. */
export type LegacyTokenOwner = { repositoryId: string; connectionId: string };

/**
 * The repositories that had a Jira token, each with the connection that
 * token actually authenticated against (KAN-22, KAN-130).
 *
 * This cannot be derived from the schema any more, which is the whole
 * reason 0072 records it: a project keeps one `connector_bindings` row,
 * and the connection every *other* repository named went with the
 * `repositories` table. Pairing a leftover token file with the surviving
 * binding instead would move one repository's credential onto another
 * repository's connection and delete the correct one, leaving Jira
 * authenticating as the wrong account with nothing to say it had.
 *
 * Empty once the rekey has finished and forgotten the setting, and empty
 * on any database that never had Jira connected — both of which mean
 * "nothing to move", which is the same instruction.
 */
export function legacyJiraTokenOwners(db: Db): LegacyTokenOwner[] {
  const raw = getSetting<unknown>(db, LEGACY_TOKEN_OWNERS, []);
  if (!Array.isArray(raw)) return [];

  // Narrowed rather than cast. It is our own migration's JSON, but this
  // is a value read off disk, and a malformed row must not reach
  // `rekeyJiraTokens` as a pair with an `undefined` id — that would name
  // a token file `undefined` and delete it.
  return raw.filter((entry): entry is LegacyTokenOwner => {
    if (typeof entry !== "object" || entry === null) return false;
    const { repositoryId, connectionId } = entry as Record<string, unknown>;
    return typeof repositoryId === "string" && repositoryId !== "" && typeof connectionId === "string" && connectionId !== "";
  });
}

/**
 * Drops the record, once every token it named has been moved.
 *
 * Kept until then rather than cleared on the first pass, because a rekey
 * that half-finished — the keychain unavailable for one of them — has to
 * be able to finish on a later launch, and this is the only place the
 * pairing still exists.
 */
export function forgetLegacyJiraTokenOwners(db: Db): void {
  clearSetting(db, LEGACY_TOKEN_OWNERS);
}
