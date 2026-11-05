import { describe, expect, it } from "vitest";
import {
  asClarification,
  childrenFromStories,
  outputSchemaFor,
  refineChildren,
  resultSchemaFor,
  specFromAnswer,
  validateActionResult,
  ProposedStorySchema,
  RefineOutputSchema,
  RefineStorySchema,
} from "./index.js";
import { developerRegistry } from "../registry/developer.js";

// The registry as EO ships it (KAN-124): every lookup here is asked about
// the developer pack, which is the one whose schemas these tests are about.
const registry = developerRegistry();

describe("validateActionResult", () => {
  // A decomposition answers with children of a stated type since
  // KAN-147, each carrying the fields that type's shape demands — so a
  // story child says `type: "story"` and brings its acceptance criteria.
  // The value comes back exactly as the agent wrote it: the composed
  // schema is a JSON Schema document, and a JSON Schema validator
  // neither strips unknown keys nor fills defaults in.
  it("parses a valid refine output", () => {
    const child = { type: "story", title: "A story", body: "Do it.", acceptance_criteria: ["it works"] };
    const result = validateActionResult(registry, "refine", { children: [child] });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ children: [child] });
  });

  it("rejects a malformed result with the specific path and message", () => {
    const result = validateActionResult(registry, "refine", { children: [{ type: "story", body: "no title" }] });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("children.0.title"); // the exact field, so the agent knows what to fix
      expect(result.error).toContain("refine");
    }
  });

  it("rejects a child of a type this project does not have", () => {
    expect(validateActionResult(registry, "refine", { children: [{ type: "case", title: "A case", body: "Do it." }] }).ok).toBe(false);
  });

  it("rejects a child that is a container, because a decomposition produces work", () => {
    expect(validateActionResult(registry, "refine", { children: [{ type: "feature", title: "A feature", body: "Do it." }] }).ok).toBe(false);
  });

  it("rejects prose where an object was required", () => {
    const result = validateActionResult(registry, "refine", "Sure! Here are three stories: ...");
    expect(result.ok).toBe(false);
  });

  it("accepts a well-formed result the model wrapped in a ```json fence", () => {
    // Asking for a schema is not the same as getting one. Claude falls
    // back to the model's own text whenever the SDK reports no
    // `structured_output`, and Codex's parse of its final message is a
    // bare JSON.parse that a fence defeats. The answer is right; only its
    // wrapping is wrong, and rejecting it spends two correction turns
    // before escalating over nothing. `asClarification` already unfences
    // the identical value — this is the same net under the answer.
    const fenced = '```json\n{ "children": [{ "type": "story", "title": "A story", "body": "Do it.", "acceptance_criteria": ["it works"] }] }\n```';

    const result = validateActionResult(registry, "refine", fenced);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ children: [{ type: "story", title: "A story", body: "Do it.", acceptance_criteria: ["it works"] }] });
    }
  });

  it("accepts a result returned as bare JSON text, fence or no fence", () => {
    const result = validateActionResult(registry, "implement", '{ "branch": "eo/EO-1", "summary": "done", "handoff": "Nothing surprising." }');

    expect(result.ok).toBe(true);
  });

  it("still hands an action with no schema its text exactly as written", () => {
    // The passthrough is the point for an action this codebase has never
    // heard of (invariant #7): unfencing it would change what a pipeline
    // author's own step receives.
    const raw = '```json\n{ "anything": true }\n```';

    const result = validateActionResult(registry, "a_pipeline_defined_its_own", raw);

    expect(result).toEqual({ ok: true, value: raw });
  });

  it("validates implement output", () => {
    expect(validateActionResult(registry, "implement", { branch: "eo/EO-1", summary: "done", handoff: "Nothing surprising." }).ok).toBe(true);
    expect(validateActionResult(registry, "implement", { summary: "no branch", handoff: "x" }).ok).toBe(false);
  });

  it("demands a handoff, because the implementer leaves nothing else in the thread", () => {
    // KAN-31. Optional would mean omitted on exactly the runs where it
    // mattered — a rejection sends the story back and the next attempt
    // has only the reviewer's complaint to go on.
    const missing = validateActionResult(registry, "implement", { branch: "eo/EO-1", summary: "done" });

    expect(missing.ok).toBe(false);
    expect(missing.ok === false && missing.error).toContain("handoff");
  });

  it("validates review output, and rejects a verdict outside the enum", () => {
    expect(validateActionResult(registry, "review", { verdict: "approve", feedback: "LGTM" }).ok).toBe(true);

    const bad = validateActionResult(registry, "review", { verdict: "maybe", feedback: "hmm" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("verdict");
  });

  it("demands a criteria worksheet on a rejection and on nothing else", () => {
    // EO-200. `reviewer.md` already said, in bold, to report every
    // blocking issue in one verdict, and EO-194 went four rejections
    // anyway. Prose has been tried; this is the schema asking.
    const coverage = [{ criterion: "429 over budget", result: "not_met" as const }];

    expect(validateActionResult(registry, "review", { verdict: "reject", feedback: "no", criteria_coverage: coverage, blocking_issues: ["fix it"] }).ok).toBe(true);

    const missing = validateActionResult(registry, "review", { verdict: "reject", feedback: "no", blocking_issues: ["fix it"] });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain("criteria_coverage");

    // An approval gains no new obligation: a clean review stays cheap.
    expect(validateActionResult(registry, "review", { verdict: "approve", feedback: "LGTM" }).ok).toBe(true);
    expect(validateActionResult(registry, "review", { verdict: "needs_user_input", feedback: "Which way?" }).ok).toBe(true);
  });

  it("takes an empty worksheet, because an item may declare no criteria", () => {
    // A floor here would leave the reviewer of a criteria-less item
    // unable to produce any valid rejection at all. Whether the
    // worksheet actually accounts for the item's criteria is the
    // engine's check, not the schema's — it is the only side that holds
    // the item (invariant #5).
    expect(validateActionResult(registry, "review", { verdict: "reject", feedback: "no", criteria_coverage: [], blocking_issues: ["fix it"] }).ok).toBe(true);
  });

  it("still refuses a rejection with no blocking issues, and a question that carries any", () => {
    // KAN-31's guarantee, restated because EO-200 moved in next to it.
    const empty = validateActionResult(registry, "review", { verdict: "reject", feedback: "no", criteria_coverage: [], blocking_issues: [] });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error).toContain("blocking_issues");

    const asking = validateActionResult(registry, "review", { verdict: "needs_user_input", feedback: "Which way?", blocking_issues: ["a thing"] });
    expect(asking.ok).toBe(true);
    // Accepted, but stripped: `needs_user_input` has no such field, so
    // nothing downstream can read one off it.
    expect(asking.ok && asking.value).not.toHaveProperty("blocking_issues");
  });

  it("rejects a criterion result outside the three a reviewer may give", () => {
    const bad = validateActionResult(registry, "review", {
      verdict: "reject",
      feedback: "no",
      // `not_reported` is the engine's word for a criterion the review
      // never mentioned. A reviewer claiming it would be claiming its
      // own silence as a finding.
      criteria_coverage: [{ criterion: "429 over budget", result: "not_reported" }],
      blocking_issues: ["fix it"],
    });

    expect(bad.ok).toBe(false);
  });

  it("validates what an @-mentioned agent answers with", () => {
    // The action had no schema, so generation was unconstrained and the
    // answer came back in whatever shape the role's own prompt implied.
    // Nothing could post that, and an unposted answer leaves the mention
    // open — which re-dispatches the same request until the attempt limit.
    expect(validateActionResult(registry, "respond", { message: "Rebased and force-pushed." }).ok).toBe(true);
    expect(validateActionResult(registry, "respond", { branch: "eo/EO-1", summary: "done", handoff: "x" }).ok).toBe(false);
    expect(validateActionResult(registry, "respond", { message: "" }).ok).toBe(false);
  });

  /**
   * The three answers to a free-text reply (EO-184).
   *
   * Discriminated on `status` so the branches cannot be half-satisfied:
   * "answered" with a summary instead of an answer is a reading nothing
   * could post, and it has to fail here rather than reach the thread.
   */
  it("validates what the system agent made of a reply to a parked step", () => {
    expect(validateActionResult(registry, "interpret", { status: "answered", answer: "EO-3" }).ok).toBe(true);
    expect(validateActionResult(registry, "interpret", { status: "acted", summary: "Deleted the stale branch.", retry: true }).ok).toBe(true);
    expect(validateActionResult(registry, "interpret", { status: "unusable", problem: "it names a person" }).ok).toBe(true);

    // An empty answer is not an answer: it is posted verbatim as the
    // comment a waiting step matches against.
    expect(validateActionResult(registry, "interpret", { status: "answered", answer: "" }).ok).toBe(false);
    // `retry` is the whole difference between "run the step again" and
    // "leave it parked", so it cannot be left to a default.
    expect(validateActionResult(registry, "interpret", { status: "acted", summary: "Did it." }).ok).toBe(false);
    expect(validateActionResult(registry, "interpret", { status: "answered", summary: "Did it.", retry: true }).ok).toBe(false);
    expect(validateActionResult(registry, "interpret", { status: "shrugged" }).ok).toBe(false);
  });

  it("passes through an action with no registered schema — workflow states are data (invariant #7)", () => {
    const result = validateActionResult(registry, "some_custom_action", { anything: true });

    expect(result).toEqual({ ok: true, value: { anything: true } });
    expect(resultSchemaFor(registry, "some_custom_action")).toBeUndefined();
  });
});

describe("outputSchemaFor", () => {
  /**
   * Two branches since KAN-29: the action's own answer, or a request to
   * be told something first. Asking has to be *in* the schema, because
   * an agent left to invent the shape of "I am blocked" writes prose,
   * and prose is what the design exists to avoid.
   */
  function branches(schema: ReturnType<typeof outputSchemaFor>): Record<string, unknown>[] {
    const properties = schema?.["properties"] as Record<string, { anyOf?: unknown }> | undefined;
    return (properties?.["outcome"]?.anyOf ?? []) as Record<string, unknown>[];
  }

  it("keeps the union off the top level, which the API refuses", () => {
    // Probed, not assumed: a root union answers every dispatch with
    // "input_schema does not support oneOf, allOf, or anyOf at the top
    // level" while every test here stays green.
    const schema = outputSchemaFor(registry, "review");

    expect(schema).toMatchObject({ type: "object" });
    expect(schema).not.toHaveProperty("anyOf");
    expect(schema?.["required"]).toContain("outcome");
  });

  it("offers the action's answer and a clarification, in that order", () => {
    const [asking, answering] = branches(outputSchemaFor(registry, "review"));

    // Asking first: a real result never matches it, but a clarification
    // could partially satisfy a loose action schema.
    expect((asking?.["properties"] as Record<string, unknown>)?.["status"]).toBeDefined();
    // Review is itself a union — approve, reject and needs_user_input are
    // different shapes — and zod emits a *discriminated* union as `oneOf`.
    // Three since KAN-53: the shipped pipeline routes `needs_user_input` to
    // the human, and a declared result no agent can produce is a branch
    // that exists and can never be taken.
    expect(answering?.["oneOf"]).toHaveLength(3);
  });

  it("produces a JSON Schema the provider can constrain generation with", () => {
    const [, answering] = branches(outputSchemaFor(registry, "review"));
    const [approve, reject] = (answering?.["oneOf"] ?? []) as Record<string, unknown>[];

    expect(approve).toMatchObject({ type: "object" });
    expect(approve?.["properties"]).toHaveProperty("verdict");
    expect(reject?.["properties"]).toHaveProperty("blocking_issues");
  });

  it("demands blocking issues on a rejection and nowhere else", () => {
    // KAN-31. A rejection reaches the next attempt as prose in a
    // comment; one with nothing listed sends a story back with no idea
    // what to change. On an approve the field means nothing, so it is
    // not there at all.
    const [, answering] = branches(outputSchemaFor(registry, "review"));
    const [approve, reject] = (answering?.["oneOf"] ?? []) as Record<string, unknown>[];

    expect(reject?.["required"]).toContain("blocking_issues");
    expect(approve?.["properties"]).not.toHaveProperty("blocking_issues");
  });

  it("constrains generation to produce the criteria worksheet on a rejection", () => {
    // EO-200. Constrained generation is what makes this an obligation
    // rather than a suggestion: the model cannot emit a rejection
    // without the field, which is the difference between this and the
    // instruction that was already in the prompt and did not hold.
    const [, answering] = branches(outputSchemaFor(registry, "review"));
    const [approve, reject] = (answering?.["oneOf"] ?? []) as Record<string, unknown>[];

    expect(reject?.["required"]).toContain("criteria_coverage");
    expect(approve?.["properties"]).not.toHaveProperty("criteria_coverage");

    const coverage = (reject?.["properties"] as Record<string, Record<string, unknown>>)["criteria_coverage"];
    const entry = coverage?.["items"] as Record<string, unknown>;
    expect(entry["required"]).toEqual(expect.arrayContaining(["criterion", "result"]));
    expect((entry["properties"] as Record<string, Record<string, unknown>>)["result"]?.["enum"]).toEqual(["met", "not_met", "not_assessed"]);
  });

  it("does not demand fields that have defaults — they are ours to fill, not the model's", () => {
    const [, answering] = branches(outputSchemaFor(registry, "implement"));

    expect(answering?.["required"]).toContain("branch");
    expect(answering?.["required"]).not.toContain("files_changed"); // defaulted, so optional for the model
  });

  it("is undefined for an action with no schema", () => {
    expect(outputSchemaFor(registry, "some_custom_action")).toBeUndefined();
  });

  it("constrains intake, which is how a clarification stops arriving as prose", () => {
    // KAN-32, and the whole point of registering it. With no schema
    // there is nothing to constrain generation with, so the provider
    // returns the model's own text — and a model asked for JSON returns
    // it inside a fence, which `asClarification` cannot read.
    const [asking, answering] = branches(outputSchemaFor(registry, "intake"));

    expect((asking?.["properties"] as Record<string, unknown>)?.["status"]).toBeDefined();
    // KAN-4 gave intake's own answer more than one branch; KAN-147
    // composes them from the project's item types, one each, and joins
    // them with `anyOf` — because two packs may ship one slug and an
    // answer matching two branches is an ambiguous classification rather
    // than a malformed result.
    expect(answering?.["anyOf"]).toHaveLength(3);
  });

  it("still requires ready/understanding on the feature branch, and defaults decisions", () => {
    const [, answering] = branches(outputSchemaFor(registry, "intake"));
    const [feature] = (answering?.["anyOf"] ?? []) as Record<string, unknown>[];

    expect(feature?.["required"]).toEqual(expect.arrayContaining(["type", "ready", "understanding"]));
    expect(feature?.["required"]).not.toContain("decisions"); // defaulted: a clear feature settles nothing
  });

  it("requires every bug field on the bug branch — no field is optional for an underspecified report", () => {
    const [, answering] = branches(outputSchemaFor(registry, "intake"));
    const [, , bug] = (answering?.["anyOf"] ?? []) as Record<string, unknown>[];

    expect(bug?.["required"]).toEqual(
      expect.arrayContaining(["type", "ready", "title", "body", "steps_to_reproduce", "expected", "actual", "environment"]),
    );
  });
});

describe("the composed intake schema — a container's branch", () => {
  it("has no way to say 'not yet' — asking is the only way to park", () => {
    // The same shape as ClarifyOutputSchema, for the same reason: one
    // parking mechanism, not two. A `ready: false` would be a field
    // nothing reads and a second way to be blocked.
    expect(validateActionResult(registry, "intake", { type: "feature", ready: false, understanding: "Not sure." }).ok).toBe(false);
  });

  it("requires an understanding, because that is what refine reads instead of the thread", () => {
    const answered = { type: "feature", ready: true, understanding: "Cap anonymous callers." };

    expect(validateActionResult(registry, "intake", { ...answered, understanding: "" }).ok).toBe(false);
    // Returned exactly as sent: the shape is a document now (KAN-147) and
    // a document validates rather than transforms — `decisions` is not
    // stamped with its default here, it is defaulted where EO *reads* the
    // answer (`ContainerIntakeSchema`). The difference between the two
    // kinds of `OutputSchema` is documented on the kinds themselves.
    expect(validateActionResult(registry, "intake", answered)).toEqual({ ok: true, value: answered });
  });

  it("demands the classification, now that there is no one type it could have meant", () => {
    // A result with no `type` used to be stamped as the feature it must
    // have been, which was back-compatibility for answers written before
    // intake had more than one (KAN-4). A shape composed from the
    // project's types (KAN-147) has no such fallback: there is nothing to
    // infer from, and inferring would be EO choosing an item's type for
    // the agent that declined to.
    expect(validateActionResult(registry, "intake", { ready: true, understanding: "Cap anonymous callers." }).ok).toBe(false);
  });

  it("keeps a settled decision's topic and wording", () => {
    const result = validateActionResult(registry, "intake", {
      type: "feature",
      ready: true,
      understanding: "Rate limiting for the public API.",
      decisions: [{ topic: "Scope", decision: "Per API key, not per account." }],
    });

    expect(result).toMatchObject({ ok: true, value: { decisions: [{ topic: "Scope", decision: "Per API key, not per account." }] } });
  });

  it("rejects a decision with nothing in it", () => {
    const result = validateActionResult(registry, "intake", {
      type: "feature",
      ready: true,
      understanding: "Rate limiting.",
      decisions: [{ topic: "Scope", decision: "" }],
    });

    expect(result.ok).toBe(false);
  });

  it("still recognises a clarification, now that intake has a schema of its own", () => {
    // Registering a schema must not shut the asking door: the union is
    // what keeps both answers reachable on the same action.
    const asked = validateActionResult(registry, "intake", {
      outcome: { status: "clarification_required", questions: [{ id: "scope", question: "Per key?", why: "Storage differs." }] },
    });

    expect(asked.ok).toBe(false); // not an intake *answer* — the supervisor reads it as a clarification instead
    expect(asClarification({ outcome: { status: "clarification_required", questions: [{ id: "scope", question: "Per key?", why: "Storage differs." }] } })).not.toBeNull();
  });
});

describe("the composed intake schema — a leaf's branch (KAN-4)", () => {
  it("accepts a story with a title, a body and at least one acceptance criterion", () => {
    const result = validateActionResult(registry, "intake", {
      type: "story",
      ready: true,
      title: "Add a logout button",
      body: "Users have no way to end their session from the header.",
      acceptance_criteria: ["A logout button appears in the header when signed in."],
    });

    expect(result).toEqual({
      ok: true,
      value: {
        type: "story",
        ready: true,
        title: "Add a logout button",
        body: "Users have no way to end their session from the header.",
        acceptance_criteria: ["A logout button appears in the header when signed in."],
      },
    });
  });

  it("rejects a story with no acceptance criteria", () => {
    const missing = validateActionResult(registry, "intake", {
      type: "story",
      ready: true,
      title: "Add a logout button",
      body: "Users have no way to end their session.",
      acceptance_criteria: [],
    });

    expect(missing.ok).toBe(false);

    const omitted = validateActionResult(registry, "intake", {
      type: "story",
      ready: true,
      title: "Add a logout button",
      body: "Users have no way to end their session.",
    });

    expect(omitted.ok).toBe(false);
  });

  it("rejects a story with no title", () => {
    const result = validateActionResult(registry, "intake", {
      type: "story",
      ready: true,
      title: "",
      body: "Users have no way to end their session.",
      acceptance_criteria: ["Works"],
    });

    expect(result.ok).toBe(false);
  });
});

describe("the composed intake schema — a leaf with four required fields (KAN-4)", () => {
  const validBug = {
    type: "bug" as const,
    ready: true as const,
    title: "Logout button does nothing",
    body: "Clicking logout leaves the session active.",
    steps_to_reproduce: "Sign in, click logout.",
    expected: "The session ends and the user is returned to the sign-in page.",
    actual: "Nothing happens; the session stays active.",
    environment: "Chrome 128 on macOS 14.",
  };

  it("accepts a bug with every required field present", () => {
    // Criteria are optional on a bug (EO-205), so a bug that arrives
    // without them is accepted rather than read as a bug that failed to
    // say something. It reads back as sent — the empty default is applied
    // where EO reads the spec, not by the document that validated it.
    expect(validateActionResult(registry, "intake", validBug)).toEqual({ ok: true, value: validBug });
  });

  it("keeps the acceptance criteria a bug does arrive with", () => {
    // The other half of EO-205: intake is a conversation, and one that
    // settled what "fixed" means had nowhere to put the answer. A bug
    // is never *asked* for criteria — the four repro fields are its bar
    // — but the ones it brings are its own.
    const criteria = ["Clicking logout ends the session.", "The header shows the sign-in link afterwards."];

    expect(validateActionResult(registry, "intake", { ...validBug, acceptance_criteria: criteria })).toEqual({
      ok: true,
      value: { ...validBug, acceptance_criteria: criteria },
    });
  });

  it("still refuses a bug whose criteria are not criteria", () => {
    // Optional is not unvalidated: an empty string is not something
    // anybody can check, exactly as on a story.
    expect(validateActionResult(registry, "intake", { ...validBug, acceptance_criteria: [""] }).ok).toBe(false);
  });

  it.each(["steps_to_reproduce", "expected", "actual", "environment"] as const)("rejects a bug missing %s", (field) => {
    const withoutField: Record<string, unknown> = { ...validBug };
    delete withoutField[field];
    expect(validateActionResult(registry, "intake", withoutField).ok).toBe(false);
  });

  it.each(["steps_to_reproduce", "expected", "actual", "environment"] as const)(
    "rejects a bug with an empty string for %s",
    (field) => {
      expect(validateActionResult(registry, "intake", { ...validBug, [field]: "" }).ok).toBe(false);
    },
  );
});

describe("the composed intake schema — a type this project does not have", () => {
  it("fails validation rather than falling back to any one branch", () => {
    const result = validateActionResult(registry, "intake", {
      type: "epic",
      ready: true,
      title: "Something bigger",
      body: "This does not fit feature, story or bug.",
    });

    expect(result.ok).toBe(false);
  });
});

describe("RefineOutputSchema", () => {
  it("requires at least one story — an empty refinement is a failure, not a result", () => {
    expect(RefineOutputSchema.safeParse({ stories: [] }).success).toBe(false);
  });

  it("rejects a negative or fractional depends_on index", () => {
    const base = { title: "T", body: "" };
    expect(RefineOutputSchema.safeParse({ stories: [{ ...base, depends_on: [-1] }] }).success).toBe(false);
    expect(RefineOutputSchema.safeParse({ stories: [{ ...base, depends_on: [1.5] }] }).success).toBe(false);
  });
});

/**
 * The two fields a submitter fills in, and the product owner never does
 * (EO-124).
 *
 * `RefineStorySchema` is shared: `work:submitPlan` takes stories in that
 * shape, and `RefineOutputSchema` and `DiscussionOutputSchema` are what
 * `outputSchemaFor` hands a provider. Adding a field to it would have
 * told the product owner about a key it cannot have — it is proposing
 * work that exists nowhere yet — and a model shown a field eventually
 * fills it in. `ProposedStorySchema` takes both back off, and these are
 * the tests that keep that true rather than remembered.
 */
describe("a story's Jira fields", () => {
  const story = { title: "A story", body: "Do it.", acceptance_criteria: ["it works"] };

  it("takes a key and a switch from a submitter", () => {
    const parsed = RefineStorySchema.safeParse({ ...story, jira_key: "KAN-123", jira_sync: false });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.jira_key).toBe("KAN-123");
    expect(parsed.data?.jira_sync).toBe(false);
  });

  it("leaves a key that is not one for the command to refuse, rather than failing the payload", () => {
    // `work_submit_plan` answers a bad plan with a `problem` naming what
    // is wrong, and a plan's keys are wrong three ways — malformed, held
    // by another item, given twice in one plan. Only the first is
    // visible from a schema, and refusing it here would make it the one
    // that comes back as a transport error instead. So the format is not
    // checked at this boundary; `applyNewFeature` checks all three and
    // canonicalises what it keeps.
    const parsed = RefineStorySchema.safeParse({ ...story, jira_key: "https://acme.atlassian.net/browse/KAN-1" });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.jira_key).toBe("https://acme.atlassian.net/browse/KAN-1");
  });

  it("keeps both optional, so a story that mentions neither is still a story", () => {
    const parsed = RefineStorySchema.safeParse(story);

    expect(parsed.success).toBe(true);
    expect(parsed.data?.jira_key).toBeUndefined();
    expect(parsed.data?.jira_sync).toBeUndefined();
  });

  it("never offers them to the product owner, whose schemas are derived from the same shape", () => {
    // The check the story asks for, made mechanical: both schemas below
    // are built from `ProposedStorySchema`, so a field added to
    // `RefineStorySchema` cannot reach a provider without this failing.
    for (const action of ["refine", "assist"]) {
      expect(JSON.stringify(outputSchemaFor(registry, action)), action).not.toContain("jira");
    }
  });

  it("still validates a refine result that says nothing about Jira", () => {
    const result = validateActionResult(registry, "refine", { children: [{ type: "story", ...story }] });

    expect(result.ok).toBe(true);
  });

  it("does not fail a run over a key a refine result invented — what the child becomes is the type's own fields", () => {
    // A JSON Schema validator neither strips an unknown key nor refuses
    // it, where zod stripped: failing here would spend two correction
    // turns on a field the agent was never asked for. What keeps the
    // invention out of the item is `specFromAnswer`, which is what the
    // creation path writes — only the properties the shape names.
    const result = validateActionResult(registry, "refine", { children: [{ type: "story", ...story, jira_key: "KAN-1" }] });

    expect(result.ok).toBe(true);

    const [child] = refineChildren(result.ok ? result.value : {});
    const shape = registry.itemTypes.get("developer:story")!.specShape;
    expect(JSON.stringify(specFromAnswer(shape, child!.spec))).not.toContain("KAN-1");
  });
});

/**
 * A story's base branch (EO-364): something a plan and a conversation
 * may name, and a decomposition never is asked for.
 */
describe("a story's base branch", () => {
  const story = { title: "A story", body: "Do it.", acceptance_criteria: ["it works"] };

  it("is taken from a submitted plan's story, and carried onto the child it becomes, trimmed", () => {
    const parsed = RefineStorySchema.parse({ ...story, base_branch: " release/2.4 " });

    expect(parsed.base_branch).toBe(" release/2.4 ");
    expect(childrenFromStories([parsed])[0]?.baseBranch).toBe("release/2.4");
  });

  it("leaves a child with no base when the story named none, or named a blank one", () => {
    expect(childrenFromStories([RefineStorySchema.parse(story)])[0]).not.toHaveProperty("baseBranch");
    expect(childrenFromStories([RefineStorySchema.parse({ ...story, base_branch: "  " })])[0]).not.toHaveProperty("baseBranch");
  });

  it("is offered in a conversation's proposals and never in a decomposition", () => {
    expect(JSON.stringify(outputSchemaFor(registry, "assist"))).toContain("base_branch");
    expect(JSON.stringify(outputSchemaFor(registry, "refine"))).not.toContain("base_branch");
    expect(ProposedStorySchema.parse({ ...story, base_branch: "release/2.4" })).not.toHaveProperty("base_branch");
  });
});

/**
 * A story's existing branch (EO-365): offered where a base branch is,
 * and never to a decomposition.
 */
describe("a story's existing branch", () => {
  const story = { title: "A story", body: "Do it.", acceptance_criteria: ["it works"] };

  it("is carried from a submitted plan's story onto the child it becomes, trimmed", () => {
    expect(childrenFromStories([RefineStorySchema.parse({ ...story, existing_branch: " feature/limits " })])[0]?.existingBranch).toBe("feature/limits");
    expect(childrenFromStories([RefineStorySchema.parse({ ...story, existing_branch: " " })])[0]).not.toHaveProperty("existingBranch");
  });

  it("is offered in a conversation's proposals and never in a decomposition", () => {
    expect(JSON.stringify(outputSchemaFor(registry, "assist"))).toContain("existing_branch");
    expect(JSON.stringify(outputSchemaFor(registry, "refine"))).not.toContain("existing_branch");
    expect(ProposedStorySchema.parse({ ...story, existing_branch: "feature/limits" })).not.toHaveProperty("existing_branch");
  });
});
