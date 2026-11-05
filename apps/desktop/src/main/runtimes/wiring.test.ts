import { describe, expect, it } from "vitest";
import { createClaudeProvider } from "../providers/claude.js";
import { buildCodexOptions } from "../providers/codex.js";

/**
 * The resolved runtime path reaches the SDKs (A-08).
 *
 * This is the test the whole story rests on. Both SDKs fall back to a
 * binary bundled inside their own package when no path is given, and
 * the Claude one is "© Anthropic PBC. All rights reserved" — so a
 * silent fallback does not fail loudly, it quietly puts a binary EO may
 * not redistribute back into the installer, and everything keeps
 * working right up until a lawyer asks.
 *
 * Both providers are driven through their real construction path with
 * only the SDK entry point replaced.
 */
describe("Claude", () => {
  it("passes the executable path to the SDK", async () => {
    const seen: unknown[] = [];
    const provider = createClaudeProvider({
      executablePath: "/cache/claude@0.3.227/claude",
      runQuery: ((args: { options: unknown }) => {
        seen.push(args.options);
        return (async function* () {})();
      }) as never,
    });

    for await (const _ of provider.start({ instructions: "i", context: "c", cwd: "/tmp", signal: new AbortController().signal })) void _;

    expect(seen[0]).toMatchObject({ pathToClaudeCodeExecutable: "/cache/claude@0.3.227/claude" });
  });

  it("passes it on resume too, which is the easy one to forget", async () => {
    const seen: unknown[] = [];
    const provider = createClaudeProvider({
      executablePath: "/cache/claude",
      runQuery: ((args: { options: unknown }) => {
        seen.push(args.options);
        return (async function* () {})();
      }) as never,
    });

    for await (const _ of provider.resume("thread-1", "reply", { cwd: "/tmp" })) void _;

    expect(seen[0]).toMatchObject({ pathToClaudeCodeExecutable: "/cache/claude" });
  });

  it("omits the option entirely when there is no path, rather than sending null", async () => {
    // The SDK treats an explicit undefined differently from an absent
    // key in some versions; absent is the documented "use your own".
    const seen: Record<string, unknown>[] = [];
    const provider = createClaudeProvider({
      executablePath: null,
      runQuery: ((args: { options: Record<string, unknown> }) => {
        seen.push(args.options);
        return (async function* () {})();
      }) as never,
    });

    for await (const _ of provider.start({ instructions: "i", context: "c", cwd: "/tmp", signal: new AbortController().signal })) void _;

    expect(seen[0]).not.toHaveProperty("pathToClaudeCodeExecutable");
  });
});

describe("Codex", () => {
  it("passes the executable path to the client that spawns the app-server", () => {
    expect(buildCodexOptions({ executablePath: "/cache/codex/bin/codex" })).toMatchObject({
      executablePath: "/cache/codex/bin/codex",
    });
  });

  it("omits it when there is no path", () => {
    expect(buildCodexOptions({ executablePath: null })).not.toHaveProperty("executablePath");
    expect(buildCodexOptions({})).not.toHaveProperty("executablePath");
  });

  it("launches the shared EO service with the database and Electron's Node mode", () => {
    // The two settings are built together, so a change to one is
    // exactly how the other gets dropped.
    const built = buildCodexOptions({ executablePath: "/cache/codex", eoMcp: { serverPath: "/app/eoServer.mjs", dbPath: "/data/eo.db" } });

    expect(built).toMatchObject({ executablePath: "/cache/codex" });
    expect(built).toMatchObject({
      config: {
        mcp_servers: {
          eo: {
            command: process.execPath,
            args: ["/app/eoServer.mjs"],
            env: { ELECTRON_RUN_AS_NODE: "1", EO_MCP_DB_PATH: "/data/eo.db", EO_MCP_COMMENT_ENABLED: "0" },
          },
        },
      },
    });
  });
});
