import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_REPOSITORY_INTELLIGENCE_PROVIDER, McpServerDraftSchema, SkillDraftSchema, type Agent, type McpServer } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "./db/client.js";
import { openMigratedTestDb } from "./db/testHelpers.js";
import { archiveMcpServer, deleteAgent, listAgents, listMcpServers, saveMcpServer, saveSkill, setAgentAttachment, setMcpServerEnabled, updateAgent } from "./db/repos/index.js";
import type { SecretStore } from "./secrets/store.js";
import { storeMcpServerSecret, type McpServerSecretsOptions } from "./mcp/serverSecrets.js";
import { codexHomePreflight, codexOwnSetupNotices, codexServerSecretReader, providerCacheKey, providerForAgent, type ProviderIdentity } from "./engine.js";
import { storeOrganisationSecret, type OrganisationSecretsOptions } from "./policy/organisationSecrets.js";
import { buildCodexOptions, SECRET_WITHHELD } from "./providers/codex.js";
import { agentRunVariables, clearVariable, storeVariable, type ModuleSecretsOptions } from "./modules/secrets.js";
import { windowsWithDeveloperMode, windowsWithoutPrivileges } from "./testing/unprivilegedWindowsFs.js";
import { readRepositoryIntelligenceConfig, writeRepositoryIntelligenceConfig } from "./packs/developer/repositoryIntelligence/index.js";

/**
 * The provider cache, once attachments exist (EO-106).
 *
 * The cache is module-level, has only `get` and `set`, and was keyed on
 * `JSON.stringify(agent.config)` — so anything held outside that bag was
 * invisible until the app restarted. That is the failure this file is
 * about: an edit to an attached server or skill has to take effect on
 * the next dispatch, and the key is the only thing that can make it.
 *
 * The agents here run the built-in demo provider, which is what
 * `buildProvider` falls through to for an unknown backend. Nothing is
 * spawned; what is being asserted is the identity of the object that
 * comes back.
 */
let handle: DbHandle;
let implementer: Agent;

/** `safeStorage`, minus the OS — reversing rather than prefixing, so a plaintext match is a real one. */
const reverse = (text: string) => [...text].reverse().join("");
const store: SecretStore = {
  isEncryptionAvailable: () => true,
  encryptString: (text: string) => Buffer.from(reverse(text)),
  decryptString: (buffer: Buffer) => reverse(buffer.toString()),
};

let secretsDirectory: string;
let secrets: McpServerSecretsOptions;

beforeEach(() => {
  handle = openMigratedTestDb();
  const seeded = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
  // `demo` rather than `claude`: the demo provider is cheap to build and
  // resolves no runtime, and the question here is about the cache and
  // not about any particular backend.
  updateAgent(handle.db, seeded.id, { provider: "demo" });
  implementer = listAgents(handle.db).find((agent) => agent.id === seeded.id)!;
  secretsDirectory = mkdtempSync(join(tmpdir(), "eo engine secrets "));
  secrets = { directory: secretsDirectory, store };
});

afterEach(() => {
  handle.close();
  rmSync(secretsDirectory, { recursive: true, force: true });
});

const identity = (): ProviderIdentity => ({
  eoMcpServerPath: "/unused/eoServer.mjs",
  dbPath: undefined,
  runtimeRoot: "/unused/runtimes",
  executablePath: null,
  sdkEntryPath: null,
  apiKeyDirectory: secretsDirectory,
  demoProviderDelayMs: undefined,
});

const currentAgent = () => listAgents(handle.db).find((agent) => agent.id === implementer.id)!;
const provider = () => providerForAgent(currentAgent(), "/unused/eoServer.mjs", undefined, "/unused/runtimes", handle.db);

function server(overrides: Record<string, unknown> & { name: string }) {
  const saved = saveMcpServer(handle.db, McpServerDraftSchema.parse({ transport: "stdio", command: "gh-mcp", ...overrides }));
  if (!saved.ok) throw new Error(saved.problems.join("\n"));
  return saved.server;
}

function skill(overrides: Record<string, unknown> & { name: string }) {
  const saved = saveSkill(handle.db, SkillDraftSchema.parse({ description: "A house playbook.", body: "Read the diff.", ...overrides }));
  if (!saved.ok) throw new Error(saved.problems.join("\n"));
  return saved.skill;
}

const attach = (kind: "mcpServer" | "skill", id: string) =>
  setAgentAttachment(handle.db, { agentId: implementer.id, kind, id, attached: true });

describe("providerForAgent", () => {
  it("hands back the same provider while nothing has changed", () => {
    expect(provider()).toBe(provider());
  });

  /**
   * The capability, not merely the setting (EO-151).
   *
   * A dispatch under repository intelligence is handed a query server a
   * dispatch without it is not, so switching it on changes what an agent
   * can do — and a provider cached before the switch would go on being
   * handed out with the surface it was built for. The flag would read as
   * set and behave as it was, which is the exact failure a rollout
   * switch exists to prevent.
   *
   * The *server* itself is deliberately not in the key: it is pointed at
   * one item's checkout and a cached provider works every item that
   * agent is given, so it rides on the turn. What is in the key is the
   * configuration that decides whether there is one at all.
   */
  it("rebuilds when repository intelligence is switched on under it", () => {
    const before = provider();
    expect(provider()).toBe(before);

    writeRepositoryIntelligenceConfig(handle.db, { enabled: true });

    expect(provider()).not.toBe(before);
    // And is stable again once it has been rebuilt, so this is a
    // function of the configuration rather than a counter that moves
    // whenever somebody writes one.
    expect(provider()).toBe(provider());
  });

  /**
   * The failure this story exists to close, on the server side.
   *
   * A renamed command is a different tool surface and no id moved. A
   * cache keyed on ids — or on `agent.config` alone, which is where it
   * started — would keep answering with the provider built for the old
   * command until somebody restarted the app.
   */
  it("rebuilds after an attached server's command changes", () => {
    const github = server({ name: "github" });
    attach("mcpServer", github.id);
    const before = provider();

    const edited = saveMcpServer(handle.db, McpServerDraftSchema.parse({ id: github.id, name: "github", transport: "stdio", command: "gh-mcp-v2" }));
    expect(edited.ok).toBe(true);

    expect(provider()).not.toBe(before);
  });

  /** And on the skill side: an edited body is different instructions to the model. */
  it("rebuilds after an attached skill's body changes", () => {
    const playbook = skill({ name: "House style" });
    attach("skill", playbook.id);
    const before = provider();

    const edited = saveSkill(handle.db, SkillDraftSchema.parse({ id: playbook.id, name: "House style", description: "A house playbook.", body: "Read the diff twice." }));
    expect(edited.ok).toBe(true);

    expect(provider()).not.toBe(before);
  });

  it("rebuilds when something is attached or detached", () => {
    const github = server({ name: "github" });
    const before = provider();

    attach("mcpServer", github.id);
    const attached = provider();
    expect(attached).not.toBe(before);

    setAgentAttachment(handle.db, { agentId: implementer.id, kind: "mcpServer", id: github.id, attached: false });
    expect(provider()).not.toBe(attached);
  });

  /**
   * The switch that would otherwise look broken (EO-148).
   *
   * Repository intelligence changes what an agent can do — a dispatch
   * under it is handed a query server a dispatch without it is not —
   * and a provider is cached for the life of the app. Turning it on
   * without moving the key would hand the next dispatch the provider
   * built while it was off, so the setting would read as changed and
   * behave as it was.
   */
  it("rebuilds when repository intelligence is switched on", () => {
    const before = provider();

    writeRepositoryIntelligenceConfig(handle.db, { enabled: true });

    expect(provider()).not.toBe(before);
  });

  it("rebuilds when the repository intelligence provider changes", () => {
    writeRepositoryIntelligenceConfig(handle.db, { enabled: true });
    const before = provider();

    writeRepositoryIntelligenceConfig(handle.db, { provider: "somebody-elses" });

    expect(provider()).not.toBe(before);
  });

  it("leaves another agent's provider alone", () => {
    const reviewer = listAgents(handle.db).find((agent) => agent.role === "reviewer")!;
    updateAgent(handle.db, reviewer.id, { provider: "demo" });
    const reviewerNow = () => listAgents(handle.db).find((agent) => agent.id === reviewer.id)!;
    const reviewerProvider = () => providerForAgent(reviewerNow(), "/unused/eoServer.mjs", undefined, "/unused/runtimes", handle.db);
    const before = reviewerProvider();

    attach("mcpServer", server({ name: "github" }).id);
    provider();

    expect(reviewerProvider()).toBe(before);
  });
});

describe("providerCacheKey", () => {
  /**
   * The cache is unbounded and now keys on text a person edits.
   *
   * A cap with an eviction order would have been two numbers with no
   * principle behind either. The bound taken instead is the real one:
   * the agent's id leads the key, and a miss discards that agent's
   * previous entry — at most one cached provider per agent, however many
   * times somebody edits a skill body. This asserts the property that
   * makes that possible; `providerForAgent` above asserts the eviction
   * does not reach across agents.
   */
  it("starts with the agent's id, which is what bounds the cache", () => {
    expect(providerCacheKey(currentAgent(), handle.db, identity()).startsWith(`${implementer.id}:`)).toBe(true);
  });

  /**
   * Read out of the database on every call, not captured at startup.
   *
   * The same layering `mcpHost/gate.ts` describes and the same one
   * `createEngine` gets by passing `limits` and `guards` as functions:
   * flipping a switch takes effect on the next dispatch rather than the
   * next launch. A key built from a value resolved once would be stable
   * across the write below, which is exactly the bug.
   */
  it("follows the repository intelligence configuration as it stands now", () => {
    const off = providerCacheKey(currentAgent(), handle.db, identity());
    expect(readRepositoryIntelligenceConfig(handle.db)).toEqual({ enabled: false, provider: DEFAULT_REPOSITORY_INTELLIGENCE_PROVIDER });

    writeRepositoryIntelligenceConfig(handle.db, { enabled: true });
    const on = providerCacheKey(currentAgent(), handle.db, identity());
    expect(on).not.toBe(off);

    // Both fields, so replacing the implementation is as much a change
    // as turning it on.
    writeRepositoryIntelligenceConfig(handle.db, { provider: "somebody-elses" });
    expect(providerCacheKey(currentAgent(), handle.db, identity())).not.toBe(on);

    // And back: the key is a function of the configuration, not a
    // counter that moves whenever somebody writes one.
    writeRepositoryIntelligenceConfig(handle.db, { enabled: false, provider: DEFAULT_REPOSITORY_INTELLIGENCE_PROVIDER });
    expect(providerCacheKey(currentAgent(), handle.db, identity())).toBe(off);
  });

  /**
   * An agent run's environment variables (EO-487) are handed to each
   * turn as it opens, never to the provider — so neither their values
   * nor an edit to them reaches the key, and the cached provider is the
   * one the next run gets.
   */
  it("holds no environment variable, and does not move when one is set, edited or removed", () => {
    const directory = mkdtempSync(join(tmpdir(), "eo variables "));
    try {
      const variables = { directory, store: { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => "" } };
      const before = providerCacheKey(currentAgent(), handle.db, identity());

      storeVariable(variables, "REGION", "eu-west-1");
      const set = providerCacheKey(currentAgent(), handle.db, identity());
      storeVariable(variables, "REGION", "us-east-2");
      const edited = providerCacheKey(currentAgent(), handle.db, identity());
      clearVariable(variables, "REGION");

      expect([set, edited, providerCacheKey(currentAgent(), handle.db, identity())]).toEqual([before, before, before]);
      expect(`${set}${edited}`).not.toMatch(/eu-west-1|us-east-2|REGION/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("changes when the attachments do, and not otherwise", () => {
    const before = providerCacheKey(currentAgent(), handle.db, identity());
    expect(providerCacheKey(currentAgent(), handle.db, identity())).toBe(before);

    attach("mcpServer", server({ name: "github" }).id);

    expect(providerCacheKey(currentAgent(), handle.db, identity())).not.toBe(before);
  });

  /**
   * No secret reaches the key. Three things make that true and the test
   * checks the outcome of all three at once:
   *
   * - the row holds environment-variable *names*, never values (EO-104);
   * - the value lives in the keychain-backed store, which the provider
   *   reads lazily at spawn — `providers/claude.ts` does the same with
   *   the API key, and `engine.ts` records why;
   * - the attachments reach the key as a sha256 digest, so even a row
   *   that somehow carried one would not put it in a Map key that
   *   outlives the run.
   *
   * The header is `${GITHUB_TOKEN}` on purpose: a `${VAR}` reference is
   * the closest a stored row ever comes to a secret, and it is the shape
   * a generated configuration carries.
   */
  it("carries no secret value", () => {
    const github = server({
      name: "github",
      transport: "http",
      command: undefined,
      url: "https://api.github.example/mcp",
      headers: { Authorization: "Bearer ${GITHUB_TOKEN}" },
      envNames: ["GITHUB_TOKEN"],
    });
    attach("mcpServer", github.id);
    expect(storeMcpServerSecret(secrets, github.id, "GITHUB_TOKEN", "ghp_the_actual_secret")).toEqual({ ok: true });

    const key = providerCacheKey(currentAgent(), handle.db, identity());

    expect(key).not.toContain("ghp_the_actual_secret");
    // Nor anything else a person typed into the server: the digest is
    // what stands in for all of it.
    expect(key).not.toContain("GITHUB_TOKEN");
    expect(key).not.toContain("api.github.example");
    // And the key is still doing its job — a fingerprint that never
    // moved would pass the assertions above by being useless.
    const withoutIt = setAgentAttachment(handle.db, { agentId: implementer.id, kind: "mcpServer", id: github.id, attached: false });
    expect(withoutIt.ok).toBe(true);
    expect(providerCacheKey(currentAgent(), handle.db, identity())).not.toBe(key);
  });
});

/**
 * Which value a Codex agent's attached server is handed for a declared
 * name (EO-328, EO-377).
 *
 * The values used to stop at the Codex CLI, and `codexSecretNotices`
 * told the person to define the server in `~/.codex/config.toml`
 * instead. EO-377 delivers them, so the question that matters is the one
 * the Claude path already answers: whose value arrives. The
 * organisation's, when it has one — and not the person's own when the
 * organisation's is there but cannot be read.
 */
describe("codexServerSecretReader", () => {
  let organisationDirectory: string;
  let organisation: OrganisationSecretsOptions;

  beforeEach(() => {
    organisationDirectory = mkdtempSync(join(tmpdir(), "eo engine organisation secrets "));
    organisation = { directory: organisationDirectory, store };
  });

  afterEach(() => {
    rmSync(organisationDirectory, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  /** A store that holds the file and cannot open it — written under another keychain. */
  const unreadableOrganisation = (): OrganisationSecretsOptions => ({
    directory: organisationDirectory,
    store: { ...store, decryptString: () => { throw new Error("written under another keychain"); } },
  });

  /** A stdio server and a remote one whose header refers to the same name. */
  function stdioAndHeader(name: string) {
    const stdio = server({ name: "github", envNames: [name] });
    const remote = server({
      name: "linear",
      transport: "http",
      command: null,
      url: "https://mcp.linear.app/mcp",
      headers: { Authorization: `Bearer \${${name}}` },
      envNames: [name],
    });
    return { stdio, remote };
  }

  function expandedAuthorization(built: ReturnType<typeof buildCodexOptions>): string | undefined {
    const entry = (built.config?.["mcp_servers"] as Record<string, { env_http_headers?: Record<string, string> }>)["linear"];
    const variable = entry?.env_http_headers?.["Authorization"];
    return variable === undefined ? undefined : built.env?.[variable];
  }

  it("hands a stdio server the organisation's value first, through `env_vars` and the CLI's environment", () => {
    const github = server({ name: "github", envNames: ["GITHUB_TOKEN", "GITHUB_HOST"] });
    expect(storeMcpServerSecret(secrets, github.id, "GITHUB_TOKEN", "ghp_personal").ok).toBe(true);
    expect(storeMcpServerSecret(secrets, github.id, "GITHUB_HOST", "github.example.com").ok).toBe(true);
    expect(storeOrganisationSecret(organisation, "GITHUB_TOKEN", "ghp_organisation").ok).toBe(true);

    const built = buildCodexOptions({ attachedServers: [github], serverSecret: codexServerSecretReader(secrets, organisation) });

    expect((built.config?.["mcp_servers"] as Record<string, unknown>)["github"]).toMatchObject({ env_vars: ["GITHUB_TOKEN", "GITHUB_HOST"] });
    // The organisation's value for the name it holds, the person's for the one it does not.
    expect(built.env).toMatchObject({ GITHUB_TOKEN: "ghp_organisation", GITHUB_HOST: "github.example.com" });
  });

  it("does not fall back to the person's value when the organisation's cannot be read", () => {
    const github = server({ name: "github", envNames: ["GITHUB_TOKEN"] });
    expect(storeMcpServerSecret(secrets, github.id, "GITHUB_TOKEN", "ghp_personal").ok).toBe(true);
    expect(storeOrganisationSecret(organisation, "GITHUB_TOKEN", "ghp_organisation").ok).toBe(true);

    const read = codexServerSecretReader(secrets, unreadableOrganisation());

    // Withheld rather than null: null would leave the name to whatever the
    // Codex CLI inherits, which is a substitution of the same kind.
    expect(read(github.id, "GITHUB_TOKEN")).toBe(SECRET_WITHHELD);
  });

  it("lets an empty organisation value win over the person's stored value and the CLI's inherited one", () => {
    vi.stubEnv("GITHUB_TOKEN", "ghp_from_the_persons_shell");
    const { stdio, remote } = stdioAndHeader("GITHUB_TOKEN");
    expect(storeMcpServerSecret(secrets, stdio.id, "GITHUB_TOKEN", "ghp_personal").ok).toBe(true);
    expect(storeOrganisationSecret(organisation, "GITHUB_TOKEN", "").ok).toBe(true);

    const built = buildCodexOptions({ attachedServers: [stdio, remote], serverSecret: codexServerSecretReader(secrets, organisation) });

    // What the stdio child's `env_vars` copies, and what the header expands from.
    expect(built.env?.["GITHUB_TOKEN"]).toBe("");
    expect(expandedAuthorization(built)).toBe("Bearer ");
  });

  it("delivers neither the person's value nor the CLI's inherited one when the organisation's cannot be read", () => {
    vi.stubEnv("GITHUB_TOKEN", "ghp_from_the_persons_shell");
    const { stdio, remote } = stdioAndHeader("GITHUB_TOKEN");
    expect(storeMcpServerSecret(secrets, stdio.id, "GITHUB_TOKEN", "ghp_personal").ok).toBe(true);
    expect(storeOrganisationSecret(organisation, "GITHUB_TOKEN", "ghp_organisation").ok).toBe(true);

    const built = buildCodexOptions({ attachedServers: [stdio, remote], serverSecret: codexServerSecretReader(secrets, unreadableOrganisation()) });

    expect(built.env).toBeDefined();
    expect(built.env).not.toHaveProperty("GITHUB_TOKEN");
    // Left as typed, as the Claude CLI leaves a reference to an unset name.
    expect(expandedAuthorization(built)).toBe("Bearer ${GITHUB_TOKEN}");
    expect(JSON.stringify(built.env)).not.toContain("ghp_");
  });

  it("reads the person's value when there is no organisation at all", () => {
    const github = server({ name: "github", envNames: ["GITHUB_TOKEN"] });
    expect(storeMcpServerSecret(secrets, github.id, "GITHUB_TOKEN", "ghp_personal").ok).toBe(true);

    expect(codexServerSecretReader(secrets, undefined)(github.id, "GITHUB_TOKEN")).toBe("ghp_personal");
    expect(codexServerSecretReader(secrets, undefined)(github.id, "UNDECLARED")).toBeNull();
  });

  /**
   * The run's environment variables, last (EO-488, ARCHITECTURE.md
   * §14.2): the organisation's value, then the server's own secret, then
   * the step's variable, then the shared variable — the order
   * `attachmentEnvironment` applies on the Claude path. The variables are
   * composed by the real store, as the supervisor composes them per turn.
   */
  describe("and the run's environment variables", () => {
    let variableDirectory: string;
    let variables: ModuleSecretsOptions;

    beforeEach(() => {
      variableDirectory = mkdtempSync(join(tmpdir(), "eo engine variables "));
      variables = { directory: variableDirectory, store };
    });

    afterEach(() => rmSync(variableDirectory, { recursive: true, force: true }));

    const run = (attachedServers: McpServer[], stepId: string | null, organisationSecrets: OrganisationSecretsOptions = organisation) =>
      buildCodexOptions({ attachedServers, serverSecret: codexServerSecretReader(secrets, organisationSecrets) }, undefined, undefined, undefined, undefined, agentRunVariables(variables, stepId));

    it("fill a declared name with no secret, through `env_vars` and the CLI's environment", () => {
      const cloud = server({ name: "cloud", envNames: ["REGION"] });
      storeVariable(variables, "REGION", "eu-west-1");

      const built = run([cloud], null);

      expect((built.config?.["mcp_servers"] as Record<string, unknown>)["cloud"]).toMatchObject({ env_vars: ["REGION"] });
      expect(built.env?.["REGION"]).toBe("eu-west-1");
      expect(codexServerSecretReader(secrets, organisation)(cloud.id, "REGION", { REGION: "eu-west-1" })).toBe("eu-west-1");
    });

    it("give the step's value over the shared one, for a run on that step only", () => {
      const cloud = server({ name: "cloud", envNames: ["REGION"] });
      storeVariable(variables, "REGION", "eu-west-1");
      storeVariable(variables, "REGION", "us-east-2", "step-a");

      expect(run([cloud], "step-a").env?.["REGION"]).toBe("us-east-2");
      expect(run([cloud], "step-b").env?.["REGION"]).toBe("eu-west-1");
    });

    it("lose to the server's own secret, and both lose to the organisation's", () => {
      const cloud = server({ name: "cloud", envNames: ["REGION", "ZONE"] });
      expect(storeMcpServerSecret(secrets, cloud.id, "REGION", "from-the-servers-secret").ok).toBe(true);
      expect(storeMcpServerSecret(secrets, cloud.id, "ZONE", "from-the-servers-secret").ok).toBe(true);
      expect(storeOrganisationSecret(organisation, "ZONE", "from-the-organisation").ok).toBe(true);
      storeVariable(variables, "REGION", "from-a-shared-variable");
      storeVariable(variables, "ZONE", "from-a-step-variable", "step-a");

      expect(run([cloud], "step-a").env).toMatchObject({ REGION: "from-the-servers-secret", ZONE: "from-the-organisation" });
    });

    it("do not displace another delivered server's secret of the same name, whichever comes first", () => {
      const withSecret = server({ name: "alpha", envNames: ["REGION"] });
      const without = server({ name: "zulu", envNames: ["REGION"] });
      expect(storeMcpServerSecret(secrets, withSecret.id, "REGION", "from-alphas-secret").ok).toBe(true);
      storeVariable(variables, "REGION", "from-a-variable");

      // The environment is flat: a variable filling `zulu`'s gap in the
      // same walk overwrote `alpha`'s secret when `zulu` came later.
      expect(run([withSecret, without], null).env?.["REGION"]).toBe("from-alphas-secret");
      expect(run([without, withSecret], null).env?.["REGION"]).toBe("from-alphas-secret");
    });

    it("fill a name no delivered server has a secret for", () => {
      storeVariable(variables, "REGION", "from-a-variable");

      expect(run([server({ name: "alpha", envNames: ["REGION"] }), server({ name: "zulu", envNames: ["REGION"] })], null).env?.["REGION"]).toBe("from-a-variable");
    });

    it("do not stand in for an organisation value that cannot be read", () => {
      const cloud = server({ name: "cloud", envNames: ["REGION"] });
      expect(storeOrganisationSecret(organisation, "REGION", "from-the-organisation").ok).toBe(true);
      storeVariable(variables, "REGION", "eu-west-1");

      const built = run([cloud], null, unreadableOrganisation());

      expect(built.env).toBeDefined();
      expect(built.env).not.toHaveProperty("REGION");
    });

    it("expand a remote server's header that refers to the name", () => {
      const { remote } = stdioAndHeader("REGION_TOKEN");
      storeVariable(variables, "REGION_TOKEN", "tok-from-a-variable");

      expect(expandedAuthorization(run([remote], null))).toBe("Bearer tok-from-a-variable");
    });

    it("are given to no server that is disabled or archived", () => {
      const disabled = server({ name: "disabled", envNames: ["REGION"] });
      const archived = server({ name: "archived", envNames: ["REGION"] });
      setMcpServerEnabled(handle.db, disabled.id, false);
      archiveMcpServer(handle.db, archived.id);
      storeVariable(variables, "REGION", "eu-west-1");
      const rows = listMcpServers(handle.db, true).filter((row) => row.id === disabled.id || row.id === archived.id);
      expect(rows).toHaveLength(2);

      const built = run(rows, null);

      expect(Object.keys((built.config?.["mcp_servers"] as Record<string, unknown> | undefined) ?? {})).toEqual([]);
      // Nothing is read for them: the reader is never asked.
      const asked: string[] = [];
      buildCodexOptions({ attachedServers: rows, serverSecret: (_id, name) => (asked.push(name), null) }, undefined, undefined, undefined, undefined, { REGION: "eu-west-1" });
      expect(asked).toEqual([]);
    });
  });
});

/**
 * What a locked-down Codex agent's dispatch checks first (EO-378): its
 * own home is made, homes nobody uses any more are removed, and a
 * dispatch that would run signed out while the Runtimes card says signed
 * in is refused with the reason instead.
 */
describe("codexHomePreflight", () => {
  let person: string;
  let root: string;

  beforeEach(() => {
    person = mkdtempSync(join(tmpdir(), "eo person codex "));
    mkdirSync(join(person, "sessions"));
    root = mkdtempSync(join(tmpdir(), "eo codex homes "));
    vi.stubEnv("CODEX_HOME", person);
    updateAgent(handle.db, implementer.id, { provider: "codex" });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(person, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it("makes the agent's home and lets the dispatch go when the sign-in is carried", async () => {
    writeFileSync(join(person, "auth.json"), "{}");

    const verdict = await codexHomePreflight(currentAgent(), handle.db, [root], async () => "signed_in");

    expect(verdict).toEqual({ ok: true });
    expect(readdirSync(join(root, implementer.id)).sort()).toEqual(["auth.json", "sessions"]);
  });

  it("refuses, saying why, when the card says signed in and there was no credential file to carry", async () => {
    const verdict = await codexHomePreflight(currentAgent(), handle.db, [root], async () => "signed_in");

    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain(join(person, "auth.json"));
    expect(verdict.reason).toContain("Let this agent use your own Codex setup");
  });

  it("removes the home of an agent that was deleted, moved to Claude or ticked over to the person's own setup", async () => {
    writeFileSync(join(person, "auth.json"), "{}");
    const others = listAgents(handle.db).filter((agent) => agent.id !== implementer.id).slice(0, 3);
    for (const other of others) mkdirSync(join(root, other.id));
    const [deleted, moved, ownSetup] = others;
    deleteAgent(handle.db, deleted!.id);
    updateAgent(handle.db, moved!.id, { provider: "claude" });
    updateAgent(handle.db, ownSetup!.id, { provider: "codex", config: { inheritAmbientConfig: true } });

    await codexHomePreflight(currentAgent(), handle.db, [root], async () => "signed_in");

    expect(readdirSync(root)).toEqual([implementer.id]);
    expect(existsSync(join(person, "auth.json"))).toBe(true);
  });

  /**
   * A sign-in in the OS keyring, which no home but the person's can
   * reach: the agent runs in their own home, and the item is told why
   * (decided on EO-378).
   */
  describe("when the person's Codex keeps its sign-in in the keyring", () => {
    beforeEach(() => {
      writeFileSync(join(person, "config.toml"), 'cli_auth_credentials_store = "keyring"\n');
    });

    it("lets the dispatch go in the person's own home, makes no home of the agent's, and sweeps the ones there were", async () => {
      mkdirSync(join(root, implementer.id));

      const verdict = await codexHomePreflight(currentAgent(), handle.db, [root], async () => "signed_in");

      expect(verdict).toEqual({ ok: true });
      expect(readdirSync(root)).toEqual([]);
    });

    it("says so on the item for a locked-down Codex agent, and for no other", () => {
      const [notice] = codexOwnSetupNotices(currentAgent(), [root]);
      expect(notice).toContain(`${currentAgent().name} runs with your own Codex setup in ${person}`);
      expect(notice).toContain("keyring");

      updateAgent(handle.db, implementer.id, { config: { inheritAmbientConfig: true } });
      expect(codexOwnSetupNotices(currentAgent(), [root])).toEqual([]);
      updateAgent(handle.db, implementer.id, { provider: "claude", config: {} });
      expect(codexOwnSetupNotices(currentAgent(), [root])).toEqual([]);
    });
  });

  /**
   * `auto`, with a credential in the keyring and an `auth.json` left
   * behind. Codex in the person's home answers the card from the keyring;
   * a home of the agent's own would read the stale file and fail. The
   * dispatch runs in the home the card asked, so the two agree.
   */
  it("runs in the person's own home when a stale credential file sits beside a keyring sign-in, so the card and the dispatch agree", async () => {
    writeFileSync(join(person, "config.toml"), 'cli_auth_credentials_store = "auto"\n');
    writeFileSync(join(person, "auth.json"), '{"tokens":{"refresh_token":"stale"}}');

    const verdict = await codexHomePreflight(currentAgent(), handle.db, [root], async () => "signed_in");

    expect(verdict).toEqual({ ok: true });
    // No home was made that would point the agent at the stale file.
    expect(readdirSync(root)).toEqual([]);
    expect(codexOwnSetupNotices(currentAgent(), [root])[0]).toContain("keyring");
  });

  /**
   * Windows, where `auth.json` is a file symlink (EO-774), which needs
   * Developer Mode or an administrator.
   */
  describe("on Windows", () => {
    beforeEach(() => writeFileSync(join(person, "auth.json"), "{}"));

    it("dispatches locked down where Developer Mode is on", async () => {
      const seams = { platform: "win32" as const, fs: windowsWithDeveloperMode() };

      const verdict = await codexHomePreflight(currentAgent(), handle.db, [root], async () => "signed_in", seams);

      expect(verdict).toEqual({ ok: true });
      expect(readdirSync(join(root, implementer.id)).sort()).toEqual(["auth.json", "sessions"]);
      expect(lstatSync(join(root, implementer.id, "auth.json")).isSymbolicLink()).toBe(true);
    });

    it("refuses the dispatch without Developer Mode, saying to turn it on or tick the agent over, and never runs it in the person's own home", async () => {
      const seams = { platform: "win32" as const, fs: windowsWithoutPrivileges() };

      const verdict = await codexHomePreflight(currentAgent(), handle.db, [root], async () => "signed_in", seams);

      expect(verdict.ok).toBe(false);
      expect(verdict.reason).toContain("Developer Mode");
      expect(verdict.reason).toContain("Let this agent use your own Codex setup");
      // Not a notice about running unlocked: nothing runs.
      expect(codexOwnSetupNotices(currentAgent(), [root], seams)).toEqual([]);
    });
  });

  it("has nothing to say on the item when the sign-in is in a file", () => {
    writeFileSync(join(person, "auth.json"), "{}");
    expect(codexOwnSetupNotices(currentAgent(), [root])).toEqual([]);
  });
});
