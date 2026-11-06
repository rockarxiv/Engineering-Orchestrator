import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProviderModel } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../db/client.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { fetchCodexModels } from "./codexModels.js";
import {
  agentReasoningEffort,
  cachedCodexModels,
  chooseSmallModel,
  chosenSmallModel,
  defaultAgentModel,
  defaultSmallModel,
  describeSmallModels,
  resolveSmallModel,
  smallestCodexModel,
  smallModelSources,
} from "./smallModels.js";

const here = dirname(fileURLToPath(import.meta.url));

/** What the pinned Codex reports, through the same reader the Agents screen and a side call use. */
async function pinnedCodexModels(): Promise<ProviderModel[]> {
  const fixture = JSON.parse(readFileSync(join(here, "__fixtures__", "codex-0.166.0-model-list.json"), "utf8")) as { data: unknown[] };
  const listed = await fetchCodexModels("/opt/codex", async () => fixture.data as never);
  if (!listed.ok) throw new Error(listed.reason);
  return listed.models;
}

/** Each backend's small model: what EO's side calls run on (EO-477). */
describe("the small model", () => {
  let handle: DbHandle;

  beforeEach(() => {
    handle = openMigratedTestDb();
  });

  afterEach(() => {
    handle.close();
  });

  it("defaults to claude-haiku-5-5 on Claude, without asking anything", async () => {
    const codexModels = vi.fn();
    expect(await resolveSmallModel(handle.db, "claude", { codexModels })).toBe("claude-haiku-5-5");
    expect(codexModels).not.toHaveBeenCalled();
  });

  it("defaults on Codex to the smallest model the runtime reports — the cheapest, of the pinned CLI's eight gpt-6-luna", async () => {
    const models = await pinnedCodexModels();
    expect(models.length).toBe(8);
    expect(smallestCodexModel(models)).toBe("gpt-6-luna");
    expect(await resolveSmallModel(handle.db, "codex", { codexModels: async () => ({ ok: true, models }) })).toBe("gpt-6-luna");
  });

  it("passes over a model it has no price for, and keeps the runtime's order on a tie", () => {
    expect(smallestCodexModel([{ value: "gpt-9-unknown" }, { value: "gpt-6-sol" }, { value: "gpt-6.1-sol" }])).toBe("gpt-6-sol");
    expect(smallestCodexModel([{ value: "gpt-9-unknown" }])).toBeNull();
  });

  it("leaves Codex on its own default, and says why, when the runtime cannot be asked", async () => {
    const fallback = await defaultSmallModel("codex", { codexModels: async () => ({ ok: false, reason: "The Codex CLI is not installed." }) });
    expect(fallback.model).toBeNull();
    expect(fallback.note).toContain("The Codex CLI is not installed.");
  });

  it("is the person's choice once they make one, on either backend, and the default again when they clear it", async () => {
    const sources = { codexModels: async () => ({ ok: true as const, models: await pinnedCodexModels() }) };
    expect(chooseSmallModel(handle.db, "claude", "claude-sonnet-5")).toEqual({ ok: true, problem: null });
    expect(chooseSmallModel(handle.db, "codex", " gpt-6-sol ")).toEqual({ ok: true, problem: null });

    expect(await resolveSmallModel(handle.db, "claude", sources)).toBe("claude-sonnet-5");
    expect(await resolveSmallModel(handle.db, "codex", sources)).toBe("gpt-6-sol");

    chooseSmallModel(handle.db, "codex", null);
    expect(chosenSmallModel(handle.db, "codex")).toBeNull();
    expect(await resolveSmallModel(handle.db, "codex", sources)).toBe("gpt-6-luna");
  });

  it("refuses a backend with no small model of its own", () => {
    expect(chooseSmallModel(handle.db, "fake", "anything")).toMatchObject({ ok: false });
  });

  it("describes both backends for the Runtimes tab: the choice, the default, and where the default comes from", async () => {
    chooseSmallModel(handle.db, "claude", "claude-sonnet-5");
    const views = await describeSmallModels(handle.db, { codexModels: async () => ({ ok: true, models: await pinnedCodexModels() }) });
    expect(views).toEqual([
      { backend: "claude", chosen: "claude-sonnet-5", defaultModel: "claude-haiku-5-5", defaultNote: expect.stringContaining("claude-haiku-5-5") },
      { backend: "codex", chosen: null, defaultModel: "gpt-6-luna", defaultNote: expect.stringContaining("smallest model the Codex runtime reports") },
    ]);
  });

  it("asks the Codex binary that would run, and keeps its answer a while, but not a failure", async () => {
    let at = 0;
    const fetch = vi.fn(async (path: string | null) => (path === "/broken" ? { ok: false as const, reason: "no" } : { ok: true as const, models: [] }));
    const list = cachedCodexModels(fetch, 1_000, () => at);
    const sources = smallModelSources((backend) => `/runtimes/${backend}`, list);

    await sources.codexModels();
    await sources.codexModels();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("/runtimes/codex", undefined);
    at = 2_000;
    await sources.codexModels();
    expect(fetch).toHaveBeenCalledTimes(2);

    await list("/broken");
    await list("/broken");
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});

/** What a side call on the system agent's model runs on where that agent names none, and the effort it is configured with (EO-578). */
describe("the system agent's model, where it names none", () => {
  it("is the model the Codex runtime marks default — of the pinned CLI's eight, gpt-6.1-sol", async () => {
    const models = await pinnedCodexModels();
    expect(models.filter((model) => model.isDefault === true).map((model) => model.value)).toEqual(["gpt-6.1-sol"]);
    expect(await defaultAgentModel("codex", { codexModels: async () => ({ ok: true, models }) })).toBe("gpt-6.1-sol");
  });

  it("is null on Codex where the runtime cannot be asked or marks none, and on Claude, whose CLI picks its own, without asking anything", async () => {
    expect(await defaultAgentModel("codex", { codexModels: async () => ({ ok: false, reason: "not installed" }) })).toBeNull();
    expect(await defaultAgentModel("codex", { codexModels: async () => ({ ok: true, models: [{ value: "gpt-6-sol", label: "Sol", supportsEffort: true, effortLevels: [] }] }) })).toBeNull();
    const codexModels = vi.fn();
    expect(await defaultAgentModel("claude", { codexModels })).toBeNull();
    expect(codexModels).not.toHaveBeenCalled();
  });

  it("reads an agent's reasoning effort under its own backend's key", () => {
    expect(agentReasoningEffort({ provider: "claude", config: { effort: "high", reasoningEffort: "low" } })).toBe("high");
    expect(agentReasoningEffort({ provider: "codex", config: { effort: "high", reasoningEffort: "low" } })).toBe("low");
    expect(agentReasoningEffort({ provider: "claude", config: {} })).toBeNull();
    expect(agentReasoningEffort({ provider: "codex", config: { reasoningEffort: "" } })).toBeNull();
    expect(agentReasoningEffort({ provider: "fake", config: { effort: "high", reasoningEffort: "low" } })).toBeNull();
  });
});
