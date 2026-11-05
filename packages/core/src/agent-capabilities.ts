import type { Agent } from "./domain.js";
import { MEMORY_NOTE_TOOL_NAME } from "./memory.js";
import { ADMIN_MCP_SERVER_NAME } from "./schemas/mcpServers.js";

/**
 * What an agent is allowed to reach, read out of its own config.
 *
 * One reader, because every capability question here is the same
 * question asked of the same field, and two readers of `allowedTools`
 * that disagree is a tool advertised and then refused.
 *
 * Keyed on named tools rather than on `agent.role`, which is the rule
 * the design states and `configToolsEnabled` already followed: roles are
 * configuration, somebody can rename one or write a second architect,
 * and a capability keyed on a role string stops working when they do.
 */

/** The full-thread read: an item and every comment on it, unbounded. */
export const THREAD_READ_TOOL = "thread_read";
/**
 * An agent's `allowedTools`, when it has one.
 *
 * Absent means the provider permits everything advertised — but it also
 * means nothing here is *granted*, and the predicates below answer no.
 * That asymmetry is deliberate and it fails safe for a step-owning agent
 * (no explicit grant, no unbounded read); where it does not fail safe is
 * a conversational role, which is why `buildTurnContext` names those
 * actions as well as asking this question.
 *
 * Exported since EO-314 so that the one reader stays one: an export
 * carries the tool surface a role asks for, and a second reader of this
 * field written over there would be a second opinion about what a grant
 * looks like.
 */
export function allowedToolsOf(config: Agent["config"]): string[] | null {
  const allowed = config["allowedTools"];
  return Array.isArray(allowed) ? allowed.filter((tool): tool is string => typeof tool === "string") : null;
}

/**
 * How EO's own tools are addressed once a provider has mounted them.
 *
 * The server calls a tool `ticket_detail`; every provider namespaces it
 * by the server it came from, so what an agent can actually call is
 * `mcp__eo__ticket_detail`. Exported because the dispatch context has to
 * *name* these tools in prose, and the bare name is not a name the agent
 * can use — see `eoToolName`.
 */
export const EO_TOOL_PREFIX = "mcp__eo__";

/**
 * The name to put in front of an agent, for a tool the eo server serves.
 *
 * Prose that says "read it with `ticket_detail`" is telling an agent to
 * call something that is not in its tool list under that name, and at
 * least one model answers by declaring the tool unavailable rather than
 * by going to look for it (EO-149: a Codex reviewer, whose MCP tools are
 * reachable only through a JS harness, refused a review on turn one
 * without a single call). The qualified name is the one every provider
 * advertises, so it is the one to write.
 */
export function eoToolName(name: string): string {
  return `${EO_TOOL_PREFIX}${name}`;
}

/**
 * Whether a config names a tool, in either form.
 *
 * The two spellings are the same grant: the Claude SDK sees
 * `mcp__eo__comment`, the tool calls itself `comment`, and a person
 * editing the list writes whichever they last saw.
 */
export function grantsTool(config: Agent["config"], ...names: string[]): boolean {
  const allowed = allowedToolsOf(config);
  if (allowed === null) return false;
  return names.some((name) => allowed.includes(name) || allowed.includes(eoToolName(name)));
}

/**
 * Whether this agent gets the whole comment thread.
 *
 * The one predicate behind two things that must never disagree: whether
 * the thread is *in* the dispatch prompt, and whether the agent can
 * *fetch* the thread. Deciding them separately is how a prompt comes to
 * say "search the rest with the tools" to an agent that has none, or
 * inlines 60k for one that could have asked.
 *
 * The conversational role — the system agent, in Discussions or in a
 * configure chat — answers true, because for it the thread is the work
 * rather than context about the work. Everything else is seeded and
 * reaches the rest by tool.
 */
export function fullThreadEnabled(agent: Pick<Agent, "config">): boolean {
  if (agent.config["enableFullThread"] === true) return true;
  return grantsTool(agent.config, THREAD_READ_TOOL);
}

/** Whether this agent may write a note into the thread mid-run. */
export function commentToolEnabled(agent: Pick<Agent, "config">): boolean {
  if (agent.config["enableCommentTool"] === true) return true;
  return grantsTool(agent.config, "comment");
}

/**
 * Whether this agent may write to memory mid-run with `memory_note`
 * (EO-479). A grant in `allowedTools` and nothing else, the way `comment`
 * is granted: there is no switch for it, so "can this agent write to
 * memory?" is answered by reading the list that decides it.
 */
export function memoryNoteEnabled(agent: Pick<Agent, "config">): boolean {
  return grantsTool(agent.config, MEMORY_NOTE_TOOL_NAME);
}

/**
 * A new agent's config with the `memory_note` grant (EO-593): every agent
 * whose runs are given memory scopes may write to them, whatever its role
 * and whoever wrote its instructions, and the instructions for doing so
 * are EO's own block rather than a paragraph of a role's prompt.
 *
 * Appended to an `allowedTools` list that lacks it, and a list of only it
 * where there is none — which narrows nothing, for the reason migration
 * 0126 gives: EO pins `bypassPermissions`, so on Claude a list
 * pre-approves rather than restricts, Codex does not read it, and every
 * other capability EO keys on a grant is still not granted. An
 * `allowedTools` that is not a list is somebody's to fix and is left.
 *
 * Only ever applied when an agent is made. Taking the grant out of one
 * agent's list is how a person stops it writing memory, and saving that
 * agent again must not undo it.
 */
export function withMemoryNoteGrant(config: Agent["config"]): Agent["config"] {
  if (grantsTool(config, MEMORY_NOTE_TOOL_NAME)) return config;
  const allowed = config["allowedTools"];
  if (allowed === undefined) return { ...config, allowedTools: [eoToolName(MEMORY_NOTE_TOOL_NAME)] };
  if (Array.isArray(allowed)) return { ...config, allowedTools: [...(allowed as unknown[]), eoToolName(MEMORY_NOTE_TOOL_NAME)] };
  return config;
}

/** Whether this agent may read the installation's configuration (pipelines, agents, runtimes). */
export function configToolsEnabled(agent: Pick<Agent, "config">): boolean {
  if (agent.config["enableConfigTools"] === true) return true;
  const allowed = allowedToolsOf(agent.config);
  if (allowed === null) return false;
  return allowed.some((tool) => tool.startsWith("mcp__eo__pipeline_") || tool.startsWith("mcp__eo__agent") || tool === "mcp__eo__runtimes_list");
}

/**
 * How a grant of EO's administrative server is spelled, in both forms.
 *
 * The same asymmetry `eoToolName` describes, one server along: what the
 * provider advertises is `mcp__eo_admin__pipeline_save`, and what a
 * person editing `allowedTools` by hand writes is whichever of the two
 * they last saw. A whole-server grant — `mcp__eo_admin`, which is Claude
 * Code's own spelling for "everything this server offers" — counts as
 * much as naming a tool under it, because that is the grant the system
 * agent actually carries.
 *
 * The bare `eo_admin` spelling is accepted for the reason `grantsTool`
 * accepts a bare tool name, and stops there. A bare *tool* name is not
 * accepted: `pipeline_save` is also what the `eo` server would call a
 * tool if it ever offered one, and a predicate that read an unqualified
 * word as a grant of this server would answer yes to an agent that had
 * been given something else entirely.
 *
 * **Both backends' spellings, through one parser (EO-314).** Codex sends
 * `eo_admin/pipeline_save` where Claude advertises
 * `mcp__eo_admin__pipeline_save` (EO-198, `roles/pipelineRead.ts`), and
 * a gate that read only the second would refuse a pack on one backend
 * and admit it on the other with every test still green — invariant #12
 * exactly. `mcpToolId` reads both and is the only thing here that reads
 * either.
 *
 * **This reads a spelling; it does not write one (EO-203).** There was an
 * `adminToolName` beside this — `eoToolName`'s twin — and the dispatch
 * context used it to tell an agent to call `mcp__eo_admin__view_current`.
 * That is Claude Code's punctuation for a tool id, Codex sends
 * `eo_admin/view_current`, and EO-198 established what naming one
 * backend's spelling in a prompt costs. It is gone rather than left
 * unused: an exported helper whose whole purpose is to put that string in
 * front of an agent is a helper somebody reaches for again. Prose names
 * the *server* now (`packages/engine/src/context.ts`), which is the one
 * part of a tool id that every backend agrees on. Accepting both
 * spellings *here* is the opposite problem and still right — this reads
 * what a person or a provider already wrote.
 */
function grantsAdminServer(tool: string): boolean {
  // The unprefixed spellings first, and they are matched here rather
  // than taught to the parser: `eo_admin` and `eo_admin__pipeline_save`
  // are what a *person* writes into the list by hand, and a parser that
  // read `something__else` as a server would turn every underscored tool
  // name into an MCP server on the capability lines. Safe to accept for
  // this one name because it is reserved — nothing else can be answering
  // under it.
  if (tool === ADMIN_MCP_SERVER_NAME || tool.startsWith(`${ADMIN_MCP_SERVER_NAME}__`)) return true;
  // And both of the spellings a *provider* advertises, through the one
  // parser — told the one server name this question is about, so that
  // `mcp__eo_admin__do__it` resolves to `eo_admin` exactly rather than
  // to whatever splitting the string happens to suggest.
  return mcpToolId(tool, [ADMIN_MCP_SERVER_NAME])?.server === ADMIN_MCP_SERVER_NAME;
}

/**
 * The server and tool a tool id names, in **either** backend's spelling
 * (EO-314, invariant #12).
 *
 * One parser, because there are two spellings of every tool EO hands an
 * agent and a check written around one of them refuses nothing on the
 * other while every test still passes (EO-198). Claude advertises
 * `mcp__eo_admin__pipeline_save`; Codex writes `${server}/${tool}`, so
 * the same grant arrives as `eo_admin/pipeline_save`. A pack carrying
 * the second form past a gate that only read the first is invariant #11
 * enforced on one backend and not the other — which is the failure this
 * function exists to make impossible to write twice.
 *
 * `tool` is null for a **whole-server** grant — `mcp__slack`, Claude
 * Code's own spelling for "everything this server offers". It is a
 * server named without a tool, not a malformed id, and the callers that
 * care about the server (a capability line, the admin gate) want it
 * while the callers that need a specific tool must refuse it.
 *
 * **Claude's spelling is ambiguous, so `knownServers` disambiguates
 * it.** `MCP_SERVER_NAME_PATTERN` permits an underscore anywhere, so
 * `slack__prod` is a legal server name and `mcp__slack__prod__list`
 * belongs equally to a `slack__prod` offering `list` and a `slack`
 * offering `prod__list`. Nothing in the string decides it; only knowing
 * which servers exist does. Every caller that holds such a list — the
 * capability lines, which have the catalogue and the pack's own
 * definitions, and the admin gate, which has one reserved name — passes
 * it, and the longest match wins because the longer name is the more
 * specific claim on the same string.
 *
 * With nobody to ask it splits on the **first** `__`, which is the guess
 * that fails safe for the gate: splitting on the last would read
 * `mcp__eo_admin__do__it` as the server `eo_admin__do`, which is not
 * EO's, and a pack asking for exactly that would be waved through. The
 * gate never relies on the guess anyway — it names `eo_admin` in
 * `knownServers` — so the fallback only ever decides a capability line
 * for a server nobody here has heard of.
 *
 * A bare word is nobody's server: `Read`, `Bash` and `comment` name no
 * server and get null, which is what stops a capability line inventing
 * an MCP server called `Bash` and what keeps an unqualified
 * `pipeline_save` from reading as EO's administrative one.
 */
export function mcpToolId(name: string, knownServers: readonly string[] = []): { server: string; tool: string | null } | null {
  if (name.startsWith(MCP_TOOL_PREFIX)) {
    const rest = name.slice(MCP_TOOL_PREFIX.length);
    if (rest === "") return null;

    // A name somebody can tell us about settles it. Longest first, so
    // `slack__prod` wins over a `slack` that also exists — the longer
    // name is the more specific claim on the same string.
    const known = [...knownServers].sort((left, right) => right.length - left.length);
    for (const server of known) {
      if (rest === server) return { server, tool: null };
      if (rest.startsWith(`${server}${MCP_NAME_SEPARATOR}`)) return { server, tool: rest.slice(server.length + MCP_NAME_SEPARATOR.length) };
    }

    const cut = rest.indexOf(MCP_NAME_SEPARATOR);
    return cut === -1 ? { server: rest, tool: null } : { server: rest.slice(0, cut), tool: rest.slice(cut + MCP_NAME_SEPARATOR.length) };
  }

  const cut = name.indexOf("/");
  if (cut <= 0) return null;
  const tool = name.slice(cut + 1);
  return { server: name.slice(0, cut), tool: tool === "" ? null : tool };
}

/** What Claude's spelling puts between the prefix, the server and the tool. */
const MCP_NAME_SEPARATOR = "__";

/** How every provider but Codex qualifies a tool by the server it came from. */
export const MCP_TOOL_PREFIX = "mcp__";

/**
 * Whether this agent holds EO's administrative tool surface — the whole
 * `mcpHost` catalogue, ungated, over the internal server EO runs for
 * itself (EO-182).
 *
 * Read off `allowedTools` and nothing else, which is the difference
 * between this and its two neighbours. `enableFullThread` and
 * `enableCommentTool` have a boolean spelling because they are switches
 * on a screen; this one deliberately does not. There is no tick box for
 * it and there should not be: the grant is a named surface in the list a
 * person edits, so "what can this agent reach?" is answered by reading
 * the same field that decides it.
 *
 * **An absent allowlist is no grant**, which is the failing-safe half of
 * the asymmetry `allowedTools` describes above and matters more here
 * than anywhere else on this page. Most agents have no `allowedTools`
 * at all; if absence meant "everything advertised", every one of them
 * would be handed the tools that rewrite EO's own configuration.
 *
 * Keyed on the grant rather than on `agent.role === "system"` for the
 * reason stated at the top of this file: roles are configuration.
 * Somebody can rename one, and a capability keyed on a role string stops
 * working the moment they do.
 */
export function adminToolsEnabled(agent: Pick<Agent, "config">): boolean {
  const allowed = allowedToolsOf(agent.config);
  if (allowed === null) return false;
  return namesAdminServer(allowed);
}

/**
 * Whether a tool list names EO's administrative server at all (EO-314).
 *
 * `adminToolsEnabled` asks it of an agent that exists here. This asks it
 * of a *list*, which is what a data pack carries: a pack ships its roles
 * with the tool surface each wants, and invariant #11 says no
 * step-owning agent may widen its own — a document that could hand
 * itself `eo_admin` would be data deciding `allowedTools`, which is the
 * one thing that invariant exists to prevent (ARCHITECTURE.md, "The `eo_admin` grant").
 *
 * One spelling of the grant, shared with the predicate above, so the
 * import gate and the dispatch cannot come to disagree about what
 * holding it looks like.
 */
export function namesAdminServer(allowed: readonly string[]): boolean {
  return allowed.some(grantsAdminServer);
}

/**
 * The MCP servers a tool list reaches, in the order it names them
 * (EO-314).
 *
 * What turns a pack's `allowedTools` into something a person can read.
 * The import preflight shows a pack's tool surface as **capabilities**,
 * one line per server — "reads your Slack channels" — rather than as
 * tool names (ARCHITECTURE.md, "A connector is an MCP server with a setup flow"), and the server is
 * the part of a
 * tool id that says which outside thing is being reached.
 *
 * Only qualified entries count, in either backend's spelling:
 * `mcp__slack__list_channels`, the whole-server `mcp__slack` and Codex's
 * `slack/list_channels` all name `slack` (`mcpToolId`).
 *
 * `knownServers` is what makes Claude's spelling readable at all where a
 * server's own name contains a double underscore — `mcp__slack__prod__list`
 * is `slack__prod`'s `list` or `slack`'s `prod__list`, and only a list of
 * the servers that exist can say which. Callers pass the names they hold:
 * the catalogue's, the pack's own definitions, and EO's reserved three. A bare `Read` or
 * `Bash` names no server and is not one — a line claiming an MCP server
 * called `Bash` would be an invention, and the reverse (reading a bare
 * `list_channels` as a server) is the mistake `grantsAdminServer` above
 * already refuses to make.
 */
export function mcpServersNamedIn(allowed: readonly string[], knownServers: readonly string[] = []): string[] {
  const found: string[] = [];
  for (const tool of allowed) {
    const server = mcpToolId(tool, knownServers)?.server;
    if (server !== undefined && !found.includes(server)) found.push(server);
  }
  return found;
}
