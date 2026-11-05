import { rmSync } from "node:fs";
import { actionDefinitionProviderSchema, developerRegistry, outputSchemaFor, SECTION_LOCKED_CHANNELS, type IpcChannel, type IpcResponse } from "@eo/core";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { createPipeline, createRoute, createStep, currentVersion, saveActionDefinition } from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { fakePlatform } from "../testing/platform.js";
import { listPipelineStepViews } from "./domainQueries.js";
import { clearHandlerRegistry, dispatchIpc } from "./registry.js";

/**
 * `roleActions:inspect`, through the real handler (EO-427): what the
 * agent screen is told about one role's action — the schema a provider
 * is handed for it, and the steps a change to its result keys reaches.
 */

const directories: string[] = [];
let handle: DbHandle;

const ALIGNMENT = {
  role: "qa",
  action: "alignment",
  description: "Checks the work against the brief.",
  results: [
    { key: "aligned", label: "Aligned", meaning: "" },
    { key: "gaps_found", label: "Gaps found", meaning: "" },
  ],
  fields: { properties: { gaps: { type: "array", items: { type: "string" } } }, required: ["gaps"] },
};

async function inspect(role: string, action: string): Promise<IpcResponse<"roleActions:inspect">> {
  const answer = await dispatchIpc("roleActions:inspect", { role, action });
  if (!answer.ok) throw new Error(JSON.stringify(answer));
  return answer.data as IpcResponse<"roleActions:inspect">;
}

/** The shipped Delivery graph, as `pipeline:save` takes it. */
function delivery() {
  const graph = listPipelineStepViews(handle.db, { pipelineId: "default" });
  return { pipelineId: "default", entryStepId: graph.entryStepId, steps: graph.steps, routes: graph.routes };
}

async function publish(graph: ReturnType<typeof delivery>) {
  const published = await dispatchIpc("pipeline:save", graph);
  expect(published, JSON.stringify(published)).toMatchObject({ ok: true, data: { saved: true } });
}

/** Delivery with a "Check" step — `qa` running `alignment` — routing the keys given. */
function withCheck(before: ReturnType<typeof delivery>, keys: string[]) {
  const check = { ...before.steps[0]!, id: "qa_check", name: "Check", type: "agent" as const, ownerRole: "qa", entryAction: "alignment", isTerminal: false, position: 99 };
  return {
    ...before,
    steps: [...before.steps, check],
    routes: [...before.routes, ...keys.map((resultKey) => ({ ...before.routes[0]!, id: `qa-${resultKey}`, fromStepId: "qa_check", resultKey, target: "terminal" }))],
  };
}

beforeEach(async () => {
  handle = openMigratedTestDb();
  const platform = fakePlatform();
  directories.push(platform.userDataPath);
  const { registerAllHandlers } = await import("./handlers.js");
  registerAllHandlers(handle.db, undefined, { platform });
});

afterEach(() => {
  clearHandlerRegistry();
  handle.close();
});

afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

describe("the schema a provider is handed", () => {
  it("is the pack's own for a shipped role's shipped action, not one generated from its result keys", async () => {
    const { providerSchema } = await inspect("reviewer", "review");

    expect(JSON.stringify(providerSchema)).toBe(JSON.stringify(outputSchemaFor(developerRegistry(), "review", undefined, "reviewer")));
    // The reviewer answers with a verdict, which no schema generated from result keys would ask for.
    expect(JSON.stringify(providerSchema)).toContain('"verdict"');
  });

  it("is the generated one for a role's own definition, and the pack's for a custom role with none", async () => {
    expect(saveActionDefinition(handle.db, ALIGNMENT).ok).toBe(true);

    expect(JSON.stringify((await inspect("qa", "alignment")).providerSchema)).toBe(JSON.stringify(actionDefinitionProviderSchema(ALIGNMENT)));
    expect(JSON.stringify((await inspect("qa", "review")).providerSchema)).toBe(JSON.stringify(outputSchemaFor(developerRegistry(), "review")));
  });

  it("is nothing for an action nobody defines", async () => {
    expect((await inspect("qa", "alignment")).providerSchema).toBeNull();
  });
});

describe("the steps a change of result keys reaches", () => {
  it("names a step dispatching a pair nobody has defined yet, with the keys it routes", async () => {
    const pipeline = createPipeline(handle.db, { name: "Quality" });
    const check = createStep(handle.db, { pipelineId: pipeline.id, position: 0, name: "Check", type: "agent", ownerRole: "qa", entryAction: "alignment" });
    createRoute(handle.db, { pipelineId: pipeline.id, fromStepId: check.id, resultKey: "done", label: "Done", target: "terminal", position: 0 });
    // Another role's step on the same action name is not a use of this pair.
    createStep(handle.db, { pipelineId: pipeline.id, position: 1, name: "Edit", type: "agent", ownerRole: "editor", entryAction: "alignment" });

    expect((await inspect("qa", "alignment")).uses).toEqual([{ pipelineId: pipeline.id, pipelineName: "Quality", stepId: check.id, stepName: "Check", routedKeys: ["done"] }]);
    expect((await inspect("qa", "smoke")).uses).toEqual([]);
  });

  it("names a step only an older version still has, with that version's routes and the work bound to it", async () => {
    expect(saveActionDefinition(handle.db, ALIGNMENT).ok).toBe(true);
    const before = delivery();
    await publish(withCheck(before, ["aligned", "gaps_found"]));
    createTestItem(handle.db, { type: "story", title: "Mid-flight", stepId: "todo" });
    const boundTo = currentVersion(handle.db, "default")!;
    await publish(before);

    expect((await inspect("qa", "alignment")).uses).toEqual([
      { pipelineId: "default", pipelineName: "Delivery", stepId: "qa_check", stepName: "Check", routedKeys: ["aligned", "gaps_found"], finishing: { version: boundTo.number, items: 1 } },
    ]);
  });

  it("says a step once where an older version routes it as the current graph does, and twice where it does not", async () => {
    expect(saveActionDefinition(handle.db, ALIGNMENT).ok).toBe(true);
    const before = delivery();
    await publish(withCheck(before, ["aligned", "gaps_found"]));
    createTestItem(handle.db, { type: "story", title: "Mid-flight", stepId: "todo" });
    const boundTo = currentVersion(handle.db, "default")!;

    // Republished with something else changed: the step is routed as it was.
    const renamed = withCheck(before, ["aligned", "gaps_found"]);
    await publish({ ...renamed, steps: renamed.steps.map((step) => (step.id === "qa_check" ? { ...step, name: "Check again" } : step)) });
    expect((await inspect("qa", "alignment")).uses).toEqual([
      { pipelineId: "default", pipelineName: "Delivery", stepId: "qa_check", stepName: "Check again", routedKeys: ["aligned", "gaps_found"] },
    ]);

    // Republished with a route taken away: the item is still carried by the older version's.
    expect((await dispatchIpc("roleActions:save", { ...ALIGNMENT, results: [ALIGNMENT.results[0]!] })).ok).toBe(true);
    await publish(withCheck(before, ["aligned"]));
    expect((await inspect("qa", "alignment")).uses).toEqual([
      { pipelineId: "default", pipelineName: "Delivery", stepId: "qa_check", stepName: "Check", routedKeys: ["aligned"] },
      { pipelineId: "default", pipelineName: "Delivery", stepId: "qa_check", stepName: "Check", routedKeys: ["aligned", "gaps_found"], finishing: { version: boundTo.number, items: 1 } },
    ]);
  });
});

describe("a read, on any installation", () => {
  it("is not one of the channels a managed agents section refuses", () => {
    expect(SECTION_LOCKED_CHANNELS.agents).not.toContain("roleActions:inspect" satisfies IpcChannel);
  });
});
