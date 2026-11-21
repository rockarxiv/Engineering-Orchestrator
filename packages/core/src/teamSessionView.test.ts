import { describe, expect, it } from "vitest";
import { readTeamWaitNote, teamWaitNote } from "./teamSessionView.js";

/** The wait note is both what a person reads and what a later read takes the reason from (EO-849). */
describe("a team's wait note", () => {
  it("reads back the assignment, the kind and the reason it was written with", () => {
    expect(readTeamWaitNote(teamWaitNote("tests", "capacity", "the team runs 2 participants at a time, and that many are working. It starts as one finishes."))).toEqual({
      key: "tests",
      kind: "capacity",
      reason: "the team runs 2 participants at a time, and that many are working. It starts as one finishes.",
    });
    expect(readTeamWaitNote(teamWaitNote("security", "restricted", "EO is paused, so no new participant starts until it is resumed."))).toEqual({
      key: "security",
      kind: "restricted",
      reason: "EO is paused, so no new participant starts until it is resumed.",
    });
  });

  it("reads nothing into any other comment", () => {
    expect(readTeamWaitNote("**tests** — Nothing found\n\nAll green.")).toBeNull();
    expect(readTeamWaitNote("The tests are waiting to start: maybe.")).toBeNull();
  });
});
