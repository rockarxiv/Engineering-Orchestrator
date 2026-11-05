import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type DbHandle } from "../../../db/client.js";
import { setSetting } from "../../../db/repos/settingsRepo.js";
import type { SecretStore } from "../../../secrets/store.js";
import { hasToken, readToken, rekeyJiraTokens, storeToken, type CredentialsOptions } from "./credentials.js";
import { forgetLegacyJiraTokenOwners, legacyJiraTokenOwners } from "./legacyTokenOwners.js";

/**
 * The startup half of the KAN-22 token rekey, after KAN-130 split
 * `repositories` apart.
 *
 * The migration's half — that 0072 writes the true repository-to-
 * connection pairs down while `repositories` still exists to be asked —
 * is pinned in `db/migrate.test.ts`. This is what happens next, against
 * the same JSON: which token ends up on which connection.
 */
let directory: string;
let handle: DbHandle;

function fakeStore(available = true): SecretStore {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) => Buffer.from(`v1:${Buffer.from(plain).toString("base64")}`),
    decryptString: (encrypted) => {
      const text = encrypted.toString();
      if (!text.startsWith("v1:")) throw new Error("not encrypted by this keychain");
      return Buffer.from(text.slice(3), "base64").toString();
    },
  };
}

function options(store: SecretStore = fakeStore()): CredentialsOptions {
  return { directory, store };
}

/** Writes exactly what migration 0072's `json_group_array` produces. */
function record(pairs: { repositoryId: string; connectionId: string }[]): void {
  setSetting(handle.db, "jira.legacyTokenOwners", pairs);
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "eo-legacy-tokens-"));
  handle = openDb(":memory:");
  // Only the table these read. A migrated database has the rest; this
  // needs somewhere to put the one setting.
  handle.db.run(sql`CREATE TABLE app_settings (key text PRIMARY KEY NOT NULL, value text NOT NULL, updated_at integer NOT NULL)`);
});

afterEach(() => {
  handle.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("the connection a legacy Jira token belonged to", () => {
  it("sends each repository's token to its own connection", () => {
    // Two repositories on one project, on *different* Jira accounts.
    // After 0072 the project keeps one binding — `repo-api`'s — and
    // `repo-ui` is first in membership order.
    storeToken(options(), "repo-ui", "token-for-acme");
    storeToken(options(), "repo-api", "token-for-other");
    record([
      { repositoryId: "repo-ui", connectionId: "conn-1" },
      { repositoryId: "repo-api", connectionId: "conn-2" },
    ]);

    const moved = rekeyJiraTokens(options(), legacyJiraTokenOwners(handle.db));

    // The regression. Pairing the leftover files with the project's one
    // surviving binding wrote `repo-ui`'s token — a credential for a
    // different Jira account — onto `conn-2`, and then deleted
    // `repo-api`'s correct one, because `rekeyJiraTokens` keeps
    // whatever the connection already has. Every Jira request after the
    // upgrade authenticated as the wrong account, with nothing anywhere
    // saying it had happened.
    expect(moved).toBe(2);
    expect(readToken(options(), "conn-1")).toBe("token-for-acme");
    expect(readToken(options(), "conn-2")).toBe("token-for-other");
    expect(hasToken(options(), "repo-ui"), "moved, not copied").toBe(false);
    expect(hasToken(options(), "repo-api")).toBe(false);
  });

  it("reads nothing from a database that never recorded any", () => {
    // Never had Jira connected, or the record has already been
    // forgotten. Both mean the same thing and neither is an error.
    expect(legacyJiraTokenOwners(handle.db)).toEqual([]);
    expect(rekeyJiraTokens(options(), legacyJiraTokenOwners(handle.db))).toBe(0);
  });

  it("ignores a malformed entry rather than naming a token file after it", () => {
    // Defensive because this is a value read off disk: a pair with no
    // `repositoryId` would otherwise reach `readToken` as `undefined`
    // and, worse, `clearToken` — deleting a file named for a mistake.
    setSetting(handle.db, "jira.legacyTokenOwners", [
      { repositoryId: "repo-ui", connectionId: "conn-1" },
      { repositoryId: "", connectionId: "conn-2" },
      { connectionId: "conn-3" },
      "nonsense",
      null,
    ]);

    expect(legacyJiraTokenOwners(handle.db)).toEqual([{ repositoryId: "repo-ui", connectionId: "conn-1" }]);
  });

  it("is forgotten once every token it named has moved", () => {
    storeToken(options(), "repo-ui", "pat");
    record([{ repositoryId: "repo-ui", connectionId: "conn-1" }]);

    rekeyJiraTokens(options(), legacyJiraTokenOwners(handle.db));
    forgetLegacyJiraTokenOwners(handle.db);

    expect(legacyJiraTokenOwners(handle.db)).toEqual([]);
  });

  it("keeps the record when a token could not be moved, so a later launch can finish", () => {
    // The keychain unavailable: `storeToken` refuses, the old file
    // stays, and nothing but this record knows what it was for.
    storeToken(options(), "repo-ui", "pat");
    record([{ repositoryId: "repo-ui", connectionId: "conn-1" }]);

    const owners = legacyJiraTokenOwners(handle.db);
    expect(rekeyJiraTokens(options(fakeStore(false)), owners)).toBe(0);

    // Which is what the startup checks before forgetting it.
    expect(owners.every((owner) => !hasToken(options(), owner.repositoryId))).toBe(false);
  });
});
