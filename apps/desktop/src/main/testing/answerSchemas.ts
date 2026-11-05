import type { Registry } from "@eo/core";

/**
 * What each backend will take as an answer schema, and one answer that
 * uses the part of a schema the two disagree about (EO-387).
 *
 * v0.7.0 shipped with every `assist` turn on Codex refused before the
 * model ran — `invalid_json_schema`, three attempts in a row — because
 * the answer schema had gained two maps and OpenAI's strict structured
 * output cannot express one. The test that should have said so walked a
 * hand-written list of six actions that left out the two with maps, and
 * asked three questions of each, none of which was "is there a keyword
 * here the backend refuses".
 *
 * So both halves are here once, for `codex.test.ts` and
 * `providerParity.test.ts` to share: every action the registry has an
 * answer for, read off the registry; and the subset as an *allowlist*, so
 * a keyword nobody has decided about fails rather than passes.
 *
 * Only tests import this module; see `testing/git.ts` for why that is
 * safe and `testing.test.ts` for what holds it.
 */

/**
 * Every action some role in the registry declares an answer schema for.
 *
 * Read off the registry rather than listed, which is the point: an
 * action added tomorrow is walked tomorrow, by a test nobody edited.
 * The names a type's override points at (`clarify`, for a leaf's
 * `refine`) are declared the same way, so they are here too.
 */
export function answerActions(registry: Registry): string[] {
  return [...new Set([...registry.roles.values()].flatMap((role) => [...role.schemasByAction.keys()]))].sort();
}

/**
 * The keywords OpenAI's strict structured output takes.
 *
 * The documented subset, plus `minLength` and `maxLength`: the
 * documentation does not list them, and every action EO has dispatched
 * on Codex since A-04 has carried `minLength` and been accepted, so they
 * are here on that evidence rather than on the page's.
 *
 * Anything else is refused by this list whether or not the API would
 * refuse it — `propertyNames` is, and so is whatever `z.toJSONSchema`
 * emits for the next zod type somebody reaches for. Adding a keyword
 * here is a claim that the API takes it; check it against the live test
 * (`codexAnswerSchema.live.test.ts`) before making it.
 */
const OPENAI_STRICT_KEYWORDS: ReadonlySet<string> = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "anyOf",
  "enum",
  "const",
  "$ref",
  "$defs",
  "description",
  "title",
  "pattern",
  "format",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minItems",
  "maxItems",
]);

/** Keywords that are enough, alone, for a node to say what it accepts. */
const SAYS_WHAT_IT_IS = ["type", "anyOf", "$ref", "const", "enum"] as const;

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Everything in a schema that OpenAI's strict structured output would
 * refuse, as `path: what is wrong`. Empty means sendable.
 *
 * Four rules, each one the API's own:
 *
 * - the root is an object, not a union;
 * - no keyword outside the subset;
 * - every object lists its properties, requires every one of them and
 *   allows no others — which is what leaves no room for a map;
 * - every node says what it is. An empty schema, zod's `unknown`, is an
 *   answer the model cannot be constrained to.
 */
export function openAiStrictViolations(schema: unknown): string[] {
  const violations: string[] = [];
  const visit = (node: unknown, path: string): void => {
    if (!isObject(node)) {
      violations.push(`${path}: not a schema`);
      return;
    }
    for (const key of Object.keys(node)) if (!OPENAI_STRICT_KEYWORDS.has(key)) violations.push(`${path}: the keyword \`${key}\``);
    if (!SAYS_WHAT_IT_IS.some((key) => key in node)) violations.push(`${path}: says nothing about what it accepts`);

    const types = Array.isArray(node["type"]) ? node["type"] : [node["type"]];
    if (types.includes("object")) {
      const properties = node["properties"];
      if (!isObject(properties)) violations.push(`${path}: an object without a fixed list of properties`);
      if (node["additionalProperties"] !== false) violations.push(`${path}: an object that does not set \`additionalProperties: false\``);
      if (isObject(properties) && JSON.stringify(node["required"]) !== JSON.stringify(Object.keys(properties))) violations.push(`${path}: an object that does not require every property`);
    }
    for (const table of ["properties", "$defs"] as const) {
      const entries = node[table];
      if (isObject(entries)) for (const [name, child] of Object.entries(entries)) visit(child, `${path}.${table}.${name}`);
    }
    if ("items" in node) visit(node["items"], `${path}.items`);
    const branches = node["anyOf"];
    if (Array.isArray(branches)) branches.forEach((branch, index) => visit(branch, `${path}.anyOf[${index}]`));
  };
  if (isObject(schema) && schema["type"] !== "object") violations.push("$: the root is not an object");
  visit(schema, "$");
  return violations;
}

/**
 * Everything in a schema the Claude CLI would refuse. Empty means
 * sendable.
 *
 * Two rules, both learned from a 400 in production rather than read
 * anywhere: the root is an object and not a union (`providerSchemaFor`
 * wraps the answer in `outcome` for this), and it declares no dialect,
 * which the CLI's validator tries to resolve (`stripSchemaDialect`).
 * Past those the SDK validates against the document as written, so a
 * map is a map and needs nothing done to it.
 */
export function claudeViolations(schema: unknown): string[] {
  if (!isObject(schema)) return ["$: not a schema"];
  const violations: string[] = [];
  if (schema["type"] !== "object") violations.push("$: the root is not an object");
  for (const union of ["anyOf", "oneOf", "allOf"]) if (union in schema) violations.push(`$: a root \`${union}\``);
  if ("$schema" in schema) violations.push("$: declares a dialect");
  return violations;
}

const DRAFT_ROUTE = { fromStepId: "merge", resultKey: "merged", label: "Merged", tone: "success", target: "done", position: 0 };
const DONE_STEP = { id: "done", position: 1, name: "Done", type: "user", ownerRole: null, entryAction: null, instructionsSummary: null, isTerminal: true, planMode: false };
const MERGE_STEP = { id: "merge", position: 0, name: "Merge", type: "module", ownerRole: null, entryAction: null, instructionsSummary: null, isTerminal: false, planMode: false };

const MODULE = {
  name: "Wait for CI",
  slug: "wait-for-ci",
  description: "Waits for the branch's checks to finish.",
  code: "export default async () => ({ ok: true, result: 'merged' });",
  why: "It would have been a script.",
  tests: [{ description: "merges once the checks pass", source: "export default async function (h) { await h.run(); }" }],
};
const MANIFEST = { name: "Wait for CI", description: "Waits for the branch's checks to finish.", results: ["merged"] };

/**
 * One `assist` answer that sets both of the schema's maps, as each
 * backend's agent writes it.
 *
 * `claude` is the shared schema's own shape: a new step's `inputs` and a
 * proposed module's manifest `inputs` are objects keyed by name, and an
 * optional field with nothing to say is left out.
 *
 * Both also carry one proposed action definition (EO-426), whose extra
 * answer fields are a typed list on either backend — and the settings a
 * draft may tune on a step, a route's "Needs a reason", and the
 * pipeline's name, icon and restored version (EO-520), each of which
 * must read back the same from both.
 *
 * `codex` is the same answer under the strict schema: each map a list of
 * `{ name, value }` entries, and every optional field present, as `null`
 * where the other leaves it out. The two must validate to one document.
 */
export const ASSIST_ANSWER_WITH_MAPS = {
  claude: {
    outcome: {
      message: "Here is a merge step that waits for CI.",
      draft: {
        name: "Release",
        rationale: "Merging waits for the checks.",
        entryStepId: "merge",
        steps: [
          {
            ...MERGE_STEP,
            timeoutMs: 3_480_000,
            inputs: { ciWaitSeconds: 2400, branch: "main", squash: true },
            watch: "off",
            workspaceId: "none",
            workspaceMode: "read",
          },
          { ...DONE_STEP, timeoutMs: "default" },
        ],
        routes: [{ ...DRAFT_ROUTE, requiresComment: true }],
        icon: "workflow",
        restoredFrom: 3,
        entryRules: [{ kind: "field", field: "customer", types: ["developer:story"], message: "the customer's name" }, { kind: "description" }],
        // Which step is a template's under a fresh id (EO-534): a map.
        templateStepIds: { release_merge: "merge" },
      },
      modules: [
        {
          ...MODULE,
          manifest: {
            ...MANIFEST,
            inputs: {
              ciWaitSeconds: { type: "number", description: "How long to wait for the checks.", default: 1800 },
              branch: { type: "string", default: "main" },
            },
          },
        },
      ],
      // A definition the draft brings with it (EO-426), with the keys an
      // agent may leave out left out.
      actions: [
        {
          role: "qa",
          action: "alignment",
          results: [{ key: "aligned" }, { key: "gaps_found", label: "Gaps found", meaning: "Something asked for is missing." }],
          fields: [{ name: "gaps", type: "string_list" }],
        },
      ],
    },
  },
  codex: {
    outcome: {
      message: "Here is a merge step that waits for CI.",
      questions: null,
      draft: {
        name: "Release",
        rationale: "Merging waits for the checks.",
        entryStepId: "merge",
        removes: null,
        target: null,
        steps: [
          {
            ...MERGE_STEP,
            timeoutMs: 3_480_000,
            inputs: [
              { name: "ciWaitSeconds", value: 2400 },
              { name: "branch", value: "main" },
              { name: "squash", value: true },
            ],
            // The words that stand for what `null` would mean (EO-520),
            // since a Codex agent's `null` is read as "left out".
            watch: "off",
            workspaceId: "none",
            workspaceMode: "read",
          },
          { ...DONE_STEP, timeoutMs: "default", inputs: null, watch: null, workspaceId: null, workspaceMode: null },
        ],
        routes: [{ ...DRAFT_ROUTE, requiresComment: true }],
        icon: "workflow",
        restoredFrom: 3,
        entryRules: [{ kind: "field", field: "customer", types: ["developer:story"], message: "the customer's name" }, { kind: "description", field: null, types: null, message: null }],
        templateStepIds: [{ name: "release_merge", value: "merge" }],
      },
      modules: [
        {
          ...MODULE,
          originalScript: null,
          manifest: {
            ...MANIFEST,
            needs: null,
            sideEffects: null,
            // Optional in the manifest (EO-456), so required-and-nullable for Codex.
            watch: null,
            inputs: [
              { name: "ciWaitSeconds", value: { type: "number", description: "How long to wait for the checks.", default: 1800 } },
              { name: "branch", value: { type: "string", description: null, default: "main" } },
            ],
          },
        },
      ],
      // The same definition under the strict schema: every key written,
      // `null` where the other backend's agent says nothing. Its fields are
      // a list on both, which is why they are one (invariant #12).
      actions: [
        {
          role: "qa",
          action: "alignment",
          description: null,
          results: [
            { key: "aligned", label: null, meaning: null },
            { key: "gaps_found", label: "Gaps found", meaning: "Something asked for is missing." },
          ],
          fields: [{ name: "gaps", type: "string_list", required: null, description: null }],
        },
      ],
      proposals: null,
      // No change to a module that exists (EO-418): nullable in the shared
      // schema, so a Codex agent writes the null a Claude agent leaves out.
      change: null,
      // Nor a card (EO-521), for the same reason.
      card: null,
      // Nor other drafts beside this one (EO-534): optional in the shared
      // schema, so required-and-nullable for Codex.
      alternatives: null,
      // Nor a trial plan (EO-587): this draft is a publish card.
      trial: null,
    },
  },
} as const;

/**
 * One card of each kind an `assist` answer may offer (EO-521, EO-522,
 * EO-523) — export, import, delete, discard edits, webhook items sent on
 * unread, a step's own secret and variable, and adding, changing and
 * removing an item type — as each backend's agent writes it.
 *
 * `claude` leaves out every field it has nothing to say in. `codex` is
 * the same answers under the strict schema, every field present and
 * `null` where it has nothing to say; the card itself has no optional
 * field, so it is written identically on both. Each pair must validate to
 * one document, card and all.
 */
const CARDS = [
  { kind: "pipelineExport", pipelineId: "release" },
  { kind: "pipelineImport", attachmentId: "019a0000-0000-7000-8000-000000000521" },
  { kind: "pipelineDelete", pipelineId: "release" },
  { kind: "pipelineDiscardEdits", pipelineId: "release" },
  // The settings that are a person's (EO-522). A step card names the step
  // and the variable and never a value: there is no field for one.
  { kind: "pipelineWebhookUnattended", pipelineId: "release", unattended: true },
  { kind: "stepSecret", stepId: "release-deploy", name: "DEPLOY_TOKEN", action: "set" },
  { kind: "stepVariable", stepId: "release-deploy", name: "REGION", action: "clear" },
  // A project's item types (EO-523). A change says null for what it
  // leaves as it is — written the same way by both backends.
  {
    kind: "itemTypeCreate",
    projectId: "payments",
    label: "Case",
    plural: "Cases",
    container: false,
    fields: [{ name: "customer", kind: "string", required: true }],
  },
  { kind: "itemTypeUpdate", itemTypeId: "case", label: "Request", plural: "Requests", container: null, fields: null },
  { kind: "itemTypeDelete", itemTypeId: "case" },
  // Keeping one's own pipeline and skipping a held template update (EO-534).
  { kind: "pipelineKeepMine", pipelineId: "release" },
  // The publish card after a draft's trials (EO-588): it names nothing.
  { kind: "trialPublish" },
] as const;

export const ASSIST_ANSWERS_WITH_CARDS = {
  claude: CARDS.map((card) => ({ outcome: { message: "That is yours to press: the card below does it.", card } })),
  codex: CARDS.map((card) => ({
    outcome: {
      message: "That is yours to press: the card below does it.",
      questions: null,
      draft: null,
      modules: null,
      actions: null,
      proposals: null,
      change: null,
      card,
      alternatives: null,
      trial: null,
    },
  })),
} as const;

/** The draft a trial plan is beside, as both backends write it: a module step that merges, then where work ends. */
const TRIAL_DRAFT = { name: "Release", rationale: "Merging waits for the checks.", entryStepId: "merge", steps: [MERGE_STEP, DONE_STEP], routes: [DRAFT_ROUTE] };

/**
 * One `assist` answer planning a test with real runs (EO-587): a draft
 * and its trial plan — two test items, one with the person's criteria and
 * one with none, and the merge step mocked with a reason and a result for
 * each — as each backend's agent writes it.
 *
 * `claude` leaves out every field it has nothing to say in. `codex` is
 * the same answer under the strict schema: every key present, `null`
 * where the other leaves it out. The two must validate to one plan.
 */
export const ASSIST_ANSWER_WITH_TRIAL = {
  claude: {
    outcome: {
      message: "Here is the design, with how it will be tested.",
      draft: TRIAL_DRAFT,
      trial: {
        items: [
          { key: "green", title: "Merge a green branch", expected: { stepId: "done", criteria: "the branch is on main" } },
          { key: "red", title: "Merge a red branch", body: "Its checks fail.", type: "story", expected: { stepId: "done" } },
        ],
        steps: [
          {
            stepId: "merge",
            mode: "mocked",
            reason: "It merges into main, which reaches outside EO.",
            mocks: [
              { item: "green", resultKey: "merged", output: "Merged." },
              { item: "red", resultKey: "merged", output: "Merged anyway." },
            ],
          },
        ],
      },
    },
  },
  codex: {
    outcome: {
      message: "Here is the design, with how it will be tested.",
      questions: null,
      draft: {
        ...TRIAL_DRAFT,
        removes: null,
        target: null,
        icon: null,
        restoredFrom: null,
        entryRules: null,
        templateStepIds: null,
        steps: [MERGE_STEP, DONE_STEP].map((step) => ({ ...step, timeoutMs: null, inputs: null, watch: null, workspaceId: null, workspaceMode: null })),
        routes: [{ ...DRAFT_ROUTE, requiresComment: null }],
      },
      modules: null,
      actions: null,
      proposals: null,
      change: null,
      card: null,
      alternatives: null,
      trial: {
        items: [
          { key: "green", title: "Merge a green branch", body: null, type: null, workspaceId: null, expected: { stepId: "done", criteria: "the branch is on main" } },
          { key: "red", title: "Merge a red branch", body: "Its checks fail.", type: "story", workspaceId: null, expected: { stepId: "done", criteria: null } },
        ],
        steps: [
          {
            stepId: "merge",
            mode: "mocked",
            reason: "It merges into main, which reaches outside EO.",
            mocks: [
              { item: "green", resultKey: "merged", output: "Merged." },
              { item: "red", resultKey: "merged", output: "Merged anyway." },
            ],
          },
        ],
      },
    },
  },
} as const;
