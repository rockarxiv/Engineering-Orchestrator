import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../client.js";
import { openMigratedTestDb } from "../testHelpers.js";
import { loadTemplateHistory, templateHistoryDirectory, type TemplateVersion } from "../../gallery/history.js";
import { importPipeline, parseExport } from "../../modules/pipelineTransfer.js";
import { getPipelineOrigin, recordPipelineOrigin } from "./pipelineOriginsRepo.js";
import { createPipeline, listStepsForPipeline } from "./pipelineStepsRepo.js";

/**
 * A pipeline's origin and its stored base (EO-531).
 */

const GALLERY_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "resources", "gallery");
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let handle: DbHandle;
const scratch: string[] = [];

beforeEach(() => {
  handle = openMigratedTestDb();
});

afterEach(() => {
  handle.close();
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function version(slug: string, at: string, directory = GALLERY_DIRECTORY): TemplateVersion {
  const found = loadTemplateHistory(directory).get(slug)?.find((candidate) => candidate.version === at);
  if (found === undefined) throw new Error(`no ${slug} ${at} in the shipped history`);
  return found;
}

function snapshotRows(): { id: string; slug: string; version: string }[] {
  return handle.db.all<{ id: string; slug: string; version: string }>(sql`SELECT id, slug, version FROM template_versions`);
}

describe("recording an origin", () => {
  it("stores the slug, the version, the step map and a snapshot whose id is a UUIDv7", () => {
    const weekly = version("weekly-report", "1.0");
    const pipeline = createPipeline(handle.db, { name: "Weekly report" });
    recordPipelineOrigin(handle.db, { pipelineId: pipeline.id, document: weekly.document, stepIds: { gather: "a" } });

    const origin = getPipelineOrigin(handle.db, pipeline.id);
    expect(origin?.slug).toBe("weekly-report");
    expect(origin?.version).toBe("1.0");
    expect(origin?.stepIds).toEqual({ gather: "a" });
    expect(origin?.base).toEqual(weekly.document);
    expect(origin?.baseId).toMatch(UUID_V7);
  });

  it("stores one snapshot for every pipeline made from the same document", () => {
    const weekly = version("weekly-report", "1.0");
    for (const name of ["One", "Two"]) {
      const pipeline = createPipeline(handle.db, { name });
      recordPipelineOrigin(handle.db, { pipelineId: pipeline.id, document: weekly.document, stepIds: {} });
    }
    expect(snapshotRows()).toHaveLength(1);
  });

  it("stores a second snapshot for a different document under the same slug and version", () => {
    const weekly = version("weekly-report", "1.0");
    const republished = { ...weekly.document, pipeline: { ...weekly.document.pipeline, name: "Weekly report, again" } };
    for (const document of [weekly.document, republished]) {
      const pipeline = createPipeline(handle.db, { name: "Weekly" });
      recordPipelineOrigin(handle.db, { pipelineId: pipeline.id, document, stepIds: {} });
    }
    expect(snapshotRows()).toHaveLength(2);
  });

  it("is none on a pipeline nobody recorded one for", () => {
    expect(getPipelineOrigin(handle.db, createPipeline(handle.db, { name: "Drawn" }).id)).toBeNull();
  });
});

describe("the stored base", () => {
  it("is read from the database, and survives a release that drops the file it came from", () => {
    // A copy of the shipped history, standing in for an older release.
    const older = mkdtempSync(join(tmpdir(), "eo-older-release-"));
    scratch.push(older);
    cpSync(templateHistoryDirectory(GALLERY_DIRECTORY), templateHistoryDirectory(older), { recursive: true });
    const before = version("software-feature-to-merge", "1.0", older);
    const pipeline = createPipeline(handle.db, { name: "Delivery" });
    recordPipelineOrigin(handle.db, { pipelineId: pipeline.id, document: before.document, stepIds: {} });

    // The release that dropped it.
    rmSync(older, { recursive: true, force: true });

    expect(getPipelineOrigin(handle.db, pipeline.id)?.base).toEqual(before.document);
  });

  it("is what the database holds, not what the app ships", () => {
    const weekly = version("weekly-report", "1.0");
    const pipeline = createPipeline(handle.db, { name: "Weekly" });
    recordPipelineOrigin(handle.db, { pipelineId: pipeline.id, document: weekly.document, stepIds: {} });

    handle.db.run(sql`UPDATE template_versions SET document = json_set(document, '$.pipeline.name', 'As stored')`);

    expect(getPipelineOrigin(handle.db, pipeline.id)?.base.pipeline.name).toBe("As stored");
  });

  it("reads as no origin where the snapshot is gone, rather than as a guess", () => {
    const weekly = version("weekly-report", "1.0");
    const pipeline = createPipeline(handle.db, { name: "Weekly" });
    recordPipelineOrigin(handle.db, { pipelineId: pipeline.id, document: weekly.document, stepIds: {} });
    handle.db.run(sql`DELETE FROM template_versions`);

    expect(getPipelineOrigin(handle.db, pipeline.id)).toBeNull();
  });
});

describe("importing a document", () => {
  it("records the origin of one that carries a template block, with each template step mapped to its re-minted id", () => {
    const content = version("content-draft-and-approve", "1.0");
    const imported = importPipeline(handle.db, { document: content.document, projectId: null, signedInBackends: [] });
    if (!imported.ok) throw new Error(imported.reason);

    const origin = getPipelineOrigin(handle.db, imported.pipelineId);
    expect(origin?.slug).toBe("content-draft-and-approve");
    expect(origin?.version).toBe("1.0");
    expect(origin?.base).toEqual(content.document);

    const steps = listStepsForPipeline(handle.db, imported.pipelineId);
    expect(Object.keys(origin!.stepIds).sort()).toEqual(content.document.steps.map((step) => step.id).sort());
    for (const step of content.document.steps) {
      const local = steps.find((candidate) => candidate.id === origin!.stepIds[step.id]);
      expect(local?.name, step.id).toBe(step.name);
      expect(local?.id).toMatch(UUID_V7);
    }
  });

  it("records none for an ordinary export, which is not a template", () => {
    const content = version("content-draft-and-approve", "1.0");
    const parsed = parseExport(JSON.stringify({ ...content.document, template: null }));
    if (!parsed.ok) throw new Error(parsed.reason);
    const imported = importPipeline(handle.db, { document: parsed.document, projectId: null, signedInBackends: [] });
    if (!imported.ok) throw new Error(imported.reason);

    expect(getPipelineOrigin(handle.db, imported.pipelineId)).toBeNull();
    expect(snapshotRows()).toHaveLength(0);
  });
});
