import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TEMPLATE_UPDATE_RECENT_MS, uuidv7, type IpcPayload, type RecordAdoptCounts, type Uuid } from "@eo/core";
import { AttachmentStorage } from "../attachments/storage.js";
import type { DbHandle } from "../db/client.js";
import {
  createPipeline,
  currentVersion,
  getAppliedTemplateUpdate,
  getPipelineOrigin,
  listPipelineVersions,
  publishSection,
  listRoutesForPipeline,
  listStepsForPipeline,
  recordPipelineOrigin,
  replacePipelineGraph,
  setPipelineVersionsToKeep,
  setSetting,
} from "../db/repos/index.js";
import { issueDevice } from "../db/repos/devicesRepo.js";
import { createPerson } from "../db/repos/peopleRepo.js";
import { createProject, getProject } from "../db/repos/projectsRepo.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import type { TemplateHistory } from "../gallery/history.js";
import { templateHistoryUpTo } from "../gallery/historyTestHelpers.js";
import { describeTemplateStatus } from "../gallery/templateStatus.js";
import { applyTemplateUpdates } from "../gallery/templateUpdates.js";
import { MANAGED_PERSON_ID_KEY } from "../identity/viewer.js";
import { buildTickInput } from "../supervisor/buildTickInput.js";
import { moveProjectToRecord } from "./adopt.js";
import { createLocalRecord } from "./localRecord.js";
import { serveAdopt, serveApply, serveChanges, type ServeRecordContext } from "./serveRecord.js";
import { createDeviceRecord } from "./deviceRecord.js";
import type { RecordTransport } from "./syncStatus.js";
import { pipelineVersionsCommand } from "../ipc/pipelineCommands.js";

/**
 * A template pipeline's origin survives a move to the record (EO-532).
 *
 * The record compares the pipelines it holds with newer template
 * versions, and a desktop leaves those alone. So a pipeline made from a
 * template and moved there has to arrive with its origin: the base, and
 * the step map an import re-minted, which no step-id matching could
 * recover on the far side.
 */

const GALLERY_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "resources", "gallery");
const SOFTWARE = "software-feature-to-merge";
const LIMITS = { globalConcurrency: 1, perAgentConcurrency: 1, perRepositoryConcurrency: 1 };

let recordDb: DbHandle;
let deskDb: DbHandle;
let serving: ServeRecordContext;
let history: TemplateHistory;
let personId: Uuid;
let deviceId: string;
let files: string;

beforeEach(() => {
  recordDb = openMigratedTestDb();
  deskDb = openMigratedTestDb();
  history = templateHistoryUpTo(GALLERY_DIRECTORY, "software-feature-to-merge", "1.3");
  files = mkdtempSync(join(tmpdir(), "eo-template-origins-"));
  const theRecord = createLocalRecord(recordDb.db);
  serving = {
    db: recordDb.db,
    record: theRecord,
    attachments: new AttachmentStorage(join(files, "record")),
    offerWork: (device, capacity) => theRecord.offerWork({ deviceId: device, capacity, tickInput: buildTickInput(recordDb.db, LIMITS, false) }),
  };
  personId = createPerson(recordDb.db, { name: "Anna", email: "anna@example.com" }).id;
  deviceId = issueDevice(recordDb.db, { personId, name: "anna-desk", tokenHash: "h1", secretsKeyHash: null }).id;
  setSetting(deskDb.db, MANAGED_PERSON_ID_KEY, personId);
});

afterEach(() => {
  recordDb.close();
  deskDb.close();
  rmSync(files, { recursive: true, force: true });
});

/** *Software feature to merge* 1.0 imported into a project of its own, every step id re-minted, as `importPipeline` does. */
function importedPipeline(projectId: Uuid): { pipelineId: string; ids: Map<string, string> } {
  const v10 = history.get(SOFTWARE)!.find((version) => version.version === "1.0")!;
  const pipeline = createPipeline(deskDb.db, { projectId, name: "Imported delivery" });
  const ids = new Map(v10.document.steps.map((step) => [step.id, uuidv7() as string]));
  const local = (id: string): string => ids.get(id) ?? id;
  replacePipelineGraph(
    deskDb.db,
    pipeline.id,
    v10.document.steps.map((step) => ({ ...step, id: local(step.id), pipelineId: pipeline.id as Uuid, moduleVersion: null })),
    v10.document.routes.map((route) => ({ ...route, pipelineId: pipeline.id as Uuid, fromStepId: local(route.fromStepId), target: local(route.target) })),
    { entryStepId: local("worktree") },
  );
  recordPipelineOrigin(deskDb.db, { pipelineId: pipeline.id, document: v10.document, stepIds: Object.fromEntries(ids) });
  return { pipelineId: pipeline.id, ids };
}

async function move(projectId: Uuid): Promise<void> {
  const outcome = await moveProjectToRecord({
    db: deskDb.db,
    projectId,
    personId,
    personName: "Anna",
    files: new AttachmentStorage(join(files, "desk")),
    send: async (request) => {
      const served = (await serveAdopt(serving, {
        deviceId,
        project: request.project,
        keyNextValue: request.keyNextValue,
        final: request.final,
        abandon: request.abandon,
        page: request.page,
      } as IpcPayload<"record:adopt">)) as { accepted: RecordAdoptCounts; problem: string | null };
      if (served.problem !== null) return { ok: false, problem: served.problem };
      return { ok: true, accepted: served.accepted };
    },
  });
  if (!outcome.ok) throw new Error(`the move was refused: ${outcome.problem}`);
}

describe("moving a template pipeline to the record", () => {
  it("carries its origin, so the record compares it with a newer version and the desktop leaves it alone", async () => {
    const project = createProject(deskDb.db, { name: "Shop", keyPrefix: "SHOP" });
    const { pipelineId, ids } = importedPipeline(project.id as Uuid);
    createTestItem(deskDb.db, { type: "story", title: "In flight", stepId: ids.get("todo")!, projectId: project.id as Uuid });
    const sent = getPipelineOrigin(deskDb.db, pipelineId)!;

    await move(project.id as Uuid);

    // The record has the origin as it was sent: the version, the base
    // read from its own database, and the re-minted step map.
    const arrived = getPipelineOrigin(recordDb.db, pipelineId);
    expect(arrived).toMatchObject({ slug: SOFTWARE, version: "1.0", stepIds: sent.stepIds });
    expect(arrived?.base).toEqual(sent.base);
    expect(getProject(deskDb.db, project.id as Uuid)?.managedAt).not.toBeNull();

    // The desktop, now following the moved project, compares nothing.
    expect(applyTemplateUpdates(deskDb.db, history, { isTheRecord: false })).toEqual([]);
    expect(getPipelineOrigin(deskDb.db, pipelineId)?.version).toBe("1.0");

    // The record compares it, and applies the new version.
    const results = applyTemplateUpdates(recordDb.db, history, { isTheRecord: true });

    expect(results).toContainEqual(expect.objectContaining({ pipelineId, outcome: "applied", from: "1.0", to: "1.3" }));
    expect(currentVersion(recordDb.db, pipelineId)?.createdBy).toBe(`template:${SOFTWARE}@1.3`);
    const watch = listStepsForPipeline(recordDb.db, pipelineId).find((step) => step.entryAction === "watch_pull_request");
    expect(watch).toBeDefined();
    // Not the template's literal id: the record's own Delivery holds that one.
    expect(watch!.id).not.toBe("pull_request_watch");
    expect(getPipelineOrigin(recordDb.db, pipelineId)?.stepIds["pull_request_watch"]).toBe(watch!.id);
  });

  it("arrives with no origin where the pipeline had none", async () => {
    const project = createProject(deskDb.db, { name: "Shop", keyPrefix: "SHOP" });
    const { pipelineId, ids } = importedPipeline(project.id as Uuid);
    deskDb.db.run(sql`UPDATE pipelines SET template_slug = NULL, template_version = NULL, template_base_id = NULL, template_step_ids = NULL WHERE id = ${pipelineId}`);
    createTestItem(deskDb.db, { type: "story", title: "In flight", stepId: ids.get("todo")!, projectId: project.id as Uuid });

    await move(project.id as Uuid);

    expect(getPipelineOrigin(recordDb.db, pipelineId)).toBeNull();
  });
});

/**
 * "Updated to" on a pipeline's head survives the move (EO-536): the
 * record answers a moved pipeline's head, so the update the desktop
 * applied a day ago must arrive with the origin — even where the
 * version it filed was pruned on the desktop and travels with nothing.
 */
describe("moving a template pipeline updated lately", () => {
  const APPLIED_AT = 1_800_000_000_000;

  for (const pruned of [false, true]) {
    it(`keeps its applied update on the record within the three days${pruned ? ", the update's version pruned before the move" : ""}`, async () => {
      const project = createProject(deskDb.db, { name: "Shop", keyPrefix: "SHOP" });
      const { pipelineId, ids } = importedPipeline(project.id as Uuid);
      createTestItem(deskDb.db, { type: "story", title: "In flight", stepId: ids.get("todo")!, projectId: project.id as Uuid });

      expect(applyTemplateUpdates(deskDb.db, history, { isTheRecord: false, now: APPLIED_AT })).toContainEqual(expect.objectContaining({ pipelineId, outcome: "applied", to: "1.3" }));
      const filed = currentVersion(deskDb.db, pipelineId)!;
      expect(filed.createdBy).toBe(`template:${SOFTWARE}@1.3`);

      if (pruned) {
        // Only the newest kept, and an ordinary edit after the update: its version is gone.
        setPipelineVersionsToKeep(deskDb.db, 1);
        const steps = listStepsForPipeline(deskDb.db, pipelineId).map(({ ownerPersonId: _person, ownerGroupId: _group, ...step }) =>
          step.id === ids.get("todo") ? { ...step, name: "Next up" } : step,
        );
        const routes = listRoutesForPipeline(deskDb.db, pipelineId).map(({ id: _id, ...route }) => route);
        expect(replacePipelineGraph(deskDb.db, pipelineId, steps, routes, { createdBy: null })).toEqual(expect.objectContaining({ replaced: true }));
        expect(listPipelineVersions(deskDb.db, pipelineId).map((version) => version.createdBy)).not.toContain(`template:${SOFTWARE}@1.3`);
      }

      await move(project.id as Uuid);

      // The record answers the moved pipeline's head, and still says so.
      const status = describeTemplateStatus(recordDb.db, pipelineId, history, { onTheRecord: true, now: APPLIED_AT + 24 * 60 * 60 * 1000 });
      expect(status.origin).toEqual(expect.objectContaining({ slug: SOFTWARE, version: "1.3" }));
      expect(status.updated).toEqual({
        version: "1.3",
        pipelineVersion: filed.number,
        at: APPLIED_AT,
        notes: history.get(SOFTWARE)!.find((version) => version.version === "1.3")!.notes,
      });
      // And stops saying so when the three days are up, as it would have on the desktop.
      expect(describeTemplateStatus(recordDb.db, pipelineId, history, { onTheRecord: true, now: APPLIED_AT + TEMPLATE_UPDATE_RECENT_MS + 1 }).updated).toBeNull();
    });
  }

  it("arrives with no applied update where none was applied", async () => {
    const project = createProject(deskDb.db, { name: "Shop", keyPrefix: "SHOP" });
    const { pipelineId } = importedPipeline(project.id as Uuid);

    await move(project.id as Uuid);

    expect(getAppliedTemplateUpdate(recordDb.db, pipelineId)).toBeNull();
    expect(describeTemplateStatus(recordDb.db, pipelineId, history, { onTheRecord: true }).updated).toBeNull();
  });
});

/**
 * A template update the record applies reaches the desktops with its
 * release notes (EO-728): the version it filed carries them down, so the
 * pipeline's version list on a desktop holding the project shows them,
 * as the record's does, and nothing is posted anywhere.
 *
 * Where the organisation publishes its pipelines: only then does a
 * desktop take the record's graph and versions at all
 * (`upsertReplicaPipeline`); unpublished, it keeps its own and holds no
 * version the update filed.
 */
describe("a template update the record applies, on a desktop", () => {
  it("shows its release notes in the desktop's version list", async () => {
    const project = createProject(deskDb.db, { name: "Shop", keyPrefix: "SHOP" });
    const { pipelineId, ids } = importedPipeline(project.id as Uuid);
    createTestItem(deskDb.db, { type: "story", title: "In flight", stepId: ids.get("todo")!, projectId: project.id as Uuid });
    await move(project.id as Uuid);
    publishSection(recordDb.db, { section: "pipelines", subjectId: "default", publishedAt: Date.now() });

    expect(applyTemplateUpdates(recordDb.db, history, { isTheRecord: true })).toContainEqual(expect.objectContaining({ pipelineId, outcome: "applied", to: "1.3" }));
    const filed = currentVersion(recordDb.db, pipelineId)!;
    expect(filed.releaseNotes).toEqual(expect.any(String));
    expect(filed.releaseNotes).not.toBe("");

    const transport: RecordTransport = {
      async request(channel, payload) {
        const answer =
          channel === "record:changes"
            ? serveChanges(serving, payload as IpcPayload<"record:changes">)
            : channel === "record:apply"
              ? await serveApply(serving, payload as IpcPayload<"record:apply">)
              : null;
        return answer === null ? { ok: false, error: { message: `EO has no channel called "${channel}".` } } : { ok: true, data: answer as never };
      },
    };
    const desk = createDeviceRecord({ db: deskDb.db, deviceId: () => deviceId, transport: () => transport });
    try {
      await desk.sync();
    } finally {
      desk.stop();
    }

    const versions = pipelineVersionsCommand(deskDb.db, { pipelineId }).versions;
    expect(versions.find((version) => version.id === filed.id)).toMatchObject({ number: filed.number, createdBy: filed.createdBy, releaseNotes: filed.releaseNotes });
    // Said on the version.
  });
});
