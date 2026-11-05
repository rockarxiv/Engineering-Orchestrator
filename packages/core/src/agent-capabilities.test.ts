import { describe, expect, it } from "vitest";
import { adminToolsEnabled, commentToolEnabled, configToolsEnabled, fullThreadEnabled, mcpServersNamedIn, mcpToolId, namesAdminServer } from "./agent-capabilities.js";
import { ADMIN_MCP_SERVER_NAME } from "./schemas/mcpServers.js";

/**
 * What an agent is allowed to reach, read out of its own config.
 *
 * These predicates are the single reader behind a pair of things that
 * must never disagree — what a prompt tells an agent it can do, and what
 * the provider is actually configured to let it call. The one that
 * carries the sharpest consequence is `adminToolsEnabled`: it decides
 * whether an agent is dispatched with the tools that rewrite EO's own
 * configuration, and everything about it is arranged to answer no unless
 * somebody said yes in so many words.
 */
function agent(config: Record<string, unknown>): { config: Record<string, unknown> } {
  return { config };
}

describe("adminToolsEnabled", () => {
  it("grants on the whole-server spelling, in both forms", () => {
    // What the provider advertises, and what a person editing the list
    // writes — the two spellings `grantsTool` already reconciles for the
    // `eo` server, one server along.
    expect(adminToolsEnabled(agent({ allowedTools: [`mcp__${ADMIN_MCP_SERVER_NAME}`] }))).toBe(true);
    expect(adminToolsEnabled(agent({ allowedTools: [ADMIN_MCP_SERVER_NAME] }))).toBe(true);
  });

  it("grants on a single named tool under the server, in both forms", () => {
    expect(adminToolsEnabled(agent({ allowedTools: ["Read", `mcp__${ADMIN_MCP_SERVER_NAME}__pipeline_save`] }))).toBe(true);
    expect(adminToolsEnabled(agent({ allowedTools: [`${ADMIN_MCP_SERVER_NAME}__pipeline_save`] }))).toBe(true);
  });

  it("answers no when there is no allowlist at all", () => {
    // The failing-safe half, and the one that matters most here. Most
    // agents carry no `allowedTools`; if absence meant "everything
    // advertised", every one of them would hold the tools that rewrite
    // EO's own configuration.
    expect(adminToolsEnabled(agent({}))).toBe(false);
    expect(adminToolsEnabled(agent({ allowedTools: undefined }))).toBe(false);
    // Not an array is not an allowlist either — a hand-edited config, or
    // one restored from somewhere older.
    expect(adminToolsEnabled(agent({ allowedTools: "mcp__eo_admin" }))).toBe(false);
  });

  it("answers no for an allowlist that names other things", () => {
    expect(adminToolsEnabled(agent({ allowedTools: [] }))).toBe(false);
    expect(adminToolsEnabled(agent({ allowedTools: ["Read", "Bash", "mcp__eo__ticket_detail", "mcp__repo"] }))).toBe(false);
  });

  it("does not read a bare tool name as a grant of this server", () => {
    // `pipeline_save` is also what the `eo` server would call a tool if
    // it ever offered one. A predicate that read an unqualified word as a
    // grant of the administrative server would say yes to an agent that
    // had been given something else entirely.
    expect(adminToolsEnabled(agent({ allowedTools: ["pipeline_save", "agent_save", "mcp_server_save"] }))).toBe(false);
  });

  it("is not fooled by a name that merely starts with the same letters", () => {
    expect(adminToolsEnabled(agent({ allowedTools: ["mcp__eo_administration__anything"] }))).toBe(false);
    expect(adminToolsEnabled(agent({ allowedTools: ["eo_admin_notes"] }))).toBe(false);
  });

  it("has no boolean spelling, unlike its neighbours", () => {
    // `enableFullThread` and `enableCommentTool` have one because they
    // are tick boxes on a screen. This deliberately does not: the grant
    // is a named surface in the list a person edits, so "what can this
    // agent reach?" is answered by reading the field that decides it.
    expect(adminToolsEnabled(agent({ enableAdminTools: true }))).toBe(false);
    expect(fullThreadEnabled(agent({ enableFullThread: true }))).toBe(true);
    expect(commentToolEnabled(agent({ enableCommentTool: true }))).toBe(true);
  });

  it("does not answer yes for an agent the config tools were granted to", () => {
    // The two are different surfaces and one is far larger. An architect
    // allowlisted to read pipelines must not come out of this holding the
    // tools that rewrite them.
    const configReader = agent({ allowedTools: ["mcp__eo__pipeline_detail", "mcp__eo__agents_list"] });
    expect(configToolsEnabled(configReader)).toBe(true);
    expect(adminToolsEnabled(configReader)).toBe(false);
  });
});

/**
 * A tool list read as *capabilities* rather than as a grant (EO-314).
 *
 * What the import preflight shows a person about a pack: one line per
 * MCP server, because the server is the part of a tool id that says
 * which outside thing is being reached (ARCHITECTURE.md, "The `eo_admin` grant").
 */
describe("mcpServersNamedIn", () => {
  it("names each server once, in the order the list names them", () => {
    expect(mcpServersNamedIn(["mcp__slack__conversations_history", "mcp__slack__chat_post", "mcp__eo__item_detail"])).toEqual(["slack", "eo"]);
  });

  it("reads the whole-server spelling as that server", () => {
    expect(mcpServersNamedIn(["mcp__slack"])).toEqual(["slack"]);
  });

  /**
   * Codex writes `${server}/${tool}` where Claude writes
   * `mcp__server__tool` (EO-198). One grant, two spellings — and a
   * reader that knew only one would leave a pack's whole tool surface
   * undescribed on the backend it was built for.
   */
  it("reads Codex's spelling as the same server", () => {
    expect(mcpServersNamedIn(["slack/conversations_history", "slack/chat_post", "eo/item_detail"])).toEqual(["slack", "eo"]);
    expect(mcpServersNamedIn(["mcp__slack__conversations_history", "slack/chat_post"])).toEqual(["slack"]);
  });

  /** And names a server whose own name carries a double underscore, given the list. */
  it("reads an ambiguous Claude id against the servers that exist", () => {
    expect(mcpServersNamedIn(["mcp__slack__prod__list"], ["slack__prod"])).toEqual(["slack__prod"]);
    expect(mcpServersNamedIn(["mcp__slack__prod__list"])).toEqual(["slack"]);
  });

  /**
   * A bare name is not a server, and inventing one from it would put a
   * line on the screen claiming an MCP server called `Bash`.
   */
  it("ignores a tool that names no server", () => {
    expect(mcpServersNamedIn(["Read", "Bash", "comment", "thread_read"])).toEqual([]);
  });
});

describe("namesAdminServer", () => {
  it("is the same question adminToolsEnabled asks, of a list", () => {
    expect(namesAdminServer([`mcp__${ADMIN_MCP_SERVER_NAME}__pipeline_save`])).toBe(true);
    expect(namesAdminServer([ADMIN_MCP_SERVER_NAME])).toBe(true);
    expect(namesAdminServer([`mcp__${ADMIN_MCP_SERVER_NAME}`])).toBe(true);
    expect(namesAdminServer(["mcp__eo__pipeline_save", "pipeline_save"])).toBe(false);
    expect(namesAdminServer([])).toBe(false);
  });

  /**
   * Codex's spelling of the same grant (EO-198). A gate that read only
   * Claude's would refuse a pack on one backend and admit it on the
   * other with every test still green — invariant #12 exactly.
   */
  it("reads Codex's spelling of the grant", () => {
    expect(namesAdminServer([`${ADMIN_MCP_SERVER_NAME}/pipeline_save`])).toBe(true);
    expect(namesAdminServer([`${ADMIN_MCP_SERVER_NAME}/`])).toBe(true);
    expect(adminToolsEnabled(agent({ allowedTools: [`${ADMIN_MCP_SERVER_NAME}/pipeline_save`] }))).toBe(true);
  });

  it("is not fooled by a server whose name merely starts the same way", () => {
    expect(namesAdminServer(["eo_administration/anything", "mcp__eo_administration__anything"])).toBe(false);
  });

  /**
   * The gate never guesses: it names the one server this question is
   * about, so a tool under it is resolved exactly however many
   * underscores the tool's own name carries.
   */
  it("resolves the grant exactly, whatever the tool is called", () => {
    expect(namesAdminServer(["mcp__eo_admin__do__it"])).toBe(true);
    expect(namesAdminServer([`${ADMIN_MCP_SERVER_NAME}/do/it`])).toBe(true);
  });
});

/**
 * The one parser both of the predicates above read a tool id with
 * (EO-314).
 */
describe("mcpToolId", () => {
  it("reads both backends' spellings", () => {
    expect(mcpToolId("mcp__slack__conversations_history")).toEqual({ server: "slack", tool: "conversations_history" });
    expect(mcpToolId("slack/conversations_history")).toEqual({ server: "slack", tool: "conversations_history" });
  });

  it("reads a whole-server grant as a server with no tool", () => {
    expect(mcpToolId("mcp__slack")).toEqual({ server: "slack", tool: null });
    expect(mcpToolId("slack/")).toEqual({ server: "slack", tool: null });
  });

  /**
   * Claude's spelling is ambiguous where a server's own name carries a
   * double underscore, and only knowing which servers exist settles it.
   * `MCP_SERVER_NAME_PATTERN` permits the name, so both readings below
   * are of legal ids.
   */
  it("reads an ambiguous id against the servers that exist", () => {
    expect(mcpToolId("mcp__slack__prod__list", ["slack__prod"])).toEqual({ server: "slack__prod", tool: "list" });
    expect(mcpToolId("mcp__slack__prod__list", ["slack"])).toEqual({ server: "slack", tool: "prod__list" });
    // Longest first: the longer name is the more specific claim on the
    // same string.
    expect(mcpToolId("mcp__slack__prod__list", ["slack", "slack__prod"])).toEqual({ server: "slack__prod", tool: "list" });
    // And a known server named without a tool is still a whole-server grant.
    expect(mcpToolId("mcp__slack__prod", ["slack__prod"])).toEqual({ server: "slack__prod", tool: null });
  });

  /**
   * With nobody to ask it splits on the *first* `__`, which is the guess
   * that fails safe for the gate: splitting on the last would read this
   * as the server `eo_admin__do`, which is not EO's, and a pack asking
   * for exactly that would be waved through.
   */
  it("guesses the first separator when nobody has said what exists", () => {
    expect(mcpToolId("mcp__eo_admin__do__it")).toEqual({ server: "eo_admin", tool: "do__it" });
  });

  it("says a bare word names no server at all", () => {
    expect(mcpToolId("Read")).toBeNull();
    expect(mcpToolId("pipeline_save")).toBeNull();
    expect(mcpToolId("/leading")).toBeNull();
    expect(mcpToolId("mcp__")).toBeNull();
  });
});
