import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Uuid } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import { createPipeline, getPipeline, listPipelines, setSetting } from "../db/repos/index.js";
import { createProject } from "../db/repos/projectsRepo.js";
import { giveSeededDelivery, openMigratedTestDb } from "../db/testHelpers.js";
import { PREVIEW_PROJECT_KEY } from "../gallery/commands.js";
import { listPipelineViews } from "./domainQueries.js";
import { createPipelineCommand } from "./pipelineCommands.js";
import { PIPELINE_NEEDS_PROJECT, projectBoardPipelineId } from "./pipelineHome.js";
import { createProjectCommand } from "./projectCommands.js";
import { ACTIVE_PROJECT_KEY } from "./repositoryCommands.js";

/**
 * Every pipeline has a project (EO-766): `pipelines:create` gives it the
 * one named or the one the window is on, and refuses with nothing
 * written where there is none; and `/project` opens the active project's
 * first pipeline rather than `default`.
 */

let handle: DbHandle;

beforeEach(() => {
  handle = openMigratedTestDb();
});

afterEach(() => {
  handle.close();
});

describe("pipelines:create", () => {
  it("puts the pipeline on the project named", () => {
    const named = createProject(handle.db, { name: "Named", keyPrefix: "NAM" });
    createProject(handle.db, { name: "Other", keyPrefix: "OTH" });

    const created = createPipelineCommand(handle.db, { projectId: named.id, name: "Intake" });

    expect(created.problem).toBeNull();
    expect(getPipeline(handle.db, created.pipeline!.id)?.projectId).toBe(named.id);
  });

  it("puts it on the project the window is on when none is named", () => {
    createProject(handle.db, { name: "First", keyPrefix: "FIR" });
    const shown = createProject(handle.db, { name: "Shown", keyPrefix: "SHO" });
    setSetting(handle.db, ACTIVE_PROJECT_KEY, shown.id);

    const created = createPipelineCommand(handle.db, { projectId: null, name: "Intake" });

    expect(created.pipeline?.projectId).toBe(shown.id);
  });

  it("refuses, saying a project is needed and writing nothing, when there is no project", () => {
    const before = listPipelines(handle.db, undefined, true).length;

    expect(createPipelineCommand(handle.db, { projectId: null, name: "Intake" })).toEqual({ pipeline: null, problem: PIPELINE_NEEDS_PROJECT });
    expect(listPipelines(handle.db, undefined, true)).toHaveLength(before);
  });

  it("does not count the gallery's Preview as a project to put one on", () => {
    const preview = createProject(handle.db, { name: "Preview", keyPrefix: "PRE" });
    setSetting(handle.db, PREVIEW_PROJECT_KEY, preview.id);
    const before = listPipelines(handle.db, undefined, true).length;

    expect(createPipelineCommand(handle.db, { projectId: null, name: "Intake" }).problem).toBe(PIPELINE_NEEDS_PROJECT);
    expect(listPipelines(handle.db, undefined, true)).toHaveLength(before);
  });
});

describe("Settings → Add project", () => {
  it("makes a project with no pipelines, and archives the seeded Delivery on a fresh installation", async () => {
    const made = await createProjectCommand(handle.db, { name: "Mine", keyPrefix: "MIN", repositoryIds: [] });
    const projectId = made.project!.id as Uuid;

    // What its rail lists: nothing of its own, and not the seeded Delivery.
    expect(listPipelineViews(handle.db, { projectId }).pipelines).toEqual([]);
    expect(getPipeline(handle.db, "default")?.archivedAt).not.toBeNull();

    const second = await createProjectCommand(handle.db, { name: "Another", keyPrefix: "ANO", repositoryIds: [] });
    expect(listPipelineViews(handle.db, { projectId: second.project!.id }).pipelines).toEqual([]);
  });
});

describe("the pipeline /project opens", () => {
  it("is the active project's first, not default", () => {
    const first = createProject(handle.db, { name: "First", keyPrefix: "FIR" });
    giveSeededDelivery(handle.db, first.id);
    const second = createProject(handle.db, { name: "Second", keyPrefix: "SEC" });
    const own = createPipeline(handle.db, { projectId: second.id, name: "Own" });
    setSetting(handle.db, ACTIVE_PROJECT_KEY, second.id);

    expect(projectBoardPipelineId(handle.db)).toBe(own.id);

    setSetting(handle.db, ACTIVE_PROJECT_KEY, first.id);
    expect(projectBoardPipelineId(handle.db)).toBe("default");
  });

  it("is none for a project with no pipeline", () => {
    const empty = createProject(handle.db, { name: "Empty", keyPrefix: "EMP" });
    setSetting(handle.db, ACTIVE_PROJECT_KEY, empty.id);

    expect(projectBoardPipelineId(handle.db)).toBeNull();
  });
});
