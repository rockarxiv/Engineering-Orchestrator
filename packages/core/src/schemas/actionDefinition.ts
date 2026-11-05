import { z } from "zod";
import type { JsonSchema } from "../agent-provider.js";
import { JSON_SCHEMA_DIALECT, jsonSchemaOutputSchema, type JsonSchemaDocument, type OutputSchema } from "./outputSchema.js";

/**
 * An action a role defines for itself, as data (EO-421).
 *
 * Until this existed an agent step's `entryAction` was a free string and
 * the shape its answer had to take was found by action name alone, across
 * every role. A custom action with no schema answered in prose, was read
 * as `done`, and parked on any step that routed on other keys. A custom
 * schema sat in one agent's `config.schemasByAction`, where nothing could
 * show it and nothing said which results it could return.
 *
 * A definition is the declared thing: keyed by **role and action**, it
 * holds what the action is for, the result keys it can return — each with
 * a label and the sentence saying when to return it — and any extra
 * properties the answer carries. EO generates the output schema from it
 * (`actionAnswerDocument`), so the keys a step routes on and the keys the
 * provider is constrained to are one list rather than two that agree.
 *
 * **It never applies to another role.** The lookup that preceded it was
 * by action across every role, which is right for a pack's shipped
 * actions — a custom role on an `implement` step is held to the
 * implement shape — and wrong for something a person wrote about one
 * role: two roles may both call an action `check` and mean different
 * things by it. So the role is half the key, and a role with no
 * definition of its own falls through to exactly the lookup it had
 * before.
 *
 * Pure, like everything in this package: the table and the one function
 * that writes to it are the desktop's (`actionDefinitionsRepo`), and
 * every write there goes through `readActionDefinitionDraft` here.
 */

/** What an action name and a result key may look like: what a route key is typed as, and nothing a prompt has to quote. */
export const ACTION_KEY_PATTERN = /^[a-z0-9_]+$/;

/**
 * The two answer properties every role-defined action has, and so the
 * two names a field may not take.
 *
 * `result` is what the run routes on and `summary` is what EO posts into
 * the thread. A field of either name would be a second definition of a
 * property the generated schema already wrote.
 */
export const RESERVED_ANSWER_FIELDS: readonly string[] = ["result", "summary"];

/** The single result a schema that declared none is given when it becomes a definition: what such a run was already read as. */
export const DEFAULT_RESULT_KEY = "done";

/**
 * The actions no pipeline step dispatches, and so the ones a role may
 * not define (EO-422).
 *
 * Each is run by EO for a purpose of its own — answering a mention,
 * reading a reply to a parked step, a turn of one of the conversation
 * rooms, the leaf half of `refine` — and EO consumes the
 * answer itself: it posts the reply, applies the reading, draws the
 * draft. A definition would replace the shape that code reads with one
 * it cannot, and there is no step whose routes its result keys could
 * name. So a save naming one is refused rather than written and never
 * used.
 *
 * Spelled here, as words, because this package is where the save's
 * rules are and half of these constants live in the desktop; the
 * desktop's test holds the two spellings together.
 */
export const UNDISPATCHED_ACTIONS: readonly string[] = ["respond", "interpret", "assist", "scenario", "clarify"];

/** Whether this is an action EO runs for itself rather than one a step dispatches. */
export function isUndispatchedAction(action: string): boolean {
  return UNDISPATCHED_ACTIONS.includes(action);
}

/**
 * What a save may be told about the installation it is saving into.
 *
 * The rules above are about the draft alone. One is not: whether the
 * role is a pack's own and the action one that pack ships for it, which
 * only whoever holds the registry can answer. Handed in as a question
 * rather than as a registry, so this file goes on knowing nothing about
 * one.
 */
export interface ActionDefinitionDraftContext {
  /** Whether an installed pack ships `action` for `role` — `roleShipsAction` against the registry in force. */
  shipsAction?: (role: string, action: string) => boolean;
}

export const ActionResultSchema = z.object({
  /** What the answer's `result` says and what a route's `resultKey` matches. */
  key: z.string(),
  /** What a person reads where the key would be shown. */
  label: z.string(),
  /** When to return it — the sentence the agent is given beside the key. */
  meaning: z.string(),
});

export type ActionResult = z.infer<typeof ActionResultSchema>;

export const ActionDefinitionSchema = z.object({
  id: z.string(),
  /** The role this is defined for, and the only one it applies to. */
  role: z.string(),
  action: z.string(),
  /** What the action is for, as the agent is told it. */
  description: z.string(),
  results: z.array(ActionResultSchema),
  /**
   * The extra properties of the answer, as a JSON Schema describing an
   * object: `properties`, and `required` for the ones that must arrive.
   * `{}` for an action that answers with `result` and `summary` alone.
   */
  fields: z.record(z.string(), z.unknown()),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export type ActionDefinition = z.infer<typeof ActionDefinitionSchema>;

/**
 * What a save is handed. No id: a definition is addressed by its role
 * and action, so a save of a pair that exists replaces it and a save of
 * one that does not creates it.
 */
export const ActionDefinitionDraftSchema = z.object({
  role: z.string(),
  action: z.string(),
  description: z.string().default(""),
  results: z.array(z.object({ key: z.string(), label: z.string().default(""), meaning: z.string().default("") })),
  fields: z.record(z.string(), z.unknown()).default({}),
});

export type ActionDefinitionDraft = z.input<typeof ActionDefinitionDraftSchema>;
/** A draft once parsed, every default filled in — what crosses the wire beside a graph being published (EO-426). */
export type ParsedActionDefinitionDraft = z.output<typeof ActionDefinitionDraftSchema>;

/** A draft that may be written, normalised, or the sentences saying why it may not. */
export type ActionDefinitionDraftResult =
  | { ok: true; role: string; action: string; description: string; results: ActionResult[]; fields: JsonSchema }
  | { ok: false; problems: string[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `gaps_found` as a person would write it: "Gaps found". */
function labelFromKey(key: string): string {
  const words = key.replace(/_+/g, " ").trim();
  return words === "" ? key : words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Everything wrong with a definition's `fields`, or nothing.
 *
 * `fields` is a JSON Schema for an object, because the generated answer
 * is one object and these are more of its properties. Its own `type`
 * may be left out; anything other than `object` is a schema for a value
 * the answer cannot be.
 */
function fieldProblems(fields: Record<string, unknown>): string[] {
  const problems: string[] = [];

  if (fields["type"] !== undefined && fields["type"] !== "object") problems.push('The fields must describe an object: "type" is either left out or "object".');

  const properties = fields["properties"];
  if (properties !== undefined && !isPlainObject(properties)) problems.push('The fields\' "properties" must be an object of field name to schema.');

  const required = fields["required"];
  const requiredNames = Array.isArray(required) && required.every((name) => typeof name === "string") ? (required as string[]) : null;
  if (required !== undefined && requiredNames === null) problems.push('The fields\' "required" must be a list of field names.');

  const named = new Set([...(isPlainObject(properties) ? Object.keys(properties) : []), ...(requiredNames ?? [])]);
  for (const reserved of RESERVED_ANSWER_FIELDS) {
    if (named.has(reserved)) problems.push(`A field may not be named "${reserved}": every answer already has one, and EO writes it.`);
  }

  // ajv decides what a valid JSON Schema is, as it does for a pack's
  // schema at import — a second opinion here would be a second
  // definition for a document to fall between.
  try {
    jsonSchemaOutputSchema(fields);
  } catch (error) {
    problems.push(`The fields are not a JSON Schema EO can read: ${error instanceof Error ? error.message : String(error)}`);
  }

  return problems;
}

/**
 * Checks a draft and normalises it, or says everything wrong with it.
 *
 * The one set of rules every write is held to — the repository's save
 * calls this and nothing else writes the table — so a definition that
 * reaches a dispatch is one whose schema can be generated and whose keys
 * a route can name.
 *
 * Every problem rather than the first, for the reason a result's
 * validation reports every issue: whoever is fixing it fixes it once.
 *
 * `context` carries the one rule that is about the installation rather
 * than the draft — see `ActionDefinitionDraftContext`. A caller that
 * leaves it out is checking the draft alone, which is what a pure test
 * of the shape wants and what no write may do.
 */
export function readActionDefinitionDraft(input: unknown, context: ActionDefinitionDraftContext = {}): ActionDefinitionDraftResult {
  const parsed = ActionDefinitionDraftSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, problems: parsed.error.issues.map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`) };
  }
  const draft = parsed.data;
  const problems: string[] = [];

  const role = draft.role.trim();
  if (role === "") problems.push("A definition needs the role it is defined for.");

  if (!ACTION_KEY_PATTERN.test(draft.action)) {
    problems.push(`The action "${draft.action}" must be lowercase letters, digits and underscores only.`);
  }

  // The two refusals that are about *which* action rather than about
  // what the draft says of it (EO-422). Both name what was refused, so
  // the sentence still reads where it is shown without the form beside
  // it — in an import's refusal, in the system agent's tool result.
  if (isUndispatchedAction(draft.action)) {
    problems.push(`The action "${draft.action}" cannot be defined: no pipeline step dispatches it, and EO reads its answer itself.`);
  } else if (role !== "" && context.shipsAction?.(role, draft.action) === true) {
    problems.push(`The ${role} role's "${draft.action}" action cannot be redefined: it ships with the role, and the pack that ships it decides its shape.`);
  }

  if (draft.results.length === 0) problems.push("An action needs at least one result: a run has to be able to say how it ended.");

  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const result of draft.results) {
    if (!ACTION_KEY_PATTERN.test(result.key)) problems.push(`The result key "${result.key}" must be lowercase letters, digits and underscores only.`);
    if (seen.has(result.key)) duplicated.add(result.key);
    seen.add(result.key);
  }
  for (const key of duplicated) problems.push(`The result key "${key}" is declared more than once; each key names one outcome.`);

  problems.push(...fieldProblems(draft.fields));

  if (problems.length > 0) return { ok: false, problems };

  return {
    ok: true,
    role,
    action: draft.action,
    description: draft.description.trim(),
    results: draft.results.map((result) => ({
      key: result.key,
      label: result.label.trim() === "" ? labelFromKey(result.key) : result.label.trim(),
      meaning: result.meaning.trim(),
    })),
    fields: draft.fields,
  };
}

/**
 * What an extra answer field of a proposed definition may be.
 *
 * A closed list, and the reason is invariant #12 rather than taste. A
 * saved definition's `fields` is a JSON Schema, which is a document of
 * no fixed shape; OpenAI's strict structured output — what a Codex
 * agent's answer is held to — cannot carry one, since every object in
 * it must list its properties. So a definition proposed *in an answer*
 * says its fields the way the agent screen's field list does: a name, a
 * type from this list, and whether it must arrive. Both backends can
 * write that, and `proposedActionDraft` turns it into the schema the
 * save takes.
 *
 * `string_list` is the one compound type, because "the gaps", "the
 * files", "the risks" is what an extra field most often is. Anything
 * richer is written where a JSON Schema can be — the agent screen, or
 * the `eo_admin` server's save.
 */
export const PROPOSED_FIELD_TYPES = ["string", "number", "integer", "boolean", "string_list"] as const;

export const ProposedActionFieldSchema = z.object({
  /** The property's name in the answer. */
  name: z.string(),
  type: z.enum(PROPOSED_FIELD_TYPES),
  /** Whether an answer without it is refused. */
  required: z.boolean().default(false),
  /** What the agent is told the field is for. */
  description: z.string().default(""),
});

export type ProposedActionField = z.infer<typeof ProposedActionFieldSchema>;

/** The shape of a proposed definition, before its rules are asked. */
const ProposedActionShape = z.object({
  role: z.string(),
  action: z.string(),
  description: z.string().default(""),
  results: z.array(z.object({ key: z.string(), label: z.string().default(""), meaning: z.string().default("") })),
  fields: z.array(ProposedActionFieldSchema).default([]),
});

/**
 * A proposed definition's field list as the JSON Schema a definition
 * holds: `{}` for none, otherwise an object's `properties` and the
 * `required` among them.
 */
export function fieldsFromList(fields: readonly ProposedActionField[]): JsonSchema {
  if (fields.length === 0) return {};
  const properties: Record<string, unknown> = {};
  for (const field of fields) {
    const described = field.description.trim() === "" ? {} : { description: field.description.trim() };
    properties[field.name] = field.type === "string_list" ? { type: "array", items: { type: "string" }, ...described } : { type: field.type, ...described };
  }
  const required = fields.filter((field) => field.required).map((field) => field.name);
  return { type: "object", properties, ...(required.length > 0 ? { required } : {}) };
}

/** A proposed definition as the save's own input — the one conversion between what an answer can say and what is written. */
export function proposedActionDraft(proposed: z.infer<typeof ProposedActionShape>): ParsedActionDefinitionDraft {
  return { role: proposed.role, action: proposed.action, description: proposed.description, results: proposed.results, fields: fieldsFromList(proposed.fields) };
}

/**
 * A definition a pipeline draft carries with it (EO-426).
 *
 * A pipeline that needs a new action used to arrive as a draft plus a
 * side write: the graph on a card, and the definition its steps route on
 * saved through a tool before anybody had read either. This is the
 * definition on the card instead, and what a person publishes is written
 * through the one function every definition is written through, in the
 * transaction that writes the graph.
 *
 * The save's input, but for `fields`, which is a list here — see
 * `PROPOSED_FIELD_TYPES`.
 *
 * **Held to the save's rules here, in the schema**, because that is
 * where a refusal reaches the agent: a result that fails its schema is
 * sent straight back with the message, and the next attempt can fix the
 * key. Every rule that is about the draft alone is asked — the one that
 * is about the installation (a pack's own role redefining its own
 * action) needs a registry this package does not hold, and is asked by
 * the supervisor where it validates the same result, so that refusal
 * reaches the agent by the same road.
 */
export const ProposedActionSchema = ProposedActionShape.superRefine((proposed, context) => {
  const names = new Set<string>();
  for (const field of proposed.fields) {
    if (field.name.trim() === "") context.addIssue({ code: "custom", path: ["fields"], message: "A field needs a name: it is the property the answer carries." });
    else if (names.has(field.name)) context.addIssue({ code: "custom", path: ["fields"], message: `The field "${field.name}" is listed more than once; each field is one property of the answer.` });
    names.add(field.name);
  }

  const read = readActionDefinitionDraft(proposedActionDraft(proposed));
  if (read.ok) return;
  for (const problem of read.problems) context.addIssue({ code: "custom", message: problem });
});

/**
 * The definitions one draft proposes: each a role and an action, said
 * once. Two entries for one pair would be two answers to "what may this
 * step return", and which of them a publish wrote would be a matter of
 * order.
 */
export const ProposedActionsSchema = z.array(ProposedActionSchema).superRefine((actions, context) => {
  const seen = new Set<string>();
  actions.forEach((entry, index) => {
    const pair = `${entry.role.trim()} ${entry.action}`;
    if (seen.has(pair)) {
      context.addIssue({
        code: "custom",
        path: [index],
        message: `The ${entry.role.trim()} role's "${entry.action}" action is proposed more than once; a draft defines each role's action once.`,
      });
    }
    seen.add(pair);
  });
});

export type ProposedAction = z.infer<typeof ProposedActionSchema>;

/**
 * What a proposed definition does to the one the role already has
 * (EO-426) — the part of a draft card that says "this changes something
 * you already rely on".
 *
 * `new` where the role defines no such action. Otherwise the result keys
 * the proposal adds and the ones it removes, which is what a person
 * weighs: a removed key is a route somewhere that stops firing, an added
 * one is a route every step using the action now has to draw. `same`
 * says the proposal is word for word what is saved, so publishing it
 * changes nothing; a proposal that only rewords a label or changes a
 * field is a change with no keys in either list.
 */
export type ProposedActionChange = { kind: "new" } | { kind: "same" } | { kind: "changed"; added: string[]; removed: string[] };

export function proposedActionChange(
  existing: Pick<ActionDefinition, "description" | "results" | "fields"> | undefined,
  proposed: Pick<ActionDefinition, "description" | "results" | "fields">,
): ProposedActionChange {
  if (existing === undefined) return { kind: "new" };
  const before = new Set(existing.results.map((result) => result.key));
  const after = new Set(proposed.results.map((result) => result.key));
  const added = [...after].filter((key) => !before.has(key));
  const removed = [...before].filter((key) => !after.has(key));
  const same =
    added.length === 0 &&
    removed.length === 0 &&
    existing.description === proposed.description &&
    JSON.stringify(existing.results) === JSON.stringify(proposed.results) &&
    JSON.stringify(existing.fields) === JSON.stringify(proposed.fields);
  return same ? { kind: "same" } : { kind: "changed", added, removed };
}

/**
 * The JSON Schema an answer to a role-defined action is held to.
 *
 * `result` as an enum of the declared keys, a required `summary`, then
 * the fields — in that order, because a provider's constrained
 * generation writes properties in the order the schema lists them and
 * the verdict is what the rest of the answer explains.
 *
 * Whatever else `fields` says about its object — `additionalProperties`,
 * `$defs` its properties refer to, the dialect it declares — is carried
 * over untouched, so a field that was valid on its own goes on meaning
 * what it meant.
 */
export function actionAnswerDocument(definition: Pick<ActionDefinition, "results" | "fields">): JsonSchema {
  const { $schema: dialect, properties, required, ...rest } = definition.fields;
  const fieldProperties = isPlainObject(properties) ? properties : {};
  const fieldRequired = Array.isArray(required) ? required.filter((name): name is string => typeof name === "string") : [];

  return {
    $schema: typeof dialect === "string" ? dialect : JSON_SCHEMA_DIALECT,
    properties: {
      result: { type: "string", enum: definition.results.map((result) => result.key) },
      summary: { type: "string" },
      ...fieldProperties,
    },
    required: ["result", "summary", ...fieldRequired.filter((name) => !RESERVED_ANSWER_FIELDS.includes(name))],
    ...rest,
    // Last, so that it is what the document says whatever `fields` said
    // of its own type — the save holds that to `object` or to nothing.
    type: "object",
  };
}

/**
 * The generated schema behind the interface every other schema sits
 * behind, so validation, the re-prompt wording and the provider wrapper
 * are the same code for a role-defined action as for a pack's.
 *
 * Throws where the document does not compile, as `jsonSchemaOutputSchema`
 * does. A definition written through the save cannot reach that; one in
 * a hand-edited database can, and its reader decides what that costs.
 */
export function actionDefinitionOutputSchema(definition: Pick<ActionDefinition, "results" | "fields">): OutputSchema {
  return jsonSchemaOutputSchema(actionAnswerDocument(definition));
}

/**
 * What a carried output schema says, as the two halves of a definition
 * (EO-421).
 *
 * How `agents.config.schemasByAction` — a JSON Schema per action, with
 * no word about results — becomes a definition, at migration and for a
 * pipeline file that still carries one. A top-level string `result` enum
 * is the result keys, since that is the property a run was already
 * routed on; a schema with none gets `done`, which is what such a run
 * was already read as. Every other top-level property is a field.
 *
 * `summary` is left out of the fields along with `result`: both are the
 * generated schema's own, and a definition whose fields named either is
 * one the save refuses.
 *
 * A document that does not describe an object — a boolean, a schema for
 * a string — has no properties to carry, and answers with no fields
 * rather than with a shape the answer could not take.
 */
export function actionShapeFromSchema(document: JsonSchemaDocument): { results: ActionResult[]; fields: JsonSchema } {
  const fallback = [{ key: DEFAULT_RESULT_KEY, label: labelFromKey(DEFAULT_RESULT_KEY), meaning: "" }];
  if (!isPlainObject(document) || (document["type"] !== undefined && document["type"] !== "object")) return { results: fallback, fields: {} };

  const properties = isPlainObject(document["properties"]) ? document["properties"] : {};
  const declared = properties["result"];
  const keys =
    isPlainObject(declared) &&
    (declared["type"] === undefined || declared["type"] === "string") &&
    Array.isArray(declared["enum"]) &&
    declared["enum"].length > 0 &&
    declared["enum"].every((key) => typeof key === "string")
      ? [...new Set(declared["enum"] as string[])]
      : null;

  const fields: JsonSchema = { ...document };
  if (isPlainObject(document["properties"])) {
    fields["properties"] = Object.fromEntries(Object.entries(properties).filter(([name]) => !RESERVED_ANSWER_FIELDS.includes(name)));
  }
  if (Array.isArray(document["required"])) {
    fields["required"] = document["required"].filter((name) => typeof name !== "string" || !RESERVED_ANSWER_FIELDS.includes(name));
  }

  return {
    results: keys === null ? fallback : keys.map((key) => ({ key, label: labelFromKey(key), meaning: "" })),
    fields,
  };
}

/**
 * What the task section says about a role-defined action: what it is
 * for, and each result key with when to return it.
 *
 * The schema constrains what the agent *can* answer; this is what tells
 * it which of those answers is true. Written in plain words with no tool
 * name and no backend's punctuation in it, so it reads the same on
 * either (invariant 12).
 */
export function renderActionDefinitionTask(definition: Pick<ActionDefinition, "action" | "description" | "results">): string {
  const lines: string[] = [];
  if (definition.description !== "") lines.push(definition.description, "");
  lines.push(
    `Answer the "${definition.action}" action with \`result\` set to exactly one of these keys, and \`summary\` saying what you did and what you found — it is posted to the thread as your comment:`,
  );
  for (const result of definition.results) {
    lines.push(result.meaning === "" ? `- \`${result.key}\` — ${result.label}` : `- \`${result.key}\` — ${result.meaning}`);
  }
  return lines.join("\n");
}

/** The answer's `summary`, when it has one worth posting. */
export function actionAnswerSummary(answer: unknown): string | null {
  if (!isPlainObject(answer)) return null;
  const summary = answer["summary"];
  return typeof summary === "string" && summary.trim() !== "" ? summary : null;
}

/**
 * What an import says about the definitions it did not write (EO-424).
 *
 * A file's definition never replaces one the installation already has
 * for the same role and action, so where the two differ the pipeline
 * that just arrived runs on the installed one — which may return keys
 * its steps do not route. One sentence, naming each pair, in the one
 * place every surface that reports an import reads it from; empty where
 * nothing was kept, so a caller appends it without asking.
 */
export function keptDefinitionsNote(kept: readonly { role: string; action: string }[]): string {
  if (kept.length === 0) return "";
  const named = kept.map(({ role, action }) => `${role}'s "${action}"`).join(", ");
  return kept.length === 1
    ? `This installation already defines ${named} differently; its own definition was kept and the file's was not applied.`
    : `This installation already defines these actions differently: ${named}. Its own definitions were kept and the file's were not applied.`;
}
