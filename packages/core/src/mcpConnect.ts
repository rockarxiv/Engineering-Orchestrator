/**
 * The commands that connect an outside client to EO's MCP host, built
 * once for every place that shows or runs them (EO-601).
 *
 * The rule: **the token never appears in an argument EO writes, runs or
 * shows.** A command line is readable by every user on the machine
 * through `ps` or `/proc/<pid>/cmdline`, and a command someone pastes
 * lands in their shell history; a process's environment is readable only
 * by the same user. So the token travels in an environment variable, an
 * argument carries at most the variable's name, and the only shown line
 * that holds the token is the one setting that variable.
 *
 * Main registers through these (`mcpHost/clients.ts`) and Settings shows
 * them ("Connect a client"), so the two cannot drift apart and one of
 * them quietly go back to a literal token. Pure strings, on the pure
 * side of invariant #2.
 */

/** The name EO registers under, everywhere. */
export const MCP_HOST_SERVER_KEY = "eo";

/**
 * The variable Claude Code and Codex read the token from. One for both,
 * so one line in a shell profile serves both.
 *
 * Codex's `mcp add` takes `--bearer-token-env-var`, a variable *name*.
 * Claude Code gets a header whose value is `Bearer ${EO_MCP_TOKEN}`,
 * passed literally: it expands `${VAR}` in a server's headers each time
 * it connects (checked against Claude Code 2.1.302 at user scope).
 */
export const MCP_TOKEN_VAR = "EO_MCP_TOKEN";

/**
 * The variable `mcp-remote` reads the whole header value from.
 *
 * Its own documented shape: `--header Authorization:${VAR}` with
 * `VAR="Bearer <token>"` in the environment. No space after the colon,
 * because Claude Desktop on Windows does not escape spaces in `args`.
 * `${VAR}` substitution works in every `mcp-remote` version, which
 * matters because it is run unpinned; `--header-file` is too recent.
 */
export const MCP_REMOTE_HEADER_VAR = "EO_MCP_HEADER";

/** `claude mcp add` at user scope, so it is there in every project. `${…}` is literal. */
export function claudeCodeAddArgs(url: string): string[] {
  return ["mcp", "add", "--scope", "user", "--transport", "http", MCP_HOST_SERVER_KEY, url, "--header", `Authorization: Bearer \${${MCP_TOKEN_VAR}}`];
}

export function codexAddArgs(url: string): string[] {
  return ["mcp", "add", MCP_HOST_SERVER_KEY, "--url", url, "--bearer-token-env-var", MCP_TOKEN_VAR];
}

/** The stdio bridge's arguments. `${…}` is literal; `mcp-remote` substitutes it. */
export function mcpRemoteArgs(url: string): string[] {
  return ["-y", "mcp-remote", url, "--header", `Authorization:\${${MCP_REMOTE_HEADER_VAR}}`];
}

/** The environment `mcp-remote` is started with: the token's one place in a stdio client's entry. */
export function mcpRemoteEnv(token: string): Record<string, string> {
  return { [MCP_REMOTE_HEADER_VAR]: `Bearer ${token}` };
}

/**
 * An argument as a shell would need it written.
 *
 * The header arguments have a space and a `$` in them — a shell would
 * expand `${EO_MCP_TOKEN}` before the client ever saw it — and a URL
 * could gain a query string, so quoting is not optional. Single quotes
 * with the standard escape, because a command shown and not runnable is
 * worse than no command.
 */
export function shellQuote(argument: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(argument) ? argument : `'${argument.replace(/'/g, `'\\''`)}'`;
}

export function shellCommand(cli: string, args: string[]): string {
  return [cli, ...args].map(shellQuote).join(" ");
}

/** The one line of these commands allowed to hold the token. */
function exportLine(variable: string, value: string): string {
  return `export ${variable}=${shellQuote(value)}`;
}

export type McpConnectCommand = "claude-code" | "codex" | "mcp-remote";

/**
 * What a person pastes into a terminal to connect `client`.
 *
 * Claude Code and Codex get their `mcp add` and then the variable it
 * reads, because the first line alone leaves the client connecting and
 * being refused. `mcp-remote` gets the variable first, since it reads it
 * the moment it starts.
 */
export function mcpConnectCommand(client: McpConnectCommand, url: string, token: string): string {
  if (client === "claude-code") return [shellCommand("claude", claudeCodeAddArgs(url)), exportLine(MCP_TOKEN_VAR, token)].join("\n");
  if (client === "codex") return [shellCommand("codex", codexAddArgs(url)), exportLine(MCP_TOKEN_VAR, token)].join("\n");
  return [exportLine(MCP_REMOTE_HEADER_VAR, `Bearer ${token}`), shellCommand("npx", mcpRemoteArgs(url))].join("\n");
}
