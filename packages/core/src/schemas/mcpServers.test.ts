import { describe, expect, it } from "vitest";
import {
  McpAuthKindSchema,
  McpServerConfigSchema,
  McpServerDraftSchema,
  isDeliverableMcpServer,
  readMcpServerDraft,
  reservedMcpServerName,
  REPOSITORY_MCP_SERVER_NAME,
  RESERVED_MCP_SERVER_NAME,
  ADMIN_MCP_SERVER_NAME,
  RESERVED_MCP_SERVER_NAME_LIST,
  type McpServerDraft,
} from "./mcpServers.js";

/** A draft as the boundary would hand it over: parsed, with every default applied. */
function draft(overrides: Partial<McpServerDraft> & { name: string; transport: McpServerDraft["transport"] }): McpServerDraft {
  return McpServerDraftSchema.parse(overrides);
}

describe("readMcpServerDraft", () => {
  it("narrows a stdio draft to a command and its args", () => {
    const read = readMcpServerDraft(draft({ name: "github", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] }));

    expect(read).toEqual({
      ok: true,
      name: "github",
      config: { transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
      envNames: [],
      // Absent rather than true: a draft that says nothing about the
      // switch is not asking for it to be flipped. See the field's note.
      enabled: undefined,
    });
  });

  it("carries the switch through only when the draft actually set it", () => {
    expect(readMcpServerDraft(draft({ name: "github", transport: "stdio", command: "npx", enabled: false })).ok).toBe(true);
    expect(readMcpServerDraft(draft({ name: "github", transport: "stdio", command: "npx", enabled: false }))).toMatchObject({ enabled: false });
  });

  it("narrows a remote draft to a url and its headers, and keeps sse apart from http", () => {
    const headers = { Authorization: "Bearer ${LINEAR_TOKEN}" };
    const http = readMcpServerDraft(draft({ name: "linear", transport: "http", url: "https://mcp.linear.app/mcp", headers }));
    const sse = readMcpServerDraft(draft({ name: "linear", transport: "sse", url: "https://mcp.linear.app/sse", headers }));

    // `header` without either draft saying so — the default, which is
    // what every server saved before the kind existed is (EO-117).
    expect(http.ok && http.config).toEqual({ transport: "http", url: "https://mcp.linear.app/mcp", headers, auth: { kind: "header" } });
    expect(sse.ok && sse.config).toEqual({ transport: "sse", url: "https://mcp.linear.app/sse", headers, auth: { kind: "header" } });
  });

  /**
   * The value never appears, in the row or in this shape. What a server
   * declares is a name, and the header that needs the value carries
   * `${NAME}` for the moment of dispatch to interpolate.
   */
  it("keeps the names of the variables a server needs", () => {
    const read = readMcpServerDraft(draft({ name: "github", transport: "stdio", command: "npx", envNames: ["GITHUB_TOKEN", "GITHUB_HOST"] }));

    expect(read.ok && read.envNames).toEqual(["GITHUB_TOKEN", "GITHUB_HOST"]);
  });

  it("refuses the name eo, and says why", () => {
    const read = readMcpServerDraft(draft({ name: "eo", transport: "stdio", command: "node" }));

    expect(read.ok).toBe(false);
    if (read.ok) return;
    // Named, rather than "invalid name": the person has to be able to
    // tell this apart from a typo, and from a name somebody else took.
    expect(read.problems.join(" ")).toContain("EO's own MCP server");
    expect(read.problems.join(" ")).toContain("shadow");
  });

  /**
   * `EO` cannot shadow `eo` on a provider that matches keys exactly, so
   * a pattern check would have refused it for the wrong reason and told
   * the person to lowercase it — which is how you end up with the name
   * that *does* shadow. Reserved is checked first, and case-insensitively.
   */
  it("refuses EO for being EO's name rather than for its capital letter", () => {
    const read = readMcpServerDraft(draft({ name: "EO", transport: "stdio", command: "node" }));

    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.problems.join(" ")).toContain("EO's own MCP server");
  });

  /**
   * The second reserved name, and it is the one somebody would
   * plausibly reach for on their own (EO-151).
   *
   * `eo` is a name nobody types by accident. `repo` is a name a person
   * adding a git or GitHub server would pick without a second thought —
   * and taking it would shadow the query server EO hands an agent whose
   * item has an index, leaving that agent calling somebody else's
   * tools under EO's name and nothing anywhere saying so.
   */
  it("refuses the name repo, and says which server it would shadow", () => {
    const read = readMcpServerDraft(draft({ name: "repo", transport: "stdio", command: "node" }));

    expect(read.ok).toBe(false);
    if (read.ok) return;
    // The same standard `eo` is held to: what it is, not that it is
    // taken. Somebody who reads "reserved" learns nothing they can act
    // on; somebody who reads this knows to pick `git` or `github`.
    expect(read.problems.join(" ")).toContain("repository intelligence server");
    expect(read.problems.join(" ")).toContain("shadow");
  });

  /**
   * And the third (EO-182).
   *
   * The one with the sharpest consequence of the three. `eo_admin` is
   * the whole `mcpHost` catalogue, ungated, served to EO's system agent
   * over a loopback listener EO starts with itself — so a catalogue row
   * that took the name would displace the one server on which every
   * write EO can make is reachable, and the agent that noticed would be
   * one that had already tried to change something and been answered by
   * somebody else's tools.
   */
  it("refuses the name eo_admin, and says which server it would shadow", () => {
    const read = readMcpServerDraft(draft({ name: ADMIN_MCP_SERVER_NAME, transport: "stdio", command: "node" }));

    expect(read.ok).toBe(false);
    if (read.ok) return;
    // Held to the standard the other two are: what it is, not that it is
    // taken.
    expect(read.problems.join(" ")).toContain("administrative server");
    expect(read.problems.join(" ")).toContain("system agent");
    expect(read.problems.join(" ")).toContain("shadow");
  });

  it("refuses REPO for being EO's name rather than for its capitals", () => {
    // Exactly the argument the `EO` case above makes: a pattern check
    // would refuse this for the wrong reason and tell the person to
    // lowercase it, which is the spelling that *does* shadow.
    const read = readMcpServerDraft(draft({ name: "REPO", transport: "stdio", command: "node" }));

    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.problems.join(" ")).toContain("repository intelligence server");
  });

  /**
   * Every reserved name is refused, and the list is what says which.
   *
   * Written over `RESERVED_MCP_SERVER_NAME_LIST` rather than as two more
   * cases, so that reserving a third name without refusing it is a
   * failing test rather than a thing nobody notices. The two named cases
   * above stay because they assert the *sentences*, which is the half a
   * loop cannot check.
   */
  it("refuses every name EO has taken, whatever the list grows to", () => {
    expect(RESERVED_MCP_SERVER_NAME_LIST).toEqual(
      expect.arrayContaining([RESERVED_MCP_SERVER_NAME, REPOSITORY_MCP_SERVER_NAME, ADMIN_MCP_SERVER_NAME]),
    );

    for (const name of RESERVED_MCP_SERVER_NAME_LIST) {
      const read = readMcpServerDraft(draft({ name, transport: "stdio", command: "node" }));
      expect(read.ok, `"${name}" was accepted`).toBe(false);
      expect(reservedMcpServerName(name)).not.toBeNull();
    }

    // Not vacuous: a name EO has not taken still gets through, so this
    // is a reservation rather than a refusal of everything.
    expect(reservedMcpServerName("github")).toBeNull();
    expect(readMcpServerDraft(draft({ name: "github", transport: "stdio", command: "node" })).ok).toBe(true);
  });

  it("refuses a name that could not be part of a tool id", () => {
    const read = readMcpServerDraft(draft({ name: "My GitHub", transport: "stdio", command: "npx" }));

    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.problems.join(" ")).toContain("tool id");
  });

  it("refuses a stdio server with nothing to run", () => {
    const read = readMcpServerDraft(draft({ name: "github", transport: "stdio", command: "   " }));

    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.problems).toEqual(["A stdio server needs a command to run."]);
  });

  it.each([
    ["", "A remote server needs a URL."],
    ["mcp.linear.app", "starts with http:// or https://"],
    ["ftp://mcp.linear.app", "http or https"],
    ["https://", "no host"],
  ])("refuses the remote URL %j", (url, expected) => {
    const read = readMcpServerDraft(draft({ name: "linear", transport: "http", url }));

    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.problems.join(" ")).toContain(expected);
  });

  it("refuses a variable name that could never be an environment variable", () => {
    const read = readMcpServerDraft(draft({ name: "fly", transport: "stdio", command: "flyctl", envNames: ["FLY-API-TOKEN"] }));

    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.problems.join(" ")).toContain("environment-variable name");
  });

  it("refuses the same variable twice — one name holds one value", () => {
    const read = readMcpServerDraft(draft({ name: "fly", transport: "stdio", command: "flyctl", envNames: ["TOKEN", "TOKEN"] }));

    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.problems.join(" ")).toContain("listed twice");
  });

  it("refuses a header name that is not one", () => {
    const read = readMcpServerDraft(draft({ name: "linear", transport: "http", url: "https://mcp.linear.app/mcp", headers: { "Bad Header": "x" } }));

    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.problems.join(" ")).toContain("HTTP header name");
  });

  /**
   * Every problem at once, not the first.
   *
   * A person fixing a form one refusal per save is being made to play a
   * guessing game with a dialog box.
   */
  it("says everything that is wrong in one answer", () => {
    const read = readMcpServerDraft(draft({ name: "My Server", transport: "stdio", command: "", envNames: ["nope-nope"] }));

    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.problems).toHaveLength(3);
  });

  /** Trimmed on the way in, so a pasted URL with a trailing space is not a refusal. */
  it("trims what it stores", () => {
    const read = readMcpServerDraft(draft({ name: " github ", transport: "stdio", command: " npx " }));

    expect(read.ok && read.name).toBe("github");
    expect(read.ok && read.config).toEqual({ transport: "stdio", command: "npx", args: [] });
  });

  /**
   * The narrowed shape is the one the boundary hands back, so it has to
   * satisfy the schema a response is validated against — otherwise a
   * malformed server would be caught as a handler bug (a throw, an
   * "Internal error") rather than as something a person can fix.
   */
  it("produces a config that satisfies McpServerConfigSchema", () => {
    const stdio = readMcpServerDraft(draft({ name: "github", transport: "stdio", command: "npx" }));
    const remote = readMcpServerDraft(draft({ name: "linear", transport: "sse", url: "https://mcp.linear.app/sse" }));

    expect(stdio.ok && McpServerConfigSchema.safeParse(stdio.config).success).toBe(true);
    expect(remote.ok && McpServerConfigSchema.safeParse(remote.config).success).toBe(true);
  });
});

/**
 * How a remote server authenticates, said outright rather than read out
 * of a header string (EO-117).
 */
describe("a remote server's authentication kind", () => {
  const bearer = (overrides: Partial<McpServerDraft> = {}) =>
    readMcpServerDraft(
      draft({ name: "linear", transport: "http", url: "https://mcp.linear.app/mcp", authKind: "bearer", bearerTokenEnvName: "LINEAR_TOKEN", ...overrides }),
    );

  it("carries the name of the variable holding the token, and never a token", () => {
    const read = bearer();

    expect(read.ok && read.config).toEqual({
      transport: "http",
      url: "https://mcp.linear.app/mcp",
      headers: {},
      auth: { kind: "bearer", tokenEnvName: "LINEAR_TOKEN" },
    });
  });

  /**
   * Declaring bearer authentication declares the variable it needs.
   *
   * `envNames` is the list of names a server needs — it is what puts a
   * box for the value on the catalogue screen and what `secretsSet` is
   * intersected against — and a bearer server needs this one by
   * definition. Making somebody type it twice would mean a server that
   * says it uses a token and has nowhere to keep one.
   */
  it("declares the token's variable among the names the server needs", () => {
    const declared = bearer();
    expect(declared.ok && declared.envNames).toEqual(["LINEAR_TOKEN"]);
    // Already listed is not listed twice: one name holds one value.
    const listedTwice = bearer({ envNames: ["LINEAR_TOKEN"] });
    expect(listedTwice.ok && listedTwice.envNames).toEqual(["LINEAR_TOKEN"]);
    // …and it joins whatever else the server declared.
    const withOthers = bearer({ envNames: ["LINEAR_WORKSPACE"] });
    expect(withOthers.ok && withOthers.envNames).toEqual(["LINEAR_WORKSPACE", "LINEAR_TOKEN"]);
  });

  it("refuses a bearer server that names no variable, and one whose name is not one", () => {
    const unnamed = bearer({ bearerTokenEnvName: null });
    expect(unnamed.ok).toBe(false);
    expect(!unnamed.ok && unnamed.problems.join(" ")).toContain("the name, not the token");

    const blank = bearer({ bearerTokenEnvName: "   " });
    expect(blank.ok).toBe(false);

    const bad = bearer({ bearerTokenEnvName: "linear-token" });
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.problems.join(" ")).toContain("is not an environment-variable name");
  });

  it("takes none, and clears the token's name with it", () => {
    const read = readMcpServerDraft(
      draft({ name: "sentry", transport: "sse", url: "https://mcp.sentry.dev/sse", authKind: "none", bearerTokenEnvName: "LEFTOVER" }),
    );

    expect(read.ok && read.config).toEqual({ transport: "sse", url: "https://mcp.sentry.dev/sse", headers: {}, auth: { kind: "none" } });
    // The name went nowhere: it belongs to the bearer member alone, and
    // an unread name in the row is a name nothing refers to.
    expect(read.ok && read.envNames).toEqual([]);
  });

  /**
   * A stdio server has no authentication to declare, and the type says
   * so: a stdio child is spawned into a fixed environment allowlist and
   * delivered without its declared values whatever it claims (EO-108).
   * The form does not offer the control; a draft that carries one anyway
   * is ignored rather than refused, the way `url` is on a stdio draft.
   */
  it("is not a thing a stdio server has", () => {
    const read = readMcpServerDraft(draft({ name: "github", transport: "stdio", command: "npx", authKind: "bearer", bearerTokenEnvName: "GITHUB_TOKEN" }));

    expect(read.ok && read.config).toEqual({ transport: "stdio", command: "npx", args: [] });
    expect(read.ok && read.envNames).toEqual([]);
  });

  /**
   * The decision this item asked to be made deliberately, kept honest.
   *
   * Multica's set has a fourth member, `oauth`, because Multica performs
   * the flow. EO performs none, and a kind nothing implements is an
   * option a person can pick that both adapters could only ignore. The
   * reasoning is at `McpAuthKindSchema`; this is the set refusing it, so
   * that adding the member is a deliberate act rather than a typo that
   * parses.
   */
  it("is a closed set of three, with no oauth in it", () => {
    expect(McpAuthKindSchema.options).toEqual(["none", "bearer", "header"]);
    expect(McpAuthKindSchema.safeParse("oauth").success).toBe(false);
    expect(McpServerDraftSchema.safeParse({ name: "linear", transport: "http", url: "https://mcp.linear.app/mcp", authKind: "oauth" }).success).toBe(false);
  });
});

/**
 * The rule both delivery mechanisms ask (EO-151).
 *
 * There is one of these because there used to be two. Codex merges
 * catalogue rows straight into `mcp_servers` and Claude gets them
 * written into a generated `.mcp.json`, and each filtered for itself —
 * so when `repo` was reserved, one of them started refusing it and the
 * other went on writing it to disk beside the server EO had just
 * injected under that name. A rule that lives in one place cannot do
 * that.
 */
describe("isDeliverableMcpServer", () => {
  const row = (overrides: Partial<{ name: string; enabled: boolean; archivedAt: number | null }> = {}) => ({
    name: "github",
    enabled: true,
    archivedAt: null,
    ...overrides,
  });

  it("delivers an ordinary enabled row", () => {
    expect(isDeliverableMcpServer(row())).toBe(true);
  });

  it("withholds what a person switched off or archived", () => {
    expect(isDeliverableMcpServer(row({ enabled: false }))).toBe(false);
    expect(isDeliverableMcpServer(row({ archivedAt: 1_700_000_000_000 }))).toBe(false);
  });

  it("withholds every name EO keeps for itself, whatever the case", () => {
    // Reachable only from a row that predates the reservation or arrived
    // in a restored database — `readMcpServerDraft` refuses these at
    // save time — which is exactly why the check is here too.
    for (const name of RESERVED_MCP_SERVER_NAME_LIST) {
      expect(isDeliverableMcpServer(row({ name })), name).toBe(false);
      expect(isDeliverableMcpServer(row({ name: name.toUpperCase() })), name.toUpperCase()).toBe(false);
    }
    expect(RESERVED_MCP_SERVER_NAME_LIST).toContain(REPOSITORY_MCP_SERVER_NAME);
  });
});

/**
 * A connector's definition, read at the same boundary the rest of a
 * server is (EO-315).
 *
 * The one behaviour worth a test of its own is the fold: a connector's
 * declared secrets *are* the server's environment variables, said once.
 * Two lists would be two lists to keep in step, and the failure is
 * invisible until a dispatch — a token stored where nothing reads it.
 */
describe("a server that is a connector", () => {
  const slack = {
    label: "Slack",
    kind: "token" as const,
    secretNames: ["SLACK_BOT_TOKEN"],
    oauth: null,
  };

  it("declares the connector's secrets as the server's environment variables", () => {
    const read = readMcpServerDraft(draft({ name: "slack", transport: "stdio", command: "slack-mcp", connector: slack }));

    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.envNames).toEqual(["SLACK_BOT_TOKEN"]);
    expect(read.connector).toEqual(slack);
  });

  it("does not list a name twice when the server already declared it", () => {
    const read = readMcpServerDraft(
      draft({ name: "slack", transport: "stdio", command: "slack-mcp", envNames: ["SLACK_BOT_TOKEN"], connector: slack }),
    );

    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.envNames).toEqual(["SLACK_BOT_TOKEN"]);
  });

  it("refuses a definition that is not well-formed, beside everything else wrong with the draft", () => {
    const read = readMcpServerDraft(
      draft({ name: "slack", transport: "stdio", command: "", connector: { ...slack, label: "" } }),
    );

    expect(read).toEqual({
      ok: false,
      problems: [
        "A connector needs a name to put on its Connect button.",
        "A stdio server needs a command to run.",
      ],
    });
  });

  /**
   * Absent is silence and `null` is a deletion. The catalogue editor
   * does not offer a connector's words, so a person fixing a command
   * sends a draft with no `connector` in it — and that must not strip a
   * pack's definition off the row. `saveMcpServer` is where the two are
   * told apart; this is the half that keeps the distinction legible at
   * the boundary.
   */
  it("distinguishes saying nothing from saying no", () => {
    const silent = readMcpServerDraft(draft({ name: "slack", transport: "stdio", command: "slack-mcp" }));
    const removed = readMcpServerDraft(draft({ name: "slack", transport: "stdio", command: "slack-mcp", connector: null }));

    expect(silent.ok && silent.connector).toBeUndefined();
    expect(removed.ok && removed.connector).toBeNull();
  });
});
