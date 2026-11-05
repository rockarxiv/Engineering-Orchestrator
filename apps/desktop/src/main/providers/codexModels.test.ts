import { describe, expect, it } from "vitest";
import { fetchCodexModels } from "./codexModels.js";

describe("fetchCodexModels", () => {
  it("uses the live CLI catalog, including each model's own reasoning efforts", async () => {
    const result = await fetchCodexModels("/managed/codex", async (path) => {
      expect(path).toBe("/managed/codex");
      return [
        {
          model: "gpt-new",
          displayName: "GPT New",
          description: "Current model",
          hidden: false,
          supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "ultra" }],
          isDefault: true,
        },
        { id: "fallback-id", displayName: "", hidden: false, supportedReasoningEfforts: [] },
        { model: "internal", displayName: "Internal", hidden: true, supportedReasoningEfforts: [] },
      ];
    });

    expect(result).toEqual({
      ok: true,
      models: [
        {
          value: "gpt-new",
          label: "GPT New",
          description: "Current model",
          supportsEffort: true,
          effortLevels: ["low", "ultra"],
          isDefault: true,
        },
        { value: "fallback-id", label: "fallback-id", supportsEffort: false, effortLevels: [] },
      ],
    });
  });

  it("keeps custom entry available when the CLI is missing", async () => {
    const result = await fetchCodexModels(null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("type a model name");
  });

  it("turns protocol failures into a useful editor message", async () => {
    const result = await fetchCodexModels("/managed/codex", async () => {
      throw new Error("not authenticated");
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("not authenticated");
  });
});

describe("fetchCodexModels, stopped (EO-477)", () => {
  it("hands the reader the caller's signal, so the app-server it spawns is closed when the caller stops", async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const pending = fetchCodexModels(
      "/opt/codex",
      (_path, signal) => {
        seen = signal;
        return new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("model discovery was cancelled")), { once: true }));
      },
      controller.signal,
    );
    controller.abort();

    expect(await pending).toMatchObject({ ok: false, reason: expect.stringContaining("cancelled") });
    expect(seen).toBe(controller.signal);
  });
});
