import { canonicalToolName, DEPRECATED_TOOL_NAMES, deprecatedToolName, replacementToolName, type DeprecatedToolName } from "@eo/core";
import type { Db } from "../db/client.js";
import { getSetting, setSetting } from "../db/repos/index.js";
import type { ClientId } from "./clients.js";

/**
 * Which of its two names each connected client is actually calling
 * (KAN-178).
 *
 * The Servers screen's row has to be *derived* rather than guessed, and
 * nothing else in EO knows the answer: a client registered through
 * `mcp:registerWith` is a command run against somebody else's editor,
 * and neither that command nor their configuration file says which tool
 * names the model inside it will reach for. The only place that becomes
 * a fact is a `tools/call` arriving here. So the host writes down what
 * it was called, per client, and the screen reads it back.
 *
 * ## What is recorded, and what is not
 *
 * The tool name and the client's own name for itself, from the
 * `clientInfo` it sent at initialize. Not the arguments, not the answer,
 * not who was asked about — this is a deprecation counter, not an audit
 * log, and `run_events` is where EO records what happened.
 *
 * Only calls that arrived over the external listener. The internal one
 * serves the system agent EO spawned itself (EO-182), whose tool surface
 * EO chooses; a row telling a person their own installation is on the
 * old names would be a row about a decision they never made and cannot
 * act on.
 *
 * ## Why the last spelling wins rather than every spelling ever
 *
 * The row exists to answer "is this client going to break?", and a
 * client that has been updated has stopped calling the old name. Keeping
 * a set of everything ever called would leave a yellow row on a client
 * that fixed itself months ago — a warning that cannot be cleared is one
 * that gets ignored, which costs more than the warning was worth.
 *
 * So the record is per *tool*, the latest spelling winning: `ticket_get`
 * then `item_get` is a client that moved, and a client that calls
 * `ticket_get` and then twenty other tools is still on the old name,
 * because none of those twenty said anything about `ticket_get`.
 */
export const MCP_ALIAS_USE_KEY = "mcp.aliasUse";

/**
 * How many clients are remembered.
 *
 * A backstop rather than a policy, like `MAX_SESSIONS`: this is a
 * single-user machine and nobody has nine editors open. The cap matters
 * because the key is what a client calls itself — a program that
 * generated a fresh name per launch would otherwise grow this row
 * without bound.
 */
const MAX_CLIENTS = 8;

/** One client, and the last spelling it used for each tool that has two. */
export interface RecordedClientCalls {
  /** What the client called itself at initialize. EO's own word for nothing. */
  client: string;
  /** The last name it called, deprecated or not. What "records the tool name of each call" means. */
  lastToolName: string;
  /** When that was, ISO-8601. */
  lastCalledAt: string;
  /**
   * Per aliased tool, in EO's own name for it, the spelling last used.
   *
   * `{ item_get: "ticket_get" }` is a client on the old name;
   * `{ item_get: "item_get" }` is one that moved. A tool it has never
   * called is absent rather than recorded as either.
   */
  spellings: Record<string, string>;
}

function readAll(db: Db): RecordedClientCalls[] {
  const stored = getSetting<unknown>(db, MCP_ALIAS_USE_KEY, []);
  if (!Array.isArray(stored)) return [];
  // Hand-narrowed rather than parsed with a schema: this row is EO's own
  // and a damaged one is worth dropping quietly, not worth refusing a
  // Settings screen over.
  return stored.filter((entry): entry is RecordedClientCalls => {
    if (entry === null || typeof entry !== "object") return false;
    const record = entry as Record<string, unknown>;
    return typeof record["client"] === "string" && typeof record["lastToolName"] === "string" && typeof record["lastCalledAt"] === "string" && typeof record["spellings"] === "object" && record["spellings"] !== null;
  });
}

/** Every client EO has heard from, most recently seen first. */
export function readAliasUse(db: Db): RecordedClientCalls[] {
  return [...readAll(db)].sort((left, right) => right.lastCalledAt.localeCompare(left.lastCalledAt));
}

/**
 * One `tools/call`, written down.
 *
 * Called on every call rather than only on a deprecated one, because
 * "this client has moved to `item_get`" is only knowable from the calls
 * that were not deprecated — a recorder that ignored them could never
 * clear a row.
 *
 * A write per call, which is one small upsert beside the several the
 * call itself already makes through `dispatchIpc`. Tool calls arrive at
 * the pace a person's editor works at, not at machine speed.
 */
export function recordToolCall(db: Db, client: string, toolName: string, now: Date = new Date()): void {
  const name = client.trim() === "" ? "an unnamed client" : client.trim();
  const existing = readAll(db);
  const previous = existing.find((entry) => entry.client === name);

  // Only a tool with two names says anything about which spelling this
  // client is on. Everything else is recorded as the last call and
  // nothing more.
  const canonical = canonicalToolName(toolName);
  const aliased = replacementToolName(toolName) !== null || deprecatedToolName(toolName) !== null;

  const updated: RecordedClientCalls = {
    client: name,
    lastToolName: toolName,
    lastCalledAt: now.toISOString(),
    spellings: { ...(previous?.spellings ?? {}), ...(aliased ? { [canonical]: toolName } : {}) },
  };

  const rest = existing.filter((entry) => entry.client !== name);
  // Newest first, then truncated: the client dropped is the one nothing
  // has been heard from for longest.
  const next = [updated, ...rest.sort((left, right) => right.lastCalledAt.localeCompare(left.lastCalledAt))].slice(0, MAX_CLIENTS);
  setSetting(db, MCP_ALIAS_USE_KEY, next);
}

/**
 * The old names one client is still on, with what to use instead.
 *
 * Empty for a client that has moved, which is the same answer as for one
 * that never called an aliased tool at all — and deliberately so: both
 * are "nothing to tell this person about".
 */
export function oldNamesStillCalled(record: RecordedClientCalls): DeprecatedToolName[] {
  const entries: DeprecatedToolName[] = [];
  for (const entry of DEPRECATED_TOOL_NAMES) {
    if (record.spellings[entry.replacement] === entry.deprecated) entries.push(entry);
  }
  return entries;
}

/**
 * Which client EO can register with a client that calls itself this is,
 * or null.
 *
 * `clientInfo.name` is whatever the program decided to send, and the
 * three EO knows how to register with each send something recognisable
 * but not identical to EO's own id — Claude Desktop calls itself
 * `claude-ai`, the CLIs call themselves after their command. Matched on
 * a normalised form so a capital letter or a space does not lose the
 * row.
 *
 * Null is an ordinary answer rather than a failure: anything can connect
 * to this server — a script, `mcp-remote`, an editor EO has never heard
 * of — and its row is shown under the name it gave rather than dropped,
 * because a client EO cannot name is exactly the one nobody will think
 * to check.
 */
export function clientIdFor(reported: string): ClientId | null {
  const normalised = reported.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  if (normalised.includes("claude-desktop") || normalised.includes("claude-ai")) return "claude-desktop";
  if (normalised.includes("claude-code")) return "claude-code";
  if (normalised.includes("codex")) return "codex";
  return null;
}
