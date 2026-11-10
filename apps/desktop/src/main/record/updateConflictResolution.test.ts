import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ADMIN_MCP_SERVER_NAME, type Agent, type AssistReply, type IpcChannel, type IpcPayload, type IpcResponse, type Item, type UpdateConflictDetail, type Uuid } from "@eo/core";
import { AttachmentStorage } from "../attachments/storage.js";
import type { DbHandle } from "../db/client.js";
import { issueDevice } from "../db/repos/devicesRepo.js";
import { createPerson } from "../db/repos/peopleRepo.js";
import {
  createPipeline,
  createProject,
  createStep,
  currentVersion,
  getItem,
  getMessage,
  getPipelineOrigin,
  getUpdateConflict,
  listCommentsForItem,
  listRoutesForPipeline,
  listStepsForPipeline,
  openUpdateConflict,
  publishSection,
  getPipeline,
  versionSnapshot,
} from "../db/repos/index.js";
import { pipelines } from "../db/schema.js";
import { messagesFrom, openMigratedTestDb } from "../db/testHelpers.js";
import { loadTemplateHistory } from "../gallery/history.js";
import { backfillPipelineOrigins } from "../gallery/origins.js";
import { applyTemplateUpdates } from "../gallery/templateUpdates.js";
import { openUpdateConflictAssist } from "../ipc/assistCommands.js";
import { clearPublishedView } from "../ipc/currentView.js";
import type { EngineHandle } from "../ipc/domainCommands.js";
import { clearHandlerRegistry, dispatchIpc } from "../ipc/registry.js";
import { TOOLS } from "../mcpHost/catalog.js";
import { findProjectThread } from "../projects/projectThread.js";
import { createFakeProvider } from "../providers/fake.js";
import { postAssistReply } from "../roles/assist.js";
import { ASSIST_ACTION } from "../roles/conversationSteps.js";
import { PROPOSAL_KIND } from "../roles/proposal.js";
import { createRunSupervisor } from "../supervisor/runSupervisor.js";
import { fakePlatform } from "../testing/platform.js";
import { createDeviceRecord, type DeviceRecord } from "./deviceRecord.js";
import { createLocalRecord } from "./localRecord.js";
import {
  RESOLVE_UPDATE_NOT_AN_ADMIN,
  serveApply,
  serveChangeDependencies,
  serveChanges,
  serveHandleMessage,
  serveMessages,
  serveSendMessage,
  serveRelease,
  serveRenew,
  serveResolveUpdateConflict,
  serveSpend,
  serveTemplateStatus,
  serveUpdateConflict,
  serveUpdateConflictChat,
  serveWork,
  type ServeRecordContext,
} from "./serveRecord.js";
import type { RecordTransport } from "./syncStatus.js";

/**
 * Resolving a template update the organisation's record holds (EO-534,
 * ARCHITECTURE.md, "Template versions and origins", "The record").
 *
 * A pipeline the record holds is compared there, so the update is held
 * there, and an admin's desktop holds only the notice and the chat. The
 * assistant on that desktop reads the update from the record; Publish on
 * one of its drafts saves the graph on the record and resolves the
 * update there; Keep my pipeline resolves it there with no graph change.
 * The record checks for itself that the asking device is an admin's, and
 * every replica follows the record's graph.
 */

const GALLERY_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "resources", "gallery");
const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };
const ADMIN = (tool: string) => `mcp__${ADMIN_MCP_SERVER_NAME}__${tool}`;

interface Desktop {
  handle: DbHandle;
  record: DeviceRecord;
  deviceId: string;
  /** False and the record cannot be reached, as a desktop finds it when the server is down. */
  online: boolean;
}

let recordDb: DbHandle;
let serving: ServeRecordContext;
let anna: Desktop;
let annaId: string;
let root: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "eo update conflict resolution record "));
  recordDb = openMigratedTestDb();
  serving = {
    db: recordDb.db,
    record: createLocalRecord(recordDb.db),
    attachments: new AttachmentStorage(join(root, "record-files")),
    offerWork: async () => [],
  };
  const annaPerson = createPerson(recordDb.db, { name: "Anna", email: "anna@example.com", isAdmin: true });
  annaId = annaPerson.id;
  anna = desktop(openMigratedTestDb(), issueDevice(recordDb.db, { personId: annaPerson.id, name: "anna-desk", tokenHash: "h1", secretsKeyHash: null }).id);
  // Anna's desktop answers its own channels, with its device record, as the app does.
  const { registerAllHandlers } = await import("../ipc/handlers.js");
  registerAllHandlers(anna.handle.db, undefined, { platform: fakePlatform(), record: anna.record });
});

afterEach(() => {
  clearHandlerRegistry();
  clearPublishedView();
  anna.record.stop();
  anna.handle.close();
  recordDb.close();
  rmSync(root, { recursive: true, force: true });
});

function desktop(handle: DbHandle, deviceId: string): Desktop {
  const machine = { online: true } as Desktop;
  const transport: RecordTransport = {
    async request(channel, payload) {
      if (!machine.online) return { ok: false, error: { message: "EO could not reach https://eo.example: fetch failed" } };
      switch (channel) {
        case "record:updateConflictChat":
          return { ok: true, data: (await serveUpdateConflictChat(serving, payload as IpcPayload<"record:updateConflictChat">)) as never };
        case "record:updateConflict":
          return { ok: true, data: (await serveUpdateConflict(serving, payload as IpcPayload<"record:updateConflict">)) as never };
        case "record:templateStatus":
          return { ok: true, data: (await serveTemplateStatus(serving, payload as IpcPayload<"record:templateStatus">)) as never };
        case "record:resolveUpdateConflict":
          // Stamped at the server's door with the device the credential is
          // for (`withDeviceIdentity`), whatever the payload said.
          return { ok: true, data: (await serveResolveUpdateConflict(serving, { ...(payload as IpcPayload<"record:resolveUpdateConflict">), deviceId })) as never };
        case "record:changeDependencies":
          return { ok: true, data: (await serveChangeDependencies(serving, { ...(payload as IpcPayload<"record:changeDependencies">), deviceId })) as never };
        case "record:changes":
          return { ok: true, data: serveChanges(serving, payload as IpcPayload<"record:changes">) as never };
        case "record:sendMessage":
          return { ok: true, data: serveSendMessage(serving, { ...(payload as IpcPayload<"record:sendMessage">), deviceId }) as never };
        case "record:handleMessage":
          return { ok: true, data: serveHandleMessage(serving, { ...(payload as IpcPayload<"record:handleMessage">), deviceId }) as never };
        case "record:messages":
          return { ok: true, data: serveMessages(serving, { ...(payload as IpcPayload<"record:messages">), deviceId }) as never };
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
  const record = createDeviceRecord({ db: handle.db, deviceId: () => deviceId, transport: () => transport, pullPageSize: 500 });
  return Object.assign(machine, { handle, record, deviceId });
}

async function call<K extends IpcChannel>(channel: K, payload: unknown): Promise<IpcResponse<K>> {
  const answer = await dispatchIpc(channel, payload);
  if (!answer.ok) throw new Error(`${channel} refused: ${answer.error.message}`);
  return answer.data as IpcResponse<K>;
}

/**
 * EO's own Delivery on the record, customised before EO-461 to hand
 * opened pull requests to the project's Merge pipeline, in a project the
 * organisation holds, with the pipelines section published — so every
 * desktop's copy is the record's. The record holds the 1.3 update and
 * sends the notice to its admin, which Anna's desktop pulls.
 */
async function heldOnTheRecord(): Promise<{ conflictId: string; projectId: Uuid }> {
  const db = recordDb.db;
  const project = createProject(db, { name: "Support", keyPrefix: "SUP", managed: true });
  const merge = createPipeline(db, { projectId: project.id, name: "Merge" });
  createStep(db, { id: "merge_pr", pipelineId: merge.id as Uuid, position: 0, name: "Merge PR", type: "user" });
  createStep(db, { pipelineId: merge.id as Uuid, position: 1, name: "Merged", type: "user", isTerminal: true });
  db.run(sql`DELETE FROM step_routes WHERE from_step_id = 'pull_request_watch'`);
  db.run(sql`UPDATE pipeline_steps SET retired_version = 1 WHERE id = 'pull_request_watch'`);
  db.run(sql`UPDATE step_routes SET target = 'merge_pr' WHERE from_step_id = 'merge_request' AND result_key = 'opened'`);
  const history = loadTemplateHistory(GALLERY_DIRECTORY);
  backfillPipelineOrigins(db, history);
  db.run(sql`UPDATE pipelines SET project_id = ${project.id} WHERE id = 'default'`);
  for (const pipelineId of ["default", merge.id]) publishSection(db, { section: "pipelines", subjectId: pipelineId, publishedAt: Date.now() });
  applyTemplateUpdates(db, history, { isTheRecord: true });
  const conflict = openUpdateConflict(db, "default")!;
  await anna.record.sync();
  return { conflictId: conflict.id, projectId: project.id as Uuid };
}

/** The notice on Anna's desktop: the record's message to her, pulled, and no project thread. */
function annaNotice(projectId: Uuid) {
  expect(findProjectThread(anna.handle.db, projectId)).toBeUndefined();
  const [notice, ...more] = messagesFrom(anna.handle.db, "template_conflict").filter((message) => message.projectId === projectId);
  expect(notice).toBeDefined();
  expect(more).toEqual([]);
  return notice!;
}

/** Fix with assistant on Anna's desktop: the record's chat, copied here with its brief. */
async function openChat(conflictId: string, projectId: Uuid): Promise<Item> {
  const notice = annaNotice(projectId);
  const opened = await openUpdateConflictAssist(anna.handle.db, { notifyStateChange: vi.fn() } as unknown as EngineHandle, { conflictId, commentId: notice.id }, anna.record);
  expect(opened.problem).toBeNull();
  return getItem(anna.handle.db, opened.conversation!.id as Uuid)!;
}

/** The tool, as the system agent on Anna's desktop calls it. */
async function readConflict(): Promise<{ text: string; refused: boolean; data: IpcResponse<"pipeline:updateConflict"> }> {
  const outcome = await TOOLS.find((tool) => tool.name === "pipeline_update_conflict")!.run(dispatchIpc, { pipelineId: "default" });
  if (!outcome.ok) throw new Error(outcome.message);
  return { text: outcome.text, refused: outcome.refused, data: outcome.data as IpcResponse<"pipeline:updateConflict"> };
}

type DraftOf = NonNullable<AssistReply["draft"]>;
type ConflictGraph = UpdateConflictDetail["current"];

const draftStep = (step: ConflictGraph["steps"][number], position: number, settings: Record<string, unknown> = {}) => {
  const { id, name, type, ownerRole, entryAction, instructionsSummary, isTerminal, planMode } = step;
  return { id, position, name, type, ownerRole, entryAction, instructionsSummary, isTerminal, planMode, ...settings };
};
const draftRoute = ({ fromStepId, resultKey, label, tone, target }: ConflictGraph["routes"][number], position: number) => ({ fromStepId, resultKey, label, tone, target, position });

/** The recommendation, from what the record's tool answer said: the template's watch in front of the person's Merge PR. */
function recommendedDraft(conflict: UpdateConflictDetail): DraftOf {
  const steps = [...conflict.current.steps].sort((a, b) => a.position - b.position);
  const watch = conflict.template.steps.find((step) => step.id === "pull_request_watch")!;
  const at = steps.findIndex((step) => step.id === "merge_request") + 1;
  return {
    rationale: "Keeps your squash merge (Merge PR) and adds the template's Watching pull request in front of it.",
    entryStepId: conflict.current.entryStepId!,
    steps: [...steps.slice(0, at), watch, ...steps.slice(at)].map((step, index) =>
      step.id === watch.id ? draftStep(step, index, { watch: watch.watch, inputs: { reportReady: true, readyWhen: "mergeable" } }) : draftStep(step, index),
    ),
    routes: [
      ...conflict.current.routes.map((route) => (route.fromStepId === "merge_request" && route.resultKey === "opened" ? { ...route, target: watch.id } : route)),
      ...conflict.template.routes.filter((route) => route.fromStepId === watch.id).map((route) => (route.resultKey === "ready" ? { ...route, target: "merge_pr" } : route)),
    ].map(draftRoute),
    target: { pipelineId: conflict.pipelineId },
  } as DraftOf;
}

/** The assistant's turn on Anna's desktop, with the fake provider: it reads the update and the pipeline, then answers. */
async function scriptedTurn(reply: AssistReply, toolAnswer: string): Promise<void> {
  const pipelineGet = await TOOLS.find((tool) => tool.name === "pipeline_get")!.run(dispatchIpc, { pipelineId: "default" });
  const fake = createFakeProvider({
    steps: [
      { toolCall: { name: ADMIN("pipeline_update_conflict"), args: { pipelineId: "default" }, answer: toolAnswer } },
      { toolCall: { name: ADMIN("pipeline_get"), args: { pipelineId: "default" }, answer: pipelineGet.ok ? pipelineGet.text : "" } },
    ],
    result: reply,
  });
  const supervisor = createRunSupervisor({
    db: anna.handle.db,
    record: anna.record,
    provider: fake,
    limits: LIMITS,
    onRunSucceeded: (item: Item, agent: Agent, action: string, parsedResult: unknown, runId: Uuid): void => {
      if (action === ASSIST_ACTION) postAssistReply(anna.handle.db, item, agent.id, runId, parsedResult);
    },
  });
  await supervisor.runOnce();
}

/** The cards the chat's newest turn posted on Anna's desktop, and the reasons for any it could not. */
function postedCards(chat: Item): { cards: Uuid[]; rejections: string[] } {
  const said = listCommentsForItem(anna.handle.db, chat.id).filter((comment) => comment.authorType === "agent");
  const ofRun = said.filter((comment) => comment.runId === said.at(-1)?.runId);
  return { cards: ofRun.filter((comment) => comment.kind === PROPOSAL_KIND).map((comment) => comment.id), rejections: ofRun.filter((comment) => comment.kind === "rejection").map((comment) => comment.body) };
}

const routeOf = (db: DbHandle, from: string, key: string) => listRoutesForPipeline(db.db, "default").find((route) => route.fromStepId === from && route.resultKey === key)?.target;

describe("a template update the organisation's record holds", () => {
  it("is read by the assistant on an admin's desktop from the record, which holds the update and its three graphs", async () => {
    const { conflictId, projectId } = await heldOnTheRecord();
    // The desktop holds the notice, not the update.
    expect(getUpdateConflict(anna.handle.db, conflictId)).toBeUndefined();
    const chat = await openChat(conflictId, projectId);

    const { data, refused } = await readConflict();

    expect(refused).toBe(false);
    expect(data.conflict).toMatchObject({ conflictId, pipelineId: "default", fromVersion: "1.0", toVersion: "1.3", chatId: chat.id });
    expect(data.conflict!.changes[0]).toMatchObject({ changedBy: "conflict", current: { target: "merge_pr" }, template: { target: "pull_request_watch" } });
  });

  it("is published on the record from the chat: the record saves the draft, resolves the update, moves its base and closes its notice, and the desktop follows", async () => {
    const { conflictId, projectId } = await heldOnTheRecord();
    const chat = await openChat(conflictId, projectId);
    const { data, text } = await readConflict();
    await scriptedTurn(
      { message: "Two ways, and keeping yours.", draft: recommendedDraft(data.conflict!), card: { kind: "pipelineKeepMine", pipelineId: "default" } },
      text,
    );
    const { cards, rejections } = postedCards(chat);
    expect(rejections).toEqual([]);
    expect(cards).toHaveLength(2);

    // The card says Publish is the record's, and passes the validator there as it would anywhere.
    const read = await call("assist:draft", { conversationId: chat.id, messageId: cards[0]! });
    expect(read).toMatchObject({ problem: null, updateConflictId: conflictId, updateConflictOnRecord: true });
    const published = await call("assist:publishOnRecord", { conversationId: chat.id, messageId: cards[0]! });

    expect(published).toEqual({ saved: true, resolved: true, problem: null });
    // On the record: the graph is the draft's, filed under Anna, the update resolved and the base moved.
    expect(routeOf(recordDb, "merge_request", "opened")).toBe("pull_request_watch");
    expect(routeOf(recordDb, "pull_request_watch", "ready")).toBe("merge_pr");
    expect(currentVersion(recordDb.db, "default")?.createdBy).toBe(annaId);
    const conflict = getUpdateConflict(recordDb.db, conflictId)!;
    expect(conflict).toMatchObject({ resolution: "published" });
    expect(getPipelineOrigin(recordDb.db, "default")).toMatchObject({ version: "1.3", baseId: conflict.templateId });
    expect(getMessage(recordDb.db, conflict.noticeIds[0]!)?.handledHow).toBe("resolved");
    // Never raised again on the record.
    expect(applyTemplateUpdates(recordDb.db, loadTemplateHistory(GALLERY_DIRECTORY), { isTheRecord: true })).toEqual([]);

    // Anna's copy follows the record's graph, and her notice closes, on the next pull.
    await anna.record.sync();
    expect(routeOf(anna.handle, "merge_request", "opened")).toBe("pull_request_watch");
    expect(getMessage(anna.handle.db, conflict.noticeIds[0]!)?.handledHow).toBe("resolved");
  });

  it("publishes a draft's entry rules on the record, and they reach the desktop (EO-610)", async () => {
    const rules = [{ kind: "description" }];
    const { conflictId, projectId } = await heldOnTheRecord();
    const chat = await openChat(conflictId, projectId);
    const { data, text } = await readConflict();
    await scriptedTurn({ message: "With a rule at the door.", draft: { ...recommendedDraft(data.conflict!), entryRules: rules } }, text);
    const { cards, rejections } = postedCards(chat);
    expect(rejections).toEqual([]);

    const published = await call("assist:publishOnRecord", { conversationId: chat.id, messageId: cards[0]! });

    expect(published).toEqual({ saved: true, resolved: true, problem: null });
    expect(getPipeline(recordDb.db, "default")?.entryRules).toEqual(rules);
    expect(versionSnapshot(recordDb.db, currentVersion(recordDb.db, "default")!.id)?.entryRules).toEqual(rules);
    await anna.record.sync();
    expect(getPipeline(anna.handle.db, "default")?.entryRules).toEqual(rules);
  });

  it("leaves the record's entry rules where they are when the draft says nothing of them (EO-610)", async () => {
    const rules = [{ kind: "workspace" }];
    const { conflictId, projectId } = await heldOnTheRecord();
    recordDb.db.update(pipelines).set({ entryRules: rules }).where(eq(pipelines.id, "default")).run();
    const chat = await openChat(conflictId, projectId);
    const { data, text } = await readConflict();
    await scriptedTurn({ message: "Nothing about rules.", draft: recommendedDraft(data.conflict!) }, text);

    const published = await call("assist:publishOnRecord", { conversationId: chat.id, messageId: postedCards(chat).cards[0]! });

    expect(published).toEqual({ saved: true, resolved: true, problem: null });
    expect(getPipeline(recordDb.db, "default")?.entryRules).toEqual(rules);
  });

  it("is kept on the record from Keep my pipeline: resolved, its base moved, the graph untouched", async () => {
    const { conflictId, projectId } = await heldOnTheRecord();
    const chat = await openChat(conflictId, projectId);
    const { data, text } = await readConflict();
    await scriptedTurn({ message: "Or keep yours.", draft: recommendedDraft(data.conflict!), card: { kind: "pipelineKeepMine", pipelineId: "default" } }, text);
    const keep = postedCards(chat).cards[1]!;
    const before = { record: listRoutesForPipeline(recordDb.db, "default").map(({ id: _id, ...route }) => route), version: currentVersion(recordDb.db, "default")?.number };

    const shown = await call("assist:card", { conversationId: chat.id, messageId: keep });
    expect(shown.card).toMatchObject({ kind: "pipelineKeepMine", held: { fromVersion: "1.0", toVersion: "1.3" } });
    const pressed = await call("assist:applyCard", { conversationId: chat.id, messageId: keep });

    expect(pressed.applied).toBe(true);
    expect(getUpdateConflict(recordDb.db, conflictId)?.resolution).toBe("kept");
    expect(getPipelineOrigin(recordDb.db, "default")?.version).toBe("1.3");
    expect(listRoutesForPipeline(recordDb.db, "default").map(({ id: _id, ...route }) => route)).toEqual(before.record);
    expect(currentVersion(recordDb.db, "default")?.number).toBe(before.version);
  });

  it("is resolved only for one of the record's admins, and a published draft only from the chat about it", async () => {
    const { conflictId, projectId } = await heldOnTheRecord();
    const chat = await openChat(conflictId, projectId);
    const ben = createPerson(recordDb.db, { name: "Ben", email: "ben@example.com", isAdmin: false });
    const bensDevice = issueDevice(recordDb.db, { personId: ben.id, name: "ben-laptop", tokenHash: "h2", secretsKeyHash: null }).id;
    const graph = { steps: listStepsForPipeline(recordDb.db, "default").filter((step) => !step.offBoard), routes: listRoutesForPipeline(recordDb.db, "default"), entryStepId: "worktree" };

    const notAnAdmin = await serveResolveUpdateConflict(serving, { deviceId: bensDevice, pipelineId: "default", resolution: "kept", chatId: null, graph: null, templateStepIds: {} });
    expect(notAnAdmin).toMatchObject({ resolved: false, problem: RESOLVE_UPDATE_NOT_AN_ADMIN });

    const elsewhere = await serveResolveUpdateConflict(serving, { deviceId: anna.deviceId, pipelineId: "default", resolution: "published", chatId: "another-chat", graph, templateStepIds: {} });
    expect(elsewhere).toMatchObject({ resolved: false, version: null });
    expect(elsewhere.problem).toContain("not raised in the chat about this template update");

    expect(getUpdateConflict(recordDb.db, conflictId)?.resolvedAt).toBeNull();
    expect(getUpdateConflict(recordDb.db, conflictId)?.chatId).toBe(chat.id);
  });
});

describe("a pipeline's head, for a pipeline the organisation's record holds (EO-536)", () => {
  it("says what the record holds: its origin and its held update, which opens the chat since its notice is a message on no item", async () => {
    const { conflictId, projectId } = await heldOnTheRecord();
    annaNotice(projectId);

    const status = await call("pipeline:templateStatus", { pipelineId: "default" });

    expect(status.origin).toEqual(expect.objectContaining({ slug: "software-feature-to-merge", version: "1.0" }));
    expect(status.waiting).toEqual(expect.objectContaining({ conflictId, toVersion: "1.3", conflicts: 1, chatId: null, notice: null }));
    expect(status.problem).toBeNull();

    // Once Fix with assistant has opened the chat, the head goes to it.
    const chat = await openChat(conflictId, projectId);
    expect((await call("pipeline:templateStatus", { pipelineId: "default" })).waiting?.chatId).toBe(chat.id);
  });

  it("says nothing, rather than the origin this desktop kept from before, while the record cannot be reached", async () => {
    await heldOnTheRecord();
    anna.online = false;

    const status = await call("pipeline:templateStatus", { pipelineId: "default" });

    expect(status).toEqual(expect.objectContaining({ origin: null, updated: null, waiting: null }));
    expect(status.problem).toContain("could not be reached");
  });
});

describe("when the record cannot say", () => {
  it("refuses Publish on the conflict chat's draft rather than publishing it into this desktop's copy, while the record is out of reach", async () => {
    const { conflictId, projectId } = await heldOnTheRecord();
    const chat = await openChat(conflictId, projectId);
    const { data, text } = await readConflict();
    await scriptedTurn({ message: "A draft.", draft: recommendedDraft(data.conflict!) }, text);
    const draft = postedCards(chat).cards[0]!;
    const before = listRoutesForPipeline(anna.handle.db, "default").map(({ id: _id, ...route }) => route);

    anna.online = false;

    // The tool says it could not ask, and is not read as "nothing is held".
    const read = await readConflict();
    expect(read.refused).toBe(true);
    expect(read.data).toMatchObject({ conflict: null, authoritative: false });
    expect(read.data.problem).toContain("could not be reached");
    // The card offers nothing to publish, and says why.
    const card = await call("assist:draft", { conversationId: chat.id, messageId: draft });
    expect(card).toMatchObject({ pipelineId: null, steps: [], updateConflictId: null, updateConflictOnRecord: false });
    expect(card.problem).toContain("EO could not ask the record whether it resolves a held template update, so nothing was published");
    expect(card.problem).toContain("could not be reached");
    // And Publish on the record says the same, writing nothing anywhere.
    const published = await call("assist:publishOnRecord", { conversationId: chat.id, messageId: draft });
    expect(published).toMatchObject({ saved: false, resolved: false });
    expect(published.problem).toContain("could not be reached, so nothing was resolved");
    expect(listRoutesForPipeline(anna.handle.db, "default").map(({ id: _id, ...route }) => route)).toEqual(before);
    expect(getUpdateConflict(recordDb.db, conflictId)?.resolvedAt).toBeNull();

    // Back in reach, the same card publishes on the record.
    anna.online = true;
    expect(await call("assist:draft", { conversationId: chat.id, messageId: draft })).toMatchObject({ problem: null, updateConflictOnRecord: true });
  });
});

describe("a desktop conflict from before the record held the pipeline", () => {
  /** Anna's own Delivery, customised and compared here, with its 1.3 update held on this desktop — before any organisation. */
  function heldHere(): string {
    const db = anna.handle.db;
    db.run(sql`DELETE FROM step_routes WHERE from_step_id = 'pull_request_watch'`);
    db.run(sql`UPDATE pipeline_steps SET retired_version = 1 WHERE id = 'pull_request_watch'`);
    db.run(sql`UPDATE step_routes SET target = 'user_attention' WHERE from_step_id = 'merge_request' AND result_key = 'opened'`);
    const history = loadTemplateHistory(GALLERY_DIRECTORY);
    backfillPipelineOrigins(db, history);
    applyTemplateUpdates(db, history, { isTheRecord: false });
    return openUpdateConflict(db, "default")!.id;
  }

  it("is closed as obsolete once the pull says the record holds the pipeline, and never shadows the record's update", async () => {
    const obsolete = heldHere();

    const { conflictId } = await heldOnTheRecord();

    expect(getUpdateConflict(anna.handle.db, obsolete)).toMatchObject({ resolution: "held by the record" });
    expect(openUpdateConflict(anna.handle.db, "default")).toBeUndefined();
    expect((await readConflict()).data.conflict?.conflictId).toBe(conflictId);
  });

  it("is passed over by Read, Keep and Publish even while it is still open here: each follows the record, which holds the pipeline now", async () => {
    const { conflictId, projectId } = await heldOnTheRecord();
    // An open hold here the pull never closed — written straight, as one
    // from a build before this one would have been left.
    const stale = heldHereAfterTheFact();
    expect(openUpdateConflict(anna.handle.db, "default")?.id).toBe(stale);
    const chat = await openChat(conflictId, projectId);

    // Read: the record's update.
    const { data, text } = await readConflict();
    expect(data.conflict?.conflictId).toBe(conflictId);
    await scriptedTurn({ message: "Two ways.", draft: recommendedDraft(data.conflict!), card: { kind: "pipelineKeepMine", pipelineId: "default" } }, text);
    const [draft, keep] = postedCards(chat).cards;

    // Publish: recognised as resolving the record's update, and resolved there.
    expect(await call("assist:draft", { conversationId: chat.id, messageId: draft! })).toMatchObject({ problem: null, updateConflictId: conflictId, updateConflictOnRecord: true });
    // Keep, pressed first: the record's update kept, nothing of the stale hold touched.
    expect((await call("assist:applyCard", { conversationId: chat.id, messageId: keep! })).applied).toBe(true);
    expect(getUpdateConflict(recordDb.db, conflictId)?.resolution).toBe("kept");
    expect(getUpdateConflict(anna.handle.db, stale)?.resolvedAt).toBeNull();
  });

  /** A hold written on Anna's desktop for the record-held pipeline, as a desktop that predates closing obsolete holds left one. */
  function heldHereAfterTheFact(): string {
    const record = getUpdateConflict(recordDb.db, openUpdateConflict(recordDb.db, "default")!.id)!;
    const id = "stale-desktop-hold";
    anna.handle.db.run(sql`
      INSERT INTO pipeline_update_conflicts (id, pipeline_id, template_slug, from_version, to_version, base_id, template_id, notes, conflicts, problems, notice_comment_ids, created_at)
      SELECT ${id}, 'default', template_slug, from_version, to_version, base_id, template_id, notes, conflicts, problems, '[]', 1
      FROM (SELECT ${record.templateSlug} AS template_slug, ${record.fromVersion} AS from_version, ${record.toVersion} AS to_version, ${record.baseId} AS base_id, ${record.templateId} AS template_id, ${record.notes} AS notes, '[]' AS conflicts, '[]' AS problems)
    `);
    return id;
  }
});
