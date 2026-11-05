import { describe, expect, it } from "vitest";
import { RepositoryIndexStatusSchema, type RepositoryIndexStatus } from "@eo/core";
import { canTransitionIndex, refuseIndexTransition, LEGAL_INDEX_TRANSITIONS } from "./transitions.js";

/**
 * The table itself (EO-145).
 *
 * What is checked here are the properties of the graph rather than the
 * individual moves — those are exercised through the service against a
 * real database in `service.test.ts`, which is where they matter.
 */

const ALL_STATUSES = RepositoryIndexStatusSchema.options;

describe("the index transition table", () => {
  /**
   * A status missing from the table would throw on lookup rather than
   * refuse, which is the wrong shape of answer entirely: adding a
   * seventh status should fail here, loudly, and not at the first
   * dispatch that happens to reach it.
   */
  it("has an entry for every status the schema allows", () => {
    expect(Object.keys(LEGAL_INDEX_TRANSITIONS).sort()).toEqual([...ALL_STATUSES].sort());
  });

  it("names only real statuses as destinations", () => {
    const destinations = Object.values(LEGAL_INDEX_TRANSITIONS).flat();
    expect(destinations.filter((status) => !ALL_STATUSES.includes(status))).toEqual([]);
  });

  /**
   * No status may move to itself.
   *
   * `ready` -> `ready` is a write that means nothing, and refusing it is
   * how a caller finds out it has lost track of what is in flight.
   * `indexing` -> `indexing` is the one that matters: while concurrency
   * stays at 1 (invariant #10) and nothing else is watching, refusing it
   * is the only thing standing between EO and two builds writing to one
   * directory.
   */
  it("allows no self-transition", () => {
    for (const status of ALL_STATUSES) {
      expect(canTransitionIndex(status, status)).toBe(false);
    }
  });

  /**
   * Version skew is answered by rebuilding, never by updating. Syncing
   * a stale index would ask a new binary to reason about a graph an old
   * one wrote — the migration this whole design exists to avoid.
   */
  it("lets a stale index be rebuilt and nothing else", () => {
    expect(LEGAL_INDEX_TRANSITIONS.stale).toEqual(["indexing"]);
  });

  it("lets a failed index be rebuilt and nothing else", () => {
    expect(LEGAL_INDEX_TRANSITIONS.failed).toEqual(["indexing"]);
  });

  /**
   * Every status is reachable from a fresh row.
   *
   * A state nothing can get to is dead code wearing a name, and this is
   * cheaper than noticing that by hand each time the table changes.
   */
  it("can reach every status from not_indexed", () => {
    const reached = new Set<RepositoryIndexStatus>(["not_indexed"]);
    for (let pass = 0; pass < ALL_STATUSES.length; pass += 1) {
      for (const from of [...reached]) {
        for (const to of LEGAL_INDEX_TRANSITIONS[from]) reached.add(to);
      }
    }
    expect([...reached].sort()).toEqual([...ALL_STATUSES].sort());
  });
});

describe("refuseIndexTransition", () => {
  /**
   * The near-miss is the interesting refusal. Somebody who tries to
   * sync a stale index has made a reasonable-looking mistake, and being
   * told that a rebuild is the way out is the entire explanation they
   * need — which is why the sentence names the alternatives rather than
   * only the problem.
   */
  it("says what was refused and what the way out is", () => {
    expect(refuseIndexTransition("stale", "updating")).toBe(
      "An index cannot move from stale to updating. From stale the legal moves are: indexing.",
    );
  });
});
