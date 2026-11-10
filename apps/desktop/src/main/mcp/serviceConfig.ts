import type { MemoryReadScope } from "@eo/core";

/** Configuration shared by the Claude and Codex provider adapters. */
export interface EoMcpServiceConfig {
  serverPath: string;
  dbPath?: string;
  enableCommentTool?: boolean;
  /** The pipeline architect's read-only view of pipelines, agents and runtimes. */
  enableConfigTools?: boolean;
  /**
   * The unbounded read: an item and every comment on it.
   *
   * Off for a step-owning agent, which is seeded with the newest word
   * from each step and searches for the rest. On for the roles whose work
   * is the conversation itself, where the thread is not context about the
   * work but the work.
   */
  enableFullThread?: boolean;
  /** Where EO caches fetched CLIs, so `runtimes_list` can say what is installed. */
  runtimeRoot?: string;
  /**
   * The run this turn's server is started for, and the directory it may
   * attach files from (EO-412).
   *
   * The one field here that is a turn's rather than an agent's: both
   * adapters fill it in from the turn they are opening, because the
   * provider this configuration otherwise comes from is cached across
   * every item its agent works. Absent, the server does not list
   * `attachment_add`.
   */
  attachFrom?: { runId: string; directory: string };
  /**
   * The memory scopes this turn may read with `memory_read` (EO-478):
   * the project's, and each workspace's its step works in. A turn's, like
   * `attachFrom`, and filled in by both adapters from the turn. Absent or
   * empty, the server does not list the tool.
   */
  memoryScopes?: readonly MemoryReadScope[];
  /**
   * Whether this agent may write to memory with `memory_note` (EO-479):
   * its `allowedTools` grants the tool. The agent's, like the comment
   * tool; the server lists it only on a turn that also has `memoryScopes`,
   * which are where a note may go.
   */
  enableMemoryNote?: boolean;
  /**
   * Where this turn's server hands every write an agent asks for —
   * `comment`, `attachment_add`, `memory_note` — and the bearer it
   * presents (EO-543). A turn's, like `attachFrom`, filled in by both
   * adapters from the turn. Absent, those tools answer that nothing
   * could be written.
   */
  writeBridge?: { url: string; token: string };
  /**
   * The skills this turn was given to load with `skill_read` (EO-721), by
   * slug. A turn's, like `attachFrom`, and filled in only by the Codex
   * adapter: Claude loads its skills with the SDK's own `Skill` tool.
   * Absent or empty, the server does not list the tool.
   */
  skillSlugs?: readonly string[];
}

export interface EoMcpStdioConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * A stdio server as either adapter will take it, before either adapter's
 * syntax (EO-151).
 *
 * The same three fields `EoMcpStdioConfig` has, with `env` optional, and
 * that difference is the whole reason it is a second type rather than
 * the same one. EO's own service always has an environment to declare —
 * that is how it is told which database to open and which tools to
 * offer. A server EO merely points at may need none, and Codex turns
 * this object into command-line arguments, so an empty `env` would be
 * one more argument saying nothing. `http_headers={}` is the same
 * omission on the remote path, made for the same reason.
 */
export interface McpStdioConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * A server EO has been told to hand an agent, as a stdio configuration
 * and nothing more (EO-151).
 *
 * The neutral half of delivering the repository intelligence server, and
 * deliberately the *whole* neutral half: what the command is, what the
 * arguments are and what name it goes under are all decided above this —
 * by the provider port, which owns the tool — and each adapter below it
 * adds only its own syntax, Claude a `type: "stdio"` and Codex an entry
 * under `mcp_servers`.
 *
 * So there is nothing here about indexes, watching or any subcommand,
 * and there must never be: a file in `main/mcp/` that knew what was
 * being spawned would be the second place EO's repository intelligence
 * is decided, and the first one to be forgotten when the implementation
 * changes.
 *
 * Copied rather than passed through. The caller's array and object are
 * its own, and an adapter that later normalised an argument in place
 * would otherwise be editing what the provider handed it.
 */
export function agentMcpStdioConfig(server: { command: string; args: readonly string[]; env?: Record<string, string> }): McpStdioConfig {
  const env = { ...(server.env ?? {}) };
  return {
    command: server.command,
    args: [...server.args],
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
}

/**
 * Both providers launch the same executable, script and environment.
 * Provider-specific syntax (Claude's `type: "stdio"`) is added by its
 * adapter after this neutral configuration has been built.
 */
export function eoMcpStdioConfig(config: EoMcpServiceConfig): EoMcpStdioConfig {
  return {
    command: process.execPath,
    args: [config.serverPath],
    env: {
      ELECTRON_RUN_AS_NODE: "1",
      ...(config.dbPath ? { EO_MCP_DB_PATH: config.dbPath } : {}),
      ...(config.runtimeRoot ? { EO_MCP_RUNTIME_ROOT: config.runtimeRoot } : {}),
      EO_MCP_COMMENT_ENABLED: config.enableCommentTool ? "1" : "0",
      EO_MCP_CONFIG_ENABLED: config.enableConfigTools ? "1" : "0",
      EO_MCP_FULL_THREAD_ENABLED: config.enableFullThread ? "1" : "0",
      EO_MCP_MEMORY_NOTE_ENABLED: config.enableMemoryNote ? "1" : "0",
      // Both or neither: a run id without a directory is a tool that can
      // check nothing, and the server lists it only when it has the pair.
      ...(config.attachFrom ? { EO_MCP_RUN_ID: config.attachFrom.runId, EO_MCP_RUN_DIRECTORY: config.attachFrom.directory } : {}),
      // As JSON, the one shape both a process environment and Codex's
      // `mcp_servers.eo.env.<NAME>` override carry intact.
      ...(config.memoryScopes && config.memoryScopes.length > 0 ? { EO_MCP_MEMORY_SCOPES: JSON.stringify(config.memoryScopes) } : {}),
      // As JSON, for the same reason.
      ...(config.writeBridge ? { EO_MCP_WRITE_BRIDGE: JSON.stringify(config.writeBridge) } : {}),
      // As JSON, for the same reason.
      ...(config.skillSlugs && config.skillSlugs.length > 0 ? { EO_MCP_SKILLS: JSON.stringify(config.skillSlugs) } : {}),
    },
  };
}
