import type { Comment, IpcChannel, IpcPayload, IpcResponse, IpcResult, MemoryEntryView, MemoryScope, SideCallResult, Uuid } from "@eo/core";
import { SKILL_PROPOSAL_DISCARD, SKILL_PROPOSAL_PROPOSE_AGAIN, SKILL_PROPOSAL_SAVE } from "@eo/core";
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
  listCommentsForItem,
  listMemories,
  skillProposalForComment,
} from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { postHumanComment } from "../ipc/domainCommands.js";
import { MEMORY_PROPOSE_SKILLS_SYSTEM } from "../memory/consolidation.js";
import { createMemoryConsolidator } from "../memory/consolidator.js";
import { findProjectThread } from "../projects/projectThread.js";
import type { SideCallRequest } from "../sideCalls/sideCall.js";
import { createDeviceRecord, type DeviceRecord } from "./deviceRecord.js";
import { createLocalRecord } from "./localRecord.js";
import { serveApply, serveChanges, serveProjectThread, type ServeRecordContext } from "./serveRecord.js";
import type { RecordTransport } from "./syncStatus.js";

/**
 * A skill proposal on a project the organisation holds (EO-483,
 * ARCHITECTURE.md, "What an agent is given", "The record").
 *
 * The proposal is posted on the project's thread, which the record and
 * every desktop share; its row, and the memory, skills and agents Save
 * changes, are the desktop whose consolidation made it. So a press on
 * another device has to reach that desktop and be carried out there,
 * once — and EO's answer has to come back to the thread everyone sees.
 * One record and two desktops in one process, through the `serve*`
 * functions `server/http.ts` puts behind its door.
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
 * consolidation on the desk that proposes `run-e2e`, posted on the
 * record's project thread and pulled to the laptop.
 */
async function proposed(): Promise<{ projectId: Uuid; evidence: MemoryEntryView[]; offer: Comment }> {
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
    projectThread: (projectId) => desk.record.projectThread(projectId),
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

  const thread = findProjectThread(laptop.handle.db, project.id as Uuid);
  expect(findProjectThread(recordDb.db, project.id as Uuid)?.id).toBe(thread?.id);
  const offer = listCommentsForItem(laptop.handle.db, thread!.id as Uuid).find((comment) => comment.options?.includes(SKILL_PROPOSAL_SAVE));
  if (!offer) throw new Error("the proposal did not reach the laptop");
  // The row is the desk's alone.
  expect(skillProposalForComment(desk.handle.db, offer.id)).toBeDefined();
  expect(skillProposalForComment(laptop.handle.db, offer.id)).toBeUndefined();
  expect(offer.body).toContain("carried out there");
  return { projectId: project.id as Uuid, evidence, offer };
}

async function pressOnLaptop(offer: Comment, option: string): Promise<void> {
  await postHumanComment(laptop.handle.db, undefined, { itemId: offer.itemId, body: option, parentId: offer.id, mentions: [], pinned: false, attachmentIds: [] });
  await syncAll();
}

function answersOn(handle: DbHandle, offer: Comment): Comment[] {
  return listCommentsForItem(handle.db, offer.itemId as Uuid).filter((comment) => comment.parentId === offer.id && comment.authorType === "engine");
}

describe("answering a skill proposal from another device", () => {
  it("is Save carried out once on the desktop whose consolidation proposed it, with EO's answer back on every copy of the thread", async () => {
    const { projectId, evidence, offer } = await proposed();

    await pressOnLaptop(offer, SKILL_PROPOSAL_SAVE);

    const skill = getSkillBySlug(desk.handle.db, "run-e2e");
    expect(skill).toBeDefined();
    const implementer = listAgents(desk.handle.db).find((agent) => agent.role === "implementer")!;
    expect(getAgentAttachments(desk.handle.db, implementer.id).skillIds).toEqual([skill!.id]);
    const active = listMemories(desk.handle.db, { kind: "project", id: projectId }).map((entry) => entry.id);
    for (const entry of evidence) expect(active).not.toContain(entry.id);
    expect(skillProposalForComment(desk.handle.db, offer.id)).toMatchObject({ status: "saved" });
    // Nothing on the laptop or the record: neither holds the proposal.
    expect(getSkillBySlug(laptop.handle.db, "run-e2e")).toBeUndefined();
    expect(getSkillBySlug(recordDb.db, "run-e2e")).toBeUndefined();

    for (const where of [desk.handle, recordDb, laptop.handle]) {
      const said = answersOn(where, offer);
      expect(said).toHaveLength(1);
      expect(said[0]!.body).toContain("Saved the skill `run-e2e`");
    }

    // The same press arriving again — a replay, a second sync — does nothing more.
    await syncAll();
    expect(answersOn(desk.handle, offer)).toHaveLength(1);
  });

  it("is Discard recorded on the desktop whose consolidation proposed it, so its fingerprint holds there", async () => {
    const { offer } = await proposed();

    await pressOnLaptop(offer, SKILL_PROPOSAL_DISCARD);

    expect(skillProposalForComment(desk.handle.db, offer.id)).toMatchObject({ status: "discarded" });
    expect(getSkillBySlug(desk.handle.db, "run-e2e")).toBeUndefined();
    for (const where of [desk.handle, recordDb, laptop.handle]) {
      expect(answersOn(where, offer).map((comment) => comment.body)).toEqual([expect.stringContaining("will not propose `run-e2e` again")]);
    }
  });

  it("is Propose again carried out on the desktop that holds the discard record, which removes it (EO-512)", async () => {
    const { offer } = await proposed();
    await pressOnLaptop(offer, SKILL_PROPOSAL_DISCARD);

    await pressOnLaptop(offer, SKILL_PROPOSAL_PROPOSE_AGAIN);

    expect(skillProposalForComment(desk.handle.db, offer.id)).toBeUndefined();
    for (const where of [desk.handle, recordDb, laptop.handle]) {
      expect(answersOn(where, offer).map((comment) => comment.body)).toEqual([expect.stringContaining("Discarded."), expect.stringContaining("Allowed again.")]);
    }
    await syncAll();
    expect(answersOn(desk.handle, offer)).toHaveLength(2);
  });
});
