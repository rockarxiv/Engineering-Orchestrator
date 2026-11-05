import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipcContract, McpServerDraftSchema, SkillDraftSchema, type IpcChannel, type IpcPayload, type RecordAdoptCounts, type Uuid } from "@eo/core";
import { buildTickInput } from "../supervisor/buildTickInput.js";
import type { DbHandle } from "../db/client.js";
import { markReplica } from "../db/recordRole.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { archiveAgent, createAgent, getAgent, listAgents, updateAgent } from "../db/repos/agentsRepo.js";
import { getAgentAttachments, setAgentAttachment } from "../db/repos/agentAttachmentsRepo.js";
import { createProject, getProject } from "../db/repos/projectsRepo.js";
import { createPerson } from "../db/repos/peopleRepo.js";
import { issueDevice } from "../db/repos/devicesRepo.js";
import { createRun, updateRun } from "../db/repos/runsRepo.js";
import { getSkill, saveSkill, upsertReplicaSkill } from "../db/repos/skillsRepo.js";
import { saveMcpServer } from "../db/repos/mcpServersRepo.js";
import { setSetting } from "../db/repos/settingsRepo.js";
import { countProjectRows, upsertReplicaProjectAgent } from "../db/repos/projectMoveRepo.js";
import { sectionDocument } from "../managed/configuration.js";
import { sectionLockFor } from "../managed/locks.js";
import { publishSectionCommand } from "../ipc/sectionCommands.js";
import { saveAgent } from "../ipc/configCommands.js";
import { clearHandlerRegistry, dispatchIpc, registerHandler } from "../ipc/registry.js";
import { MANAGED_PERSON_ID_KEY } from "../identity/viewer.js";
import { createLocalRecord, type LocalItemRecord } from "./localRecord.js";
import { createDeviceRecord, type DeviceRecord } from "./deviceRecord.js";
import { moveProjectToRecord } from "./adopt.js";
import { serveAdopt, serveApply, serveChanges, serveRelease, serveRenew, serveWork, type ServeRecordContext } from "./serveRecord.js";
import type { RecordTransport } from "./syncStatus.js";

/**
 * A project's own agents travel with the project (EO-476,
 * ARCHITECTURE.md, "An agent is a row", "The record").
 *
 * Three databases, as `keepOrMove.test.ts` has them: the organisation's
 * record, Anna's desktop that holds the project, and her laptop — a
 * replica that has never seen it. The requests go through the same
 * `serve*` functions the server puts behind its door, so what is
 * exercised is the record contract rather than a stub of it.
 */

let recordDb: DbHandle;
let annaDb: DbHandle;
let laptopDb: DbHandle;
let theRecord: LocalItemRecord;
let serving: ServeRecordContext;
let anna: Desktop;
let laptop: Desktop;
let annaPersonId: Uuid;
let stopBeingAReplica: (() => void) | null = null;

const LIMITS = { globalConcurrency: 1, perAgentConcurrency: 1, perRepositoryConcurrency: 1 };

interface Desktop {
  handle: DbHandle;
  record: DeviceRecord;
  deviceId: string;
}

beforeEach(() => {
  recordDb = openMigratedTestDb();
  annaDb = openMigratedTestDb();
  laptopDb = openMigratedTestDb();
  theRecord = createLocalRecord(recordDb.db);
  serving = {
    db: recordDb.db,
    record: theRecord,
    offerWork: (deviceId, capacity) => theRecord.offerWork({ deviceId, capacity, tickInput: buildTickInput(recordDb.db, LIMITS, false) }),
  };
  const person = createPerson(recordDb.db, { name: "Anna", email: "anna@example.com" });
  annaPersonId = person.id;
  anna = desktop(annaDb, issueDevice(recordDb.db, { personId: person.id, name: "anna-desk", tokenHash: "h1", secretsKeyHash: null }).id);
  laptop = desktop(laptopDb, issueDevice(recordDb.db, { personId: person.id, name: "anna-laptop", tokenHash: "h2", secretsKeyHash: null }).id);
  setSetting(annaDb.db, MANAGED_PERSON_ID_KEY, annaPersonId);
  setSetting(laptopDb.db, MANAGED_PERSON_ID_KEY, annaPersonId);
});

afterEach(() => {
  stopBeingAReplica?.();
  stopBeingAReplica = null;
  clearHandlerRegistry();
  anna.record.stop();
  laptop.record.stop();
  recordDb.close();
  annaDb.close();
  laptopDb.close();
});

function desktop(handle: DbHandle, deviceId: string, pullPageSize = 500): Desktop {
  const transport: RecordTransport = {
    async request(channel, payload) {
      const answer = await answerOnTheRecord(channel, payload);
      return answer === null ? { ok: false, error: { message: `EO has no channel called "${channel}".` } } : { ok: true, data: answer as never };
    },
  };
  return {
    handle,
    deviceId,
    record: createDeviceRecord({ db: handle.db, deviceId: () => deviceId, transport: () => transport, pullPageSize }),
  };
}

async function answerOnTheRecord(channel: string, payload: unknown): Promise<unknown> {
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
    case "record:adopt":
      return await serveAdopt(serving, payload as IpcPayload<"record:adopt">);
    default:
      return null;
  }
}

/** The move, as the IPC command performs it: pages over the transport, into the record. */
async function move(projectId: Uuid): Promise<{ problem?: string }> {
  const outcome = await moveProjectToRecord({
    db: annaDb.db,
    projectId,
    personId: annaPersonId,
    personName: "Anna",
    send: async (request) => {
      // Through the contract's own schema, as the server's door reads
      // it, so a page over the contract's limits is refused here as it
      // would be there rather than quietly accepted by a direct call.
      const parsed = ipcContract["record:adopt"].request.safeParse({
        deviceId: anna.deviceId,
        project: request.project,
        keyNextValue: request.keyNextValue,
        final: request.final,
        abandon: request.abandon,
        page: request.page,
      });
      if (!parsed.success) return { ok: false, problem: `the record refused the request: ${parsed.error.message}` };
      const served = (await answerOnTheRecord("record:adopt", parsed.data)) as { accepted: RecordAdoptCounts; problem: string | null };
      if (served.problem !== null) return { ok: false, problem: served.problem };
      return { ok: true, accepted: served.accepted };
    },
  });
  return outcome.ok ? {} : { problem: outcome.problem };
}

/** A skill both installations hold under one id, so an attachment to it can travel. */
function sharedSkill(): string {
  const saved = saveSkill(annaDb.db, SkillDraftSchema.parse({ name: "House style", description: "How support writes.", body: "Be brief." }));
  if (!saved.ok) throw new Error(saved.problems.join("\n"));
  upsertReplicaSkill(recordDb.db, getSkill(annaDb.db, saved.skill.id)!);
  upsertReplicaSkill(laptopDb.db, getSkill(annaDb.db, saved.skill.id)!);
  return saved.skill.id;
}

/**
 * Anna's Support project, with an agent of its own — attached to a
 * skill, and with a run on the project's work to its name — a retired
 * one, and one global agent of hers that is the installation's rather
 * than the project's.
 */
function supportWithItsOwnAgents() {
  const support = createProject(annaDb.db, { name: "Support", keyPrefix: "SUP", managed: false });
  const own = createAgent(annaDb.db, {
    name: "Support implementer",
    role: "implementer",
    provider: "codex",
    model: "gpt-5",
    instructions: "Implement in the support team's voice.",
    config: { effort: "high" },
    projectId: support.id,
  });
  const skillId = sharedSkill();
  expect(setAgentAttachment(annaDb.db, { agentId: own.id, kind: "skill", id: skillId, attached: true }).ok).toBe(true);
  const retired = createAgent(annaDb.db, { name: "Old support writer", role: "writer", provider: "fake", instructions: "Write.", projectId: support.id });
  archiveAgent(annaDb.db, retired.id);
  const hers = createAgent(annaDb.db, { name: "Anna's global writer", role: "writer", provider: "fake", instructions: "Write for everyone." });

  const item = createTestItem(annaDb.db, { type: "story", title: "A refund", stepId: "todo", projectId: support.id });
  const run = createRun(annaDb.db, { itemId: item.id, agentId: own.id, action: "implement", stepId: "todo" });
  updateRun(annaDb.db, run.id, { status: "succeeded", endedAt: 3 });
  return { support, own, retired, hers, item, run, skillId };
}

describe("handing a solo project to the record (EO-476)", () => {
  it("carries the project's own agents with it, tool surface and history included, and leaves the global ones behind", async () => {
    const { support, own, retired, hers, run, skillId } = supportWithItsOwnAgents();

    expect(await move(support.id)).toEqual({});

    // The project's own agents are on the record, under the ids they
    // had, as the project's — archived one included, since a run or a
    // comment may name it.
    const there = getAgent(recordDb.db, own.id);
    expect(there).toMatchObject({
      name: "Support implementer",
      role: "implementer",
      instructions: "Implement in the support team's voice.",
      config: { effort: "high" },
      enabled: true,
      projectId: support.id,
    });
    expect(getAgentAttachments(recordDb.db, own.id).skillIds).toEqual([skillId]);
    expect(getAgent(recordDb.db, retired.id)).toMatchObject({ projectId: support.id });
    expect(getAgent(recordDb.db, retired.id)?.archivedAt).not.toBeNull();
    // A global agent is the installation's, not the project's.
    expect(getAgent(recordDb.db, hers.id)).toBeUndefined();

    // The moved run still says who did it, because the agents went up
    // before the runs that name them.
    expect(recordDb.db.get<{ agentId: string | null }>(sql`select agent_id as agentId from runs where id = ${run.id}`)?.agentId).toBe(own.id);
    // …and the count comparison holds for them as for every other table.
    expect(countProjectRows(recordDb.db, support.id).agents).toBe(2);
    expect(countProjectRows(recordDb.db, support.id)).toEqual(countProjectRows(annaDb.db, support.id));
  });

  it("makes them the record's staffing for the project: the record offers the project's work to its own agent", async () => {
    const { support, own, item } = supportWithItsOwnAgents();
    await move(support.id);
    // The run that was already there is over; this is the step's next one.
    const offers = await serving.offerWork(anna.deviceId, 1);

    const offered = offers.find((offer) => offer.dispatch.item.id === item.id);
    expect(offered?.dispatch.agent?.id).toBe(own.id);
  });

  it("puts them on a replica that pulls the project, scoped to it, with the record's backend as a starting point", async () => {
    const { support, own, retired, hers, skillId } = supportWithItsOwnAgents();
    await move(support.id);

    await laptop.record.sync();

    expect(getProject(laptopDb.db, support.id)).toBeDefined();
    const landed = getAgent(laptopDb.db, own.id);
    expect(landed).toMatchObject({
      name: "Support implementer",
      instructions: "Implement in the support team's voice.",
      config: { effort: "high" },
      enabled: true,
      projectId: support.id,
      // A recommendation, spent on the first arrival.
      provider: "codex",
      model: "gpt-5",
    });
    expect(getAgentAttachments(laptopDb.db, own.id).skillIds).toEqual([skillId]);
    expect(getAgent(laptopDb.db, retired.id)?.archivedAt).not.toBeNull();
    expect(getAgent(laptopDb.db, hers.id)).toBeUndefined();
    // The desktop that moved it still has its own copy, unchanged.
    expect(getAgent(annaDb.db, own.id)).toMatchObject({ projectId: support.id, enabled: true });
  });

  it("carries more agents than one page holds, within the contract's limit, before the runs that name them (review)", async () => {
    const { support, own, run } = supportWithItsOwnAgents();
    // Archived and deleted ones count: nothing bounds how many a
    // project collects over its life.
    for (let index = 0; index < 205; index += 1) {
      const extra = createAgent(annaDb.db, { name: `Retired writer ${String(index)}`, role: "writer", provider: "fake", instructions: "Write.", projectId: support.id });
      archiveAgent(annaDb.db, extra.id);
    }
    const local = countProjectRows(annaDb.db, support.id).agents;
    expect(local).toBe(207);

    expect(await move(support.id)).toEqual({});

    expect(countProjectRows(recordDb.db, support.id).agents).toBe(local);
    expect(recordDb.db.get<{ agentId: string | null }>(sql`select agent_id as agentId from runs where id = ${run.id}`)?.agentId).toBe(own.id);
  });

  it("keeps a project's agents out of the agents section's publication, so none lands as a global agent", async () => {
    const { support, own } = supportWithItsOwnAgents();
    await move(support.id);

    const document = sectionDocument(recordDb.db, "agents");
    expect(document?.agents.some((agent) => agent.id === own.id)).toBe(false);
    expect(document?.agents.length).toBeGreaterThan(0);
  });
});

describe("a record-held project's agents on a replica (EO-476)", () => {
  async function movedAndPulled() {
    const arranged = supportWithItsOwnAgents();
    await move(arranged.support.id);
    await laptop.record.sync();
    return arranged;
  }

  it("are the record's configuration where the agents section is published: an edit on the record reaches the replica", async () => {
    const { own, support } = await movedAndPulled();
    // Laptop picks its own backend, which stays its own.
    updateAgent(laptopDb.db, own.id, { provider: "claude", model: null });

    publishSectionCommand(recordDb.db, { section: "agents", pipelineId: null, versionNumber: null });
    updateAgent(recordDb.db, own.id, { instructions: "Implement in the support team's voice, second edition." });
    await laptop.record.sync();

    expect(getAgent(laptopDb.db, own.id)).toMatchObject({
      instructions: "Implement in the support team's voice, second edition.",
      projectId: support.id,
      provider: "claude",
      // Not stood down by the publication's global implementer: on its
      // project it outranks the global ones, and it is the record's.
      enabled: true,
    });
  });

  it("are left as this machine has them where the section is not published, as unpublished pipelines are", async () => {
    const { own } = await movedAndPulled();

    updateAgent(recordDb.db, own.id, { instructions: "Changed on the record." });
    await laptop.record.sync();

    expect(getAgent(laptopDb.db, own.id)?.instructions).toBe("Implement in the support team's voice.");
    // A new agent of the project's still arrives.
    const support = getAgent(recordDb.db, own.id)!.projectId!;
    const second = createAgent(recordDb.db, { name: "Support reviewer", role: "reviewer", provider: "claude", instructions: "Review.", projectId: support });
    await laptop.record.sync();
    expect(getAgent(laptopDb.db, second.id)).toMatchObject({ projectId: support, instructions: "Review." });
  });

  it("refuses an edit like any other locked edit, on a managed desktop with the agents section locked", async () => {
    const { own } = await movedAndPulled();
    publishSectionCommand(recordDb.db, { section: "agents", pipelineId: null, versionNumber: null });
    await laptop.record.sync();

    stopBeingAReplica = markReplica(laptopDb.db, () => true);
    registerHandler("agents:save", (payload) => saveAgent(laptopDb.db, payload), {
      exposeErrorDetails: true,
      sectionLock: (channel: IpcChannel) => sectionLockFor(laptopDb.db, channel),
    });
    const before = getAgent(laptopDb.db, own.id)!;

    const answer = await dispatchIpc("agents:save", {
      id: own.id,
      name: before.name,
      role: before.role,
      provider: before.provider,
      instructions: "Rewritten on the laptop.",
    } satisfies Partial<IpcPayload<"agents:save">>);

    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(answer.error.code).toBe("section-locked");
    expect(answer.error.lock).toMatchObject({ locked: true, section: "agents" });
    expect(getAgent(laptopDb.db, own.id)).toEqual(before);
  });

  it("take the record's current configuration when the agents section is published, with no edit after it (review)", async () => {
    const { own } = await movedAndPulled();
    // Edited on the record while the section was unpublished: the
    // replica keeps its own copy, and its cursor reads past the edit.
    updateAgent(recordDb.db, own.id, { instructions: "Edited before anything was published." });
    await laptop.record.sync();
    expect(getAgent(laptopDb.db, own.id)?.instructions).toBe("Implement in the support team's voice.");

    publishSectionCommand(recordDb.db, { section: "agents", pipelineId: null, versionNumber: null });
    await laptop.record.sync();

    // Locked now, and holding what the record holds — not the copy it
    // can no longer correct.
    expect(getAgent(laptopDb.db, own.id)?.instructions).toBe("Edited before anything was published.");
  });

  it("agree with a fresh replica once the record makes one of them global (review)", async () => {
    const { own } = await movedAndPulled();
    publishSectionCommand(recordDb.db, { section: "agents", pipelineId: null, versionNumber: null });
    await laptop.record.sync();
    expect(getAgent(laptopDb.db, own.id)?.projectId).not.toBeNull();

    updateAgent(recordDb.db, own.id, { projectId: null });
    publishSectionCommand(recordDb.db, { section: "agents", pipelineId: null, versionNumber: null });
    await laptop.record.sync();

    // A machine meeting the agent for the first time, after the change.
    const freshDb = openMigratedTestDb();
    const fresh = desktop(freshDb, issueDevice(recordDb.db, { personId: annaPersonId, name: "anna-new", tokenHash: "h3", secretsKeyHash: null }).id);
    setSetting(freshDb.db, MANAGED_PERSON_ID_KEY, annaPersonId);
    try {
      await fresh.record.sync();
      expect(getAgent(freshDb.db, own.id)?.projectId).toBeNull();
      expect(getAgent(laptopDb.db, own.id)?.projectId).toBeNull();
    } finally {
      fresh.record.stop();
      freshDb.close();
    }
  });

  it("waits for its project rather than landing as a global agent", () => {
    const support = createProject(recordDb.db, { name: "Support", keyPrefix: "SUP" });
    const agent = {
      id: "01a15295-0000-7000-8000-00000000a9e1",
      projectId: support.id,
      name: "Support implementer",
      role: "implementer",
      instructions: "Implement.",
      config: {},
      enabled: true,
      archivedAt: null,
      deletedAt: null,
      recommendedProvider: "claude",
      recommendedModel: null,
      mcpServerIds: [],
      skillIds: [],
      revision: 0,
      updatedAt: 1,
    };
    const before = listAgents(laptopDb.db).length;

    expect(upsertReplicaProjectAgent(laptopDb.db, agent)).toBe("waiting");
    expect(listAgents(laptopDb.db)).toHaveLength(before);
    // And a system agent is never a project's, whatever arrives.
    expect(upsertReplicaProjectAgent(recordDb.db, { ...agent, role: "system" })).toBe("refused");
    expect(getAgent(recordDb.db, agent.id as Uuid)).toBeUndefined();
  });
});

/**
 * The same, read one row a page (EO-476, review).
 *
 * Every list on `record:changes` pages on a cursor of its own, so with a
 * page of one the order things arrive in is the order of each list, not
 * the order they depend on each other in. These are the two dependencies
 * that cross lists: a publication and the agents it makes apply, and a
 * run and the agent it names.
 */
describe("a record-held project's agents on a replica reading one row a page (EO-476)", () => {
  beforeEach(() => {
    laptop.record.stop();
    laptop = desktop(laptopDb, laptop.deviceId, 1);
  });

  /** Pulls until nothing is left, as ticks would — a page of one takes many passes. */
  async function syncedFully(): Promise<void> {
    for (let pass = 0; pass < 20; pass += 1) await laptop.record.sync();
  }

  it("applies the record's current agent once the agents section is published, even when another publication is read first and nothing is edited after", async () => {
    const { support, own } = supportWithItsOwnAgents();
    await move(support.id);
    await syncedFully();

    // Edited on the record while unpublished: the laptop keeps its own
    // copy and reads past the edit.
    updateAgent(recordDb.db, own.id, { instructions: "Latest record instructions." });
    await syncedFully();
    expect(getAgent(laptopDb.db, own.id)?.instructions).toBe("Implement in the support team's voice.");

    // Another section published first, older on the publications list,
    // so the stamped agent is read before the agents publication is.
    publishSectionCommand(recordDb.db, { section: "connectors", pipelineId: null, versionNumber: null });
    recordDb.db.run(sql`update published_sections set published_at = 1 where section = 'connectors'`);
    publishSectionCommand(recordDb.db, { section: "agents", pipelineId: null, versionNumber: null });
    await syncedFully();

    expect(getAgent(laptopDb.db, own.id)?.instructions).toBe("Latest record instructions.");
  });

  it("names a run's agent when the agent arrives on a later page than the run", async () => {
    const { support, item } = supportWithItsOwnAgents();
    await move(support.id);
    await syncedFully();

    createAgent(recordDb.db, { name: "Earlier agent", role: "writer", provider: "fake", instructions: "Write.", projectId: support.id });
    const later = createAgent(recordDb.db, { name: "Later agent", role: "implementer", provider: "fake", instructions: "Implement.", projectId: support.id });
    // Last on the agents list, so the run is read first.
    recordDb.db.run(sql`update agents set updated_at = 9999999999999 where id = ${later.id}`);
    const run = createRun(recordDb.db, { itemId: item.id, agentId: later.id, action: "implement", stepId: "todo" });
    updateRun(recordDb.db, run.id, { status: "succeeded", endedAt: 3 });
    await syncedFully();

    expect(getAgent(laptopDb.db, later.id)).toBeDefined();
    expect(laptopDb.db.get<{ agentId: string | null }>(sql`select agent_id as agentId from runs where id = ${run.id}`)?.agentId).toBe(later.id);
  });

  it("names a run's global agent when a later publication brings it, and leaves the run readable until then", async () => {
    const { support, item } = supportWithItsOwnAgents();
    await move(support.id);
    await syncedFully();

    const global = createAgent(recordDb.db, { name: "Organisation reviewer", role: "reviewer", provider: "fake", instructions: "Review." });
    const run = createRun(recordDb.db, { itemId: item.id, agentId: global.id, action: "review", stepId: "todo" });
    updateRun(recordDb.db, run.id, { status: "succeeded", endedAt: 3 });
    await syncedFully();

    // Nobody has published it, so it may never arrive: the run is here
    // all the same, as nobody's.
    const agentOf = (): string | null | undefined => laptopDb.db.get<{ agentId: string | null }>(sql`select agent_id as agentId from runs where id = ${run.id}`)?.agentId;
    expect(agentOf()).toBeNull();

    publishSectionCommand(recordDb.db, { section: "agents", pipelineId: null, versionNumber: null });
    await syncedFully();
    expect(agentOf()).toBe(global.id);
  });

  it("does not let a held project copy undo the publication that made the agent global (review)", async () => {
    const { support, own } = supportWithItsOwnAgents();
    await move(support.id);
    await syncedFully();

    // Held while unpublished…
    updateAgent(recordDb.db, own.id, { instructions: "Unpublished change" });
    await syncedFully();
    // …and then made global and published. The held copy is older than
    // the publication, and must not be written over it on the next retry.
    updateAgent(recordDb.db, own.id, { projectId: null, instructions: "Now global" });
    publishSectionCommand(recordDb.db, { section: "agents", pipelineId: null, versionNumber: null });
    await syncedFully();

    expect(getAgent(laptopDb.db, own.id)).toMatchObject({ projectId: null, instructions: "Now global" });
  });

  it("does not let a publication read late undo a newer project copy of the same agent (review)", async () => {
    const { support } = supportWithItsOwnAgents();
    await move(support.id);
    const roving = createAgent(recordDb.db, { name: "Roving writer", role: "writer", provider: "fake", instructions: "Global, then the project's." });
    // Two older publications ahead of the agents one, so the publications
    // list reaches it last…
    publishSectionCommand(recordDb.db, { section: "connectors", pipelineId: null, versionNumber: null });
    recordDb.db.run(sql`update published_sections set published_at = 1 where section = 'connectors'`);
    publishSectionCommand(recordDb.db, { section: "packs", pipelineId: null, versionNumber: null });
    recordDb.db.run(sql`update published_sections set published_at = 2 where section = 'packs'`);
    publishSectionCommand(recordDb.db, { section: "agents", pipelineId: null, versionNumber: null });
    const publishedAt = recordDb.db.get<{ at: number }>(sql`select published_at as at from published_sections where section = 'agents'`)!.at;
    // …and the agent put on the project after it, first on the agents list.
    updateAgent(recordDb.db, roving.id, { projectId: support.id, instructions: "The project's now." });
    recordDb.db.run(sql`update agents set updated_at = ${publishedAt + 5} where id = ${roving.id}`);
    recordDb.db.run(sql`update agents set updated_at = ${publishedAt + 1000} where project_id = ${support.id} and id <> ${roving.id}`);

    await syncedFully();

    expect(getAgent(laptopDb.db, roving.id)).toMatchObject({ projectId: support.id, instructions: "The project's now." });
  });

  it("attaches a skill that arrives on a later page than the project agent it belongs to, with no edit after (review)", async () => {
    const { support } = supportWithItsOwnAgents();
    await move(support.id);
    publishSectionCommand(recordDb.db, { section: "agents", pipelineId: null, versionNumber: null });
    await syncedFully();

    const saved = saveSkill(recordDb.db, SkillDraftSchema.parse({ name: "Later skill", description: "Arrives with packs.", body: "Later." }));
    if (!saved.ok) throw new Error(saved.problems.join("\n"));
    const own = createAgent(recordDb.db, { name: "New writer", role: "writer", provider: "fake", instructions: "Write.", projectId: support.id });
    expect(setAgentAttachment(recordDb.db, { agentId: own.id, kind: "skill", id: saved.skill.id, attached: true }).ok).toBe(true);
    // The skill comes with the packs publication, behind another one, so
    // the agent is read first.
    publishSectionCommand(recordDb.db, { section: "connectors", pipelineId: null, versionNumber: null });
    recordDb.db.run(sql`update published_sections set published_at = ${Date.now() + 10} where section = 'connectors'`);
    publishSectionCommand(recordDb.db, { section: "packs", pipelineId: null, versionNumber: null });
    recordDb.db.run(sql`update published_sections set published_at = ${Date.now() + 20} where section = 'packs'`);
    await syncedFully();

    expect(getSkill(laptopDb.db, saved.skill.id)).toBeDefined();
    expect(getAgentAttachments(laptopDb.db, own.id).skillIds).toContain(saved.skill.id);
  });

  it("orders a publication and a scope change made in the same millisecond by revision, not by the clock (review)", async () => {
    // A project with no agents of its own yet, so the one moved onto it
    // is first on the agents list.
    const support = createProject(annaDb.db, { name: "Support", keyPrefix: "SUP", managed: false });
    expect(await move(support.id)).toEqual({});
    const roving = createAgent(recordDb.db, { name: "Roving writer", role: "writer", provider: "fake", instructions: "Global" });
    // Two older publications ahead of the agents one, so the project copy
    // is read before the publication it supersedes.
    publishSectionCommand(recordDb.db, { section: "connectors", pipelineId: null, versionNumber: null });
    recordDb.db.run(sql`update published_sections set published_at = 1 where section = 'connectors'`);
    publishSectionCommand(recordDb.db, { section: "packs", pipelineId: null, versionNumber: null });
    recordDb.db.run(sql`update published_sections set published_at = 2 where section = 'packs'`);
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 100);
    try {
      publishSectionCommand(recordDb.db, { section: "agents", pipelineId: null, versionNumber: null });
      updateAgent(recordDb.db, roving.id, { projectId: support.id, instructions: "Project now" });
    } finally {
      clock.mockRestore();
    }

    await syncedFully();

    expect(getAgent(laptopDb.db, roving.id)).toMatchObject({ projectId: support.id, instructions: "Project now" });
  });

  it("still repairs a later agent's skill behind two hundred agents waiting on a server that never comes (review)", async () => {
    laptop.record.stop();
    laptop = desktop(laptopDb, laptop.deviceId, 500);
    const { support } = supportWithItsOwnAgents();
    await move(support.id);
    publishSectionCommand(recordDb.db, { section: "agents", pipelineId: null, versionNumber: null });
    await laptop.record.sync();
    const unpublished = saveMcpServer(recordDb.db, McpServerDraftSchema.parse({ name: "never-published", transport: "stdio", command: "missing-mcp" }));
    if (!unpublished.ok) throw new Error("the server did not save");
    for (let index = 0; index < 200; index += 1) {
      const waiting = createAgent(recordDb.db, { name: `Waiting ${String(index)}`, role: "writer", provider: "fake", instructions: "Write.", projectId: support.id });
      setAgentAttachment(recordDb.db, { agentId: waiting.id, kind: "mcpServer", id: unpublished.server.id, attached: true });
    }
    await laptop.record.sync();
    const later = saveSkill(recordDb.db, SkillDraftSchema.parse({ name: "Available later", description: "Comes with packs.", body: "Later." }));
    if (!later.ok) throw new Error(later.problems.join("\n"));
    const writer = createAgent(recordDb.db, { name: "Later writer", role: "writer", provider: "fake", instructions: "Write.", projectId: support.id });
    setAgentAttachment(recordDb.db, { agentId: writer.id, kind: "skill", id: later.skill.id, attached: true });
    await laptop.record.sync();

    publishSectionCommand(recordDb.db, { section: "packs", pipelineId: null, versionNumber: null });
    for (let pass = 0; pass < 5; pass += 1) await laptop.record.sync();

    expect(getAgentAttachments(laptopDb.db, writer.id).skillIds).toContain(later.skill.id);
  });

  it("does not re-attach a tool a person took off here while the agents section is unpublished (review)", async () => {
    laptop.record.stop();
    laptop = desktop(laptopDb, laptop.deviceId, 500);
    const { support, skillId } = supportWithItsOwnAgents();
    await move(support.id);
    await laptop.record.sync();
    const later = saveMcpServer(recordDb.db, McpServerDraftSchema.parse({ name: "not-yet-published", transport: "stdio", command: "later-mcp" }));
    if (!later.ok) throw new Error("the server did not save");
    const writer = createAgent(recordDb.db, { name: "Editable writer", role: "writer", provider: "fake", instructions: "Write.", projectId: support.id });
    setAgentAttachment(recordDb.db, { agentId: writer.id, kind: "skill", id: skillId, attached: true });
    setAgentAttachment(recordDb.db, { agentId: writer.id, kind: "mcpServer", id: later.server.id, attached: true });
    await laptop.record.sync();
    expect(getAgentAttachments(laptopDb.db, writer.id).skillIds).toContain(skillId);

    expect(setAgentAttachment(laptopDb.db, { agentId: writer.id, kind: "skill", id: skillId, attached: false }).ok).toBe(true);
    await laptop.record.sync();
    await laptop.record.sync();

    expect(getAgentAttachments(laptopDb.db, writer.id).skillIds).not.toContain(skillId);
  });
});
