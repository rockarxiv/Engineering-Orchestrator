import { acceptanceCriteriaOf, type Item } from "@eo/core";
import { describe, expect, it } from "vitest";
import { splitJiraDescription, toJiraDescription } from "./description.js";

function story(overrides: Partial<Item> = {}): Item {
  return {
    body: "Count them.",
    spec: { acceptance_criteria: ["429 after 100 req/min", "the header says when to retry"] },
    ...overrides,
  } as Item;
}

describe("what EO writes into a Jira description", () => {
  it("puts the criteria under the body, where someone reading the issue will find them", () => {
    expect(toJiraDescription(story())).toBe(
      "Count them.\n\nAcceptance criteria:\n- 429 after 100 req/min\n- the header says when to retry",
    );
  });

  it("writes no heading for an item that has no criteria", () => {
    expect(toJiraDescription(story({ spec: null }))).toBe("Count them.");
    expect(toJiraDescription(story({ spec: { touches: ["src/api.ts"] } }))).toBe("Count them.");
  });

  it("narrows rather than trusts — `spec` is open JSON", () => {
    expect(acceptanceCriteriaOf(story({ spec: { acceptance_criteria: "not a list" } }))).toEqual([]);
    expect(acceptanceCriteriaOf(story({ spec: { acceptance_criteria: ["real", 7, "", "  "] } }))).toEqual(["real"]);
  });
});

describe("reading a Jira description back", () => {
  it("survives its own round trip, which is the whole point", () => {
    const item = story();
    const split = splitJiraDescription(toJiraDescription(item));

    expect(split.body).toBe("Count them.");
    expect(split.criteria).toEqual(acceptanceCriteriaOf(item));
  });

  it("takes the block off however Jira ended its lines", () => {
    const split = splitJiraDescription("Count them.\r\n\r\nAcceptance criteria:\r\n- 429 after 100 req/min");

    expect(split.body).toBe("Count them.");
    expect(split.criteria).toEqual(["429 after 100 req/min"]);
  });

  it("leaves a description that merely talks about acceptance criteria alone", () => {
    // Guessing wrong here means eating what somebody wrote.
    const prose = "Acceptance criteria:\n\nWe never agreed these. Ask Dana before starting.";
    const split = splitJiraDescription(prose);

    expect(split.body).toBe(prose);
    expect(split.criteria).toEqual([]);
  });

  it("leaves a bare heading alone — EO never writes one with nothing under it", () => {
    expect(splitJiraDescription("Count them.\n\nAcceptance criteria:").criteria).toEqual([]);
  });

  it("takes only the last block off, so a body that mentions one keeps it", () => {
    const split = splitJiraDescription(
      "The old Acceptance criteria:\n- were wrong\n\nCount them.\n\nAcceptance criteria:\n- 429 after 100 req/min",
    );

    expect(split.body).toBe("The old Acceptance criteria:\n- were wrong\n\nCount them.");
    expect(split.criteria).toEqual(["429 after 100 req/min"]);
  });

  it("returns a description with no block as the body it is", () => {
    expect(splitJiraDescription("Count them.")).toEqual({ body: "Count them.", criteria: [] });
    expect(splitJiraDescription("")).toEqual({ body: "", criteria: [] });
  });
});
