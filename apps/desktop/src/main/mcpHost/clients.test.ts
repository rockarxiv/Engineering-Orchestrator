import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TOKEN_VAR, claudeDesktopConfig, createRunner, detectClients, registerWith, type ClientContext, type Runner } from "./clients.js";

/**
 * Registering EO with the clients someone already has.
 *
 * The runner is faked because the point is which command EO invokes and
 * with what — driving the real `claude` would test their CLI, and
 * driving it *and writing to a real home directory* would edit the
 * config of whoever ran the suite.
 */
const REGISTRATION = { url: "http://127.0.0.1:4319/mcp", token: "a-token" };

function fakeRunner(responses: Record<string, { ok?: boolean; stdout?: string; notFound?: boolean; error?: string }>): {
  run: Runner;
  calls: { cli: string; args: string[] }[];
} {
  const calls: { cli: string; args: string[] }[] = [];
  const run: Runner = async (cli, args) => {
    calls.push({ cli, args });
    // Longest matching prefix, so a stub keyed on "claude mcp" answers
    // both `mcp list` and `mcp add --scope user …` without the test
    // having to restate every argument.
    const invocation = `${cli} ${args.join(" ")}`;
    const key = Object.keys(responses)
      .filter((candidate) => invocation.startsWith(candidate))
      .sort((a, b) => b.length - a.length)[0];
    const reply = key === undefined ? {} : responses[key]!;
    return {
      ok: reply.ok ?? !(reply.notFound ?? false),
      stdout: reply.stdout ?? "",
      error: reply.error ?? "",
      notFound: reply.notFound ?? false,
    };
  };
  return { run, calls };
}

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "eo-mcp-clients-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function context(run: Runner): ClientContext {
  return { run, home, platform: "linux" };
}

describe("finding what is installed", () => {
  it("reports a CLI that is not on PATH as absent rather than as a failure", async () => {
    const { run } = fakeRunner({ claude: { notFound: true }, codex: { notFound: true } });

    const found = await detectClients(context(run));

    expect(found.map((client) => [client.id, client.installed])).toEqual([
      ["claude-code", false],
      ["codex", false],
      ["claude-desktop", false],
    ]);
    expect(found.every((client) => client.problem === null)).toBe(true);
  });

  it("notices EO is already registered, so it does not offer to add it twice", async () => {
    const { run } = fakeRunner({
      "claude --version": { stdout: "1.0.0" },
      "claude mcp": { stdout: "eo: http://127.0.0.1:4319/mcp (HTTP) - ✓ Connected" },
      "codex --version": { stdout: "0.5.0" },
      "codex mcp": { stdout: "Name  Url\nother  http://elsewhere" },
    });

    const found = await detectClients(context(run));

    expect(found.find((client) => client.id === "claude-code")?.registered).toBe(true);
    expect(found.find((client) => client.id === "codex")?.registered).toBe(false);
  });

  it("says it cannot tell, rather than guessing no, when the client's own command fails", async () => {
    // Offering to add something already there is a worse answer than
    // admitting we could not check.
    const { run } = fakeRunner({ "claude --version": { stdout: "1.0.0" }, "claude mcp": { ok: false, error: "boom" }, codex: { notFound: true } });

    const found = await detectClients(context(run));

    expect(found.find((client) => client.id === "claude-code")?.registered).toBeNull();
  });

  it("finds Claude Desktop by its directory, so a fresh install is not called absent", async () => {
    // The app makes the directory on install and the config only once
    // something writes one.
    mkdirSync(join(home, ".config", "Claude"), { recursive: true });
    const { run } = fakeRunner({ claude: { notFound: true }, codex: { notFound: true } });

    const found = await detectClients(context(run));

    expect(found.find((client) => client.id === "claude-desktop")).toMatchObject({ installed: true, registered: false });
  });
});

describe("registering with Claude Code", () => {
  it("uses its own mcp add, at user scope, naming the variable that carries the token", async () => {
    const { run, calls } = fakeRunner({ "claude mcp": { stdout: "Added" } });

    const result = await registerWith(context(run), "claude-code", REGISTRATION);

    expect(result).toMatchObject({ registered: true, problem: null });
    expect(calls[0]).toEqual({
      cli: "claude",
      // `--scope user`, or it lands only in whichever directory this ran from.
      args: [
        "mcp", "add", "--scope", "user", "--transport", "http", "eo",
        // Literal `${…}`: Claude Code expands it when it connects, so the
        // token is not on this process's command line.
        "http://127.0.0.1:4319/mcp", "--header", "Authorization: Bearer ${EO_MCP_TOKEN}",
      ],
    });
    // Not finished until the person sets the variable, as with Codex.
    expect(result.caveat).toContain(`export ${TOKEN_VAR}=`);
    expect(result.caveat).toContain("Until you do, Claude Code will connect and be refused.");
  });

  it("passes the command's own complaint through rather than a generic failure", async () => {
    const { run } = fakeRunner({ "claude mcp": { ok: false, error: "already exists" } });

    expect(await registerWith(context(run), "claude-code", REGISTRATION)).toMatchObject({
      registered: false,
      problem: "already exists",
    });
  });
});

describe("registering with Codex", () => {
  it("points it at an environment variable, because that is all its mcp add takes", async () => {
    const { run, calls } = fakeRunner({ "codex mcp": { stdout: "Added global MCP server 'eo'." } });

    const result = await registerWith(context(run), "codex", REGISTRATION);

    expect(calls[0]).toEqual({
      cli: "codex",
      args: ["mcp", "add", "eo", "--url", "http://127.0.0.1:4319/mcp", "--bearer-token-env-var", TOKEN_VAR],
    });
    // The token never reaches config.toml, so the registration is not
    // finished when this returns — and the caveat is how the person
    // learns that here rather than from a refused tool call.
    expect(result.registered).toBe(true);
    expect(result.caveat).toContain(TOKEN_VAR);
  });
});

// Every platform's answer side by side, macOS's included: CI runs this
// file on Linux, where the darwin branch is never the one taken, so a
// wrong macOS path would pass everything else here. Checked against the
// MCP project's "Connect to local MCP servers"
// (https://modelcontextprotocol.io/docs/develop/connect-local-servers),
// which is where Claude Desktop's own help sends people for this file.
describe("where Claude Desktop keeps its config", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ["darwin", "/Users/someone", "/Users/someone/Library/Application Support/Claude/claude_desktop_config.json"],
    ["linux", "/home/someone", "/home/someone/.config/Claude/claude_desktop_config.json"],
    ["win32", "C:\\Users\\someone", "C:\\Users\\someone\\AppData\\Roaming\\Claude\\claude_desktop_config.json"],
  ] as const)("on %s, under %s", (platform, home, expected) => {
    vi.stubEnv("APPDATA", "C:\\Users\\someone\\AppData\\Roaming");
    expect(claudeDesktopConfig(home, platform)).toBe(expected);
  });

  it("finds it on Windows under the home's roaming folder when APPDATA is unset", () => {
    vi.stubEnv("APPDATA", undefined);
    expect(claudeDesktopConfig("C:\\Users\\someone", "win32")).toBe("C:\\Users\\someone\\AppData\\Roaming\\Claude\\claude_desktop_config.json");
  });
});

describe("registering with Claude Desktop", () => {
  it("bridges to it over stdio, since that is what the app speaks", async () => {
    mkdirSync(join(home, ".config", "Claude"), { recursive: true });
    const { run, calls } = fakeRunner({});

    const result = await registerWith(context(run), "claude-desktop", REGISTRATION);

    expect(result.registered).toBe(true);
    // No CLI exists to ask, which is the only reason EO writes this file.
    expect(calls).toEqual([]);
    const written = JSON.parse(readFileSync(claudeDesktopConfig(home, "linux"), "utf8")) as { mcpServers: Record<string, unknown> };
    expect(written.mcpServers["eo"]).toEqual({
      command: "npx",
      // No space after the colon: Claude Desktop on Windows does not
      // escape spaces in `args`, and this is mcp-remote's documented spelling.
      args: ["-y", "mcp-remote", REGISTRATION.url, "--header", "Authorization:${EO_MCP_HEADER}"],
      env: { EO_MCP_HEADER: `Bearer ${REGISTRATION.token}` },
    });
  });

  it("keeps every preference and every other server already in the file", async () => {
    const file = claudeDesktopConfig(home, "linux");
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, JSON.stringify({ preferences: { theme: "dark" }, mcpServers: { other: { command: "run-me" } } }));
    const { run } = fakeRunner({});

    await registerWith(context(run), "claude-desktop", REGISTRATION);

    const written = JSON.parse(readFileSync(file, "utf8")) as { preferences: unknown; mcpServers: Record<string, unknown> };
    expect(written.preferences).toEqual({ theme: "dark" });
    expect(Object.keys(written.mcpServers)).toEqual(["other", "eo"]);
  });

  it("refuses to touch a config it cannot parse", async () => {
    // More likely something half-edited than something EO should
    // overwrite — and overwriting it would destroy the rest of it.
    const file = claudeDesktopConfig(home, "linux");
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, "{ not json");
    const { run } = fakeRunner({});

    const result = await registerWith(context(run), "claude-desktop", REGISTRATION);

    expect(result).toMatchObject({ registered: false });
    expect(result.problem).toContain("not valid JSON");
    expect(readFileSync(file, "utf8")).toBe("{ not json");
  });
});

describe("the real runner", () => {
  it("reports a missing binary as notFound rather than as an error", async () => {
    // The distinction the whole screen rests on: "you have not installed
    // this" and "your install said no" are different answers, and only
    // the second is worth showing someone as a problem.
    const { createRunner } = await import("./clients.js");

    const result = await createRunner(home, "linux")("eo-definitely-not-a-real-binary", ["--version"]);

    expect(result).toMatchObject({ ok: false, notFound: true });
  });

  // The fixture is a `#!/bin/sh` script, and the behaviour under test is a
  // macOS one (see below) reached through a `"linux"` runner. Windows can
  // neither chmod it nor honour the shebang, so the test would be asserting
  // about a scenario that platform does not have.
  it.skipIf(process.platform === "win32")("finds a binary that is not on the inherited PATH", async () => {
    // On macOS an app launched from Finder inherits roughly
    // /usr/bin:/bin:/usr/sbin:/sbin and sees neither Homebrew nor
    // anything npm installed — so someone whose `claude` works perfectly
    // in a terminal would be told it is not installed, which is the most
    // confusing thing this screen could say. `~/.local/bin` is one of the
    // places searched beyond PATH.
    const bin = join(home, ".local", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "eo-fake-cli"), "#!/bin/sh\necho found\n", { mode: 0o755 });

    const result = await createRunner(home, "linux")("eo-fake-cli", []);

    expect(result).toMatchObject({ ok: true, stdout: "found" });
  });
});

describe("when EO cannot do it for you", () => {
  const registration = REGISTRATION;

  it("hands back the exact command it would have run", async () => {
    const { run } = fakeRunner({ "claude mcp": { ok: false, error: "permission denied" } });

    const result = await registerWith(context(run), "claude-code", registration);

    expect(result.problem).toBe("permission denied");
    // A failure with no next step is a dead end. Running it by hand also
    // prints whatever their own CLI says, which beats anything EO can
    // report back through a pipe.
    expect(result.manual?.text).toBe(
      [
        "claude mcp add --scope user --transport http eo http://127.0.0.1:4319/mcp --header 'Authorization: Bearer ${EO_MCP_TOKEN}'",
        "export EO_MCP_TOKEN=a-token",
      ].join("\n"),
    );
  });

  it("quotes what a shell would need quoted, so the command is runnable", async () => {
    // The header argument has a space in it, and a `$` a shell would
    // expand before Claude Code ever saw it. A command that is shown and
    // cannot be pasted is worse than showing nothing.
    const { run } = fakeRunner({ claude: { notFound: true }, codex: { notFound: true } });

    const [claudeCode] = await detectClients(context(run), registration);

    expect(claudeCode?.manual?.text).toContain("'Authorization: Bearer ${EO_MCP_TOKEN}'");
  });

  it("tells Codex users about the environment variable in the command itself", async () => {
    // `mcp add` alone leaves Codex connecting and being refused, because
    // the token is not in what it writes.
    const { run } = fakeRunner({ claude: { notFound: true }, codex: { notFound: true } });

    const codex = (await detectClients(context(run), registration)).find((client) => client.id === "codex");

    expect(codex?.manual?.text).toContain("--bearer-token-env-var EO_MCP_TOKEN");
    expect(codex?.manual?.text).toContain("export EO_MCP_TOKEN=a-token");
  });

  it("gives Claude Desktop the JSON and the file to put it in, having no CLI to name", async () => {
    const { run } = fakeRunner({ claude: { notFound: true }, codex: { notFound: true } });

    const desktop = (await detectClients(context(run), registration)).find((client) => client.id === "claude-desktop");

    expect(desktop?.manual?.label).toContain("claude_desktop_config.json");
    expect(JSON.parse(desktop?.manual?.text ?? "{}")).toEqual({
      mcpServers: {
        eo: {
          command: "npx",
          args: ["-y", "mcp-remote", registration.url, "--header", "Authorization:${EO_MCP_HEADER}"],
          env: { EO_MCP_HEADER: "Bearer a-token" },
        },
      },
    });
  });

  it("offers nothing to paste when there is nothing to connect to", async () => {
    // A command naming a port EO is not listening on is worse than no
    // command: it looks like it worked.
    const { run } = fakeRunner({ claude: { notFound: true }, codex: { notFound: true } });

    const found = await detectClients(context(run), null);

    expect(found.every((client) => client.manual === null)).toBe(true);
  });

  it("shows the same arguments it runs, so the two cannot drift", async () => {
    const { run, calls } = fakeRunner({ "claude mcp": { stdout: "Added" } });

    const result = await registerWith(context(run), "claude-code", registration);

    // Every argument EO passed appears in the command it would show.
    for (const argument of calls[0]!.args) {
      expect(result.manual?.text).toContain(argument.includes(" ") ? `'${argument}'` : argument);
    }
  });
});

describe("the token on a command line", () => {
  // A command line is readable by every user on the machine through `ps`
  // or /proc/<pid>/cmdline, and a shown command lands in shell history.
  // So for every client: no argument EO writes, spawns or shows carries
  // the token. It may appear only where a variable is set — an
  // `export EO_MCP_TOKEN=` line, or Claude Desktop's `env`.
  const SECRET = { url: "http://127.0.0.1:4319/mcp", token: "s3cret-tok3n-601" };

  function shownLinesWithToken(text: string): string[] {
    return text.split("\n").filter((line) => line.includes(SECRET.token));
  }

  it("never reaches the arguments EO spawns for Claude Code or Codex, nor the commands it shows", async () => {
    const { run, calls } = fakeRunner({ "claude mcp": { stdout: "Added" }, "codex mcp": { stdout: "Added" } });

    const claude = await registerWith(context(run), "claude-code", SECRET);
    const codex = await registerWith(context(run), "codex", SECRET);

    expect(calls.map((call) => call.cli)).toEqual(["claude", "codex"]);
    for (const call of calls) {
      for (const argument of call.args) expect(argument).not.toContain(SECRET.token);
    }
    expect(calls[1]!.args).toContain("--bearer-token-env-var");
    for (const result of [claude, codex]) {
      expect(shownLinesWithToken(result.manual?.text ?? "")).toEqual([`export ${TOKEN_VAR}=${SECRET.token}`]);
    }
  });

  it("never reaches the arguments EO writes for Claude Desktop, nor the snippet it shows", async () => {
    mkdirSync(join(home, ".config", "Claude"), { recursive: true });
    const { run } = fakeRunner({});

    const result = await registerWith(context(run), "claude-desktop", SECRET);

    type Entry = { args: string[]; env: Record<string, string> };
    const written = JSON.parse(readFileSync(claudeDesktopConfig(home, "linux"), "utf8")) as { mcpServers: Record<string, Entry> };
    const shown = JSON.parse(result.manual?.text ?? "{}") as { mcpServers: Record<string, Entry> };
    for (const entry of [written.mcpServers["eo"]!, shown.mcpServers["eo"]!]) {
      for (const argument of entry.args) expect(argument).not.toContain(SECRET.token);
      // The token's only place: the environment mcp-remote is started with.
      expect(JSON.stringify({ ...entry, env: undefined })).not.toContain(SECRET.token);
      expect(entry.env).toEqual({ EO_MCP_HEADER: `Bearer ${SECRET.token}` });
    }
  });

  it("is never in what detection shows for any client either", async () => {
    mkdirSync(join(home, ".config", "Claude"), { recursive: true });
    const { run } = fakeRunner({ "claude --version": { stdout: "1.0.0" }, "codex --version": { stdout: "0.5.0" } });

    const found = await detectClients(context(run), SECRET);

    for (const client of found.filter((client) => client.id !== "claude-desktop")) {
      expect(shownLinesWithToken(client.manual?.text ?? "")).toEqual([`export ${TOKEN_VAR}=${SECRET.token}`]);
    }
  });
});

describe("an entry Claude Desktop got from an older EO", () => {
  // Before EO-601 the token sat in `args`, so on mcp-remote's command line
  // for as long as Claude Desktop ran. Such an entry must not read as fine.
  function writeOldShape(token: string): string {
    const file = claudeDesktopConfig(home, "linux");
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        preferences: { theme: "dark" },
        mcpServers: {
          other: { command: "run-me", args: ["--flag"] },
          eo: { command: "npx", args: ["-y", "mcp-remote", REGISTRATION.url, "--header", `Authorization: Bearer ${token}`] },
        },
      }),
    );
    return file;
  }

  function desktopOf(found: Awaited<ReturnType<typeof detectClients>>) {
    return found.find((client) => client.id === "claude-desktop");
  }

  it("is reported as needing to be added again, so the button is offered", async () => {
    writeOldShape(REGISTRATION.token);
    const { run } = fakeRunner({ claude: { notFound: true }, codex: { notFound: true } });

    const desktop = desktopOf(await detectClients(context(run), REGISTRATION));

    expect(desktop).toMatchObject({ installed: true, registered: false, caveat: null });
    expect(desktop?.problem).toContain("Add EO again");
  });

  it("is recognised even with a token from before a rotation, or with no server running", async () => {
    writeOldShape("an-older-token");
    const { run } = fakeRunner({ claude: { notFound: true }, codex: { notFound: true } });

    expect(desktopOf(await detectClients(context(run), REGISTRATION))?.registered).toBe(false);
    expect(desktopOf(await detectClients(context(run), null))?.problem).toContain("Add EO again");
  });

  it("is replaced by registering again, leaving the rest of the file alone", async () => {
    const file = writeOldShape(REGISTRATION.token);
    const { run } = fakeRunner({ claude: { notFound: true }, codex: { notFound: true } });

    await registerWith(context(run), "claude-desktop", REGISTRATION);

    const written = JSON.parse(readFileSync(file, "utf8")) as { preferences: unknown; mcpServers: Record<string, unknown> };
    expect(written.preferences).toEqual({ theme: "dark" });
    expect(written.mcpServers).toEqual({
      other: { command: "run-me", args: ["--flag"] },
      eo: {
        command: "npx",
        args: ["-y", "mcp-remote", REGISTRATION.url, "--header", "Authorization:${EO_MCP_HEADER}"],
        env: { EO_MCP_HEADER: `Bearer ${REGISTRATION.token}` },
      },
    });
    // And the new shape reads as registered, with nothing to fix.
    expect(desktopOf(await detectClients(context(run), REGISTRATION))).toMatchObject({ registered: true, problem: null });
  });
});
