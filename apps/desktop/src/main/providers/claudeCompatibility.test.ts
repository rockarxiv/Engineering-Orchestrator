import { describe, expect, it } from "vitest";
import {
  claudeCompatibilityHolds,
  claudeSettingsLayers,
  effectiveClaudeEnvironment,
  effectiveClaudeModel,
  fullPromptHeld,
  isCustomModelName,
  modelCatalogHeldOff,
  refusalFallbackHeldOff,
  toolSearchHeldOff,
  type ClaudeSettingsReader,
} from "./claudeCompatibility.js";

/** Settings files by path, as a reader the module can be handed. */
function filesReader(files: Record<string, unknown>, dirs: Record<string, string[]> = {}): ClaudeSettingsReader {
  return { readText: (path) => (path in files ? JSON.stringify(files[path]) : null), listDir: (path) => dirs[path] ?? [] };
}

const GATEWAY = "https://llm-gateway.example.com/anthropic";

/**
 * The defaults claude@0.3.312 changed, each held to claude@0.3.302's answer
 * (EO-599). Every rule here was read off both binaries and measured with a
 * capture server; the measurements are recorded in `claudeCompatibility.ts`.
 */
describe("which settings files the CLI reads, and in what order", () => {
  const home = "/home/someone";
  const cwd = "/work/repo";
  const all = filesReader(
    {
      [`${home}/.claude.json`]: { env: { A: "global" } },
      [`${home}/.claude/settings.json`]: { env: { A: "user", B: "user" }, model: "user-model" },
      [`${cwd}/.claude/settings.json`]: { env: { A: "project" }, model: "project-model" },
      [`${cwd}/.claude/settings.local.json`]: { env: { A: "local" } },
      "/etc/claude-code/managed-settings.json": { env: { C: "managed" } },
      "/etc/claude-code/managed-settings.d/20-later.json": { env: { C: "drop-in" } },
    },
    { "/etc/claude-code/managed-settings.d": ["20-later.json", "notes.txt"] },
  );

  it("reads the legacy global config, the project's and the managed files for a locked-down agent, in that order", () => {
    const layers = claudeSettingsLayers({ cwd, env: { HOME: home }, sources: "project", platform: "linux", reader: all });
    expect(layers.map((layer) => layer.source)).toEqual(["globalConfig", "projectSettings", "policySettings", "policySettings"]);
    expect(effectiveClaudeEnvironment({ A: "spawn" }, layers)).toMatchObject({ A: "project", C: "drop-in" });
  });

  it("adds the person's user and local settings for an agent on their own setup, local winning", () => {
    const layers = claudeSettingsLayers({ cwd, env: { HOME: home }, sources: "all", platform: "linux", reader: all });
    expect(layers.map((layer) => layer.source)).toEqual(["globalConfig", "userSettings", "projectSettings", "localSettings", "policySettings", "policySettings"]);
    expect(effectiveClaudeEnvironment({}, layers)).toMatchObject({ A: "local", B: "user" });
  });

  it("reads neither the project's nor the person's settings for a side call", () => {
    const layers = claudeSettingsLayers({ cwd, env: { HOME: home }, sources: "none", platform: "linux", reader: all });
    expect(layers.map((layer) => layer.source)).toEqual(["globalConfig", "policySettings", "policySettings"]);
  });

  it("follows CLAUDE_CONFIG_DIR for both the global config and the user settings", () => {
    const reader = filesReader({ "/cfg/.claude.json": { env: { A: "global" } }, "/cfg/settings.json": { env: { B: "user" } }, [`${home}/.claude.json`]: { env: { A: "ignored" } } });
    const layers = claudeSettingsLayers({ cwd, env: { HOME: home, CLAUDE_CONFIG_DIR: "/cfg" }, sources: "all", platform: "linux", reader });
    expect(effectiveClaudeEnvironment({}, layers)).toEqual({ A: "global", B: "user" });
  });

  it("spells every path the way the platform it was given does, whatever this one is (EO-598)", () => {
    const reader = filesReader(
      {
        "C:\\Users\\someone\\.claude.json": { env: { A: "global" } },
        "C:\\work\\repo\\.claude\\settings.json": { env: { B: "project" } },
        "C:\\Program Files\\ClaudeCode\\managed-settings.json": { env: { C: "managed" } },
        "C:\\Program Files\\ClaudeCode\\managed-settings.d\\20-later.json": { env: { C: "drop-in" } },
      },
      { "C:\\Program Files\\ClaudeCode\\managed-settings.d": ["20-later.json"] },
    );
    const layers = claudeSettingsLayers({ cwd: "C:\\work\\repo", env: { HOME: "C:\\Users\\someone" }, sources: "project", platform: "win32", reader });
    expect(layers.map((layer) => layer.source)).toEqual(["globalConfig", "projectSettings", "policySettings", "policySettings"]);
    expect(effectiveClaudeEnvironment({}, layers)).toEqual({ A: "global", B: "project", C: "drop-in" });
  });

  it("skips a file it cannot parse, as the CLI does", () => {
    const reader: ClaudeSettingsReader = { readText: (path) => (path === `${cwd}/.claude/settings.json` ? "{ not json" : null), listDir: () => [] };
    expect(claudeSettingsLayers({ cwd, env: { HOME: home }, sources: "project", platform: "linux", reader })).toEqual([]);
  });

  it("names the model on the command line first, then ANTHROPIC_MODEL, then the highest settings file", () => {
    const layers = claudeSettingsLayers({ cwd, env: { HOME: home }, sources: "all", platform: "linux", reader: all });
    expect(effectiveClaudeModel("explicit", {}, layers)).toBe("explicit");
    expect(effectiveClaudeModel(null, { ANTHROPIC_MODEL: "from-env" }, layers)).toBe("from-env");
    expect(effectiveClaudeModel(null, {}, layers)).toBe("project-model");
    expect(effectiveClaudeModel(null, {}, [])).toBeNull();
    // An alias through the person's own pin for it.
    expect(effectiveClaudeModel("sonnet", { ANTHROPIC_DEFAULT_SONNET_MODEL: "my-sonnet-deployment" }, [])).toBe("my-sonnet-deployment");
    expect(effectiveClaudeModel("sonnet", {}, [])).toBe("sonnet");
  });
});

describe("tool search behind a gateway", () => {
  it("is held off where 2.1.302 turned it off", () => {
    expect(toolSearchHeldOff({ ANTHROPIC_BASE_URL: GATEWAY })).toBe(true);
    // A base URL the old CLI could not parse was not first-party to it either.
    expect(toolSearchHeldOff({ ANTHROPIC_BASE_URL: "not a url" })).toBe(true);
  });

  it("is left alone everywhere 2.1.302 left it on", () => {
    expect(toolSearchHeldOff({})).toBe(false);
    expect(toolSearchHeldOff({ ANTHROPIC_BASE_URL: "https://api.anthropic.com" })).toBe(false);
    expect(toolSearchHeldOff({ ANTHROPIC_BASE_URL: GATEWAY, CLAUDE_CODE_USE_BEDROCK: "1" })).toBe(false);
    // Set means non-empty, "0" included: measured, CLAUDE_CODE_USE_VERTEX=0 still puts the CLI on Vertex.
    expect(toolSearchHeldOff({ ANTHROPIC_BASE_URL: GATEWAY, CLAUDE_CODE_USE_VERTEX: "0" })).toBe(false);
    expect(toolSearchHeldOff({ ANTHROPIC_BASE_URL: GATEWAY, _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: "1" })).toBe(false);
  });

  it("is the person's to decide once they have said anything", () => {
    expect(toolSearchHeldOff({ ANTHROPIC_BASE_URL: GATEWAY, ENABLE_TOOL_SEARCH: "true" })).toBe(false);
    expect(toolSearchHeldOff({ ANTHROPIC_BASE_URL: GATEWAY, ENABLE_TOOL_SEARCH: "auto:50" })).toBe(false);
  });
});

describe("what is not held", () => {
  it("leaves the Monitor tool to the pinned CLI: nothing is withheld with telemetry or nonessential traffic off, or on Vertex", () => {
    // A scope decision (EO-599): 2.1.312's Monitor, sleep refusal, prompt
    // guidance and plugin monitors come as one, and EO keeps none of them back.
    for (const env of [{ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" }, { DISABLE_TELEMETRY: "1" }, { DO_NOT_TRACK: "1" }]) {
      expect(claudeCompatibilityHolds({ spawnEnv: { HOME: "/home/someone", ...env }, cwd: "/work/repo", sources: "project", platform: "linux", reader: filesReader({}) })).toEqual({ env: {} });
    }
    expect(Object.keys(claudeCompatibilityHolds({ spawnEnv: { HOME: "/home/someone", CLAUDE_CODE_USE_VERTEX: "1" }, cwd: "/work/repo", sources: "project", platform: "linux", reader: filesReader({}) }))).toEqual(["env"]);
  });
});

describe("a custom deployment on a cloud platform", () => {
  it("is a name no spelling of a Claude model matches", () => {
    expect(isCustomModelName("my-custom-deployment")).toBe(true);
    expect(isCustomModelName(null)).toBe(false);
    for (const known of ["claude-opus-5-5", "us.anthropic.claude-sonnet-4-5-20250929-v1:0", "claude-sonnet-4-5@20250929", "sonnet", "opus[1m]", "team-haiku"]) {
      expect(isCustomModelName(known), known).toBe(false);
    }
    // An inference profile's old answer depended on the model behind it, which EO cannot look up.
    expect(isCustomModelName("arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc123")).toBe(false);
  });

  it("keeps the full prompt on Bedrock, Foundry, Mantle and Vertex, unless the person chose", () => {
    for (const platform of ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_USE_MANTLE", "CLAUDE_CODE_USE_VERTEX"]) {
      expect(fullPromptHeld({ [platform]: "1" }, "my-custom-deployment"), platform).toBe(true);
    }
    expect(fullPromptHeld({}, "my-custom-deployment")).toBe(false);
    expect(fullPromptHeld({ CLAUDE_CODE_USE_ANTHROPIC_AWS: "1" }, "my-custom-deployment")).toBe(false);
    expect(fullPromptHeld({ CLAUDE_CODE_USE_VERTEX: "1" }, "claude-sonnet-4-5@20250929")).toBe(false);
    expect(fullPromptHeld({ CLAUDE_CODE_USE_VERTEX: "1", CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT: "1" }, "my-custom-deployment")).toBe(false);
  });

  it("gets no refusal fallback, on any provider, unless the person chose", () => {
    expect(refusalFallbackHeldOff({}, "my-custom-deployment")).toBe(true);
    expect(refusalFallbackHeldOff({ CLAUDE_CODE_USE_VERTEX: "1" }, "my-custom-deployment")).toBe(true);
    expect(refusalFallbackHeldOff({}, "claude-opus-5-5")).toBe(false);
    expect(refusalFallbackHeldOff({}, null)).toBe(false);
    expect(refusalFallbackHeldOff({ CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK: "" }, "my-custom-deployment")).toBe(true);
  });

  it("downloads no model catalogue on the four cloud platforms, unless the person chose", () => {
    expect(modelCatalogHeldOff({ CLAUDE_CODE_USE_VERTEX: "1" })).toBe(true);
    expect(modelCatalogHeldOff({ CLAUDE_CODE_USE_BEDROCK: "1" })).toBe(true);
    expect(modelCatalogHeldOff({})).toBe(false);
    expect(modelCatalogHeldOff({ CLAUDE_CODE_USE_VERTEX: "1", CLAUDE_CODE_MODEL_CATALOG: "on" })).toBe(false);
  });
});

describe("everything a turn is handed", () => {
  it("decides on the settings files as well as the spawn environment", () => {
    const reader = filesReader({ "/work/repo/.claude/settings.json": { env: { ANTHROPIC_BASE_URL: GATEWAY, CLAUDE_CODE_USE_VERTEX: "" }, model: "my-custom-deployment" } });
    expect(claudeCompatibilityHolds({ spawnEnv: { HOME: "/home/someone" }, cwd: "/work/repo", sources: "project", platform: "linux", reader })).toEqual({
      env: { ENABLE_TOOL_SEARCH: "false", CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK: "1" },
    });
  });

  it("holds nothing for a turn on Anthropic's own API with nothing set", () => {
    expect(claudeCompatibilityHolds({ spawnEnv: { HOME: "/home/someone" }, cwd: "/work/repo", sources: "all", platform: "linux", reader: filesReader({}) })).toEqual({ env: {} });
  });

  it("never sets a variable a settings file defines, even as empty, which the CLI would lay over it", () => {
    const reader = filesReader({ "/work/repo/.claude/settings.json": { env: { CLAUDE_CODE_USE_VERTEX: "1", CLAUDE_CODE_MODEL_CATALOG: "", DISABLE_TELEMETRY: "1" } } });
    const holds = claudeCompatibilityHolds({ spawnEnv: { HOME: "/home/someone" }, cwd: "/work/repo", sources: "project", model: "my-custom-deployment", platform: "linux", reader });
    expect(holds).toEqual({
      env: { CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT: "0", CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK: "1" },
    });
  });

  it("holds over an empty value in the spawn environment, which EO's own value replaces", () => {
    const holds = claudeCompatibilityHolds({ spawnEnv: { HOME: "/home/someone", CLAUDE_CODE_USE_VERTEX: "1", CLAUDE_CODE_MODEL_CATALOG: "" }, cwd: "/work/repo", sources: "project", platform: "linux", reader: filesReader({}) });
    expect(holds.env["CLAUDE_CODE_MODEL_CATALOG"]).toBe("off");
  });
});
