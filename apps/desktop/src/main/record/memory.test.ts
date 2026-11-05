import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FOLDER_KIND,
  MEMORY_NOTE_TOOL_NAME,
  type AgentEvent,
  type AgentProvider,
  type IpcChannel,
  type IpcPayload,
  type IpcResponse,
  type IpcResult,
  type Item,
  type MemoryScope,
  type RecordAdoptCounts,
  type Uuid,
} from "@eo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../db/client.js";
import { createTestItem, openMigratedTestDb, openMigratedTestDbAt } from "../db/testHelpers.js";
import {
  activeMemoriesIn,
  addMemory,
  applyConsolidation,
  addWorkspaceToProject,
  createProject,
  createRun,
  createWorkspace,
  editedPredecessors,
  getMemory,
  getMemorySearchEntry,
  getRun,
  getProject,
  listCommentsForItem,
  listConsolidations,
  listMemories,
  listRunsForItem,
  postComment,
  retireMemory,
  setItemHeld,
  startConsolidation,
  updateRun,
} from "../db/repos/index.js";
import { createPerson } from "../db/repos/peopleRepo.js";
import { grantLease } from "../db/repos/leasesRepo.js";
import { issueDevice } from "../db/repos/devicesRepo.js";
import { setSetting } from "../db/repos/settingsRepo.js";
import { projectMovedToTheRecord } from "../db/repos/projectsRepo.js";
// @ts-expect-error — the service is plain JavaScript, deliberately: it ships
// unbundled because Codex spawns it by path.
import * as eoServer from "../mcp/eoServer.mjs";
import { eoMcpStdioConfig } from "../mcp/serviceConfig.js";
import { validImplementResult } from "../providers/fixtures.js";
import { toolResultEvent } from "../providers/toolResult.js";
import { buildTickInput } from "../supervisor/buildTickInput.js";
import { createRunSupervisor, type RunSupervisor } from "../supervisor/runSupervisor.js";
import {
  addMemoryCommand,
  editMemoryCommand,
  getMemoryCommand,
  listConsolidationsCommand,
  restoreConsolidationCommand,
  restoreMemoryCommand,
  retireMemoryCommand,
  searchMemoryCommand,
} from "../ipc/memoryCommands.js";
import { clearHandlerRegistry, registerHandler } from "../ipc/registry.js";
import { answerToolCall } from "../mcpHost/server.js";
import { createMemoryConsolidator } from "../memory/consolidator.js";
import { startAgentWriteBridge, type AgentWriteBridge, type AgentWriteHandler } from "../mcp/writeBridge.js";
import { readProjectMemories } from "../db/repos/memoriesRepo.js";
import { asRunCommand, runCommandId } from "./runCommand.js";
import { createLocalRecord, type LocalItemRecord } from "./localRecord.js";
import { createDeviceRecord, type DeviceRecord } from "./deviceRecord.js";
import { moveProjectToRecord } from "./adopt.js";
import {
  serveAdopt,
  serveApply,
  serveChanges,
  serveMemory,
  serveMemoryConsolidations,
  serveRelease,
  serveRestoreMemoryConsolidation,
  serveRenew,
  serveWork,
  type ServeRecordContext,
} from "./serveRecord.js";
import type { RecordTransport } from "./syncStatus.js";

/**
 * Memory where an organisation's server holds the project (EO-482,
 * ARCHITECTURE.md, "What an agent is given", "The record").
 *
 * A project's memory is the record's like the rest of the project: every
 * desktop is given the same entries, so a write is asked of the record
 * rather than made on a replica, and a replica takes what the record has
 * on each pull. Three databases in one process, with the record contract
 * between them through the same `serve*` functions the server puts behind
 * its door, and a supervisor on the desktop that runs the agent — whose
 * `memory_note` is answered by the real `eo` service.
 */

interface EoService {
  tools: { name: string }[];
  handle(request: unknown): Promise<{ result: { isError?: boolean; content: { type: string; text?: string }[] } }>;
  close(): void;
}
const service = eoServer as {
  createEoMcpService(options: Record<string, unknown>): EoService;
  parseMemoryScopes(raw: unknown): unknown[];
};
const serverPath = join(dirname(fileURLToPath(import.meta.url)), "..", "mcp", "eoServer.mjs");

const LIMITS = { globalConcurrency: 1, perAgentConcurrency: 1, perRepositoryConcurrency: 1 };
const UNREACHABLE = "EO could not reach https://eo.example: fetch failed";

interface Desktop {
  handle: DbHandle;
  /** Where the `eo` service reads from, where the test gave it a file. */
  path: string | undefined;
  record: DeviceRecord;
  deviceId: string;
  online: boolean;
}

let root: string;
let recordDb: DbHandle;
let theRecord: LocalItemRecord;
let serving: ServeRecordContext;
let annaPersonId: Uuid;
let anna: Desktop;
let laptop: Desktop;
let bridge: AgentWriteBridge;
/** What the bridge hands a note to: the supervisor of the test's desktop, once there is one. */
let writeBridged: AgentWriteHandler;
/** How many pages of consolidations the record has been asked for, and which one it fails, if any. */
let consolidationPagesAsked = 0;
let failConsolidationPage: number | null = null;

function transportFor(machine: Desktop): RecordTransport {
  return {
    async request<K extends IpcChannel>(channel: K, payload: IpcPayload<K>): Promise<IpcResult<IpcResponse<K>>> {
      if (!machine.online) return { ok: false, error: { message: UNREACHABLE } };
      const answer = await (async (): Promise<unknown> => {
        switch (channel) {
          case "record:work":
            return serveWork(serving, payload as IpcPayload<"record:work">);
          case "record:renew":
            return serveRenew(serving, payload as IpcPayload<"record:renew">);
          case "record:release":
            return serveRelease(serving, payload as IpcPayload<"record:release">);
          case "record:apply":
            return serveApply(serving, payload as IpcPayload<"record:apply">);
          case "record:changes":
            return serveChanges(serving, payload as IpcPayload<"record:changes">);
          case "record:memory":
            // The door stamps the device from its token; the test's
            // transport is that door.
            return serveMemory(serving, { ...(payload as IpcPayload<"record:memory">), deviceId: machine.deviceId });
          case "record:memoryConsolidations":
            consolidationPagesAsked += 1;
            if (failConsolidationPage === consolidationPagesAsked) return null;
            return serveMemoryConsolidations(serving, payload as IpcPayload<"record:memoryConsolidations">);
          case "record:restoreMemoryConsolidation":
            return serveRestoreMemoryConsolidation(serving, { ...(payload as IpcPayload<"record:restoreMemoryConsolidation">), deviceId: machine.deviceId });
          default:
            return null;
        }
      })();
      return answer === null ? { ok: false, error: { message: `EO has no channel called "${channel}".` } } : { ok: true, data: answer as IpcResponse<K> };
    },
  };
}

function desktop(handle: DbHandle, deviceId: string, path?: string): Desktop {
  const machine: Desktop = { handle, path, deviceId, online: true, record: undefined as unknown as DeviceRecord };
  machine.record = createDeviceRecord({ db: handle.db, deviceId: () => deviceId, transport: () => transportFor(machine), pullPageSize: 500 });
  // Signed in, as far as anything reading this database can tell.
  setSetting(handle.db, "managed.serverAddress", "https://eo.example");
  return machine;
}

beforeEach(async () => {
  consolidationPagesAsked = 0;
  failConsolidationPage = null;
  writeBridged = async () => ({ ok: false, code: "NO_RUN", problem: "No supervisor is listening." });
  bridge = await startAgentWriteBridge((itemId, request) => writeBridged(itemId, request));
  root = mkdtempSync(join(tmpdir(), "eo memory record "));
  recordDb = openMigratedTestDb();
  theRecord = createLocalRecord(recordDb.db);
  serving = {
    db: recordDb.db,
    record: theRecord,
    // The record's own scheduler, from its own tables.
    offerWork: (deviceId, capacity) => theRecord.offerWork({ deviceId, capacity, tickInput: buildTickInput(recordDb.db, LIMITS, false, {}) }),
  };
  annaPersonId = createPerson(recordDb.db, { name: "Anna", email: "anna@example.com" }).id;
  const annaDevice = issueDevice(recordDb.db, { personId: annaPersonId, name: "anna-desk", tokenHash: "h1", secretsKeyHash: null }).id;
  const laptopDevice = issueDevice(recordDb.db, { personId: annaPersonId, name: "anna-laptop", tokenHash: "h2", secretsKeyHash: null }).id;
  const annaPath = join(root, "anna.db");
  anna = desktop(openMigratedTestDbAt(annaPath), annaDevice, annaPath);
  laptop = desktop(openMigratedTestDb(), laptopDevice);
});

afterEach(async () => {
  await bridge.close();
  for (const machine of [anna, laptop]) {
    machine.record.stop();
    machine.handle.close();
  }
  recordDb.close();
  rmSync(root, { recursive: true, force: true });
});

/** A project on the record with one story waiting for the implementer, pulled down to both desktops. */
async function organisationWork(): Promise<{ projectId: Uuid; item: Item }> {
  const project = createProject(recordDb.db, { name: "Support", keyPrefix: "SUP", managed: true });
  const item = createTestItem(recordDb.db, { type: "story", title: "Add CSV export", stepId: "todo", projectId: project.id });
  await anna.record.sync();
  await laptop.record.sync();
  if (getProject(anna.handle.db, project.id) === undefined) throw new Error("the project did not reach the desktop");
  return { projectId: project.id, item };
}

/**
 * An implementer that writes one memory note, answered by the real `eo`
 * service started with the environment the turn would give it — reading
 * this desktop's own database, as it does in a real run.
 */
function notingAgent(machine: Desktop, note: unknown, options: { beforeNote?: () => void } = {}) {
  const seen = { scopes: [] as unknown[], bridged: false, answers: [] as { ok: boolean; text: string }[], resumed: false };
  // A fresh turn and a turn on a parked run's thread note the same way.
  async function* turn(opts: { memoryScopes?: unknown; writeBridge?: { url: string; token: string } } | undefined): AsyncIterable<AgentEvent> {
      const env = eoMcpStdioConfig({
        serverPath,
        ...(opts?.memoryScopes ? { memoryScopes: opts.memoryScopes as never } : {}),
        enableMemoryNote: true,
        ...(opts?.writeBridge ? { writeBridge: opts.writeBridge } : {}),
      }).env;
      seen.scopes = service.parseMemoryScopes(env["EO_MCP_MEMORY_SCOPES"]);
      seen.bridged = env["EO_MCP_WRITE_BRIDGE"] !== undefined;
      const eo = service.createEoMcpService({
        dbPath: machine.path,
        memoryScopes: seen.scopes,
        enableMemoryNote: env["EO_MCP_MEMORY_NOTE_ENABLED"] === "1",
        writeBridge: env["EO_MCP_WRITE_BRIDGE"] === undefined ? null : JSON.parse(env["EO_MCP_WRITE_BRIDGE"]),
      });
      try {
        yield { type: "thread_started", threadId: "thread-1" };
        options.beforeNote?.();
        yield { type: "tool_call", name: MEMORY_NOTE_TOOL_NAME, args: note, callId: "call-0" };
        const { result } = await eo.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: MEMORY_NOTE_TOOL_NAME, arguments: note } });
        const text = result.content[0]?.text ?? "";
        seen.answers.push({ ok: result.isError !== true, text });
        yield toolResultEvent({ name: MEMORY_NOTE_TOOL_NAME, callId: "call-0", ok: result.isError !== true, output: text });
        yield { type: "result", data: validImplementResult };
      } finally {
        eo.close();
      }
  }
  const provider: AgentProvider = {
    start: (opts) => turn(opts),
    resume: (_threadId, _message, opts) => {
      seen.resumed = true;
      return turn(opts);
    },
  };
  return { provider, seen };
}

/**
 * The desktop's supervisor, with the agent write bridge production gives
 * it — or, with `bridge: false`, without one, which is a turn started
 * before the bridge was listening.
 */
function supervisorOn(machine: Desktop, provider: AgentProvider, options: { bridge?: boolean } = {}): RunSupervisor {
  const supervisor = createRunSupervisor({
    db: machine.handle.db,
    provider,
    limits: LIMITS,
    record: machine.record,
    deviceId: machine.deviceId,
    guards: { interpretReplies: false },
    ...(options.bridge === false ? {} : { agentWriteBridge: () => bridge }),
  });
  writeBridged = (itemId, request) => supervisor.handleAgentWrite(itemId, request);
  return supervisor;
}

const projectScope = (projectId: string): MemoryScope => ({ kind: "project", id: projectId });
/** The implementer every database is seeded with, by the same id. */
const IMPLEMENTER = "019fb8c6-de91-7cdd-b0c6-3250561e04fb" as Uuid;

describe("memory_note on a project the organisation holds", () => {
  it("is written on the record, sourced to the desktop's run, and reaches the other desktop on its next pull", async () => {
    const { projectId, item } = await organisationWork();
    const { provider, seen } = notingAgent(anna, { scope: "project", text: "Run pnpm install before the tests; the lockfile is checked." });

    await supervisorOn(anna, provider).runOnce();

    // The turn was told its scope and where to hand what it writes (EO-543).
    expect(seen.scopes).toEqual([expect.objectContaining({ kind: "project", id: projectId })]);
    expect(seen.bridged).toBe(true);
    // The tool's answer is the record's: it saved the note — once.
    expect(seen.answers).toEqual([{ ok: true, text: expect.stringMatching(/^EO noted this in the memory of .*, which your organisation's record keeps/) }]);
    const run = listRunsForItem(anna.handle.db, item.id)[0]!;
    // On the record, with the run that wrote it.
    const onRecord = listMemories(recordDb.db, projectScope(projectId));
    expect(onRecord).toEqual([
      expect.objectContaining({
        body: "Run pnpm install before the tests; the lockfile is checked.",
        source: { type: "run", runId: run.id, itemId: item.id },
      }),
    ]);
    // The desktop that asked holds the record's row, by its id.
    expect(listMemories(anna.handle.db, projectScope(projectId)).map((entry) => entry.id)).toEqual([onRecord[0]!.id]);

    // The other desktop has none until it pulls, and then the same one.
    expect(listMemories(laptop.handle.db, projectScope(projectId))).toEqual([]);
    await laptop.record.sync();
    expect(listMemories(laptop.handle.db, projectScope(projectId))).toEqual([
      expect.objectContaining({ id: onRecord[0]!.id, body: onRecord[0]!.body, source: { type: "run", runId: run.id, itemId: item.id } }),
    ]);
  });

  it("is saved for a reply to a parked run, written before any sync has carried that run to the record, and reaches the other desktop", async () => {
    const { projectId, item } = await organisationWork();
    // A run that asked a question and was parked, and the person's answer.
    // Neither the parked run nor the reply that resumes it holds a lease.
    const parked = createRun(anna.handle.db, {
      itemId: item.id as Uuid,
      agentId: IMPLEMENTER,
      action: "implement",
      status: "queued",
      threadId: "thread-1",
      provider: "fake",
    });
    updateRun(anna.handle.db, parked.id, { status: "awaiting_input", endedAt: Date.now() });
    postComment(anna.handle.db, { itemId: item.id as Uuid, author: { type: "human" }, body: "Yes, go ahead." });
    const { provider, seen } = notingAgent(anna, { scope: "project", text: "Customers on the old plan are billed in arrears." });
    expect(listRunsForItem(recordDb.db, item.id)).toEqual([]);

    await supervisorOn(anna, provider).resumeItem(item.id as Uuid);

    expect(seen.answers).toEqual([{ ok: true, text: expect.stringMatching(/^EO noted this in the memory of .*, which your organisation's record keeps/) }]);
    const reply = listRunsForItem(anna.handle.db, item.id).find((run) => run.id !== parked.id)!;
    expect(reply).toBeDefined();
    expect(seen.resumed).toBe(true);
    const onRecord = listMemories(recordDb.db, projectScope(projectId));
    expect(onRecord).toEqual([expect.objectContaining({ body: "Customers on the old plan are billed in arrears.", source: { type: "run", runId: reply.id, itemId: item.id } })]);
    // The run went to the record ahead of the note, with this device's lines.
    expect(getRun(recordDb.db, reply.id)).toBeDefined();
    expect(listMemories(anna.handle.db, projectScope(projectId)).map((entry) => entry.id)).toEqual([onRecord[0]!.id]);
    await laptop.record.sync();
    expect(listMemories(laptop.handle.db, projectScope(projectId)).map((entry) => entry.id)).toEqual([onRecord[0]!.id]);
  });

  it("answers that the note was not saved when the record cannot be reached — from the write itself — and writes nothing anywhere", async () => {
    const { projectId, item } = await organisationWork();
    // The record goes away once the run has been handed out. Nothing has
    // marked this desktop offline: the answer is the write's, not a guess.
    const { provider, seen } = notingAgent(anna, { scope: "project", text: "The fixtures live in ./fixtures." }, { beforeNote: () => void (anna.online = false) });

    await supervisorOn(anna, provider).runOnce();

    expect(seen.answers).toEqual([{ ok: false, text: expect.stringContaining("The note was not saved.") }]);
    expect(seen.answers[0]!.text).toContain("could not be reached");
    expect(listMemories(anna.handle.db, projectScope(projectId), { includeRetired: true })).toEqual([]);
    expect(listMemories(recordDb.db, projectScope(projectId), { includeRetired: true })).toEqual([]);
    // The agent heard it from the tool; there is nothing for EO to add.
    expect(listCommentsForItem(anna.handle.db, item.id).filter((comment) => comment.body.includes("memory note"))).toEqual([]);
  });

  it("without the bridge, answers that nothing was written — nothing could say it was — and writes nothing", async () => {
    const { projectId, item } = await organisationWork();
    const { provider, seen } = notingAgent(anna, { scope: "project", text: "The fixtures live in ./fixtures." });

    await supervisorOn(anna, provider, { bridge: false }).runOnce();

    expect(seen.answers).toEqual([{ ok: false, text: expect.stringContaining("nothing was written") }]);
    expect(listMemories(anna.handle.db, projectScope(projectId), { includeRetired: true })).toEqual([]);
    expect(listMemories(recordDb.db, projectScope(projectId), { includeRetired: true })).toEqual([]);
    expect(listCommentsForItem(anna.handle.db, item.id).filter((comment) => comment.body.includes("memory note"))).toEqual([]);
  });
});

describe("a note that replaces entries on a project the organisation holds (EO-594)", () => {
  /** An entry on the record, pulled down to both desktops: an agent's from a run on an item since deleted, or a person's. */
  async function onTheRecord(projectId: string, body: string, by: "agent" | "person") {
    const written = addMemory(recordDb.db, {
      scope: projectScope(projectId),
      body,
      source: by === "agent" ? { type: "run", runId: null, itemId: null } : { type: "person", personId: annaPersonId },
      now: 1_000,
    });
    if (!written.ok) throw new Error(written.problem);
    await anna.record.sync();
    await laptop.record.sync();
    if (getMemory(anna.handle.db, written.entry.id) === undefined) throw new Error("the entry did not reach the desktop");
    return written.entry;
  }

  it("retires what it replaces on the record, in the same write, and both desktops hold the record's rows", async () => {
    const { projectId } = await organisationWork();
    const wrong = await onTheRecord(projectId, "Known gap: the export skips refunds.", "agent");
    const { provider, seen } = notingAgent(anna, { scope: "project", text: "The export includes refunds.", replaces: [wrong.id] });

    await supervisorOn(anna, provider).runOnce();

    expect(seen.answers).toEqual([{ ok: true, text: expect.stringContaining("which your organisation's record keeps") }]);
    const [note] = listMemories(recordDb.db, projectScope(projectId));
    expect(note?.body).toBe("The export includes refunds.");
    expect(getMemory(recordDb.db, wrong.id)).toMatchObject({ retiredReason: "superseded" });
    expect(getMemorySearchEntry(recordDb.db, note!.id)?.supersededIds).toEqual([wrong.id]);
    // The desktop that asked holds both changed rows at once; the other on its next pull.
    expect(getMemory(anna.handle.db, wrong.id)).toMatchObject({ retiredReason: "superseded" });
    expect(getMemorySearchEntry(anna.handle.db, note!.id)?.supersededIds).toEqual([wrong.id]);
    await laptop.record.sync();
    expect(getMemory(laptop.handle.db, wrong.id)).toMatchObject({ retiredReason: "superseded" });
    expect(getMemorySearchEntry(laptop.handle.db, note!.id)?.supersededIds).toEqual([wrong.id]);
  });

  it("is refused for a person's entry, and nothing is written or retired anywhere", async () => {
    const { projectId } = await organisationWork();
    const persons = await onTheRecord(projectId, "Dates are local time.", "person");
    const { provider, seen } = notingAgent(anna, { scope: "project", text: "Dates are UTC.", replaces: [persons.id] });

    await supervisorOn(anna, provider).runOnce();

    expect(seen.answers).toEqual([{ ok: false, text: expect.stringContaining("a note never replaces a person's entry") }]);
    for (const db of [recordDb.db, anna.handle.db]) {
      expect(listMemories(db, projectScope(projectId), { includeRetired: true }).map((entry) => [entry.id, entry.retiredAt])).toEqual([[persons.id, null]]);
    }
  });

  it("is refused by the record itself for an entry of another project, whatever the device says", async () => {
    const { projectId, item } = await organisationWork();
    const other = createProject(recordDb.db, { name: "Elsewhere", keyPrefix: "ELS", managed: true });
    const theirs = addMemory(recordDb.db, { scope: projectScope(other.id), body: "Another project's fact.", source: { type: "run", runId: null, itemId: null } });
    if (!theirs.ok) throw new Error(theirs.problem);
    // Anna's desktop holds the item's lease and runs it: the record takes its note, and holds what it names to the item's project.
    grantLease(recordDb.db, { itemId: item.id as Uuid, deviceId: anna.deviceId, now: Date.now(), ttlMs: 60_000 });
    const run = createRun(anna.handle.db, { itemId: item.id as Uuid, agentId: null, action: "implement" });
    const held = getRun(anna.handle.db, run.id)!;
    const answer = await serveMemory(serving, {
      deviceId: anna.deviceId,
      write: { op: "note", itemId: item.id, scope: projectScope(projectId), body: "A correction.", extracted: false, replaces: [theirs.entry.id] },
      run: asRunCommand(held, runCommandId(run.id, held.status), 0),
    });

    expect(answer.result).toEqual({ ok: false, problem: expect.stringContaining("not in a scope this run works in") });
    expect(listMemories(recordDb.db, projectScope(projectId), { includeRetired: true })).toEqual([]);
    expect(getMemory(recordDb.db, theirs.entry.id)?.retiredAt).toBeNull();
  });
});

describe("a container's memory on a project the organisation holds (EO-596)", () => {
  /** A container on the record with one story filed under it and one that is not, pulled down to both desktops. */
  async function containerWork(): Promise<{ projectId: Uuid; container: Item; under: Item; other: Item }> {
    const project = createProject(recordDb.db, { name: "Support", keyPrefix: "SUP", managed: true });
    const container = createTestItem(recordDb.db, { type: "feature", title: "Rate limiting", stepId: null, projectId: project.id });
    const under = createTestItem(recordDb.db, { type: "story", title: "Limit the API", stepId: "todo", projectId: project.id, parentId: container.id });
    const other = createTestItem(recordDb.db, { type: "story", title: "Add CSV export", stepId: "todo", projectId: project.id });
    await anna.record.sync();
    await laptop.record.sync();
    if (getProject(anna.handle.db, project.id) === undefined) throw new Error("the project did not reach the desktop");
    return { projectId: project.id, container, under, other };
  }

  it("is given to a run under the container, written on the record when it notes there, and reaches the other desktop on its pull", async () => {
    const { projectId, container, under, other } = await containerWork();
    // Only the story under the container is dispatchable this tick.
    setItemHeld(recordDb.db, other.id as Uuid, Date.now());
    const { provider, seen } = notingAgent(anna, { scope: container.id, text: "The limiter's buckets are keyed by the account while this work is in progress." });

    await supervisorOn(anna, provider).runOnce();

    const containerScope: MemoryScope = { kind: "container", id: container.id };
    expect(seen.scopes).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "project", id: projectId }), expect.objectContaining({ kind: "container", id: container.id })]));
    expect(seen.answers).toEqual([{ ok: true, text: expect.stringMatching(/^EO noted this in the memory of /) }]);
    const onRecord = listMemories(recordDb.db, containerScope);
    expect(onRecord).toEqual([expect.objectContaining({ body: "The limiter's buckets are keyed by the account while this work is in progress.", source: expect.objectContaining({ itemId: under.id }) })]);
    expect(readProjectMemories(recordDb.db, projectId).map((entry) => entry.id)).toContain(onRecord[0]!.id);
    expect(listMemories(anna.handle.db, containerScope).map((entry) => entry.id)).toEqual([onRecord[0]!.id]);
    expect(listMemories(laptop.handle.db, containerScope)).toEqual([]);
    await laptop.record.sync();
    expect(listMemories(laptop.handle.db, containerScope)).toEqual([expect.objectContaining({ id: onRecord[0]!.id, scope: containerScope })]);
  });

  it("is refused by the record for a run on an item not filed under the container", async () => {
    const { container, other } = await containerWork();
    grantLease(recordDb.db, { itemId: other.id as Uuid, deviceId: anna.deviceId, now: Date.now(), ttlMs: 60_000 });
    const run = createRun(anna.handle.db, { itemId: other.id as Uuid, agentId: null, action: "implement" });
    const held = getRun(anna.handle.db, run.id)!;

    const answer = await serveMemory(serving, {
      deviceId: anna.deviceId,
      write: { op: "note", itemId: other.id, scope: { kind: "container", id: container.id }, body: "Not this run's to write.", extracted: false, replaces: [] },
      run: asRunCommand(held, runCommandId(run.id, held.status), 0),
    });

    expect(answer.result).toEqual({ ok: false, problem: expect.stringContaining("is not a scope this run works in") });
    expect(listMemories(recordDb.db, { kind: "container", id: container.id }, { includeRetired: true })).toEqual([]);
  });
});

describe("the record checking who asks for a note (invariant 5)", () => {
  it("refuses a device that holds no lease on the item and did not run the run, and changes neither the run nor memory", async () => {
    const { projectId, item } = await organisationWork();
    const run = createRun(recordDb.db, { itemId: item.id as Uuid, agentId: null, action: "implement" });
    updateRun(recordDb.db, run.id, { status: "succeeded", endedAt: 1_000 });
    const before = getRun(recordDb.db, run.id)!;
    // The laptop claims the run ended differently, and writes a note in its name.
    const forged = { ...asRunCommand(before, runCommandId(run.id, "failed"), 0), status: "failed", error: "forged" };

    const answer = await serveMemory(serving, {
      deviceId: laptop.deviceId,
      write: { op: "note", itemId: item.id, scope: projectScope(projectId), body: "Written in another machine's run.", extracted: false, replaces: [] },
      run: forged,
    });

    expect(answer.result).toEqual({ ok: false, problem: expect.stringContaining("did not run that run") });
    expect(getRun(recordDb.db, run.id)).toEqual(before);
    expect(listMemories(recordDb.db, projectScope(projectId), { includeRetired: true })).toEqual([]);
  });

  it("refuses a run the record has never heard of from a device that holds no lease, and records no run", async () => {
    const { projectId, item } = await organisationWork();
    const local = createRun(laptop.handle.db, { itemId: item.id as Uuid, agentId: null, action: "implement" });

    const answer = await serveMemory(serving, {
      deviceId: laptop.deviceId,
      write: { op: "note", itemId: item.id, scope: projectScope(projectId), body: "No claim behind this.", extracted: true, replaces: [] },
      run: asRunCommand(local, runCommandId(local.id, local.status), 0),
    });

    expect(answer.result.ok).toBe(false);
    expect(getRun(recordDb.db, local.id)).toBeUndefined();
    expect(listMemories(recordDb.db, projectScope(projectId), { includeRetired: true })).toEqual([]);
  });
});

describe("a person's memory on a project the organisation holds", () => {
  it("is written on the record, named after the person whose device asked, and copied into the desktop at once", async () => {
    const { projectId } = await organisationWork();

    const added = await addMemoryCommand(anna.record, { scope: projectScope(projectId), body: "Releases go out on Tuesdays." });
    if (!added.ok) throw new Error(added.problem);
    expect(added.entry.source).toEqual({ type: "person", personId: annaPersonId });
    expect(getMemory(recordDb.db, added.entry.id)).toMatchObject({ body: "Releases go out on Tuesdays." });
    expect(getMemory(anna.handle.db, added.entry.id)).toMatchObject({ body: "Releases go out on Tuesdays." });

    // An edit retires the old row and writes a new one — both on the record, both copied here.
    const edited = await editMemoryCommand(anna.record, { id: added.entry.id, body: "Releases go out on Wednesdays." });
    if (!edited.ok) throw new Error(edited.problem);
    expect(getMemory(recordDb.db, added.entry.id)).toMatchObject({ retiredReason: "edited" });
    expect(getMemory(anna.handle.db, added.entry.id)).toMatchObject({ retiredReason: "edited" });
    expect(listMemories(anna.handle.db, projectScope(projectId)).map((entry) => entry.body)).toEqual(["Releases go out on Wednesdays."]);

    // Which version the edit replaced travels with the rows (EO-545).
    expect(editedPredecessors(anna.handle.db, getMemorySearchEntry(anna.handle.db, edited.entry.id)!).map((entry) => entry.id)).toEqual([added.entry.id]);

    // The laptop's pull brings the retirement as well as the new row.
    await laptop.record.sync();
    expect(getMemorySearchEntry(laptop.handle.db, edited.entry.id)?.replacesId).toBe(added.entry.id);
    expect(listMemories(laptop.handle.db, projectScope(projectId), { includeRetired: true }).map((entry) => [entry.body, entry.retiredReason])).toEqual([
      ["Releases go out on Wednesdays.", null],
      ["Releases go out on Tuesdays.", "edited"],
    ]);

    // A retirement made on the record reaches a replica on its pull.
    expect(await retireMemoryCommand(laptop.record, { id: edited.entry.id })).toMatchObject({ ok: true });
    await anna.record.sync();
    expect(listMemories(anna.handle.db, projectScope(projectId))).toEqual([]);
  });

  it("writes nothing when the record cannot be reached, and says so", async () => {
    const { projectId } = await organisationWork();
    anna.online = false;

    const added = await addMemoryCommand(anna.record, { scope: projectScope(projectId), body: "Releases go out on Tuesdays." });

    expect(added).toEqual({ ok: false, problem: expect.stringContaining("could not be reached, so nothing was saved") });
    expect(listMemories(anna.handle.db, projectScope(projectId), { includeRetired: true })).toEqual([]);
    expect(listMemories(recordDb.db, projectScope(projectId), { includeRetired: true })).toEqual([]);
  });

  it("is written here, and never sent, on a project kept on this desktop", async () => {
    const kept = createProject(anna.handle.db, { name: "Mine", keyPrefix: "MINE" });
    anna.online = false;

    const added = await addMemoryCommand(anna.record, { scope: projectScope(kept.id), body: "Mine alone." });

    expect(added).toMatchObject({ ok: true, entry: { source: { type: "person", personId: null } } });
    expect(listMemories(recordDb.db, projectScope(kept.id))).toEqual([]);
  });
});

/**
 * The MCP write tools (EO-546) on a desktop: the memory panel's channels,
 * registered over this desktop's record as production registers them, and
 * called the way a client calls them.
 */
describe("a person's memory written through MCP on a project the organisation holds", () => {
  function serveMemoryTools(machine: Desktop): void {
    const opts = { exposeErrorDetails: true };
    registerHandler("memory:add", (payload) => addMemoryCommand(machine.record, payload), opts);
    registerHandler("memory:edit", (payload) => editMemoryCommand(machine.record, payload), opts);
    registerHandler("memory:retire", (payload) => retireMemoryCommand(machine.record, payload), opts);
    registerHandler("memory:restore", (payload) => restoreMemoryCommand(machine.record, payload), opts);
    registerHandler("memory:restoreConsolidation", (payload) => restoreConsolidationCommand(machine.handle.db, machine.record, payload), opts);
    registerHandler("memory:search", (payload) => searchMemoryCommand(machine.handle.db, payload), opts);
  }

  async function call(name: string, args: Record<string, unknown>): Promise<{ text: string; data: unknown; isError: boolean }> {
    const result = await answerToolCall({ name, arguments: args }, "admin", true);
    const first = result.content[0];
    return { text: first?.type === "text" ? first.text : "", data: result.structuredContent, isError: result.isError === true };
  }

  /** Every row of the scope on one database, active and retired, as a comparable snapshot. */
  const rowsOf = (handle: DbHandle, projectId: string) => listMemories(handle.db, projectScope(projectId), { includeRetired: true });

  afterEach(() => clearHandlerRegistry());

  it("writes on the record, named after the person whose device asked, and the replica holds only the record's rows", async () => {
    const { projectId } = await organisationWork();
    serveMemoryTools(anna);

    const added = await call("memory_add", { scope: projectScope(projectId), body: "Releases go out on Tuesdays." });
    expect(added.isError).toBe(false);
    const entry = (added.data as { entry: { id: string; source: unknown } }).entry;
    // The record named the person: a write made on the replica would have no one to name.
    expect(entry.source).toEqual({ type: "person", personId: annaPersonId });
    expect(getMemory(recordDb.db, entry.id)).toMatchObject({ body: "Releases go out on Tuesdays.", source: { type: "person", personId: annaPersonId } });
    // What the desktop holds is the record's rows, exactly.
    expect(rowsOf(anna.handle, projectId)).toEqual(rowsOf(recordDb, projectId));

    const edited = await call("memory_edit", { id: entry.id, body: "Releases go out on Wednesdays." });
    const newer = (edited.data as { entry: { id: string; source: unknown } }).entry;
    expect(newer.source).toEqual({ type: "person", personId: annaPersonId });
    expect(getMemory(recordDb.db, entry.id)).toMatchObject({ retiredReason: "edited" });
    expect(rowsOf(anna.handle, projectId)).toEqual(rowsOf(recordDb, projectId));

    expect((await call("memory_retire", { id: newer.id })).data).toMatchObject({ ok: true, entry: { id: newer.id, retiredReason: "retired" } });
    expect(getMemory(recordDb.db, newer.id)).toMatchObject({ retiredReason: "retired" });
    expect((await call("memory_restore", { id: newer.id })).data).toMatchObject({ ok: true, entry: { id: newer.id, retiredAt: null } });
    expect(getMemory(recordDb.db, newer.id)).toMatchObject({ retiredAt: null });
    expect(rowsOf(anna.handle, projectId)).toEqual(rowsOf(recordDb, projectId));

    // And the other desktop pulls the same.
    await laptop.record.sync();
    expect(rowsOf(laptop.handle, projectId)).toEqual(rowsOf(recordDb, projectId));
  });

  it("undoes a consolidation on the record that ran it, and answers with the entries as the record left them", async () => {
    const { projectId } = await organisationWork();
    const person = { type: "person" as const, personId: annaPersonId };
    const first = addMemory(recordDb.db, { scope: projectScope(projectId), body: "Shard 3 is flaky.", source: person, now: 1000 });
    const second = addMemory(recordDb.db, { scope: projectScope(projectId), body: "Rerun it once.", source: person, now: 1001 });
    const evidence = addMemory(recordDb.db, { scope: projectScope(projectId), body: "To cut a release: tag, push, publish.", source: person, now: 1002 });
    if (!first.ok || !second.ok || !evidence.ok) throw new Error("could not seed the record");
    const started = startConsolidation(recordDb.db, { scope: projectScope(projectId), trigger: "cap", now: 2000 });
    const applied = applyConsolidation(recordDb.db, {
      id: started.id,
      sent: [first.entry, second.entry, evidence.entry],
      answer: { retire: [], merge: [{ body: "Shard 3 is flaky; rerun it once.", from: [first.entry.id, second.entry.id], contradictsRepositoryFile: false }], rewrite: [] },
      note: null,
      caps: { maxEntries: 200, maxChars: 40_000 },
      now: 2000,
    });
    if (!applied.ok) throw new Error(applied.problem);
    // A skill the consolidation proposed was saved on the record, taking the evidence — in neither of its lists.
    expect(retireMemory(recordDb.db, evidence.entry.id, { reason: "moved_to_skill", consolidationId: started.id, now: 2500 }).ok).toBe(true);
    await anna.record.sync();
    expect(getMemory(anna.handle.db, evidence.entry.id)).toMatchObject({ retiredReason: "moved_to_skill" });
    serveMemoryTools(anna);

    const restored = await call("memory_consolidation_restore", { consolidationId: started.id });

    expect(restored.isError).toBe(false);
    const data = restored.data as { restored: number; retired: number; entries: { id: string; state: string }[] };
    expect(data).toMatchObject({ restored: 3, retired: 1 });
    expect(listConsolidations(recordDb.db, projectScope(projectId))[0]).toMatchObject({ id: started.id, status: "restored" });
    // The evidence is active on this desktop at once, from the record's answer rather than a later pull.
    expect(data.entries.filter((row) => row.state === "active").map((row) => row.id).sort()).toEqual([first.entry.id, second.entry.id, evidence.entry.id].sort());
    expect(getMemory(anna.handle.db, evidence.entry.id)).toMatchObject({ retiredAt: null });
    expect(rowsOf(anna.handle, projectId)).toEqual(rowsOf(recordDb, projectId));
  });

  it("answers that nothing was saved when the record cannot be reached, and writes nothing anywhere", async () => {
    const { projectId } = await organisationWork();
    const onRecord = addMemory(recordDb.db, { scope: projectScope(projectId), body: "Use pnpm.", source: { type: "person", personId: annaPersonId }, now: 1000 });
    if (!onRecord.ok) throw new Error(onRecord.problem);
    await anna.record.sync();
    serveMemoryTools(anna);
    anna.online = false;
    const desktopBefore = rowsOf(anna.handle, projectId);
    const recordBefore = rowsOf(recordDb, projectId);

    for (const [name, args] of [
      ["memory_add", { scope: projectScope(projectId), body: "Releases go out on Tuesdays." }],
      ["memory_edit", { id: onRecord.entry.id, body: "Use pnpm 10." }],
      ["memory_retire", { id: onRecord.entry.id }],
    ] as const) {
      const answer = await call(name, args);
      expect(answer.isError, name).toBe(false);
      expect(answer.text, name).toMatch(/^This project's memory is kept by your organisation's record, which could not be reached, so nothing was saved/);
      expect(answer.data, name).toEqual({ ok: false, problem: answer.text });
    }
    expect(rowsOf(anna.handle, projectId)).toEqual(desktopBefore);
    expect(rowsOf(recordDb, projectId)).toEqual(recordBefore);
  });
});

describe("handing a solo project to the record", () => {
  it("carries its memory entries across — retired ones and their sources too — and the other desktop pulls them", async () => {
    const project = createProject(anna.handle.db, { name: "Mine", keyPrefix: "MINE" });
    const item = createTestItem(anna.handle.db, { type: "story", title: "Learned something", stepId: "todo", projectId: project.id });
    const run = createRun(anna.handle.db, { itemId: item.id, agentId: null, action: "implement" });
    updateRun(anna.handle.db, run.id, { status: "succeeded", endedAt: Date.now() });
    const scope = projectScope(project.id);
    const byRun = addMemory(anna.handle.db, { scope, body: "The tests need Postgres 16.", source: { type: "run", runId: run.id, itemId: item.id } });
    const byPerson = addMemory(anna.handle.db, { scope, body: "Releases go out on Tuesdays.", source: { type: "person", personId: null } });
    const old = addMemory(anna.handle.db, { scope, body: "The old CI is on Jenkins.", source: { type: "person", personId: null } });
    if (!byRun.ok || !byPerson.ok || !old.ok) throw new Error("the fixture's memory was not written");
    retireMemory(anna.handle.db, old.entry.id, { reason: "retired" });

    const moved = await moveProjectToRecord({
      db: anna.handle.db,
      projectId: project.id,
      personId: annaPersonId,
      personName: "Anna",
      send: async (request) => {
        const served = (await serveAdopt(serving, {
          deviceId: anna.deviceId,
          project: request.project,
          keyNextValue: request.keyNextValue,
          final: request.final,
          abandon: request.abandon,
          page: request.page,
        })) as { accepted: RecordAdoptCounts; problem: string | null };
        return served.problem !== null ? { ok: false, problem: served.problem } : { ok: true, accepted: served.accepted };
      },
    });
    if (!moved.ok) throw new Error(moved.problem);

    expect(moved.moved.memories).toBe(3);
    const onRecord = listMemories(recordDb.db, scope, { includeRetired: true });
    expect(onRecord.map((entry) => entry.id).sort()).toEqual([byRun.entry.id, byPerson.entry.id, old.entry.id].sort());
    expect(getMemory(recordDb.db, byRun.entry.id)).toMatchObject({ source: { type: "run", runId: run.id, itemId: item.id } });
    expect(getMemory(recordDb.db, old.entry.id)).toMatchObject({ retiredReason: "retired" });

    // From now on the project's memory is the record's: a person's write
    // from this desktop goes there.
    expect(projectMovedToTheRecord(anna.handle.db, project.id)).toBe(true);
    const added = await addMemoryCommand(anna.record, { scope, body: "Written after the move." });
    if (!added.ok) throw new Error(added.problem);
    expect(getMemory(recordDb.db, added.entry.id)).toBeDefined();

    // And the other desktop is given all of it on its pull.
    await laptop.record.sync();
    expect(listMemories(laptop.handle.db, scope).map((entry) => entry.body).sort()).toEqual(
      ["Releases go out on Tuesdays.", "The tests need Postgres 16.", "Written after the move."].sort(),
    );
  });
});

describe("consolidating a project the organisation holds", () => {
  it("never happens on a desktop holding a replica of it; it happens on the record, workspaces included", async () => {
    const { projectId } = await organisationWork();
    const workspaceScope: MemoryScope = { kind: "workspace", id: "anna-checkout" };
    // Over the entry cap of one, in the project and in a workspace of it
    // that only a desktop has a row for.
    for (const [body, scope] of [
      ["One.", projectScope(projectId)],
      ["Two.", projectScope(projectId)],
      ["Three.", workspaceScope],
      ["Four.", workspaceScope],
    ] as const) {
      const written = addMemory(recordDb.db, { scope, body, source: { type: "run", runId: null, itemId: null }, projectId });
      if (!written.ok) throw new Error(written.problem);
    }
    await anna.record.sync();
    expect(listMemories(anna.handle.db, projectScope(projectId))).toHaveLength(2);

    const caps = () => ({ maxEntries: 1, maxChars: 40_000 });
    const sideCall = vi.fn();
    const onDesktop = createMemoryConsolidator({
      db: anna.handle.db,
      sideCall,
      caps,
      heldElsewhere: (id) => projectMovedToTheRecord(anna.handle.db, id as Uuid),
    });
    expect(onDesktop.check()).toEqual([]);
    expect(listConsolidations(anna.handle.db, projectScope(projectId))).toEqual([]);

    const onRecord = createMemoryConsolidator({ db: recordDb.db, sideCall, caps, workspacesElsewhere: true });
    expect(onRecord.check().map((due) => due.scope)).toEqual(expect.arrayContaining([projectScope(projectId), workspaceScope]));
    expect(sideCall).not.toHaveBeenCalled();
  });
});

describe("a moved project's consolidations, read on a desktop (EO-545)", () => {
  /** 250 consolidations of the project on the record, the oldest of them one that retired an entry and wrote another. */
  async function manyConsolidations(projectId: Uuid) {
    const scope = projectScope(projectId);
    const old = addMemory(recordDb.db, { scope, body: "Old.", source: { type: "run", runId: null, itemId: null }, projectId, now: 1 });
    if (!old.ok) throw new Error(old.problem);
    const oldest = startConsolidation(recordDb.db, { scope, trigger: "cap", now: 10 });
    const applied = applyConsolidation(recordDb.db, {
      id: oldest.id,
      sent: [old.entry],
      answer: { retire: [], merge: [], rewrite: [{ id: old.entry.id, body: "Old, merged.", contradictsRepositoryFile: false }] },
      note: null,
      caps: { maxEntries: 200, maxChars: 40_000 },
      now: 10,
    });
    if (!applied.ok) throw new Error(applied.problem);
    for (let at = 1; at < 250; at += 1) startConsolidation(recordDb.db, { scope, trigger: "schedule", now: 100 + at });
    await anna.record.sync();
    return { scope, old: old.entry.id, written: applied.consolidation.writtenIds[0]!, oldest: oldest.id };
  }

  it("reads every page the record has, newest first, and finds an old entry's consolidation", async () => {
    const { projectId } = await organisationWork();
    const { scope, old, written, oldest } = await manyConsolidations(projectId);

    const listed = await listConsolidationsCommand(anna.record, { scope });
    expect(consolidationPagesAsked).toBe(2);
    expect(listed.consolidations).toHaveLength(250);
    expect(new Set(listed.consolidations.map((row) => row.id)).size).toBe(250);
    expect(listed.consolidations.map((row) => row.startedAt)).toEqual([...listed.consolidations.map((row) => row.startedAt)].sort((a, b) => b - a));
    expect(listed.consolidations[249]).toMatchObject({ id: oldest, replacedCount: 1, producedCount: 1, restored: false });

    const retired = await getMemoryCommand(anna.handle.db, anna.record, { id: old });
    expect(retired).toMatchObject({ ok: true, retiredBy: { id: oldest } });
    const produced = await getMemoryCommand(anna.handle.db, anna.record, { id: written });
    expect(produced).toMatchObject({ ok: true, producedBy: { id: oldest } });
  });

  it("answers what this desktop holds, rather than a list cut short, when a later page fails", async () => {
    const { projectId } = await organisationWork();
    const { scope } = await manyConsolidations(projectId);
    failConsolidationPage = 2;

    const listed = await listConsolidationsCommand(anna.record, { scope });
    expect(listed.consolidations).toEqual(listConsolidations(anna.handle.db, scope));
    expect(listed.consolidations).not.toHaveLength(200);
  });
});

/** A transport-free hand-over of one of Anna's projects to the record. */
async function handOver(projectId: Uuid): Promise<RecordAdoptCounts> {
  const moved = await moveProjectToRecord({
    db: anna.handle.db,
    projectId,
    personId: annaPersonId,
    personName: "Anna",
    send: async (request) => {
      const served = (await serveAdopt(serving, {
        deviceId: anna.deviceId,
        project: request.project,
        keyNextValue: request.keyNextValue,
        final: request.final,
        abandon: request.abandon,
        page: request.page,
      })) as { accepted: RecordAdoptCounts; problem: string | null };
      return served.problem !== null ? { ok: false, problem: served.problem } : { ok: true, accepted: served.accepted };
    },
  });
  if (!moved.ok) throw new Error(moved.problem);
  return moved.moved;
}

describe("a workspace's memory when the workspace changes project", () => {
  it("goes with the workspace, so handing over the project it is in now carries it, and the one it left does not", async () => {
    const workspace = createWorkspace(anna.handle.db, { kind: FOLDER_KIND, config: { path: root } });
    const scope: MemoryScope = { kind: "workspace", id: workspace.id };
    // Written while the workspace belonged to no project at all…
    const early = addMemory(anna.handle.db, { scope, body: "The fixtures live in ./fixtures.", source: { type: "person", personId: null } });
    // …then attached to one project, written to again, and moved to another.
    const first = createProject(anna.handle.db, { name: "First", keyPrefix: "FIR", workspaceIds: [workspace.id] });
    const later = addMemory(anna.handle.db, { scope, body: "Run the linter before pushing.", source: { type: "person", personId: null } });
    const second = createProject(anna.handle.db, { name: "Second", keyPrefix: "SEC" });
    addWorkspaceToProject(anna.handle.db, second.id, workspace.id);
    if (!early.ok || !later.ok) throw new Error("the fixture's memory was not written");

    expect(readProjectMemories(anna.handle.db, first.id)).toEqual([]);
    expect(readProjectMemories(anna.handle.db, second.id).map((entry) => entry.id).sort()).toEqual([early.entry.id, later.entry.id].sort());

    const moved = await handOver(second.id);

    expect(moved.memories).toBe(2);
    expect(listMemories(recordDb.db, scope).map((entry) => entry.body).sort()).toEqual(["Run the linter before pushing.", "The fixtures live in ./fixtures."]);
    expect(readProjectMemories(recordDb.db, second.id)).toHaveLength(2);
  });
});

describe("a consolidation running when its project is handed over", () => {
  it("does not change the replica with an answer that arrives after the hand-over", async () => {
    const project = createProject(anna.handle.db, { name: "Mine", keyPrefix: "MINE" });
    const scope = projectScope(project.id);
    const notes = ["One.", "Two.", "Three."].map((body) => {
      const written = addMemory(anna.handle.db, { scope, body, source: { type: "run", runId: null, itemId: null } });
      if (!written.ok) throw new Error(written.problem);
      return written.entry;
    });
    let answer!: (value: unknown) => void;
    const sideCall = vi.fn(() => new Promise((resolve) => (answer = resolve)));
    const consolidator = createMemoryConsolidator({
      db: anna.handle.db,
      sideCall: sideCall as never,
      caps: () => ({ maxEntries: 1, maxChars: 40_000 }),
      systemAgent: () => ({ backend: "fake", model: null, reasoningEffort: null }),
      heldElsewhere: (id) => projectMovedToTheRecord(anna.handle.db, id as Uuid),
    });
    consolidator.start();
    await vi.waitFor(() => expect(sideCall).toHaveBeenCalledTimes(1));

    // Handed over while the side call is out.
    await handOver(project.id);
    answer({ ok: true, value: { entries: [{ body: "All three.", from: notes.map((entry) => entry.id), contradictsRepositoryFile: false }] } });
    await consolidator.idle();
    consolidator.stop();

    expect(activeMemoriesIn(anna.handle.db, [scope]).map((entry) => entry.body).sort()).toEqual(["One.", "Three.", "Two."]);
    expect(listConsolidations(anna.handle.db, scope)).toEqual([expect.objectContaining({ status: "failed", writtenIds: [], retiredIds: [] })]);
    // …and the record holds what was handed over, unconsolidated.
    expect(activeMemoriesIn(recordDb.db, [scope])).toHaveLength(3);
  });
});
