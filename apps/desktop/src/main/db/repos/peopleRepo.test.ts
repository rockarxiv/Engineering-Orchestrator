import { LOCAL_PERSON_ID, LOCAL_PERSON_NAME, type Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../client.js";
import { openMigratedTestDb } from "../testHelpers.js";
import { getPerson, listPeople, localPerson } from "./peopleRepo.js";

/**
 * One implicit local person, from the first run (EO-302, ARCHITECTURE.md, "Identity").
 *
 * Identity arrives with jobs rather than with the server: a job needs
 * an owner and "have Anna approve it" needs an assignee before any
 * server exists. Solo mode has exactly one person and never asks who
 * they are — they are "you", and every place in EO that meant "the
 * human" means this row.
 *
 * A migrated database is a database being born here, which is the state
 * `index.ts` is in on a new installation's first launch: 0077 is what
 * creates the row, so the app never has to.
 */
describe("the local person", () => {
  let handle: DbHandle;

  beforeEach(() => {
    handle = openMigratedTestDb();
  });

  afterEach(() => {
    handle.close();
  });

  it("exists on a database that has just been created, and is the only one", () => {
    expect(localPerson(handle.db)).toMatchObject({ id: LOCAL_PERSON_ID, name: LOCAL_PERSON_NAME, email: null });
    expect(listPeople(handle.db).map((person) => person.id)).toEqual([LOCAL_PERSON_ID]);
  });

  it("was created when the database was, rather than carrying a placeholder time", () => {
    // Not an assertion about the clock: what it rules out is a row
    // seeded with 0 or with a literal baked into the migration, which
    // would make "when did this installation start" unanswerable the
    // day a second person joins it.
    expect(localPerson(handle.db).createdAt).toBeGreaterThan(1_700_000_000_000);
  });

  it("answers with nothing for an id no row carries, rather than guessing", () => {
    expect(getPerson(handle.db, "0199aa00-0000-7000-8000-00000000dead" as Uuid)).toBeUndefined();
  });
});
