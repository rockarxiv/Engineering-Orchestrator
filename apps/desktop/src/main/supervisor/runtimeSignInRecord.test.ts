import { type Agent, type AgentProvider, type IpcChannel, type IpcPayload, type IpcResponse, type IpcResult, type Item, type Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { issueDevice } from "../db/repos/devicesRepo.js";
import { createStep, listAgents, listRunsForItem, updateAgent } from "../db/repos/index.js";
import { createPerson } from "../db/repos/peopleRepo.js";
import { agentOfKind, createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { createFakeProvider } from "../providers/fake.js";
import { validImplementResult } from "../providers/fixtures.js";
import { createDeviceRecord, type DeviceRecord } from "../record/deviceRecord.js";
import { createLocalRecord, type LocalItemRecord } from "../record/localRecord.js";
import { serveApply, serveChanges, serveRelease, serveRenew, serveWork, type ServeRecordContext } from "../record/serveRecord.js";
import type { RecordTransport } from "../record/syncStatus.js";
import type { RuntimeAuthCheck } from "../runtimes/auth.js";
import { createRunSupervisor, type RunSupervisor } from "./runSupervisor.js";

/**
 * A runtime blocked on a desktop whose work an organisation's record
 * schedules (EO-796).
 *
 * The record runs the only scheduler, so the desktop's own tick input
 * never reaches the pick: what the desktop cannot run has to travel with
 * its `record:work` ask, or the record goes on leasing it the blocked
 * item and the desktop's one slot is spent standing down from it.
 *
 * Three machines in one process — the record, and two desktops linked to
 * it — through the same `serve*` functions the server's door uses, with
 * the record's own supervisor answering `record:work` as the server's
 * engine does.
 */

const LIMITS = { globalConcurrency: 1, perAgentConcurrency: 1, perRepositoryConcurrency: 1 };

let recordDb: DbHandle;
let theRecord: LocalItemRecord;
let recordSupervisor: RunSupervisor;
let serving: ServeRecordContext;
let anna: Desktop;
let dana: Desktop;
/** Every offer the record made, by device, in order. */
const offered = new Map<string, string[]>();

interface Desktop {
  handle: DbHandle;
  record: DeviceRecord;
  deviceId: string;
  supervisor: RunSupervisor;
  started: string[];
}

/**
 * Codex for the implementer and Claude for the reviewer, on whichever
 * machine, and a step the reviewer drafts at, by the same id everywhere:
 * Claude's work without a review's need for criteria.
 */
function backends(handle: DbHandle): void {
  const agents = listAgents(handle.db);
  updateAgent(handle.db, agents.find((agent) => agent.role === "implementer")!.id, { provider: "codex" });
  updateAgent(handle.db, agents.find((agent) => agent.role === "reviewer")!.id, { provider: "claude" });
  createStep(handle.db, { id: "draft", pipelineId: "default" as Uuid, position: 25, name: "Draft", type: "agent", agentId: agentOfKind(handle.db, "reviewer"), entryAction: "implement" });
}

function deviceFor(name: string, machine: string): string {
  const person = createPerson(recordDb.db, { name, email: `${name.toLowerCase()}@example.com` });
  return issueDevice(recordDb.db, { personId: person.id, name: machine, tokenHash: `hash-of-${machine}`, secretsKeyHash: null }).id;
}

function transport(deviceId: string): RecordTransport {
  return {
    async request<K extends IpcChannel>(channel: K, payload: IpcPayload<K>): Promise<IpcResult<IpcResponse<K>>> {
      // Stamped at the server's door with the device the credential is for.
      const stamped = { ...(payload as object), deviceId };
      const answer = await (async (): Promise<unknown> => {
        switch (channel) {
          case "record:work": {
            const work = await serveWork(serving, stamped as IpcPayload<"record:work">);
            offered.set(deviceId, [...(offered.get(deviceId) ?? []), ...work.offers.map((offer) => offer.itemId)]);
            return work;
          }
          case "record:renew":
            return serveRenew(serving, stamped as IpcPayload<"record:renew">);
          case "record:release":
            return serveRelease(serving, stamped as IpcPayload<"record:release">);
          case "record:apply":
            return serveApply(serving, stamped as IpcPayload<"record:apply">);
          case "record:changes":
            return serveChanges(serving, payload as IpcPayload<"record:changes">);
          default:
            return null;
        }
      })();
      return answer === null ? { ok: false, error: { message: `EO has no channel called "${channel}".` } } : { ok: true, data: answer as IpcResponse<K> };
    },
  };
}

/** A desktop on which Claude is signed out, or not. */
function desktop(name: string, machine: string, claudeSignedOut: boolean): Desktop {
  const handle = openMigratedTestDb();
  backends(handle);
  const deviceId = deviceFor(name, machine);
  const record = createDeviceRecord({ db: handle.db, deviceId: () => deviceId, transport: () => transport(deviceId), pullPageSize: 500 });
  const started: string[] = [];
  const inner = createFakeProvider({ result: validImplementResult });
  const provider = (agent: Agent): AgentProvider => ({
    start: (opts) => {
      started.push(agent.name);
      return inner.start(opts);
    },
    resume: inner.resume.bind(inner),
  });
  const checkAuth = async (agent: Agent): Promise<RuntimeAuthCheck> =>
    claudeSignedOut && agent.provider === "claude"
      ? { ok: false, reason: "Claude Code is not signed in.", signedOut: { runtime: "claude", executablePath: "/opt/eo/claude" } }
      : { ok: true };
  const supervisor = createRunSupervisor({ db: handle.db, record, deviceId, limits: LIMITS, provider, checkAuth });
  return { handle, record, deviceId, supervisor, started };
}

beforeEach(() => {
  offered.clear();
  recordDb = openMigratedTestDb();
  backends(recordDb);
  theRecord = createLocalRecord(recordDb.db);
  // The server: the record, with an engine that dispatches nothing itself
  // and answers `record:work` for the desktops.
  recordSupervisor = createRunSupervisor({
    db: recordDb.db,
    record: theRecord,
    dispatches: false,
    limits: LIMITS,
    provider: { start: () => { throw new Error("the record runs nothing"); } } as never,
  });
  serving = { db: recordDb.db, record: theRecord, offerWork: recordSupervisor.offerWork };
  anna = desktop("Anna", "anna-laptop", true);
  dana = desktop("Dana", "dana-desktop", false);
});

afterEach(() => {
  anna.record.stop();
  dana.record.stop();
  anna.handle.close();
  dana.handle.close();
  recordDb.close();
});

/** Work for Claude: the reviewer, drafting. First in line on the record. */
const forClaude = (title: string): Item => createTestItem(recordDb.db, { type: "story", title, stepId: "draft", priority: 5 });
/** Work for Codex: the implementer. */
const forCodex = (title: string): Item => createTestItem(recordDb.db, { type: "story", title, stepId: "todo" });

describe("a runtime blocked on a desktop the organisation's record schedules", () => {
  it("is sent with the desktop's ask, so the record leases it the Codex item and not the blocked Claude ones", async () => {
    // First in line on the record: two Claude items, more urgent and older.
    const held = [forClaude("One"), forClaude("Two")];
    const codex = forCodex("Codex's");
    await anna.record.sync();

    for (let pass = 0; pass < 4; pass++) {
      await anna.supervisor.runOnce();
      await anna.record.sync();
    }

    // One Claude item meets the probe, which blocks Claude on Anna's
    // laptop; after that the record offers her none.
    const offers = offered.get(anna.deviceId) ?? [];
    const claudeOffers = offers.filter((itemId) => held.some((item) => item.id === itemId));
    expect(claudeOffers).toHaveLength(1);
    expect(offers).toContain(codex.id);
    expect(anna.started).toEqual(["Implementer"]);
    expect(listRunsForItem(recordDb.db, codex.id)).not.toEqual([]);
    for (const item of held) expect(listRunsForItem(recordDb.db, item.id)).toEqual([]);
  });

  it("is this desktop's alone: another desktop, signed in, is still leased the Claude items", async () => {
    const held = forClaude("One");
    await anna.record.sync();
    await dana.record.sync();
    await anna.supervisor.runOnce();
    await anna.record.sync();
    expect(anna.started).toEqual([]);

    await dana.record.sync();
    await dana.supervisor.runOnce();

    expect(dana.started).toEqual(["Reviewer"]);
    await dana.record.sync();
    expect(listRunsForItem(recordDb.db, held.id)).not.toEqual([]);
  });
});
