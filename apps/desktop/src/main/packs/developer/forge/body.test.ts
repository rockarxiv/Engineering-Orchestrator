import { describe, expect, it } from "vitest";
import { buildPullRequestBody, buildPullRequestTitle, MAX_BODY_CHARS, type PullRequestFacts } from "./body.js";

/**
 * What the pull request says (F-06).
 *
 * The prose is an agent's and the facts are EO's, and the line between
 * them is the point: a reader on the forge should be able to trust the
 * bottom half without trusting the top half.
 */
function facts(overrides: Partial<PullRequestFacts> = {}): PullRequestFacts {
  return {
    itemKey: "API-4",
    itemTitle: "Outbox table and enqueue",
    branch: "eo/API-4",
    baseBranch: "main",
    acceptanceCriteria: ["Written in the same transaction as the event", "Survives a restart"],
    checks: [
      { name: "test", passed: true },
      { name: "lint", passed: true },
    ],
    jiraKey: "KAN-8",
    jiraUrl: "https://acme.atlassian.net/browse/KAN-8",
    reference: null,
    ...overrides,
  };
}

describe("the title", () => {
  it("prefers the linked Jira key over EO's own item key when there is one", () => {
    expect(buildPullRequestTitle(facts())).toBe("KAN-8: Outbox table and enqueue");
  });

  it("falls back to the EO item key when there is no linked Jira issue", () => {
    expect(buildPullRequestTitle(facts({ jiraKey: null }))).toBe("API-4: Outbox table and enqueue");
  });
});

describe("the title under a Reference (EO-638)", () => {
  it("names the Reference ahead of the Jira key and the EO key", () => {
    expect(buildPullRequestTitle(facts({ reference: "PROJ-123" }))).toBe("PROJ-123: Outbox table and enqueue");
    expect(buildPullRequestTitle(facts({ reference: "PROJ-123", jiraKey: null, jiraUrl: null }))).toBe("PROJ-123: Outbox table and enqueue");
  });
});

describe("the facts block under a Reference (EO-638)", () => {
  // EO-45 under feature EO-40, its own Reference PROJ-123, mirroring KAN-9.
  const named = facts({
    itemKey: "EO-45",
    branch: "eo/PROJ-123-EO-45",
    reference: "PROJ-123",
    jiraKey: "KAN-9",
    jiraUrl: "https://acme.atlassian.net/browse/KAN-9",
  });

  it("names the Reference alone: no EO key, no feature key, no Jira key, no branches", () => {
    const { text } = buildPullRequestBody({ agentBody: "Adds an outbox.", facts: named });
    const block = text.slice(text.indexOf("<!-- eo:facts -->"));

    expect(block).toContain("**PROJ-123**\n");
    for (const key of ["EO-45", "EO-40", "KAN-9"]) expect(block).not.toContain(key);
    expect(block).not.toContain("**Jira**");
    expect(block).not.toContain("→");
    // The rest of what EO signs is unchanged.
    expect(block).toContain("- Survives a restart");
    expect(block).toContain("test ✓ · lint ✓");
  });

  it("does the same for a Reference the item inherits, which reaches the facts the same way", () => {
    const { text } = buildPullRequestBody({ agentBody: "x", facts: facts({ itemKey: "EO-46", branch: "eo/PROJ-123-EO-46", reference: "PROJ-123", jiraKey: null, jiraUrl: null }) });
    const block = text.slice(text.indexOf("<!-- eo:facts -->"));

    expect(block).toContain("**PROJ-123**");
    expect(block).not.toContain("EO-46");
  });

  it("leaves the prose alone, keys and all", () => {
    // Asked of the reviewer, never rewritten by EO.
    const { text } = buildPullRequestBody({ agentBody: "Closes part of EO-45.", facts: named });

    expect(text).toContain("Closes part of EO-45.");
  });
});

describe("the facts block", () => {
  it("carries the branch, the criteria, the checks and the Jira link", () => {
    const { text } = buildPullRequestBody({ agentBody: "Adds an outbox.", facts: facts() });

    expect(text).toContain("**API-4** · `eo/API-4` → `main`");
    expect(text).toContain("- Survives a restart");
    expect(text).toContain("test ✓ · lint ✓");
    expect(text).toContain("[KAN-8](https://acme.atlassian.net/browse/KAN-8)");
  });

  it("reports a check that failed as failed", () => {
    // The checks come from what G-02 ran. If EO is going to print them
    // at all, printing them honestly is the only version worth having.
    const { text } = buildPullRequestBody({
      agentBody: "Adds an outbox.",
      facts: facts({ checks: [{ name: "test", passed: true }, { name: "lint", passed: false }] }),
    });

    expect(text).toContain("test ✓ · lint ✗");
  });

  it("comes after the prose, not before it", () => {
    const { text } = buildPullRequestBody({ agentBody: "Adds an outbox.", facts: facts() });

    expect(text.indexOf("Adds an outbox.")).toBeLessThan(text.indexOf("<!-- eo:facts -->"));
  });

  it("is exactly as before when no Reference names the work", () => {
    const { text } = buildPullRequestBody({ agentBody: "x", facts: facts({ itemKey: "EO-45", branch: "eo/EO-45" }) });

    expect(text).toContain("**EO-45** · `eo/EO-45` → `main`");
    expect(text).toContain("**Jira** — [KAN-8](https://acme.atlassian.net/browse/KAN-8)");
  });

  it("keeps the EO item key in the facts line even when a Jira key is linked", () => {
    // The title prefers Jira; the facts line is EO's own record and does not.
    const { text } = buildPullRequestBody({ agentBody: "Adds an outbox.", facts: facts({ jiraKey: "KAN-8" }) });

    expect(text).toContain("**API-4** · `eo/API-4` → `main`");
  });

  it("says nothing about Jira when there is no Jira", () => {
    const { text } = buildPullRequestBody({ agentBody: "x", facts: facts({ jiraKey: null, jiraUrl: null }) });

    expect(text).not.toContain("**Jira**");
  });

  it("never writes a closing keyword", () => {
    // EO does not know the issue number, and a guess auto-closes
    // someone else's issue the moment this is merged.
    const { text } = buildPullRequestBody({ agentBody: "Fixes the thing.", facts: facts() });

    expect(text).not.toMatch(/\b(Fixes|Closes|Resolves) #\d+/);
  });
});

describe("whose prose it is", () => {
  it("uses the agent's when there is one", () => {
    const { text, fallback } = buildPullRequestBody({
      agentBody: "## What\nAn outbox.\n\n## Why\nSo a push survives a crash.",
      template: "## What\n\n## Why\n",
      facts: facts(),
    });

    expect(text).toContain("So a push survives a crash.");
    expect(fallback).toBe(false);
  });

  it("falls back to the unfilled template before anything it could write itself", () => {
    // A repository that requires a template usually has CI checking its
    // headings. Empty headings a human completes beat a well-written
    // body that fails the check.
    const { text, fallback } = buildPullRequestBody({
      template: "## What\n\n## Why\n",
      implementSummary: "Added src/webhooks/outbox.ts.",
      facts: facts(),
    });

    expect(text).toContain("## What");
    expect(text).not.toContain("Added src/webhooks/outbox.ts.");
    expect(fallback).toBe(true);
  });

  it("then the implementer's summary, then the item", () => {
    expect(buildPullRequestBody({ implementSummary: "Added the table.", itemBody: "We need an outbox.", facts: facts() }).text).toContain(
      "Added the table.",
    );
    expect(buildPullRequestBody({ itemBody: "We need an outbox.", facts: facts() }).text).toContain("We need an outbox.");
  });

  it("still produces a usable body with nothing at all", () => {
    const { text, fallback } = buildPullRequestBody({ facts: facts() });

    expect(fallback).toBe(true);
    expect(text).toContain("No description was written");
    expect(text).toContain("**API-4**");
  });

  it("treats whitespace as absent", () => {
    const { fallback } = buildPullRequestBody({ agentBody: "   \n\n  ", template: "## What\n", facts: facts() });

    expect(fallback).toBe(true);
  });
});

describe("length", () => {
  it("caps the body, because glab has no --description-file", () => {
    // The description travels as an argv entry, and Windows caps a whole
    // command line at 32767 characters.
    const { text } = buildPullRequestBody({ agentBody: "x".repeat(MAX_BODY_CHARS * 2), facts: facts() });

    expect(text.length).toBeLessThan(MAX_BODY_CHARS + 100);
    expect(text).toContain("truncated by EO");
  });
});
