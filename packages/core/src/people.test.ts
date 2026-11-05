import { describe, expect, it } from "vitest";
import { LOCAL_PERSON_ID, LOCAL_PERSON_NAME } from "./people.js";

/** The same shape `uuid.test.ts` holds `uuidv7()` to: version 7, RFC 4122 variant. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * The local person's id is reserved, and it is still a UUIDv7.
 *
 * A constant typed as `Uuid` is the one id in EO that `uuidv7()` never
 * produced, so it is the one that can quietly stop being a UUID: a
 * cast satisfies the compiler whatever the string says. It is not
 * decoration either — the value flows into `Person.id`,
 * `Item.createdBy`, `Item.assigneeId` and every human mention target,
 * all of which are `Uuid` and mean UUIDv7 by §3 of the working
 * agreement.
 *
 * So the contract is checked here rather than asserted in a comment.
 * The migration is pinned to the same value from the other side:
 * `migrate.test.ts` reads the row 0077 inserts and compares its id to
 * this constant, so the SQL literal and this one cannot drift apart
 * without a test saying so.
 */
describe("the reserved local person", () => {
  it("is a well-formed UUIDv7, not a sentinel wearing the type", () => {
    expect(LOCAL_PERSON_ID).toMatch(UUID_PATTERN);
  });

  it("carries a timestamp a person could have been created at", () => {
    // Rules out a hand-typed id that happens to match the pattern —
    // `00000000-0000-7000-8000-...` would pass the regex and decode to
    // 1970, which no installation was born in.
    const timestamp = Number.parseInt(LOCAL_PERSON_ID.replace(/-/g, "").slice(0, 12), 16);
    expect(timestamp).toBeGreaterThan(Date.parse("2020-01-01"));
    expect(timestamp).toBeLessThan(Date.parse("2100-01-01"));
  });

  it("is called something a sentence can be built around", () => {
    expect(LOCAL_PERSON_NAME).toBe("you");
  });
});
