import { EO_TOOL_PREFIX } from "./agent-capabilities.js";
import { ADMIN_MCP_SERVER_NAME } from "./schemas/mcpServers.js";

/**
 * The names EO renamed but does not own the callers of (KAN-162).
 *
 * KAN-145 renamed the entity to `item` everywhere EO owns — the tables,
 * the IPC contract, the schemas, the engine, the renderer. Three
 * contracts were left alone, because renaming them would break somebody
 * else's code on EO's schedule (`ARCHITECTURE.md`, "Vocabulary"):
 *
 * - the MCP tool names in `mcpHost/catalog.ts` that Claude Code, Codex
 *   and Claude Desktop registered against through `mcp:registerWith`;
 * - `ticket_detail`, which EO's own service advertises and which every
 *   shipped prompt named;
 * - the module host's `ctx.ticket()` and `ctx.ticketByKey()`, called by
 *   user-authored modules approved by the hash of their code, so that
 *   their bodies cannot change without a person re-approving them.
 *
 * This file is where the two halves of that arrangement are written
 * down: which old name maps to which new one, and the release the old
 * one stops resolving after. It is deliberately in `@eo/core` rather
 * than beside any one of the three surfaces, because four of them read
 * it — the MCP catalog, EO's own service, the module host, and the
 * screens that tell the person which state their installation is in.
 *
 * ## Why the person is told at all
 *
 * Invariant #12: a capability reaches both backends, or names the one it
 * does not — and an absence is never left to be discovered by an agent.
 * An alias period is a scheduled absence. The Servers screen, the pack
 * import preflight and a module's approval card all read this list so
 * that "your client still calls `ticket_get`" is something a person is
 * shown before it stops working, rather than something they find out
 * from a client that broke.
 */

/**
 * The release the aliases below stop resolving after.
 *
 * One string, in one place, because it appears in every tool
 * description, in the module host's deprecation line and on three
 * screens — and a version written down five times is a version that
 * disagrees with itself the day one of them is edited.
 *
 * EO has never shipped a numbered release: every `package.json` in the
 * workspace says `0.0.0`, which is the placeholder a build stamps over.
 * So this names the release the aliases are retired *after* rather than
 * reading a current version off anything — "one release" is a decision
 * about the next one, and the story that removes the aliases is the one
 * that has to bump this.
 */
export const ALIAS_RETIREMENT_VERSION = "0.1";

/** One name a caller registered against, and the name to use instead. */
export interface DeprecatedToolName {
  /** What an installed client, or a shipped prompt, still says. */
  readonly deprecated: string;
  /** EO's own name for the same tool. Identical behaviour, identical answer. */
  readonly replacement: string;
  /** Which server advertises the pair. `eo` is the service every dispatched agent talks to. */
  readonly server: "eo" | "eo_host";
}

/**
 * Every tool name that is an alias, and what it is an alias for.
 *
 * Ordered as the catalog offers them, which is the order a person
 * reading the Servers screen sees.
 *
 * `work_submit_ticket` is here despite not starting with `ticket_` — it
 * is the same rename in the middle of a name rather than at the front,
 * and a client that registered against it is in exactly the position
 * `ticket_get`'s is.
 *
 * `thread_read`, `comment_search` and their neighbours are *not* here.
 * They read an item and talk about one, but neither their names nor
 * their arguments carry the word, so there was nothing to rename and
 * nothing to alias.
 */
export const DEPRECATED_TOOL_NAMES: readonly DeprecatedToolName[] = [
  // EO's own service, which every dispatched agent talks to and every
  // shipped prompt names.
  { deprecated: "ticket_detail", replacement: "item_detail", server: "eo" },
  // The host external clients register against.
  { deprecated: "tickets_list", replacement: "items_list", server: "eo_host" },
  { deprecated: "tickets_list_archived", replacement: "items_list_archived", server: "eo_host" },
  { deprecated: "ticket_get", replacement: "item_get", server: "eo_host" },
  { deprecated: "work_submit_ticket", replacement: "work_submit_item", server: "eo_host" },
  { deprecated: "ticket_update", replacement: "item_update", server: "eo_host" },
  { deprecated: "ticket_move", replacement: "item_move", server: "eo_host" },
  { deprecated: "ticket_hold", replacement: "item_hold", server: "eo_host" },
  { deprecated: "ticket_resume", replacement: "item_resume", server: "eo_host" },
  { deprecated: "ticket_archive", replacement: "item_archive", server: "eo_host" },
  { deprecated: "ticket_delete", replacement: "item_delete", server: "eo_host" },
];

/**
 * The module host methods a module may still call (KAN-162).
 *
 * Separate from the tools because the failure mode is different in kind.
 * A tool name is a string a client sends and can be edited; `ctx.ticket()`
 * is a call inside a module body whose *hash* a person approved, so
 * changing the body means asking them again. Listed all the same,
 * because the approval card is one of the screens the design asks for.
 */
export const DEPRECATED_MODULE_CONTEXT_METHODS: readonly DeprecatedToolName[] = [
  { deprecated: "ctx.ticket", replacement: "ctx.item", server: "eo" },
  { deprecated: "ctx.ticketByKey", replacement: "ctx.itemByKey", server: "eo" },
];

/**
 * The sentence a deprecated tool's description is prefixed with.
 *
 * One sentence, at the front, so a model reading a tool list sees it
 * before the description it would otherwise act on. The retirement
 * version is in it because "deprecated" alone gives nobody a date to
 * plan against.
 */
export function deprecationNotice(replacement: string): string {
  return `Deprecated: use ${replacement}; retired after v${ALIAS_RETIREMENT_VERSION}.`;
}

/** EO's own name for a deprecated one, or null when the name is not an alias. */
export function replacementToolName(name: string): string | null {
  return DEPRECATED_TOOL_NAMES.find((entry) => entry.deprecated === name)?.replacement ?? null;
}

/** The deprecated name for one of EO's own, or null when nothing was ever called that. */
export function deprecatedToolName(replacement: string): string | null {
  return DEPRECATED_TOOL_NAMES.find((entry) => entry.replacement === replacement)?.deprecated ?? null;
}

/**
 * EO's own name for a tool, whichever of its names was called.
 *
 * **EO writes this name in every sentence it produces about a tool.** A
 * deprecated spelling is a door a client comes in through; it is not a
 * name EO says back out. That is one rule rather than a taste, and it is
 * what makes the two halves of a pair answer *identically*: a refusal
 * that named the tool it was called by would make `ticket_move` and
 * `item_move` differ in their text while agreeing on everything else,
 * which is the same tool giving two answers to one question.
 *
 * The deprecation notice on the description is the single exception, and
 * the only place the old name is acknowledged — because that is the one
 * sentence whose whole job is to say which name you used and which to
 * use instead.
 *
 * Hands back the name it was given when that name is already EO's own,
 * which is every tool outside the table, so a caller never has to ask
 * whether a name is aliased before writing it into a sentence.
 */
export function canonicalToolName(name: string): string {
  return replacementToolName(name) ?? name;
}

/**
 * The deprecated names an allowlist, or any list of tool names, still
 * uses — in whichever of the two spellings it wrote them.
 *
 * What the Servers screen, the import preflight and the approval card
 * are built on: given the names a client or an agent config carries,
 * which of them are on a clock. Empty means nothing here is aliased,
 * which is the state the retirement story leaves every installation in.
 */
export function deprecatedToolNamesIn(names: readonly string[]): string[] {
  const found = new Set<string>();
  for (const name of names) {
    const held = eoToolIn(name);
    if (held !== null && replacementToolName(held.bare) !== null) found.add(held.bare);
  }
  return [...found];
}

/**
 * An allowlist widened so that a grant of either spelling is a grant of
 * both.
 *
 * The half of the alias period nothing else can cover. An agent's
 * `allowedTools` is a list a *person* or a migration wrote — five
 * migrations put `mcp__eo__ticket_detail` into the roles EO ships — and
 * the prompts those agents read now name `mcp__eo__item_detail`. Without
 * this, EO would be pointing an agent at a tool its own allowlist does
 * not permit: the tool is advertised, the prose names it, and the call
 * is refused. That is invariant #12's failure mode exactly, and it is
 * worse than the rename it came from, because the agent would report the
 * tool missing on a run where EO believed it had provided it.
 *
 * Both directions, because both are real: an installation migrated from
 * before this holds the old spelling, and one configured after it holds
 * the new. Neither should have to be edited twice.
 *
 * Adds only. A list that names neither spelling keeps naming neither —
 * writing one would be granting a tool nobody granted.
 *
 * Not a widening of a tool *surface*, which invariant #11 forbids an
 * agent to do to itself: the name this adds is the same tool over the
 * same channel under its other name, so nothing becomes reachable that
 * the list did not already reach. And it is EO's decision rather than
 * the agent's — an agent has no way to ask for this and no way to
 * decline it.
 *
 * ## Both backends, and the one that needs nothing
 *
 * Invariant #12 asks whether a capability reaches both backends. This
 * one does: the Claude adapter is the only place `allowedTools` is read
 * — it is Claude Code's own option and EO passes it through — and Codex
 * has no allowlist, so an agent on that backend was never able to be
 * refused a tool it had been pointed at. Nothing is missing over there;
 * there is nothing to widen.
 */
export function withAliasedToolNames(names: readonly string[]): string[] {
  const out = [...names];
  for (const name of names) {
    const held = eoToolIn(name);
    if (held === null) continue;
    const twin = replacementToolName(held.bare) ?? deprecatedToolName(held.bare);
    if (twin === null) continue;
    const spelled = `${held.prefix}${twin}`;
    if (!out.includes(spelled)) out.push(spelled);
  }
  return out;
}

/**
 * One of EO's own tools named in a list, split into the prefix it was
 * written with and the tool itself — or null when the entry is not one.
 *
 * `mcp__eo__ticket_detail` and `ticket_detail` are the same grant, which
 * is `grantsTool` in agent-capabilities.ts's rule and where that
 * asymmetry is explained. A whole-server grant (`mcp__eo`) names no tool:
 * it already covers both spellings, so there is nothing to add.
 *
 * Restricted to EO's two servers and the bare form, because that is the
 * whole of what EO is entitled to widen. A third-party server with a
 * tool of its own called `ticket_get` is somebody else's contract, and
 * writing `mcp__github__item_get` into an allowlist would be inventing a
 * grant for a tool that does not exist.
 */
function eoToolIn(name: string): { prefix: string; bare: string } | null {
  for (const prefix of ["", EO_TOOL_PREFIX, `mcp__${ADMIN_MCP_SERVER_NAME}__`]) {
    if (!name.startsWith(prefix)) continue;
    const bare = name.slice(prefix.length);
    // Only the unqualified remainder: `mcp__eo__` followed by something
    // that is itself namespaced is not a tool this owns.
    if (bare !== "" && !bare.includes("__")) return { prefix, bare };
  }
  return null;
}

/**
 * Which of the three surfaces is being described (KAN-178).
 *
 * One word, substituted into one sentence, because the alternative is
 * three sentences that drift: the original design asks for "the same
 * line" on the Servers screen, the pack import preflight and a module's
 * approval card, and the only way to keep that true a year from now is
 * for there to be one line.
 */
export type AliasSubject = "client" | "pack" | "module";

/**
 * What a person is shown about something still on the old names.
 *
 * Two states rather than one, and the difference is a date passing
 * rather than anything the person did. Until the retirement release, the
 * old names still resolve and the line is a deadline — yellow, and it
 * says which release. Once that release is the one running, the next
 * update is what breaks this, and the line says so — red, and it names
 * the thing that will stop working rather than leaving "something".
 *
 * A deprecation line in a tool description would have said all of this
 * to the agent, which is invariant #12's failure mode exactly: the
 * capability is going away and the only party told is the one that
 * cannot act on it. This is the same fact, said to the person who can.
 */
export function aliasNotice(subject: AliasSubject, retired: boolean): string {
  return retired
    ? `uses ticket_* names · this ${subject} will stop working on update`
    : `uses ticket_* names · retired after v${ALIAS_RETIREMENT_VERSION}`;
}

/**
 * Whether the release the aliases are retired after is the one running.
 *
 * Major and minor only, and everything after them ignored: a build
 * stamps `0.1.3` or `0.1.0-rc.2` over the workspace's `0.0.0`
 * placeholder, and all three are the same release as far as a contract
 * that was promised "one more release" is concerned.
 *
 * Anything that does not parse — a placeholder, a git describe, an empty
 * string — is read as *not yet*, which is the direction that cannot
 * mislead: telling somebody their client is about to break when it is
 * not is how a warning stops being read.
 */
export function aliasRetirementReached(version: string): boolean {
  const parse = (text: string): [number, number] | null => {
    const match = /^v?(\d+)\.(\d+)/.exec(text.trim());
    return match ? [Number(match[1]), Number(match[2])] : null;
  };

  const current = parse(version);
  const retirement = parse(ALIAS_RETIREMENT_VERSION);
  if (current === null || retirement === null) return false;
  return current[0] > retirement[0] || (current[0] === retirement[0] && current[1] >= retirement[1]);
}

/**
 * A name written into a document EO does not own, in either spelling.
 *
 * `mcp__eo__ticket_detail` is what a prompt says and `ticket_detail` is
 * what a tool list says; both are the same tool, and both are what this
 * has to find. Anchored on either side against something that is not an
 * identifier character, so `my_ticket_detail_helper` is not a mention of
 * `ticket_detail` — the prefix is spelled out rather than left to `\b`,
 * which sees no boundary between the underscore and the name.
 */
function mentionPattern(name: string): RegExp {
  return new RegExp(`(?<![A-Za-z0-9_])(?:${EO_TOOL_PREFIX}|mcp__${ADMIN_MCP_SERVER_NAME}__)?${name}(?![A-Za-z0-9_])`);
}

/**
 * The aliased tools a piece of prose still names.
 *
 * A text scan, like `portabilityWarnings` and for the same reason: what
 * it reads is a prompt somebody wrote, and there is no parse of English
 * that would do better. Over-eager in the one direction that costs
 * nothing — a sentence *about* `ticket_get` counts as naming it, and the
 * line it produces is then true anyway.
 *
 * Ordered as `DEPRECATED_TOOL_NAMES` is, so two surfaces listing the
 * same document's findings list them the same way.
 */
export function deprecatedToolsNamedIn(text: string): DeprecatedToolName[] {
  return DEPRECATED_TOOL_NAMES.filter((entry) => mentionPattern(entry.deprecated).test(text));
}

/**
 * The module-host methods a module's source still calls.
 *
 * Calls rather than mentions, which is the difference between this and
 * the scan above: `ctx.ticket` is only the old contract when it is
 * invoked, and a comment in the code saying the author knows about the
 * rename should not light the card up. So the open bracket is part of
 * the pattern — which is also what keeps `ctx.ticket(` from matching
 * inside `ctx.ticketByKey(`.
 *
 * Whitespace is allowed around the dot and before the bracket because a
 * formatter is entitled to put it there, and a module is approved by the
 * hash of exactly the text somebody pasted.
 */
export function deprecatedContextMethodsCalledIn(code: string): DeprecatedToolName[] {
  return DEPRECATED_MODULE_CONTEXT_METHODS.filter((entry) => {
    const method = entry.deprecated.slice("ctx.".length);
    return new RegExp(`(?<![A-Za-z0-9_$.])ctx\\s*\\.\\s*${method}\\s*\\(`).test(code);
  });
}
