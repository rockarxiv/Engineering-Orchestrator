import { z } from "zod";
import { LEGACY_BOUNDARY_NAMES } from "./legacyNames.js";
import type { JsonSchemaObject } from "./toolSchema.js";

/**
 * Field selection, filtering, sorting and paging for every read tool
 * (EO-538).
 *
 * Built once, here, and applied by `callTool` to a read tool's answer
 * after it has been dispatched and translated to the spelling clients
 * read — so every read tool has it, present or added later, and none of
 * them carries a line of its own for it. Nothing in this module reaches
 * EO: it is handed a value and hands one back. A tool still answers
 * through its IPC handler under the same contract, and what this does is
 * cut that answer down to what the caller asked for.
 *
 * Paths are dot paths into the answer as a client reads it, so
 * `tickets.key` on `tickets_list`. EO's own words are taken as well —
 * `items.key` means the same — because the `item_*` twins advertise
 * them and a caller reading those should not have to know the answer
 * still arrives in the old vocabulary (legacyNames.ts).
 */

/** The five parameters, in the order they are advertised. */
export const NARROWING_KEYS = ["fields", "where", "sort", "limit", "offset"] as const;
export type NarrowingKey = (typeof NARROWING_KEYS)[number];

/** The largest page one call can ask for. */
export const MAX_LIMIT = 1000;

/**
 * How many characters a read answer may run to before EO cuts it to a
 * page — the rendered text and the structured copy together, since both
 * go on the wire on every call.
 */
export const ANSWER_BUDGET = 40_000;

export const WHERE_OPERATORS = ["eq", "ne", "in", "contains", "gt", "gte", "lt", "lte", "exists"] as const;
export type WhereOperator = (typeof WHERE_OPERATORS)[number];

const OPERATOR_LIST = "eq, ne, in, contains, gt, gte, lt, lte or exists";

const PathSchema = z.string().min(1, "A path cannot be empty: name a field, such as `key` or `stepName`.");

const ConditionSchema = z
  .object({
    path: PathSchema.describe("Where in one list element to look, as a dot path such as `stepName` or `parentKey`."),
    op: z
      .enum(WHERE_OPERATORS, {
        error: (issue) =>
          `${JSON.stringify(issue.input)} is not an operator EO knows. Use one of ${OPERATOR_LIST}.`,
      })
      .describe(
        "eq and ne compare exactly; in takes an array and matches any of it; contains is a case-insensitive substring on " +
          "text and membership on an array; gt, gte, lt and lte order numbers and text (ISO dates order as text); exists " +
          "matches a value that is present and not null, or with value false one that is absent or null.",
      ),
    value: z
      .unknown()
      .optional()
      .describe("What to compare with: any JSON value. An array for in; true or false for exists, which defaults to true."),
  })
  .strict()
  .superRefine((condition, ctx) => {
    const { op, value } = condition;
    const at = { path: ["value"] };
    if (op === "exists") {
      if (value !== undefined && typeof value !== "boolean") ctx.addIssue({ code: "custom", ...at, message: "exists takes true or false, or no value at all for true." });
      return;
    }
    if (value === undefined) {
      ctx.addIssue({ code: "custom", ...at, message: `${op} needs a value to compare with.` });
      return;
    }
    if (op === "in" && !Array.isArray(value)) ctx.addIssue({ code: "custom", ...at, message: "in takes an array of the values to match." });
    if ((op === "gt" || op === "gte" || op === "lt" || op === "lte") && typeof value !== "number" && typeof value !== "string") {
      ctx.addIssue({ code: "custom", ...at, message: `${op} compares numbers or text, so its value must be a number or a string.` });
    }
  });

export type Condition = z.output<typeof ConditionSchema>;

/**
 * The parameters, as a schema: what is parsed, and — through
 * `z.toJSONSchema` — what is advertised. One source for both, so the
 * description a client reads cannot drift from what EO accepts.
 */
const NarrowingSchema = z.object({
  fields: z
    .array(PathSchema)
    .min(1, "fields needs at least one path; omit it to keep everything.")
    .optional()
    .describe(
      "Keep only these dot paths in the answer, through lists — such as [\"tickets.key\", \"tickets.stepName\"]. A path that " +
        "matches nothing is named in the summary rather than refused.",
    ),
  where: z
    .array(ConditionSchema)
    .optional()
    .describe("Keep only the list's elements matching every one of these conditions. Paths are relative to one element."),
  sort: z
    .object({
      path: PathSchema.describe("The field to order by, relative to one list element."),
      direction: z.enum(["asc", "desc"], { error: "direction is asc or desc." }).default("asc"),
    })
    .strict()
    .optional()
    .describe("Order the list by one field. Elements without it come last either way."),
  limit: z
    .number()
    .int("limit is a whole number.")
    .min(0, "limit cannot be negative.")
    .max(MAX_LIMIT, `limit is at most ${MAX_LIMIT.toLocaleString("en-US")}; page with offset for more.`)
    .optional()
    .describe(`At most this many of the list's elements, up to ${MAX_LIMIT.toLocaleString("en-US")}.`),
  offset: z
    .number()
    .int("offset is a whole number.")
    .min(0, "offset cannot be negative.")
    .optional()
    .describe("Skip this many of the list's elements first. The answer's nextOffset is the value to send for the next page."),
});

export type Narrowing = Partial<z.output<typeof NarrowingSchema>>;

/** Which of the five a tool takes: `fields` always, the rest only with a main list. */
export function narrowingKeysFor(list: string | undefined): readonly NarrowingKey[] {
  return list === undefined ? ["fields"] : NARROWING_KEYS;
}

/** What each parameter is advertised as, on every read tool alike. */
export const NARROWING_PROPERTIES: Readonly<Record<NarrowingKey, JsonSchemaObject>> = (() => {
  const json = z.toJSONSchema(NarrowingSchema, { io: "input" }) as { properties: Record<NarrowingKey, JsonSchemaObject> };
  return json.properties;
})();

/**
 * A tool's input schema with the narrowing parameters added.
 *
 * The host's meaning of each name is the only one: a read tool must not
 * declare a parameter of its own under any of them, because the host
 * takes the five off a call before the tool sees it. `run_events` once
 * had its own `limit`, the channel's page size, and paging it twice —
 * once by the channel, then again by the host — answered empty pages
 * (EO-538). narrowing.test.ts holds every read tool to this: it checks
 * each one advertises the host's own description of all five.
 */
export function withNarrowingProperties(schema: JsonSchemaObject, list: string | undefined): JsonSchemaObject {
  const properties = (schema["properties"] ?? {}) as Record<string, unknown>;
  const added: Record<string, unknown> = {};
  // A key the tool already declares is left as the tool wrote it, so the
  // collision shows in what is advertised, where narrowing.test.ts sees it.
  for (const key of narrowingKeysFor(list)) if (!Object.hasOwn(properties, key)) added[key] = NARROWING_PROPERTIES[key];
  return { ...schema, properties: { ...properties, ...added } };
}

export type SplitArguments =
  | { ok: true; narrowing: Narrowing | null; rest: unknown }
  | { ok: false; issues: string[] };

/**
 * The narrowing parameters taken off a call, and the rest left for the
 * tool.
 *
 * `narrowing` is null when the call named none of them, which is what
 * decides between a narrowed answer and the tool's own — and, for an
 * answer too large to use, the size budget.
 */
export function splitArguments(args: unknown, keys: readonly NarrowingKey[]): SplitArguments {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return { ok: true, narrowing: null, rest: args };
  const record = args as Record<string, unknown>;
  const present = keys.filter((key) => record[key] !== undefined);
  if (present.length === 0) return { ok: true, narrowing: null, rest: args };

  const rest: Record<string, unknown> = { ...record };
  const taken: Record<string, unknown> = {};
  for (const key of present) {
    taken[key] = record[key];
    delete rest[key];
  }
  const parsed = NarrowingSchema.safeParse(taken);
  if (!parsed.success) return { ok: false, issues: parsed.error.issues.map(describeIssue) };
  return { ok: true, narrowing: parsed.data, rest };
}

function describeIssue(issue: z.core.$ZodIssue): string {
  const where = issue.path.map((part, index) => (typeof part === "number" ? `[${part}]` : index === 0 ? String(part) : `.${String(part)}`)).join("");
  return where === "" ? issue.message : `${where}: ${issue.message}`;
}

/** A dot path as the answer spells it on the wire: EO's own words put into the old ones. */
function wireSegments(path: string): string[] {
  return path.split(".").map((segment) => LEGACY_BOUNDARY_NAMES[segment] ?? segment);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * What sits at a path inside one value.
 *
 * Through arrays, so `labels.name` on an element with a list of labels
 * answers every label's name — which is what `contains` then looks
 * through.
 */
function valueAt(value: unknown, segments: readonly string[]): unknown {
  if (segments.length === 0) return value;
  if (Array.isArray(value)) return value.flatMap((element) => {
    const found = valueAt(element, segments);
    return found === undefined ? [] : [found];
  });
  if (!isRecord(value)) return undefined;
  const [head, ...tail] = segments;
  return valueAt(value[head!], tail);
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function ordered(a: unknown, b: unknown): number | null {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  return null;
}

/** Whether one list element meets one condition. Exported for the per-operator tests. */
export function matches(element: unknown, condition: Condition): boolean {
  const actual = valueAt(element, wireSegments(condition.path));
  const { op, value } = condition;
  switch (op) {
    case "exists": {
      const present = actual !== undefined && actual !== null;
      return value === false ? !present : present;
    }
    case "eq":
      return sameValue(actual, value);
    case "ne":
      return !sameValue(actual, value);
    case "in":
      return Array.isArray(value) && value.some((candidate) => sameValue(actual, candidate));
    case "contains":
      // Membership takes any JSON value, objects and null included —
      // `allowedValues` on jira_fields is a list of objects. A substring
      // only makes sense of something that is written as text.
      if (Array.isArray(actual)) return actual.some((held) => sameValue(held, value));
      if (typeof actual === "string" && (typeof value === "string" || typeof value === "number" || typeof value === "boolean")) {
        return actual.toLowerCase().includes(String(value).toLowerCase());
      }
      return false;
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const order = ordered(actual, value);
      if (order === null) return false;
      if (op === "gt") return order > 0;
      if (op === "gte") return order >= 0;
      if (op === "lt") return order < 0;
      return order <= 0;
    }
  }
}

function sortList(list: readonly unknown[], sort: NonNullable<Narrowing["sort"]>): unknown[] {
  const segments = wireSegments(sort.path);
  const sign = sort.direction === "desc" ? -1 : 1;
  const keyed = list.map((element) => ({ element, key: valueAt(element, segments) }));
  // Stable, so equal keys keep the order EO answered them in.
  keyed.sort((a, b) => {
    const aMissing = a.key === undefined || a.key === null;
    const bMissing = b.key === undefined || b.key === null;
    if (aMissing || bMissing) return aMissing === bMissing ? 0 : aMissing ? 1 : -1;
    const order = ordered(a.key, b.key) ?? ordered(JSON.stringify(a.key), JSON.stringify(b.key)) ?? 0;
    return sign * order;
  });
  return keyed.map((entry) => entry.element);
}

/**
 * The paths `fields` names, as a trie.
 *
 * `whole` marks a node a path ended on: everything under it is kept,
 * whatever longer paths through it were also named and in whichever
 * order — so `["tickets", "tickets.key"]` keeps every list element whole, the
 * union of the two rather than the narrower.
 */
interface PathTree {
  whole: boolean;
  children: Map<string, PathTree>;
}

/** What `project` answers for a value that does not have the path asked for. */
const OMIT = Symbol("omit");

/** Whether a path names anything in `value`. An empty list cannot say, so it is taken as yes. */
function pathExists(value: unknown, segments: readonly string[]): boolean {
  if (segments.length === 0) return value !== undefined;
  if (Array.isArray(value)) return value.length === 0 || value.some((element) => pathExists(element, segments));
  if (!isRecord(value)) return false;
  const [head, ...tail] = segments;
  return Object.hasOwn(value, head!) && pathExists(value[head!], tail);
}

/**
 * `value` with only the paths in `tree` kept.
 *
 * A value that ends before the path does — a string payload where
 * `payload.summary` was asked for, or a null — has nothing at that path,
 * so it is left out rather than kept whole: keeping it would hand back
 * exactly the unselected content `fields` exists to drop. In a list, an
 * element like that is dropped, while an object element without the
 * field stays as `{}` so a page still has as many elements as it says.
 */
function project(value: unknown, tree: PathTree): unknown {
  if (tree.whole) return value;
  if (Array.isArray(value)) {
    const kept = value.map((element) => project(element, tree)).filter((element) => element !== OMIT);
    return value.length > 0 && kept.length === 0 ? OMIT : kept;
  }
  if (!isRecord(value)) return OMIT;
  const out: Record<string, unknown> = {};
  for (const [segment, below] of tree.children) {
    if (!Object.hasOwn(value, segment)) continue;
    const kept = project(value[segment], below);
    if (kept !== OMIT) out[segment] = kept;
  }
  return out;
}

function selectFields(data: Record<string, unknown>, fields: readonly string[]): { data: Record<string, unknown>; unknown: string[] } {
  const tree: PathTree = { whole: false, children: new Map() };
  const unknownPaths: string[] = [];
  for (const path of fields) {
    const segments = wireSegments(path);
    if (!pathExists(data, segments)) {
      unknownPaths.push(path);
      continue;
    }
    let node = tree;
    for (const segment of segments) {
      let next = node.children.get(segment);
      if (next === undefined) {
        next = { whole: false, children: new Map() };
        node.children.set(segment, next);
      }
      node = next;
    }
    node.whole = true;
  }
  // Nothing matched is an answer with nothing in it, not the whole answer.
  const projected = project(data, tree);
  return { data: isRecord(projected) ? projected : {}, unknown: unknownPaths };
}

/** The page counts a narrowed answer carries beside the data. */
export interface PageCounts {
  total: number;
  returned: number;
  nextOffset: number | null;
}

export interface NarrowedAnswer {
  text: string;
  data: Record<string, unknown>;
}

/** The last segment of the list's path, as a noun for the summary: "tickets", "events". */
function noun(list: string): string {
  const segments = wireSegments(list);
  return segments[segments.length - 1] ?? list;
}

function render(summary: string, data: Record<string, unknown>): NarrowedAnswer {
  return { text: `${summary}\n${JSON.stringify(data)}`, data };
}

function listIn(data: Record<string, unknown>, list: string): unknown[] | null {
  const found = valueAt(data, wireSegments(list));
  return Array.isArray(found) ? found : null;
}

function withList(data: Record<string, unknown>, list: string, replacement: unknown[]): Record<string, unknown> {
  const [head, ...tail] = wireSegments(list);
  if (head === undefined) return data;
  if (tail.length === 0) return { ...data, [head]: replacement };
  const below = data[head];
  return isRecord(below) ? { ...data, [head]: withList(below, tail.join("."), replacement) } : data;
}

/**
 * An answer cut down to what was asked for.
 *
 * In this order: the list is filtered by `where`, ordered by `sort`,
 * counted, paged by `offset` and `limit`, and then `fields` keeps only
 * the paths named — so a filter or a sort may use a field the caller
 * did not ask to see.
 *
 * `data` is the wire-spelled answer, which is what both the structured
 * copy and the text are built from: the two are the same answer, as
 * every tool's must be (catalog.ts, `ToolOutcome`).
 */
export function narrowAnswer(data: Record<string, unknown>, list: string | undefined, narrowing: Narrowing): NarrowedAnswer {
  let working = data;
  let counts: PageCounts | null = null;
  if (list !== undefined) {
    const elements = listIn(working, list);
    if (elements === null) {
      counts = { total: 0, returned: 0, nextOffset: null };
    } else {
      const conditions = narrowing.where ?? [];
      let kept = elements.filter((element) => conditions.every((condition) => matches(element, condition)));
      if (narrowing.sort !== undefined) kept = sortList(kept, narrowing.sort);
      const offset = narrowing.offset ?? 0;
      const page = kept.slice(offset, narrowing.limit === undefined ? undefined : offset + narrowing.limit);
      const next = offset + page.length;
      counts = { total: kept.length, returned: page.length, nextOffset: next < kept.length ? next : null };
      working = withList(working, list, page);
    }
  }

  let unknownFields: string[] = [];
  if (narrowing.fields !== undefined) {
    const selected = selectFields(working, narrowing.fields);
    working = selected.data;
    unknownFields = selected.unknown;
  }

  const parts: string[] = [];
  if (list !== undefined && counts !== null) {
    const name = noun(list);
    parts.push(
      `${counts.total.toLocaleString("en-US")} ${name} matched; ${counts.returned.toLocaleString("en-US")} returned` +
        (counts.nextOffset === null ? ", and there are no more." : `; the next page starts at offset ${counts.nextOffset}.`),
    );
  } else {
    parts.push(`Narrowed to ${narrowing.fields?.length === 1 ? "the field" : "the fields"} asked for.`);
  }
  if (unknownFields.length > 0) parts.push(`Nothing is at ${unknownFields.map((path) => `\`${path}\``).join(", ")}, so ${unknownFields.length === 1 ? "it was" : "they were"} left out.`);

  return render(parts.join(" "), counts === null ? working : { ...working, ...counts });
}

/** How many characters an answer puts on the wire: its text and its structured copy. */
export function answerSize(text: string, data: unknown): number {
  return text.length + JSON.stringify(data).length;
}

/**
 * An answer nobody narrowed, cut to fit when it is too large to use.
 *
 * Null when it already fits — and then the caller sends the tool's own
 * answer untouched, byte for byte. Only an answer that would be over
 * `ANSWER_BUDGET` is changed, which is the point of the budget: it
 * stops an agent being handed a hundred and sixty thousand characters
 * it cannot hold, and touches nothing else.
 *
 * A tool with a main list answers its first page — as many elements as
 * fit, from the start — with the counts and a sentence saying how to
 * narrow. A tool without one has no page to cut to, so it answers as
 * much of itself as fits, in order, and names each part it left out
 * with its size, which is what `fields` is then asked for.
 */
export function withinBudget(text: string, data: Record<string, unknown>, list: string | undefined, tool: string): NarrowedAnswer | null {
  const size = answerSize(text, data);
  if (size <= ANSWER_BUDGET) return null;
  const elements = list === undefined ? null : listIn(data, list);
  if (list !== undefined && elements !== null) return firstPage(data, list, elements, size, tool);
  return partialAnswer(data, size, tool);
}

function overBudget(size: number): string {
  return `This answer would be ${size.toLocaleString("en-US")} characters, over EO's ${ANSWER_BUDGET.toLocaleString("en-US")}-character budget for one answer`;
}

function firstPage(data: Record<string, unknown>, list: string, elements: readonly unknown[], size: number, tool: string): NarrowedAnswer {
  const name = noun(list);
  const first = elements.find(isRecord);
  const example = `${wireSegments(list).join(".")}.${first === undefined ? "id" : (Object.keys(first)[0] ?? "id")}`;
  const build = (count: number): NarrowedAnswer => {
    const counts: PageCounts = { total: elements.length, returned: count, nextOffset: count < elements.length ? count : null };
    const summary =
      `${overBudget(size)}, so this is the first page: ${count.toLocaleString("en-US")} of ${elements.length.toLocaleString("en-US")} ${name}. ` +
      `Narrow it with \`where\` to filter the ${name}, \`fields\` to keep only the paths you need (such as "${example}"), and ` +
      `\`limit\` with \`offset\` to page` +
      (counts.nextOffset === null ? "." : ` — the next page starts at offset ${counts.nextOffset}.`) +
      ` The eo_orient guide (eo_guide) describes all five; ${tool} takes them.`;
    return render(summary, { ...withList(data, list, elements.slice(0, count)), ...counts });
  };

  // The largest page that fits, found by halving: each probe renders the
  // whole answer, so what is measured is exactly what would be sent.
  let low = 0;
  let high = Math.min(elements.length, MAX_LIMIT);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const probe = build(mid);
    if (answerSize(probe.text, probe.data) <= ANSWER_BUDGET) low = mid;
    else high = mid - 1;
  }
  return build(low);
}

interface Omitted {
  path: string;
  characters: number;
  entries?: number;
}

/**
 * As much of an answer as fits in `room` characters of JSON, in order,
 * and what was left out.
 *
 * An object too large to keep whole is descended into, so `ticket_get`
 * keeps its item's title and description and leaves out the comment
 * thread, rather than leaving out the item.
 */
function fit(value: Record<string, unknown>, room: number, prefix: string, omitted: Omitted[]): { kept: Record<string, unknown>; used: number } {
  const kept: Record<string, unknown> = {};
  let used = 2;
  for (const [key, held] of Object.entries(value)) {
    const keyCost = JSON.stringify(key).length + 2;
    const path = prefix === "" ? key : `${prefix}.${key}`;
    const cost = keyCost + (held === undefined ? 0 : JSON.stringify(held).length);
    if (used + cost <= room) {
      kept[key] = held;
      used += cost;
      continue;
    }
    if (isRecord(held) && used + keyCost + 2 <= room) {
      const inner = fit(held, room - used - keyCost, path, omitted);
      kept[key] = inner.kept;
      used += keyCost + inner.used;
      continue;
    }
    omitted.push({ path, characters: cost - keyCost, ...(Array.isArray(held) ? { entries: held.length } : {}) });
  }
  return { kept, used };
}

function partialAnswer(data: Record<string, unknown>, size: number, tool: string): NarrowedAnswer {
  const build = (room: number): NarrowedAnswer => {
    const omitted: Omitted[] = [];
    const { kept } = fit(data, room, "", omitted);
    const named = omitted
      .slice(0, 10)
      .map((entry) => `\`${entry.path}\` (${entry.characters.toLocaleString("en-US")} characters${entry.entries === undefined ? "" : `, ${entry.entries} entries`})`)
      .join(", ");
    const more = omitted.length > 10 ? ` and ${omitted.length - 10} more listed under omitted` : "";
    const summary =
      `${overBudget(size)}, so this is the part that fits. Left out: ${named}${more}. ` +
      `Ask ${tool} again with \`fields\` naming only the paths you need, such as "${omitted[0]?.path ?? "a.b"}.<field>".`;
    return render(summary, { ...kept, omitted });
  };

  // The text carries the data again as JSON, so each copy gets a little
  // under half; shrunk until the whole of it, sentence included, fits.
  let room = Math.floor(ANSWER_BUDGET / 2) - 1_000;
  let answer = build(room);
  while (answerSize(answer.text, answer.data) > ANSWER_BUDGET && room > 0) {
    room -= 2_000;
    answer = build(Math.max(room, 0));
  }
  return answer;
}
