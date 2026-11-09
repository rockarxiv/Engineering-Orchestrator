import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LOCAL_PERSON_ID, RecordPipelineSchema, withDeviceIdentity, type EntryRule, type IpcChannel, type IpcPayload, type IpcResponse, type IpcResult, type Item, type Uuid } from "@eo/core";
import { buildTickInput } from "../supervisor/buildTickInput.js";
import type { DbHandle } from "../db/client.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { deleteItem, getItem, linkJiraKey, updateItem } from "../db/repos/itemsRepo.js";
import {
  getComment,
  listCommentsForItem,
  listMentionsForComment,
  openMentionsForHuman,
  setCommentPinned,
} from "../db/repos/commentsRepo.js";
import { listTransitionsForItem } from "../db/repos/transitionsRepo.js";
import { listRunEvents } from "../db/repos/runEventsRepo.js";
import { items as itemsTable, pipelines, pipelineSteps, runEvents, runs as runsTable } from "../db/schema.js";
import { asc, eq } from "drizzle-orm";
import { createRun, getRun, runsNeedingSync, updateRun } from "../db/repos/runsRepo.js";
import { grantLease } from "../db/repos/leasesRepo.js";
import { createPerson, updatePerson } from "../db/repos/peopleRepo.js";
import { createAgent, listAgents, updateAgent } from "../db/repos/agentsRepo.js";
import { pendingPushesForItem } from "../db/repos/outboxRepo.js";
import { pendingCount } from "../db/repos/recordPendingRepo.js";
import { setSetting } from "../db/repos/settingsRepo.js";
import { bridgePushChannels } from "../ipc/push.js";
import { getDevice, issueDevice } from "../db/repos/devicesRepo.js";
import { assignItem, claimItem, decideItem, moveItem, moveItemToVersion, takeOverItem, updateItemText } from "../ipc/domainCommands.js";
import { itemAuthorityCommand } from "../ipc/identityCommands.js";
import { saveGroup } from "../db/repos/groupsRepo.js";
import { getPipeline, listRoutesForPipeline, replacePipelineGraph, setStepOwner } from "../db/repos/pipelineStepsRepo.js";
import { listPipelinesUpdatedSince, upsertReplicaPipeline } from "../db/repos/projectMoveRepo.js";
import { MANAGED_PERSON_ID_KEY, MANAGED_PERSON_NAME_KEY } from "../identity/viewer.js";
import { createRunEventBuffer } from "../db/repos/runEventBuffer.js";
import { addItemAttachments, listAttachmentsForComment, listItemAttachments, removeItemAttachment } from "../db/repos/attachmentsRepo.js";
import { AttachmentStorage } from "../attachments/storage.js";
import { forgetCommands, itemsWithQueuedMoves, pendingCommands, queuedCommandCount } from "../db/repos/recordCommandsRepo.js";
import { createLocalRecord, type LocalItemRecord } from "./localRecord.js";
import { createDeviceRecord, type DeviceRecord } from "./deviceRecord.js";
import {
  serveApply,
  serveAttachment,
  serveChanges,
  serveRelease,
  serveRenew,
  serveWork,
  type ServeRecordContext,
} from "./serveRecord.js";
import { syncStatus, type RecordTransport } from "./syncStatus.js";
import {
  createStep,
  boundGraphForItem,
  currentVersion,
  listMcpServers,
  listModules,
  listPipelineVersions,
  listPublishedSections,
  listSkills,
  listStepsForPipeline,
  saveMcpServer,
  saveModule,
  saveSkill,
} from "../db/repos/index.js";
import { listPipelineStepViews } from "../ipc/domainQueries.js";
import { savePipeline, setAgentBinding } from "../ipc/configCommands.js";
import { moveStepItemsCommand } from "../ipc/pipelineCommands.js";
import { publishPreflightCommand, publishSectionCommand } from "../ipc/sectionCommands.js";
import { sectionLockFor } from "../managed/locks.js";

/**
 * Two desktops, one record (EO-324,
 * `ARCHITECTURE.md`, "The record").
 *
 * Three databases in one process: the record, and a device on each side
 * of it. Every request goes through the same `serve*` functions
 * `server/http.ts` puts behind its door, so what is exercised here is
 * the record contract and not a stub of it — what the transport does
 * *not* carry is a socket, which is `server/smoke.test.ts`'s subject
 * and is deliberately not re-tested here.
 *
 * Each device is switched between online and offline by one line —
 * `anna.online = false` — because that is what the design is about, and a
 * test that had to tear down a server to say it would say it once.
 */

const LIMITS = { globalConcurrency: 1, perAgentConcurrency: 1, perRepositoryConcurrency: 1 };

let recordDb: DbHandle;
let annaDb: DbHandle;
let danaDb: DbHandle;
let theRecord: LocalItemRecord;
let serving: ServeRecordContext;
let anna: Desktop;
let dana: Desktop;
/** Every temporary attachment directory this file made, removed at the end of each test. */
const directories: string[] = [];

/** A store of its own per machine, because a file on one is not a file on another. */
function ownFiles(): AttachmentStorage {
  const root = mkdtempSync(join(tmpdir(), "eo-record-files-"));
  directories.push(root);
  return new AttachmentStorage(root);
}

/** A desktop: its own database, its own record, and a switch for the network. */
interface Desktop {
  handle: DbHandle;
  record: DeviceRecord;
  /** Where this machine keeps its files. */
  files: AttachmentStorage;
  /** Set false to take this machine off the network without telling it. */
  online: boolean;
  /**
   * Set true to let the next request reach the record and lose its
   * answer on the way back.
   *
   * The failure a retry has to survive, and the one an on/off switch
   * cannot produce: the record *did* the thing, and this device has no
   * idea. It is how a socket dropping mid-reply looks from here.
   */
  swallowNextAnswer: boolean;
  /**
   * Set true to let this machine read everything except the bytes of a
   * file.
   *
   * The failure the durable want-list exists for, and one an on/off
   * switch cannot produce: the metadata arrives and its cursor moves
   * past it, and *then* the download does not happen.
   */
  refuseAttachments: boolean;
  deviceId: string;
}

/**
 * Three rows a page.
 *
 * Small enough that a dozen items reach the second page, which is what
 * makes the catch-up test below a test of paging rather than a
 * demonstration that one page works.
 */
const PULL_PAGE = 3;

/** Every cursor at its beginning — what a desktop that has read nothing sends. */
const EMPTY_CURSORS = {
  items: { ts: 0, id: "" },
  transitions: { ts: 0, id: "" },
  comments: { ts: 0, id: "" },
  runs: { ts: 0, id: "" },
  runEvents: { ts: 0, runId: "", seq: -1 },
  attachments: { ts: 0, id: "" },
  pins: { ts: 0, id: "" },
};

beforeEach(() => {
  recordDb = openMigratedTestDb();
  annaDb = openMigratedTestDb();
  danaDb = openMigratedTestDb();
  theRecord = createLocalRecord(recordDb.db);
  serving = {
    db: recordDb.db,
    record: theRecord,
    attachments: ownFiles(),
    // The record's own scheduler, which on a server is the engine's.
    // Here it is the same composition by hand: one tick input built
    // from the record's tables, and never from a device's.
    offerWork: (deviceId, capacity) =>
      theRecord.offerWork({ deviceId, capacity, tickInput: buildTickInput(recordDb.db, LIMITS, false) }),
  };
  // Two people on the organisation's list, each with a machine (EO-323).
  // The record needs them to say *whose* move won: `transitions.actor`
  // holds `human`, and a sentence naming "human's move" would tell
  // nobody anything.
  anna = desktop(annaDb, deviceFor("Anna", "anna@example.com", "anna-laptop"));
  dana = desktop(danaDb, deviceFor("Dana", "dana@example.com", "dana-desktop"));
});

/** A person and their machine on the record, answering with the device's own id. */
function deviceFor(name: string, email: string, machine: string): string {
  const person = createPerson(recordDb.db, { name, email });
  return issueDevice(recordDb.db, { personId: person.id, name: machine, tokenHash: `hash-of-${machine}`, secretsKeyHash: null }).id;
}

/** Which device wrote each line of a run's transcript, as the record has it. */
function runEventAuthors(runId: string): (string | null)[] {
  return recordDb.db
    .select({ deviceId: runEvents.deviceId })
    .from(runEvents)
    .where(eq(runEvents.runId, runId))
    .orderBy(asc(runEvents.seq))
    .all()
    .map((row) => row.deviceId);
}

afterEach(() => {
  // The subscriptions first: they are keyed on the database, and a
  // suite that left them attached would queue every later test's moves
  // through a record that is closing.
  anna.record.stop();
  dana.record.stop();
  recordDb.close();
  annaDb.close();
  danaDb.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function desktop(handle: DbHandle, deviceId: string): Desktop {
  const machine: Desktop = {
    handle,
    online: true,
    swallowNextAnswer: false,
    refuseAttachments: false,
    deviceId,
    files: ownFiles(),
    record: undefined as unknown as DeviceRecord,
  };
  machine.record = createDeviceRecord({
    db: handle.db,
    deviceId: () => deviceId,
    attachments: machine.files,
    // A signed-in desktop always *has* a transport; what changes when
    // the network goes is what that transport answers. Conflating the
    // two would be testing a signed-out desktop, which schedules for
    // itself and is a different story entirely.
    transport: transportFor(machine),
    pullPageSize: PULL_PAGE,
  });
  return machine;
}

/**
 * The record contract, straight into the record's database.
 *
 * What `managed/serverClient.ts` is in production, minus HTTP. The
 * sentence it writes for a failure is copied exactly — `remoteRecord`
 * reads "EO could not reach" to tell an outage from a refusal, and a
 * test whose failures said something else would be testing a different
 * code path than the one that runs.
 */
function transportFor(machine: Desktop): () => RecordTransport {
  const transport: RecordTransport = {
    async request<K extends IpcChannel>(channel: K, payload: IpcPayload<K>): Promise<IpcResult<IpcResponse<K>>> {
      // The sentence `managed/serverClient.ts` writes for a socket that
      // never opened, copied exactly: `remoteRecord` reads "EO could not
      // reach" to tell an outage from a refusal, and a test whose
      // failures said something else would exercise a different branch
      // than the one that runs.
      if (!machine.online) return { ok: false, error: { message: "EO could not reach https://eo.example: fetch failed" } };
      if (machine.refuseAttachments && channel === "record:attachment") {
        return { ok: false, error: { message: "EO could not reach https://eo.example: socket hang up" } };
      }
      const answer = await answerOnTheRecord(channel, payload);
      if (machine.swallowNextAnswer) {
        // Served, and then the socket drops on the way back. The record
        // has done it; this device is about to be told nothing.
        machine.swallowNextAnswer = false;
        return { ok: false, error: { message: "EO could not reach https://eo.example: socket hang up" } };
      }
      return answer === null
        ? { ok: false, error: { message: `EO has no channel called "${channel}".` } }
        : { ok: true, data: answer as IpcResponse<K> };
    },
  };
  return () => transport;
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
    case "record:attachment":
      return serveAttachment(serving, payload as IpcPayload<"record:attachment">);
    default:
      return null;
  }
}

/** Waits for something a subscription does on its own schedule, or gives up loudly. */
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** An item on the record, which is where every item in managed mode is born. */
function onTheRecord(title = "A story"): Item {
  return createTestItem(recordDb.db, { type: "story", title, stepId: "todo" });
}

/** What this desktop has for that item, once it has caught up. */
function seenBy(machine: Desktop, itemId: string): Item | undefined {
  return getItem(machine.handle.db, itemId as Uuid);
}

// ── Work no cap holds back (EO-616) ──────────────────────────────────

describe("a signed-in desktop with no capacity left", () => {
  it("still asks the record, which offers it work no cap holds back, and a process that can run nothing does not ask", async () => {
    const onEveryMachine = { id: "ask", pipelineId: "default" as never, position: -1, name: "Intake", type: "agent" as const, ownerRole: "system", entryAction: "intake" };
    createStep(recordDb.db, onEveryMachine);
    createStep(annaDb.db, onEveryMachine);
    const own = createTestItem(recordDb.db, { type: "feature", title: "The system agent's", stepId: "ask" });
    onTheRecord();
    serving.offerWork = (deviceId, capacity) =>
      theRecord.offerWork({ deviceId, capacity, tickInput: buildTickInput(recordDb.db, LIMITS, false, {}, Date.now(), Number.POSITIVE_INFINITY, null, false, new Set(), new Set(["system"])) });
    await anna.record.sync();
    const tickInput = buildTickInput(annaDb.db, LIMITS, false);

    expect(await anna.record.offerWork({ deviceId: anna.deviceId, capacity: null, tickInput })).toEqual([]);
    expect(theRecord.leaseFor(own.id)).toBeNull();

    const offers = await anna.record.offerWork({ deviceId: anna.deviceId, capacity: 0, tickInput });
    expect(offers.map((offer) => offer.dispatch.item.id)).toEqual([own.id]);
    expect(theRecord.leaseFor(own.id)?.deviceId).toBe(anna.deviceId);
  });
});

// ── The first acceptance criterion ───────────────────────────────────

describe("two desktops signed in to one record", () => {
  it("see the same board", async () => {
    const item = onTheRecord("Rate limiting");

    await anna.record.sync();
    await dana.record.sync();

    expect(seenBy(anna, item.id)?.title).toBe("Rate limiting");
    expect(seenBy(dana, item.id)?.title).toBe("Rate limiting");
    expect(seenBy(anna, item.id)?.stepId).toBe("todo");
    expect(seenBy(dana, item.id)?.stepId).toBe("todo");
  });

  it("show a move made on one of them on the other", async () => {
    const item = onTheRecord();
    await anna.record.sync();
    await dana.record.sync();

    // Anna drags the card. The move is applied to her replica at once —
    // she is not made to wait on a network — and queued for the record.
    anna.record.applyTransition({ itemId: item.id, toStepId: "review", actor: "human" });
    expect(seenBy(anna, item.id)?.stepId).toBe("review");

    await anna.record.sync();
    await dana.record.sync();

    expect(getItem(recordDb.db, item.id)?.stepId).toBe("review");
    expect(seenBy(dana, item.id)?.stepId).toBe("review");
    // And it arrived as a *move*, with the audit row the record wrote —
    // not as an item that quietly has a different column now.
    expect(listTransitionsForItem(danaDb.db, item.id).map((move) => move.toStepId)).toEqual(["review"]);
  });

  it("carry what was said on one of them to the other", async () => {
    const item = onTheRecord();
    await anna.record.sync();
    await dana.record.sync();

    anna.record.postComment({ itemId: item.id, author: { type: "human" }, body: "The Q3 number is wrong." });

    await anna.record.sync();
    await dana.record.sync();

    expect(listCommentsForItem(danaDb.db, item.id).map((comment) => comment.body)).toContain("The Q3 number is wrong.");
  });

  it("do not double a comment when the queue is replayed twice", async () => {
    const item = onTheRecord();
    await anna.record.sync();
    anna.record.postComment({ itemId: item.id, author: { type: "human" }, body: "Said once." });

    await anna.record.sync();
    // A second pass, and a third: the record has already seen this and
    // the id is what says so.
    await anna.record.sync();
    await dana.record.sync();
    await dana.record.sync();

    const said = (handle: DbHandle): number =>
      listCommentsForItem(handle.db, item.id).filter((comment) => comment.body === "Said once.").length;
    expect([said(recordDb), said(annaDb), said(danaDb)]).toEqual([1, 1, 1]);
  });

  it("run one dispatch at a time across both, on whichever device claimed it", async () => {
    const item = onTheRecord();
    await anna.record.sync();
    await dana.record.sync();

    // Both machines ask at once, which is the case a lease exists for.
    const [forAnna, forDana] = await Promise.all([
      anna.record.offerWork({ deviceId: anna.deviceId, capacity: 1, tickInput: buildTickInput(annaDb.db, LIMITS, false) }),
      dana.record.offerWork({ deviceId: dana.deviceId, capacity: 1, tickInput: buildTickInput(danaDb.db, LIMITS, false) }),
    ]);

    const offers = [...forAnna, ...forDana];
    expect(offers).toHaveLength(1);
    expect(offers[0]?.dispatch.item.id).toBe(item.id);
    // And the claim names the machine that got it, which is the only
    // thing that tells the record which laptop went quiet later.
    expect(theRecord.leaseFor(item.id)?.deviceId).toBe(offers[0]?.lease.deviceId);

    // The one that lost is told nothing and has written nothing: losing
    // a race is not an event.
    const loser = forAnna.length === 0 ? anna : dana;
    expect(listCommentsForItem(loser.handle.db, item.id)).toEqual([]);
  });

  it("offers the item again once the claim is given back", async () => {
    const item = onTheRecord();
    // Both replicas first: an offer names ids, and a device that has
    // not caught up cannot resolve one — which is deliberate, and is
    // asserted on its own below.
    await anna.record.sync();
    await dana.record.sync();
    const [offer] = await anna.record.offerWork({
      deviceId: anna.deviceId,
      capacity: 1,
      tickInput: buildTickInput(annaDb.db, LIMITS, false),
    });

    await anna.record.releaseLease(offer!.lease);

    const forDana = await dana.record.offerWork({
      deviceId: dana.deviceId,
      capacity: 1,
      tickInput: buildTickInput(danaDb.db, LIMITS, false),
    });
    expect(forDana.map((one) => one.dispatch.item.id)).toEqual([item.id]);
  });
});

// ── The second acceptance criterion ──────────────────────────────────

describe("a desktop that goes offline mid-run", () => {
  it("finishes the run, and its result reaches the record on reconnect with every event in order", async () => {
    const item = onTheRecord();
    await anna.record.sync();

    // The claim is taken while the network is up — a device only ever
    // runs what the record leased it.
    const [offer] = await anna.record.offerWork({
      deviceId: anna.deviceId,
      capacity: 1,
      tickInput: buildTickInput(annaDb.db, LIMITS, false),
    });
    expect(offer).toBeDefined();

    // …and then the network goes, mid-run. The run carries on: the original design's
    // "finish the run you hold, queue the result".
    anna.online = false;
    const run = createRun(annaDb.db, { itemId: item.id, agentId: null, action: "implement", stepId: "todo" });
    const buffer = createRunEventBuffer(annaDb.db);
    for (const line of ["reading the spec", "writing the limiter", "running the tests"]) {
      buffer.append(run.id, "stdout", { text: line });
    }
    buffer.dispose();
    updateRun(annaDb.db, run.id, { status: "succeeded", endedAt: 1_700_000_000_000 });

    // Nothing reached the record while she was away, and the line says
    // so rather than the board looking as though it had.
    const offline = await anna.record.sync();
    expect(offline.offline).toBe(true);
    expect(getRun(recordDb.db, run.id)).toBeUndefined();
    expect(syncStatus(annaDb.db, true).state).toBe("offline");

    anna.online = true;
    await anna.record.sync();

    // The outcome, and the whole transcript, in the order it was
    // written.
    expect(getRun(recordDb.db, run.id)?.status).toBe("succeeded");
    const onTheRecordEvents = listRunEvents(recordDb.db, run.id);
    expect(onTheRecordEvents.map((event) => event.seq)).toEqual(listRunEvents(annaDb.db, run.id).map((event) => event.seq));
    expect(onTheRecordEvents.map((event) => (event.payload as { text: string }).text)).toEqual([
      "reading the spec",
      "writing the limiter",
      "running the tests",
    ]);
    expect(syncStatus(annaDb.db, true).state).toBe("online");
  });

  it("records the device that wrote each line of the transcript", async () => {
    const item = onTheRecord();
    await anna.record.sync();
    const run = createRun(annaDb.db, { itemId: item.id, agentId: null, action: "implement", stepId: "todo" });
    const buffer = createRunEventBuffer(annaDb.db);
    buffer.append(run.id, "stdout", { text: "one line" });
    buffer.dispose();

    await anna.record.sync();

    expect(runEventAuthors(run.id)).toEqual([anna.deviceId]);
  });

  it("sends nothing twice when a pass is repeated", async () => {
    const item = onTheRecord();
    await anna.record.sync();
    const run = createRun(annaDb.db, { itemId: item.id, agentId: null, action: "implement", stepId: "todo" });
    const buffer = createRunEventBuffer(annaDb.db);
    buffer.append(run.id, "stdout", { text: "one line" });
    buffer.dispose();

    await anna.record.sync();
    await anna.record.sync();
    await anna.record.sync();

    expect(listRunEvents(recordDb.db, run.id)).toHaveLength(1);
  });
});

// ── The third acceptance criterion ───────────────────────────────────

describe("an offline move", () => {
  it("applies when nobody else touched the item", async () => {
    const item = onTheRecord();
    await anna.record.sync();

    anna.online = false;
    anna.record.applyTransition({ itemId: item.id, toStepId: "review", actor: "human" });
    // Provisional while it waits: the card is dashed and says *queued*,
    // which is this list.
    expect(itemsWithQueuedMoves(annaDb.db)).toEqual([item.id]);
    expect(syncStatus(annaDb.db, true).queuedItemIds).toEqual([item.id]);

    anna.online = true;
    const drained = await anna.record.sync();

    expect(drained.sent).toBe(1);
    expect(drained.superseded).toBe(0);
    expect(getItem(recordDb.db, item.id)?.stepId).toBe("review");
    // And it stops being provisional, which is the other half of the
    // dashed card meaning anything.
    expect(itemsWithQueuedMoves(annaDb.db)).toEqual([]);
    expect(queuedCommandCount(annaDb.db)).toBe(0);
  });

  it("is dropped with an inbox row when the item had already moved", async () => {
    const item = onTheRecord();
    await anna.record.sync();
    await dana.record.sync();

    // Anna approves while out of touch.
    anna.online = false;
    anna.record.applyTransition({ itemId: item.id, toStepId: "review", actor: "human" });
    expect(seenBy(anna, item.id)?.stepId).toBe("review");

    // Dana, who is not, moves the same card somewhere else first.
    dana.record.applyTransition({ itemId: item.id, toStepId: "ready_to_merge", actor: "human" });
    await dana.record.sync();
    expect(getItem(recordDb.db, item.id)?.stepId).toBe("ready_to_merge");

    anna.online = true;
    const drained = await anna.record.sync();

    // The record won, and Anna's move was dropped rather than applied
    // late over the top of Dana's.
    expect(drained.superseded).toBe(1);
    expect(getItem(recordDb.db, item.id)?.stepId).toBe("ready_to_merge");
    expect(seenBy(anna, item.id)?.stepId).toBe("ready_to_merge");
    expect(itemsWithQueuedMoves(annaDb.db)).toEqual([]);

    // And she was told, in the inbox — which is the query over open
    // human mentions, because there is no inbox table (invariant #4).
    const inbox = openMentionsForHuman(annaDb.db);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.comment.body).toContain(`Your move of ${item.key} was superseded by`);
    expect(inbox[0]?.comment.body).toContain("Dana");
    expect(inbox[0]?.comment.kind).toBe("escalation");

    // Never silently: the move is gone *and* the sentence is there.
    // Dana, who did nothing wrong, hears nothing about it.
    await dana.record.sync();
    expect(openMentionsForHuman(danaDb.db)).toEqual([]);
  });

  it("is dropped with a reason when the record cannot carry it out at all", async () => {
    const item = onTheRecord();
    await anna.record.sync();

    anna.online = false;
    anna.record.postComment({ itemId: item.id, author: { type: "human" }, body: "Still worth saying." });
    // …and while she is away, somebody deletes the item from the record
    // (KAN-30). There is nothing left for her comment to be about.
    deleteItem(recordDb.db, item.id);

    anna.online = true;
    const drained = await anna.record.sync();

    // Refused, said, and dropped — rather than retried forever against a
    // record that has already answered (invariant #8).
    expect(drained.refused).toBe(1);
    expect(queuedCommandCount(annaDb.db)).toBe(0);
    expect(listCommentsForItem(annaDb.db, item.id).map((comment) => comment.body).join("\n")).toContain(
      "would not accept a change EO had waiting",
    );
  });

  it("replays a queue in the order it was made", async () => {
    const item = onTheRecord();
    await anna.record.sync();

    anna.online = false;
    anna.record.postComment({ itemId: item.id, author: { type: "human" }, body: "Correcting the Q3 number first." });
    anna.record.applyTransition({ itemId: item.id, toStepId: "review", actor: "human" });
    anna.record.postComment({ itemId: item.id, author: { type: "human" }, body: "…and then this." });

    anna.online = true;
    await anna.record.sync();

    // The comment written before the move is above it on the record's
    // thread, which is what "replays in order" has to mean: an agent
    // dispatched by that move reads the correction that prompted it.
    const said = listCommentsForItem(recordDb.db, item.id).map((comment) => comment.body);
    expect(said.indexOf("Correcting the Q3 number first.")).toBeLessThan(said.indexOf("…and then this."));
    expect(getItem(recordDb.db, item.id)?.stepId).toBe("review");
  });
});

describe("a desktop catching up after a long absence", () => {
  it("reads every page, and never steps its cursor past a page that was cut short", async () => {
    // Twelve items and twelve comments on the record, read a page at a
    // time. The page size is what makes this a test rather than a
    // demonstration: at three per page, the item list is truncated while
    // the comment list is not, which is exactly the shape that used to
    // let the cursor jump past rows nobody had been sent.
    const items = Array.from({ length: 12 }, (_, at) => onTheRecord(`Story ${at}`));
    for (const item of items) {
      theRecord.postComment({ itemId: item.id, author: { type: "human" }, body: `about ${item.key}` });
    }

    // One pass, paging until the record has nothing more.
    await anna.record.sync();

    for (const item of items) {
      expect(seenBy(anna, item.id)?.title).toBe(item.title);
      expect(listCommentsForItem(annaDb.db, item.id).map((comment) => comment.body)).toContain(`about ${item.key}`);
    }
  });
});

describe("a command the record applied and never got to acknowledge", () => {
  it("is replayed and acknowledged, not mistaken for somebody else's move", async () => {
    const item = onTheRecord();
    await anna.record.sync();

    anna.record.applyTransition({ itemId: item.id, toStepId: "review", actor: "human" });

    // The record applies it; the answer never arrives.
    anna.swallowNextAnswer = true;
    const lost = await anna.record.sync();
    expect(lost.sent).toBe(0);
    expect(getItem(recordDb.db, item.id)?.stepId).toBe("review");
    // So the command is still here, which is right: unanswered is
    // indistinguishable from unsent, and the safe reading is to send again.
    expect(itemsWithQueuedMoves(annaDb.db)).toEqual([item.id]);

    const retried = await anna.record.sync();

    // Acknowledged as what it is — already done — rather than refused as
    // a conflict with itself. The item had indeed moved since the
    // command was made; the thing that moved it was this command.
    expect(retried.sent).toBe(1);
    expect(retried.superseded).toBe(0);
    expect(itemsWithQueuedMoves(annaDb.db)).toEqual([]);
    // And no accusation. The failure this guards against is an inbox row
    // telling Anna her move was superseded by her own.
    expect(openMentionsForHuman(annaDb.db)).toEqual([]);
    expect(getItem(annaDb.db, item.id)?.stepId).toBe("review");
    // One move, not two: the record's audit row is keyed on the move's
    // own id, so a replay writes nothing the second time.
    expect(listTransitionsForItem(recordDb.db, item.id)).toHaveLength(1);
  });

  it("does not double a comment either", async () => {
    const item = onTheRecord();
    await anna.record.sync();
    anna.record.postComment({ itemId: item.id, author: { type: "human" }, body: "Said once, sent twice." });

    anna.swallowNextAnswer = true;
    await anna.record.sync();
    await anna.record.sync();

    expect(listCommentsForItem(recordDb.db, item.id).filter((comment) => comment.body === "Said once, sent twice.")).toHaveLength(1);
  });
});

describe("a file attached to a comment", () => {
  /** What somebody dropped on a thread: staged, then posted with the comment. */
  async function attach(machine: Desktop, itemId: string, name: string, contents: string): Promise<string> {
    const staged = await machine.files.stageData({ name, dataBase64: Buffer.from(contents).toString("base64") });
    const prepared = await machine.files.prepare([staged.id]);
    const comment = machine.record.postComment({
      itemId: itemId as Uuid,
      author: { type: "human" },
      body: `Here is ${name}.`,
      attachmentRecords: prepared,
    });
    await machine.files.finish(prepared);
    return comment.id;
  }

  it("reaches the record, bytes and all, and then the other desktop", async () => {
    const item = onTheRecord();
    await anna.record.sync();
    await dana.record.sync();

    const commentId = await attach(anna, item.id, "report.pdf", "the Q3 numbers");

    await anna.record.sync();

    // On the record: the row, and a file behind it rather than a broken
    // link on the admin's board.
    const onRecord = listAttachmentsForComment(recordDb.db, commentId as Uuid);
    expect(onRecord.map((file) => file.name)).toEqual(["report.pdf"]);
    expect((await serving.attachments!.read(onRecord[0]!.path))?.toString()).toBe("the Q3 numbers");

    await dana.record.sync();

    // And on Dana's, with the bytes fetched rather than the metadata
    // alone: a row pointing at a file that is not there is worse than no
    // row at all.
    const onDana = listAttachmentsForComment(danaDb.db, commentId as Uuid);
    expect(onDana.map((file) => file.name)).toEqual(["report.pdf"]);
    expect((await dana.files.read(onDana[0]!.path))?.toString()).toBe("the Q3 numbers");
    expect(listCommentsForItem(danaDb.db, item.id).map((comment) => comment.body)).toContain("Here is report.pdf.");
  });

  it("waits with its comment while the record is unreachable, and goes when it is not", async () => {
    const item = onTheRecord();
    await anna.record.sync();

    anna.online = false;
    const commentId = await attach(anna, item.id, "note.txt", "written offline");
    await anna.record.sync();
    // Both halves are still waiting: the comment that announces the file
    // and the file itself.
    expect(pendingKinds()).toEqual(["comment", "attachment"]);

    anna.online = true;
    await anna.record.sync();

    expect(queuedCommandCount(annaDb.db)).toBe(0);
    expect(listAttachmentsForComment(recordDb.db, commentId as Uuid)).toHaveLength(1);
  });

  it("is sent alone, because one file can fill a whole request", async () => {
    const item = onTheRecord();
    await anna.record.sync();

    anna.online = false;
    await attach(anna, item.id, "one.txt", "first");
    await attach(anna, item.id, "two.txt", "second");
    // Four commands: two comments and two files, in the order they
    // happened. A batch that carried both files could exceed the
    // contract's own request limit, so the drain cuts at the first.
    expect(pendingKinds()).toEqual(["comment", "attachment", "comment", "attachment"]);

    anna.online = true;
    await anna.record.sync();

    expect(queuedCommandCount(annaDb.db)).toBe(0);
    await dana.record.sync();
    expect(
      listCommentsForItem(danaDb.db, item.id)
        .flatMap((comment) => listAttachmentsForComment(danaDb.db, comment.id))
        .map((file) => file.name)
        .sort(),
    ).toEqual(["one.txt", "two.txt"]);
  });

  /** The queue's kinds, in the order it holds them. */
  function pendingKinds(): string[] {
    return pendingCommands(annaDb.db).map((entry) => entry.kind);
  }
});

describe("an item's own file (EO-702)", () => {
  /** Put on the item from its page: staged, then added with no comment. */
  async function addToItem(machine: Desktop, itemId: string, name: string, contents: string): Promise<Uuid> {
    const staged = await machine.files.stageData({ name, dataBase64: Buffer.from(contents).toString("base64") });
    const prepared = await machine.files.prepare([staged.id]);
    addItemAttachments(machine.handle.db, itemId as Uuid, prepared);
    await machine.files.finish(prepared);
    return prepared[0]!.id;
  }

  it("reaches the record and the other desktop with no comment to come first, and its removal follows", async () => {
    const item = onTheRecord();
    await anna.record.sync();
    await dana.record.sync();

    const fileId = await addToItem(anna, item.id, "mock.png", "the mock");
    await anna.record.sync();

    // On the record: the item's own, bytes behind it.
    const onRecord = listItemAttachments(recordDb.db, item.id as Uuid);
    expect(onRecord.map((file) => [file.id, file.name, file.commentId])).toEqual([[fileId, "mock.png", null]]);
    expect((await serving.attachments!.read(onRecord[0]!.path))?.toString()).toBe("the mock");

    await dana.record.sync();

    // On Dana's: the item's own too, fetched, and in nobody's thread.
    const onDana = listItemAttachments(danaDb.db, item.id as Uuid);
    expect(onDana.map((file) => [file.id, file.name, file.commentId])).toEqual([[fileId, "mock.png", null]]);
    expect((await dana.files.read(onDana[0]!.path))?.toString()).toBe("the mock");
    expect(listCommentsForItem(danaDb.db, item.id).flatMap((comment) => comment.attachments ?? [])).toEqual([]);

    // Anna takes it off again.
    const removed = removeItemAttachment(annaDb.db, fileId);
    expect(removed).toBeDefined();
    await anna.files.removeManaged(removed!);
    await anna.record.sync();

    expect(listItemAttachments(recordDb.db, item.id as Uuid)).toEqual([]);
    expect(await serving.attachments!.read(onRecord[0]!.path)).toBeNull();

    await dana.record.sync();

    expect(listItemAttachments(danaDb.db, item.id as Uuid)).toEqual([]);
    expect(await dana.files.read(onDana[0]!.path)).toBeNull();
    // And neither desktop sends anything back about it.
    expect(queuedCommandCount(annaDb.db)).toBe(0);
    expect(queuedCommandCount(danaDb.db)).toBe(0);
  });

  it("is not brought back when it was removed before the file was sent", async () => {
    const item = onTheRecord();
    await anna.record.sync();

    anna.online = false;
    const fileId = await addToItem(anna, item.id, "draft.txt", "never mind");
    const removed = removeItemAttachment(annaDb.db, fileId);
    await anna.files.removeManaged(removed!);
    expect(pendingCommands(annaDb.db).map((entry) => entry.kind)).toEqual(["attachment", "attachmentRemoval"]);

    anna.online = true;
    await anna.record.sync();
    await dana.record.sync();

    expect(queuedCommandCount(annaDb.db)).toBe(0);
    expect(listItemAttachments(recordDb.db, item.id as Uuid)).toEqual([]);
    expect(listItemAttachments(danaDb.db, item.id as Uuid)).toEqual([]);
  });
});

/**
 * Telling the tracker is the record's job (EO-324, ARCHITECTURE.md, "The record").
 *
 * A move on a signed-in desktop is provisional until the record accepts
 * it. An outbox row is not: it is a promise to tell Jira, and Jira has
 * no word for provisional. So the device that made the move must not
 * push it — the record does, once it has decided, and once rather than
 * once per desktop that pulls it down afterwards.
 *
 * The item is given a workspace and a Jira key on every side, because
 * the guard being tested is inside `transitionItem`'s existing
 * conditions and a test whose item was not Jira-synced would pass with
 * the guard deleted.
 */
describe("a tracker a managed desktop does not own", () => {
  /** A Jira-synced item on the record, on each desktop's replica too. */
  async function jiraSyncedItem(): Promise<Item> {
    const workspaceId = attachWorkspace(recordDb.db, { name: "app", keyPrefix: "APP", repoPath: "/tmp/app" }).id;
    const item = createTestItem(recordDb.db, { type: "story", title: "Rate limiting", stepId: "todo", workspaceId });
    linkJiraKey(recordDb.db, item.id, "APP-1");
    // The replicas need the same shape, or the guard is never reached on
    // them and the test proves nothing about the desktop side.
    for (const machine of [anna, dana]) {
      const theirs = attachWorkspace(machine.handle.db, { name: "app", keyPrefix: "APP", repoPath: "/tmp/app" }).id;
      await machine.record.sync();
      machine.handle.db.update(itemsTable).set({ workspaceId: theirs }).where(eq(itemsTable.id, item.id)).run();
      linkJiraKey(machine.handle.db, item.id, "APP-1");
    }
    return item;
  }

  /** What this machine has promised to tell Jira about the item. */
  function pushes(handle: DbHandle, itemId: string): string[] {
    return pendingPushesForItem(handle.db, itemId as Uuid, "jira").map((entry) => entry.kind);
  }

  it("is left alone by an offline move, so a superseded one never reaches it", async () => {
    const item = await jiraSyncedItem();

    anna.online = false;
    anna.record.applyTransition({ itemId: item.id, toStepId: "review", actor: "human" });
    // Nothing promised to Jira, because nothing is settled: the record
    // has not seen this move and may refuse it.
    expect(pushes(annaDb, item.id)).toEqual([]);

    // And it does refuse it — Dana got there first.
    dana.record.applyTransition({ itemId: item.id, toStepId: "ready_to_merge", actor: "human" });
    await dana.record.sync();

    anna.online = true;
    const drained = await anna.record.sync();

    expect(drained.superseded).toBe(1);
    // The dropped move told the tracker nothing, on either machine.
    expect(pushes(annaDb, item.id)).toEqual([]);
    expect(pushes(danaDb, item.id)).toEqual([]);
    // The record pushed the move it accepted, and only that one.
    expect(pushes(recordDb, item.id)).toEqual(["status"]);
  });

  it("is left alone when a move is pulled down, however many desktops pull it", async () => {
    const item = await jiraSyncedItem();

    anna.record.applyTransition({ itemId: item.id, toStepId: "review", actor: "human" });
    await anna.record.sync();
    // Dana pulls the accepted move. Twice, because a cursor deliberately
    // re-reads its own boundary.
    await dana.record.sync();
    await dana.record.sync();

    expect(getItem(danaDb.db, item.id)?.stepId).toBe("review");
    expect(pushes(danaDb, item.id)).toEqual([]);
    expect(pushes(annaDb, item.id)).toEqual([]);
    // One move, one push — not one per machine with EO open.
    expect(pushes(recordDb, item.id)).toEqual(["status"]);
  });

  it("hears about a comment once, from the record rather than from every replica", async () => {
    const item = await jiraSyncedItem();

    anna.record.postComment({ itemId: item.id, author: { type: "human" }, body: "The Q3 number is wrong." });
    await anna.record.sync();
    await dana.record.sync();

    expect(pushes(annaDb, item.id)).toEqual([]);
    expect(pushes(danaDb, item.id)).toEqual([]);
    expect(pushes(recordDb, item.id)).toEqual(["comment"]);
  });
});

describe("what a comment means, across machines", () => {
  it("carries an explicit mention, so the record can dispatch it", async () => {
    const item = onTheRecord();
    await anna.record.sync();
    await dana.record.sync();
    const reviewer = listAgents(annaDb.db).find((agent) => agent.role === "reviewer")!;

    // Explicit, with no token in the body at all — which is the case a
    // record that re-parsed the text would lose entirely.
    const said = anna.record.postComment({
      itemId: item.id,
      author: { type: "human" },
      body: "Have another look at this.",
      mentions: [{ type: "agent", agentId: reviewer.id }],
    });

    await anna.record.sync();

    // On the record, as a mention of that agent: this is what the
    // record's scheduler reads to dispatch the reviewer.
    expect(listMentionsForComment(recordDb.db, said.id).map((mention) => ({ type: mention.targetType, id: mention.targetId }))).toEqual([
      { type: "agent", id: reviewer.id },
    ]);

    await dana.record.sync();
    expect(listMentionsForComment(danaDb.db, said.id).map((mention) => mention.targetId)).toEqual([reviewer.id]);
  });

  it("carries a mention of the person, so the inbox arrives where somebody is sitting", async () => {
    const item = onTheRecord();
    await anna.record.sync();
    await dana.record.sync();

    anna.record.postComment({
      itemId: item.id,
      author: { type: "engine" },
      kind: "escalation",
      mentions: [{ type: "human" }],
      body: "Which of these did you mean?",
    });

    await anna.record.sync();
    await dana.record.sync();

    // Everybody signed in to this record is being asked, which is what a
    // shared thread means — and each machine resolves it to the person
    // in front of it.
    expect(openMentionsForHuman(recordDb.db)).toHaveLength(1);
    expect(openMentionsForHuman(danaDb.db)).toHaveLength(1);
  });

  it("carries a pin, and a pin somebody adds afterwards", async () => {
    const item = onTheRecord();
    await anna.record.sync();
    await dana.record.sync();

    const said = anna.record.postComment({
      itemId: item.id,
      author: { type: "human" },
      body: "This is the bit that matters.",
      pinned: true,
    });
    await anna.record.sync();
    await dana.record.sync();

    // A pin is what survives context truncation (ARCHITECTURE.md, "What an agent is given"), so an
    // agent on
    // another machine reading a long thread has to see it.
    expect(getComment(recordDb.db, said.id)?.pinned).toBe(true);
    expect(getComment(danaDb.db, said.id)?.pinned).toBe(true);

    // And taking it off later is a change of its own, made long after
    // the comment was written.
    setCommentPinned(annaDb.db, said.id, false);
    await anna.record.sync();
    await dana.record.sync();

    expect(getComment(recordDb.db, said.id)?.pinned).toBe(false);
    expect(getComment(danaDb.db, said.id)?.pinned).toBe(false);
    // …and having arrived, it is not sent back again on the next pull.
    await dana.record.sync();
    expect(queuedCommandCount(danaDb.db)).toBe(0);
  });
});

describe("what one desktop's run looks like on another", () => {
  it("shows the run and its transcript, not an idle board", async () => {
    const item = onTheRecord();
    await anna.record.sync();
    await dana.record.sync();
    const implementer = listAgents(annaDb.db).find((agent) => agent.role === "implementer")!;

    // Anna's machine runs the work. Dana's shows nothing about it until
    // it pulls — and the board reads the latest run's status out of the
    // *local* runs table, so without this Dana draws an idle column
    // while an agent is going on somebody else's laptop.
    const run = createRun(annaDb.db, {
      itemId: item.id,
      agentId: implementer.id,
      action: "implement",
      stepId: "todo",
      status: "running",
    });
    const buffer = createRunEventBuffer(annaDb.db);
    for (const line of ["reading the spec", "writing the limiter"]) buffer.append(run.id, "stdout", { text: line });
    buffer.dispose();

    await anna.record.sync();
    await dana.record.sync();

    const seen = getRun(danaDb.db, run.id);
    expect(seen?.status).toBe("running");
    expect(seen?.agentId).toBe(implementer.id);
    // And the transcript, in the order Anna's machine wrote it.
    expect(listRunEvents(danaDb.db, run.id).map((event) => (event.payload as { text: string }).text)).toEqual([
      "reading the spec",
      "writing the limiter",
    ]);
    // Attributed to the machine the work actually happened on, not to
    // the one that received it.
    expect(runEventAuthors(run.id)).toEqual([anna.deviceId, anna.deviceId]);
  });

  it("follows the run to its end", async () => {
    const item = onTheRecord();
    await anna.record.sync();
    await dana.record.sync();
    const run = createRun(annaDb.db, { itemId: item.id, agentId: null, action: "implement", stepId: "todo" });
    await anna.record.sync();
    await dana.record.sync();
    expect(getRun(danaDb.db, run.id)?.status).toBe("queued");

    updateRun(annaDb.db, run.id, { status: "succeeded", endedAt: 1_700_000_000_000 });
    await anna.record.sync();
    await dana.record.sync();

    expect(getRun(danaDb.db, run.id)?.status).toBe("succeeded");
  });

  it("does not offer the record back a run it received from the record", async () => {
    const item = onTheRecord();
    await anna.record.sync();
    await dana.record.sync();
    const run = createRun(annaDb.db, { itemId: item.id, agentId: null, action: "implement", stepId: "todo" });
    const buffer = createRunEventBuffer(annaDb.db);
    buffer.append(run.id, "stdout", { text: "one line" });
    buffer.dispose();
    await anna.record.sync();

    await dana.record.sync();
    // A second pass would send it straight back without the bookmark
    // that says this device owes the record nothing for it — and then a
    // third, and a fourth, once per tick for ever.
    const again = await dana.record.sync();

    expect(again.runEvents).toBe(0);
    expect(runsNeedingSync(danaDb.db)).toEqual([]);
    // And the record's copy is not doubled.
    expect(listRunEvents(recordDb.db, run.id)).toHaveLength(1);
  });
});

describe("a device pretending to be another device", () => {
  /**
   * The door, as `server/http.ts` hangs it (EO-324).
   *
   * What is being checked is one line of that file: the payload's
   * `deviceId` is *replaced* with the authenticated caller's before
   * anything reads it. Every test here sends a request naming somebody
   * else and expects the answer to be about the sender.
   */
  function asDevice<K extends IpcChannel>(deviceId: string, channel: K, payload: IpcPayload<K>): IpcPayload<K> {
    return withDeviceIdentity(channel, payload, deviceId) as IpcPayload<K>;
  }

  it("cannot take the work, because the door says who is asking", async () => {
    const item = onTheRecord();
    await anna.record.sync();

    // Dana's token, Anna's name in the payload. The door stamps its own
    // answer over the claim.
    const offered = await serveWork(
      serving,
      asDevice(dana.deviceId, "record:work", { deviceId: anna.deviceId, capacity: 1 }),
    );

    expect(offered.offers.map((offer) => offer.lease.deviceId)).toEqual([dana.deviceId]);
    expect(theRecord.leaseFor(item.id)?.deviceId).toBe(dana.deviceId);
  });

  it("cannot keep another machine's claim alive", async () => {
    const item = onTheRecord();
    theRecord.grantLease({ itemId: item.id, deviceId: anna.deviceId });

    const renewed = await serveRenew(
      serving,
      asDevice(dana.deviceId, "record:renew", { deviceId: anna.deviceId, itemIds: [item.id], releaseOthers: false }),
    );

    // Nothing renewed, because Dana holds nothing — and Anna's claim is
    // untouched rather than handed over.
    expect(renewed.held).toEqual([]);
    expect(theRecord.leaseFor(item.id)?.deviceId).toBe(anna.deviceId);
  });

  it("cannot give another machine's claim back", async () => {
    const item = onTheRecord();
    theRecord.grantLease({ itemId: item.id, deviceId: anna.deviceId });

    const released = await serveRelease(
      serving,
      asDevice(dana.deviceId, "record:release", { deviceId: anna.deviceId, itemId: item.id }),
    );

    expect(released.released).toBe(false);
    expect(theRecord.leaseFor(item.id)?.deviceId).toBe(anna.deviceId);
  });

  it("cannot file a transcript under another machine's name", async () => {
    const item = onTheRecord();
    const run = createRun(recordDb.db, { itemId: item.id, agentId: null, action: "implement", stepId: "todo" });

    await serveApply(
      serving,
      asDevice(dana.deviceId, "record:apply", {
        deviceId: anna.deviceId,
        commands: [
          {
            kind: "runEvents",
            id: "01a0-forged",
            runId: run.id,
            itemId: item.id,
            events: [{ seq: 0, ts: 1_700_000_000_000, type: "stdout", payload: { text: "not mine" } }],
          },
        ],
      }),
    );

    // The author is whoever actually sent it. `run_events` is the
    // durability substrate (invariant #3), and a record that let one
    // machine sign another's name to it would be a record of something
    // that did not happen.
    expect(runEventAuthors(run.id)).toEqual([dana.deviceId]);
  });
});

describe("a push from the record", () => {
  it("is what makes a move on one desktop appear on the other", async () => {
    const item = onTheRecord();
    await anna.record.sync();
    await dana.record.sync();

    // Dana's machine is subscribed: `startMain` wires the push client's
    // `onChanged` to exactly this. Nothing polls in between.
    const stopListening = bridgePushChannels({
      send: () => {
        void dana.record.sync();
      },
    });
    try {
      anna.record.applyTransition({ itemId: item.id, toStepId: "review", actor: "human" });
      // Anna's own sync is what reaches the record — and the record
      // announcing it is what reaches Dana, without Dana asking.
      await anna.record.sync();

      await until(() => getItem(danaDb.db, item.id)?.stepId === "review", "the move to appear on the other desktop");
    } finally {
      stopListening();
    }
  });
});

describe("what an offline run leaves behind it", () => {
  it("replays the comment and the move it produced, carrying the run they hang off", async () => {
    // The shape of a real offline run, which is the case the second
    // acceptance criterion is about. `comments.run_id` and
    // `transitions.run_id` are foreign keys and the record enforces
    // them, so a queue replayed without the run in front of it stops
    // dead on the first thing that run produced — and everything behind
    // it stops too.
    const item = onTheRecord();
    await anna.record.sync();

    anna.online = false;
    const run = createRun(annaDb.db, { itemId: item.id, agentId: null, action: "implement", stepId: "todo", status: "running" });
    // What a run leaves on its way out: the output it wrote, and the
    // move its result routed. Both name the run.
    anna.record.postComment({ itemId: item.id, author: { type: "engine" }, body: "Here is the limiter.", runId: run.id });
    anna.record.applyTransition({ itemId: item.id, toStepId: "review", actor: "human", runId: run.id });
    updateRun(annaDb.db, run.id, { status: "succeeded", endedAt: 1_700_000_000_000 });

    anna.online = true;
    const drained = await anna.record.sync();

    // Nothing refused, nothing stranded.
    expect(drained.refused).toBe(0);
    expect(queuedCommandCount(annaDb.db)).toBe(0);
    // And all three arrived, joined up: the comment and the move both
    // point at a run the record has.
    expect(getRun(recordDb.db, run.id)?.status).toBe("succeeded");
    const said = listCommentsForItem(recordDb.db, item.id).find((comment) => comment.body === "Here is the limiter.");
    expect(said?.runId).toBe(run.id);
    expect(listTransitionsForItem(recordDb.db, item.id).map((move) => ({ to: move.toStepId, runId: move.runId }))).toEqual([
      { to: "review", runId: run.id },
    ]);
  });

  it("carries the result the run produced, not only that it finished", async () => {
    const item = onTheRecord();
    await anna.record.sync();

    anna.online = false;
    const run = createRun(annaDb.db, { itemId: item.id, agentId: null, action: "implement", stepId: "todo", status: "running" });
    updateRun(annaDb.db, run.id, {
      status: "succeeded",
      endedAt: 1_700_000_000_000,
      // The point of the run having happened: what it answered with.
      result: { summary: "Added the limiter", files_changed: 3 },
      tokensIn: 4_000,
      tokensOut: 900,
      costCents: 12,
    });

    anna.online = true;
    await anna.record.sync();

    const onRecord = getRun(recordDb.db, run.id);
    expect(onRecord?.result).toEqual({ summary: "Added the limiter", files_changed: 3 });
    // And what it cost, because the record is the only scheduler and a
    // budget it enforces against a number that is always zero is not a
    // budget (EO-211).
    expect(onRecord).toMatchObject({ tokensIn: 4_000, tokensOut: 900, costCents: 12 });

    // …and on to the other desktop, which is where an admin reads it.
    await dana.record.sync();
    expect(getRun(danaDb.db, run.id)?.result).toEqual({ summary: "Added the limiter", files_changed: 3 });
  });
});

describe("a file that lands after its comment has already been read", () => {
  it("still reaches the desktop that pulled in between", async () => {
    // The race, run deliberately. Anna's comment reaches the record;
    // Dana pulls and steps her cursor past it; *then* Anna's file
    // arrives. A comment is immutable and is never paged twice, so
    // without a stream of its own that file would be invisible on
    // Dana's machine for ever.
    const item = onTheRecord();
    await anna.record.sync();
    await dana.record.sync();

    const staged = await anna.files.stageData({ name: "report.pdf", dataBase64: Buffer.from("the Q3 numbers").toString("base64") });
    const prepared = await anna.files.prepare([staged.id]);
    const said = anna.record.postComment({
      itemId: item.id,
      author: { type: "human" },
      body: "Here is report.pdf.",
      attachmentRecords: prepared,
    });
    await anna.files.finish(prepared);

    // Only the comment goes over — the drain sends a file alone, so
    // this is exactly the interval that exists in production.
    const batch = pendingCommands(annaDb.db, 1);
    expect(batch.map((entry) => entry.kind)).toEqual(["comment"]);
    await serveApply(serving, { deviceId: anna.deviceId, commands: [batch[0]!.command] });
    forgetCommands(annaDb.db, [batch[0]!.id]);

    // Dana reads the thread in that interval and moves on.
    await dana.record.sync();
    expect(listCommentsForItem(danaDb.db, item.id).map((comment) => comment.body)).toContain("Here is report.pdf.");
    expect(listAttachmentsForComment(danaDb.db, said.id)).toEqual([]);

    // The file lands a moment later.
    await anna.record.sync();
    expect(listAttachmentsForComment(recordDb.db, said.id)).toHaveLength(1);

    // And Dana learns about it, bytes and all, without the comment ever
    // being paged again.
    await dana.record.sync();
    const onDana = listAttachmentsForComment(danaDb.db, said.id);
    expect(onDana.map((file) => file.name)).toEqual(["report.pdf"]);
    expect((await dana.files.read(onDana[0]!.path))?.toString()).toBe("the Q3 numbers");
  });
});

describe("the pull, when its pages do not line up", () => {
  it("reads past sequence nine of a run that wrote its whole transcript in one millisecond", async () => {
    // A chatty agent writes far more than ten lines in a millisecond,
    // which is the ordinary case rather than the corner one. The cursor
    // that carried the sequence inside a string compared `":10" > ":9"`
    // and found it false — so a page ending at nine skipped ten to
    // nineteen, for ever, and only on the runs busy enough to matter.
    const item = onTheRecord();
    await anna.record.sync();
    const run = createRun(annaDb.db, { itemId: item.id, agentId: null, action: "implement", stepId: "todo", status: "running" });

    // Twelve events, all stamped the same millisecond: `createRunEventBuffer`
    // allocates the sequence, and the clock is what is held still here.
    const buffer = createRunEventBuffer(annaDb.db);
    for (let line = 0; line < 12; line += 1) buffer.append(run.id, "stdout", { text: `line ${String(line)}` });
    buffer.dispose();
    annaDb.db.update(runEvents).set({ ts: 1_700_000_000_000 }).where(eq(runEvents.runId, run.id)).run();
    await anna.record.sync();
    recordDb.db.update(runEvents).set({ ts: 1_700_000_000_000 }).where(eq(runEvents.runId, run.id)).run();

    // Dana reads them three at a time, so a page boundary lands between
    // nine and ten.
    await dana.record.sync();

    expect(listRunEvents(danaDb.db, run.id).map((event) => event.seq)).toEqual([...Array(12).keys()]);
  });

  it("keeps a transcript whose run is a page behind it, and places it when the run arrives", async () => {
    // Six lists, six cursors, and a page of one is not a page of the
    // others. Arranged rather than hoped for: the runs are ordered
    // oldest-changed first and their transcripts newest-written first,
    // so at three rows a page the last run's events arrive two pages
    // before the run itself. A cursor only moves forwards, so an event
    // dropped here is an event nobody mentions again.
    const item = onTheRecord();
    const runs = Array.from({ length: 4 }, (_, at) => {
      const run = createRun(recordDb.db, { itemId: item.id, agentId: null, action: `implement-${String(at)}`, stepId: "todo", status: "running" });
      const buffer = createRunEventBuffer(recordDb.db);
      buffer.append(run.id, "stdout", { text: `run ${String(at)} said something` });
      buffer.dispose();
      return run;
    });
    runs.forEach((run, at) => {
      // The run rows in order; their transcripts in the opposite one.
      recordDb.db.update(runsTable).set({ updatedAt: 1_000 + at }).where(eq(runsTable.id, run.id)).run();
      recordDb.db.update(runEvents).set({ ts: 2_000 - at }).where(eq(runEvents.runId, run.id)).run();
    });

    // One pass, paging until the record has nothing more.
    await dana.record.sync();

    for (const run of runs) {
      expect(getRun(danaDb.db, run.id)?.action).toBe(run.action);
      expect(listRunEvents(danaDb.db, run.id).map((event) => (event.payload as { text: string }).text)).toEqual([
        `run ${run.action.slice("implement-".length)} said something`,
      ]);
    }
    // And nothing is still being held: everything found its parent.
    expect(pendingCount(danaDb.db)).toBe(0);
  });

  it("holds a comment whose item has not arrived, rather than dropping it", async () => {
    // The hold, on its own. A device is given a comment and not the
    // item it belongs to — which is what an unaligned page looks like
    // from here, and is indistinguishable from "the item is not coming
    // at all". One of those two readings is data loss, so neither is
    // guessed at: the comment is kept.
    const item = onTheRecord();
    const said = theRecord.postComment({ itemId: item.id, author: { type: "human" }, body: "About an item you do not have." });

    // Dana's item cursor is pushed past everything the record has, so
    // the items list comes back empty while the comments list does not.
    // That is the shape of a page boundary, arranged rather than raced.
    setSetting(danaDb.db, "record.changesCursors", { ...EMPTY_CURSORS, items: { ts: Date.now() + 60_000, id: "" } });
    await dana.record.sync();

    expect(getItem(danaDb.db, item.id)).toBeUndefined();
    // Held, and named for what it waits on, rather than gone.
    expect(pendingCount(danaDb.db, "comment")).toBe(1);

    // …and placed the moment the item arrives, though the record never
    // mentions the comment again: its cursor has long since moved past.
    setSetting(danaDb.db, "record.changesCursors", EMPTY_CURSORS);
    await dana.record.sync();

    expect(listCommentsForItem(danaDb.db, item.id).map((comment) => comment.body)).toContain("About an item you do not have.");
    expect(getComment(danaDb.db, said.id)).toBeDefined();
    expect(pendingCount(danaDb.db, "comment")).toBe(0);
  });
});

describe("a file this desktop was told about and had not downloaded", () => {
  it("still arrives after a restart between the metadata and the bytes", async () => {
    const item = onTheRecord();
    await anna.record.sync();
    await dana.record.sync();

    const staged = await anna.files.stageData({ name: "report.pdf", dataBase64: Buffer.from("the Q3 numbers").toString("base64") });
    const prepared = await anna.files.prepare([staged.id]);
    const said = anna.record.postComment({
      itemId: item.id,
      author: { type: "human" },
      body: "Here is report.pdf.",
      attachmentRecords: prepared,
    });
    await anna.files.finish(prepared);
    await anna.record.sync();

    // Dana reads everything except the bytes. Its comment and
    // attachment cursors have now moved past both — the record will not
    // mention either again, because a comment is immutable and an
    // attachment's own cursor only goes forwards.
    dana.refuseAttachments = true;
    await dana.record.sync();
    expect(listAttachmentsForComment(danaDb.db, said.id)).toEqual([]);
    // The want is on disk rather than in a map a restart would empty.
    expect(pendingCount(danaDb.db, "attachment")).toBe(1);

    // EO closes and opens again: a new record over the same database,
    // with nothing at all carried across in memory.
    dana.record.stop();
    dana.record = createDeviceRecord({
      db: danaDb.db,
      deviceId: () => dana.deviceId,
      attachments: dana.files,
      transport: transportFor(dana),
      pullPageSize: PULL_PAGE,
    });
    dana.refuseAttachments = false;

    await dana.record.sync();

    const onDana = listAttachmentsForComment(danaDb.db, said.id);
    expect(onDana.map((file) => file.name)).toEqual(["report.pdf"]);
    expect((await dana.files.read(onDana[0]!.path))?.toString()).toBe("the Q3 numbers");
    expect(pendingCount(danaDb.db, "attachment")).toBe(0);
  });
});

// ── The last scope bullet ────────────────────────────────────────────

describe("the local scheduler while signed in", () => {
  it("offers nothing when the record cannot be reached, however dispatchable the replica looks", async () => {
    const item = onTheRecord();
    await anna.record.sync();
    // The replica has a perfectly dispatchable item on it — its own
    // scheduler would offer it in a heartbeat.
    expect(createLocalRecord(annaDb.db).pick(buildTickInput(annaDb.db, LIMITS, false)).map((one) => one.item.id)).toEqual([item.id]);

    anna.online = false;

    expect(
      await anna.record.offerWork({ deviceId: anna.deviceId, capacity: 1, tickInput: buildTickInput(annaDb.db, LIMITS, false) }),
    ).toEqual([]);
  });

  it("runs only what the record leases it", async () => {
    const item = onTheRecord();
    await anna.record.sync();

    // Dana holds the claim. Anna's replica still shows the item sitting
    // there, dispatchable, and Anna's tick must still be offered
    // nothing: the record is the only scheduler.
    await dana.record.offerWork({ deviceId: dana.deviceId, capacity: 1, tickInput: buildTickInput(danaDb.db, LIMITS, false) });

    const forAnna = await anna.record.offerWork({
      deviceId: anna.deviceId,
      capacity: 1,
      tickInput: buildTickInput(annaDb.db, LIMITS, false),
    });

    expect(forAnna).toEqual([]);
    expect(theRecord.leaseFor(item.id)?.deviceId).toBe(dana.deviceId);
  });
});

// ── A solo desktop is unchanged ──────────────────────────────────────

// ── What an organisation publishes (EO-329, ARCHITECTURE.md, "Publish, lock and versions")
// ─────────────

describe("a section the organisation publishes", () => {
  /** A catalogued MCP server's draft, with the fields a caller says nothing about at their defaults. */
  const SERVER = {
    name: "",
    transport: "stdio" as const,
    command: null,
    args: [] as string[],
    url: null,
    headers: {} as Record<string, string>,
    authKind: "header" as const,
    bearerTokenEnvName: null,
    envNames: [] as string[],
  };

  /** The graph as the record has it, ready to be saved back with an edit. */
  function graphOnTheRecord(): IpcPayload<"pipeline:save"> {
    const graph = listPipelineStepViews(recordDb.db, { pipelineId: "default" });
    return { pipelineId: "default", steps: graph.steps, routes: graph.routes, entryStepId: graph.entryStepId };
  }

  function stepNamed(handle: DbHandle, stepId: string): string | undefined {
    return listStepsForPipeline(handle.db, "default").find((step) => step.id === stepId)?.name;
  }

  it("reaches every signed-in desktop, and locks the section there and not on the record", async () => {
    publishSectionCommand(recordDb.db, { section: "pipelines", pipelineId: null, versionNumber: null });

    await anna.record.sync();
    await dana.record.sync();

    for (const machine of [anna, dana]) {
      const published = listPublishedSections(machine.handle.db);
      expect(published.map((row) => row.section)).toContain("pipelines");
      // Read-only rows marked with the version, which is what the story
      // asks a device to store.
      expect(published.every((row) => row.versionNumber !== null)).toBe(true);
      // And the lock binds here, where the record is somewhere else.
      expect(sectionLockFor(machine.handle.db, "pipeline:save")).toMatchObject({ locked: true, section: "pipelines" });
    }

    // Never on the record itself: publishing is what an admin does
    // there, and a lock that bound would lock the only person who can
    // lift it.
    expect(sectionLockFor(recordDb.db, "pipeline:save")).toBeNull();
  });

  it("rolls back to an older version, and the desktops receive that graph", async () => {
    // v1 is what the installation was seeded with. An item enters on it
    // and is bound to it.
    const item = onTheRecord("Mid-flight");
    const boundTo = getItem(recordDb.db, item.id)?.pipelineVersionId ?? null;
    expect(boundTo).not.toBeNull();

    // v2: the same graph with a step renamed, published to everybody.
    const graph = graphOnTheRecord();
    const renamed = graph.steps[0];
    expect(renamed).toBeDefined();
    const saved = savePipeline(recordDb.db, undefined, {
      ...graph,
      steps: graph.steps.map((step) => (step.id === renamed!.id ? { ...step, name: "Renamed in v2" } : step)),
    });
    expect(saved).toMatchObject({ saved: true, version: 2 });
    publishSectionCommand(recordDb.db, { section: "pipelines", pipelineId: null, versionNumber: null });
    await anna.record.sync();
    expect(stepNamed(anna.handle, renamed!.id)).toBe("Renamed in v2");

    // …and back to v1, which is publishing an older version again.
    const rolledBack = publishSectionCommand(recordDb.db, { section: "pipelines", pipelineId: "default", versionNumber: 1 });
    expect(rolledBack.problem).toBeNull();

    // The record's own graph is v1's again, and the pipeline is on v1 —
    // the version named is republished rather than copied into a v3.
    expect(stepNamed(recordDb, renamed!.id)).toBe(renamed!.name);
    expect(currentVersion(recordDb.db, "default")?.number).toBe(1);
    expect(listPipelineVersions(recordDb.db, "default").map((version) => version.number)).toEqual([1, 2]);
    // The published row points at the older version, which is what a
    // desktop stores beside the lock.
    expect(listPublishedSections(recordDb.db).find((row) => row.subjectId === "default")?.versionNumber).toBe(1);

    // And the desktops receive it.
    await anna.record.sync();
    await dana.record.sync();
    expect(stepNamed(anna.handle, renamed!.id)).toBe(renamed!.name);
    expect(stepNamed(dana.handle, renamed!.id)).toBe(renamed!.name);
    expect(listPublishedSections(anna.handle.db).find((row) => row.subjectId === "default")?.versionNumber).toBe(1);

    // The work that was mid-flight is where it was, on the version it
    // entered on. A rollback publishes a graph; it moves nothing.
    expect(getItem(recordDb.db, item.id)?.pipelineVersionId).toBe(boundTo);
  });

  it("leaves a desktop's own graph alone until the section is published", async () => {
    // ARCHITECTURE.md, "Publish, lock and versions"'s other half: "unpublished sections stay
    // editable locally".
    await anna.record.sync();
    const graph = graphOnTheRecord();
    const step = graph.steps[0];
    expect(step).toBeDefined();

    // Anna edits her own copy, which nothing has published and which
    // she is therefore entitled to edit.
    savePipeline(anna.handle.db, undefined, {
      ...listPipelineStepViews(anna.handle.db, { pipelineId: "default" }),
      pipelineId: "default",
      steps: listPipelineStepViews(anna.handle.db, { pipelineId: "default" }).steps.map((one) =>
        one.id === step!.id ? { ...one, name: "Anna's name for it" } : one,
      ),
    });
    // …and the record's own graph moves on, which pages it to her.
    savePipeline(recordDb.db, undefined, {
      ...graph,
      steps: graph.steps.map((one) => (one.id === step!.id ? { ...one, name: "The record's name" } : one)),
    });

    await anna.record.sync();

    // Hers, still. A desktop whose local edits were reverted by the
    // next pull would have no local editing at all — only a delay
    // before losing it.
    expect(stepNamed(anna.handle, step!.id)).toBe("Anna's name for it");
    expect(sectionLockFor(anna.handle.db, "pipeline:save")).toBeNull();
  });

  it("sends the configuration it published, not a lock over what each desktop had", async () => {
    // The organisation's own agent, with a prompt and a tool surface.
    const theirs = createAgent(recordDb.db, {
      name: "Organisation implementer",
      role: "implementer",
      provider: "claude",
      model: "sonnet",
      instructions: "Follow the organisation's engineering guide.",
      enabled: true,
    });

    // …and one Anna wrote herself, for the same role, which nothing on
    // the record has ever heard of.
    const hers = createAgent(anna.handle.db, {
      name: "Anna's implementer",
      role: "implementer",
      provider: "claude",
      instructions: "Whatever Anna decided.",
      enabled: true,
    });

    publishSectionCommand(recordDb.db, { section: "agents", pipelineId: null, versionNumber: null });
    await anna.record.sync();

    // The agent itself arrived, by the record's id and with the
    // record's prompt — a lock over Anna's own copy would have left her
    // running something else entirely.
    const landed = listAgents(anna.handle.db).find((agent) => agent.id === theirs.id);
    expect(landed?.instructions).toBe("Follow the organisation's engineering guide.");
    expect(landed?.enabled).toBe(true);
    // …and Anna's own one stood down rather than competing with it for
    // the same role on every dispatch. Switched off, not archived: she
    // gets it back with one switch if she ever signs out.
    const standingDown = listAgents(anna.handle.db).find((agent) => agent.id === hers.id);
    expect(standingDown).toMatchObject({ enabled: false, archivedAt: null });

    // The backend stays hers (ARCHITECTURE.md, "An agent is a row"). The publication only
    // recommends
    // one, and the recommendation is spent on the first arrival.
    setAgentBinding(anna.handle.db, { agentId: theirs.id, provider: "codex", model: null });
    updateAgent(recordDb.db, theirs.id, { instructions: "Follow the organisation's engineering guide, second edition." });
    publishSectionCommand(recordDb.db, { section: "agents", pipelineId: null, versionNumber: null });
    await anna.record.sync();

    const rebound = listAgents(anna.handle.db).find((agent) => agent.id === theirs.id);
    expect(rebound?.instructions).toBe("Follow the organisation's engineering guide, second edition.");
    // The one thing a publish may never take: the backend this machine
    // is actually signed in to.
    expect(rebound?.provider).toBe("codex");
  });

  it("keeps a desktop's in-flight item on the version it entered on, through a rollback", async () => {
    const graph = graphOnTheRecord();
    const step = graph.steps[0];
    expect(step).toBeDefined();

    // v2 first, so that the work below enters on it — an item binds to
    // the version it entered on and finishes there (EO-327).
    savePipeline(recordDb.db, undefined, {
      ...graph,
      steps: graph.steps.map((one) => (one.id === step!.id ? { ...one, name: "Named in v2" } : one)),
    });
    const item = onTheRecord("Mid-flight");
    publishSectionCommand(recordDb.db, { section: "pipelines", pipelineId: null, versionNumber: null });
    await anna.record.sync();
    const bound = getItem(anna.handle.db, item.id)?.pipelineVersionId ?? null;
    expect(bound).not.toBeNull();
    expect(bound).toBe(getItem(recordDb.db, item.id)?.pipelineVersionId);

    // Rolled back under it, and published again.
    publishSectionCommand(recordDb.db, { section: "pipelines", pipelineId: "default", versionNumber: 1 });
    await anna.record.sync();

    // The desktop draws the live graph as v1 — the organisation rolled
    // it back — *and* still routes this item by the document it
    // entered on. Without the version snapshots on the replica,
    // `boundGraphForItem` had nothing to resolve and fell through to
    // the live rows: the item would have finished under rules nobody
    // agreed to when it started, which is the whole of EO-327.
    expect(stepNamed(anna.handle, step!.id)).toBe(step!.name);
    const annasItem = getItem(anna.handle.db, item.id);
    expect(annasItem?.pipelineVersionId).toBe(bound);
    const routing = boundGraphForItem(anna.handle.db, annasItem!);
    expect(routing).not.toBeNull();
    expect(routing?.number).toBe(2);
    expect(routing?.steps.find((one) => one.id === step!.id)?.name).toBe("Named in v2");
  });

  it("sends the skills a published packs section carries, over a desktop's own of the same slug", async () => {
    const theirs = saveSkill(recordDb.db, {
      slug: "release-notes",
      name: "Release notes",
      description: "How this organisation writes release notes.",
      body: "Lead with what changed for somebody using it.",
      files: [],
    });
    expect(theirs.ok).toBe(true);
    if (!theirs.ok) return;

    // And one Anna wrote for herself, under the same slug — the
    // collision the catalogue has to survive, because a slug is unique
    // and is what a model invokes.
    const hers = saveSkill(anna.handle.db, {
      slug: "release-notes",
      name: "Anna's release notes",
      description: "Hers.",
      body: "Whatever Anna decided.",
      files: [],
    });
    expect(hers.ok).toBe(true);
    if (!hers.ok) return;

    publishSectionCommand(recordDb.db, { section: "packs", pipelineId: null, versionNumber: null });
    await anna.record.sync();

    // The organisation's skill is here, by its own id and with its own
    // body — the content, not a flag saying a section is managed.
    const landed = listSkills(anna.handle.db, true).find((skill) => skill.id === theirs.skill.id);
    expect(landed).toMatchObject({ slug: "release-notes", name: "Release notes", body: "Lead with what changed for somebody using it." });
    // Anna's stood aside rather than colliding: archived, still here for
    // whatever names it, and no longer holding the slug.
    const stood = listSkills(anna.handle.db, true).find((skill) => skill.id === hers.skill.id);
    expect(stood?.archivedAt).not.toBeNull();
    expect(stood?.slug).not.toBe("release-notes");

    // …and an edit published afterwards lands too, which is the half a
    // one-shot copy would pass and a sync has to keep passing.
    saveSkill(recordDb.db, { id: theirs.skill.id, slug: null, name: "Release notes", description: "Second edition.", body: "Lead with the fix.", files: [] });
    publishSectionCommand(recordDb.db, { section: "packs", pipelineId: null, versionNumber: null });
    await anna.record.sync();
    expect(listSkills(anna.handle.db, true).find((skill) => skill.id === theirs.skill.id)?.body).toBe("Lead with the fix.");
  });

  it("sends the modules a published pipelines section carries, because a step runs them", async () => {
    const theirs = saveModule(recordDb.db, {
      slug: "deploy",
      name: "Deploy",
      description: "Ships the branch.",
      code: "export default async () => ({ result: 'shipped' });",
      manifest: {
        name: "Deploy",
        description: "Ships the branch.",
        inputs: {},
        needs: { bin: [], env: [], network: false, item: false, comment: false, attach: false, create: false },
        results: ["shipped"],
      },
      approve: true,
    });
    expect(theirs.ok).toBe(true);
    if (!theirs.ok) return;

    publishSectionCommand(recordDb.db, { section: "pipelines", pipelineId: null, versionNumber: null });
    await anna.record.sync();

    const landed = listModules(anna.handle.db, true).find((module) => module.id === theirs.module.id);
    // The code itself, and the approval with it: a published pipeline
    // whose module arrived unapproved is a pipeline that refuses to run
    // on every desktop, with nobody able to approve it.
    expect(landed?.code).toBe("export default async () => ({ result: 'shipped' });");
    expect(landed?.approvedAt).not.toBeNull();
  });

  it("locks the connectors catalogue without publishing a second copy of it", async () => {
    // A connector is an MCP server row with a descriptor on it, and the
    // rows are EO-328's to publish: `policy:save` writes them into this
    // same table with the record's ids. So what publishing connectors
    // does is shut the doors a pack would bring one through — and it
    // carries no document, because two writers of one table with two
    // rules about name collisions is a state nobody could reason about.
    const connector = saveMcpServer(recordDb.db, {
      ...SERVER,
      name: "slack",
      transport: "http",
      url: "https://slack.test/mcp",
      envNames: ["SLACK_BOT_TOKEN"],
      connector: { label: "Slack", kind: "token", secretNames: ["SLACK_BOT_TOKEN"], oauth: null },
    });
    if (!connector.ok) throw new Error(connector.problems.join("; "));

    publishSectionCommand(recordDb.db, { section: "connectors", pipelineId: null, versionNumber: null });
    await anna.record.sync();

    // The lock arrived…
    expect(listPublishedSections(anna.handle.db).map((row) => row.section)).toContain("connectors");
    expect(sectionLockFor(anna.handle.db, "gallery:use")).toMatchObject({ locked: true, section: "connectors" });
    // …and no second copy of the catalogue with it.
    expect(listPublishedSections(anna.handle.db).find((row) => row.section === "connectors")?.document).toBeNull();
    expect(listMcpServers(anna.handle.db, true).some((server) => server.id === connector.server.id)).toBe(false);
  });

  it("sends nobody to publish policy from here, because policy has a screen of its own", async () => {
    // EO-328 landed the design whole — allowed backends, the per-person
    // budget, which MCP servers exist, the organisation's secrets —
    // with its own publish and its own refusals, per row. A second
    // Publish button for the same section would be two publishes
    // disagreeing about what had been published.
    const refused = publishSectionCommand(recordDb.db, { section: "policy", pipelineId: null, versionNumber: null });

    expect(refused.published).toEqual([]);
    expect(refused.problem).toContain("Settings");
    expect(refused.problem).toContain("Policy");
    await anna.record.sync();
    expect(listPublishedSections(anna.handle.db).some((row) => row.section === "policy")).toBe(false);
    // …and the guardrails on a desktop are still the desktop's, which
    // is the claim this story is not the one to make (the design's ceiling is
    // per person and is drawn on the Policy screen).
    expect(sectionLockFor(anna.handle.db, "guards:set")).toBeNull();
  });

  it("counts what is in flight before it publishes anything", async () => {
    onTheRecord("One");
    onTheRecord("Two");

    const preflight = publishPreflightCommand(recordDb.db, { section: "pipelines", pipelineId: null, versionNumber: null });

    // Two items, and the two desktops on the record's device list.
    expect(preflight.items).toBe(2);
    expect(preflight.devices).toBe(2);
    expect(preflight.confirmation).toBe("2 items in flight across 2 desktops finish on v1.");
    // Nothing was written: an admin may read this and close it.
    expect(listPublishedSections(recordDb.db)).toEqual([]);
    await anna.record.sync();
    expect(listPublishedSections(anna.handle.db)).toEqual([]);
  });

  /**
   * A move to another pipeline version from a desktop (EO-567): a
   * command the record applies, under a published and locked pipelines
   * section, whose binding reaches the other desktop's replica.
   */
  it("moves an item to another version through the record, under a locked pipelines section", async () => {
    // v1, which the item enters on, then a v2 published to everybody.
    const item = onTheRecord("Unstarted");
    const v1 = getItem(recordDb.db, item.id)?.pipelineVersionId ?? null;
    const graph = graphOnTheRecord();
    const renamed = graph.steps[0]!;
    expect(
      savePipeline(recordDb.db, undefined, {
        ...graph,
        steps: graph.steps.map((step) => (step.id === renamed.id ? { ...step, name: "Renamed in v2" } : step)),
      }),
    ).toMatchObject({ saved: true, version: 2 });
    publishSectionCommand(recordDb.db, { section: "pipelines", pipelineId: null, versionNumber: null });
    await anna.record.sync();
    await dana.record.sync();
    expect(sectionLockFor(anna.handle.db, "pipeline:save")).toMatchObject({ locked: true, section: "pipelines" });
    expect(seenBy(anna, item.id)?.pipelineVersionId).toBe(v1);

    const asked = moveItemToVersion(annaDb.db, undefined, { itemId: item.id, version: 2, comment: "Onto the version everybody else is on." });

    // Asked, not done: nothing is written on Anna's replica until the
    // record has applied it.
    expect(asked).toMatchObject({ moved: true, queued: true, fromVersion: 1, toVersion: 2, problem: null });
    expect(pendingCommands(annaDb.db).map((entry) => entry.kind)).toEqual(["rebind"]);
    expect(seenBy(anna, item.id)?.pipelineVersionId).toBe(v1);

    await anna.record.sync();
    await dana.record.sync();

    const v2 = currentVersion(recordDb.db, "default")!;
    expect(v2.number).toBe(2);
    expect(pendingCommands(annaDb.db)).toEqual([]);
    expect(getItem(recordDb.db, item.id)).toMatchObject({ pipelineVersionId: v2.id, stepId: "todo" });
    // The binding reached both replicas, Dana's included.
    expect(seenBy(dana, item.id)?.pipelineVersionId).toBe(v2.id);
    expect(seenBy(anna, item.id)?.pipelineVersionId).toBe(v2.id);
    // One comment, written on the record under the id Anna's desktop
    // minted, naming who asked.
    const said = listCommentsForItem(danaDb.db, item.id).filter((comment) => comment.id === asked.commentId);
    expect(said).toHaveLength(1);
    expect(said[0]?.body).toContain("Moved from version 1 to version 2");
    expect(said[0]?.body).toContain("by Anna.");
    expect(said[0]?.body).toContain("Onto the version everybody else is on.");
    expect(listTransitionsForItem(recordDb.db, item.id)).toHaveLength(listTransitionsForItem(danaDb.db, item.id).length);
  });

  it("refuses a version move the record will not make, and says so on the item", async () => {
    const item = onTheRecord("Unstarted");
    const graph = graphOnTheRecord();
    expect(
      savePipeline(recordDb.db, undefined, { ...graph, steps: graph.steps.map((step, index) => (index === 0 ? { ...step, name: "Renamed" } : step)) }),
    ).toMatchObject({ saved: true, version: 2 });
    publishSectionCommand(recordDb.db, { section: "pipelines", pipelineId: null, versionNumber: null });
    await anna.record.sync();

    // Dana's desktop is working on the item. Anna's replica cannot see
    // that lease; the record can, and judges the move again.
    expect(grantLease(recordDb.db, { itemId: item.id, deviceId: dana.deviceId, now: Date.now(), ttlMs: 60_000 })).not.toBeNull();
    const before = getItem(recordDb.db, item.id);
    expect(moveItemToVersion(annaDb.db, undefined, { itemId: item.id, version: 2, comment: "" }).queued).toBe(true);

    const drained = await anna.record.sync();

    expect(drained.refused).toBe(1);
    expect(getItem(recordDb.db, item.id)).toEqual(before);
    expect(listCommentsForItem(annaDb.db, item.id).map((comment) => comment.body)).toContainEqual(expect.stringContaining("An agent is working on"));
    expect(pendingCommands(annaDb.db)).toEqual([]);
  });
});

describe("a desktop that is signed in to nothing", () => {
  it("is its own record, with a local lease and no queue", async () => {
    // A database of its own, because a desktop's subscriptions belong to
    // the database rather than to the object: `annaDb` already has a
    // signed-in desktop listening to it, and a second record over it
    // would be two machines sharing one replica, which is not a thing.
    const soloDb = openMigratedTestDb();
    const item = createTestItem(soloDb.db, { type: "story", title: "Solo work", stepId: "todo" });

    // `transport()` answering null is a desktop signed in to nothing,
    // which is a different thing from an outage: this machine is its
    // own record and schedules for itself.
    const record = createDeviceRecord({ db: soloDb.db, deviceId: () => "local", transport: () => null });
    try {
      const offers = await record.offerWork({ deviceId: "local", capacity: 1, tickInput: buildTickInput(soloDb.db, LIMITS, false) });

      expect(offers.map((one) => one.dispatch.item.id)).toEqual([item.id]);
      expect(record.linked()).toBe(false);
      // Nothing is queued and no line is drawn: there is no record to be
      // out of touch with.
      expect(queuedCommandCount(soloDb.db)).toBe(0);
      expect(syncStatus(soloDb.db, false)).toMatchObject({ state: "solo", offlineSince: null });

      record.applyTransition({ itemId: item.id, toStepId: "review", actor: "human" });
      record.postComment({ itemId: item.id, author: { type: "human" }, body: "and a word about it" });
      expect(getItem(soloDb.db, item.id)?.stepId).toBe("review");
      // Still nothing. A solo desktop that accumulated commands would be
      // building a queue that could only ever be deleted.
      expect(queuedCommandCount(soloDb.db)).toBe(0);
    } finally {
      record.stop();
      soloDb.close();
    }
  });
});

// ── EO-367: a claim reaches the record ───────────────────────────────

/**
 * Who holds an item, decided by the record (EO-367, ARCHITECTURE.md, "The board", "The record").
 *
 * A claim is applied here at once, queued like a move, and arbitrated
 * by the record: the first to reach it wins, a later claim on an item
 * somebody else holds is dropped and its claimant told, and every
 * desktop converges on the holder the record has. Claims are made
 * through `claimItem` — the handler behind `items:claim` — with no
 * acting device, which is how a desktop's own renderer calls it.
 */
describe("a claim on a managed desktop", () => {
  /** This machine's sign-in, as `rememberSession` writes it: the person the record knows the device as. */
  function signIn(machine: Desktop): { id: string; name: string } {
    const device = getDevice(recordDb.db, machine.deviceId)!;
    const person = { id: device.personId, name: device.personName };
    setSetting(machine.handle.db, MANAGED_PERSON_ID_KEY, person.id);
    setSetting(machine.handle.db, MANAGED_PERSON_NAME_KEY, person.name);
    return person;
  }

  /** Every comment body on this item, on one machine. */
  function bodies(db: DbHandle["db"], itemId: string): string[] {
    return listCommentsForItem(db, itemId as Uuid).map((comment) => comment.body);
  }

  let annaPerson: { id: string; name: string };
  let danaPerson: { id: string; name: string };

  beforeEach(() => {
    annaPerson = signIn(anna);
    danaPerson = signIn(dana);
  });

  it("goes to whoever reached the record first, and every desktop ends up agreeing", async () => {
    const item = onTheRecord();
    await anna.record.sync();
    await dana.record.sync();
    const movesBefore = listTransitionsForItem(recordDb.db, item.id).map((move) => move.id);

    // Both press Claim before either has synced.
    const annas = claimItem(annaDb.db, { itemId: item.id });
    const danas = claimItem(danaDb.db, { itemId: item.id });

    // Shown at once, under the person each machine is signed in as —
    // and queued as a claim, not as a comment saying so.
    expect(annas.assigneeId).toBe(annaPerson.id);
    expect(danas.assigneeId).toBe(danaPerson.id);
    expect(seenBy(anna, item.id)?.assigneeId).toBe(annaPerson.id);
    expect(pendingCommands(annaDb.db).map((entry) => entry.kind)).toEqual(["claim"]);
    expect(pendingCommands(danaDb.db).map((entry) => entry.kind)).toEqual(["claim"]);

    await anna.record.sync();
    const dropped = await dana.record.sync();
    await anna.record.sync();

    // The record arbitrated: Anna's reached it first.
    expect(dropped.superseded).toBe(1);
    expect(getItem(recordDb.db, item.id)?.assigneeId).toBe(annaPerson.id);
    expect(seenBy(anna, item.id)?.assigneeId).toBe(annaPerson.id);
    expect(seenBy(dana, item.id)?.assigneeId).toBe(annaPerson.id);
    expect(annaPerson.id).not.toBe(LOCAL_PERSON_ID);

    // Dana was told, in her inbox, and told who has it.
    const inbox = openMentionsForHuman(danaDb.db);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.comment.body).toContain(`Your claim on ${item.key} was dropped`);
    expect(inbox[0]?.comment.body).toContain("Anna");
    expect(inbox[0]?.comment.kind).toBe("escalation");
    // Anna, whose claim stood, hears nothing about it.
    expect(openMentionsForHuman(annaDb.db)).toEqual([]);

    // The thread names the claimant, once, on every machine — and
    // nobody's thread says "you".
    for (const db of [recordDb.db, annaDb.db, danaDb.db]) {
      expect(bodies(db, item.id)).not.toContain("Claimed by you.");
      expect(bodies(db, item.id).filter((body) => body === "Claimed by Anna.")).toHaveLength(1);
      expect(bodies(db, item.id)).not.toContain("Claimed by Dana.");
    }

    // And nothing moved: a claim is not a transition (invariant #1).
    for (const db of [recordDb.db, annaDb.db, danaDb.db]) {
      expect(getItem(db, item.id)?.stepId).toBe("todo");
      expect(listTransitionsForItem(db, item.id).map((move) => move.id)).toEqual(movesBefore);
    }
    expect(queuedCommandCount(annaDb.db)).toBe(0);
    expect(queuedCommandCount(danaDb.db)).toBe(0);
  });

  it("is dropped on a desktop that had already seen somebody else's, and puts the holder back", async () => {
    // The case the pull alone cannot repair: Dana's copy already has
    // the record's latest row, so nothing newer comes down after her
    // claim is refused.
    const item = onTheRecord();
    await anna.record.sync();
    await dana.record.sync();
    claimItem(annaDb.db, { itemId: item.id });
    await anna.record.sync();
    await dana.record.sync();
    expect(seenBy(dana, item.id)?.assigneeId).toBe(annaPerson.id);

    claimItem(danaDb.db, { itemId: item.id });
    expect(seenBy(dana, item.id)?.assigneeId).toBe(danaPerson.id);
    await dana.record.sync();

    expect(getItem(recordDb.db, item.id)?.assigneeId).toBe(annaPerson.id);
    expect(seenBy(dana, item.id)?.assigneeId).toBe(annaPerson.id);
    expect(openMentionsForHuman(danaDb.db).map((mention) => mention.comment.body)).toEqual([
      expect.stringContaining("Anna already holds it"),
    ]);
  });

  it("made offline waits in the queue, and applies on reconnect when nobody else got there", async () => {
    const item = onTheRecord();
    await anna.record.sync();

    anna.online = false;
    claimItem(annaDb.db, { itemId: item.id });
    await anna.record.sync();
    // Provisional: queued, and the card says so.
    expect(pendingCommands(annaDb.db).map((entry) => entry.kind)).toEqual(["claim"]);
    expect(itemsWithQueuedMoves(annaDb.db)).toEqual([item.id]);
    expect(getItem(recordDb.db, item.id)?.assigneeId).toBeNull();

    anna.online = true;
    const drained = await anna.record.sync();

    expect(drained.sent).toBe(1);
    expect(getItem(recordDb.db, item.id)?.assigneeId).toBe(annaPerson.id);
    expect(seenBy(anna, item.id)?.assigneeId).toBe(annaPerson.id);
    expect(pendingCommands(annaDb.db)).toEqual([]);
    expect(itemsWithQueuedMoves(annaDb.db)).toEqual([]);
  });

  it("made offline is dropped with an inbox row when somebody claimed it in the meantime", async () => {
    const item = onTheRecord();
    await anna.record.sync();
    await dana.record.sync();

    anna.online = false;
    claimItem(annaDb.db, { itemId: item.id });
    expect(pendingCommands(annaDb.db).map((entry) => entry.kind)).toEqual(["claim"]);

    claimItem(danaDb.db, { itemId: item.id });
    await dana.record.sync();

    anna.online = true;
    await anna.record.sync();

    expect(getItem(recordDb.db, item.id)?.assigneeId).toBe(danaPerson.id);
    expect(seenBy(anna, item.id)?.assigneeId).toBe(danaPerson.id);
    expect(pendingCommands(annaDb.db)).toEqual([]);
    const inbox = openMentionsForHuman(annaDb.db);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.comment.body).toContain("dropped");
    expect(inbox[0]?.comment.body).toContain("Dana");
  });

  it("stays claimed through a later pull of the item", async () => {
    // What used to undo every claim: the next pull wrote the record's
    // assignee over the replica's, and the record's was null.
    const item = onTheRecord();
    await anna.record.sync();
    await dana.record.sync();
    claimItem(annaDb.db, { itemId: item.id });
    await anna.record.sync();
    await dana.record.sync();

    // Something unrelated changes the item on the record, so it pages again.
    updateItem(recordDb.db, item.id, { title: "Rate limiting, revised" });
    await anna.record.sync();
    await dana.record.sync();

    expect(seenBy(anna, item.id)?.title).toBe("Rate limiting, revised");
    expect(seenBy(dana, item.id)?.title).toBe("Rate limiting, revised");
    expect(seenBy(anna, item.id)?.assigneeId).toBe(annaPerson.id);
    expect(seenBy(dana, item.id)?.assigneeId).toBe(annaPerson.id);
  });

  it("is acknowledged, not reported as lost, when the record applied it and the answer never came back", async () => {
    const item = onTheRecord();
    await anna.record.sync();

    claimItem(annaDb.db, { itemId: item.id });
    anna.swallowNextAnswer = true;
    await anna.record.sync();
    expect(getItem(recordDb.db, item.id)?.assigneeId).toBe(annaPerson.id);

    // Replayed, and the record recognises its own claim.
    const replayed = await anna.record.sync();

    expect(replayed.superseded).toBe(0);
    expect(openMentionsForHuman(annaDb.db)).toEqual([]);
    expect(bodies(recordDb.db, item.id).filter((body) => body === "Claimed by Anna.")).toHaveLength(1);
  });
});

describe("an assignment on a managed desktop", () => {
  it("reaches the record and the other desktop, and says who made it", async () => {
    const item = onTheRecord();
    await anna.record.sync();
    await dana.record.sync();
    const annaDevice = getDevice(recordDb.db, anna.deviceId)!;
    const danaDevice = getDevice(recordDb.db, dana.deviceId)!;
    setSetting(annaDb.db, MANAGED_PERSON_ID_KEY, annaDevice.personId);
    setSetting(annaDb.db, MANAGED_PERSON_NAME_KEY, annaDevice.personName);

    // Dana is on the organisation's list and nowhere on Anna's desktop,
    // and Anna is offline: nobody here can name her yet. The assignment
    // is still made — queued, drawn as provisional — and the record
    // decides. (`managedIpc.test.ts` covers the picker adopting her row
    // when the list can be asked.)
    anna.online = false;
    const assigned = assignItem(annaDb.db, { itemId: item.id, personId: danaDevice.personId });
    expect(assigned).toMatchObject({ assigneeId: danaDevice.personId, assigneeName: null });
    expect(pendingCommands(annaDb.db).map((entry) => entry.kind)).toEqual(["assign"]);
    expect(itemsWithQueuedMoves(annaDb.db)).toEqual([item.id]);
    // Showing nobody new rather than somebody this machine cannot name.
    expect(seenBy(anna, item.id)?.assigneeId).toBeNull();

    anna.online = true;
    await anna.record.sync();
    await dana.record.sync();

    expect(itemsWithQueuedMoves(annaDb.db)).toEqual([]);
    expect(getItem(recordDb.db, item.id)?.assigneeId).toBe(danaDevice.personId);
    expect(seenBy(dana, item.id)?.assigneeId).toBe(danaDevice.personId);
    expect(seenBy(anna, item.id)?.assigneeId).toBe(danaDevice.personId);
    expect(listCommentsForItem(recordDb.db, item.id).map((comment) => comment.body)).toContain("Assigned to Dana by Anna.");
    expect(listCommentsForItem(danaDb.db, item.id).map((comment) => comment.body)).toContain("Assigned to Dana by Anna.");
    expect(getItem(recordDb.db, item.id)?.stepId).toBe("todo");
  });

  it("refused by the record puts back who the record has holding the item", async () => {
    const item = onTheRecord();
    await anna.record.sync();
    const annaDevice = getDevice(recordDb.db, anna.deviceId)!;
    setSetting(annaDb.db, MANAGED_PERSON_ID_KEY, annaDevice.personId);
    setSetting(annaDb.db, MANAGED_PERSON_NAME_KEY, annaDevice.personName);
    claimItem(annaDb.db, { itemId: item.id });
    await anna.record.sync();

    // Somebody this desktop has a row for and the record does not — a
    // colleague who left, an old local row.
    const ghost = createPerson(annaDb.db, { name: "Ghost" });
    assignItem(annaDb.db, { itemId: item.id, personId: ghost.id });
    expect(seenBy(anna, item.id)?.assigneeId).toBe(ghost.id);

    const drained = await anna.record.sync();

    // The record wrote nothing, so no newer row came down to repair it:
    // the refusal itself carried Anna back.
    expect(drained.refused).toBe(1);
    expect(getItem(recordDb.db, item.id)?.assigneeId).toBe(annaDevice.personId);
    expect(seenBy(anna, item.id)?.assigneeId).toBe(annaDevice.personId);
    expect(itemsWithQueuedMoves(annaDb.db)).toEqual([]);
    expect(listCommentsForItem(annaDb.db, item.id).map((comment) => comment.body)).toContainEqual(
      expect.stringContaining("no such person"),
    );
  });
});

describe("a claim from a machine the record cannot put a person to", () => {
  it("is refused, and the desktop stops showing it", async () => {
    // A device whose row the record does not have — revoked, or a token
    // from another organisation's server.
    const strangerDb = openMigratedTestDb();
    const stranger = desktop(strangerDb, "a-laptop-nobody-issued");
    try {
      const item = onTheRecord();
      await stranger.record.sync();
      setSetting(strangerDb.db, MANAGED_PERSON_ID_KEY, "0190a000-0000-7000-8000-00000000abcd");
      setSetting(strangerDb.db, MANAGED_PERSON_NAME_KEY, "Sam");

      claimItem(strangerDb.db, { itemId: item.id });
      expect(seenBy(stranger, item.id)?.assigneeId).toBe("0190a000-0000-7000-8000-00000000abcd");

      const drained = await stranger.record.sync();

      expect(drained.refused).toBe(1);
      expect(getItem(recordDb.db, item.id)?.assigneeId).toBeNull();
      expect(seenBy(stranger, item.id)?.assigneeId).toBeNull();
      expect(queuedCommandCount(strangerDb.db)).toBe(0);
    } finally {
      stranger.record.stop();
      strangerDb.close();
    }
  });
});

describe("a claim on a moved item, on a desktop with nobody signed in", () => {
  it("shows nobody rather than the local you, and the record names the person", async () => {
    // Anna's desktop, with no sign-in remembered — the settings a
    // sign-out clears. Her device row still stands on the record.
    const item = onTheRecord();
    await anna.record.sync();

    const claimed = claimItem(annaDb.db, { itemId: item.id });

    expect(claimed.assigneeId).toBeNull();
    expect(claimed.assigneeId).not.toBe(LOCAL_PERSON_ID);
    expect(seenBy(anna, item.id)?.assigneeId).toBeNull();
    expect(pendingCommands(annaDb.db).map((entry) => entry.kind)).toEqual(["claim"]);
    expect(itemsWithQueuedMoves(annaDb.db)).toEqual([item.id]);

    await anna.record.sync();

    const annaPerson = getDevice(recordDb.db, anna.deviceId)!.personId;
    expect(getItem(recordDb.db, item.id)?.assigneeId).toBe(annaPerson);
    expect(seenBy(anna, item.id)?.assigneeId).toBe(annaPerson);
    expect(listCommentsForItem(annaDb.db, item.id).map((comment) => comment.body)).toContain("Claimed by Anna.");
  });
});

describe("a claim on a desktop signed in to nothing", () => {
  it("is decided there and then, and queues nothing", () => {
    const soloDb = openMigratedTestDb();
    const record = createDeviceRecord({ db: soloDb.db, deviceId: () => "local", transport: () => null });
    try {
      const item = createTestItem(soloDb.db, { type: "story", title: "Solo work", stepId: "todo" });

      const claimed = claimItem(soloDb.db, { itemId: item.id });

      expect(claimed.assigneeId).toBe(LOCAL_PERSON_ID);
      expect(getItem(soloDb.db, item.id)?.assigneeId).toBe(LOCAL_PERSON_ID);
      expect(getComment(soloDb.db, claimed.commentId as Uuid)?.body).toBe("Claimed by you.");
      expect(queuedCommandCount(soloDb.db)).toBe(0);
    } finally {
      record.stop();
      soloDb.close();
    }
  });
});

/**
 * A human step owned by a group (EO-368, the revised decision on EO-366).
 *
 * Design approves on `ready_to_merge`. Who may act there is two facts —
 * membership of Design, and who holds the item — and the record is where
 * they are enforced, with the person resolved from the device a command
 * arrived on. A refusal is dropped and said in the refused person's inbox,
 * and what their desktop showed at once is put back by the record's answer.
 */
describe("a human step owned by a group", () => {
  const APPROVE = "ready_to_merge";
  let annaPerson: { id: string; name: string };
  let danaPerson: { id: string; name: string };
  let designId: string;

  /** This machine's sign-in, as `rememberSession` writes it. */
  function signInAs(machine: Desktop): { id: string; name: string } {
    const device = getDevice(recordDb.db, machine.deviceId)!;
    setSetting(machine.handle.db, MANAGED_PERSON_ID_KEY, device.personId);
    setSetting(machine.handle.db, MANAGED_PERSON_NAME_KEY, device.personName);
    return { id: device.personId, name: device.personName };
  }

  /**
   * Design, with these people in it, owning the approve step — on the
   * record, where it is enforced, and on each desktop's copy of the
   * graph, the way a published pipeline carries `owner_group_id` down.
   */
  function design(...members: { id: string }[]): void {
    designId = saveGroup(recordDb.db, { name: "Design", memberIds: members.map((member) => member.id) }).id;
    for (const db of [recordDb.db, annaDb.db, danaDb.db]) setStepOwner(db, APPROVE, { personId: null, groupId: designId });
  }

  /** An item waiting at Design's step, unclaimed, that both desktops have seen. */
  async function waitingOnDesign(): Promise<Item> {
    const item = createTestItem(recordDb.db, { type: "story", title: "Launch post", stepId: APPROVE });
    await anna.record.sync();
    await dana.record.sync();
    return item;
  }

  /** Everybody syncs, in an order that lets every answer reach every machine. */
  async function everybodySyncs(): Promise<void> {
    await anna.record.sync();
    await dana.record.sync();
    await anna.record.sync();
  }

  /** The open human mentions on one desktop, as the bodies of their comments. */
  function inboxOf(machine: Desktop): string[] {
    return openMentionsForHuman(machine.handle.db).map((mention) => mention.comment.body);
  }

  /** The machine's person claims it, and the record applies the claim. */
  async function heldBy(machine: Desktop, item: Item): Promise<void> {
    claimItem(machine.handle.db, { itemId: item.id });
    await everybodySyncs();
    expect(getItem(recordDb.db, item.id)?.assigneeId).toBe(getDevice(recordDb.db, machine.deviceId)!.personId);
  }

  const decide = (machine: Desktop, item: Item) =>
    decideItem(machine.handle.db, undefined, { itemId: item.id, resultKey: "send_back", comment: "The headline is wrong." });
  const move = (machine: Desktop, item: Item) =>
    moveItem(machine.handle.db, undefined, { itemId: item.id, toStepId: "todo", comment: "", cancelActiveRun: false });

  beforeEach(() => {
    annaPerson = signInAs(anna);
    danaPerson = signInAs(dana);
  });

  describe("somebody who is not in the group", () => {
    beforeEach(() => design(danaPerson));

    it("cannot claim it: the record keeps nobody holding it, and tells them which group it waits on", async () => {
      const item = await waitingOnDesign();

      claimItem(annaDb.db, { itemId: item.id });
      // Shown at once, as any claim is…
      expect(seenBy(anna, item.id)?.assigneeId).toBe(annaPerson.id);
      await everybodySyncs();

      // …and refused by the record, which wrote nothing.
      expect(getItem(recordDb.db, item.id)?.assigneeId).toBeNull();
      expect(seenBy(anna, item.id)?.assigneeId).toBeNull();
      expect(seenBy(dana, item.id)?.assigneeId).toBeNull();
      const inbox = inboxOf(anna);
      expect(inbox).toHaveLength(1);
      expect(inbox[0]).toContain(`Your claim on ${item.key} was not applied`);
      expect(inbox[0]).toContain("Design");
      expect(listCommentsForItem(recordDb.db, item.id as Uuid).map((comment) => comment.body)).not.toContain("Claimed by Anna.");
      expect(queuedCommandCount(annaDb.db)).toBe(0);
    });

    it("cannot move it off the step: it stays put everywhere, and the record writes no transition", async () => {
      const item = await waitingOnDesign();
      const movesBefore = listTransitionsForItem(recordDb.db, item.id).map((transition) => transition.id);

      expect(move(anna, item).moved).toBe(true);
      // Provisional, on her own copy.
      expect(seenBy(anna, item.id)?.stepId).toBe("todo");
      await everybodySyncs();

      expect(getItem(recordDb.db, item.id)?.stepId).toBe(APPROVE);
      expect(seenBy(anna, item.id)?.stepId).toBe(APPROVE);
      expect(seenBy(dana, item.id)?.stepId).toBe(APPROVE);
      expect(listTransitionsForItem(recordDb.db, item.id).map((transition) => transition.id)).toEqual(movesBefore);
      const inbox = inboxOf(anna);
      expect(inbox).toHaveLength(1);
      expect(inbox[0]).toContain(`Your move on ${item.key} was not applied`);
      expect(inbox[0]).toContain("you are not in Design");
      expect(queuedCommandCount(annaDb.db)).toBe(0);
    });

    it("cannot decide on it either", async () => {
      const item = await waitingOnDesign();

      expect(decide(anna, item).decided).toBe(true);
      await everybodySyncs();

      expect(getItem(recordDb.db, item.id)?.stepId).toBe(APPROVE);
      expect(seenBy(anna, item.id)?.stepId).toBe(APPROVE);
      expect(inboxOf(anna)).toEqual([expect.stringContaining(`Your decision on ${item.key} was not applied`)]);
    });

    it("cannot edit it on the strength of a claim the record has not answered, and the refused claim leaves no edit behind", async () => {
      const item = await waitingOnDesign();

      claimItem(annaDb.db, { itemId: item.id });
      // Shown as hers at once — and still not hers to change.
      expect(seenBy(anna, item.id)?.assigneeId).toBe(annaPerson.id);
      const edited = updateItemText(annaDb.db, { itemId: item.id, title: "Anna's title", body: "Anna's body" });
      expect(edited).toMatchObject({ updated: false, problem: expect.stringContaining("it is not yours yet") });
      expect(seenBy(anna, item.id)?.title).toBe("Launch post");

      await everybodySyncs();

      expect(getItem(recordDb.db, item.id)?.assigneeId).toBeNull();
      for (const machine of [anna, dana]) {
        expect(seenBy(machine, item.id)?.title).toBe("Launch post");
        expect(seenBy(machine, item.id)?.body).toBe(getItem(recordDb.db, item.id)?.body);
      }
      expect(getItem(recordDb.db, item.id)?.title).toBe("Launch post");
    });

    it("can still comment on it, and the comment reaches the record", async () => {
      const item = await waitingOnDesign();

      anna.record.postComment({ itemId: item.id as Uuid, author: { type: "human" }, body: "Can we use the blue hero image?" });
      await everybodySyncs();

      expect(listCommentsForItem(recordDb.db, item.id as Uuid).map((comment) => comment.body)).toContain("Can we use the blue hero image?");
      expect(listCommentsForItem(danaDb.db, item.id as Uuid).map((comment) => comment.body)).toContain("Can we use the blue hero image?");
      expect(inboxOf(anna)).toEqual([]);
    });

    it("is refused the same way when they ask the record directly, from a browser", async () => {
      const item = await waitingOnDesign();
      const asAnna = { actingDeviceId: anna.deviceId };

      const claimed = claimItem(recordDb.db, { itemId: item.id, ...asAnna });
      const moved = moveItem(recordDb.db, undefined, { itemId: item.id, toStepId: "todo", comment: "", cancelActiveRun: false, ...asAnna });
      const decided = decideItem(recordDb.db, undefined, { itemId: item.id, resultKey: "send_back", comment: "No.", ...asAnna });
      const edited = updateItemText(recordDb.db, { itemId: item.id, title: "Renamed by Anna", ...asAnna });

      expect(claimed.problem).toContain("Design");
      expect(moved).toMatchObject({ moved: false, problem: expect.stringContaining("you are not in Design") });
      expect(decided).toMatchObject({ decided: false, problem: expect.stringContaining("you are not in Design") });
      expect(edited).toMatchObject({ updated: false, problem: expect.stringContaining("you are not in Design") });
      const onTheRecordNow = getItem(recordDb.db, item.id)!;
      expect(onTheRecordNow.assigneeId).toBeNull();
      expect(onTheRecordNow.stepId).toBe(APPROVE);
      expect(onTheRecordNow.title).toBe("Launch post");
      expect(listTransitionsForItem(recordDb.db, item.id)).toEqual([]);
      // Each one said, in Anna's inbox on the record.
      const annas = openMentionsForHuman(recordDb.db, annaPerson.id as Uuid).map((mention) => mention.comment.body);
      expect(annas).toHaveLength(4);
      for (const line of annas) expect(line).toContain("Design");
      // …and the screen asking who may act is told she may not.
      expect((await itemAuthorityCommand(recordDb.db, { itemId: item.id, ...asAnna })).authority).toMatchObject({
        group: { name: "Design" },
        you: "outsider",
      });
    });
  });

  describe("two members, one of them holding it", () => {
    beforeEach(() => design(annaPerson, danaPerson));

    it("drops the other member's decision and move, and names the holder", async () => {
      const item = await waitingOnDesign();
      await heldBy(anna, item);

      decide(dana, item);
      await dana.record.sync();
      expect(getItem(recordDb.db, item.id)?.stepId).toBe(APPROVE);
      expect(seenBy(dana, item.id)?.stepId).toBe(APPROVE);

      move(dana, item);
      await everybodySyncs();

      expect(getItem(recordDb.db, item.id)?.stepId).toBe(APPROVE);
      expect(seenBy(anna, item.id)?.stepId).toBe(APPROVE);
      expect(seenBy(dana, item.id)?.stepId).toBe(APPROVE);
      // Still Anna's on every machine — arriving back on the step did not
      // leave it unclaimed on Dana's.
      expect(seenBy(dana, item.id)?.assigneeId).toBe(annaPerson.id);
      const inbox = inboxOf(dana);
      expect(inbox).toHaveLength(2);
      expect(inbox).toContainEqual(expect.stringContaining(`Your decision on ${item.key} was not applied: Anna holds it`));
      expect(inbox).toContainEqual(expect.stringContaining(`Your move on ${item.key} was not applied: Anna holds it`));
      expect(inboxOf(anna)).toEqual([]);
    });

    it("drops the other member's assistant's decision on live work, as it drops theirs, and applies it on a trial item (EO-585)", async () => {
      // Dana's system agent pressing the result through her desktop's
      // administrative host: it acts with her authority and no more, so
      // on a step Anna holds it is refused by the record exactly as
      // Dana's own press is — not waved through for not being "human".
      const assistant = createAgent(danaDb.db, { name: "Assistant", role: "system", provider: "claude", instructions: "", config: { allowedTools: ["mcp__eo_admin"] } });
      const asAssistant = (item: Item) =>
        decideItem(danaDb.db, undefined, { itemId: item.id, resultKey: "send_back", comment: "The headline is wrong.", actingAgentId: assistant.id });

      const live = await waitingOnDesign();
      await heldBy(anna, live);
      asAssistant(live);
      await everybodySyncs();

      expect(getItem(recordDb.db, live.id)?.stepId).toBe(APPROVE);
      expect(seenBy(dana, live.id)?.stepId).toBe(APPROVE);
      expect(listTransitionsForItem(recordDb.db, live.id)).toEqual([]);
      expect(inboxOf(dana)).toContainEqual(expect.stringContaining(`Your decision on ${live.key} was not applied: Anna holds it`));

      // On a trial item the assistant stands in for whoever the step
      // would ask, so no hold binds it.
      const trial = createTestItem(recordDb.db, { type: "story", title: "A test item", stepId: APPROVE, trialAt: Date.now() });
      await everybodySyncs();
      await heldBy(anna, trial);
      asAssistant(trial);
      await everybodySyncs();

      expect(getItem(recordDb.db, trial.id)?.stepId).not.toBe(APPROVE);
      expect(listTransitionsForItem(recordDb.db, trial.id).at(-1)?.actor).toBe(assistant.id);
    });

    it("does not apply the other member's edit to the item's title or body", async () => {
      const item = await waitingOnDesign();
      await heldBy(anna, item);

      const edited = updateItemText(danaDb.db, { itemId: item.id, title: "Dana's title", body: "Dana's body" });
      await everybodySyncs();

      expect(edited.updated).toBe(false);
      expect(edited.problem).toContain("Anna holds it");
      expect(getItem(recordDb.db, item.id)?.title).toBe("Launch post");
      expect(seenBy(dana, item.id)?.title).toBe("Launch post");
      expect(seenBy(dana, item.id)?.body).toBe(getItem(recordDb.db, item.id)?.body);
      expect(inboxOf(dana)).toEqual([expect.stringContaining(`Your edit on ${item.key} was not applied`)]);
      // And the record refuses it the same way when Dana asks it directly.
      expect(updateItemText(recordDb.db, { itemId: item.id, title: "Dana's title", actingDeviceId: dana.deviceId })).toMatchObject({
        updated: false,
        problem: expect.stringContaining("Anna holds it"),
      });
      expect(getItem(recordDb.db, item.id)?.title).toBe("Launch post");
    });

    it("lets the other member take it over from the holder they were warned about, and tells the holder", async () => {
      const item = await waitingOnDesign();
      await heldBy(anna, item);

      const taken = takeOverItem(danaDb.db, { itemId: item.id, fromPersonId: annaPerson.id });
      expect(taken.assigneeId).toBe(danaPerson.id);
      expect(pendingCommands(danaDb.db).map((entry) => entry.kind)).toEqual(["takeover"]);
      await everybodySyncs();

      expect(getItem(recordDb.db, item.id)?.assigneeId).toBe(danaPerson.id);
      expect(seenBy(anna, item.id)?.assigneeId).toBe(danaPerson.id);
      expect(seenBy(dana, item.id)?.assigneeId).toBe(danaPerson.id);
      for (const db of [recordDb.db, annaDb.db, danaDb.db]) {
        expect(listCommentsForItem(db, item.id as Uuid).map((comment) => comment.body)).toContain("Dana took this over from Anna.");
      }
      // Anna hears it in her inbox; Dana, who did it, does not.
      expect(inboxOf(anna)).toEqual(["Dana took this over from Anna."]);
      expect(inboxOf(dana)).toEqual([]);
      // Not a transition.
      expect(getItem(recordDb.db, item.id)?.stepId).toBe(APPROVE);
      expect(listTransitionsForItem(recordDb.db, item.id)).toEqual([]);
    });

    it("after a takeover, decides by the new holder and refuses the previous one", async () => {
      const item = await waitingOnDesign();
      await heldBy(anna, item);
      takeOverItem(danaDb.db, { itemId: item.id, fromPersonId: annaPerson.id });
      await everybodySyncs();

      decide(anna, item);
      await anna.record.sync();
      expect(getItem(recordDb.db, item.id)?.stepId).toBe(APPROVE);
      expect(inboxOf(anna)).toContainEqual(expect.stringContaining(`Your decision on ${item.key} was not applied: Dana holds it`));

      decide(dana, item);
      await everybodySyncs();
      expect(getItem(recordDb.db, item.id)?.stepId).toBe("todo");
      expect(seenBy(anna, item.id)?.stepId).toBe("todo");
      expect(inboxOf(dana)).toEqual([]);
    });

    it("drops a takeover from somebody who no longer holds it, and names who does", async () => {
      const item = await waitingOnDesign();
      await heldBy(anna, item);
      // Pat is in Design too, and takes it from Anna in a browser while
      // Dana is looking at a warning that still names Anna.
      const patDevice = deviceFor("Pat", "pat@example.com", "pat-browser");
      const pat = getDevice(recordDb.db, patDevice)!.personId;
      saveGroup(recordDb.db, { id: designId, name: "Design", memberIds: [annaPerson.id, danaPerson.id, pat] });

      takeOverItem(danaDb.db, { itemId: item.id, fromPersonId: annaPerson.id });
      expect(takeOverItem(recordDb.db, { itemId: item.id, fromPersonId: annaPerson.id, actingDeviceId: patDevice }).problem).toBeNull();
      await everybodySyncs();

      expect(getItem(recordDb.db, item.id)?.assigneeId).toBe(pat);
      expect(seenBy(dana, item.id)?.assigneeId).toBe(pat);
      const inbox = inboxOf(dana);
      expect(inbox).toHaveLength(1);
      expect(inbox[0]).toContain(`Your takeover on ${item.key} was not applied`);
      expect(inbox[0]).toContain("it is held by Pat now");
      expect(listCommentsForItem(recordDb.db, item.id as Uuid).map((comment) => comment.body)).not.toContain("Dana took this over from Anna.");
    });

    it("drops a takeover even when the item has since reached the sender some other way, and says it is theirs", async () => {
      const item = await waitingOnDesign();
      await heldBy(anna, item);

      // Dana confirms a warning naming Anna; before her takeover reaches
      // the record, Anna hands the item to her in a browser.
      takeOverItem(danaDb.db, { itemId: item.id, fromPersonId: annaPerson.id });
      assignItem(recordDb.db, { itemId: item.id, personId: danaPerson.id, actingDeviceId: anna.deviceId });
      const before = listCommentsForItem(recordDb.db, item.id as Uuid).map((comment) => comment.body);
      await everybodySyncs();

      // Not acknowledged as though it had landed: nothing was taken from
      // Anna by this takeover, so nothing says it was.
      expect(getItem(recordDb.db, item.id)?.assigneeId).toBe(danaPerson.id);
      expect(seenBy(dana, item.id)?.assigneeId).toBe(danaPerson.id);
      expect(listCommentsForItem(recordDb.db, item.id as Uuid).map((comment) => comment.body)).toEqual(before);
      expect(inboxOf(anna)).toEqual([]);
      const inbox = inboxOf(dana);
      expect(inbox).toHaveLength(1);
      expect(inbox[0]).toContain(`Your takeover on ${item.key} was not applied: it has changed hands since you were warned`);
      expect(inbox[0]).toContain("it is held by you (Dana) now");
    });

    it("drops a takeover that arrives after the item has left the step, and tells the sender in their inbox", async () => {
      const item = await waitingOnDesign();
      await heldBy(anna, item);

      // Dana confirms the warning offline; meanwhile Anna sends the item
      // back from a browser, off Design's step.
      dana.online = false;
      takeOverItem(danaDb.db, { itemId: item.id, fromPersonId: annaPerson.id });
      expect(decideItem(recordDb.db, undefined, { itemId: item.id, resultKey: "send_back", comment: "Back to drafting.", actingDeviceId: anna.deviceId }).decided).toBe(true);
      dana.online = true;
      await everybodySyncs();

      expect(getItem(recordDb.db, item.id)).toMatchObject({ stepId: "todo", assigneeId: annaPerson.id });
      expect(seenBy(dana, item.id)?.assigneeId).toBe(annaPerson.id);
      expect(listCommentsForItem(recordDb.db, item.id as Uuid).map((comment) => comment.body)).not.toContain("Dana took this over from Anna.");
      const inbox = inboxOf(dana);
      expect(inbox).toHaveLength(1);
      expect(inbox[0]).toContain(`Your takeover on ${item.key} was not applied: ${item.key} has moved on and no longer waits on a group`);
      expect(queuedCommandCount(danaDb.db)).toBe(0);
    });

    it("does not let a takeover the record has not answered authorise an edit, and leaves none behind when it is refused", async () => {
      const item = await waitingOnDesign();
      await heldBy(anna, item);
      const patDevice = deviceFor("Pat", "pat@example.com", "pat-browser");
      const pat = getDevice(recordDb.db, patDevice)!.personId;
      saveGroup(recordDb.db, { id: designId, name: "Design", memberIds: [annaPerson.id, danaPerson.id, pat] });

      takeOverItem(danaDb.db, { itemId: item.id, fromPersonId: annaPerson.id });
      expect(seenBy(dana, item.id)?.assigneeId).toBe(danaPerson.id);
      expect(updateItemText(danaDb.db, { itemId: item.id, title: "Dana's title" })).toMatchObject({
        updated: false,
        problem: expect.stringContaining("it is not yours yet"),
      });
      // Pat takes it from Anna first, so Dana's takeover is refused.
      takeOverItem(recordDb.db, { itemId: item.id, fromPersonId: annaPerson.id, actingDeviceId: patDevice });
      await everybodySyncs();

      expect(getItem(recordDb.db, item.id)?.assigneeId).toBe(pat);
      expect(seenBy(dana, item.id)?.assigneeId).toBe(pat);
      expect(seenBy(dana, item.id)?.title).toBe("Launch post");
      expect(getItem(recordDb.db, item.id)?.title).toBe("Launch post");
    });

    it("lets the holder edit their own copy once the record has confirmed the takeover", async () => {
      const item = await waitingOnDesign();
      await heldBy(anna, item);
      takeOverItem(danaDb.db, { itemId: item.id, fromPersonId: annaPerson.id });
      await everybodySyncs();

      expect(updateItemText(danaDb.db, { itemId: item.id, title: "Dana's title" })).toMatchObject({ updated: true, problem: null });
    });

    it("is refused the same way when the other member asks the record directly, from a browser", async () => {
      const item = await waitingOnDesign();
      await heldBy(anna, item);
      const asDana = { actingDeviceId: dana.deviceId };

      expect(claimItem(recordDb.db, { itemId: item.id, ...asDana })).toMatchObject({ assigneeId: annaPerson.id, problem: expect.stringContaining("Anna holds it") });
      expect(moveItem(recordDb.db, undefined, { itemId: item.id, toStepId: "todo", comment: "", cancelActiveRun: false, ...asDana }).moved).toBe(false);
      expect(decideItem(recordDb.db, undefined, { itemId: item.id, resultKey: "send_back", comment: "No.", ...asDana }).decided).toBe(false);
      expect(takeOverItem(recordDb.db, { itemId: item.id, fromPersonId: danaPerson.id, ...asDana }).problem).toContain("it is held by Anna now");

      expect(getItem(recordDb.db, item.id)).toMatchObject({ assigneeId: annaPerson.id, stepId: APPROVE });
      expect(listTransitionsForItem(recordDb.db, item.id)).toEqual([]);
      const danas = openMentionsForHuman(recordDb.db, danaPerson.id as Uuid).map((mention) => mention.comment.body);
      expect(danas).toHaveLength(4);
      for (const line of danas) expect(line).toContain("Anna");
      expect((await itemAuthorityCommand(recordDb.db, { itemId: item.id, ...asDana })).authority).toMatchObject({
        holder: { id: annaPerson.id, name: "Anna" },
        you: "member",
      });
      expect((await itemAuthorityCommand(recordDb.db, { itemId: item.id, actingDeviceId: anna.deviceId })).authority?.you).toBe("holder");

      // …and the takeover itself, from a browser, warned about the right person.
      expect(takeOverItem(recordDb.db, { itemId: item.id, fromPersonId: annaPerson.id, ...asDana })).toMatchObject({
        assigneeId: danaPerson.id,
        problem: null,
      });
      expect(openMentionsForHuman(recordDb.db, annaPerson.id as Uuid).map((mention) => mention.comment.body)).toContain(
        "Dana took this over from Anna.",
      );
    });

    it("lets the member who does not hold it comment", async () => {
      const item = await waitingOnDesign();
      await heldBy(anna, item);

      dana.record.postComment({ itemId: item.id as Uuid, author: { type: "human" }, body: "I can take this if you are busy." });
      await everybodySyncs();

      expect(listCommentsForItem(recordDb.db, item.id as Uuid).map((comment) => comment.body)).toContain("I can take this if you are busy.");
      expect(inboxOf(dana)).toEqual([]);
    });
  });

  describe("an administrator outside the group", () => {
    beforeEach(() => {
      design(danaPerson);
      // Anna is an admin, and not in Design.
      updatePerson(recordDb.db, annaPerson.id as Uuid, { isAdmin: true });
    });

    it("cannot claim it or decide on it, but can take it over after the warning and then decide", async () => {
      const item = await waitingOnDesign();

      claimItem(annaDb.db, { itemId: item.id });
      await everybodySyncs();
      expect(getItem(recordDb.db, item.id)?.assigneeId).toBeNull();
      expect(inboxOf(anna)).toEqual([expect.stringContaining("you are not in Design")]);

      await heldBy(dana, item);
      decide(anna, item);
      await everybodySyncs();
      expect(getItem(recordDb.db, item.id)?.stepId).toBe(APPROVE);
      // Her decision's own words answered the earlier row, so the inbox
      // holds the newest refusal: not in Design, and not yet hers.
      expect(inboxOf(anna)).toEqual([expect.stringContaining(`Your decision on ${item.key} was not applied: ${item.key} waits on Design`)]);

      takeOverItem(annaDb.db, { itemId: item.id, fromPersonId: danaPerson.id });
      await everybodySyncs();
      expect(getItem(recordDb.db, item.id)?.assigneeId).toBe(annaPerson.id);
      expect(inboxOf(dana)).toEqual(["Anna took this over from Dana."]);

      decide(anna, item);
      await everybodySyncs();
      expect(getItem(recordDb.db, item.id)?.stepId).toBe("todo");
      expect(seenBy(dana, item.id)?.stepId).toBe("todo");
    });
  });

  describe("an item nobody holds yet", () => {
    beforeEach(() => design(annaPerson, danaPerson));

    it("refuses a member's decision until they claim it, then applies the same decision", async () => {
      const item = await waitingOnDesign();

      decide(dana, item);
      await everybodySyncs();
      expect(getItem(recordDb.db, item.id)?.stepId).toBe(APPROVE);
      expect(seenBy(dana, item.id)?.stepId).toBe(APPROVE);
      expect(inboxOf(dana)).toEqual([expect.stringContaining("nobody holds it yet")]);

      claimItem(danaDb.db, { itemId: item.id });
      decide(dana, item);
      await everybodySyncs();

      expect(getItem(recordDb.db, item.id)?.assigneeId).toBe(danaPerson.id);
      expect(getItem(recordDb.db, item.id)?.stepId).toBe("todo");
      expect(seenBy(anna, item.id)?.stepId).toBe("todo");
    });
  });

  it("still applies a move off the step that an agent or the engine made", async () => {
    design(danaPerson);
    const item = await waitingOnDesign();
    const reviewer = createAgent(annaDb.db, { name: "Reviewer", role: "reviewer", provider: "claude", instructions: "Review it.", enabled: true });

    anna.record.applyTransition({ itemId: item.id as Uuid, toStepId: "todo", actor: reviewer.id });
    await everybodySyncs();
    expect(getItem(recordDb.db, item.id)?.stepId).toBe("todo");

    theRecord.applyTransition({ itemId: item.id as Uuid, toStepId: APPROVE, actor: "engine" });
    await everybodySyncs();
    anna.record.applyTransition({ itemId: item.id as Uuid, toStepId: "review", actor: "engine" });
    await everybodySyncs();
    expect(getItem(recordDb.db, item.id)?.stepId).toBe("review");
    expect(inboxOf(anna)).toEqual([]);
  });

  it("leaves a human step with no owner, and one naming a single person, open to anybody signed in", async () => {
    // No owner: Anna claims and moves an item that is nobody's.
    const unowned = await waitingOnDesign();
    claimItem(annaDb.db, { itemId: unowned.id });
    await everybodySyncs();
    move(dana, unowned);
    await everybodySyncs();
    expect(getItem(recordDb.db, unowned.id)).toMatchObject({ assigneeId: annaPerson.id, stepId: "todo" });

    // Dana's step: Anna, who is not Dana, claims and moves it as before.
    const hers = await waitingOnDesign();
    // On the record, which is where who may act is decided.
    setStepOwner(recordDb.db, APPROVE, { personId: danaPerson.id as Uuid, groupId: null });
    claimItem(annaDb.db, { itemId: hers.id });
    await everybodySyncs();
    move(anna, hers);
    await everybodySyncs();
    expect(getItem(recordDb.db, hers.id)).toMatchObject({ assigneeId: annaPerson.id, stepId: "todo" });
    expect(inboxOf(anna)).toEqual([]);
    expect(inboxOf(dana)).toEqual([]);
  });
});

describe("a group-owned human step on a desktop signed in to nothing", () => {
  it("claims, edits and moves as it always has, refusing nothing and warning about nobody", async () => {
    const soloDb = openMigratedTestDb();
    const record = createDeviceRecord({ db: soloDb.db, deviceId: () => "local", transport: () => null });
    try {
      const group = saveGroup(soloDb.db, { name: "Design", memberIds: [] });
      setStepOwner(soloDb.db, "ready_to_merge", { personId: null, groupId: group.id });
      const item = createTestItem(soloDb.db, { type: "story", title: "Solo post", stepId: "ready_to_merge" });

      expect((await itemAuthorityCommand(soloDb.db, { itemId: item.id })).authority).toBeNull();
      expect(claimItem(soloDb.db, { itemId: item.id })).toMatchObject({ assigneeId: LOCAL_PERSON_ID, problem: null });
      expect(updateItemText(soloDb.db, { itemId: item.id, title: "Solo post, revised" })).toMatchObject({ updated: true });
      expect(moveItem(soloDb.db, undefined, { itemId: item.id, toStepId: "todo", comment: "", cancelActiveRun: false }).moved).toBe(true);

      expect(getItem(soloDb.db, item.id)).toMatchObject({ title: "Solo post, revised", stepId: "todo", assigneeId: LOCAL_PERSON_ID });
      expect(openMentionsForHuman(soloDb.db)).toEqual([]);
      expect(queuedCommandCount(soloDb.db)).toBe(0);
    } finally {
      record.stop();
      soloDb.close();
    }
  });
});

describe("a pipeline's entry rules on the record (EO-610)", () => {
  /** A second pipeline with one step, on a database, asking for `rules`. */
  function intakeOn(db: DbHandle["db"], rules: EntryRule[]): void {
    db.insert(pipelines).values({ id: "intake", name: "Intake", position: 9, entryRules: rules, createdAt: 1, updatedAt: 1 }).run();
    db.insert(pipelineSteps).values({ id: "intake-front", pipelineId: "intake", position: 0, name: "Triage", type: "user" }).run();
  }
  const moveIn = (machine: Desktop, item: Item) =>
    moveItem(machine.handle.db, undefined, { itemId: item.id, toStepId: "intake-front", toPipelineId: "intake" as Uuid, comment: "", cancelActiveRun: false });

  it("refuses a device's move its own copy let through, tells the person, and puts the item back", async () => {
    intakeOn(recordDb.db, [{ kind: "description" }]);
    // This desktop's copy has not caught up with the rule.
    intakeOn(annaDb.db, []);
    const item = onTheRecord();
    await anna.record.sync();

    expect(moveIn(anna, item).moved).toBe(true);
    expect(seenBy(anna, item.id)?.pipelineId).toBe("intake");
    await anna.record.sync();

    expect(getItem(recordDb.db, item.id)).toMatchObject({ stepId: "todo", pipelineId: "default" });
    expect(seenBy(anna, item.id)).toMatchObject({ stepId: "todo", pipelineId: "default" });
    const inbox = openMentionsForHuman(annaDb.db).map((mention) => mention.comment.body);
    expect(inbox).toEqual([`Your move on ${item.key} was not applied: "Intake" needs these before work can enter it: a description.`]);
    expect(queuedCommandCount(annaDb.db)).toBe(0);
  });

  it("refuses it at the device first, where its copy has the rule", async () => {
    intakeOn(recordDb.db, [{ kind: "description" }]);
    intakeOn(annaDb.db, [{ kind: "description" }]);
    const item = onTheRecord();
    await anna.record.sync();

    expect(moveIn(anna, item)).toMatchObject({ moved: false, problem: expect.stringContaining("a description") });
    expect(queuedCommandCount(annaDb.db)).toBe(0);
  });

  it("applies a move that meets them", async () => {
    intakeOn(recordDb.db, [{ kind: "description" }]);
    intakeOn(annaDb.db, []);
    const item = createTestItem(recordDb.db, { type: "story", title: "Written", body: "It says something.", stepId: "todo" });
    await anna.record.sync();

    moveIn(anna, item);
    await anna.record.sync();

    expect(getItem(recordDb.db, item.id)).toMatchObject({ stepId: "intake-front", pipelineId: "intake" });
  });

  it("does not ask of a rehearsal, or of work cleared off a step that is going", async () => {
    intakeOn(recordDb.db, [{ kind: "description" }]);
    intakeOn(annaDb.db, []);
    const trial = createTestItem(recordDb.db, { type: "story", title: "A rehearsal", stepId: "todo", trialAt: 1 });
    const cleared = onTheRecord("Cleared");
    await anna.record.sync();

    moveIn(anna, trial);
    moveStepItemsCommand(annaDb.db, { fromStepId: "todo", toStepId: "intake-front" });
    await anna.record.sync();

    expect(getItem(recordDb.db, trial.id)?.pipelineId).toBe("intake");
    expect(getItem(recordDb.db, cleared.id)?.pipelineId).toBe("intake");
  });

  it("travels with a pipeline to a replica, on the pipeline and on its versions", () => {
    const rules: EntryRule[] = [{ kind: "description" }];
    replacePipelineGraph(recordDb.db, "default", listStepsForPipeline(recordDb.db, "default"), listRoutesForPipeline(recordDb.db, "default"), { entryRules: rules });
    const page = listPipelinesUpdatedSince(recordDb.db, { ts: 0, id: "" }, 500).find((pipeline) => pipeline.id === "default");
    const current = page!.versions.find((version) => version.id === page!.currentVersionId);

    expect(page?.entryRules).toEqual(rules);
    expect(current?.entryRules).toEqual(rules);
    expect(RecordPipelineSchema.parse(JSON.parse(JSON.stringify(page))).entryRules).toEqual(rules);

    upsertReplicaPipeline(annaDb.db, RecordPipelineSchema.parse(JSON.parse(JSON.stringify({ ...page, id: "arrived", projectId: null, steps: [], routes: [], versions: [], currentVersionId: null, entryStepId: null }))));
    expect(getPipeline(annaDb.db, "arrived")?.entryRules).toEqual(rules);
  });
});
