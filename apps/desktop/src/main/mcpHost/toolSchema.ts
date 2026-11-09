import { ACTING_AGENT_KEY, PATHS_FROM_KEY, ipcContract, type IpcChannel } from "@eo/core";
import { z } from "zod";

/** What an MCP client is handed as a tool's `inputSchema`. */
export type JsonSchemaObject = Record<string, unknown>;

/**
 * The empty argument list, spelled the only way MCP can spell it.
 *
 * Shared rather than rebuilt so `isVoidChannel`'s callers and this
 * module cannot come to disagree about what "takes nothing" looks like.
 */
const NO_ARGUMENTS: JsonSchemaObject = { type: "object", properties: {}, additionalProperties: false };

/**
 * Whether a channel's request schema is `z.void()`.
 *
 * Worth its own exported predicate because the answer is needed twice
 * and for opposite reasons: here, to emit an empty object schema instead
 * of asking zod to translate something it cannot; and in the dispatcher,
 * to send `undefined` rather than the `{}` every MCP client puts on the
 * wire for a tool with no arguments. `z.void()` rejects `{}` as firmly
 * as it rejects a string, so without the second half every one of these
 * channels would refuse every call.
 */
export function isVoidChannel(channel: IpcChannel): boolean {
  return ipcContract[channel].request.def.type === "void";
}

/**
 * The same schema with the caller's identity taken out of it (EO-326).
 *
 * `ACTOR_SCOPED_CHANNELS` carry an `actingDeviceId` that a server's door
 * stamps from the credential a request arrived on. It is deliberately
 * not something a *caller* supplies — and an agent is a caller. Left in,
 * a tool would advertise "say which device you are" to a model, and a
 * model that said one would be reading somebody else's inbox and filing
 * a decision under their name.
 *
 * So it is removed from what a tool shows **and** from what a tool may
 * send (see `spelledTool`, which deletes the key before dispatching).
 * Both halves are needed: the schema is a description and a description
 * nobody enforces is a suggestion.
 *
 * This is invariant 11's rule one step further out. That invariant stops
 * a step-owning agent widening its own *tool surface*; this stops one
 * widening its own *authority* through a tool it already has. Neither is
 * something an agent gets to decide.
 *
 * A non-object schema and an object that never declared the field are
 * handed back by identity, so `channelTool` can still tell "this needed
 * changing" from "this did not".
 */
export function withoutCallerIdentity(schema: z.ZodType): z.ZodType {
  // Three of these channels default an absent payload to `{}`, which
  // wraps the object in a `ZodDefault` — and a check for a plain object
  // would sail straight past it, leaving `items_list` and `inbox_list`
  // advertising the one field no tool may have. Unwrapped and re-wrapped
  // so the default survives: it is what lets a client call these with no
  // arguments at all.
  if (schema instanceof z.ZodDefault) {
    const inner = schema.def.innerType as z.ZodType;
    const without = withoutCallerIdentity(inner);
    return without === inner ? schema : without.default(schema.def.defaultValue as never);
  }
  if (!(schema instanceof z.ZodObject)) return schema;
  const shape = schema.shape as Record<string, z.ZodType>;
  if (!CALLER_IDENTITY_KEYS.some((key) => Object.hasOwn(shape, key))) return schema;

  const kept: Record<string, z.ZodType> = {};
  for (const [key, field] of Object.entries(shape)) if (!CALLER_IDENTITY_KEYS.includes(key)) kept[key] = field;
  // Loose, for `advertisedInLegacy`'s reason: an unknown key is stripped
  // rather than refused, which is what every tool did before — and the
  // one key this exists to drop is stripped by exactly that rule.
  return z.looseObject(kept);
}

/** The field a server's door stamps, spelled once. */
export const ACTING_DEVICE_KEY = "actingDeviceId";

/**
 * Every field that says who is asking, and so is never a tool argument:
 * the device a server's door stamps (EO-326), and the system agent EO's
 * administrative host stamps from the turn's credential (EO-585). A model
 * that could name the agent would be passing its own press off as the
 * assistant's, or the assistant's as the person's. And where the caller
 * may name files from (EO-700), which EO's MCP hosts stamp from who is at
 * the other end: a model that could name it would pick its own reach.
 */
const CALLER_IDENTITY_KEYS: readonly string[] = [ACTING_DEVICE_KEY, ACTING_AGENT_KEY, PATHS_FROM_KEY];

/**
 * A channel's request schema, as the JSON Schema a tool advertises.
 *
 * `io: "input"` is the same choice `outputSchemaFor` makes in
 * packages/core/src/schemas/index.ts, for the same reason: the schema
 * describes what the *caller* must produce, so a field carrying a zod
 * default is optional and arrives with its default attached. Under
 * `io: "output"` the same schema demands every defaulted field —
 * `runs:listEvents` would require `fromSeq` and `limit`, which is asking
 * a model for two numbers EO was going to fill in anyway.
 */
export function inputSchemaFor(schema: z.ZodType): JsonSchemaObject {
  // z.toJSONSchema does not merely produce something awkward for
  // `z.void()` — it throws ("Void cannot be represented in JSON
  // Schema"). MCP has no way to say "no arguments" other than an empty
  // object schema, so that is both the honest translation and the only
  // one available.
  if (schema.def.type === "void") return { ...NO_ARGUMENTS };

  const json = z.toJSONSchema(schema, { io: "input" }) as JsonSchemaObject;

  // The dialect belongs on a document, not on a tool's inline schema,
  // and clients that copy it into their own validator get a needless
  // remote fetch out of it.
  delete json["$schema"];

  // `io: "input"` does not add this and `io: "output"` does, which is
  // the wrong way round for a tool. Zod strips unknown keys silently, so
  // a misspelled argument reaches the handler as an *absence* — the
  // call succeeds and quietly does something other than what was asked.
  // Declaring it lets a well-behaved client refuse before sending
  // rather than after.
  //
  // Only for object schemas: a channel whose request is a union or an
  // array has no notion of an additional property, and asserting one
  // would be a claim about a shape that does not have it.
  if (json["type"] !== "object") return json;
  return { ...json, additionalProperties: false };
}
