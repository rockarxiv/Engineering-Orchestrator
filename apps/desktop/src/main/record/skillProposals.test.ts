import type { IpcChannel, IpcPayload, IpcResponse, IpcResult, MemoryEntryView, MemoryScope, SideCallResult, Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { issueDevice } from "../db/repos/devicesRepo.js";
import { createPerson } from "../db/repos/peopleRepo.js";
import {
  addMemory,
  createProject,
  createRun,
  getAgentAttachments,
  getProject,
  getSkillBySlug,
  listAgents,
  listMemories,
  listSkillVersions,
} from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { MEMORY_PROPOSE_SKILLS_SYSTEM } from "../memory/consolidation.js";
import { createMemoryConsolidator } from "../memory/consolidator.js";
import { findProjectThread } from "../projects/projectThread.js";
import type { SideCallRequest } from "../sideCalls/sideCall.js";
import { createDeviceRecord, type DeviceRecord } from "./deviceRecord.js";
import { createLocalRecord } from "./localRecord.js";
import { serveApply, serveChanges, serveProjectThread, type ServeRecordContext } from "./serveRecord.js";
import type { RecordTransport } from "./syncStatus.js";

/**
 * A skill proposal on a project the organisation holds (EO-483, EO-719,
 * ARCHITECTURE.md, "Proposing skills", "The record").
 *
 * The proposal is applied on the desktop whose consolidation made it —
 * the memory, skills and agents it changes are that desktop's — and its
 * notice is posted on the project's thread, which the record and every
 * desktop share. The notice asks nothing, so a reply to it from another
 * device, with the words proposals used to offer, changes nothing
 * anywhere. One record and two desktops in one process, through the
 * `serve*` functions `server/http.ts` puts behind its door.
 */

type Answer = SideCallResult<unknown>;
type AnyRequest = SideCallRequest<unknown>;

const CAPS = { maxEntries: 6, maxChars: 40_000 };
const BODY = "## Trigger\nWhen the e2e suite runs.\n\n## Steps\n1. `Xvfb :99 &`, then `pnpm e2e`.\n\n## Verification\nEvery spec passes.";

interface Desktop {
  handle: DbHandle;
  record: DeviceRecord;
}

let recordDb: DbHandle;
let serving: ServeRecordContext;
let desk: Desktop;
let laptop: Desktop;

function transport(): RecordTransport {
  return {
    async request<K extends IpcChannel>(channel: K, payload: IpcPayload<K>): Promise<IpcResult<IpcResponse<K>>> {
      const answer = await (async (): Promise<unknown> => {
        switch (channel) {
          case "record:apply":
            return serveApply(serving, payload as IpcPayload<"record:apply">);
          case "record:changes":
            return serveChanges(serving, payload as IpcPayload<"record:changes">);
          case "record:projectThread":
            return serveProjectThread(serving, payload as IpcPayload<"record:projectThread">);
          default:
            return null;
        }
      })();
      return answer === null ? { ok: false, error: { message: `EO has no channel called "${channel}".` } } : { ok: true, data: answer as IpcResponse<K> };
    },
  };
}

function desktop(personId: Uuid, machine: string): Desktop {
  const handle = openMigratedTestDb();
  const deviceId = issueDevice(recordDb.db, { personId, name: machine, tokenHash: `hash-of-${machine}`, secretsKeyHash: null }).id;
  return { handle, record: createDeviceRecord({ db: handle.db, deviceId: () => deviceId, transport: () => transport(), pullPageSize: 500 }) };
}

beforeEach(() => {
  recordDb = openMigratedTestDb();
  serving = { db: recordDb.db, record: createLocalRecord(recordDb.db), offerWork: async () => [] };
  // One person, two machines: the desk that consolidated, and the laptop
  // they answer from.
  const anna = createPerson(recordDb.db, { name: "Anna", email: "anna@example.com" }).id as Uuid;
  desk = desktop(anna, "anna-desk");
  laptop = desktop(anna, "anna-laptop");
});

afterEach(() => {
  for (const machine of [desk, laptop]) {
    machine.record.stop();
    machine.handle.close();
  }
  recordDb.close();
});

/** Enough rounds for a press on one desktop to reach the other and its answer to come back. */
async function syncAll(): Promise<void> {
  for (let round = 0; round < 3; round += 1) {
    await desk.record.sync();
    await laptop.record.sync();
  }
}

/**
 * A project on the record with an item, pulled to both desktops; six
 * notes in the desk's memory of it, two of them the e2e procedure; and a
 * consolidation on the desk that proposes `run-e2e`, after which every
 * device has synced.
 */
async function proposed(): Promise<{ projectId: Uuid; evidence: MemoryEntryView[] }> {
  const project = createProject(recordDb.db, { name: "Support", keyPrefix: "SUP", managed: true });
  const item = createTestItem(recordDb.db, { type: "story", title: "Fix the export", stepId: "todo", projectId: project.id as Uuid });
  await syncAll();
  if (getProject(desk.handle.db, project.id as Uuid) === undefined) throw new Error("the project did not reach the desk");

  const implementer = listAgents(desk.handle.db).find((agent) => agent.role === "implementer")!;
  const run = createRun(desk.handle.db, { itemId: item.id, agentId: implementer.id, action: "implement", status: "succeeded" }).id;
  const scope: MemoryScope = { kind: "project", id: project.id };
  const at = Date.now() - 3 * 24 * 60 * 60 * 1000;
  const note = (body: string, offset: number) => {
    const written = addMemory(desk.handle.db, { scope, body, source: { type: "run", runId: run, itemId: item.id }, now: at + offset });
    if (!written.ok) throw new Error(written.problem);
    return written.entry;
  };
  const evidence = [note("e2e: start `Xvfb :99 &`, then `pnpm e2e`.", 0), note("e2e failed with Missing X server; started Xvfb and reran.", 1)];
  const facts = [1, 2, 3, 4].map((index) => note(`The ledger is in UTC (${index}).`, 10 + index));

  const consolidator = createMemoryConsolidator({
    db: desk.handle.db,
    caps: () => CAPS,
    // The consolidation folds the facts; the skill proposal call after it (EO-575) proposes `run-e2e`.
    sideCall: (async (request: AnyRequest): Promise<Answer> => ({
      ok: true,
      value: request.schema.parse(
        request.system !== MEMORY_PROPOSE_SKILLS_SYSTEM
          ? { retire: [], merge: [{ body: "The ledger is in UTC.", from: facts.map((entry) => entry.id), contradictsRepositoryFile: false }], rewrite: [] }
          : {
        skills: [
          {
            kind: "new",
            slug: "run-e2e",
            name: "Run e2e",
            description: "Run this repository's e2e suite under a virtual display.",
            scope,
            evidence: { entryIds: evidence.map((entry) => entry.id), itemIds: [item.id] },
            body: BODY,
          },
        ],
      }),
    })) as never,
  });
  consolidator.start();
  await consolidator.idle();
  consolidator.stop();
  await syncAll();

  return { projectId: project.id as Uuid, evidence };
}

describe("a skill proposal on a project the organisation holds", () => {
  it("is applied on the desktop whose consolidation proposed it, and posts nothing on any copy (EO-728)", async () => {
    const { projectId, evidence } = await proposed();

    const skill = getSkillBySlug(desk.handle.db, "run-e2e");
    expect(skill).toMatchObject({ createdBy: "agent", scope: { kind: "project", projectId } });
    const versions = listSkillVersions(desk.handle.db, skill!.id);
    expect(versions.map((version) => version.author.kind)).toEqual(["consolidation"]);
    expect(versions[0]!.report).toMatchObject({ kind: "consolidation", evidence: evidence.map((entry) => ({ entryId: entry.id, body: entry.body })) });
    const implementer = listAgents(desk.handle.db).find((agent) => agent.role === "implementer")!;
    expect(getAgentAttachments(desk.handle.db, implementer.id).skillIds).toEqual([skill!.id]);
    const active = listMemories(desk.handle.db, { kind: "project", id: projectId }).map((entry) => entry.id);
    for (const entry of evidence) expect(active).not.toContain(entry.id);

    // No project thread was opened on the record or on either desktop.
    for (const where of [desk.handle, recordDb, laptop.handle]) expect(findProjectThread(where.db, projectId)).toBeUndefined();
  });
});
