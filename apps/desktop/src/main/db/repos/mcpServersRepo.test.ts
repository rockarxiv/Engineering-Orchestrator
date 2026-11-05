import { sql } from "drizzle-orm";
import { McpServerDraftSchema, type McpServerDraft } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../client.js";
import { openMigratedTestDb } from "../testHelpers.js";
import { archiveMcpServer, getMcpServer, getMcpServerByName, listMcpServers, saveMcpServer, setMcpServerEnabled } from "./mcpServersRepo.js";

/**
 * The MCP server catalogue's rows (EO-104).
 *
 * Against the real migrations in an in-memory database, so a column this
 * repository writes and a column the migration creates cannot drift
 * apart without a test noticing.
 */
function draft(overrides: Partial<McpServerDraft> & { name: string; transport: McpServerDraft["transport"] }): McpServerDraft {
  return McpServerDraftSchema.parse(overrides);
}

let handle: DbHandle;

beforeEach(() => {
  handle = openMigratedTestDb();
});

afterEach(() => {
  handle.close();
});

describe("saveMcpServer", () => {
  it("creates a stdio server and reads it back whole", () => {
    const saved = saveMcpServer(handle.db, draft({ name: "github", transport: "stdio", command: "npx", args: ["-y", "server-github"], envNames: ["GITHUB_TOKEN"] }));

    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(getMcpServer(handle.db, saved.server.id)).toEqual({
      id: saved.server.id,
      name: "github",
      // Nobody said what it does, and an empty description is what that
      // means (EO-314).
      description: "",
      config: { transport: "stdio", command: "npx", args: ["-y", "server-github"] },
      envNames: ["GITHUB_TOKEN"],
      enabled: true,
      createdAt: expect.any(Number),
      updatedAt: expect.any(Number),
      archivedAt: null,
      // A server nobody has written words for (EO-315). Null is the
      // honest answer for every row somebody typed in by hand.
      connector: null,
    });
  });

  /**
   * The failure this closes is silent and one screen away from where it
   * is caused (EO-315). The catalogue editor does not offer a
   * connector's setup, so the person who adds the command to a server a
   * pack declared sends a draft with no connector and no environment
   * names — and the row used to come back with nothing declared while
   * keeping its setup. Connect went on storing a value under a name
   * `attachmentEnvironment` no longer walked: green on screen, and the
   * agent handed nothing.
   */
  it("keeps a connector's secrets declared when a later save never mentions them", () => {
    const connector = { label: "Slack", kind: "token" as const, secretNames: ["SLACK_BOT_TOKEN"], oauth: null };
    const first = saveMcpServer(handle.db, draft({ name: "slack", transport: "stdio", command: "slack-mcp", connector }));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.server.envNames).toEqual(["SLACK_BOT_TOKEN"]);

    // A person fixing the command. Nothing about a connector in it, and
    // `envNames` defaults to empty at the boundary.
    const second = saveMcpServer(handle.db, draft({ id: first.server.id, name: "slack", transport: "stdio", command: "/opt/slack-mcp" }));
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.server.connector).toEqual(connector);
    expect(second.server.envNames).toEqual(["SLACK_BOT_TOKEN"]);
    expect(second.server.config).toEqual({ transport: "stdio", command: "/opt/slack-mcp", args: [] });
  });

  it("stops declaring them once it is no longer a connector", () => {
    const connector = { label: "Slack", kind: "token" as const, secretNames: ["SLACK_BOT_TOKEN"], oauth: null };
    const first = saveMcpServer(handle.db, draft({ name: "slack", transport: "stdio", command: "slack-mcp", connector }));
    if (!first.ok) return;

    // An explicit null is the one way to say it: silence leaves the
    // setup alone, so this is a decision rather than an omission.
    const second = saveMcpServer(handle.db, draft({ id: first.server.id, name: "slack", transport: "stdio", command: "slack-mcp", connector: null }));
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.server.connector).toBeNull();
    expect(second.server.envNames).toEqual([]);
  });

  it("creates a remote server with its headers", () => {
    const saved = saveMcpServer(
      handle.db,
      draft({ name: "linear", transport: "sse", url: "https://mcp.linear.app/sse", headers: { Authorization: "Bearer ${LINEAR_TOKEN}" }, envNames: ["LINEAR_TOKEN"] }),
    );

    expect(saved.ok && saved.server.config).toEqual({
      transport: "sse",
      url: "https://mcp.linear.app/sse",
      headers: { Authorization: "Bearer ${LINEAR_TOKEN}" },
      // Neither the draft nor this test says how it authenticates, and
      // it reads back as `header` — the shape every remote server in the
      // catalogue had before EO-117, still first-class (EO-117).
      auth: { kind: "header" },
    });
  });

  /**
   * A bearer server, from the draft to the columns and back (EO-117).
   *
   * Read back through the repository *and* out of the row, because the
   * claim has two halves: the kind and the variable's name are what the
   * database holds, and the token is not among them.
   */
  it("stores a bearer server's kind and the name of the variable holding its token", () => {
    const saved = saveMcpServer(
      handle.db,
      draft({ name: "linear", transport: "http", url: "https://mcp.linear.app/mcp", authKind: "bearer", bearerTokenEnvName: "LINEAR_TOKEN" }),
    );

    expect(saved.ok && saved.server.config).toEqual({
      transport: "http",
      url: "https://mcp.linear.app/mcp",
      headers: {},
      auth: { kind: "bearer", tokenEnvName: "LINEAR_TOKEN" },
    });
    // Declaring the kind declares the variable, so the value has a row
    // to be typed into on the catalogue screen and `secretsSet` has
    // something to intersect against.
    expect(saved.ok && saved.server.envNames).toEqual(["LINEAR_TOKEN"]);

    const row = handle.db.get<{ authKind: string; bearerTokenEnvName: string | null }>(
      sql`SELECT auth_kind AS authKind, bearer_token_env_name AS bearerTokenEnvName FROM mcp_servers WHERE name = 'linear'`,
    );
    expect(row).toEqual({ authKind: "bearer", bearerTokenEnvName: "LINEAR_TOKEN" });
  });

  it("clears the token's name when a server stops being a bearer one", () => {
    const created = saveMcpServer(
      handle.db,
      draft({ name: "linear", transport: "http", url: "https://mcp.linear.app/mcp", authKind: "bearer", bearerTokenEnvName: "LINEAR_TOKEN" }),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const edited = saveMcpServer(
      handle.db,
      // Still carrying the name, the way a form that only changed the
      // dropdown would: what decides is the kind, and a name nothing
      // refers to has no business sitting in the row.
      draft({ id: created.server.id, name: "linear", transport: "http", url: "https://mcp.linear.app/mcp", authKind: "header", bearerTokenEnvName: "LINEAR_TOKEN" }),
    );

    expect(edited.ok && edited.server.config).toMatchObject({ auth: { kind: "header" } });
    const row = handle.db.get<{ bearerTokenEnvName: string | null }>(
      sql`SELECT bearer_token_env_name AS bearerTokenEnvName FROM mcp_servers WHERE name = 'linear'`,
    );
    expect(row?.bearerTokenEnvName).toBeNull();
  });

  it("edits a server in place, in both directions across the transports", () => {
    const created = saveMcpServer(handle.db, draft({ name: "github", transport: "stdio", command: "npx" }));
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const edited = saveMcpServer(handle.db, draft({ id: created.server.id, name: "github", transport: "http", url: "https://api.githubcopilot.com/mcp/" }));

    expect(edited.ok && edited.server.id).toBe(created.server.id);
    // The half this transport does not use is cleared rather than left
    // lying there: a row remembering a command it will never run is a row
    // that reads as two servers at once.
    expect(edited.ok && edited.server.config).toEqual({ transport: "http", url: "https://api.githubcopilot.com/mcp/", headers: {}, auth: { kind: "header" } });
    expect(listMcpServers(handle.db)).toHaveLength(1);
  });

  it("refuses a second server with a name that is taken", () => {
    saveMcpServer(handle.db, draft({ name: "github", transport: "stdio", command: "npx" }));

    const clash = saveMcpServer(handle.db, draft({ name: "github", transport: "stdio", command: "docker" }));

    expect(clash.ok).toBe(false);
    if (clash.ok) return;
    expect(clash.problems.join(" ")).toContain('already called "github"');
  });

  it("lets a server keep its own name across an edit", () => {
    const created = saveMcpServer(handle.db, draft({ name: "github", transport: "stdio", command: "npx" }));
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(saveMcpServer(handle.db, draft({ id: created.server.id, name: "github", transport: "stdio", command: "docker" })).ok).toBe(true);
  });

  /**
   * A refusal, never a throw. Everything here is something a person
   * typed, and throwing is for programmer error — the repository applies
   * the same check the boundary does so a caller that reaches it
   * directly cannot write a row the view schema would refuse to read.
   */
  it("refuses a malformed server without throwing", () => {
    expect(() => saveMcpServer(handle.db, draft({ name: "github", transport: "stdio", command: "" }))).not.toThrow();
    expect(saveMcpServer(handle.db, draft({ name: "github", transport: "stdio", command: "" })).ok).toBe(false);
    expect(listMcpServers(handle.db)).toEqual([]);
  });

  it("refuses to edit a server that is not there", () => {
    const missing = saveMcpServer(handle.db, draft({ id: "019fb8c6-0000-7000-8000-00000000beef", name: "github", transport: "stdio", command: "npx" }));

    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.problems.join(" ")).toContain("No MCP server");
  });
});

describe("listing, enabling and archiving", () => {
  it("lists live servers by name and leaves archived ones out until asked", () => {
    const first = saveMcpServer(handle.db, draft({ name: "zed", transport: "stdio", command: "npx" }));
    saveMcpServer(handle.db, draft({ name: "atlas", transport: "stdio", command: "npx" }));
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    expect(listMcpServers(handle.db).map((server) => server.name)).toEqual(["atlas", "zed"]);

    expect(archiveMcpServer(handle.db, first.server.id)).toBe(true);

    expect(listMcpServers(handle.db).map((server) => server.name)).toEqual(["atlas"]);
    // Archived, not deleted: whatever attached it still has something to
    // point at (invariant #3).
    expect(listMcpServers(handle.db, true).map((server) => server.name)).toEqual(["atlas", "zed"]);
    expect(getMcpServerByName(handle.db, "zed")?.archivedAt).toEqual(expect.any(Number));
  });

  it("turns a server off and on again without touching what it points at", () => {
    const saved = saveMcpServer(handle.db, draft({ name: "github", transport: "stdio", command: "npx", args: ["-y"] }));
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;

    expect(setMcpServerEnabled(handle.db, saved.server.id, false)).toBe(true);
    expect(getMcpServer(handle.db, saved.server.id)?.enabled).toBe(false);
    // Disabled is a switch, not an archive: the row is still live.
    expect(listMcpServers(handle.db)).toHaveLength(1);

    expect(setMcpServerEnabled(handle.db, saved.server.id, true)).toBe(true);
    expect(getMcpServer(handle.db, saved.server.id)?.config).toEqual({ transport: "stdio", command: "npx", args: ["-y"] });
  });

  /**
   * A save that says nothing about the switch is not asking for it to be
   * flipped. Without this, fixing a typo in the command of a server
   * somebody had deliberately turned off turns it back on — silently,
   * because nothing about editing a command says anything about being
   * enabled.
   */
  it("leaves a disabled server disabled when a save does not mention it", () => {
    const saved = saveMcpServer(handle.db, draft({ name: "github", transport: "stdio", command: "npx" }));
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    setMcpServerEnabled(handle.db, saved.server.id, false);

    const edited = saveMcpServer(handle.db, draft({ id: saved.server.id, name: "github", transport: "stdio", command: "docker" }));

    expect(edited.ok && edited.server.enabled).toBe(false);
    // And a caller that does mention it is still obeyed.
    expect(saveMcpServer(handle.db, draft({ id: saved.server.id, name: "github", transport: "stdio", command: "docker", enabled: true })).ok).toBe(true);
    expect(getMcpServer(handle.db, saved.server.id)?.enabled).toBe(true);
  });

  it("says no rather than throwing when the server is gone", () => {
    expect(setMcpServerEnabled(handle.db, "019fb8c6-0000-7000-8000-00000000beef", false)).toBe(false);
    expect(archiveMcpServer(handle.db, "019fb8c6-0000-7000-8000-00000000beef")).toBe(false);
  });
});

/**
 * What a server does, in a person's words (EO-314, ARCHITECTURE.md, "A connector is an MCP server
 * with a setup flow").
 *
 * The only field on a server that is a label rather than an identifier,
 * and it exists because two surfaces need a sentence no tool id can
 * supply: the catalogue screen and the pack import gate, which shows a
 * pack's tool surface as capabilities rather than as tool names.
 */
describe("a server's description", () => {
  it("is written by the save and read back whole", () => {
    const saved = saveMcpServer(handle.db, draft({ name: "slack", description: "reads your Slack channels", transport: "stdio", command: "slack-mcp" }));

    expect(saved.ok && saved.server.description).toBe("reads your Slack channels");
  });

  /**
   * Absent means "leave it as it is", the arrangement `enabled` already
   * has. A save that fixes a command must not delete the sentence the
   * import gate shows — the trap a `.default("")` would set.
   */
  it("survives a save that does not mention it", () => {
    const saved = saveMcpServer(handle.db, draft({ name: "slack", description: "reads your Slack channels", transport: "stdio", command: "slack-mcp" }));
    if (!saved.ok) throw new Error(saved.problems.join(", "));

    const edited = saveMcpServer(handle.db, draft({ id: saved.server.id, name: "slack", transport: "stdio", command: "slack-mcp --v2" }));

    expect(edited.ok && edited.server.description).toBe("reads your Slack channels");
  });

  /** And an empty one is somebody clearing it, which is a thing they may do. */
  it("is cleared by a save that says so", () => {
    const saved = saveMcpServer(handle.db, draft({ name: "slack", description: "reads your Slack channels", transport: "stdio", command: "slack-mcp" }));
    if (!saved.ok) throw new Error(saved.problems.join(", "));

    const edited = saveMcpServer(handle.db, draft({ id: saved.server.id, name: "slack", description: "  ", transport: "stdio", command: "slack-mcp" }));

    expect(edited.ok && edited.server.description).toBe("");
  });
});
