import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PipelineSaveInputSchema, type PipelineStep, type PipelineStepView, type StepRouteSave, type Uuid } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { createPipeline, createProject, createRoute, createStep, currentVersion, listRoutesForPipeline, setEntryStep, versionSnapshot } from "../db/repos/index.js";
import { renderPipeline } from "../mcpHost/render.js";
import { exportPipeline, importPipeline } from "../modules/pipelineTransfer.js";
import { savePipeline, validatePipelineCommand } from "./configCommands.js";
import { listPipelineStepViews } from "./domainQueries.js";
import { pipelineVersionsCommand } from "./pipelineCommands.js";

/**
 * A route's traversal limit (EO-921) as part of the graph: read by
 * `pipeline_get`, written by `pipeline_save` — kept where a save leaves it
 * out, cleared by null, refused below 1 — frozen in the version a save
 * files and given back by a restore, reported by the version diff, and
 * carried by export and import.
 */
let handle: DbHandle;
let pipelineId: Uuid;
let write: PipelineStep;
let check: PipelineStep;
let done: PipelineStep;

beforeEach(() => {
  handle = openMigratedTestDb();
  const project = createProject(handle.db, { name: "Workbench", keyPrefix: "WRK" });
  pipelineId = createPipeline(handle.db, { projectId: project.id, name: "Drafts" }).id as Uuid;
  write = createStep(handle.db, { pipelineId, position: 0, name: "Write", type: "user", results: [{ key: "done", label: "Written", tone: "success", requiresComment: false }] });
  check = createStep(handle.db, {
    pipelineId,
    position: 1,
    name: "Check",
    type: "user",
    results: [
      { key: "approved", label: "Approve", tone: "success", requiresComment: false },
      { key: "send_back", label: "Send back", tone: "warning", requiresComment: true },
    ],
  });
  done = createStep(handle.db, { pipelineId, position: 2, name: "Done", type: "user", isTerminal: true });
  createRoute(handle.db, { pipelineId, fromStepId: write.id, resultKey: "done", label: "Written", tone: "success", target: check.id, position: 0 });
  createRoute(handle.db, { pipelineId, fromStepId: check.id, resultKey: "approved", label: "Approve", tone: "success", target: done.id, position: 0 });
  createRoute(handle.db, { pipelineId, fromStepId: check.id, resultKey: "send_back", label: "Send back", tone: "warning", target: write.id, position: 1 });
  setEntryStep(handle.db, pipelineId, write.id);
});

afterEach(() => handle.close());

/** The graph as a save sends it, with Check → Send back's limit as given; `undefined` leaves the key out. */
function routes(limit: number | null | undefined): StepRouteSave[] {
  const sendBack = { id: "r3", pipelineId, fromStepId: check.id, resultKey: "send_back", label: "Send back", tone: "warning" as const, target: write.id, position: 1 };
  return [
    { id: "r1", pipelineId, fromStepId: write.id, resultKey: "done", label: "Written", tone: "success", target: check.id, position: 0 },
    { id: "r2", pipelineId, fromStepId: check.id, resultKey: "approved", label: "Approve", tone: "success", target: done.id, position: 0 },
    limit === undefined ? sendBack : { ...sendBack, traversalLimit: limit },
  ];
}

function steps(): PipelineStepView[] {
  return [write, check, done].map((step) => ({ ...step, workspaceMode: step.workspaceMode, moduleVersion: null, brief: null }));
}

const save = (limit: number | null | undefined) => savePipeline(handle.db, { notifyStateChange: () => {} }, { pipelineId, steps: steps(), routes: routes(limit), entryStepId: write.id });
const sendBackLimit = () => listRoutesForPipeline(handle.db, pipelineId).find((route) => route.resultKey === "send_back")!.traversalLimit;

describe("a route's traversal limit, as part of the graph (EO-921)", () => {
  it("is stored by a save, kept by one that leaves it out, cleared by null, and refused below 1 or as a fraction", () => {
    expect(sendBackLimit()).toBeNull();
    expect(save(3).saved).toBe(true);
    expect(sendBackLimit()).toBe(3);

    expect(save(undefined).saved).toBe(true);
    expect(sendBackLimit()).toBe(3);

    expect(save(null).saved).toBe(true);
    expect(sendBackLimit()).toBeNull();

    // The rule `pipeline:save` and the `pipeline_save` tool read the request by.
    for (const refused of [0, -1, 1.5]) {
      expect(PipelineSaveInputSchema.safeParse({ pipelineId, steps: steps(), routes: routes(refused), entryStepId: write.id }).success, String(refused)).toBe(false);
    }
    expect(PipelineSaveInputSchema.safeParse({ pipelineId, steps: steps(), routes: routes(1), entryStepId: write.id }).success).toBe(true);

    // And the same rule where a caller reaches the save, or the editor's check, without the schema.
    for (const refused of [0, 1.5]) {
      const result = save(refused);
      expect(result.saved, String(refused)).toBe(false);
      expect(result.problems).toContainEqual(expect.objectContaining({ severity: "error", stateId: check.id, message: expect.stringContaining("a whole number of 1 or more") }));
      const checked = validatePipelineCommand(handle.db, { pipelineId, steps: steps(), routes: routes(refused), entryStepId: write.id });
      expect(checked.problems).toContainEqual(expect.objectContaining({ severity: "error", stateId: check.id }));
    }
    expect(sendBackLimit()).toBeNull();
  });

  it("is what pipeline_get reads and says, and only on the route that has one", () => {
    expect(save(3).saved).toBe(true);
    const graph = listPipelineStepViews(handle.db, { pipelineId });
    expect(graph.routes.map((route) => [route.resultKey, route.traversalLimit])).toEqual(
      expect.arrayContaining([
        ["done", null],
        ["approved", null],
        ["send_back", 3],
      ]),
    );
    const said = renderPipeline(graph);
    expect(said).toContain(`on \`send_back\` → ${write.id} (Send back) — taken at most 3 times since a person last commented, then held for one: \`traversalLimit: 3\``);
    expect(said.match(/traversalLimit/g)).toHaveLength(1);
  });

  it("is frozen in the version a save files, reported by the diff, and given back by a restore", () => {
    expect(save(3).saved).toBe(true);
    const limited = currentVersion(handle.db, pipelineId)!;
    expect(versionSnapshot(handle.db, limited.id)?.routes.find((route) => route.resultKey === "send_back")?.traversalLimit).toBe(3);

    expect(save(null).saved).toBe(true);
    const cleared = currentVersion(handle.db, pipelineId)!;
    expect(versionSnapshot(handle.db, cleared.id)?.routes.find((route) => route.resultKey === "send_back")?.traversalLimit).toBeNull();

    const diff = pipelineVersionsCommand(handle.db, { pipelineId, from: limited.number, to: cleared.number }).diff;
    expect(diff?.routes).toEqual([{ fromStepName: "Check", resultKey: "send_back", change: "changed", fields: [{ field: "traversalLimit", before: "3", after: "no limit" }] }]);

    const restored = pipelineVersionsCommand(handle.db, { pipelineId, graph: limited.number }).graph;
    expect(restored?.routes.find((route) => route.resultKey === "send_back")?.traversalLimit).toBe(3);
    expect(savePipeline(handle.db, { notifyStateChange: () => {} }, { pipelineId, steps: restored!.steps, routes: restored!.routes, entryStepId: restored!.entryStepId }).saved).toBe(true);
    expect(sendBackLimit()).toBe(3);
  });

  it("travels in an export, written only where a route has one, and comes back on import", () => {
    expect(save(3).saved).toBe(true);
    const exported = exportPipeline(handle.db, pipelineId);
    if (!exported.ok) throw new Error(exported.reason);
    expect(exported.document.routes.find((route) => route.resultKey === "send_back")?.traversalLimit).toBe(3);
    expect(exported.document.routes.find((route) => route.resultKey === "approved")).not.toHaveProperty("traversalLimit");

    const imported = importPipeline(handle.db, { document: exported.document });
    if (!imported.ok) throw new Error(JSON.stringify(imported));
    const landed = listRoutesForPipeline(handle.db, imported.pipelineId);
    expect(landed.find((route) => route.resultKey === "send_back")).toMatchObject({ fromStepId: imported.stepIds[check.id], traversalLimit: 3 });
    expect(landed.filter((route) => route.traversalLimit !== null)).toHaveLength(1);
  });
});
