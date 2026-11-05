import { describe, expect, it } from "vitest";
import { DiscussionOutputSchema } from "./discussion.js";
import { providerSchemaFor, validateResultAgainst, zodOutputSchema } from "./index.js";

/**
 * The shape a conversational turn proposing work is answered in.
 *
 * Asked for directly rather than through the registry by action name:
 * `discuss` was Discussions' action and went with it (EO-526). The shape
 * stays — the assistant's answer composes its questions and proposals,
 * and approving a card reads a turn back through it.
 */
const DISCUSSION = zodOutputSchema(DiscussionOutputSchema);

/** The minimum a discussion turn can be: the PO said something and proposed nothing. */
const chatter = { message: "The scheduler skips a ticket whose dependencies aren't terminal yet." };

function discuss(raw: unknown) {
  return validateResultAgainst(DISCUSSION, "discuss", raw);
}

describe("DiscussionOutputSchema — the conversational turn", () => {
  it("accepts a message with no proposals, and defaults the array", () => {
    const result = discuss(chatter);

    expect(result.ok).toBe(true);
    // A turn that proposes nothing is the normal case, not a run that
    // did nothing — the whole point of a `discuss` action.
    expect(result.ok && result.value).toEqual({ ...chatter, questions: [], proposals: [] });
  });

  it("rejects a turn with no message, however many proposals it carries", () => {
    const result = discuss({ proposals: [{ action: "amend", item: "EO-1", why: "because", title: "New" }] });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("message");
  });

  it("carries several proposals in one turn", () => {
    const result = discuss({
      message: "Two things follow from that.",
      proposals: [
        { action: "amend", item: "EO-1", why: "the API changed", body: "Updated." },
        { action: "new_bug", title: "Retry storm", body: "It retries forever.", steps_to_reproduce: "Kill the upstream.", expected: "Backs off.", actual: "Hammers.", environment: "main, Linux." },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.ok && (result.value as { proposals: unknown[] }).proposals).toHaveLength(2);
  });

  it("rejects an unrecognised action rather than dropping it", () => {
    const result = discuss({ message: "Deleting it.", proposals: [{ action: "delete", item: "EO-1" }] });
    expect(result.ok).toBe(false);
  });
});

describe("DiscussionProposalSchema — new work", () => {
  it("accepts a feature with its stories, reusing the refine story shape", () => {
    const result = discuss({
      message: "Here's how I'd break it down.",
      proposals: [
        {
          action: "new_feature",
          title: "Rate limiting",
          understanding: "Cap anonymous callers at 100 requests a minute.",
          stories: [{ title: "Add the limiter", body: "Sliding window.", acceptance_criteria: ["returns 429 after 100 in a minute"] }],
        },
      ],
    });

    expect(result.ok).toBe(true);
    const proposal = result.ok ? (result.value as { proposals: [{ decisions: unknown[]; stories: [{ depends_on: unknown[]; touches: unknown[] }] }] }).proposals[0] : null;
    // Defaults come from RefineStorySchema itself, which is the proof
    // that `applyApprovedProposal` will accept this untouched.
    expect(proposal?.decisions).toEqual([]);
    expect(proposal?.stories[0]?.depends_on).toEqual([]);
    expect(proposal?.stories[0]?.touches).toEqual([]);
  });

  it("carries a base branch on a story, inside a feature or on its own (EO-364)", () => {
    const result = discuss({
      message: "These go on the release branch.",
      proposals: [
        {
          action: "new_feature",
          title: "Rate limiting",
          understanding: "Cap anonymous callers at 100 requests a minute.",
          stories: [{ title: "Add the limiter", body: "Sliding window.", acceptance_criteria: ["returns 429"], base_branch: "release/2.4" }],
        },
        { action: "new_story", title: "Retry-After", body: "Say when.", acceptance_criteria: ["a 429 carries Retry-After"], base_branch: "release/2.4" },
      ],
    });

    expect(result.ok).toBe(true);
    const proposals = result.ok ? (result.value as { proposals: [{ stories: [{ base_branch?: string }] }, { base_branch?: string }] }).proposals : null;
    expect(proposals?.[0].stories[0].base_branch).toBe("release/2.4");
    expect(proposals?.[1].base_branch).toBe("release/2.4");
  });

  it("rejects a feature proposing no stories — there would be nothing to create", () => {
    const result = discuss({
      message: "Breaking it down.",
      proposals: [{ action: "new_feature", title: "Rate limiting", understanding: "Cap callers.", stories: [] }],
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("stories");
  });

  it("attaches a story to an existing feature and depends on live siblings by key", () => {
    const result = discuss({
      message: "That's a new story under the feature.",
      proposals: [
        {
          action: "new_story",
          parent: "EO-42",
          title: "Add a Retry-After header",
          body: "The 429 says nothing about when to come back.",
          acceptance_criteria: ["a 429 carries Retry-After in seconds"],
          depends_on: ["EO-43"],
          touches: ["src/limiter.ts"],
        },
      ],
    });

    expect(result.ok).toBe(true);
  });

  it("rejects a story with no acceptance criteria, at the same bar refine holds", () => {
    const result = discuss({
      message: "Adding it.",
      proposals: [{ action: "new_story", title: "Do a thing", body: "", acceptance_criteria: [] }],
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("acceptance_criteria");
  });

  it("rejects a bug missing any of the four required fields", () => {
    const complete = {
      action: "new_bug",
      title: "Logout does nothing",
      body: "Clicking logout leaves the session active.",
      steps_to_reproduce: "Sign in, click Logout.",
      expected: "The session ends.",
      actual: "Nothing happens.",
      environment: "Chrome 128 on macOS 14.",
    };
    expect(discuss({ message: "Filing it.", proposals: [complete] }).ok).toBe(true);

    for (const field of ["steps_to_reproduce", "expected", "actual", "environment"] as const) {
      const partial: Record<string, unknown> = { ...complete };
      delete partial[field];
      expect(discuss({ message: "Filing it.", proposals: [partial] }).ok, `${field} must be required`).toBe(false);
      expect(discuss({ message: "Filing it.", proposals: [{ ...complete, [field]: "" }] }).ok, `${field} must be non-empty`).toBe(false);
    }
  });

  it("rejects a touches entry that is prose rather than a path", () => {
    const result = discuss({
      message: "Adding it.",
      proposals: [
        {
          action: "new_story",
          title: "Do a thing",
          body: "",
          acceptance_criteria: ["it works"],
          touches: ["gateway middleware / request pipeline"],
        },
      ],
    });

    expect(result.ok).toBe(false);
  });
});

describe("DiscussionProposalSchema — changing existing work", () => {
  it("accepts an amendment that changes one field, with a reason", () => {
    expect(discuss({ message: "Updating it.", proposals: [{ action: "amend", item: "EO-45", why: "new requirement", acceptance_criteria: ["also logs the caller"] }] }).ok).toBe(true);
  });

  it("rejects an amendment that changes nothing", () => {
    // It would otherwise validate and render an approvable card that
    // does nothing when applied.
    const result = discuss({ message: "Updating it.", proposals: [{ action: "amend", item: "EO-45", why: "new requirement" }] });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("at least one");
  });

  it("rejects an amendment with no reason — it lands on someone else's item", () => {
    expect(discuss({ message: "Updating it.", proposals: [{ action: "amend", item: "EO-45", title: "New title" }] }).ok).toBe(false);
  });

  it("has no way to express a state change, because only transitionItem may write one", () => {
    // Invariant 1. `state` is not in the schema, so it is stripped
    // rather than honoured — and the amendment still has to change
    // something real to validate at all.
    const result = discuss({ message: "Moving it.", proposals: [{ action: "amend", item: "EO-45", why: "done", state: "ready_to_merge" }] });
    expect(result.ok).toBe(false);
  });

  it("accepts a reorder and rejects one that moves no edges", () => {
    expect(discuss({ message: "Ordering them.", proposals: [{ action: "reorder", item: "EO-45", why: "it needs the limiter first", add_depends_on: ["EO-43"] }] }).ok).toBe(true);
    expect(discuss({ message: "Ordering them.", proposals: [{ action: "reorder", item: "EO-45", why: "no-op", add_depends_on: [], remove_depends_on: [] }] }).ok).toBe(false);
  });

  it("rejects an item reference that is a title rather than a key", () => {
    const result = discuss({ message: "Updating it.", proposals: [{ action: "amend", item: "the rate limiting story", why: "x", title: "New" }] });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("ticket key");
  });

  it("accepts any prefix, because key_prefix is a setting a human types", () => {
    for (const key of ["EO-42", "KAN-7", "DISC-1", "my-repository-12"]) {
      expect(discuss({ message: "x", proposals: [{ action: "amend", item: key, why: "y", title: "z" }] }).ok, key).toBe(true);
    }
  });
});

describe("asking, as part of a turn", () => {
  const scope = {
    id: "scope",
    question: "Per API key or per account?",
    why: "Two keys on one account either share a budget or they do not.",
    options: ["per key", "per account"],
  };

  it("carries a batch of questions alongside the message", () => {
    const result = discuss({
      message: "Two things decide the shape of this.",
      questions: [scope, { id: "window", question: "How long is the window?", why: "It sets the counter's resolution.", options: ["a minute", "an hour"] }],
    });

    expect(result.ok).toBe(true);
    // Asking and saying something are the same turn: "here is what I
    // understand, and here is what I still need" is one thing a person
    // says, not two.
    expect(result.ok && (result.value as { questions: unknown[] }).questions).toHaveLength(2);
  });

  it("requires a `why` on every question", () => {
    const result = discuss({ message: "One thing first.", questions: [{ id: "scope", question: "Per key?", options: ["yes", "no"] }] });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("why");
  });

  it("refuses a question with nothing to choose between", () => {
    // The card is a decision between alternatives. An open question —
    // "what are you trying to build?" — is something the product owner
    // says in `message`, where the person answers it by typing, and a
    // card wrapped around it is a form field pretending to be a choice.
    const open = { id: "goal", question: "What are you trying to build?", why: "Nothing can be scoped until I know." };

    expect(discuss({ message: "Tell me more.", questions: [{ ...open, options: [] }] }).ok).toBe(false);
    expect(discuss({ message: "Tell me more.", questions: [{ ...open, options: ["a feature"] }] }).ok).toBe(false);
    expect(discuss({ message: "Tell me more.", questions: [open] }).ok).toBe(false);
  });

  it("refuses to ask and propose in the same turn", () => {
    const result = discuss({
      message: "Here is what I think.",
      questions: [scope],
      proposals: [{ action: "amend", item: "EO-1", why: "the API changed", body: "Updated." }],
    });

    // A proposal built on unanswered questions is a guess with an
    // Approve button under it.
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("either asks or proposes");
  });

  it("caps a batch at what a person can reasonably be asked at once", () => {
    const many = Array.from({ length: 7 }, (_unused, index) => ({ ...scope, id: `q${index}` }));

    expect(discuss({ message: "Everything at once.", questions: many }).ok).toBe(false);
  });

  it("caps the options at a choice rather than a form", () => {
    expect(discuss({ message: "Pick one.", questions: [{ ...scope, options: ["a", "b", "c", "d", "e", "f"] }] }).ok).toBe(false);
  });
});

/**
 * A priority on the proposals that create work, and on the one that
 * changes it, held to the rule `items:update` applies (EO-568): an
 * integer, 0 or more.
 */
describe("DiscussionProposalSchema — priority", () => {
  const feature = (extra: Record<string, unknown> = {}, storyExtra: Record<string, unknown> = {}) => ({
    action: "new_feature",
    title: "Rate limiting",
    understanding: "Cap callers.",
    stories: [{ title: "Add the limiter", body: "", acceptance_criteria: ["It limits."], ...storyExtra }],
    ...extra,
  });
  const newStory = (extra: Record<string, unknown> = {}) => ({ action: "new_story", title: "Add the limiter", body: "", acceptance_criteria: ["It limits."], ...extra });
  const newBug = (extra: Record<string, unknown> = {}) => ({
    action: "new_bug",
    title: "Login loops",
    body: "",
    steps_to_reproduce: "Sign in.",
    expected: "Signed in.",
    actual: "Back at sign-in.",
    environment: "Chrome.",
    ...extra,
  });
  const amend = (extra: Record<string, unknown> = {}) => ({ action: "amend", item: "EO-45", why: "The person asked.", ...extra });

  it.each([
    ["new_feature", feature({ priority: 2 }, { priority: 1 })],
    ["new_story", newStory({ priority: 2 })],
    ["new_bug", newBug({ priority: 1 })],
    ["amend", amend({ priority: 3 })],
  ])("accepts one on %s", (_action, proposal) => {
    expect(discuss({ message: "Here.", proposals: [proposal] }).ok).toBe(true);
  });

  it.each([
    ["new_feature", feature()],
    ["new_story", newStory()],
    ["new_bug", newBug()],
  ])("leaves %s without one valid, as every proposal before it was", (_action, proposal) => {
    const result = discuss({ message: "Here.", proposals: [proposal] });

    expect(result.ok).toBe(true);
    expect(JSON.stringify(result.ok && result.value)).not.toContain("priority");
  });

  it.each([
    ["the feature of a new_feature", feature({ priority: -1 })],
    ["a story inside a new_feature", feature({}, { priority: -1 })],
    ["a new_story", newStory({ priority: -1 })],
    ["a new_bug", newBug({ priority: -1 })],
    // It was any integer, so an approvable card could carry one
    // `items:update` refused only on accept.
    ["an amend", amend({ priority: -1 })],
    ["a new_story, fractionally", newStory({ priority: 1.5 })],
    ["an amend, fractionally", amend({ priority: 0.5 })],
  ])("refuses a bad priority on %s", (_where, proposal) => {
    expect(discuss({ message: "Here.", proposals: [proposal] }).ok).toBe(false);
  });
});

describe("the discussion shape as a provider is handed it", () => {
  it("produces a JSON schema the provider can constrain generation with", () => {
    const schema = providerSchemaFor(DISCUSSION);

    expect(schema).toBeDefined();
    // Same nesting every other action gets: the union with
    // ClarificationRequired lives under `outcome`, because the API
    // refuses a root-level union.
    expect(schema).toHaveProperty("properties.outcome");
    // Refinements cannot be expressed in JSON Schema and are dropped
    // here by design — they still run on parse, so an amendment that
    // changes nothing fails validation and is re-prompted rather than
    // being made impossible to generate.
    expect(JSON.stringify(schema)).not.toContain("at least one");
  });
});
