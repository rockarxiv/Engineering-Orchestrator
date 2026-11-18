import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Uuid } from "@eo/core";
import type { DbHandle } from "../client.js";
import { openMigratedTestDb } from "../testHelpers.js";
import { copyPipeline } from "./pipelineCopyRepo.js";
import { createPipeline, listStepsForPipeline, replacePipelineGraph } from "./pipelineStepsRepo.js";
import { currentVersion, ensureCurrentVersion, versionSnapshot } from "./pipelineVersionsRepo.js";
import { createProject } from "./projectsRepo.js";

/**
 * A copy names its own steps (EO-831): a step's brief that names another
 * step of the source names the copy's step for it, in the live rows and in
 * every version the copy carries.
 */
describe("copying a pipeline", () => {
  let handle: DbHandle;

  beforeEach(() => {
    handle = openMigratedTestDb();
  });

  afterEach(() => {
    handle.close();
  });

  it("moves a brief's step references onto the copy's step ids", () => {
    const from = createProject(handle.db, { name: "From", keyPrefix: "FRM" }).id;
    const onto = createProject(handle.db, { name: "Onto", keyPrefix: "ONT" }).id as Uuid;
    const source = createPipeline(handle.db, { projectId: from, name: "Review" });
    const brief = [{ show: "output" as const, step: "src_draft" }, { show: "comment" as const, kind: "approval" }];
    replacePipelineGraph(
      handle.db,
      source.id,
      [
        { id: "src_draft", pipelineId: source.id as Uuid, position: 0, name: "Draft", type: "user", isTerminal: false },
        { id: "src_check", pipelineId: source.id as Uuid, position: 1, name: "Check", type: "user", isTerminal: false, brief },
        { id: "src_done", pipelineId: source.id as Uuid, position: 2, name: "Done", type: "user", isTerminal: true },
      ],
      [
        { pipelineId: source.id as Uuid, fromStepId: "src_draft", resultKey: "done", label: "Done", tone: "success", target: "src_check", position: 0 },
        { pipelineId: source.id as Uuid, fromStepId: "src_check", resultKey: "approve", label: "Approve", tone: "success", target: "src_done", position: 0 },
      ],
      { entryStepId: "src_draft" },
    );
    ensureCurrentVersion(handle.db, source.id);

    const copy = copyPipeline(handle.db, source.id, onto);

    const draftCopy = copy.stepIds.get("src_draft")!;
    const expected = [{ show: "output", step: draftCopy }, { show: "comment", kind: "approval" }];
    expect(listStepsForPipeline(handle.db, copy.pipelineId).find((step) => step.name === "Check")?.brief).toEqual(expected);
    const version = currentVersion(handle.db, copy.pipelineId)!;
    expect(versionSnapshot(handle.db, version.id)?.steps.find((step) => step.name === "Check")?.brief).toEqual(expected);
    // The source is as it was.
    expect(listStepsForPipeline(handle.db, source.id).find((step) => step.name === "Check")?.brief).toEqual(brief);
  });
});
