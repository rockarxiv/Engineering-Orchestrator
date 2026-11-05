/**
 * An action definition's `fields`, as the list the agent screen edits
 * (EO-427).
 *
 * `fields` is a JSON Schema for an object, and a JSON Schema can say far
 * more than a form can ask. So the list is a *view* of the schema rather
 * than a second model of it: each property is one row, a row whose
 * schema is one of the four shapes below is edited in place, and every
 * other row is carried through exactly as it was written — named, marked
 * as editable in the JSON view only, and never rebuilt. The same holds
 * for whatever the schema says about its object besides `properties` and
 * `required`: it is not drawn, and it is not touched.
 *
 * That is the whole of the promise "a save made from the list leaves
 * what the list cannot express unchanged": `fieldsFromRows` writes
 * `properties` and `required` into the document it was read from and
 * nothing else, and a row nobody edited holds the very schema it was
 * read with.
 */

/** The four types the list offers. Anything else is JSON-only. */
export type FieldKind = "text" | "number" | "boolean" | "text_list";

export const FIELD_KINDS: readonly { kind: FieldKind; label: string }[] = [
  { kind: "text", label: "Text" },
  { kind: "number", label: "Number" },
  { kind: "boolean", label: "Yes / no" },
  { kind: "text_list", label: "List of text" },
];

export interface FieldRow {
  name: string;
  required: boolean;
  /** The property's schema, as written. What is saved for this row, whatever kind it is. */
  schema: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The schema the list writes for a kind.
 *
 * The spellings `fieldsFromList` in the core writes for a proposed
 * definition, so a field made here and one made by an agent's draft are
 * one document.
 */
function schemaOf(kind: FieldKind): Record<string, unknown> {
  if (kind === "text") return { type: "string" };
  if (kind === "text_list") return { type: "array", items: { type: "string" } };
  return { type: kind };
}

/**
 * Which of the four a property's schema is, or null where it is
 * something the list cannot express.
 *
 * Exact, apart from a `description`: that is the one thing a proposed
 * definition's field carries beside its type, it changes nothing about
 * what the answer may be, and a field with one is still a text field.
 * Any other keyword — an `enum`, a `minLength`, a `format` — narrows
 * what is accepted, so a row that drew it as plain "Text" would be
 * showing a looser field than the one saved.
 */
export function kindOf(schema: unknown): FieldKind | null {
  if (!isPlainObject(schema)) return null;
  const { description, ...rest } = schema;
  if (description !== undefined && typeof description !== "string") return null;
  const keys = Object.keys(rest);
  if (keys.length === 1 && rest["type"] === "string") return "text";
  if (keys.length === 1 && rest["type"] === "number") return "number";
  if (keys.length === 1 && rest["type"] === "boolean") return "boolean";
  if (keys.length === 2 && rest["type"] === "array") {
    const items = rest["items"];
    if (isPlainObject(items) && Object.keys(items).length === 1 && items["type"] === "string") return "text_list";
  }
  return null;
}

/** A row given another of the four types. Its description, if it has one, stays with it. */
export function withKind(row: FieldRow, kind: FieldKind): FieldRow {
  const description = isPlainObject(row.schema) && typeof row.schema["description"] === "string" ? { description: row.schema["description"] } : {};
  return { ...row, schema: { ...schemaOf(kind), ...description } };
}

/** A row as the list adds one: a text field nobody has named yet. */
export function blankRow(): FieldRow {
  return { name: "", required: false, schema: schemaOf("text") };
}

/**
 * The schema's properties as rows, or null where the document does not
 * hold them in a form a list can be read from.
 *
 * Null is "edit this in the JSON view", not "no fields": `properties`
 * that is not an object, or `required` that is not a list of names, is a
 * document the save will refuse, and a list drawn over it would write a
 * well-formed one in its place the moment a row was touched.
 */
export function rowsFromFields(fields: Record<string, unknown>): FieldRow[] | null {
  const properties = fields["properties"];
  const required = fields["required"];
  if (properties !== undefined && !isPlainObject(properties)) return null;
  if (required !== undefined && !(Array.isArray(required) && required.every((name) => typeof name === "string"))) return null;
  const names = new Set((required as string[] | undefined) ?? []);
  return Object.entries(properties ?? {}).map(([name, schema]) => ({ name, required: names.has(name), schema }));
}

/**
 * The rows written back into the document they were read from.
 *
 * `properties` and `required` are replaced where they stand and every
 * other key keeps its place and its value. `required` keeps the order it
 * had — a name already in it stays where it was, a newly required one
 * goes on the end — and keeps any name that matches no property, since
 * that is something only the JSON view said and only it may unsay.
 *
 * A document that had neither key and is given no rows comes back as it
 * was: `{}` stays `{}`. One that gains its first field also gains
 * `type: "object"`, which is how `fieldsFromList` writes it.
 */
export function fieldsFromRows(base: Record<string, unknown>, rows: readonly FieldRow[]): Record<string, unknown> {
  const before = rowsFromFields(base);
  // Not a document the list reads, so not one it writes.
  if (before === null) return base;

  // `Object.fromEntries` defines each name as an own property. Assigning
  // them would not: a property named `__proto__` — which JSON may carry
  // and a schema may name — would set the object's prototype instead,
  // and be gone from what is saved.
  const properties: Record<string, unknown> = Object.fromEntries(rows.map((row) => [row.name, row.schema]));

  const previousNames = new Set(before.map((row) => row.name));
  const previousRequired = (base["required"] as string[] | undefined) ?? [];
  const nowRequired = new Set(rows.filter((row) => row.required).map((row) => row.name));
  const kept = previousRequired.filter((name) => nowRequired.has(name) || !previousNames.has(name));
  const required = [...kept, ...[...nowRequired].filter((name) => !kept.includes(name))];

  const next: Record<string, unknown> = base["properties"] === undefined && base["type"] === undefined && rows.length > 0 ? { type: "object", ...base } : { ...base };
  if (base["properties"] !== undefined || rows.length > 0) next["properties"] = properties;
  if (base["required"] !== undefined || required.length > 0) next["required"] = required;
  return next;
}

/** What is wrong with the rows as a list, before the save is asked: a name left empty, or one used twice. */
export function rowProblems(rows: readonly FieldRow[]): string[] {
  const problems: string[] = [];
  if (rows.some((row) => row.name.trim() === "")) problems.push("Every field needs a name: it is the property the answer carries.");
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const row of rows) {
    if (row.name.trim() === "") continue;
    if (seen.has(row.name)) twice.add(row.name);
    seen.add(row.name);
  }
  for (const name of twice) problems.push(`The field "${name}" is listed more than once; each field is one property of the answer.`);
  return problems;
}

/** The fields as the JSON view shows them. */
export function fieldsToText(fields: Record<string, unknown>): string {
  return JSON.stringify(fields, null, 2);
}

/**
 * The JSON view's text as fields, or the parser's own sentence.
 *
 * Whether it is a JSON Schema EO can compile is not asked here: the
 * renderer may not run the compiler (its content security policy
 * forbids the code generation ajv compiles with), so that is the save's
 * to refuse, in the compiler's words.
 */
export function fieldsFromText(text: string): { ok: true; fields: Record<string, unknown> } | { ok: false; problem: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim() === "" ? "{}" : text);
  } catch (error) {
    return { ok: false, problem: error instanceof Error ? error.message : String(error) };
  }
  if (!isPlainObject(parsed)) return { ok: false, problem: "The fields must be a JSON object: a JSON Schema describing the answer's extra properties." };
  return { ok: true, fields: parsed };
}
