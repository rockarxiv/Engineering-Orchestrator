import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { TEAM_EVIDENCE_TOOLS, type AgentEvent } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { createAgent } from "../db/repos/agentsRepo.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { reportOnlyProviderForAgent } from "../engine.js";
import { fakeAppServer, note } from "../testing/fakeCodexAppServer.js";
import { lockReportOnly, reportOnlyOptionsProblem } from "./claude.js";
import { codexClientOptions, createCodexProvider, reportOnlyCodexConfigProblem, REPORT_ONLY_CODEX_FEATURES, type CodexProviderOptions } from "./codex.js";
import { CodexClient, dropWarmCodexThread } from "./codexClient.js";
import { reportOnlyBridgeProblem } from "./reportOnly.js";

/**
 * What each backend refuses a report-only team participant (EO-845) on
 * its own terms, beside what `providerParity.test.ts` holds both to: a
 * lock undone after it was written, a Codex launch missing any of its
 * parts, and the composition root's refusals and per-attempt isolation.
 */

const scratch: string[] = [];
function directory(): string {
  const made = mkdtempSync(join(tmpdir(), "eo-report-only-"));
  scratch.push(made);
  return made;
}
afterEach(() => {
  dropWarmCodexThread();
  for (const made of scratch.splice(0)) rmSync(made, { recursive: true, force: true });
});

const CREDENTIAL = { url: "http://127.0.0.1:1/agent-write", token: "item-1~evidence~attempt-1.signed", writes: [...TEAM_EVIDENCE_TOOLS], reportOnly: true };
const EO_MCP = { serverPath: "/app/eoServer.mjs" };

describe("a report-only credential", () => {
  it("must be marked report-only and name the evidence tools and nothing else", () => {
    expect(reportOnlyBridgeProblem(CREDENTIAL)).toBeNull();
    expect(reportOnlyBridgeProblem(undefined)).not.toBeNull();
    expect(reportOnlyBridgeProblem({ ...CREDENTIAL, reportOnly: undefined } as never)).toContain("not a report-only");
    expect(reportOnlyBridgeProblem({ ...CREDENTIAL, writes: [...TEAM_EVIDENCE_TOOLS, "comment"] } as never)).toContain("comment");
    expect(reportOnlyBridgeProblem({ ...CREDENTIAL, writes: [] })).not.toBeNull();
  });
});

describe("Claude's lock", () => {
  /** What a turn's options look like once built for an ordinary agent, with everything a lock must take off. */
  function built(): Options {
    return {
      cwd: "/tmp/participant",
      tools: ["Bash"],
      allowedTools: ["Bash", "mcp__eo__comment"],
      settingSources: ["project"],
      plugins: [{ type: "local", path: "/tmp/tools" }],
      extraArgs: { "mcp-config": "/tmp/tools/.mcp.json" },
      skills: ["eo-attachments:house-style"],
      mcpServers: {
        repo: { type: "stdio", command: "repo" },
        eo_admin: { type: "http", url: "http://127.0.0.1:2/mcp" },
        eo: { type: "stdio", command: "node", args: ["/app/eoServer.mjs"], env: { EO_MCP_WRITE_BRIDGE: JSON.stringify(CREDENTIAL) } },
      },
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [async () => ({})] }], SessionStart: [{ hooks: [async () => ({})] }] },
      promptSuggestions: true,
    } as Options;
  }

  it("leaves only EO's server, no built-in tool, no setting source and one hook", () => {
    const options = built();
    lockReportOnly(options);
    expect(reportOnlyOptionsProblem(options)).toBeNull();
    expect(Object.keys(options.mcpServers ?? {})).toEqual(["eo"]);
    expect(options.tools).toEqual([]);
    expect(options.settingSources).toEqual([]);
    expect(options.plugins).toBeUndefined();
    expect(options.extraArgs?.["mcp-config"]).toBeUndefined();
    expect(options.allowedTools).toEqual(TEAM_EVIDENCE_TOOLS.map((tool) => `mcp__eo__${tool}`));
    expect(Object.keys(options.hooks ?? {})).toEqual(["PreToolUse"]);
    expect(options.promptSuggestions).toBeUndefined();
  });

  it("is checked, so a lock that was undone is a turn refused, saying what", () => {
    const undo: [string, (options: Options) => void][] = [
      ["its built-in tools are not switched off", (options) => (options.tools = ["Bash"])],
      ["it would load settings", (options) => (options.settingSources = ["project"])],
      ["beside EO's own server", (options) => (options.mcpServers = { ...options.mcpServers, github: { type: "stdio", command: "gh" } })],
      ["no hook refuses its other calls", (options) => (options.hooks = {})],
      ["hooks EO did not write", (options) => (options.hooks = { ...options.hooks, PostToolUse: [{ hooks: [async () => ({})] }] })],
      ["not a report-only participant's", (options) => ((options.mcpServers!["eo"] as { env: Record<string, string> }).env["EO_MCP_WRITE_BRIDGE"] = JSON.stringify({ url: "u", token: "t" }))],
      ["load a plugin", (options) => (options.plugins = [{ type: "local", path: "/tmp/x" }])],
    ];
    for (const [said, change] of undo) {
      const options = built();
      lockReportOnly(options);
      change(options);
      expect(reportOnlyOptionsProblem(options), said).toContain(said);
    }
    const none = built();
    delete none.mcpServers;
    lockReportOnly(none);
    expect(reportOnlyOptionsProblem(none)).toContain("no EO server");
  });
});

describe("Codex's launch", () => {
  function participant(options: Record<string, unknown> = {}) {
    const caches = directory();
    writeFileSync(join(caches, "models_cache.json"), JSON.stringify({ models: [{ slug: "gpt-participant", tool_mode: "code_mode_only" }] }));
    const home = directory();
    const fake = fakeAppServer({ after: { "turn/start": [note.turnStarted(), note.agentMessage("done"), note.turnCompleted()] } });
    const base: Parameters<typeof createCodexProvider>[0] = {
      reportOnly: true,
      executablePath: "/opt/codex",
      eoMcp: EO_MCP,
      searchHookCommandPath: "/opt/eo/hook.mjs",
      searchHookTrust: async () => ({ key: "k", hash: "sha256:abc" }),
      codexHome: () => home,
      sideCallModelCaches: () => [join(caches, "models_cache.json")],
      config: { model: "gpt-participant" },
      ...options,
    } as CodexProviderOptions;
    const provider = createCodexProvider({
      ...base,
      createCodex: (repository, searchHook, attachFrom, memoryScopes, variables, writeBridge, withheld, adminDirectory, skillSlugs) =>
        new CodexClient({ ...codexClientOptions(base, repository, searchHook, attachFrom, memoryScopes, variables, writeBridge, withheld, adminDirectory, skillSlugs), spawn: fake.spawn, shutdownGraceMs: 200, killGraceMs: 100 }),
    });
    return { fake, provider };
  }

  async function outcome(stream: AsyncIterable<AgentEvent>): Promise<string> {
    let said = "";
    try {
      for await (const event of stream) if (event.type === "error") said += event.message;
    } catch (error) {
      said += error instanceof Error ? error.message : String(error);
    }
    return said;
  }

  const turn = (cwd: string) => ({ instructions: "Report.", context: "EO-1", cwd, writeBridge: CREDENTIAL, signal: new AbortController().signal });

  it("runs with every part in place", async () => {
    const { fake, provider } = participant();
    expect(await outcome(provider.start(turn(directory())))).toBe("");
    expect(fake.launches).toHaveLength(1);
  });

  it("is refused before the app-server starts without the hook command, its model in the catalogue, a home of its own, or on the person's setup", async () => {
    const cases: [string, Record<string, unknown>, RegExp][] = [
      ["no hook command", { searchHookCommandPath: undefined }, /hook/],
      ["a model the catalogue does not name", { config: { model: "gpt-unknown" } }, /does not name gpt-unknown/],
      ["no model", { config: {} }, /names no model/],
      ["the person's own home", { codexHome: () => null }, /person's own Codex home/],
      ["the person's own setup", { config: { model: "gpt-participant", inheritAmbientConfig: true } }, /person's own Codex setup/],
    ];
    for (const [name, options, said] of cases) {
      const { fake, provider } = participant(options);
      expect(await outcome(provider.start(turn(directory()))), name).toMatch(said);
      expect(fake.launches, name).toHaveLength(0);
    }
  });

  it("is checked, so a launch with a feature left on, another server or no hook is refused", () => {
    const config = {
      mcp_servers: { eo: { env: { EO_MCP_WRITE_BRIDGE: JSON.stringify(CREDENTIAL) } } },
      hooks: { PreToolUse: [{ matcher: "*" }] },
      features: { ...REPORT_ONLY_CODEX_FEATURES },
      model_catalog_json: "/tmp/catalog.json",
    };
    const env = { CODEX_HOME: "/tmp/home" };
    expect(reportOnlyCodexConfigProblem(config, env)).toBeNull();
    expect(reportOnlyCodexConfigProblem({ ...config, features: { ...config.features, shell_tool: true } }, env)).toContain("shell_tool");
    expect(reportOnlyCodexConfigProblem({ ...config, mcp_servers: { ...config.mcp_servers, github: {} } }, env)).toContain("beside EO's own");
    expect(reportOnlyCodexConfigProblem({ ...config, hooks: { PreToolUse: [{ matcher: "Bash" }] } }, env)).toContain("hook");
    expect(reportOnlyCodexConfigProblem({ ...config, model_catalog_json: undefined }, env)).toContain("catalogue");
    expect(reportOnlyCodexConfigProblem(config, {})).toContain("person's own Codex home");
  });

  it("is never warmed or forked", async () => {
    const { fake, provider } = participant();
    provider.prewarm?.({ kind: "start", instructions: "Report.", cwd: directory(), warmKey: "k" } as never);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fake.launches).toHaveLength(0);
    const forked = await provider.fork!("thr-1", "go", { writeBridge: CREDENTIAL });
    expect(forked.ok).toBe(false);
  });
});

describe("a participant's provider, from the composition root", () => {
  let handle: DbHandle;
  const priorCodexHome = process.env["CODEX_HOME"];
  beforeEach(() => {
    handle = openMigratedTestDb();
    // The person's own Codex home, kept out of the test's way.
    process.env["CODEX_HOME"] = directory();
  });
  afterEach(() => {
    handle.close();
    if (priorCodexHome === undefined) delete process.env["CODEX_HOME"];
    else process.env["CODEX_HOME"] = priorCodexHome;
  });

  const request = (agent: ReturnType<typeof createAgent>, attemptId: string, roots: string[], participantRoot: string) =>
    reportOnlyProviderForAgent({
      agent,
      attemptId,
      eoMcpServerPath: "/app/eoServer.mjs",
      dbPath: undefined,
      runtimeRoot: directory(),
      db: handle.db,
      codexHomeRoots: roots,
      codexSearchHookCommandPath: "/opt/eo/hook.mjs",
      participantRoot,
    });

  it("gives two attempts of one agent separate directories, Codex homes and providers", () => {
    const agent = createAgent(handle.db, { name: "Rita", role: "reviewer", provider: "codex", model: "gpt-participant", instructions: "Review." });
    const roots = [directory()];
    const participants = directory();
    const first = request(agent, "019f0000-0000-7000-8000-000000000001", roots, participants);
    const second = request(agent, "019f0000-0000-7000-8000-000000000002", roots, participants);
    if (!first.ok || !second.ok) throw new Error("refused");
    expect(first.cwd).not.toBe(second.cwd);
    expect(readdirSync(first.cwd)).toEqual([]);
    expect(first.provider).not.toBe(second.provider);
    const homes = readdirSync(join(roots[0]!, agent.id)).sort();
    expect(homes).toEqual(["019f0000-0000-7000-8000-000000000001", "019f0000-0000-7000-8000-000000000002"]);
    const claude = createAgent(handle.db, { name: "Cleo", role: "reviewer", provider: "claude", model: "claude-test", instructions: "Review." });
    const one = request(claude, "019f0000-0000-7000-8000-000000000003", roots, participants);
    const two = request(claude, "019f0000-0000-7000-8000-000000000004", roots, participants);
    expect(one.ok && two.ok && one.cwd !== two.cwd && existsSync(one.cwd)).toBe(true);
  });

  it("refuses, saying why, what it cannot hold to report-only", () => {
    const roots = [directory()];
    const participants = directory();
    const demo = createAgent(handle.db, { name: "Dee", role: "reviewer", provider: "demo", model: null, instructions: "." });
    expect(request(demo, "019f0000-0000-7000-8000-000000000005", roots, participants)).toMatchObject({ ok: false, problem: expect.stringContaining("only Claude and Codex") });
    const ambient = createAgent(handle.db, { name: "Amb", role: "reviewer", provider: "claude", model: null, instructions: ".", config: { inheritAmbientConfig: true } });
    expect(request(ambient, "019f0000-0000-7000-8000-000000000006", roots, participants)).toMatchObject({ ok: false, problem: expect.stringContaining("person's own setup") });
    const noModel = createAgent(handle.db, { name: "Nom", role: "reviewer", provider: "codex", model: null, instructions: "." });
    expect(request(noModel, "019f0000-0000-7000-8000-000000000007", roots, participants)).toMatchObject({ ok: false, problem: expect.stringContaining("names no model") });
    const codex = createAgent(handle.db, { name: "Cod", role: "reviewer", provider: "codex", model: "gpt-participant", instructions: "." });
    expect(request(codex, "019f0000-0000-7000-8000-000000000008", [], participants)).toMatchObject({ ok: false });
    expect(request(codex, "../escape", roots, participants)).toMatchObject({ ok: false });
  });
});
