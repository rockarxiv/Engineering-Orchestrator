import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, AgentProviderStartOptions, IpcPayload, Item, Uuid } from "@eo/core";
import { AttachmentStorage } from "../attachments/storage.js";
import type { DbHandle } from "../db/client.js";
import { issueDevice } from "../db/repos/devicesRepo.js";
import { createPerson } from "../db/repos/peopleRepo.js";
import {
  createPipeline,
  createProject,
  createStep,
  getItem,
  getUpdateConflict,
  listCommentsForItem,
  listMentionsForComment,
  listRunsForItem,
  openUpdateConflict,
} from "../db/repos/index.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { loadTemplateHistory } from "../gallery/history.js";
import { backfillPipelineOrigins } from "../gallery/origins.js";
import { applyTemplateUpdates } from "../gallery/templateUpdates.js";
import { openUpdateConflictAssist } from "../ipc/assistCommands.js";
import { clearPublishedView } from "../ipc/currentView.js";
import type { EngineHandle } from "../ipc/domainCommands.js";
import { findProjectThread } from "../projects/projectThread.js";
import { createFakeProvider } from "../providers/fake.js";
import { assistAgent, assistBoards, postAssistReply, shownAssistConversation } from "../roles/assist.js";
import { ASSIST_ACTION, ASSIST_STEP } from "../roles/conversationSteps.js";
import { createRunSupervisor } from "../supervisor/runSupervisor.js";
import { createDeviceRecord, type DeviceRecord } from "./deviceRecord.js";
import { createLocalRecord } from "./localRecord.js";
import { serveApply, serveChanges, serveRelease, serveRenew, serveSpend, serveUpdateConflictChat, serveWork, type ServeRecordContext } from "./serveRecord.js";
import type { RecordTransport } from "./syncStatus.js";

/**
 * Fix with assistant where the organisation's record holds the conflict
 * (EO-533, ARCHITECTURE.md, "Template versions and origins", "The
 * record").
 *
 * A pipeline the record holds is compared there, so the conflict is
 * there and only its notice reaches an admin's desktop. Pressing the
 * button on that desktop asks the record, which makes the chat once —
 * for every admin — and the desktop copies it with its brief and
 * dispatches the first turn.
 */

const GALLERY_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "resources", "gallery");
const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };

interface Desktop {
  handle: DbHandle;
  record: DeviceRecord;
  online: boolean;
}

let recordDb: DbHandle;
let serving: ServeRecordContext;
let anna: Desktop;
let laptop: Desktop;
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "eo update conflict chat record "));
  recordDb = openMigratedTestDb();
  serving = {
    db: recordDb.db,
    record: createLocalRecord(recordDb.db),
    attachments: new AttachmentStorage(join(root, "record-files")),
    offerWork: async () => [],
  };
  const annaPerson = createPerson(recordDb.db, { name: "Anna", email: "anna@example.com", isAdmin: true });
  const annaDevice = issueDevice(recordDb.db, { personId: annaPerson.id, name: "anna-desk", tokenHash: "h1", secretsKeyHash: null }).id;
  anna = desktop(openMigratedTestDb(), annaDevice);
  const benPerson = createPerson(recordDb.db, { name: "Ben", email: "ben@example.com", isAdmin: true });
  laptop = desktop(openMigratedTestDb(), issueDevice(recordDb.db, { personId: benPerson.id, name: "ben-laptop", tokenHash: "h2", secretsKeyHash: null }).id);
});

afterEach(() => {
  clearPublishedView();
  for (const machine of [anna, laptop]) {
    machine.record.stop();
    machine.handle.close();
  }
  recordDb.close();
  rmSync(root, { recursive: true, force: true });
});

function desktop(handle: DbHandle, deviceId = "device"): Desktop {
  const machine: Desktop = { handle, online: true, record: undefined as unknown as DeviceRecord };
  const transport: RecordTransport = {
    async request(channel, payload) {
      if (!machine.online) return { ok: false, error: { message: "EO could not reach https://eo.example: fetch failed" } };
      switch (channel) {
        case "record:updateConflictChat":
          return { ok: true, data: (await serveUpdateConflictChat(serving, payload as IpcPayload<"record:updateConflictChat">)) as never };
        case "record:changes":
          return { ok: true, data: serveChanges(serving, payload as IpcPayload<"record:changes">) as never };
        case "record:apply":
          return { ok: true, data: (await serveApply(serving, payload as IpcPayload<"record:apply">)) as never };
        case "record:work":
          return { ok: true, data: (await serveWork(serving, payload as IpcPayload<"record:work">)) as never };
        case "record:renew":
          return { ok: true, data: (await serveRenew(serving, payload as IpcPayload<"record:renew">)) as never };
        case "record:release":
          return { ok: true, data: (await serveRelease(serving, payload as IpcPayload<"record:release">)) as never };
        case "record:spend":
          return { ok: true, data: (await serveSpend(serving, payload as IpcPayload<"record:spend">)) as never };
        default:
          return { ok: false, error: { message: `EO has no channel called "${channel}".` } };
      }
    },
  };
  machine.record = createDeviceRecord({ db: handle.db, deviceId: () => deviceId, transport: () => transport, pullPageSize: 500 });
  return machine;
}

/**
 * EO's own Delivery on the record, customised before EO-461 and held by
 * a project the organisation owns: the record compares it, holds the 1.3
 * update and posts the notice — which both desktops then pull.
 */
async function heldOnTheRecord(): Promise<{ conflictId: string; projectId: Uuid }> {
  const db = recordDb.db;
  const merge = createPipeline(db, { projectId: null, name: "Merge" });
  createStep(db, { id: "merge_pr", pipelineId: merge.id as Uuid, position: 0, name: "Merge PR", type: "user" });
  createStep(db, { pipelineId: merge.id as Uuid, position: 1, name: "Merged", type: "user", isTerminal: true });
  db.run(sql`DELETE FROM step_routes WHERE from_step_id = 'pull_request_watch'`);
  db.run(sql`UPDATE pipeline_steps SET retired_version = 1 WHERE id = 'pull_request_watch'`);
  db.run(sql`UPDATE step_routes SET target = 'merge_pr' WHERE from_step_id = 'merge_request' AND result_key = 'opened'`);
  const history = loadTemplateHistory(GALLERY_DIRECTORY);
  backfillPipelineOrigins(db, history);
  const project = createProject(db, { name: "Support", keyPrefix: "SUP", managed: true });
  db.run(sql`UPDATE pipelines SET project_id = ${project.id} WHERE id = 'default'`);
  applyTemplateUpdates(db, history, { isTheRecord: true });
  const conflict = openUpdateConflict(db, "default")!;
  expect(conflict.noticeCommentIds).toHaveLength(1);
  await anna.record.sync();
  await laptop.record.sync();
  return { conflictId: conflict.id, projectId: project.id as Uuid };
}

/** The notice as a desktop's replica holds it. */
function noticeOn(machine: Desktop, projectId: Uuid) {
  const thread = findProjectThread(machine.handle.db, projectId);
  expect(thread).toBeDefined();
  const [notice] = listCommentsForItem(machine.handle.db, thread!.id as Uuid);
  expect(notice).toBeDefined();
  return notice!;
}

/**
 * A desktop's supervisor as production builds it: with its device record,
 * so its ticks sync with the record and claim through it, answering an
 * assist turn the way the developer pack does. Records what each turn it
 * started was given.
 */
function supervisorOf(machine: Desktop): { runOnce: () => Promise<void>; started: AgentProviderStartOptions[] } {
  const fake = createFakeProvider({ steps: [{ output: "Reading the conflict." }], result: { message: "Here are my drafts." } });
  const started: AgentProviderStartOptions[] = [];
  const supervisor = createRunSupervisor({
    db: machine.handle.db,
    record: machine.record,
    provider: { ...fake, start: (options) => (started.push(options), fake.start(options)) },
    limits: LIMITS,
    onRunSucceeded: (item: Item, agent: Agent, action: string, parsedResult: unknown, runId: Uuid): void => {
      if (action === ASSIST_ACTION) postAssistReply(machine.handle.db, item, agent.id, runId, parsedResult);
    },
  });
  return { runOnce: () => supervisor.runOnce(), started };
}

/** How many distinct runs of the assistant a chat has had, on any machine — a run copied to another is still one. */
function assistRunsOn(chatId: Uuid): number {
  const runs = new Set<string>();
  for (const machine of [anna, laptop]) for (const run of listRunsForItem(machine.handle.db, chatId)) if (run.action === ASSIST_ACTION) runs.add(run.id);
  return runs.size;
}

function engineStub(): EngineHandle & { notifyStateChange: ReturnType<typeof vi.fn> } {
  return { notifyStateChange: vi.fn() } as unknown as EngineHandle & { notifyStateChange: ReturnType<typeof vi.fn> };
}

describe("a conflict the organisation's record holds", () => {
  it("is opened from a replica's notice: the record makes the chat, the desktop copies it with its brief and dispatches the first turn", async () => {
    const { conflictId, projectId } = await heldOnTheRecord();
    const notice = noticeOn(anna, projectId);
    expect(notice.options).toEqual([{ kind: "open", label: "Fix with assistant", opens: { type: "updateConflictChat", conflictId } }]);
    // The replica holds the notice and not the conflict.
    expect(getUpdateConflict(anna.handle.db, conflictId)).toBeUndefined();
    const engine = engineStub();

    const opened = await openUpdateConflictAssist(anna.handle.db, engine, { conflictId, commentId: notice.id }, anna.record);

    expect(opened.problem).toBeNull();
    const chatId = opened.conversation!.id as Uuid;
    // Made on the record, recorded on its conflict, on the project that holds the pipeline.
    expect(getUpdateConflict(recordDb.db, conflictId)?.chatId).toBe(chatId);
    expect(getItem(recordDb.db, chatId)).toMatchObject({ stepId: ASSIST_STEP, projectId });
    // Copied here, shown, with the brief first and the pipeline as its subject.
    const chat = getItem(anna.handle.db, chatId)!;
    expect(chat.stepId).toBe(ASSIST_STEP);
    expect(shownAssistConversation(anna.handle.db)?.id).toBe(chatId);
    const [brief, ...rest] = listCommentsForItem(anna.handle.db, chatId);
    expect(rest).toEqual([]);
    expect(brief!.authorType).toBe("engine");
    expect(brief!.body).toContain("Pipeline: Delivery (id: default)");
    expect(brief!.body).toContain("from version 1.0 (the pipeline's base) to version 1.3");
    expect(listCommentsForItem(recordDb.db, chatId).map((comment) => comment.id)).toEqual([brief!.id]);
    expect(assistBoards(chat)).toEqual([{ from: brief!.id, pipelineId: "default" }]);
    // Asking this desktop's assistant, so this desktop's tick answers it.
    const assistant = assistAgent(anna.handle.db)!;
    expect(listMentionsForComment(anna.handle.db, brief!.id as Uuid)).toEqual([expect.objectContaining({ targetType: "agent", targetId: assistant.id, status: "open" })]);
    expect(engine.notifyStateChange).toHaveBeenCalledWith({ promptly: true });

    // The first turn, dispatched on the brief by this desktop's next
    // tick — its supervisor holding its device record — with the fake provider.
    const supervisor = supervisorOf(anna);
    await supervisor.runOnce();

    const runs = listRunsForItem(anna.handle.db, chatId);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ action: ASSIST_ACTION, agentId: assistant.id, initiationId: brief!.id, status: "succeeded" });
    expect(supervisor.started).toHaveLength(1);
    expect(supervisor.started[0]!.context).toContain("Pipeline: Delivery (id: default)");
  });

  it("is answered once across desktops: one that only synced the chat holds the brief asking nobody, and both supervisors together start one turn", async () => {
    const { conflictId, projectId } = await heldOnTheRecord();
    const opened = await openUpdateConflictAssist(anna.handle.db, engineStub(), { conflictId, commentId: noticeOn(anna, projectId).id }, anna.record);
    const chatId = opened.conversation!.id as Uuid;
    const [brief] = listCommentsForItem(anna.handle.db, chatId);
    // On the record the brief asks nobody: the turn was handed to Anna's desktop.
    expect(listMentionsForComment(recordDb.db, brief!.id as Uuid)).toEqual([]);
    expect(getUpdateConflict(recordDb.db, conflictId)?.chatTurnDeviceId).not.toBeNull();

    // The laptop never pressed: it has the chat and its brief from the pull alone.
    await laptop.record.sync();
    expect(getItem(laptop.handle.db, chatId)?.stepId).toBe(ASSIST_STEP);
    expect(listCommentsForItem(laptop.handle.db, chatId).map((comment) => comment.id)).toEqual([brief!.id]);
    expect(listMentionsForComment(laptop.handle.db, brief!.id as Uuid)).toEqual([]);

    const onAnna = supervisorOf(anna);
    const onLaptop = supervisorOf(laptop);
    await Promise.all([onAnna.runOnce(), onLaptop.runOnce()]);
    await Promise.all([anna.record.sync(), laptop.record.sync()]);
    await Promise.all([onAnna.runOnce(), onLaptop.runOnce()]);

    expect(onAnna.started).toHaveLength(1);
    expect(onLaptop.started).toHaveLength(0);
    expect(assistRunsOn(chatId)).toBe(1);
    // The desktop that answered had the pipeline pinned to the brief before it asked.
    expect(assistBoards(getItem(anna.handle.db, chatId)!)).toEqual([{ from: brief!.id, pipelineId: "default" }]);
  });

  it("hands the first turn to one desktop when two press at once, and to the same desktop again if it asks again", async () => {
    const { conflictId, projectId } = await heldOnTheRecord();

    const [fromAnna, fromLaptop] = await Promise.all([
      openUpdateConflictAssist(anna.handle.db, engineStub(), { conflictId, commentId: noticeOn(anna, projectId).id }, anna.record),
      openUpdateConflictAssist(laptop.handle.db, engineStub(), { conflictId, commentId: noticeOn(laptop, projectId).id }, laptop.record),
    ]);
    expect(fromLaptop.conversation!.id).toBe(fromAnna.conversation!.id);
    const chatId = fromAnna.conversation!.id as Uuid;
    const [brief] = listCommentsForItem(recordDb.db, chatId);

    // Exactly one desktop asks its assistant, and it has the pipeline pinned.
    const asking = [anna, laptop].filter((machine) => listMentionsForComment(machine.handle.db, brief!.id as Uuid).some((mention) => mention.targetType === "agent"));
    expect(asking).toHaveLength(1);
    expect(assistBoards(getItem(asking[0]!.handle.db, chatId)!)).toEqual([{ from: brief!.id, pipelineId: "default" }]);

    // The winner pressing again is not asked twice; nor is the other desktop handed the turn.
    const engine = engineStub();
    await openUpdateConflictAssist(asking[0]!.handle.db, engine, { conflictId, commentId: null }, asking[0]!.record);
    expect(engine.notifyStateChange).not.toHaveBeenCalled();
    expect(listMentionsForComment(asking[0]!.handle.db, brief!.id as Uuid)).toHaveLength(1);

    const onAnna = supervisorOf(anna);
    const onLaptop = supervisorOf(laptop);
    await Promise.all([onAnna.runOnce(), onLaptop.runOnce()]);
    expect(onAnna.started.length + onLaptop.started.length).toBe(1);
    expect(assistRunsOn(chatId)).toBe(1);
  });

  it("is one shared chat: another admin's desktop, and the same desktop again, are shown the chat the first press made", async () => {
    const { conflictId, projectId } = await heldOnTheRecord();
    const first = await openUpdateConflictAssist(anna.handle.db, engineStub(), { conflictId, commentId: noticeOn(anna, projectId).id }, anna.record);
    const chatId = first.conversation!.id;
    const engine = engineStub();

    const fromLaptop = await openUpdateConflictAssist(laptop.handle.db, engine, { conflictId, commentId: noticeOn(laptop, projectId).id }, laptop.record);
    const again = await openUpdateConflictAssist(anna.handle.db, engineStub(), { conflictId, commentId: null }, anna.record);

    expect(fromLaptop.problem).toBeNull();
    expect(fromLaptop.conversation!.id).toBe(chatId);
    expect(again.conversation!.id).toBe(chatId);
    expect(shownAssistConversation(laptop.handle.db)?.id).toBe(chatId);
    // The brief once, on the record and on the laptop's copy; nothing new dispatched.
    expect(listCommentsForItem(recordDb.db, chatId as Uuid)).toHaveLength(1);
    expect(listCommentsForItem(laptop.handle.db, chatId as Uuid)).toHaveLength(1);
    expect(engine.notifyStateChange).not.toHaveBeenCalled();
  });

  it("says so, making nothing, when the record cannot be reached", async () => {
    const { conflictId, projectId } = await heldOnTheRecord();
    anna.online = false;

    const opened = await openUpdateConflictAssist(anna.handle.db, engineStub(), { conflictId, commentId: noticeOn(anna, projectId).id }, anna.record);

    expect(opened.conversation).toBeNull();
    expect(opened.problem).toMatch(/held on your organisation's record, which could not be reached/);
    expect(getUpdateConflict(recordDb.db, conflictId)?.chatId).toBeNull();
  });
});
