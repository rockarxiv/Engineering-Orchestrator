import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";
import { capabilitiesFor, fetchClaudeModels, providerSteersLiveTurns } from "./capabilities.js";
import { createClaudeProvider } from "./claude.js";
import { createCodexProvider } from "./codex.js";

describe("capabilitiesFor", () => {
  it("offers each backend only its own settings", () => {
    const claude = capabilitiesFor("claude");
    const codex = capabilitiesFor("codex");

    // Reasoning effort is the one both have and neither shares a list
    // for: Claude's levels are not Codex's, and offering one provider
    // the other's would offer settings that get silently ignored.
    expect(claude.reasoningEfforts).toContain("max");
    expect(claude.reasoningEfforts).not.toContain("minimal");
    expect(codex.reasoningEfforts).toContain("minimal");
    expect(codex.reasoningEfforts).not.toContain("max");
  });

  /**
   * The settings that stopped being settings (EO-178).
   *
   * Each of the three had exactly one correct value under EO and is
   * pinned where the process is spawned, so publishing a list of the
   * others was publishing ways to break the agent dressed as
   * configuration. Asserted as an absence from the whole shape rather
   * than as three empty arrays: an empty array is a question the editor
   * keeps asking that has no answer, and it is the field that had to go.
   */
  it("publishes no list for a setting EO has already decided", () => {
    for (const provider of ["claude", "codex", "fake"]) {
      const caps = capabilitiesFor(provider) as Record<string, unknown>;
      expect(Object.keys(caps), provider).not.toContain("permissionModes");
      expect(Object.keys(caps), provider).not.toContain("sandboxModes");
      expect(Object.keys(caps), provider).not.toContain("approvalPolicies");
      // Not a list, but gone for the same reason a list would be (EO-375):
      // Codex has no max turns, so neither backend offers it.
      expect(Object.keys(caps), provider).not.toContain("supportsMaxTurns");
    }
  });

  it("says which provider's list is live, so the UI knows when to ask", () => {
    expect(capabilitiesFor("claude").modelsAreLive).toBe(true);
    expect(capabilitiesFor("codex").modelsAreLive).toBe(true);
    expect(capabilitiesFor("codex").models).toEqual([]);
  });

  it("gives the fake provider nothing to configure, rather than throwing", () => {
    // The editor renders whatever a provider offers, so an unknown or
    // configuration-free backend has to be describable.
    const fake = capabilitiesFor("fake");

    expect(fake.models).toEqual([]);
    expect(fake.reasoningEfforts).toEqual([]);
  });
});

/**
 * The predicate and the providers, checked against each other (EO-176).
 *
 * Two places have to agree about whether a backend can be spoken to
 * mid-turn: the stream, which either implements `steer` or does not, and
 * this predicate, which is what a screen asks *before* there is a
 * message to deliver. Nothing in the type system ties them together — so
 * a backend gaining the capability while the predicate stayed put would
 * surface as a missing control and nothing louder. This is the thing
 * that would be loud.
 */
describe("providerSteersLiveTurns", () => {
  it("agrees with the stream each backend actually returns", () => {
    const startOpts = { instructions: "", context: "", cwd: "/tmp/wt", signal: new AbortController().signal };
    const claude = createClaudeProvider({ runQuery: (() => (async function* () {})()) as never }).start(startOpts);
    const codex = createCodexProvider({
      createCodex: () => ({ startThread: () => ({ runStreamed: async () => ({ events: (async function* () {})() }), run: vi.fn() }) }) as never,
    }).start(startOpts);

    expect(providerSteersLiveTurns("claude")).toBe(typeof claude.steer === "function");
    expect(providerSteersLiveTurns("codex")).toBe(typeof codex.steer === "function");
    expect(providerSteersLiveTurns("claude")).toBe(true);
    // EO-373: `turn/steer` over the app-server.
    expect(providerSteersLiveTurns("codex")).toBe(true);
  });

  it("answers no for a backend it has never heard of", () => {
    // Fails closed, like every other capability question in EO: an
    // unknown backend is offered no control rather than one that might
    // do nothing.
    expect(providerSteersLiveTurns("fake")).toBe(false);
    expect(providerSteersLiveTurns("")).toBe(false);
  });
});

describe("fetchClaudeModels", () => {
  function fakeQuery(models: ModelInfo[] | Error) {
    return (() => ({
      supportedModels: () => (models instanceof Error ? Promise.reject(models) : Promise.resolve(models)),
      return: vi.fn(),
    })) as never;
  }

  it("asks the installed SDK rather than a list we maintain", async () => {
    const result = await fetchClaudeModels(
      fakeQuery([
        { value: "claude-opus-5", displayName: "Opus 5", description: "", supportsEffort: true, supportedEffortLevels: ["low", "high"] },
        { value: "claude-haiku-4-5", displayName: "Haiku 4.5", description: "", supportsEffort: false },
      ] as ModelInfo[]),
    );

    expect(result).toEqual({
      ok: true,
      models: [
        { value: "claude-opus-5", label: "Opus 5", supportsEffort: true, effortLevels: ["low", "high"] },
        { value: "claude-haiku-4-5", label: "Haiku 4.5", supportsEffort: false, effortLevels: [] },
      ],
    });
  });

  it("falls back to the model id when the SDK gives no display name", async () => {
    const result = await fetchClaudeModels(fakeQuery([{ value: "claude-new", displayName: "", description: "" } as ModelInfo]));

    expect(result.ok && result.models[0]?.label).toBe("claude-new");
  });

  it("treats an empty list as a failure to answer, because that is what being signed out looks like", async () => {
    // Found live: an unauthenticated CLI returns [] rather than
    // throwing, so the dropdown was empty and silent about why.
    const result = await fetchClaudeModels(fakeQuery([]));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("signed in");
  });

  it("explains a failed fetch instead of throwing, and says the field still works", async () => {
    // Not signed in, or no CLI on PATH. The editor keeps a typeable
    // field, so this must not take the screen down.
    const result = await fetchClaudeModels(fakeQuery(new Error("not authenticated")));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("not authenticated");
    expect(result.reason).toContain("type a model name");
  });
});
