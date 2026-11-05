import { z } from "zod";

/**
 * The old vocabulary, still spoken at the MCP boundary (KAN-145/KAN-162).
 *
 * KAN-145 renamed the entity to `item` everywhere EO owns — the tables,
 * the IPC contract, the schemas. It deliberately did *not* rename the
 * MCP tool names, because external clients registered against
 * `ticket_get`, `ticket_move`, `tickets_list` and `work_submit_ticket`
 * through `mcp:registerWith`, and a name EO does not own is not EO's to
 * change on its own schedule.
 *
 * A tool's name is only a third of what a client registered against.
 * The other two thirds are **the arguments it takes** and **the shape it
 * answers with**, and both are generated from the IPC contract — so
 * renaming the contract renamed them silently. `ticket_get` began
 * demanding `itemId` while still calling itself `ticket_get`. Worse,
 * where the field was optional the failure was not even loud:
 * `spend_read({ ticketId })` and `guardrails_set({ perTicketBudgetCents })`
 * have zod strip the unknown key and succeed, answering a question
 * nobody asked — the day's total instead of the item's, the guardrails
 * unchanged instead of written.
 *
 * So the whole boundary was frozen, not just the names. Nine keys, in
 * one table, applied in exactly two places: `channelTool` translates
 * arguments on the way in, and `callTool` translates structured output
 * on the way out. Between those two points EO speaks its own vocabulary
 * and nothing here leaks inward.
 *
 * ## What KAN-162 changed, and what it deliberately did not
 *
 * KAN-145 left a note here saying the alias story would delete this
 * table. It does not, and the reason is worth writing down: a table
 * that went away would take the *answers* with it. A client that
 * registered against `ticket_get` reads `ticket`, `ticketId` and
 * `ticketKey` out of what comes back, and an alias period whose whole
 * purpose is that installed clients keep working cannot be the thing
 * that stops them reading their own replies.
 *
 * So **the answer is this spelling for every tool, under either of its
 * names.** Every `ticket_*` tool now has an `item_*` twin over the same
 * channel with the same handler (`deprecations.ts` is the list), and
 * `toLegacyShape` is applied to what both of them answer. A twin whose
 * reply came back in a different shape from the name it aliases would
 * not be an alias; it would be a second tool, and the story's criterion
 * is that a pair returns identical results for identical inputs. The
 * release that retires the old names is where the answers follow.
 *
 * What KAN-162 did change here is two narrower things.
 *
 * **Which spelling a tool advertises follows its name.** The deprecated
 * name offers `ticketId`, as it always has; the twin offers `itemId`.
 * That is the one place EO's own word reaches a caller without
 * rewriting anything an installed client reads — a suggestion to
 * whoever is reading `tools/list`, not a difference in what a call may
 * say or in what comes back.
 *
 * **Both spellings are accepted, whichever name was called.** The freeze
 * *refused* the new spelling by name, because accepting it silently was
 * how `spend_read({ itemId })` came to answer the wrong question.
 * Refusing was right while there was nothing to migrate to; now there
 * is, and refusing `item_get({ itemId })` would be the boundary
 * contradicting its own tool list. So a renamed key is taken under
 * either name — and sending *both* is refused, by name, because two
 * spellings of one field in one call is the only case where EO would
 * have to guess which the caller meant.
 *
 * The story after this one is where the `ticket_*` names, and this file
 * with them, are removed.
 *
 * ## Why a table of exact keys, and not a pattern
 *
 * `itemTypes` on the registry predates KAN-145 — it was always called
 * that, because an item *type* is a registry concept rather than the
 * ticket that was renamed. A rule like "any key starting with `item`"
 * would rename it to `ticketTypes` and invent a field that has never
 * existed. Every key below was verified against the pre-rename tree: the
 * nine are exactly what `packages/core/src/ipc-schemas.ts` renamed, and
 * `itemTypes` is the only item-shaped key that came from anywhere else.
 *
 * `itemTypeLabel` (EO-309) is the one entry here that was never renamed
 * from anything, because it did not exist before the rename. It is in
 * the table all the same, and the line between it and `itemTypes` is
 * *what carries it*: `itemTypes` is a field of the registry, which is
 * not a ticket and never was, while this is a field of an inbox row,
 * sitting between `ticketTitle` and `ticketState` in the same answer. A
 * client reading that row in the old vocabulary would otherwise find
 * one key in the new one, which is the boundary speaking two languages
 * in a single object.
 */
const TO_LEGACY: Readonly<Record<string, string>> = {
  item: "ticket",
  items: "tickets",
  itemId: "ticketId",
  itemKey: "ticketKey",
  itemState: "ticketState",
  itemTitle: "ticketTitle",
  itemTypeLabel: "ticketTypeLabel",
  itemCount: "ticketCount",
  perItemAttemptLimit: "perTicketAttemptLimit",
  perItemBudgetCents: "perTicketBudgetCents",
};

/** Exported for the test that pins the table against the IPC contract. */
export const LEGACY_BOUNDARY_NAMES = TO_LEGACY;

/**
 * Which vocabulary one tool *advertises* its arguments in.
 *
 * `"ticket"` is what every tool EO has ever offered advertises, and what
 * all but the eleven aliased twins go on advertising — a tool whose name
 * nobody is migrating away from has nothing to migrate its arguments to.
 * `"item"` is EO's own, and only the `item_*` twins are in it.
 *
 * Advertising only. What a call may *say* is both spellings either way,
 * and what it gets back is the legacy spelling either way — see the note
 * at the top of this file on why the answer is a property of the
 * boundary rather than of the name that was called.
 */
export type ToolSpelling = "item" | "ticket";

/**
 * A tool's arguments at the boundary: what it advertises, and what it
 * accepts.
 *
 * Two schemas rather than one because they have to disagree. The
 * advertised one is the plain object — that is what a client is shown
 * and what `inputSchemaFor` translates, and it is the only half that
 * differs between the two spellings. The accepting one takes either
 * spelling whichever name was called, so that `item_get` and
 * `ticket_get` cannot differ in what a call is allowed to say.
 */
export interface BoundaryArguments<T> {
  /** What `tools/list` shows. One spelling, and nothing else. */
  advertised: z.ZodType;
  /** What a call is parsed with. Its output is the channel's own payload. */
  accepts: z.ZodType<T>;
  /** False when this schema named nothing that was renamed. */
  translated: boolean;
}

/**
 * A tool's arguments, advertised in one spelling and accepted in both.
 *
 * Hands back the schema it was given, unchanged and by identity, when
 * nothing in it is renamed — which is most tools, and is what lets
 * `channelTool` tell "this needs translating" from "this does not".
 *
 * Only the top level is renamed, because only the top level is
 * arguments. Every affected request schema is flat, and a nested rename
 * would be reaching into payloads — a comment body, a pipeline draft —
 * that this has no business rewriting.
 *
 * ## Why the real validation is the channel's own
 *
 * `accepts` normalises the keys and then pipes the result straight into
 * the schema it was handed. Nothing here re-implements "required",
 * "optional", a default or a type: a call that gets one wrong is
 * answered in the channel's own words, about the field the channel
 * declares, which is what a caller would have been told before any of
 * this existed.
 *
 * ## Why both spellings at once are refused
 *
 * `ticket_get({ ticketId: "a", itemId: "b" })` names one field twice and
 * disagrees with itself. Taking the first, the last or the legacy one
 * would all be EO picking on the caller's behalf and answering about an
 * item they did not ask about — the silent-wrong-answer failure this
 * file was written for, arriving by the other door. So it is refused,
 * naming both spellings, and the caller sends one.
 *
 * The guard sits ahead of the object rather than on it, because zod
 * skips a refinement once the value it is refining has already failed —
 * so a check *on* the object would have gone unheard on exactly the ten
 * tools whose renamed field is required, leaving them answering "expected
 * string, received undefined" about a field the caller never mentioned.
 */
export function boundaryArguments<T extends z.ZodType>(schema: T, spelling: ToolSpelling): BoundaryArguments<z.output<T>> {
  const pairs = renamedTopLevel(schema);
  if (pairs === null) return { advertised: schema, accepts: schema as unknown as z.ZodType<z.output<T>>, translated: false };

  const accepts = z
    .unknown()
    .superRefine((value, ctx) => {
      if (!isPlainRecord(value)) return;
      for (const [current, legacy] of pairs) {
        if (!(current in value) || !(legacy in value)) continue;
        ctx.addIssue({
          code: "custom",
          path: [current],
          message:
            `Send \`${legacy}\` or \`${current}\`, not both — they are two spellings of one field and EO will not guess which you meant. ` +
            `\`${legacy}\` is the spelling this boundary has always used and \`${current}\` is EO's own; either is taken.`,
        });
      }
    })
    .transform((value) => {
      // The legacy spelling put back under the name the channel
      // declares. Only the keys *this* schema renamed, so a boundary key
      // belonging to some other tool is left to be stripped as any
      // unknown key is, rather than quietly rewritten into one this
      // channel does declare.
      if (!isPlainRecord(value)) return value;
      const out: Record<string, unknown> = { ...value };
      for (const [current, legacy] of pairs) {
        if (!(legacy in out)) continue;
        out[current] = out[legacy];
        delete out[legacy];
      }
      return out;
    })
    // The channel's own schema, doing the whole of the validation and
    // producing the whole of the payload — including stripping every
    // unknown key, exactly as it did before any of this existed.
    .pipe(schema);

  return { advertised: spelling === "ticket" ? advertisedInLegacy(schema, pairs) : schema, accepts: accepts as z.ZodType<z.output<T>>, translated: true };
}

/**
 * The declared shape with every renamed key spelled the old way.
 *
 * Each field keeps its own schema, so its description, its default and
 * whether it is optional all survive the rename — the advertised schema
 * differs from the channel's in the spelling of a key and in nothing
 * else.
 *
 * Loose rather than strict so that an unknown key is still stripped
 * rather than refused, which is what it was before. `inputSchemaFor`
 * advertises `additionalProperties: false` either way, so a client is
 * told exactly what it was told before.
 */
function advertisedInLegacy(schema: z.ZodType, pairs: ReadonlyMap<string, string>): z.ZodType {
  const shape = (schema as z.ZodObject).shape as Record<string, z.ZodType>;
  const renamed: Record<string, z.ZodType> = {};
  for (const [key, field] of Object.entries(shape)) renamed[pairs.get(key) ?? key] = field;
  return z.looseObject(renamed);
}

/** Current spelling to legacy, for the keys this schema declares. Null when it declares none. */
function renamedTopLevel(schema: z.ZodType): ReadonlyMap<string, string> | null {
  if (!(schema instanceof z.ZodObject)) return null;

  const pairs = new Map<string, string>();
  for (const key of Object.keys(schema.shape as Record<string, z.ZodType>)) {
    const legacy = TO_LEGACY[key];
    if (legacy !== undefined) pairs.set(key, legacy);
  }
  return pairs.size === 0 ? null : pairs;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Structured output, in the old spelling, on its way to the wire.
 *
 * Applied to what *every* tool answers, an `item_*` twin included. The
 * temptation is to let the twin answer in EO's own words, since nothing
 * has registered against that name yet — and it was written that way
 * once. It is wrong: a pair whose two names hand back two shapes is two
 * tools, and "identical results for identical inputs" is the thing the
 * aliases exist to promise. One boundary, one vocabulary, until the
 * names it was built for are gone.
 *
 * Deep, unlike the argument translation, because a response is a
 * document rather than a flat argument list: `ticket_get` answers with
 * an item that carries comments that carry an `itemId` apiece, and a
 * client reading the second level is as entitled to the old spelling as
 * one reading the first.
 *
 * Keys only. A *value* that happens to read "item" is somebody's prose —
 * a comment body, an item's title — and rewriting it would be editing
 * what a person wrote.
 */
export function toLegacyShape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toLegacyShape);
  if (value === null || typeof value !== "object") return value;
  // Only plain objects: a Date or a Map reaching here would be rebuilt
  // as an object literal and lose what it was.
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return value;

  const out: Record<string, unknown> = {};
  for (const [key, held] of Object.entries(value as Record<string, unknown>)) out[TO_LEGACY[key] ?? key] = toLegacyShape(held);
  return out;
}
