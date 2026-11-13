import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RecordPipelineSchema, SectionDocumentSchema, type Item, type ModuleManifest, type Uuid } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import {
  createPipeline,
  createRun,
  createRunEventBuffer,
  createStep,
  getModuleVersion,
  listModuleVersions,
  listStepsForPipeline,
  publishSection,
  saveModule,
  setEntryStep,
} from "../db/repos/index.js";
import { listPipelinesUpdatedSince, upsertReplicaPipeline } from "../db/repos/projectMoveRepo.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { applySectionDocument, sectionDocument } from "../managed/configuration.js";
import { createModuleRunnerLookup } from "../modules/registry.js";
import { preparingAt } from "../supervisor/testWorkspaceKinds.js";

/**
 * A record-held pipeline's module pin, on a replica (EO-772).
 *
 * A step pins a module version *by number*, so the pin only means the
 * same thing on a desktop if the desktop's numbers are the record's. The
 * pipelines section carries the module's history whole for that reason,
 * and this runs the pinned step through a real module host on the
 * replica to show which code it gets: the record pins an approved v2
 * under an unapproved v3 head, and the replica runs v2.
 */

const hostPath = join(dirname(fileURLToPath(import.meta.url)), "..", "modules", "moduleHost.mjs");
const launcher = { execPath: process.execPath, hostPath, hostEnv: { ELECTRON_RUN_AS_NODE: "1" } };
const store = {
  isEncryptionAvailable: () => true,
  encryptString: (text: string) => Buffer.from(`enc:${text}`),
  decryptString: (buffer: Buffer) => buffer.toString().replace(/^enc:/, ""),
};

const manifest: ModuleManifest = {
  name: "Probe",
  description: "Says which version it is.",
  inputs: {},
  needs: { bin: [], env: [], network: false, item: false, comment: false, attach: false, create: false },
  results: ["ok"],
};
const says = (word: string) => `export default async function run() { return { ok: true, result: "ok", detail: "${word}" }; }`;

let recordDb: DbHandle;
let desktopDb: DbHandle;
let scratch: string;

beforeEach(() => {
  recordDb = openMigratedTestDb();
  desktopDb = openMigratedTestDb();
  scratch = mkdtempSync(join(tmpdir(), "eo module pin "));
});

afterEach(() => {
  recordDb.close();
  desktopDb.close();
  rmSync(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
});

/** On the record: "Probe" v1, v2 approved, v3 an unapproved edit; a pipeline whose step pins v2. */
function recordPinningV2UnderV3(): { moduleId: string; pipelineId: string } {
  const save = (code: string, approve: boolean, id?: string) => {
    const saved = saveModule(recordDb.db, { ...(id === undefined ? {} : { id }), slug: "probe", name: "Probe", description: "Says which version it is.", code, manifest, approve });
    if (!saved.ok) throw new Error(saved.reason);
    return saved.module.id;
  };
  const moduleId = save(says("v1"), true);
  save(says("v2"), true, moduleId);
  save(says("v3"), false, moduleId);

  const pipeline = createPipeline(recordDb.db, { name: "Probing" });
  createStep(recordDb.db, { id: "probe-step", pipelineId: pipeline.id, position: 0, name: "Probe", type: "module", entryAction: moduleId, moduleVersion: 2 });
  createStep(recordDb.db, { id: "done-step", pipelineId: pipeline.id, position: 1, name: "Done", type: "user", isTerminal: true });
  setEntryStep(recordDb.db, pipeline.id, "probe-step");
  return { moduleId, pipelineId: pipeline.id };
}

/** The pipelines section and the record's pipelines, over the wire and into the desktop, as the drain and the sync deliver them. */
function replicate(): void {
  const publishedAt = Date.now();
  publishSection(recordDb.db, { section: "pipelines", subjectId: "default", publishedAt });
  const document = SectionDocumentSchema.parse(JSON.parse(JSON.stringify(sectionDocument(recordDb.db, "pipelines"))));
  publishSection(desktopDb.db, { section: "pipelines", subjectId: "default", publishedAt, document });
  applySectionDocument(desktopDb.db, document);
  for (const pipeline of listPipelinesUpdatedSince(recordDb.db, { ts: 0, id: "" }, 100)) {
    upsertReplicaPipeline(desktopDb.db, RecordPipelineSchema.parse(JSON.parse(JSON.stringify(pipeline))));
  }
}

/** Runs the module step on the desktop, for an item standing on it. */
async function runOnDesktop(moduleId: string): Promise<unknown> {
  const on: Item = createTestItem(desktopDb.db, { type: "story", title: "Probe it", stepId: "probe-step" });
  const run = createRun(desktopDb.db, { itemId: on.id, agentId: null, action: moduleId, status: "running", provider: "module" });
  const buffer = createRunEventBuffer(desktopDb.db);
  const runner = createModuleRunnerLookup({ db: desktopDb.db, launcher, secrets: { directory: join(scratch, "secrets"), store } })(moduleId);
  if (runner === undefined) throw new Error("The desktop has no runner for the module.");
  return runner({
    db: desktopDb.db,
    item: on,
    prepareWorkspace: preparingAt(scratch),
    report: (text: string) => {
      buffer.append(run.id as Uuid, "output", { type: "output", text });
      buffer.flush();
    },
    runId: run.id as Uuid,
  });
}

describe("a record-held pipeline's module pin", () => {
  it("reaches a replica with the record's version numbers, and the replica runs the pinned version", async () => {
    const { moduleId, pipelineId } = recordPinningV2UnderV3();

    replicate();

    expect(listStepsForPipeline(desktopDb.db, pipelineId as Uuid).find((step) => step.id === "probe-step")?.moduleVersion).toBe(2);
    expect(listModuleVersions(desktopDb.db, moduleId).map((version) => [version.number, version.approved])).toEqual([
      [3, false],
      [2, true],
      [1, true],
    ]);
    expect(getModuleVersion(desktopDb.db, moduleId, 2)?.code).toBe(says("v2"));

    expect(await runOnDesktop(moduleId)).toEqual({ ok: true, result: "ok", detail: "v2" });
  });

  it("files nothing of the replica's own when the same publication applies again", () => {
    const { moduleId } = recordPinningV2UnderV3();

    replicate();
    replicate();

    expect(listModuleVersions(desktopDb.db, moduleId).map((version) => version.number)).toEqual([3, 2, 1]);
    expect(getModuleVersion(desktopDb.db, moduleId, 3)?.code).toBe(says("v3"));
  });
});
