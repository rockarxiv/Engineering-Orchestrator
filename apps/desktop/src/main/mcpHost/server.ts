import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
// Type-only, so it is erased at build time and does not defeat the lazy
// runtime import below — but the compiler still checks what this file
// hands back against what the SDK will accept.
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Db } from "../db/client.js";
import { dispatchIpc } from "../ipc/registry.js";
import { gateRefusal, readMcpConfig, toolAllowed, toolOffered, toolsFor, type McpAudience } from "./gate.js";
import { canonicalToolName, withActingAgent, withPathsFrom, type PathsFrom } from "@eo/core";
import { TOOLS, type Dispatch, type ToolSpec } from "./catalog.js";
import { GUIDES, guideNamed } from "./guides.js";
import { toLegacyShape } from "./legacyNames.js";
import { recordToolCall } from "./aliasUse.js";
import { resolveItemKeys } from "./itemKeys.js";
import { narrowAnswer, splitArguments, withinBudget, type Narrowing, type NarrowedAnswer } from "./narrow.js";

/**
 * The one module that knows `@modelcontextprotocol/sdk` exists.
 *
 * The SDK is imported dynamically for two reasons. The host is off by
 * default, so someone who never turns it on never pays for loading
 * express, hono and jose. And if the module ever fails to resolve —
 * someone moves the dependency, or a packaging exclusion catches it the
 * way the `@anthropic-ai/**` rule in electron-builder.yml catches its
 * neighbour — the app must start anyway. EO without its MCP host is EO;
 * EO that refuses to launch because a socket could not be opened is a
 * support item.
 *
 * If the SDK ever has to go, the replacement surface is this file's
 * exported interface — `handleRequest`, `notifyToolsChanged`, `close` —
 * and catalog.ts, render.ts and gate.ts are untouched by the swap. The
 * protocol beneath it is JSON-RPC 2.0, which eoServer.mjs already
 * hand-rolls over stdio; what would have to be written here is the
 * Streamable HTTP part, which is the expensive half.
 */

export const MCP_SERVER_NAME = "eo";

/**
 * What a model is told before it reads a single tool name.
 *
 * The first paragraph is the one that earns its place. A model that
 * cannot find "create item" does not conclude there isn't one — it
 * invents an item id and calls ticket_update, or looks for a way in
 * through Jira it has not been given. Saying the door does not exist,
 * and naming the two that do, is cheaper than any amount of tool
 * description.
 *
 * The last paragraph is here for the opposite reason: everything the
 * guides hold is deliberately *not* here, and something has to say they
 * exist. `prompts/list` is a call most clients never make and `eo_guide`
 * is one name among thirty, so without a line in the always-loaded text
 * three pages of procedure are present and unfindable. A clause each is
 * enough to pick one; the guide itself is free until fetched.
 */
export const SERVER_INSTRUCTIONS = [
  "EO drives a feature request from an idea to a ready-to-merge pull request by dispatching role-based coding agents",
  "against a dependency-ordered ticket graph. These tools do what the person at EO's keyboard can do.",
  "",
  "There is no tool that makes a ticket from a title, and that is deliberate: work nothing has thought about is",
  "work typed straight into a column. What you can hand over is a plan you have already agreed with the person you",
  "are working with — work_submit_plan takes an understanding, the decisions you settled and stories with",
  "acceptance criteria, and creates a feature with those stories under it, on a pipeline. It is the same shape and",
  "the same validation EO's own system agent goes through. Agree the work first, then submit it whole.",
  "",
  "Comments are the only communication channel. To ask a person something, or to hand work to an agent, post a",
  "comment that mentions them with comment_post. There is no separate inbox to write to.",
  "",
  "A refusal is not a failure. Tools that move, hold, resume or delete a ticket answer 'no, and here is why' on a",
  "successful call — usually because an agent is working on the ticket. Read the text and the structured fields",
  "before retrying, and never retry the same call unchanged.",
  "",
  "EO only moves a ticket through its pipeline's own routes; nothing here writes a ticket's step directly.",
  "",
  "Longer procedure lives in EO's guides — the eo_guide tool, or the same text as an MCP prompt of the same name.",
  "Read the one that fits before a first attempt rather than after a refusal: eo_orient for the model and vocabulary",
  "these tools assume, eo_submit_work for what a plan or a ticket must carry to be accepted, eo_change_pipeline",
  "before editing a pipeline graph, eo_unblock when nothing is moving.",
].join("\n");

/**
 * The SDK's own types, not a hand-written stand-in for them.
 *
 * An earlier version declared narrow `SdkServer`/`SdkTransport`
 * interfaces and cast to them, which reads as caution and is the
 * opposite: `LoadedSdk` already carries the real constructors via
 * `typeof import(...)`, so casting away from them was throwing out the
 * only thing that would notice the SDK renaming `sendToolListChanged` or
 * changing `handleRequest`'s signature. That failure would then surface
 * on a packaged launch, which is the class of bug `packaging.test.ts`
 * exists to prevent one file over.
 */
type SdkServer = InstanceType<LoadedSdk["Server"]>;
type SdkTransport = InstanceType<LoadedSdk["StreamableHTTPServerTransport"]>;

interface Session {
  server: SdkServer;
  transport: SdkTransport;
  lastSeen: number;
  /** Who opened it, as `ProtocolHostOptions.sessionOwner` named them — null on a host that names nobody. */
  owner: string | null;
}

/**
 * How many clients may hold a session at once, and how long an idle one
 * survives.
 *
 * Both are backstops rather than policy: this is a single-user machine,
 * so eight is already more editors than anyone has open, and a client
 * that goes away without sending DELETE would otherwise leave its
 * session behind until the app quits.
 *
 * A backstop is not enough where every client goes away without one
 * (EO-444). The admin host is reached by a CLI EO spawns per turn, and
 * neither backend's CLI sends DELETE when it exits — so eight turns in
 * half an hour filled the cap with dead sessions and the ninth was
 * refused. That host therefore names who opened each session
 * (`sessionOwner`) and closes them itself when the turn is over
 * (`closeSessionsOf`); the idle timeout is left for clients nobody is
 * keeping track of.
 */
const MAX_SESSIONS = 8;
const SESSION_IDLE_MS = 30 * 60 * 1000;

export interface McpProtocolHost {
  handleRequest: (req: IncomingMessage, res: ServerResponse, parsedBody?: unknown) => Promise<void>;
  notifyToolsChanged: () => void;
  /**
   * Closes every session `owner` opened, and answers how many there were
   * (EO-444). What frees a slot under `MAX_SESSIONS` when the client
   * behind it has gone without sending DELETE.
   */
  closeSessionsOf: (owner: string) => Promise<number>;
  /** How many sessions are open — what counts against `MAX_SESSIONS`, for a status line and the tests that hold it. */
  sessionCount: () => number;
  close: () => Promise<void>;
}

export type StartProtocolResult = { ok: true; host: McpProtocolHost } | { ok: false; problem: string };

/**
 * The names this server answers to.
 *
 * Passed in rather than read off the request, which would be circular —
 * a check that allows whatever the caller claimed is not a check.
 *
 * A function rather than a value because the port is not known until the
 * socket is bound, and the socket cannot be bound until this host
 * exists to serve it. Asked for per request, so the answer is always the
 * port EO is actually on.
 */
export type AllowedNames = () => { hosts: string[]; origins: string[] };

/**
 * What differs between the two hosts EO runs on this code (EO-182).
 *
 * Both are the same protocol over the same catalogue reaching the same
 * `dispatchIpc`; what separates them is who is at the other end. The
 * external one answers a stranger holding a token, so its tool list is
 * whatever `mcp.dangerousOperations` says. The internal one answers a
 * process EO spawned itself, and there is no stranger for that switch to
 * be about — so it passes a gate that is always open.
 *
 * A function rather than a boolean because the external host's answer
 * changes while a client is connected: the switch is read per request,
 * which is what makes flipping it take effect on the next call rather
 * than the next launch.
 */
export interface ProtocolHostOptions {
  /** What this server calls itself at initialize. Defaults to `eo`. */
  name?: string;
  /** Whether the destructive tools are offered. Defaults to the `mcp.dangerousOperations` setting. */
  dangerousOperations?: () => boolean;
  /**
   * Which of EO's two listeners this is (EO-192).
   *
   * A value rather than something inferred from `name`, because a name
   * is a label a caller passes and this decides what a client can reach.
   * Defaults to `external`, which is the fail-safe direction: the host
   * that needs the wider surface asks for it, and anything built later
   * that forgets gets the narrower one.
   */
  audience?: McpAudience;
  /**
   * A refusal decided outside this directory, consulted before a tool
   * runs (EO-356): the tool's own name and its arguments in, a sentence
   * to answer with — and nothing executed — or null to let it through.
   *
   * A function handed in rather than a rule written here, because the
   * rules that need one read EO's state (which runs are live, which
   * module a conversation is about) and this directory reaches EO only
   * through registered handlers. The admin host is given one; the
   * external host, which answers a person's own client, is not.
   */
  refuseCall?: (tool: string, args: unknown) => string | null;
  /**
   * Told of every call a tool answered (EO-501): the tool's own name, the
   * arguments it was called with, and the data it answered with — the
   * structured answer, before any of it is turned into prose for the
   * client. Only for calls that ran: one refused, gated or failed is not
   * reported.
   *
   * For a rule that has to know what a call *did*, read from EO's own
   * answer rather than from the text a backend kept of it: a run's log
   * holds that text bounded, and quotes whatever the call echoed back.
   * Like `refuseCall`, handed in, because the rules read EO's state. It
   * can never change the answer, and an observer that throws is reported
   * and does not fail the call.
   */
  observeCall?: (tool: string, args: unknown, data: unknown) => void;
  /**
   * Who a request is from, for a host whose caller keeps track of its
   * clients (EO-444): read off an initialize request, and written on the
   * session it opens so that `closeSessionsOf` can find it again. Null —
   * and so is the default — for a client nobody is tracking.
   *
   * Null from a host that has this is a refusal, not an anonymous
   * session: the credential was checked before the request's body was
   * read, and an owner let go of in between must not open one. And it
   * is asked again once the session has been opened, for an owner let go
   * of while the handshake itself was in flight. Either way round, a
   * session `closeSessionsOf` has already missed is never left behind.
   */
  sessionOwner?: (req: IncomingMessage) => string | null;
  /**
   * Which system agent a session's owner is, or null for one that is the
   * person (EO-585). Asked at each call rather than once at initialize,
   * so a turn let go of mid-session acts as nobody's agent rather than
   * as a stale one. Only the administrative host has an answer: its
   * owners are turns, and each turn's credential was minted for one
   * agent. A host without this acts for the person, as every host did.
   */
  actingAgent?: (owner: string) => string | null;
  /**
   * Where a call on this host may name files by path from, for
   * `comment_post`'s `paths` (EO-700), asked per call with the session's
   * owner. Absent, the audience decides: the external host's client acts
   * on a credential the person handed it and may name any file their
   * account can read, while the administrative host — whose owners are
   * turns — names none unless it says which directory a turn runs in.
   * The fail-safe direction, as `audience`'s default is.
   */
  pathsFrom?: (owner: string | null) => PathsFrom;
}

/** What a host grants when it says nothing: see `ProtocolHostOptions.pathsFrom`. */
export function defaultPathsFrom(audience: McpAudience): PathsFrom {
  return audience === "external" ? { kind: "anywhere" } : { kind: "directory", directory: null };
}

/**
 * The channels a tool may reach, and no others.
 *
 * `dispatchIpc` will invoke anything that is registered, and one of the
 * registered channels — `mcp:getStatus` — returns this server's own
 * bearer token in full. That a connected client cannot reach it was,
 * until this line, a property of the catalog happening not to name it,
 * enforced by a test. One catalog entry, or one tool that derived its
 * channel from an argument, was the whole distance between "connected
 * client" and "connected client holds the credential".
 *
 * So the seam is narrowed to the union of what the catalog declares.
 * The test in catalog.test.ts stays — it fails earlier and says more —
 * but it is no longer the only thing standing there.
 */
const REACHABLE_CHANNELS: ReadonlySet<string> = new Set(TOOLS.flatMap((tool) => tool.channels));

const dispatch: Dispatch = (channel, payload) => {
  if (!REACHABLE_CHANNELS.has(channel)) {
    return Promise.resolve({ ok: false as const, error: { message: `"${channel}" is not reachable over MCP.` } });
  }
  return dispatchIpc(channel, payload);
};

/**
 * The same seam, with the system agent that is asking put on what it
 * sends (EO-585) — or the seam itself, for a call that is the person's.
 *
 * Stamped here, below every tool, rather than by any of them: a tool
 * deletes whatever a client sent under the same name before it
 * dispatches (`spelledTool`), and this is the one place that knows which
 * turn the call arrived on.
 */
function dispatchAs(actingAgentId: string | null, pathsFrom: PathsFrom): Dispatch {
  // And where this caller may name files from (EO-700), stamped here for
  // the same reason: the tool has taken off whatever a client sent under
  // that name, and only the host knows who is at the other end.
  return (channel, payload) => dispatch(channel, withPathsFrom(channel, actingAgentId === null ? payload : withActingAgent(channel, payload, actingAgentId), pathsFrom));
}

/**
 * The tool a client named, if this listener offers it.
 *
 * Audience-aware, so `tools/call` cannot reach what `tools/list` did not
 * show — a client can call a tool it was never shown, which is the same
 * reason the gate is re-checked below. Undefined for an admin-only tool
 * on the external host, and the caller then answers exactly what it
 * answers for a name nobody has: from out there, it does not exist.
 */
function toolNamed(name: unknown, audience: McpAudience): ToolSpec | undefined {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  return tool !== undefined && toolOffered(tool, audience) ? tool : undefined;
}

/**
 * The answer to one `tools/call`, whole — what a client actually
 * receives.
 *
 * Exported because this, and not `ToolSpec.run`, is the result the
 * story's first criterion is about: the translation on the way out
 * happens here, one layer above the tool, so a test that stopped at
 * `run` would be proving something narrower than what a client reads.
 * `aliases.test.ts` calls this. The request handler below is a thin
 * adapter onto it, and is the only other caller.
 */
export async function answerToolCall(
  call: { name: unknown; arguments?: unknown },
  audience: McpAudience,
  dangerousOperations: boolean,
  refuseCall?: (tool: string, args: unknown) => string | null,
  observeCall?: (tool: string, args: unknown, data: unknown) => void,
  actingAgentId: string | null = null,
  pathsFrom: PathsFrom = defaultPathsFrom(audience),
): Promise<CallToolResult> {
  const tool = toolNamed(call.name, audience);
  if (!tool) {
    return { isError: true, content: [{ type: "text", text: `EO has no tool named "${String(call.name)}".` }] };
  }
  // By EO's own name, so a rule about `module_save` cannot be walked
  // round through an alias of it (KAN-162).
  const refused = refuseCall?.(canonicalToolName(tool.name), call.arguments ?? {}) ?? null;
  if (refused !== null) return { isError: true, content: [{ type: "text", text: refused }] };
  return callTool(tool, call.arguments ?? {}, dangerousOperations, observeCall, dispatchAs(actingAgentId, pathsFrom));
}

/** What one tool call answers with, in MCP's shape. */
async function callTool(
  tool: ToolSpec,
  args: unknown,
  dangerousOperations: boolean,
  observeCall: ((tool: string, args: unknown, data: unknown) => void) | undefined,
  dispatch: Dispatch,
): Promise<CallToolResult> {
  // Re-checked here and not only in tools/list, because a client can call
  // a tool it was never shown — a stale list, or one that simply guessed.
  if (!toolAllowed(tool, dangerousOperations)) {
    // EO's own name for it, not the door it was called through, for the
    // reason `canonicalToolName` gives: both halves of an aliased pair
    // have to refuse in the same words (KAN-162).
    return { isError: true, content: [{ type: "text", text: gateRefusal(canonicalToolName(tool.name)) }] };
  }

  // The narrowing parameters are the host's, not the tool's (EO-538):
  // taken off before the tool sees the call, so its own schema and its
  // channel's are exactly what they were, and applied to its answer
  // below. A read tool is the only kind that has any.
  const split = splitArguments(args, tool.narrowing ?? []);
  if (!split.ok) {
    return {
      isError: true,
      content: [{ type: "text", text: `Invalid arguments for "${canonicalToolName(tool.name)}". Nothing was read.\n${split.issues.map((issue) => `- ${issue}`).join("\n")}` }],
    };
  }

  // An item's key where its id is asked for (EO-539), turned into the id
  // before the tool runs — so the tool, its channel and its handler see
  // what they always saw, and a key naming nothing reaches none of them.
  const resolved = await resolveItemKeys(dispatch, split.rest, tool.itemKeys ?? []);
  if (!resolved.ok) {
    return { isError: true, content: [{ type: "text", text: `${resolved.message} ${tool.kind === "read" ? "Nothing was read." : "Nothing was changed."}` }] };
  }

  // Narrowed over the whole list where a tool's channel pages its own
  // (`ToolSpec.runWhole`); otherwise the tool answers as it always has.
  const run = split.narrowing !== null && tool.runWhole !== undefined ? tool.runWhole : tool.run;
  const outcome = await run(dispatch, resolved.args);
  if (!outcome.ok) {
    const detail = outcome.issues && outcome.issues.length > 0 ? `\n${outcome.issues.map((issue) => `- ${issue}`).join("\n")}` : "";
    return { isError: true, content: [{ type: "text", text: `${outcome.message}${detail}` }] };
  }

  if (observeCall) {
    try {
      observeCall(canonicalToolName(tool.name), args, outcome.data);
    } catch (error) {
      // The call has run and its answer stands; what watched it failing is not the caller's problem.
      console.error(`[eo] observing ${tool.name} failed:`, error);
    }
  }

  const shaped = toLegacyShape(outcome.data);
  const answer = await narrowedAnswer(tool, outcome.text, shaped, outcome.refused, split.narrowing, resolved.args, dispatch);
  if (answer !== null && "message" in answer) return { isError: true, content: [{ type: "text", text: answer.message }] };
  if (answer !== null) {
    return { isError: false, content: [{ type: "text", text: answer.text }], structuredContent: answer.data };
  }
  return {
    // False even when the answer is a refusal: `items:move` answering
    // "no, an agent is working on it" is a successful call whose answer
    // is no, and reporting it as a protocol error would tell a model its
    // request was malformed when it was merely declined.
    isError: false,
    content: [{ type: "text", text: outcome.text }],
    // `structuredContent` must be an object, and a few channels answer
    // with null or an array — wrapped rather than dropped, so the
    // machine-readable copy is never the thing that goes missing.
    //
    // Translated to the old spelling on the way past (legacyNames.ts).
    // This is the last place EO's own vocabulary is EO's own: a client
    // that registered against `ticket_get` reads `ticket`, `ticketId`
    // and `ticketKey` out of the answer, and freezing the arguments
    // while letting the answer change would have left it calling a tool
    // successfully and unable to read what came back.
    //
    // Every tool, `item_get` included, and that is deliberate (KAN-162).
    // An alias whose answer came back in a different shape from the
    // name it aliases would be a second tool: the story's criterion is
    // that a pair returns identical results for identical inputs, so
    // the vocabulary on the wire is a property of this boundary and not
    // of which of a tool's two names was called. What the twin does
    // carry in EO's own words is the arguments it *advertises* — see
    // `channelTool` — and the release that retires the old names is
    // where the answers follow.
    structuredContent: isPlainObject(shaped) ? shaped : { result: shaped },
  };
}

/**
 * A read answer narrowed to what the caller asked for, or cut to the
 * size budget — or null, when it goes out as the tool wrote it.
 *
 * Applied to the answer in the spelling a client reads, so the paths a
 * caller names are the ones it sees (`tickets.key`, not `items.key`),
 * and built once into both copies: the structured data, and the text,
 * which is a one-line summary over compact JSON of that same data.
 *
 * A refusal is never narrowed. It is a sentence saying why not, and
 * filtering it would hand back an empty list that looks like an answer.
 *
 * An answer over the budget from a tool whose channel pages its own list
 * is cut from the whole list, not from the page `run` read: the first
 * page and its `total` have to describe everything there is, and
 * `run_events` reads only 200 events of however many the run has. So it
 * is read again through `runWhole` — only then, because an answer under
 * the budget goes out as the tool wrote it and costs nothing more. A
 * failure of that second read is reported rather than covered with a
 * count that would be wrong.
 */
async function narrowedAnswer(
  tool: ToolSpec,
  text: string,
  shaped: unknown,
  refused: boolean,
  narrowing: Narrowing | null,
  args: unknown,
  dispatch: Dispatch,
): Promise<NarrowedAnswer | { message: string } | null> {
  if (tool.narrowing === undefined || refused || !isPlainObject(shaped)) return null;
  if (narrowing !== null) return narrowAnswer(shaped, tool.list, narrowing);
  const name = canonicalToolName(tool.name);
  const cut = withinBudget(text, shaped, tool.list, name);
  if (cut === null || tool.runWhole === undefined) return cut;

  const whole = await tool.runWhole(dispatch, args);
  if (!whole.ok) {
    const detail = whole.issues && whole.issues.length > 0 ? `\n${whole.issues.map((issue) => `- ${issue}`).join("\n")}` : "";
    return { message: `${whole.message}${detail}` };
  }
  const wholeShaped = toLegacyShape(whole.data);
  if (whole.refused || !isPlainObject(wholeShaped)) return cut;
  return withinBudget(whole.text, wholeShaped, tool.list, name) ?? { text: whole.text, data: wholeShaped };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The three SDK modules this needs, or nothing.
 *
 * Loaded as one object behind one guard rather than three consts behind
 * three, because the closures below capture them and a narrowing that
 * has to hold across a function boundary is easier to write than to
 * argue with.
 */
interface LoadedSdk {
  Server: (typeof import("@modelcontextprotocol/sdk/server/index.js"))["Server"];
  types: typeof import("@modelcontextprotocol/sdk/types.js");
  StreamableHTTPServerTransport: (typeof import("@modelcontextprotocol/sdk/server/streamableHttp.js"))["StreamableHTTPServerTransport"];
}

async function loadSdk(): Promise<LoadedSdk | null> {
  try {
    const [server, types, transports] = await Promise.all([
      import("@modelcontextprotocol/sdk/server/index.js"),
      import("@modelcontextprotocol/sdk/types.js"),
      import("@modelcontextprotocol/sdk/server/streamableHttp.js"),
    ]);
    return { Server: server.Server, types, StreamableHTTPServerTransport: transports.StreamableHTTPServerTransport };
  } catch {
    return null;
  }
}

export async function startProtocolHost(
  db: Db,
  version: string,
  allowed: AllowedNames,
  options: ProtocolHostOptions = {},
): Promise<StartProtocolResult> {
  const serverName = options.name ?? MCP_SERVER_NAME;
  const dangerousOperations = options.dangerousOperations ?? (() => readMcpConfig(db).dangerousOperations);
  const audience = options.audience ?? "external";

  const sdk = await loadSdk();
  if (sdk === null) {
    return { ok: false, problem: "The MCP protocol library is not available in this build." };
  }
  // Destructured, not reached through `sdk`: a property access does not
  // carry the null check into the closures below, and a non-null
  // assertion at each use would be three claims where one is enough.
  const { Server, types, StreamableHTTPServerTransport } = sdk;

  const sessions = new Map<string, Session>();
  /**
   * Sessions being built but not yet in the map.
   *
   * `MAX_SESSIONS` used to be checked against `sessions.size`, which a
   * session only joins inside `onsessioninitialized` — after
   * `server.connect` and inside `transport.handleRequest`, so two awaits
   * later. Concurrent initialize requests therefore all observed an
   * empty map and all passed a cap that never fired. Reserving the slot
   * synchronously, before the first await, is what makes the number mean
   * something.
   */
  let reserved = 0;

  /**
   * What the client called itself at initialize, or null.
   *
   * Read off the initialize request rather than asked of the SDK, which
   * only knows it once the handshake it is in the middle of has
   * finished. Optional in the protocol's own schema — `clientInfo` is
   * required but a client that sends a malformed one still gets a
   * session, and a missing name is not grounds to refuse anybody.
   */
  function clientNameFrom(parsedBody: unknown): string | null {
    if (parsedBody === null || typeof parsedBody !== "object") return null;
    const params = (parsedBody as { params?: unknown }).params;
    if (params === null || typeof params !== "object") return null;
    const info = (params as { clientInfo?: unknown }).clientInfo;
    if (info === null || typeof info !== "object") return null;
    const name = (info as { name?: unknown }).name;
    return typeof name === "string" && name.trim() !== "" ? name : null;
  }

  function buildServer(client: string | null, owner: string | null): SdkServer {
    const server = new Server(
      { name: serverName, version },
      {
        // `listChanged` is not optimism: the destructive-operations
        // switch changes the tool list while a client is connected, and
        // without this the client would go on believing the list it was
        // handed at initialize.
        capabilities: {
          tools: { listChanged: true },
          // The guides. Fixed for the life of a build, so no listChanged.
          prompts: { listChanged: false },
        },
        instructions: SERVER_INSTRUCTIONS,
      },
    );

    server.setRequestHandler(types.ListToolsRequestSchema, () => ({
      tools: toolsFor(dangerousOperations(), audience).map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: { title: tool.name, ...tool.annotations },
      })),
    }));

    // Guides, over MCP's own mechanism for them.
    //
    // Prompts are what the protocol has for "here is how you do X" —
    // named, fetched on demand, and surfaced by clients as something a
    // person can pick. Tool descriptions cannot hold a procedure and
    // `instructions` is always-loaded context, so neither is the right
    // home for three pages of prose most sessions never need.
    server.setRequestHandler(types.ListPromptsRequestSchema, () => ({
      prompts: GUIDES.map((guide) => ({ name: guide.name, title: guide.title, description: guide.description })),
    }));

    server.setRequestHandler(types.GetPromptRequestSchema, (request) => {
      const guide = guideNamed(request.params?.name ?? "");
      if (!guide) throw new types.McpError(types.ErrorCode.InvalidParams, `EO has no guide named "${String(request.params?.name)}".`);
      return {
        description: guide.description,
        messages: [{ role: "user" as const, content: { type: "text" as const, text: guide.body } }],
      };
    });

    server.setRequestHandler(types.CallToolRequestSchema, (request) => {
      // Written down before the call is answered, and never in a way
      // that can change what the answer is: a client that is still on
      // `ticket_get` gets exactly what `item_get` would have given it
      // (KAN-162), and this is only so the *person* is told (KAN-178).
      // Wrapped because a failed write is not grounds to refuse a tool
      // call — the row going stale is a smaller harm than the call
      // failing for a reason the caller cannot act on.
      if (audience === "external" && client !== null && typeof request.params?.name === "string") {
        try {
          recordToolCall(db, client, request.params.name);
        } catch {
          // Nothing to do and nothing to say: see above.
        }
      }
      // Which system agent this turn is, asked now rather than at
      // initialize (EO-585): a call is the agent's only while the turn
      // that holds the credential is.
      const actingAgentId = owner === null ? null : (options.actingAgent?.(owner) ?? null);
      return answerToolCall(
        { name: request.params?.name, arguments: request.params?.arguments },
        audience,
        dangerousOperations(),
        options.refuseCall,
        options.observeCall,
        actingAgentId,
        options.pathsFrom?.(owner) ?? defaultPathsFrom(audience),
      );
    });

    return server;
  }

  /**
   * Out of the map at once, closed in the background.
   *
   * Both, as the shutdown path does. Closing only the transport leaves the
   * SDK `Server` and every handler registered on it alive for the life of
   * the process.
   */
  async function dropSession(id: string, session: Session): Promise<void> {
    sessions.delete(id);
    await Promise.allSettled([session.transport.close(), session.server.close()]);
  }

  function evictIdleSessions(): void {
    const cutoff = Date.now() - SESSION_IDLE_MS;
    for (const [id, session] of sessions) {
      if (session.lastSeen < cutoff) void dropSession(id, session);
    }
  }

  async function closeSessionsOf(owner: string): Promise<number> {
    const owned = [...sessions].filter(([, session]) => session.owner === owner);
    await Promise.allSettled(owned.map(([id, session]) => dropSession(id, session)));
    return owned.length;
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse, parsedBody?: unknown): Promise<void> {
    evictIdleSessions();

    const sessionId = req.headers["mcp-session-id"];
    const existing = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
    if (existing) {
      existing.lastSeen = Date.now();
      await existing.transport.handleRequest(req, res, parsedBody);
      return;
    }

    if (!types.isInitializeRequest(parsedBody)) {
      // Either a session that has been evicted or one that never
      // existed. The transport's own 400/404 would be indistinguishable
      // from a protocol fault, and "start again" is the actionable half.
      res.writeHead(404, { "content-type": "application/json" }).end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32001, message: "No such MCP session. Send an initialize request to start one." },
        }),
      );
      return;
    }

    // A host that keeps track of who opens its sessions opens none for
    // nobody (EO-444). The listener checked the credential on the
    // headers, before the body was read; a turn let go of while its
    // initialize body was still arriving reaches here with no owner, and
    // a session opened now would be one `closeSessionsOf` has already
    // looked for and missed — held against the cap for half an hour.
    const owner = options.sessionOwner ? options.sessionOwner(req) : null;
    if (options.sessionOwner && owner === null) {
      res.writeHead(401, { "content-type": "application/json", "www-authenticate": "Bearer" }).end(
        JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Unauthorized." } }),
      );
      return;
    }

    if (sessions.size + reserved >= MAX_SESSIONS) {
      res.writeHead(503, { "content-type": "application/json" }).end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32000, message: `EO is already serving ${MAX_SESSIONS} MCP sessions.` },
        }),
      );
      return;
    }

    reserved += 1;
    try {
      await openSession(req, res, parsedBody, owner);
    } finally {
      reserved -= 1;
    }
  }

  async function openSession(req: IncomingMessage, res: ServerResponse, parsedBody: unknown, owner: string | null): Promise<void> {
    // Built before the transport, because the transport's
    // `onsessioninitialized` fires during handleRequest and closes over it.
    const server = buildServer(clientNameFrom(parsedBody), owner);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id: string) => {
        sessions.set(id, { server, transport, lastSeen: Date.now(), owner });
      },
      onsessionclosed: (id: string) => {
        sessions.delete(id);
      },
      // Set here as well as in http.ts's own middleware. These are
      // marked @deprecated in the SDK in favour of external middleware,
      // which is why the real check lives there — but two cheap checks,
      // one of which cannot be deprecated out from under us, is the
      // right number for the one thing standing between a web page and
      // this socket.
      enableDnsRebindingProtection: true,
      allowedHosts: allowed().hosts,
      allowedOrigins: allowed().origins,
    });

    transport.onclose = () => {
      if (transport.sessionId !== undefined) sessions.delete(transport.sessionId);
    };

    await server.connect(transport);
    await transport.handleRequest(req, res, parsedBody);

    // Let go of while the handshake was in flight: `closeSessionsOf` ran
    // before this session was in the map to be found, so it is closed
    // here instead of sitting out the idle timeout (EO-444).
    const id = transport.sessionId;
    const opened = id === undefined ? undefined : sessions.get(id);
    if (id !== undefined && opened !== undefined && owner !== null && options.sessionOwner?.(req) !== owner) {
      await dropSession(id, opened);
    }
  }

  return {
    ok: true,
    host: {
      handleRequest,
      notifyToolsChanged: () => {
        // Fire-and-forget by design. The SDK resolves a notification with
        // nowhere to go rather than rejecting it, and the one thing that
        // can reject — a server no longer attached to a transport — is a
        // session `onclose` has already removed. `void` says the promise
        // is dropped on purpose rather than forgotten; it handles nothing,
        // because there is nothing here to handle.
        for (const session of sessions.values()) void session.server.sendToolListChanged();
      },
      closeSessionsOf,
      sessionCount: () => sessions.size,
      close: async () => {
        const open = [...sessions.values()];
        sessions.clear();
        await Promise.allSettled(open.map(async (session) => { await session.transport.close(); await session.server.close(); }));
      },
    },
  };
}
