import { describe, expect, it } from "vitest";
import {
  ALIAS_RETIREMENT_VERSION,
  aliasNotice,
  aliasRetirementReached,
  canonicalToolName,
  deprecatedContextMethodsCalledIn,
  deprecatedToolsNamedIn,
  deprecatedToolName,
  deprecatedToolNamesIn,
  DEPRECATED_MODULE_CONTEXT_METHODS,
  DEPRECATED_TOOL_NAMES,
  deprecationNotice,
  replacementToolName,
  withAliasedToolNames,
} from "./deprecations.js";
import { eoToolName } from "./agent-capabilities.js";

describe("the names EO renamed but does not own the callers of", () => {
  it("pairs every deprecated name with a distinct replacement", () => {
    const deprecated = DEPRECATED_TOOL_NAMES.map((entry) => entry.deprecated);
    const replacements = DEPRECATED_TOOL_NAMES.map((entry) => entry.replacement);

    expect(new Set(deprecated).size).toBe(deprecated.length);
    expect(new Set(replacements).size).toBe(replacements.length);
    // And the two sets are disjoint: a name that is both an alias and
    // what something else is an alias for is a chain, and the widening
    // below only ever walks one hop.
    expect(deprecated.filter((name) => replacements.includes(name))).toEqual([]);
  });

  it("names every one of them with EO's own word", () => {
    // The whole point of the list. A pair whose replacement still says
    // "ticket" would be an alias to nowhere.
    const wrong = DEPRECATED_TOOL_NAMES.filter((entry) => /ticket/.test(entry.replacement) || !/item/.test(entry.replacement));

    expect(wrong).toEqual([]);
  });

  it("puts the retirement version in the notice, so nobody is told only that something is deprecated", () => {
    expect(deprecationNotice("item_get")).toBe(`Deprecated: use item_get; retired after v${ALIAS_RETIREMENT_VERSION}.`);
  });

  it("looks a pair up from either end", () => {
    expect(replacementToolName("ticket_get")).toBe("item_get");
    expect(deprecatedToolName("item_get")).toBe("ticket_get");
    expect(replacementToolName("item_get")).toBe(null);
    expect(replacementToolName("pipeline_get")).toBe(null);
  });

  /**
   * `work_submit_ticket` is the one whose rename is in the middle of the
   * name rather than at the front, so a pattern over the prefix would
   * have missed it — which is why this is a table and not a regex.
   */
  it("covers work_submit_ticket, whose word is not at the front", () => {
    expect(replacementToolName("work_submit_ticket")).toBe("work_submit_item");
  });

  it("says which of a list's names are on a clock, in either spelling", () => {
    expect(deprecatedToolNamesIn(["Read", "mcp__eo__ticket_detail", "mcp__eo__item_get"]).sort()).toEqual(["ticket_detail"]);
    expect(deprecatedToolNamesIn(["ticket_move", "ticket_move", "Bash"])).toEqual(["ticket_move"]);
    // The state the retirement story leaves an installation in.
    expect(deprecatedToolNamesIn(["mcp__eo__item_detail", "Read"])).toEqual([]);
  });

  /**
   * The rule that makes a pair answer identically, rather than nearly so.
   *
   * Every sentence EO produces about a tool names it this way, so the
   * two halves of an alias cannot differ in the one place a tool has
   * something to say about itself — a refusal, a gate message, an
   * invalid-argument report. The deprecation notice on the description
   * is the single exception, and the only place the old name is written.
   */
  it("names a tool by EO's own name whichever of its names was called", () => {
    expect(canonicalToolName("ticket_get")).toBe("item_get");
    expect(canonicalToolName("item_get")).toBe("item_get");
    // Everything outside the table is already its own name, so nobody
    // has to ask whether a name is aliased before writing it down.
    expect(canonicalToolName("pipeline_get")).toBe("pipeline_get");
  });

  it("names the module host's two methods as well, for the approval card to read", () => {
    expect(DEPRECATED_MODULE_CONTEXT_METHODS.map((entry) => entry.deprecated)).toEqual(["ctx.ticket", "ctx.ticketByKey"]);
    expect(DEPRECATED_MODULE_CONTEXT_METHODS.map((entry) => entry.replacement)).toEqual(["ctx.item", "ctx.itemByKey"]);
  });
});

/**
 * The half of the alias period nothing else can cover.
 *
 * EO's prompts name `mcp__eo__item_detail`; five migrations wrote
 * `mcp__eo__ticket_detail` into the `allowedTools` of the roles EO
 * ships. Without the widening, EO would be pointing an agent at a tool
 * its own allowlist does not permit — the tool advertised, the prose
 * naming it, and every call refused.
 */
describe("widening an allowlist so either spelling is a grant of both", () => {
  it("adds the replacement to a list that names the deprecated spelling", () => {
    expect(withAliasedToolNames(["Read", eoToolName("ticket_detail")])).toEqual(["Read", "mcp__eo__ticket_detail", "mcp__eo__item_detail"]);
  });

  it("adds the deprecated spelling to a list configured after the rename", () => {
    // Both directions, because both exist: a migrated installation holds
    // the old spelling and a fresh one holds the new, and neither should
    // have to be edited twice.
    expect(withAliasedToolNames([eoToolName("item_detail")])).toEqual(["mcp__eo__item_detail", "mcp__eo__ticket_detail"]);
  });

  it("keeps the prefix the entry was written with, bare included", () => {
    expect(withAliasedToolNames(["ticket_get"])).toEqual(["ticket_get", "item_get"]);
    expect(withAliasedToolNames(["mcp__eo_admin__ticket_get"])).toEqual(["mcp__eo_admin__ticket_get", "mcp__eo_admin__item_get"]);
  });

  it("adds nothing twice when a list already names both", () => {
    expect(withAliasedToolNames(["mcp__eo__ticket_detail", "mcp__eo__item_detail"])).toEqual(["mcp__eo__ticket_detail", "mcp__eo__item_detail"]);
  });

  /**
   * Adds only. A list that names neither spelling keeps naming neither —
   * writing one in would be granting a tool nobody granted, which on a
   * list that is the whole of what an agent may call is the opposite of
   * what this is for.
   */
  it("leaves a list that names nothing aliased exactly as it was", () => {
    expect(withAliasedToolNames(["Read", "Bash", "mcp__repo"])).toEqual(["Read", "Bash", "mcp__repo"]);
    expect(withAliasedToolNames([])).toEqual([]);
  });

  it("treats a whole-server grant as naming no tool, because it already covers both", () => {
    expect(withAliasedToolNames(["mcp__eo"])).toEqual(["mcp__eo"]);
  });

  /**
   * Somebody else's contract. A third-party server with a tool of its
   * own called `ticket_get` is not EO's to rename, and writing
   * `mcp__github__item_get` into an allowlist would invent a grant for a
   * tool that does not exist.
   */
  it("widens only EO's own servers, not a third party that happens to use the word", () => {
    expect(withAliasedToolNames(["mcp__github__ticket_get"])).toEqual(["mcp__github__ticket_get"]);
  });
});

/**
 * The half of the alias period that is about the person rather than the
 * agent (KAN-178).
 *
 * Three screens print these two sentences — the Servers screen, the pack
 * import preflight and a module's approval card — and the reason they
 * are functions in `@eo/core` rather than strings in three components is
 * that the design asked for *the same line* in all three.
 */
describe("what the person is shown", () => {
  it("names the release while there is still one to wait for", () => {
    expect(aliasNotice("client", false)).toBe(`uses ticket_* names · retired after v${ALIAS_RETIREMENT_VERSION}`);
    // The same sentence whichever surface is asking, which is the point
    // of it being one function.
    expect(aliasNotice("pack", false)).toBe(aliasNotice("client", false));
    expect(aliasNotice("module", false)).toBe(aliasNotice("client", false));
  });

  it("says what will break, and names it, once the deadline is the release you are on", () => {
    expect(aliasNotice("client", true)).toBe("uses ticket_* names · this client will stop working on update");
    expect(aliasNotice("pack", true)).toBe("uses ticket_* names · this pack will stop working on update");
  });

  it("reads the deadline off major and minor, and ignores everything after them", () => {
    expect(aliasRetirementReached("0.0.0")).toBe(false);
    expect(aliasRetirementReached("0.0.9")).toBe(false);
    expect(aliasRetirementReached("0.1.0")).toBe(true);
    expect(aliasRetirementReached("0.1.3-rc.2")).toBe(true);
    expect(aliasRetirementReached("1.0.0")).toBe(true);
    expect(aliasRetirementReached("v0.1.0")).toBe(true);
  });

  /**
   * The direction that cannot mislead. A version EO cannot read is a
   * placeholder or a git describe, and telling somebody their client is
   * about to break when it is not is how a warning stops being read.
   */
  it("treats a version it cannot read as not yet", () => {
    expect(aliasRetirementReached("")).toBe(false);
    expect(aliasRetirementReached("dev")).toBe(false);
  });
});

describe("what a document still names", () => {
  it("finds a shipped prompt's tool name in either spelling", () => {
    expect(deprecatedToolsNamedIn("Read one with `mcp__eo__ticket_detail`.").map((entry) => entry.deprecated)).toEqual(["ticket_detail"]);
    expect(deprecatedToolsNamedIn("call ticket_move then ticket_get").map((entry) => entry.replacement)).toEqual(["item_get", "item_move"]);
  });

  it("says nothing about a prompt that has been updated", () => {
    expect(deprecatedToolsNamedIn("Read one with `mcp__eo__item_detail`, then item_move it.")).toEqual([]);
  });

  /**
   * The prefix is spelled out in the pattern rather than left to `\b`,
   * which sees no boundary between an underscore and a letter — so
   * without it `my_ticket_detail_helper` would be read as a mention.
   */
  it("does not mistake a longer identifier for one of EO's names", () => {
    expect(deprecatedToolsNamedIn("my_ticket_detail_helper() and ticket_detailed")).toEqual([]);
  });

  it("finds the module host methods a module actually calls", () => {
    expect(deprecatedContextMethodsCalledIn("const it = await ctx.ticket();").map((entry) => entry.replacement)).toEqual(["ctx.item"]);
    expect(deprecatedContextMethodsCalledIn("await ctx . ticketByKey('KAN-1')").map((entry) => entry.deprecated)).toEqual(["ctx.ticketByKey"]);
  });

  /**
   * `ctx.ticket(` must not match inside `ctx.ticketByKey(`, or a module
   * calling one would be reported as calling both — and the open bracket
   * is what keeps them apart.
   */
  it("tells the two methods apart, and ignores a module that has moved", () => {
    expect(deprecatedContextMethodsCalledIn("await ctx.ticketByKey(key)").map((entry) => entry.deprecated)).toEqual(["ctx.ticketByKey"]);
    expect(deprecatedContextMethodsCalledIn("await ctx.item(); await ctx.itemByKey(key);")).toEqual([]);
  });

  it("ignores prose about the rename, which is a mention rather than a call", () => {
    expect(deprecatedContextMethodsCalledIn("// ctx.ticket was renamed to ctx.item")).toEqual([]);
  });
});
