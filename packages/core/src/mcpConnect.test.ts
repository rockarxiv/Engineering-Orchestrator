import { describe, expect, it } from "vitest";
import { MCP_REMOTE_HEADER_VAR, MCP_TOKEN_VAR, claudeCodeAddArgs, codexAddArgs, mcpConnectCommand, mcpRemoteArgs, mcpRemoteEnv, shellQuote } from "./mcpConnect.js";

/**
 * The commands that connect an outside client to EO's MCP host (EO-601):
 * the token is never in an argument, only in the line or the `env` that
 * sets the variable the client reads.
 */
const URL = "http://127.0.0.1:4319/mcp";
const TOKEN = "s3cret-tok3n-601";

describe("connecting an outside client", () => {
  it("names the variable in every argument, never the token", () => {
    expect(claudeCodeAddArgs(URL)).toEqual([
      "mcp", "add", "--scope", "user", "--transport", "http", "eo", URL, "--header", "Authorization: Bearer ${EO_MCP_TOKEN}",
    ]);
    expect(codexAddArgs(URL)).toEqual(["mcp", "add", "eo", "--url", URL, "--bearer-token-env-var", MCP_TOKEN_VAR]);
    // No space after the colon: Claude Desktop on Windows does not escape spaces in `args`.
    expect(mcpRemoteArgs(URL)).toEqual(["-y", "mcp-remote", URL, "--header", "Authorization:${EO_MCP_HEADER}"]);
    expect(mcpRemoteEnv(TOKEN)).toEqual({ [MCP_REMOTE_HEADER_VAR]: `Bearer ${TOKEN}` });
  });

  it("shows the token only on the line that sets the variable", () => {
    const expected = {
      "claude-code": `export ${MCP_TOKEN_VAR}=${TOKEN}`,
      codex: `export ${MCP_TOKEN_VAR}=${TOKEN}`,
      "mcp-remote": `export ${MCP_REMOTE_HEADER_VAR}='Bearer ${TOKEN}'`,
    } as const;
    for (const [client, line] of Object.entries(expected)) {
      const shown = mcpConnectCommand(client as keyof typeof expected, URL, TOKEN).split("\n");
      expect(shown.filter((each) => each.includes(TOKEN))).toEqual([line]);
    }
  });

  it("quotes `${…}` so a shell passes it through for the client to expand", () => {
    expect(mcpConnectCommand("claude-code", URL, TOKEN)).toContain("--header 'Authorization: Bearer ${EO_MCP_TOKEN}'");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });
});
