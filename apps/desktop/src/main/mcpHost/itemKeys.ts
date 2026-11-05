import type { IpcChannel, IpcResponse } from "@eo/core";
import type { Dispatch } from "./catalog.js";
import type { JsonSchemaObject } from "./toolSchema.js";

/**
 * An item's key, accepted wherever a tool takes an item's id (EO-539).
 *
 * Keys are what a person types and what every answer shows — `EO-486` —
 * and ids are UUIDs nobody can read. Until this, turning one into the
 * other meant listing the whole project and searching it, which is the
 * answer EO-537 exists to stop agents having to read. So the host does
 * it, once, before any tool that takes an id runs: the tool, its
 * channel and its handler see the id they always saw, and a key naming
 * nothing never reaches them at all.
 *
 * In the host rather than in each tool, and found from each tool's own
 * advertised arguments rather than listed, so a tool added later that
 * takes `itemId` accepts a key without a line of its own.
 * `itemKeys.test.ts` holds every such tool in the catalogue to it.
 */

/** The arguments that hold an item's id, in either spelling (legacyNames.ts). */
export const ITEM_ID_ARGUMENTS = ["itemId", "ticketId"] as const;

/** The channel a key is resolved through — added to the channels of every tool that resolves one. */
export const RESOLVE_KEY_CHANNEL: IpcChannel = "items:resolveKey";

/** What every such tool's description says, so a caller reading the list knows it need not look an id up. */
export const KEY_ACCEPTED_SENTENCE = "The ticket may be named by its key, such as EO-486, wherever its id is asked for.";

const KEY_ACCEPTED_PROPERTY = "The ticket's id, or its key such as EO-486.";

/** A UUID, which is what every item id is — and which is passed through exactly as it was. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A key: a prefix, a hyphen and a number. A prefix may itself hold a hyphen, so the number is what follows the last. */
const KEY = /^\S+-\d+$/;

/** Which of the id arguments a tool advertises. Empty for a tool that takes no item id. */
export function itemIdArgumentsOf(schema: JsonSchemaObject): string[] {
  const properties = (schema["properties"] ?? {}) as Record<string, unknown>;
  return ITEM_ID_ARGUMENTS.filter((name) => Object.hasOwn(properties, name));
}

/** A tool's input schema with each id argument described as taking a key too. */
export function withKeyAcceptingProperties(schema: JsonSchemaObject, names: readonly string[]): JsonSchemaObject {
  const properties = { ...((schema["properties"] ?? {}) as Record<string, unknown>) };
  for (const name of names) {
    const property = properties[name];
    if (property !== null && typeof property === "object") properties[name] = { ...property, description: KEY_ACCEPTED_PROPERTY };
  }
  return { ...schema, properties };
}

export type ResolvedArguments = { ok: true; args: unknown } | { ok: false; message: string };

/**
 * A call's arguments with every item key in them turned into the id it
 * names — or the sentence saying which key named nothing.
 *
 * Only the arguments `names` lists — every spelling of an item id the
 * tool accepts, not only the one it advertises — and only a value that is a string
 * and not already a UUID: a UUID goes through untouched, so a call that
 * worked before works the same. Any other string must be a key that
 * names an item, and is refused, by name, if it is not — before the tool
 * runs, so a write given one changes nothing. Asked of the channel,
 * because the host reaches EO's data through nothing else.
 */
export async function resolveItemKeys(dispatch: Dispatch, args: unknown, names: readonly string[]): Promise<ResolvedArguments> {
  if (names.length === 0 || args === null || typeof args !== "object" || Array.isArray(args)) return { ok: true, args };
  const record = args as Record<string, unknown>;
  // Both spellings of one id in one call is refused by the tool itself,
  // by name (legacyNames.ts): the one case where EO would have to guess
  // which the caller meant. Left for that refusal rather than resolved
  // into two ids it would refuse all the same, or into a different one.
  if (names.filter((name) => record[name] !== undefined).length > 1) return { ok: true, args };
  let resolved: Record<string, unknown> | null = null;

  for (const name of names) {
    const value = record[name];
    if (typeof value !== "string" || UUID.test(value)) continue;
    const key = value.trim();
    // Neither an id nor a key — `EO486`, `EO-`, `#486`, a title. Every
    // item id is a UUID, so a value that is not one and is not written as
    // a key names no item whatever is done with it, and passing it on
    // would have the tool answer a generic "no such item" without saying
    // what it was given (EO-539).
    if (!KEY.test(key)) return { ok: false, message: `"${value}" is neither an item's id nor its key: an id is a UUID, and a key is a project's prefix, a hyphen and a number, like EO-486.` };
    const answer = await dispatch(RESOLVE_KEY_CHANNEL, { key });
    if (!answer.ok) return { ok: false, message: answer.error.message };
    const { itemId, problem } = answer.data as IpcResponse<"items:resolveKey">;
    if (itemId === null) return { ok: false, message: problem ?? `"${value}" names no item.` };
    resolved = { ...(resolved ?? record), [name]: itemId };
  }
  return { ok: true, args: resolved ?? args };
}
