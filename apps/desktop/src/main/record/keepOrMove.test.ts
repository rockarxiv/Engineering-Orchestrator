import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EMPTY_SPEC_SHAPE, LOCAL_PERSON_ID, type IpcPayload, type Item, type RecordAdoptCounts, type Uuid } from "@eo/core";
import { sql } from "drizzle-orm";
import { buildTickInput } from "../supervisor/buildTickInput.js";
import type { DbHandle } from "../db/client.js";
import { createTestItem, messagesAboutJob, openMigratedTestDb } from "../db/testHelpers.js";
import { getItemWatch, startItemWatch, updateItemWatch } from "../db/repos/itemWatchesRepo.js";
import {
  abandonAdoption,
  beginAdoption,
  createProject,
  getProject,
  keepProjectLocal,
  listProjects,
  listUndecidedProjects,
  updateProject,
} from "../db/repos/projectsRepo.js";
import { createPerson } from "../db/repos/peopleRepo.js";
import { issueDevice } from "../db/repos/devicesRepo.js";
import { getItem, linkJiraKey, setItemAssignee, updateItem } from "../db/repos/itemsRepo.js";
import { addDependency, listDependencies, removeDependency } from "../db/repos/itemDepsRepo.js";
import { extensionsForItem, setItemExtension } from "../db/repos/itemExtensionsRepo.js";
import { listTransitionsForItem } from "../db/repos/transitionsRepo.js";
import {
  dismissOpenMentionsForComment,
  getComment,
  listCommentsForItem,
  listMentionsForComment,
  needsAttention,
  openMentionsForHuman,
  postComment,
  resolveMentions,
  setCommentPinned,
} from "../db/repos/commentsRepo.js";
import { createRun, updateRun } from "../db/repos/runsRepo.js";
import { appendRunEvent } from "../db/repos/runEventsRepo.js";
import { setSetting } from "../db/repos/settingsRepo.js";
import {
  adoptPipeline,
  getPipeline,
  createPipeline,
  createRoute,
  createStep,
  setEntryStep,
  listPipelines,
  listRoutesForPipeline,
  listStepsForPipeline,
  updateStep,
} from "../db/repos/pipelineStepsRepo.js";
import { getJob, hasFiredAt, insertJob, listOccurrences, recordOccurrence, updateJobRow } from "../db/repos/jobsRepo.js";
import { getAttachment, insertAttachments } from "../db/repos/attachmentsRepo.js";
import { pendingCommands } from "../db/repos/recordCommandsRepo.js";
import { pendingPushesForItem } from "../db/repos/outboxRepo.js";
import { createGitWorkspace } from "../db/repos/workspacesRepo.js";
import { createItemType, getItemType, listItemTypes, resolveItemType } from "../db/repos/itemTypesRepo.js";
import { countProjectRows, projectItemIds } from "../db/repos/projectMoveRepo.js";
import { backfillsOwed } from "../db/repos/recordBackfillsRepo.js";
import { createLocalRecord, type LocalItemRecord } from "./localRecord.js";
import { createDeviceRecord, type DeviceRecord } from "./deviceRecord.js";
import { moveProjectToRecord, type AdoptRequest } from "./adopt.js";
import { serveAdopt, serveApply, serveChanges, serveRelease, serveRenew, serveWork, type ServeRecordContext } from "./serveRecord.js";
import type { RecordTransport } from "./syncStatus.js";
import { MANAGED_PERSON_ID_KEY, signedInPersonId } from "../identity/viewer.js";
import { AttachmentStorage } from "../attachments/storage.js";
import { runJobTick } from "../jobs/scheduler.js";
import { fireJob } from "../jobs/fire.js";

/** 2026-06-01 is a Monday. 08:00 in Berlin that day is 06:00Z. */
const MONDAY_0800 = Date.UTC(2026, 5, 1, 6, 0);
const WEEKLY_0800 = {
  kind: "schedule",
  schedule: { kind: "weekly", weekday: 1, hour: 8, minute: 0 },
  timeZone: "Europe/Berlin",
  catchUpWithinMinutes: 180,
} as const;
import { createProjectCommand, type KeepOrMoveContext } from "../ipc/projectCommands.js";

/**
 * Signing in with work already on the board (EO-325,
 * `ARCHITECTURE.md`, "What a person sees first",
 * "The record", "Identity").
 *
 * Three databases, as `sync.test.ts` has them: the organisation's
 * record, and two desktops — both **the same person's**, which is what
 * the third acceptance criterion is about. Anna has two projects of her
 * own when she signs in; she keeps one and moves the other, and every
 * claim below is about the difference that makes.
 *
 * The requests go through the same `serve*` functions `server/http.ts`
 * puts behind its door, so what is exercised is the record contract
 * rather than a stub of it. What is not here is a socket, which is
 * `server/smoke.test.ts`'s subject.
 */

let recordDb: DbHandle;
let annaDb: DbHandle;
let laptopDb: DbHandle;
let theRecord: LocalItemRecord;
let serving: ServeRecordContext;
let anna: Desktop;
let laptop: Desktop;
/** Anna, on the organisation's list. One person, two machines. */
let annaPersonId: Uuid;

const LIMITS = { globalConcurrency: 1, perAgentConcurrency: 1, perRepositoryConcurrency: 1 };

interface Desktop {
  handle: DbHandle;
  record: DeviceRecord;
  online: boolean;
  /**
   * Set true to take this machine's credential away.
   *
   * Signing out and being revoked are one thing from here: the token
   * is gone, so `managed.client()` answers null and the device has no
   * transport at all. Distinct from `online`, which is a network that
   * has dropped while the credential is still good.
   */
  signedOut: boolean;
  deviceId: string;
  /** Where this machine keeps its files. A file on one is not a file on another. */
  files: AttachmentStorage;
}

/** Every temporary attachment directory this file made, removed at the end of each test. */
const directories: string[] = [];

function ownFiles(): AttachmentStorage {
  const root = mkdtempSync(join(tmpdir(), "eo-move-files-"));
  directories.push(root);
  return new AttachmentStorage(root);
}

beforeEach(() => {
  recordDb = openMigratedTestDb();
  annaDb = openMigratedTestDb();
  laptopDb = openMigratedTestDb();
  theRecord = createLocalRecord(recordDb.db);
  serving = {
    db: recordDb.db,
    record: theRecord,
    // The record's own file store, so a moved attachment is a file on
    // the record like any other.
    attachments: ownFiles(),
    offerWork: (deviceId, capacity) =>
      theRecord.offerWork({ deviceId, capacity, tickInput: buildTickInput(recordDb.db, LIMITS, false) }),
  };

  // One person on the organisation's list, with two machines on it.
  const person = createPerson(recordDb.db, { name: "Anna", email: "anna@example.com" });
  annaPersonId = person.id;
  anna = desktop(annaDb, issueDevice(recordDb.db, { personId: person.id, name: "anna-desk", tokenHash: "h1", secretsKeyHash: null }).id);
  laptop = desktop(laptopDb, issueDevice(recordDb.db, { personId: person.id, name: "anna-laptop", tokenHash: "h2", secretsKeyHash: null }).id);
});

afterEach(() => {
  anna.record.stop();
  laptop.record.stop();
  recordDb.close();
  annaDb.close();
  laptopDb.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function desktop(handle: DbHandle, deviceId: string): Desktop {
  const machine: Desktop = {
    handle,
    online: true,
    signedOut: false,
    deviceId,
    files: ownFiles(),
    record: undefined as unknown as DeviceRecord,
  };
  machine.record = createDeviceRecord({
    db: handle.db,
    deviceId: () => deviceId,
    transport: transportFor(machine),
    pullPageSize: 500,
  });
  return machine;
}

/** The record contract, straight into the record's database — `sync.test.ts`'s own stand-in. */
function transportFor(machine: Desktop): () => RecordTransport | null {
  const transport: RecordTransport = {
    async request(channel, payload) {
      if (!machine.online) return { ok: false, error: { message: "EO could not reach https://eo.example: fetch failed" } };
      const answer = await answerOnTheRecord(channel, payload);
      return answer === null
        ? { ok: false, error: { message: `EO has no channel called "${channel}".` } }
        : { ok: true, data: answer as never };
    },
  };
  // Null is what `createManagedDirectory().client()` answers for a
  // desktop with no token — signed out, or turned out by an admin.
  return () => (machine.signedOut ? null : transport);
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

/**
 * Anna's desktop signs in.
 *
 * Two settings and nothing else, because that *is* what signing in
 * leaves behind on a machine: which person this installation is
 * (`viewerPersonId` reads it, and so does the inbox) and, in
 * production, a token in the keychain. The transport is already there —
 * a signed-in desktop always has one; what changes when the network
 * goes is what it answers.
 */
function signIn(machine: Desktop): void {
  setSetting(machine.handle.db, MANAGED_PERSON_ID_KEY, annaPersonId);
}

/** A project Anna made before she had ever heard of a server. */
function localProject(name: string, prefix: string): { id: Uuid; prefix: string } {
  const project = createProject(annaDb.db, { name, keyPrefix: prefix, managed: false });
  return { id: project.id, prefix };
}

/** An item on one of them, on the default pipeline's `todo` step. */
function itemOn(projectId: Uuid, title: string): Item {
  return createTestItem(annaDb.db, { type: "story", title, stepId: "todo", projectId });
}

/**
 * Puts a whole project's history back in time.
 *
 * Every fixture here is stamped "now" by the repo that wrote it, and
 * what the paging bug needs is rows *older* than a cursor that has
 * already moved. Raw SQL because there is no writer for this and there
 * should not be: EO never edits when something happened.
 */
function backdate(projectId: Uuid, at: number): void {
  const db = annaDb.db;
  const mine = sql`(select id from items where project_id = ${projectId})`;
  db.run(sql`update projects set created_at = ${at}, updated_at = ${at} where id = ${projectId}`);
  db.run(sql`update items set created_at = ${at}, updated_at = ${at} where project_id = ${projectId}`);
  db.run(sql`update comments set created_at = ${at} where item_id in ${mine}`);
  db.run(sql`update transitions set ts = ${at} where item_id in ${mine}`);
  db.run(sql`update runs set started_at = ${at}, updated_at = ${at} where item_id in ${mine}`);
  db.run(sql`update attachments set created_at = ${at} where item_id in ${mine}`);
}

/** The move, as the IPC command performs it: pages over the transport, into the record. */
async function move(projectId: Uuid, from?: string): Promise<{ problem?: string }> {
  const outcome = await moveProjectToRecord({
    db: annaDb.db,
    projectId,
    personId: annaPersonId,
    personName: "Anna",
    files: anna.files,
    send: async (request) => {
      // Through the same switch every other request in this file
      // respects. A move is refused when this machine cannot reach its
      // record, and half of what is proved below is what that refusal
      // leaves behind.
      if (!anna.online) return { ok: false, problem: "EO could not reach https://eo.example: fetch failed" };
      const served = (await answerOnTheRecord("record:adopt", {
        // No `ownerId`: the record derives it from this device's token.
        deviceId: from ?? anna.deviceId,
        project: request.project,
        keyNextValue: request.keyNextValue,
        final: request.final,
        abandon: request.abandon,
        page: request.page,
      })) as { accepted: RecordAdoptCounts; problem: string | null };
      if (served.problem !== null) return { ok: false, problem: served.problem };
      return { ok: true, accepted: served.accepted };
    },
  });
  return outcome.ok ? {} : { problem: outcome.problem };
}

/** How many rows a table holds for one project's items, on either side. */
function counts(handle: DbHandle, projectId: string): Record<string, number> {
  const one = (query: ReturnType<typeof sql>): number => handle.db.get<{ n: number }>(query)?.n ?? 0;
  return {
    items: one(sql`select count(*) as n from items where project_id = ${projectId}`),
    comments: one(sql`select count(*) as n from comments c join items i on i.id = c.item_id where i.project_id = ${projectId}`),
    mentions: one(
      sql`select count(*) as n from comment_mentions m join comments c on c.id = m.comment_id
          join items i on i.id = c.item_id where i.project_id = ${projectId}`,
    ),
    transitions: one(
      sql`select count(*) as n from transitions t join items i on i.id = t.item_id where i.project_id = ${projectId}`,
    ),
    runs: one(sql`select count(*) as n from runs r join items i on i.id = r.item_id where i.project_id = ${projectId}`),
    runEvents: one(
      sql`select count(*) as n from run_events e join runs r on r.id = e.run_id join items i on i.id = r.item_id
          where i.project_id = ${projectId}`,
    ),
    // The graphs its work actually stands on, matching the steps and
    // routes below and what `readProjectPipelines` sends: a project
    // whose board is the shared, unadopted one owns no pipeline row and
    // is not a project with no graph.
    pipelines: one(
      sql`select count(*) as n from pipelines p where p.id in (
            select p2.id from pipelines p2 where p2.project_id = ${projectId}
            union select i.pipeline_id from items i where i.project_id = ${projectId} and i.pipeline_id is not null)`,
    ),
    jobs: one(sql`select count(*) as n from jobs where project_id = ${projectId}`),
    // What those jobs have already done. Append-only rows, and the only
    // account there is of a job having fired or been skipped — so a
    // comparison that did not count them could not have caught their
    // absence, which is how they went missing.
    occurrences: one(
      sql`select count(*) as n from job_occurrences o join jobs j on j.id = o.job_id where j.project_id = ${projectId}`,
    ),
    // The files too, since EO-325's review: they used to be queued
    // behind a finished move and could therefore be missing from a
    // comparison that said nothing was lost.
    attachments: one(
      sql`select count(*) as n from attachments a join items i on i.id = a.item_id where i.project_id = ${projectId}`,
    ),
    // …and the two item-owned tables the second review found missing
    // from the transfer *and* from this helper, which is why the
    // helper could not have caught it. A count comparison that does not
    // count a table proves nothing about it.
    deps: one(
      sql`select count(*) as n from item_deps d join items i on i.id = d.item_id where i.project_id = ${projectId}`,
    ),
    extensions: one(
      sql`select count(*) as n from item_extensions e join items i on i.id = e.item_id where i.project_id = ${projectId}`,
    ),
    // The rows that decide where work *goes*, since the fourth review:
    // counting pipelines proved nothing about them, because a graph
    // arrives as one row and a dozen others and a comparison that
    // counted the one could not tell a whole graph from an empty one.
    // The graph rows the project's work actually stands on, which is
    // what `readProjectPipelines` sends: a pipeline the project owns,
    // and the unadopted one an item is on. Counting only `project_id =
    // …` would call a project with a shared board a project with no
    // graph at all.
    steps: one(
      sql`select count(*) as n from pipeline_steps s where s.pipeline_id in (
            select p.id from pipelines p where p.project_id = ${projectId}
            union select i.pipeline_id from items i where i.project_id = ${projectId} and i.pipeline_id is not null)`,
    ),
    routes: one(
      sql`select count(*) as n from step_routes r where r.pipeline_id in (
            select p.id from pipelines p where p.project_id = ${projectId}
            union select i.pipeline_id from items i where i.project_id = ${projectId} and i.pipeline_id is not null)`,
    ),
  };
}

// ── The first acceptance criterion ───────────────────────────────────

describe("signing in with two local projects and keeping both", () => {
  it("shows them under Local, unchanged", async () => {
    const support = localProject("Support", "SUP");
    const marketing = localProject("Marketing", "MKT");
    itemOn(support.id, "A refund");
    itemOn(marketing.id, "The Q3 note");

    signIn(anna);

    // Both undecided the moment she signs in, which is what opens the
    // sheet — and the sheet's own list.
    expect(listUndecidedProjects(annaDb.db).map((project) => project.name).sort()).toEqual(["Marketing", "Support"]);

    keepProjectLocal(annaDb.db, support.id);
    keepProjectLocal(annaDb.db, marketing.id);

    // Kept means local: `managedAt` null is what the switcher groups
    // under "Local", and it is what every other question in this story
    // is answered by.
    expect(listProjects(annaDb.db).every((project) => project.managedAt === null)).toBe(true);
    expect(listUndecidedProjects(annaDb.db)).toEqual([]);

    // Unchanged: nothing about them has been sent anywhere.
    await anna.record.sync();
    expect(counts(recordDb, support.id).items).toBe(0);
    expect(counts(recordDb, marketing.id).items).toBe(0);
  });

  it("keeps the local scheduler running them", async () => {
    const support = localProject("Support", "SUP");
    const item = itemOn(support.id, "A refund");
    signIn(anna);
    keepProjectLocal(annaDb.db, support.id);

    // The record has nothing to offer — it has never heard of this
    // item — and the desktop offers it anyway, from its own scheduler.
    const offers = await anna.record.offerWork({
      deviceId: anna.deviceId,
      capacity: 1,
      tickInput: buildTickInput(annaDb.db, LIMITS, false),
    });

    expect(offers.map((offer) => offer.dispatch.item.id)).toEqual([item.id]);
    // …and the claim it came with is the *local* one, which is what
    // makes the next tick able to renew it.
    expect(offers[0]?.lease.deviceId).toBe(anna.deviceId);
    const held = await anna.record.renewClaims(anna.deviceId, [item.id]);
    expect(held.map((lease) => lease.itemId)).toEqual([item.id]);
  });

  it("offers work no cap holds back on a kept project at a capacity of nought (EO-616)", async () => {
    const support = localProject("Support", "SUP");
    createStep(annaDb.db, { id: "ask", pipelineId: "default" as never, position: -1, name: "Intake", type: "agent", ownerRole: "system", entryAction: "intake" });
    const own = createTestItem(annaDb.db, { type: "feature", title: "The system agent's", stepId: "ask", projectId: support.id });
    itemOn(support.id, "A refund");
    signIn(anna);
    keepProjectLocal(annaDb.db, support.id);

    const offers = await anna.record.offerWork({
      deviceId: anna.deviceId,
      capacity: 0,
      tickInput: buildTickInput(annaDb.db, LIMITS, false, {}, Date.now(), Number.POSITIVE_INFINITY, null, false, new Set(), new Set(["system"])),
    });

    expect(offers.map((offer) => offer.dispatch.item.id)).toEqual([own.id]);
  });

  it("does not queue a kept project's comments or moves for the record", async () => {
    const support = localProject("Support", "SUP");
    const item = itemOn(support.id, "A refund");
    signIn(anna);
    keepProjectLocal(annaDb.db, support.id);

    anna.record.postComment({ itemId: item.id, author: { type: "human" }, body: "Refunded." });
    anna.record.applyTransition({ itemId: item.id, toStepId: "review", actor: "human" });

    await anna.record.sync();

    // Nothing crossed. The record has no item to have heard about it.
    expect(getItem(recordDb.db, item.id)).toBeUndefined();
    // And it was applied here, in full: a kept project behaves exactly
    // as it did in solo mode.
    expect(getItem(annaDb.db, item.id)?.stepId).toBe("review");
    expect(listCommentsForItem(annaDb.db, item.id).map((comment) => comment.body)).toContain("Refunded.");
  });
});

// ── The second acceptance criterion ──────────────────────────────────

describe("moving a project", () => {
  it("uploads every row, and the counts match", async () => {
    const support = localProject("Support", "SUP");
    const first = itemOn(support.id, "A refund");
    const second = itemOn(support.id, "A chargeback");

    // A thread, a move, a run and a transcript — one of everything the
    // story names, so that a count comparison means something.
    postComment(annaDb.db, { itemId: first.id, author: { type: "human" }, body: "Looks right." });
    postComment(annaDb.db, { itemId: second.id, author: { type: "engine" }, body: "Nothing to do here." });
    const record = createLocalRecord(annaDb.db);
    record.applyTransition({ itemId: first.id, toStepId: "review", actor: "human" });
    const run = createRun(annaDb.db, { itemId: second.id, agentId: null, action: "implement", stepId: "todo" });
    appendRunEvent(annaDb.db, run.id, "started", { at: 1 });
    appendRunEvent(annaDb.db, run.id, "finished", { at: 2 });
    // Over, because EO will not move a project with something still
    // running on it — a run that finished half way through the transfer
    // would write its result somewhere the record could not follow.
    updateRun(annaDb.db, run.id, { status: "succeeded", endedAt: 3 });

    signIn(anna);
    const before = counts(annaDb, support.id);
    expect(await move(support.id)).toEqual({});

    // Nothing was lost: every table the story names holds the same
    // number of rows on both sides.
    expect(counts(recordDb, support.id)).toEqual(before);
    // …and it is the *same* rows, not a similar number of them.
    expect(getItem(recordDb.db, first.id)?.key).toBe(first.key);
    expect(getItem(recordDb.db, first.id)?.stepId).toBe("review");
    expect(getItem(recordDb.db, second.id)?.title).toBe("A chargeback");

    // The project is the record's now, and whose it is is the one thing
    // the record assigned.
    expect(getProject(annaDb.db, support.id)?.managedAt).not.toBeNull();
    expect(getProject(recordDb.db, support.id)?.ownerId).toBe(annaPersonId);
  });

  it("carries the graph its items stand on, and the key counter", async () => {
    const support = localProject("Support", "SUP");
    itemOn(support.id, "A refund");
    signIn(anna);
    await move(support.id);

    // The pipeline and its steps, because an item whose step the record
    // cannot resolve is an item the record refuses.
    const graphs = listPipelines(recordDb.db, support.id, true);
    expect(graphs.length).toBeGreaterThan(0);
    expect(listStepsForPipeline(recordDb.db, graphs[0]!.id).length).toBeGreaterThan(0);

    // And the counter, so the next item the record mints does not
    // collide with one it has just taken. `next_value` holds the
    // number the last item took, so the two sides must agree on it
    // exactly rather than merely both be non-zero.
    const here = annaDb.db.get<{ n: number }>(sql`select next_value as n from key_counters where prefix = 'SUP'`);
    const there = recordDb.db.get<{ n: number }>(sql`select next_value as n from key_counters where prefix = 'SUP'`);
    expect(there?.n).toBe(here?.n);
  });

  it("refuses a second time, because there is no way back", async () => {
    const support = localProject("Support", "SUP");
    itemOn(support.id, "A refund");
    signIn(anna);
    await move(support.id);

    expect((await move(support.id)).problem).toContain("already on the record");
    // …and keeping it is refused for the same reason.
    expect(keepProjectLocal(annaDb.db, support.id)).toBeUndefined();
  });

  it("puts the moved project's items on the person's other desktop", async () => {
    const support = localProject("Support", "SUP");
    const item = itemOn(support.id, "A refund");
    signIn(anna);
    signIn(laptop);
    await move(support.id);

    await laptop.record.sync();

    // The project, the graph and the item — in that order, and all
    // three, because an item that arrives belonging to nothing is drawn
    // on no board.
    expect(getProject(laptopDb.db, support.id)?.name).toBe("Support");
    expect(getItem(laptopDb.db, item.id)?.title).toBe("A refund");
    expect(getItem(laptopDb.db, item.id)?.projectId).toBe(support.id);
  });

  it("goes on syncing what happens on it afterwards", async () => {
    const support = localProject("Support", "SUP");
    const item = itemOn(support.id, "A refund");
    signIn(anna);
    signIn(laptop);
    await move(support.id);
    await laptop.record.sync();

    anna.record.postComment({ itemId: item.id, author: { type: "human" }, body: "Refunded today." });
    await anna.record.sync();
    await laptop.record.sync();

    expect(listCommentsForItem(laptopDb.db, item.id).map((comment) => comment.body)).toContain("Refunded today.");
  });

  /**
   * A watch on a step that keeps checking is shared state on the record
   * (EO-456), and one written while the project was this machine's alone
   * was never queued. The move queues it, so the record holds the item
   * from the same watch rather than offering it at once.
   */
  it("hands the record the watches its items already had", async () => {
    const support = localProject("Support", "SUP");
    const item = itemOn(support.id, "Waiting for the customer");
    const watch = startItemWatch(annaDb.db, { itemId: item.id, stepId: "todo", initiationId: `initial:${item.id}:todo`, startedAt: 1_000 });
    updateItemWatch(annaDb.db, watch.id, { checks: 3, nextCheckAt: 9_000, postedNewsIds: ["reply-1"] });
    signIn(anna);

    expect(await move(support.id)).toEqual({});
    await anna.record.sync();

    expect(getItemWatch(recordDb.db, item.id, "todo")).toMatchObject({ startedAt: 1_000, checks: 3, nextCheckAt: 9_000, postedNewsIds: ["reply-1"] });
  });
});

// ── The third acceptance criterion, and the mention rewrite ──────────

describe("what the local person's mentions become", () => {
  it("become the signed-in person's on a moved project, and reach both desktops' inboxes", async () => {
    const support = localProject("Support", "SUP");
    const item = itemOn(support.id, "A refund");
    // An escalation, which is what actually puts a row in an inbox: an
    // open human mention on a thread.
    const asked = postComment(annaDb.db, {
      itemId: item.id,
      author: { type: "engine" },
      body: "@user the customer disputes the amount.",
      kind: "escalation",
      mentions: [{ type: "human" }],
    });
    // Written against the implicit local person, which is what solo
    // mode means by "you".
    expect(listMentionsForComment(annaDb.db, asked.id).map((mention) => mention.targetId)).toEqual([LOCAL_PERSON_ID]);

    signIn(anna);
    signIn(laptop);
    expect(await move(support.id)).toEqual({});

    // Rewritten onto the person the organisation knows.
    expect(listMentionsForComment(annaDb.db, asked.id).map((mention) => mention.targetId)).toEqual([annaPersonId]);
    // …and still in Anna's inbox on the machine she moved it from,
    // because "you" on that machine is now her.
    expect(openMentionsForHuman(annaDb.db).map((row) => row.comment.id)).toContain(asked.id);

    // The record holds it as hers rather than as its own implicit
    // person's — which is what makes the next line possible at all.
    expect(listMentionsForComment(recordDb.db, asked.id).map((mention) => mention.targetId)).toEqual([annaPersonId]);

    await laptop.record.sync();
    expect(openMentionsForHuman(laptopDb.db).map((row) => row.comment.id)).toContain(asked.id);
  });

  it("changes nothing on a kept project", async () => {
    const marketing = localProject("Marketing", "MKT");
    const item = itemOn(marketing.id, "The Q3 note");
    const asked = postComment(annaDb.db, {
      itemId: item.id,
      author: { type: "engine" },
      body: "Waiting on you.",
      kind: "escalation",
      mentions: [{ type: "human" }],
    });

    signIn(anna);
    keepProjectLocal(annaDb.db, marketing.id);

    // Untouched. A project somebody kept is theirs, and "you" on it is
    // still the implicit local person.
    expect(listMentionsForComment(annaDb.db, asked.id).map((mention) => mention.targetId)).toEqual([LOCAL_PERSON_ID]);
  });

  it("leaves a kept project's mentions alone when its neighbour is moved", async () => {
    const support = localProject("Support", "SUP");
    const marketing = localProject("Marketing", "MKT");
    const moved = itemOn(support.id, "A refund");
    const kept = itemOn(marketing.id, "The Q3 note");
    const onMoved = postComment(annaDb.db, {
      itemId: moved.id,
      author: { type: "engine" },
      body: "Waiting on you.",
      mentions: [{ type: "human" }],
    });
    const onKept = postComment(annaDb.db, {
      itemId: kept.id,
      author: { type: "engine" },
      body: "Waiting on you.",
      mentions: [{ type: "human" }],
    });

    signIn(anna);
    keepProjectLocal(annaDb.db, marketing.id);
    await move(support.id);

    expect(listMentionsForComment(annaDb.db, onMoved.id).map((mention) => mention.targetId)).toEqual([annaPersonId]);
    expect(listMentionsForComment(annaDb.db, onKept.id).map((mention) => mention.targetId)).toEqual([LOCAL_PERSON_ID]);
  });
});

// ── What a move that does not finish must not leave behind ───────────

describe("a move that fails", () => {
  /** An escalation on a project, addressed to whoever this machine's person is. */
  function escalationOn(item: Item): Uuid {
    return postComment(annaDb.db, {
      itemId: item.id,
      author: { type: "engine" },
      body: "Waiting on you.",
      kind: "escalation",
      mentions: [{ type: "human" }],
    }).id;
  }

  /** Every column a move rewrites, as this machine currently has it. */
  function identityOf(projectId: Uuid, commentId: Uuid): { mention: string | null; assignee: string | null; createdBy: string | null } {
    const item = getItem(annaDb.db, projectItemIds(annaDb.db, projectId)[0]!);
    return {
      mention: listMentionsForComment(annaDb.db, commentId)[0]?.targetId ?? null,
      assignee: item?.assigneeId ?? null,
      createdBy: item?.createdBy ?? null,
    };
  }

  it("leaves every identity reference exactly as it was, so keeping it afterwards changes nothing", async () => {
    const support = localProject("Support", "SUP");
    const item = itemOn(support.id, "A refund");
    setItemAssignee(annaDb.db, item.id, LOCAL_PERSON_ID);
    const asked = escalationOn(item);
    const before = identityOf(support.id, asked);
    expect(before).toEqual({ mention: LOCAL_PERSON_ID, assignee: LOCAL_PERSON_ID, createdBy: LOCAL_PERSON_ID });

    signIn(anna);
    anna.online = false;
    expect((await move(support.id)).problem).toContain("EO could not reach");

    // **The review's first finding.** The rewrite used to happen before
    // the first page went out, so a move that failed half way left a
    // project that was still the person's with every mention, assignee
    // and creator already pointing at the signed-in person. Nothing is
    // written now until the whole transfer is accounted for.
    expect(identityOf(support.id, asked)).toEqual(before);

    // …which is what makes "keeping both shows them under Local,
    // unchanged" true after a failed move rather than only before one.
    anna.online = true;
    expect(keepProjectLocal(annaDb.db, support.id)).toBeDefined();
    expect(identityOf(support.id, asked)).toEqual(before);
    expect(getProject(annaDb.db, support.id)?.managedAt).toBeNull();
  });

  it("moves no bookmark into a run it did not finish handing over", async () => {
    const support = localProject("Support", "SUP");
    const item = itemOn(support.id, "A refund");
    const run = createRun(annaDb.db, { itemId: item.id, agentId: null, action: "implement", stepId: "todo" });
    appendRunEvent(annaDb.db, run.id, "started", { at: 1 });

    signIn(anna);
    anna.online = false;
    await move(support.id);

    // The bookmark itself, rather than `runsNeedingSync` — which is
    // scoped to what the record owns and would answer "nothing" for a
    // project that is still local whatever the bookmark said. What
    // matters is that the column was never touched: a bookmark moved
    // for a move that failed is a transcript with a hole in it that
    // nothing goes back for, and it would only show once the project
    // finally *did* move.
    const bookmark = annaDb.db.get<{ seq: number; status: string | null }>(
      sql`select synced_seq as seq, synced_status as status from runs where id = ${run.id}`,
    );
    expect(bookmark).toEqual({ seq: -1, status: null });
  });

  it("is what a record refusing one row makes of the whole move", async () => {
    const support = localProject("Support", "SUP");
    itemOn(support.id, "A refund");
    signIn(anna);

    // A record that takes the structure and then loses an item. What it
    // says is `skipped`, which used to be a note beside a successful,
    // irreversible move and is now the end of one.
    const outcome = await moveProjectToRecord({
      db: annaDb.db,
      projectId: support.id,
      personId: annaPersonId,
      personName: "Anna",
      files: anna.files,
      send: async (request) =>
        request.page.items.length > 0
          ? {
              ok: true,
              accepted: { ...tookNothing(), skipped: ["SUP-1: this record has no item type \"story\""] },
            }
          : { ok: true, accepted: took(request.page) },
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? "" : outcome.problem).toContain("could not take part of this project");
    expect(getProject(annaDb.db, support.id)?.managedAt).toBeNull();
  });

  it("is what a record quietly taking fewer rows than it was sent makes of it", async () => {
    const support = localProject("Support", "SUP");
    itemOn(support.id, "A refund");
    itemOn(support.id, "A chargeback");
    signIn(anna);

    // No `skipped`, no error — just one fewer item than went out. The
    // count comparison is what catches it, and it is made while the
    // move can still be stopped rather than reported afterwards.
    const outcome = await moveProjectToRecord({
      db: annaDb.db,
      projectId: support.id,
      personId: annaPersonId,
      personName: "Anna",
      files: anna.files,
      send: async (request) =>
        request.page.items.length > 0
          ? { ok: true, accepted: { ...took(request.page), items: request.page.items.length - 1 } }
          : { ok: true, accepted: took(request.page) },
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? "" : outcome.problem).toContain("of 2 items");
    expect(getProject(annaDb.db, support.id)?.managedAt).toBeNull();
  });
});

// ── The files, which used to be queued behind a finished move ────────

describe("the files a project carries", () => {
  async function fileOn(item: Item, name: string): Promise<Uuid> {
    const stored = await anna.files.storeImported({ name, mimeType: "text/plain", data: Buffer.from("the Q3 number") });
    const comment = postComment(annaDb.db, { itemId: item.id, author: { type: "human" }, body: `Here is ${name}.` });
    insertAttachments(annaDb.db, [{ ...stored, itemId: item.id, commentId: comment.id }]);
    return stored.id;
  }

  it("travel with it, and are counted before it is finished", async () => {
    const support = localProject("Support", "SUP");
    const item = itemOn(support.id, "A refund");
    const fileId = await fileOn(item, "report.txt");

    signIn(anna);
    const outcome = await moveProjectToRecord({
      db: annaDb.db,
      projectId: support.id,
      personId: annaPersonId,
      personName: "Anna",
      files: anna.files,
      send: async (request) => {
        const served = await serveAdopt(serving, {
          deviceId: anna.deviceId,
          project: request.project,
          keyNextValue: request.keyNextValue,
          final: request.final,
          abandon: request.abandon,
          page: request.page,
        });
        return served.problem === null ? { ok: true, accepted: served.accepted } : { ok: false, problem: served.problem };
      },
    });

    expect(outcome.ok).toBe(true);
    // The row *and* the bytes are on the record by the time the move is
    // over — not queued behind it, which is what let a move be finished
    // and irreversible while its files were still only here.
    expect(getAttachment(recordDb.db, fileId)?.name).toBe("report.txt");
    const kept = getAttachment(recordDb.db, fileId);
    expect(await serving.attachments?.read(kept?.path ?? "")).not.toBeNull();
    expect(outcome.ok && outcome.moved.attachments).toBe(1);
    expect(counts(recordDb, support.id).attachments).toBe(counts(annaDb, support.id).attachments);
  });

  it("stop a move that has nowhere to read them from", async () => {
    const support = localProject("Support", "SUP");
    const item = itemOn(support.id, "A refund");
    await fileOn(item, "report.txt");
    signIn(anna);

    // A process with no file store moves a project without files
    // perfectly well and must refuse one that has them, rather than
    // moving it and losing them.
    const outcome = await moveProjectToRecord({
      db: annaDb.db,
      projectId: support.id,
      personId: annaPersonId,
      personName: "Anna",
      send: async (request) => ({ ok: true, accepted: took(request.page) }),
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? "" : outcome.problem).toContain("nowhere to read them from");
    expect(getProject(annaDb.db, support.id)?.managedAt).toBeNull();
  });
});

// ── Whose the project becomes ────────────────────────────────────────

describe("who the record makes the owner", () => {
  it("is the person the asking device belongs to, whatever the device claims", async () => {
    const support = localProject("Support", "SUP");
    itemOn(support.id, "A refund");
    // Somebody else on the organisation's list, with no machine here.
    const dana = createPerson(recordDb.db, { name: "Dana", email: "dana@example.com" });

    signIn(anna);
    // Anna's desktop moves the project, and the wire carries her claim
    // about ownership — which the record does not read. There is no
    // field on `record:adopt` for a client to name somebody else at
    // all; the owner comes from the device token the door checked.
    expect(await move(support.id)).toEqual({});

    expect(getProject(recordDb.db, support.id)?.ownerId).toBe(annaPersonId);
    expect(getProject(recordDb.db, support.id)?.ownerId).not.toBe(dana.id);
  });

  it("is refused outright from a machine the record has never issued a token to", async () => {
    const support = localProject("Support", "SUP");
    itemOn(support.id, "A refund");
    signIn(anna);

    expect((await move(support.id, "a-device-nobody-issued")).problem).toContain("does not know the machine");
    expect(getProject(annaDb.db, support.id)?.managedAt).toBeNull();
    expect(getProject(recordDb.db, support.id)).toBeUndefined();
  });
});

/** A record that takes nothing at all, for a test that wants to say so explicitly. */
function tookNothing(): RecordAdoptCounts {
  return {
    itemTypes: 0,
    pipelines: 0,
    steps: 0,
    routes: 0,
    agents: 0,
    jobs: 0,
    occurrences: 0,
    items: 0,
    runs: 0,
    runEvents: 0,
    transitions: 0,
    comments: 0,
    mentions: 0,
    deps: 0,
    extensions: 0,
    attachments: 0,
    memories: 0,
    skills: 0,
    skipped: [],
  };
}

/** A record that takes everything it is sent — counted from the page, so a fixture that grows stays true. */
function took(page: Parameters<typeof serveAdopt>[1]["page"]): RecordAdoptCounts {
  return {
    itemTypes: page.itemTypes.length,
    pipelines: page.pipelines.length,
    steps: page.pipelines.reduce((total, one) => total + one.steps.length, 0),
    routes: page.pipelines.reduce((total, one) => total + one.routes.length, 0),
    agents: page.agents.length,
    jobs: page.jobs.length,
    occurrences: page.occurrences.length,
    items: page.items.length,
    runs: page.runs.length,
    runEvents: page.runEvents.reduce((total, batch) => total + batch.events.length, 0),
    transitions: page.transitions.length,
    comments: page.comments.length,
    mentions: page.mentions.length,
    deps: page.deps.length,
    extensions: page.extensions.length,
    attachments: page.attachments.length,
    memories: page.memories.length,
    skills: page.skills.length,
    skipped: [],
  };
}

// ── Whose project a device may write to (the review's first finding) ─

describe("a project already on the record", () => {
  it("cannot have its owner taken by another person's device", async () => {
    // Anna moves her project. It is hers, and every signed-in device
    // learns its id from `record:changes`.
    const support = localProject("Support", "SUP");
    itemOn(support.id, "A refund");
    signIn(anna);
    expect(await move(support.id)).toEqual({});

    // Dana is somebody else on the organisation's list, with a machine
    // of her own. Her device sends an adopt request naming Anna's
    // project and nothing else — the one-request takeover the review
    // found.
    const dana = createPerson(recordDb.db, { name: "Dana", email: "dana@example.com" });
    const danaDevice = issueDevice(recordDb.db, { personId: dana.id, name: "dana-desk", tokenHash: "h3", secretsKeyHash: null });

    const answer = (await answerOnTheRecord("record:adopt", {
      deviceId: danaDevice.id,
      project: { ...asWire(recordDb, support.id), ownerId: dana.id },
      keyNextValue: 0,
      final: false,
      abandon: false,
      page: nothing(),
    })) as { problem: string | null };

    expect(answer.problem).toContain("belongs to somebody else");
    expect(getProject(recordDb.db, support.id)?.ownerId).toBe(annaPersonId);
  });

  it("cannot be taken off the record by another person's device either", async () => {
    const support = localProject("Support", "SUP");
    const item = itemOn(support.id, "A refund");
    signIn(anna);
    await move(support.id);

    const dana = createPerson(recordDb.db, { name: "Dana", email: "dana@example.com" });
    const danaDevice = issueDevice(recordDb.db, { personId: dana.id, name: "dana-desk", tokenHash: "h3", secretsKeyHash: null });

    const answer = (await answerOnTheRecord("record:adopt", {
      deviceId: danaDevice.id,
      project: asWire(recordDb, support.id),
      keyNextValue: 0,
      final: false,
      abandon: true,
      page: nothing(),
    })) as { problem: string | null };

    expect(answer.problem).toContain("belongs to somebody else");
    expect(getItem(recordDb.db, item.id)?.title).toBe("A refund");
  });

  it("is not abandoned by its own owner once it is live", async () => {
    const support = localProject("Support", "SUP");
    const item = itemOn(support.id, "A refund");
    signIn(anna);
    await move(support.id);

    const answer = (await answerOnTheRecord("record:adopt", {
      deviceId: anna.deviceId,
      project: asWire(recordDb, support.id),
      keyNextValue: 0,
      final: false,
      abandon: true,
      page: nothing(),
    })) as { problem: string | null };

    // There is no way back in this version, and that applies to the
    // machine that moved it as much as to anybody else. Abandoning is
    // for a transfer that never finished.
    expect(answer.problem).toContain("finished moving here");
    expect(getItem(recordDb.db, item.id)?.title).toBe("A refund");
  });
});

// ── A transfer that has not finished is not live (the second finding) ─

describe("while a project is still arriving", () => {
  /** A move that gets as far as the items and then stops. */
  async function halfWay(projectId: Uuid): Promise<void> {
    await moveProjectToRecord({
      db: annaDb.db,
      projectId,
      personId: annaPersonId,
      personName: "Anna",
      files: anna.files,
      send: async (request) => {
        if (request.page.items.length > 0) {
          const served = await serveAdopt(serving, adoptPayload(anna.deviceId, request));
          // …and then the network goes, one page in.
          anna.online = false;
          return served.problem === null ? { ok: true, accepted: served.accepted } : { ok: false, problem: served.problem };
        }
        if (!anna.online) return { ok: false, problem: "EO could not reach https://eo.example: fetch failed" };
        const served = await serveAdopt(serving, adoptPayload(anna.deviceId, request));
        return served.problem === null ? { ok: true, accepted: served.accepted } : { ok: false, problem: served.problem };
      },
    });
  }

  it("is not on another desktop's board, and is not scheduled by the record", async () => {
    const support = localProject("Support", "SUP");
    const item = itemOn(support.id, "A refund");
    signIn(anna);
    signIn(laptop);

    // A transfer that stops after the items, with the abandon it tries
    // to send unable to get out.
    await halfWay(support.id);
    expect(getItem(recordDb.db, item.id)?.title).toBe("A refund");

    // **The review's second finding.** The record has some of this
    // project; it must not draw it anywhere or dispatch anything on it.
    await laptop.record.sync();
    expect(getProject(laptopDb.db, support.id)).toBeUndefined();
    expect(getItem(laptopDb.db, item.id)).toBeUndefined();

    const offers = await theRecord.offerWork({
      deviceId: laptop.deviceId,
      capacity: 1,
      tickInput: buildTickInput(recordDb.db, LIMITS, false),
    });
    expect(offers).toEqual([]);
  });

  it("is not scheduled here either, so two schedulers cannot hold one item", async () => {
    const support = localProject("Support", "SUP");
    const item = itemOn(support.id, "A refund");
    signIn(anna);

    // Frozen the moment the transfer starts, and durably: a process
    // that died mid-move comes back with it still frozen rather than
    // dispatching work that is half way to somewhere else.
    const froze = beginAdoption(annaDb.db, support.id);
    expect(froze?.adoptingAt).not.toBeNull();

    const offers = await anna.record.offerWork({
      deviceId: anna.deviceId,
      capacity: 1,
      tickInput: buildTickInput(annaDb.db, LIMITS, false),
    });
    expect(offers).toEqual([]);

    // …and unfrozen by giving up, which puts it back exactly as it was.
    abandonAdoption(annaDb.db, support.id);
    const after = await anna.record.offerWork({
      deviceId: anna.deviceId,
      capacity: 1,
      tickInput: buildTickInput(annaDb.db, LIMITS, false),
    });
    expect(after.map((offer) => offer.dispatch.item.id)).toEqual([item.id]);
  });

  it("is taken back off the record when the move gives up", async () => {
    const support = localProject("Support", "SUP");
    const item = itemOn(support.id, "A refund");
    postComment(annaDb.db, { itemId: item.id, author: { type: "human" }, body: "Refunded." });
    signIn(anna);

    // The network holds long enough for the abandon to get out, which
    // is the ordinary case: the record refused something rather than
    // vanishing.
    const outcome = await moveProjectToRecord({
      db: annaDb.db,
      projectId: support.id,
      personId: annaPersonId,
      personName: "Anna",
      files: anna.files,
      send: async (request) => {
        if (request.page.comments.length > 0) return { ok: false, problem: "the record had had enough" };
        const served = await serveAdopt(serving, adoptPayload(anna.deviceId, request));
        return served.problem === null ? { ok: true, accepted: served.accepted } : { ok: false, problem: served.problem };
      },
    });

    expect(outcome.ok).toBe(false);
    // Nothing half-written left behind on the server, and nothing
    // frozen left behind here.
    expect(getProject(recordDb.db, support.id)).toBeUndefined();
    expect(getItem(recordDb.db, item.id)).toBeUndefined();
    expect(getProject(annaDb.db, support.id)?.adoptingAt).toBeNull();
    expect(getProject(annaDb.db, support.id)?.managedAt).toBeNull();
  });

  it("refuses to start while something on it is running", async () => {
    const support = localProject("Support", "SUP");
    const item = itemOn(support.id, "A refund");
    createRun(annaDb.db, { itemId: item.id, agentId: null, action: "implement", stepId: "todo" });
    signIn(anna);

    expect((await move(support.id)).problem).toContain("still running");
    expect(getProject(annaDb.db, support.id)?.adoptingAt).toBeNull();
  });
});

// ── Work written while the move was running ──────────────────────────

describe("a comment typed in the middle of a move", () => {
  it("goes up with it rather than being left behind", async () => {
    const support = localProject("Support", "SUP");
    const item = itemOn(support.id, "A refund");
    signIn(anna);

    // Somebody types while the transfer is in flight. The scheduler is
    // frozen, so this is the only writer left — and the pass that finds
    // the project quiet is what catches it.
    let typed = false;
    const outcome = await moveProjectToRecord({
      db: annaDb.db,
      projectId: support.id,
      personId: annaPersonId,
      personName: "Anna",
      files: anna.files,
      send: async (request) => {
        const served = await serveAdopt(serving, adoptPayload(anna.deviceId, request));
        if (!typed && request.page.items.length > 0) {
          typed = true;
          postComment(annaDb.db, { itemId: item.id, author: { type: "human" }, body: "One more thing." });
        }
        return served.problem === null ? { ok: true, accepted: served.accepted } : { ok: false, problem: served.problem };
      },
    });

    expect(outcome.ok).toBe(true);
    expect(listCommentsForItem(recordDb.db, item.id).map((comment) => comment.body)).toContain("One more thing.");
    expect(counts(recordDb, support.id)).toEqual(counts(annaDb, support.id));
  });
});

// ── What "you" means on a project somebody kept (the third finding) ───

describe("a kept project after signing in", () => {
  it("keeps its old escalations in the inbox and its needs-attention mark", () => {
    const marketing = localProject("Marketing", "MKT");
    const item = itemOn(marketing.id, "The Q3 note");
    const asked = postComment(annaDb.db, {
      itemId: item.id,
      author: { type: "engine" },
      body: "Waiting on you.",
      kind: "escalation",
      mentions: [{ type: "human" }],
    });
    expect(openMentionsForHuman(annaDb.db).map((row) => row.comment.id)).toContain(asked.id);
    expect(needsAttention(annaDb.db, item.id)).toBe(true);

    signIn(anna);
    keepProjectLocal(annaDb.db, marketing.id);

    // **The review's third finding.** A global "you" hid every one of
    // these: the rows still target the implicit local person, because
    // nothing rewrote them and nothing was supposed to, and an inbox
    // asking only about the organisation's person found none of them.
    expect(openMentionsForHuman(annaDb.db).map((row) => row.comment.id)).toContain(asked.id);
    expect(needsAttention(annaDb.db, item.id)).toBe(true);
  });

  it("writes new mentions against the local person, as solo mode does", () => {
    const marketing = localProject("Marketing", "MKT");
    const item = itemOn(marketing.id, "The Q3 note");
    signIn(anna);
    keepProjectLocal(annaDb.db, marketing.id);

    const later = postComment(annaDb.db, {
      itemId: item.id,
      author: { type: "engine" },
      body: "Still waiting on you.",
      kind: "escalation",
      mentions: [{ type: "human" }],
    });

    // A kept project behaves exactly as it did in solo mode, which is
    // the whole of the first acceptance criterion — and an escalation
    // written against the organisation's person would be one this
    // machine's own inbox could only find by accident.
    expect(listMentionsForComment(annaDb.db, later.id).map((mention) => mention.targetId)).toEqual([LOCAL_PERSON_ID]);
    expect(openMentionsForHuman(annaDb.db).map((row) => row.comment.id)).toContain(later.id);
  });

  it("does not take a moved project's escalations out of the same inbox", async () => {
    const support = localProject("Support", "SUP");
    const marketing = localProject("Marketing", "MKT");
    const moved = itemOn(support.id, "A refund");
    const kept = itemOn(marketing.id, "The Q3 note");
    const onMoved = postComment(annaDb.db, {
      itemId: moved.id,
      author: { type: "engine" },
      body: "Waiting on you.",
      mentions: [{ type: "human" }],
    });
    const onKept = postComment(annaDb.db, {
      itemId: kept.id,
      author: { type: "engine" },
      body: "Waiting on you.",
      mentions: [{ type: "human" }],
    });

    signIn(anna);
    keepProjectLocal(annaDb.db, marketing.id);
    expect(await move(support.id)).toEqual({});

    // Both, because both are this person — the organisation's row on
    // the work it owns, and the implicit local one on the work that
    // stayed here.
    const inbox = openMentionsForHuman(annaDb.db).map((row) => row.comment.id);
    expect(inbox).toContain(onMoved.id);
    expect(inbox).toContain(onKept.id);
  });
});

/** A project as the wire carries it, read off whichever database holds it. */
function asWire(handle: DbHandle, projectId: Uuid): {
  id: string;
  name: string;
  keyPrefix: string;
  ownerId: string | null;
  managedAt: number | null;
  createdAt: number;
  updatedAt: number;
} {
  const project = getProject(handle.db, projectId)!;
  return {
    id: project.id,
    name: project.name,
    keyPrefix: project.keyPrefix,
    ownerId: project.ownerId,
    managedAt: project.managedAt,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

/** A request carrying no rows: a commit, an abandon, or an attempted takeover. */
function nothing(): IpcPayload<"record:adopt">["page"] {
  return {
    itemTypes: [],
    pipelines: [],
    agents: [],
    jobs: [],
    occurrences: [],
    items: [],
    runs: [],
    runEvents: [],
    transitions: [],
    comments: [],
    mentions: [],
    deps: [],
    graph: false,
    extensions: [],
    attachments: [],
    memories: [],
    skills: [],
  };
}

/** One adopt request, as the device's transport would build it. */
function adoptPayload(deviceId: string, request: AdoptRequest): IpcPayload<"record:adopt"> {
  return {
    deviceId,
    project: request.project,
    keyNextValue: request.keyNextValue,
    final: request.final,
    abandon: request.abandon,
    page: request.page,
  };
}

// ── The graph and the pack state that hang off an item ───────────────

describe("what an item carries besides itself", () => {
  it("moves the dependency graph, which decides what may run", async () => {
    const support = localProject("Support", "SUP");
    const first = itemOn(support.id, "The API change");
    const second = itemOn(support.id, "The client change");
    addDependency(annaDb.db, second.id, first.id);

    signIn(anna);
    const before = counts(annaDb, support.id);
    expect(await move(support.id)).toEqual({});

    // **The review's first finding.** `item_deps` never travelled, so
    // the record held the items and not the edge between them — and an
    // edge is not decoration: the scheduler will not dispatch an item
    // whose dependency is unfinished, so a record with the wrong graph
    // *schedules differently*, with nothing about the board looking
    // wrong.
    expect(listDependencies(recordDb.db, second.id).map((dep) => dep.dependsOnId)).toEqual([first.id]);
    expect(counts(recordDb, support.id)).toEqual(before);
    expect(before.deps).toBe(1);
  });

  it("refuses to move a project whose dependency reaches work that is staying", async () => {
    const support = localProject("Support", "SUP");
    const marketing = localProject("Marketing", "MKT");
    const moving = itemOn(support.id, "The API change");
    const staying = itemOn(marketing.id, "The Q3 note");
    addDependency(annaDb.db, moving.id, staying.id);

    signIn(anna);
    keepProjectLocal(annaDb.db, marketing.id);

    // `item_deps` has foreign keys both ways, so this edge cannot be
    // written on the record at all. Named rather than dropped: a move
    // that quietly severed a dependency would hand over a project the
    // record schedules differently.
    const answer = await move(support.id);
    expect(answer.problem).toContain("cut a dependency");
    expect(answer.problem).toContain("MKT-1");
    expect(getProject(annaDb.db, support.id)?.managedAt).toBeNull();
  });

  it("moves what the packs know about it", async () => {
    const support = localProject("Support", "SUP");
    const item = itemOn(support.id, "A refund");
    // The developer pack's Jira binding — the one extension that exists
    // today — and a second, to prove nothing here knows what a pack is.
    setItemExtension(annaDb.db, item.id, "jira", { key: "SUP-9", id: "10001", sync: true, pullPending: false });
    setItemExtension(annaDb.db, item.id, "git", { branch: "eo/SUP-1", pullRequest: "https://example/pr/7" });

    signIn(anna);
    const before = counts(annaDb, support.id);
    expect(await move(support.id)).toEqual({});

    // **The review's third finding.** Item-owned rows belong to the item
    // wherever it goes: the issue it mirrors and the branch its work is
    // on are facts about the work, not about the machine that did it.
    expect(extensionsForItem(recordDb.db, item.id)).toEqual({
      jira: { key: "SUP-9", id: "10001", sync: true, pullPending: false },
      git: { branch: "eo/SUP-1", pullRequest: "https://example/pr/7" },
    });
    expect(counts(recordDb, support.id)).toEqual(before);
    expect(before.extensions).toBe(2);

    // …and the machine-local half of the same story stayed here. A
    // workspace is a path on somebody's disk (ARCHITECTURE.md, "Where a job runs"), so the branch
    // travels and the checkout it is in does not.
    expect(getItem(recordDb.db, item.id)?.workspaceId).toBeNull();
  });
});

// ── Rows edited while their page was in flight ───────────────────────

describe("an edit made while the move was running", () => {
  /**
   * A record that lets the test act between two requests.
   *
   * `at` fires once, the first time a page of the named kind goes out,
   * *before* the record sees it — which is the moment a person typing
   * at their desk would land in.
   */
  function recordThatLets(act: { when: (page: AdoptRequest["page"]) => boolean; then: () => void }): Parameters<
    typeof moveProjectToRecord
  >[0]["send"] {
    let fired = false;
    return async (request) => {
      if (!fired && act.when(request.page)) {
        fired = true;
        act.then();
      }
      const served = await serveAdopt(serving, adoptPayload(anna.deviceId, request));
      return served.problem === null ? { ok: true, accepted: served.accepted } : { ok: false, problem: served.problem };
    };
  }

  async function moveLetting(projectId: Uuid, act: Parameters<typeof recordThatLets>[0]): Promise<boolean> {
    const outcome = await moveProjectToRecord({
      db: annaDb.db,
      projectId,
      personId: annaPersonId,
      personName: "Anna",
      files: anna.files,
      send: recordThatLets(act),
    });
    return outcome.ok;
  }

  it("lands the item's new title rather than the one the snapshot read", async () => {
    const support = localProject("Support", "SUP");
    const item = itemOn(support.id, "A refund");
    signIn(anna);

    // **The review's second finding.** The sweep only re-sent ids it
    // had never seen, and the record only inserted where it had
    // nothing, so an item edited while its page was in flight left the
    // record holding the old version under a move that said it had
    // taken everything.
    const ok = await moveLetting(support.id, {
      when: (page) => page.items.length > 0,
      then: () => updateItem(annaDb.db, item.id, { title: "A chargeback, actually" }),
    });

    expect(ok).toBe(true);
    expect(getItem(recordDb.db, item.id)?.title).toBe("A chargeback, actually");
  });

  it("lands the project's new name", async () => {
    const support = localProject("Support", "SUP");
    itemOn(support.id, "A refund");
    signIn(anna);

    // The project row was captured once, before the first page, so a
    // rename never reached the record at all.
    const ok = await moveLetting(support.id, {
      when: (page) => page.items.length > 0,
      then: () => updateProject(annaDb.db, support.id, { name: "Customer Support" }),
    });

    expect(ok).toBe(true);
    expect(getProject(recordDb.db, support.id)?.name).toBe("Customer Support");
  });

  it("lands a card dragged to another step, as a move rather than as a column", async () => {
    const support = localProject("Support", "SUP");
    const item = itemOn(support.id, "A refund");
    signIn(anna);

    const ok = await moveLetting(support.id, {
      when: (page) => page.items.length > 0,
      // Through the local record, which is the only door there is —
      // invariant #1, and the reason the record cannot simply write the
      // column on the far side either.
      then: () => createLocalRecord(annaDb.db).applyTransition({ itemId: item.id, toStepId: "review", actor: "human" }),
    });

    expect(ok).toBe(true);
    expect(getItem(recordDb.db, item.id)?.stepId).toBe("review");
    // And it arrived as a move, with an audit row behind it, rather
    // than as an item that quietly has a different column now.
    expect(listTransitionsForItem(recordDb.db, item.id).map((move) => move.toStepId)).toContain("review");
  });

  it("lands a step edited under it", async () => {
    const support = localProject("Support", "SUP");
    // A graph somebody drew rather than the seeded board: the seeded
    // one is shared on every installation and a move may not rewrite
    // what is shared. See "a graph nobody owns" below.
    const pipeline = createPipeline(annaDb.db, { name: "The support flow", projectId: support.id });
    const step = createStep(annaDb.db, { pipelineId: pipeline.id, position: 0, name: "Waiting", type: "user" });
    setEntryStep(annaDb.db, pipeline.id, step.id);
    createTestItem(annaDb.db, { type: "story", title: "A refund", stepId: step.id, projectId: support.id });
    signIn(anna);
    expect(step.planMode).toBe(false);

    // A step carries no timestamp of its own — it travels with the
    // pipeline that does — so the whole graph goes on every pass and
    // the record takes what the sender has. Without that the record
    // kept whatever the first page happened to read.
    const ok = await moveLetting(support.id, {
      when: (page) => page.items.length > 0,
      then: () => updateStep(annaDb.db, step.id, { planMode: true }),
    });

    expect(ok).toBe(true);
    expect(listStepsForPipeline(recordDb.db, pipeline.id).find((one) => one.id === step.id)?.planMode).toBe(true);
  });

  it("lands a dependency taken off, rather than leaving it standing", async () => {
    const support = localProject("Support", "SUP");
    const first = itemOn(support.id, "The API change");
    const second = itemOn(support.id, "The client change");
    addDependency(annaDb.db, second.id, first.id);
    signIn(anna);

    // An edge has no version — it is two ids and nothing else — so the
    // whole graph travels on every pass and the record replaces its own
    // with it. Otherwise a dependency taken off mid-transfer would
    // linger, and the record would hold work back that nothing was
    // waiting on.
    const ok = await moveLetting(support.id, {
      when: (page) => page.deps.length > 0,
      then: () => removeDependency(annaDb.db, second.id, first.id),
    });

    expect(ok).toBe(true);
    expect(listDependencies(recordDb.db, second.id)).toEqual([]);
  });
});

// ── The graph, which decides where work goes ─────────────────────────

describe("a graph the project owns", () => {
  /** The project, with the seeded board adopted into it as first run does. */
  function projectWithItsOwnGraph(): { id: Uuid; pipelineId: Uuid } {
    const support = localProject("Support", "SUP");
    // A graph somebody drew, rather than the seeded board: the seeded
    // one is shared on every installation, including the record's, and
    // a move may not rewrite what is shared. This is the ordinary shape
    // of a project that owns its own routing.
    const pipeline = createPipeline(annaDb.db, { name: "The support flow", projectId: support.id });
    const waiting = createStep(annaDb.db, { pipelineId: pipeline.id, position: 0, name: "Waiting", type: "user" });
    const done = createStep(annaDb.db, { pipelineId: pipeline.id, position: 1, name: "Done", type: "user", isTerminal: true });
    createRoute(annaDb.db, {
      pipelineId: pipeline.id,
      fromStepId: waiting.id,
      resultKey: "done",
      label: "Done",
      tone: "success",
      target: done.id,
    });
    setEntryStep(annaDb.db, pipeline.id, waiting.id);
    createTestItem(annaDb.db, { type: "story", title: "A refund", stepId: waiting.id, projectId: support.id });
    return { id: support.id, pipelineId: pipeline.id };
  }

  it("moves with every step and route, counted", async () => {
    const support = projectWithItsOwnGraph();
    signIn(anna);
    const before = counts(annaDb, support.id);
    expect(before.steps).toBeGreaterThan(0);
    expect(before.routes).toBeGreaterThan(0);

    expect(await move(support.id)).toEqual({});

    expect(counts(recordDb, support.id)).toEqual(before);
  });

  it("takes a route removed mid-transfer off the record too", async () => {
    const support = projectWithItsOwnGraph();
    const steps = listStepsForPipeline(annaDb.db, support.pipelineId);
    const added = createRoute(annaDb.db, {
      pipelineId: support.pipelineId,
      fromStepId: steps[0]!.id,
      resultKey: "escalate",
      label: "Escalate",
      tone: "warning",
      target: steps[1]!.id,
      position: 99,
    });
    signIn(anna);

    // **The review's second finding.** Steps and routes carry no
    // version, so the whole graph travels — and the record was
    // upserting every row of it and removing none, which left a route
    // deleted during the transfer standing on the record and sending
    // work somewhere the person had stopped sending it.
    const outcome = await moveProjectToRecord({
      db: annaDb.db,
      projectId: support.id,
      personId: annaPersonId,
      personName: "Anna",
      files: anna.files,
      send: async (request) => {
        // Straight at the table: what a person does through the
        // pipeline editor is a whole-graph replace, and what this test
        // is about is the row being gone by the time the next sweep
        // reads it.
        if (request.page.items.length > 0) annaDb.db.run(sql`delete from step_routes where id = ${added.id}`);
        const served = await serveAdopt(serving, adoptPayload(anna.deviceId, request));
        return served.problem === null ? { ok: true, accepted: served.accepted } : { ok: false, problem: served.problem };
      },
    });

    expect(outcome.ok).toBe(true);
    expect(listRoutesForPipeline(recordDb.db, support.pipelineId).map((route) => route.id)).not.toContain(added.id);
    expect(counts(recordDb, support.id)).toEqual(counts(annaDb, support.id));
  });

  it("says so rather than silently differing when a step it must remove is occupied", async () => {
    const support = projectWithItsOwnGraph();
    const spare = createStep(annaDb.db, {
      pipelineId: support.pipelineId,
      position: 98,
      name: "A step nobody keeps",
      type: "user",
    });
    signIn(anna);

    // The record takes the step, an item lands on it there, and then
    // the sender stops having it. `items.step_id` is a foreign key, so
    // the record cannot remove it — and a graph that cannot be
    // reconciled ends the move rather than quietly differing from the
    // one it was moved from.
    const outcome = await moveProjectToRecord({
      db: annaDb.db,
      projectId: support.id,
      personId: annaPersonId,
      personName: "Anna",
      files: anna.files,
      send: async (request) => {
        const served = await serveAdopt(serving, adoptPayload(anna.deviceId, request));
        if (request.page.items.length > 0) {
          createTestItem(recordDb.db, { type: "story", title: "Somebody else's", stepId: spare.id, projectId: support.id });
          annaDb.db.run(sql`delete from step_routes where from_step_id = ${spare.id}`);
          annaDb.db.run(sql`delete from pipeline_steps where id = ${spare.id}`);
        }
        return served.problem === null ? { ok: true, accepted: served.accepted } : { ok: false, problem: served.problem };
      },
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? "" : outcome.problem).toContain("still has work sitting on it");
    expect(getProject(annaDb.db, support.id)?.managedAt).toBeNull();
  });
});

describe("a graph nobody owns", () => {
  it("is not rewritten by somebody moving a project that stands on it", async () => {
    const support = localProject("Support", "SUP");
    itemOn(support.id, "A refund");
    // The seeded Delivery board, still nobody's — as it was before EO-766
    // gave every project its own — which this project's work stands on,
    // and on an organisation's record *everybody's*.
    const shared = getPipeline(annaDb.db, "default")!;
    expect(shared.projectId).toBeNull();
    const step = listStepsForPipeline(annaDb.db, shared.id)[0]!;
    updateStep(annaDb.db, step.id, { planMode: true });
    const wasOnTheRecord = listStepsForPipeline(recordDb.db, shared.id).find((one) => one.id === step.id);

    signIn(anna);
    const outcome = await move(support.id);

    // **The review's fourth finding.** One person's local edits to
    // their own default board must not silently change the routing of
    // every other project on the organisation's record. A move carries
    // work, not the organisation's configuration — publishing a graph
    // is 7c's, with a lock and somebody's consent attached to it.
    expect(outcome).toEqual({});
    expect(listStepsForPipeline(recordDb.db, shared.id).find((one) => one.id === step.id)?.planMode).toBe(wasOnTheRecord?.planMode);
    expect(getProject(recordDb.db, support.id)?.managedAt).not.toBeNull();
    // …and it is still nobody's there, rather than having been claimed
    // for the project that happened to move.
    expect(listPipelines(recordDb.db, undefined, true).find((one) => one.id === shared.id)?.projectId).toBeNull();
  });

  it("stops the move when the record's copy has no step the work is standing on", async () => {
    const support = localProject("Support", "SUP");
    const shared = getPipeline(annaDb.db, "default")!;
    const invented = createStep(annaDb.db, { pipelineId: shared.id, position: 97, name: "A step only here", type: "user" });
    itemOn(support.id, "A refund");
    signIn(anna);

    // A shared graph the record will not change, and work standing on a
    // step the record's copy has never had. Said rather than landing in
    // no column.
    const answer = await move(support.id);
    expect(answer.problem).toContain("a move may not change a shared graph");
    expect(answer.problem).toContain(invented.id);
    expect(getProject(annaDb.db, support.id)?.managedAt).toBeNull();
  });
});

// ── A job pointed somewhere else mid-transfer ────────────────────────

describe("a job whose pipeline changes while the move runs", () => {
  it("arrives pointing where it points now", async () => {
    const support = localProject("Support", "SUP");
    itemOn(support.id, "The weekly report");
    const first = getPipeline(annaDb.db, "default")!;
    adoptPipeline(annaDb.db, first.id, support.id);
    const second = createPipeline(annaDb.db, { name: "The other flow", projectId: support.id });
    createStep(annaDb.db, { pipelineId: second.id, position: 0, name: "Waiting", type: "user" });
    const job = insertJob(annaDb.db, {
      projectId: support.id,
      name: "The weekly report",
      trigger: { kind: "manual" },
      pipelineId: first.id,
      template: null,
      ownerId: LOCAL_PERSON_ID,
    });
    signIn(anna);

    // **The review's third finding.** Every sweep re-sent the job and
    // the conflict clause wrote every column but this one, so the count
    // matched and the job fired into the wrong graph. A count that only
    // counts rows says nothing about what is in them.
    const outcome = await moveProjectToRecord({
      db: annaDb.db,
      projectId: support.id,
      personId: annaPersonId,
      personName: "Anna",
      files: anna.files,
      send: async (request) => {
        const served = await serveAdopt(serving, adoptPayload(anna.deviceId, request));
        if (request.page.jobs.length > 0) updateJobRow(annaDb.db, job.id as Uuid, { pipelineId: second.id });
        return served.problem === null ? { ok: true, accepted: served.accepted } : { ok: false, problem: served.problem };
      },
    });

    expect(outcome.ok).toBe(true);
    expect(getJob(recordDb.db, job.id as Uuid)?.pipelineId).toBe(second.id);
  });
});

// ── The types a moved project files its work under ───────────────────

describe("a project with an item type of its own", () => {
  /** A support project whose work is filed under a type EO does not ship. */
  function projectWithACustomType(): { id: Uuid; typeId: Uuid; item: Item } {
    const support = localProject("Support", "SUP");
    const type = createItemType(annaDb.db, {
      projectId: support.id,
      packSlug: "support",
      slug: "complaint",
      label: "Complaint",
      plural: "Complaints",
      container: false,
      specShape: EMPTY_SPEC_SHAPE,
    });
    const item = createTestItem(annaDb.db, {
      type: { packSlug: "support", slug: "complaint" },
      title: "The Q3 invoice",
      stepId: "todo",
      projectId: support.id,
    });
    return { id: support.id, typeId: type.id, item };
  }

  it("reaches the other desktop with the type it was filed under", async () => {
    const support = projectWithACustomType();
    signIn(anna);
    signIn(laptop);

    expect(await move(support.id)).toEqual({});
    await laptop.record.sync();

    // **The review's finding.** `item_types` reached the record on the
    // adoption page and had no way down: `record:changes` carried no
    // list and no cursor for them, and the replica *invented* its own
    // copies of whatever this installation happened to have. A type EO
    // does not ship was therefore nowhere on the second desktop, and
    // the item filed under it was dropped.
    const there = getItemType(laptopDb.db, support.typeId);
    expect(there?.slug).toBe("complaint");
    expect(there?.label).toBe("Complaint");
    expect(there?.projectId).toBe(support.id);

    // …and the item arrived filed under *that* row rather than under a
    // local one that happened to share a word.
    expect(getItem(laptopDb.db, support.item.id)?.typeId).toBe(support.typeId);
    expect(getItem(laptopDb.db, support.item.id)?.title).toBe("The Q3 invoice");
  });

  it("does not leave the other desktop with two rows for one word", async () => {
    const support = localProject("Support", "SUP");
    // The type this project's items are actually on, moved with its own
    // id. The laptop already has a `story` of its own in the
    // installation scope, seeded exactly as this machine's was.
    const item = itemOn(support.id, "A refund");
    const typeId = getItem(annaDb.db, item.id)!.typeId;
    signIn(anna);
    signIn(laptop);

    expect(await move(support.id)).toEqual({});
    await laptop.record.sync();

    // One row per word in the project's scope. The replica used to copy
    // the installation's types into every project it learned about, so
    // a moved `story` landed beside an invented one — and
    // `resolveItemType` refuses to choose between two rows sharing a
    // slug, which stops every item of that type resolving at all.
    expect(listItemTypes(laptopDb.db, support.id).filter((one) => one.slug === "story")).toHaveLength(1);
    expect(getItem(laptopDb.db, item.id)?.typeId).toBe(typeId);
    expect(resolveItemType(laptopDb.db, support.id, "story").ok).toBe(true);
  });

  it("waits for a type that is a page behind its items rather than dropping them", async () => {
    const support = projectWithACustomType();
    signIn(anna);
    signIn(laptop);
    expect(await move(support.id)).toEqual({});

    // A page so small that the types and the items cannot arrive
    // together. An item whose type has not landed is held rather than
    // dropped — dropping is right for a step this installation can
    // never have, and wrong for a row that is one page away.
    const slowly = createDeviceRecord({
      db: laptopDb.db,
      deviceId: () => laptop.deviceId,
      transport: transportFor(laptop),
      pullPageSize: 1,
    });
    try {
      for (let pass = 0; pass < 40; pass += 1) await slowly.sync();
    } finally {
      slowly.stop();
    }

    expect(getItem(laptopDb.db, support.item.id)?.typeId).toBe(support.typeId);
  });
});

// ── A project made after signing in ──────────────────────────────────

describe("creating a project while signed in", () => {
  /** The keep-or-move door, as `handlers.ts` builds it for this machine. */
  function handover(): KeepOrMoveContext {
    return {
      db: annaDb.db,
      // Signed in is not the same as reachable: a desktop whose network
      // has gone is still signed in, and what changes is what its
      // transport answers. `anna.online` drives the second, below.
      signedIn: () => true,
      personId: () => annaPersonId,
      personName: () => "Anna",
      files: anna.files,
      send: async (request) => {
        if (!anna.online) return { ok: false, problem: "EO could not reach https://eo.example: fetch failed" };
        const served = await serveAdopt(serving, adoptPayload(anna.deviceId, request));
        return served.problem === null ? { ok: true, accepted: served.accepted } : { ok: false, problem: served.problem };
      },
    };
  }

  it("puts it on the record, and on the person's other desktop", async () => {
    signIn(anna);
    signIn(laptop);

    const created = await createProjectCommand(annaDb.db, { name: "Support", keyPrefix: "SUP", repositoryIds: [] }, handover());

    expect(created.ok).toBe(true);
    expect(created.problem).toBeNull();
    // **The review's finding.** The column that says the record holds a
    // project used to be written by `createProject` on the strength of
    // this machine being signed in — and nothing sent it anywhere. The
    // outbound queue carries moves, comments and runs; a project is not
    // one of those, which is why it has a transfer of its own. So a
    // project was born claiming to be somewhere it had never been, and
    // every write on it afterwards was queued for a server that had
    // never heard of it.
    const projectId = created.project!.id as Uuid;
    expect(getProject(recordDb.db, projectId)?.name).toBe("Support");
    expect(getProject(annaDb.db, projectId)?.managedAt).not.toBeNull();

    // …and it is a project the other desktop can draw a board from.
    await laptop.record.sync();
    expect(getProject(laptopDb.db, projectId)?.name).toBe("Support");
    expect(listItemTypes(laptopDb.db, projectId).length).toBeGreaterThan(0);
  });

  it("carries the work filed on it straight afterwards", async () => {
    signIn(anna);
    signIn(laptop);
    const created = await createProjectCommand(annaDb.db, { name: "Support", keyPrefix: "SUP", repositoryIds: [] }, handover());
    const projectId = created.project!.id as Uuid;

    // The ordinary path from here: the project is the record's, so a
    // comment on its work is queued for the organisation rather than
    // written as this machine's own.
    const item = createTestItem(recordDb.db, { type: "story", title: "A refund", stepId: "todo", projectId });
    await anna.record.sync();
    anna.record.postComment({ itemId: item.id, author: { type: "human" }, body: "Refunded." });
    await anna.record.sync();
    await laptop.record.sync();

    expect(listCommentsForItem(laptopDb.db, item.id).map((comment) => comment.body)).toContain("Refunded.");
  });

  it("leaves it here, and says so, when the record cannot be reached", async () => {
    signIn(anna);
    anna.online = false;

    const created = await createProjectCommand(annaDb.db, { name: "Support", keyPrefix: "SUP", repositoryIds: [] }, handover());

    // Created either way: an outage is not a reason somebody cannot
    // start work (ARCHITECTURE.md, "The record"). What it is not is *claimed* — the project is
    // this machine's, it says so, and the keep-or-move sheet offers it
    // when the record is reachable again.
    expect(created.ok).toBe(true);
    expect(created.problem).toContain("could not hand it to your organisation");
    const projectId = created.project!.id as Uuid;
    expect(getProject(annaDb.db, projectId)?.managedAt).toBeNull();
    expect(getProject(recordDb.db, projectId)).toBeUndefined();
    expect(listUndecidedProjects(annaDb.db).map((one) => one.name)).toContain("Support");
  });

  it("is simply a local project on a desktop that never signed in", async () => {
    const created = await createProjectCommand(
      annaDb.db,
      { name: "Support", keyPrefix: "SUP", repositoryIds: [] },
      { ...handover(), signedIn: () => false },
    );

    expect(created.problem).toBeNull();
    expect(getProject(annaDb.db, created.project!.id as Uuid)?.managedAt).toBeNull();
    expect(getProject(recordDb.db, created.project!.id as Uuid)).toBeUndefined();
  });
});

// ── Signing out does not move a project back ─────────────────────────

describe("a moved project after the credential goes", () => {
  /** Anna moves Support and keeps Marketing, then loses her token. */
  async function movedAndKept(): Promise<{ moved: Uuid; movedItem: Item; kept: Uuid; keptItem: Item }> {
    const support = localProject("Support", "SUP");
    const marketing = localProject("Marketing", "MKT");
    const movedItem = itemOn(support.id, "A refund");
    const keptItem = itemOn(marketing.id, "The Q3 note");
    signIn(anna);
    keepProjectLocal(annaDb.db, marketing.id);
    expect(await move(support.id)).toEqual({});
    return { moved: support.id, movedItem, kept: marketing.id, keptItem };
  }

  it("is not offered to the local scheduler, while the kept one still is", async () => {
    const both = await movedAndKept();

    // Signed out, or turned out by an admin — from here they are one
    // thing: there is no token, so there is no transport.
    anna.signedOut = true;
    expect(anna.record.linked()).toBe(false);

    const offers = await anna.record.offerWork({
      deviceId: anna.deviceId,
      capacity: 5,
      tickInput: buildTickInput(annaDb.db, { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 5 }, false),
    });

    // **The review's finding.** A missing transport used to send every
    // item to the local scheduler, so a project somebody had handed
    // over ran here again — dispatched, moved and pushed to a tracker
    // by a machine that is a replica of it. A one-way move undone by
    // forgetting a password, and two writers for one item.
    const offered = offers.map((offer) => offer.dispatch.item.id);
    expect(offered).not.toContain(both.movedItem.id);
    // …and the project she kept is hers, and still runs.
    expect(offered).toContain(both.keptItem.id);
  });

  it("still queues what is written on it, rather than keeping it here", async () => {
    const both = await movedAndKept();
    anna.signedOut = true;

    anna.record.postComment({ itemId: both.movedItem.id, author: { type: "human" }, body: "Refunded." });
    anna.record.postComment({ itemId: both.keptItem.id, author: { type: "human" }, body: "Sent." });

    // The moved project's comment is the record's to apply, so it waits
    // in the queue for a credential rather than landing as this
    // machine's own word on the matter. The kept project's is simply
    // this machine's, and is queued for nobody.
    const waiting = pendingCommands(annaDb.db, 50).map((command) => command.itemId);
    expect(waiting).toContain(both.movedItem.id);
    expect(waiting).not.toContain(both.keptItem.id);
  });

  it("still leaves the tracker to the record, and still tells it about the kept one", async () => {
    const both = await movedAndKept();
    // Both items mirror an issue and sit in a checkout, which is what
    // makes a tracker push something either of them could produce.
    const workspace = createGitWorkspace(annaDb.db, { config: { name: "acme", repoPath: "/tmp/acme" } });
    for (const item of [both.movedItem, both.keptItem]) {
      annaDb.db.run(sql`update items set workspace_id = ${workspace.id} where id = ${item.id}`);
    }
    linkJiraKey(annaDb.db, both.movedItem.id, "SUP-9");
    linkJiraKey(annaDb.db, both.keptItem.id, "MKT-4");
    anna.signedOut = true;

    anna.record.postComment({ itemId: both.movedItem.id, author: { type: "human" }, body: "Refunded." });
    anna.record.postComment({ itemId: both.keptItem.id, author: { type: "human" }, body: "Sent." });

    // A replica does not tell anybody's tracker: the record does that,
    // once, rather than this machine doing it early and every other
    // machine doing it again on the pull (`recordRole.ts`). Losing a
    // token does not make this machine the one that owns the push.
    expect(pendingPushesForItem(annaDb.db, both.movedItem.id)).toHaveLength(0);
    expect(pendingPushesForItem(annaDb.db, both.keptItem.id).length).toBeGreaterThan(0);
  });

  it("carries what was written while signed out once a credential comes back", async () => {
    const both = await movedAndKept();
    anna.signedOut = true;
    anna.record.postComment({ itemId: both.movedItem.id, author: { type: "human" }, body: "Refunded while signed out." });

    // Nothing reaches the record while there is no token.
    await anna.record.sync();
    expect(listCommentsForItem(recordDb.db, both.movedItem.id).map((one) => one.body)).not.toContain("Refunded while signed out.");

    // …and everything does the moment one is back. The queue is the
    // same one an outage fills, because signing out is a long outage
    // rather than a way back.
    anna.signedOut = false;
    await anna.record.sync();
    expect(listCommentsForItem(recordDb.db, both.movedItem.id).map((one) => one.body)).toContain("Refunded while signed out.");
  });

  it("does not become undecided again, so the sheet never offers to keep it", async () => {
    const both = await movedAndKept();
    anna.signedOut = true;

    // `managed_at` is a point of no return written by the transfer that
    // put the rows there, and a token being forgotten does not bring
    // them back.
    expect(getProject(annaDb.db, both.moved)?.managedAt).not.toBeNull();
    expect(listUndecidedProjects(annaDb.db).map((one) => one.name)).not.toContain("Support");
    expect(keepProjectLocal(annaDb.db, both.moved)).toBeUndefined();
  });
});

// ── What a job has already done ──────────────────────────────────────

describe("a project whose job has already fired", () => {
  /** A project with a job, one firing and one skip behind it. */
  function projectWithAJobBehindIt(): { id: Uuid; jobId: Uuid; fired: Uuid } {
    const support = localProject("Support", "SUP");
    const thread = itemOn(support.id, "The weekly report");
    const pipeline = getPipeline(annaDb.db, "default")!;
    adoptPipeline(annaDb.db, pipeline.id, support.id);
    const job = insertJob(annaDb.db, {
      projectId: support.id,
      name: "The weekly report",
      trigger: { kind: "manual" },
      pipelineId: pipeline.id,
      template: null,
      ownerId: LOCAL_PERSON_ID,
    });
    const fired = recordOccurrence(annaDb.db, { jobId: job.id as Uuid, dueAt: 1_000, status: "fired", firedAt: 1_001, itemId: thread.id });
    recordOccurrence(annaDb.db, { jobId: job.id as Uuid, dueAt: 2_000, status: "skipped", reason: "The previous one was still open." });
    return { id: support.id, jobId: job.id as Uuid, fired: fired.id as Uuid };
  }

  it("moves its history with it", async () => {
    const support = projectWithAJobBehindIt();
    signIn(anna);
    const before = counts(annaDb, support.id);
    expect(before.occurrences).toBe(2);

    expect(await move(support.id)).toEqual({});

    // **The review's first finding.** The schedule travelled and the
    // account of it did not, so the record would fire an occurrence
    // this machine had already fired — and the skip somebody was told
    // about would be gone from its history.
    expect(counts(recordDb, support.id)).toEqual(before);
    const there = listOccurrences(recordDb.db, support.jobId);
    expect(there.map((one) => one.status).sort()).toEqual(["fired", "skipped"]);
    expect(there.find((one) => one.id === support.fired)?.firedAt).toBe(1_001);
    expect(there.find((one) => one.status === "skipped")?.reason).toBe("The previous one was still open.");
    // …and the record will not fire that due time again, which is the
    // whole reason the row is append-only.
    expect(hasFiredAt(recordDb.db, support.jobId, 1_000)).toBe(true);
  });
});

// ── What the move says it moved ──────────────────────────────────────

describe("the count a finished move reports", () => {
  it("is what the record holds, not what the sweeps acknowledged", async () => {
    const support = localProject("Support", "SUP");
    itemOn(support.id, "A refund");
    itemOn(support.id, "A chargeback");
    signIn(anna);

    let passes = 0;
    const outcome = await moveProjectToRecord({
      db: annaDb.db,
      projectId: support.id,
      personId: annaPersonId,
      personName: "Anna",
      files: anna.files,
      send: async (request) => {
        if (request.page.itemTypes.length > 0) passes += 1;
        const served = await serveAdopt(serving, adoptPayload(anna.deviceId, request));
        return served.problem === null ? { ok: true, accepted: served.accepted } : { ok: false, problem: served.problem };
      },
    });

    expect(outcome.ok).toBe(true);
    // The structure goes on every pass, so that a pipeline added mid
    // transfer arrives — which means more than one pass acknowledged
    // it. That is correct, and adding the acknowledgements up was not.
    expect(passes).toBeGreaterThan(1);

    // **The review's third finding.** The report used to be the sum of
    // what every pass was told, so a two-pass move claimed twice as
    // many types, pipelines, steps and routes as exist. A number that
    // says two of something the record holds one of is a number nobody
    // can check anything against.
    const moved = outcome.ok ? outcome.moved : null;
    const { skipped, ...reported } = moved!;
    expect(skipped).toEqual([]);
    // Row for row against both databases, which is the comparison the
    // story asks for and the one an accumulated total could not be put
    // through.
    expect(reported).toEqual(countProjectRows(annaDb.db, support.id));
    expect(reported).toEqual(countProjectRows(recordDb.db, support.id));
    expect(reported.itemTypes).toBeGreaterThan(0);
    expect(reported.items).toBe(2);
  });
});

// ── Whose inbox a pulled escalation lands in ─────────────────────────

describe("an escalation pulled onto somebody else's desktop", () => {
  it("stays the person it was asking, rather than becoming whoever is looking", async () => {
    // Dana is a colleague with a machine of her own on the same record.
    const dana = createPerson(recordDb.db, { name: "Dana", email: "dana@example.com" });
    const danaHandle = openMigratedTestDb();
    const danaDesk = desktop(danaHandle, issueDevice(recordDb.db, { personId: dana.id, name: "dana-desk", tokenHash: "h9", secretsKeyHash: null }).id);
    setSetting(danaHandle.db, MANAGED_PERSON_ID_KEY, dana.id);
    try {
      const support = localProject("Support", "SUP");
      const item = itemOn(support.id, "A refund");
      const asked = postComment(annaDb.db, {
        itemId: item.id,
        author: { type: "engine" },
        body: "Waiting on you.",
        kind: "escalation",
        mentions: [{ type: "human" }],
      });
      signIn(anna);
      signIn(laptop);
      expect(await move(support.id)).toEqual({});

      await laptop.record.sync();
      await danaDesk.record.sync();

      // **The review's second finding.** The replica threw the person
      // away and let `postComment` fall back to "whoever is in front of
      // this machine", so Anna's escalation arrived as Dana's on Dana's
      // desktop — and as nobody's on Anna's second one.
      expect(listMentionsForComment(danaHandle.db, asked.id).map((one) => one.targetId)).toEqual([annaPersonId]);
      expect(openMentionsForHuman(danaHandle.db).map((row) => row.comment.id)).not.toContain(asked.id);
      expect(needsAttention(danaHandle.db, item.id)).toBe(false);

      // …and it is Anna's, on both of hers.
      expect(openMentionsForHuman(annaDb.db).map((row) => row.comment.id)).toContain(asked.id);
      expect(openMentionsForHuman(laptopDb.db).map((row) => row.comment.id)).toContain(asked.id);
    } finally {
      danaDesk.record.stop();
      danaHandle.close();
    }
  });
});

// ── Who fires a moved project's jobs ─────────────────────────────────

describe("a scheduled job on a project that has moved", () => {
  /**
   * A desktop that knows which of its projects are somebody else's.
   *
   * `markReplica` is what `createDeviceRecord` installs in production;
   * `createDeviceRecord` in this file's fixtures installs it too, so
   * this only makes the fixture's own `Db` the one the job scheduler
   * reads. Returned as a disposer, because the flag is keyed on the
   * database and two of them over one database would be two answers.
   */
  function jobFixture(): { projectId: Uuid; jobId: Uuid; due: number } {
    const support = localProject("Support", "SUP");
    itemOn(support.id, "The weekly report");
    const pipeline = getPipeline(annaDb.db, "default")!;
    adoptPipeline(annaDb.db, pipeline.id, support.id);
    const job = insertJob(annaDb.db, {
      projectId: support.id,
      name: "The weekly report",
      trigger: WEEKLY_0800,
      pipelineId: pipeline.id,
      template: { type: "story", title: "This week", body: null },
      ownerId: LOCAL_PERSON_ID,
    });
    // `insertJob` stamps "now", and this is a job that already existed
    // when the occurrence came round.
    annaDb.db.run(sql`update jobs set created_at = ${MONDAY_0800 - 60_000} where id = ${job.id}`);
    return { projectId: support.id, jobId: job.id as Uuid, due: MONDAY_0800 };
  }

  it("is passed over here and fired by the record", async () => {
    const fixture = jobFixture();
    signIn(anna);
    expect(await move(fixture.projectId)).toEqual({});

    // **The review's first finding.** A job fires by *creating an
    // item*, which is the record's to write — and a created item is not
    // one of the commands the outbound queue carries, so a desktop
    // firing one would file work the record never hears about, beside
    // the one the record filed for the same due minute.
    const here = runJobTick(annaDb.db, { now: fixture.due + 70 * 60_000 });
    expect(here.considered).toBe(0);
    expect(here.fired).toEqual([]);
    expect(listOccurrences(annaDb.db, fixture.jobId)).toEqual([]);

    // The record is the one writer, and it fires it.
    const there = runJobTick(recordDb.db, { now: fixture.due + 70 * 60_000 });
    expect(there.fired).toContain(fixture.jobId);
    expect(listOccurrences(recordDb.db, fixture.jobId).length).toBeGreaterThan(0);
  });

  it("is still this machine's to fire on a project that was kept", async () => {
    const fixture = jobFixture();
    signIn(anna);
    keepProjectLocal(annaDb.db, fixture.projectId);

    // A kept project is the person's, and behaves exactly as it did in
    // solo mode — which is the whole of the first acceptance criterion.
    const here = runJobTick(annaDb.db, { now: fixture.due + 70 * 60_000 });
    expect(here.fired).toContain(fixture.jobId);
    expect(listOccurrences(annaDb.db, fixture.jobId).length).toBeGreaterThan(0);
  });

  it("is still the record's own to fire, on the record", () => {
    // The server is the record, so nothing about a moved project makes
    // it somebody else's replica — `isTheRecord`. Without that the
    // record would decline to fire the jobs it is the only one able to
    // fire, and a moved schedule would simply stop.
    createTestItem(recordDb.db, { type: "story", title: "The weekly report", stepId: "todo" });
    const job = insertJob(recordDb.db, {
      projectId: null,
      name: "The weekly report",
      trigger: WEEKLY_0800,
      pipelineId: "default",
      template: { type: "story", title: "This week", body: null },
      ownerId: LOCAL_PERSON_ID,
    });
    recordDb.db.run(sql`update jobs set created_at = ${MONDAY_0800 - 60_000} where id = ${job.id}`);

    expect(runJobTick(recordDb.db, { now: MONDAY_0800 + 70 * 60_000 }).fired).toContain(job.id);
  });
});

// ── A pin taken off while the move was running ───────────────────────

describe("a pin changed during a move", () => {
  it("arrives as it stands, in either direction", async () => {
    const support = localProject("Support", "SUP");
    const item = itemOn(support.id, "A refund");
    const pinned = postComment(annaDb.db, { itemId: item.id, author: { type: "human" }, body: "The Q3 number is wrong." });
    setCommentPinned(annaDb.db, pinned.id, true);
    const loose = postComment(annaDb.db, { itemId: item.id, author: { type: "human" }, body: "And the Q2 one." });
    signIn(anna);

    // **The review's second finding.** A pin is two states, not a
    // version, and the sweep ordered it: `false` read as older than
    // `true`, so a comment sent pinned and unpinned before the commit
    // was never re-sent and the record kept a pin the person had taken
    // off. The other direction was never in doubt, which is why one
    // test drives both.
    let changed = false;
    const outcome = await moveProjectToRecord({
      db: annaDb.db,
      projectId: support.id,
      personId: annaPersonId,
      personName: "Anna",
      files: anna.files,
      send: async (request) => {
        const served = await serveAdopt(serving, adoptPayload(anna.deviceId, request));
        if (!changed && request.page.comments.length > 0) {
          changed = true;
          setCommentPinned(annaDb.db, pinned.id, false);
          setCommentPinned(annaDb.db, loose.id, true);
        }
        return served.problem === null ? { ok: true, accepted: served.accepted } : { ok: false, problem: served.problem };
      },
    });

    expect(outcome.ok).toBe(true);
    expect(changed).toBe(true);
    expect(getComment(recordDb.db, pinned.id)?.pinned).toBe(false);
    expect(getComment(recordDb.db, loose.id)?.pinned).toBe(true);
  });
});

// ── Firing, while a project is half way to somewhere else ────────────

describe("a job whose project is mid-transfer", () => {
  /** A project with a weekly job on it, already due once. */
  function jobDueOn(projectId: Uuid): Uuid {
    itemOn(projectId, "The weekly report");
    const pipeline = getPipeline(annaDb.db, "default")!;
    adoptPipeline(annaDb.db, pipeline.id, projectId);
    const job = insertJob(annaDb.db, {
      projectId,
      name: "The weekly report",
      trigger: WEEKLY_0800,
      pipelineId: pipeline.id,
      template: { type: "story", title: "This week", body: null },
      ownerId: LOCAL_PERSON_ID,
    });
    annaDb.db.run(sql`update jobs set created_at = ${MONDAY_0800 - 60_000} where id = ${job.id}`);
    return job.id as Uuid;
  }

  it("fires on neither side while the transfer is running", () => {
    const support = localProject("Support", "SUP");
    const jobId = jobDueOn(support.id);
    signIn(anna);
    beginAdoption(annaDb.db, support.id);

    // **The review's first finding, its first half.** The rows are half
    // here and half there, so an item filed into the middle belongs to
    // neither — and the tick was gated on a *finished* replica, which a
    // transfer in flight is not yet.
    const here = runJobTick(annaDb.db, { now: MONDAY_0800 + 70 * 60_000 });
    expect(here.considered).toBe(0);
    expect(listOccurrences(annaDb.db, jobId)).toEqual([]);

    // …and pressing Run now says so rather than filing one anyway.
    const pressed = fireJob(annaDb.db, getJob(annaDb.db, jobId)!);
    expect(pressed.item).toBeNull();
    expect(pressed.problem).toContain("being moved");
  });

  it("is not fired by Run now on the desktop that handed it over", async () => {
    const support = localProject("Support", "SUP");
    const jobId = jobDueOn(support.id);
    signIn(anna);
    expect(await move(support.id)).toEqual({});

    // **The second half.** The tick passed over it and the presses did
    // not: Run now filed an item and an occurrence on a machine that is
    // a replica of the project they belong to, and neither is a command
    // the outbound queue carries — so the record never heard about
    // either and the copy stopped being a copy.
    const before = countProjectRows(annaDb.db, support.id);
    const pressed = fireJob(annaDb.db, getJob(annaDb.db, jobId)!);

    expect(pressed.item).toBeNull();
    expect(pressed.problem).toContain("record files its work");
    // No item, and no occurrence either: a row saying "this machine
    // declined" is a row the record never hears about, on a project
    // whose whole account of itself is meant to be the record's.
    expect(pressed.occurrence).toBeNull();
    // Nothing written on the project at all — no item, no occurrence.
    const after = countProjectRows(annaDb.db, support.id);
    expect(after).toEqual(before);
    // Every guard ends in a message where there is no item (invariant
    // #8, EO-729): to the person at this desktop, about no project, so it
    // is kept and handled here rather than on the organisation's record.
    const told = messagesAboutJob(annaDb.db, jobId);
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ projectId: null, source: "job_declined", recipientId: signedInPersonId(annaDb.db) });
    expect(told[0]?.body).toContain("record files its work");
    expect(pendingCommands(annaDb.db, 50)).toEqual([]);

    // The record is the one that files it, and does.
    const there = runJobTick(recordDb.db, { now: MONDAY_0800 + 70 * 60_000 });
    expect(there.fired).toContain(jobId);
  });
});

// ── A graph pulled before its project was live ───────────────────────

describe("a desktop that syncs in the middle of somebody else's move", () => {
  it("ends up with the project's own graph attached to it", async () => {
    const support = localProject("Support", "SUP");
    // A graph the project owns, rather than the shared seeded board:
    // only an owned one can be left installation-scoped by this.
    const pipeline = createPipeline(annaDb.db, { name: "The support flow", projectId: support.id });
    const waiting = createStep(annaDb.db, { pipelineId: pipeline.id, position: 0, name: "Waiting", type: "user" });
    setEntryStep(annaDb.db, pipeline.id, waiting.id);
    const item = createTestItem(annaDb.db, { type: "story", title: "A refund", stepId: waiting.id, projectId: support.id });
    signIn(anna);
    signIn(laptop);
    let pulledMidMove = false;

    // The laptop pulls *during* the transfer, which is the case the
    // review found: the graph had already gone up, the project had not
    // been finalised, and the pipeline cursor moved past a row the
    // replica could only write with no project to attach it to.
    const outcome = await moveProjectToRecord({
      db: annaDb.db,
      projectId: support.id,
      personId: annaPersonId,
      personName: "Anna",
      files: anna.files,
      send: async (request) => {
        const served = await serveAdopt(serving, adoptPayload(anna.deviceId, request));
        // Once, on the first page that carries the graph — the sweep
        // re-sends the structure on every pass, and a later one runs
        // *after* the commit, by which time the laptop is entitled to
        // it.
        if (!pulledMidMove && request.page.pipelines.length > 0) {
          pulledMidMove = true;
          await laptop.record.sync();
        }
        return served.problem === null ? { ok: true, accepted: served.accepted } : { ok: false, problem: served.problem };
      },
    });
    expect(outcome.ok).toBe(true);
    expect(pulledMidMove).toBe(true);

    // Nothing of a project still arriving reaches another desktop.
    expect(listPipelines(laptopDb.db, undefined, true).find((one) => one.id === pipeline.id)).toBeUndefined();

    // …and once it is live, the whole of it does — attached to its
    // project rather than stranded in the installation's scope.
    await laptop.record.sync();
    expect(getProject(laptopDb.db, support.id)?.name).toBe("Support");
    expect(listPipelines(laptopDb.db, undefined, true).find((one) => one.id === pipeline.id)?.projectId).toBe(support.id);
    expect(listStepsForPipeline(laptopDb.db, pipeline.id).map((one) => one.id)).toContain(waiting.id);
    expect(getItem(laptopDb.db, item.id)?.stepId).toBe(waiting.id);
  });
});

// ── A desktop that was already in use when the move happened ─────────

describe("a desktop whose cursors are already past the moved project's history", () => {
  it("reads the whole of it anyway, without its dates being rewritten", async () => {
    signIn(anna);
    signIn(laptop);

    // Something newer on the record first, so the laptop has cursors
    // that have run somewhere. This is the ordinary case and not a
    // contrived one: a person's second desktop has been syncing an
    // organisation's record for weeks before they move an old project
    // of their own onto it.
    const delivery = localProject("Delivery", "DEL");
    const todays = itemOn(delivery.id, "A release");
    postComment(annaDb.db, { itemId: todays.id, author: { type: "human" }, body: "Shipping on Friday." });
    expect(await move(delivery.id)).toEqual({});
    await laptop.record.sync();
    expect(getItem(laptopDb.db, todays.id)?.title).toBe("A release");

    // And a project from March, with an escalation nobody has answered.
    const support = localProject("Support", "SUP");
    const item = itemOn(support.id, "A refund");
    const asked = postComment(annaDb.db, {
      itemId: item.id,
      author: { type: "engine" },
      body: "Waiting on you about the amount.",
      kind: "escalation",
      mentions: [{ type: "human" }],
    });
    const march = Date.now() - 90 * 24 * 60 * 60 * 1000;
    backdate(support.id, march);

    expect(await move(support.id)).toEqual({});
    await laptop.record.sync();

    // **The review's finding.** Every list in `record:changes` pages
    // strictly forwards on when its rows were written, and the move
    // does not restamp what it carries — a comment written in March is
    // a comment written in March. So the laptop, whose cursors were
    // already at today, took the project row and asked for nothing
    // behind it: an empty board under the right name, and an
    // escalation that never reached the inbox it was addressed to.
    expect(getProject(laptopDb.db, support.id)?.name).toBe("Support");
    expect(getItem(laptopDb.db, item.id)?.title).toBe("A refund");
    expect(listCommentsForItem(laptopDb.db, item.id).map((one) => one.id)).toContain(asked.id);
    expect(openMentionsForHuman(laptopDb.db).map((row) => row.comment.id)).toContain(asked.id);
    expect(needsAttention(laptopDb.db, item.id)).toBe(true);

    // …and the history it read is still March's. The repair is a second
    // question, not a rewritten answer.
    expect(getComment(laptopDb.db, asked.id)?.createdAt).toBe(getComment(annaDb.db, asked.id)?.createdAt);
    expect(getComment(recordDb.db, asked.id)?.createdAt).toBeLessThan(march + 1000);

    // Read to the end, so it is not asked for again on every tick.
    expect(backfillsOwed(laptopDb.db)).toBe(0);
    const before = countProjectRows(annaDb.db, support.id);
    expect(countProjectRows(laptopDb.db, support.id).items).toBe(before.items);
    expect(countProjectRows(laptopDb.db, support.id).comments).toBe(before.comments);
  });
});

// ── An escalation that was already answered ──────────────────────────

describe("what a mention's history survives", () => {
  it("arrives addressed, dismissed or open, as it stands here", async () => {
    const support = localProject("Support", "SUP");
    const item = itemOn(support.id, "A refund");

    // Three escalations, and three different endings. The first was
    // answered a fortnight ago; the second somebody deliberately
    // dismissed; the third is still waiting.
    const answered = postComment(annaDb.db, {
      itemId: item.id,
      author: { type: "engine" },
      body: "Waiting on you about the amount.",
      kind: "escalation",
      mentions: [{ type: "human" }],
    });
    const reply = postComment(annaDb.db, { itemId: item.id, author: { type: "human" }, body: "It was £42." });
    resolveMentions(annaDb.db, reply.id);

    const dropped = postComment(annaDb.db, {
      itemId: item.id,
      author: { type: "engine" },
      body: "Waiting on you about the address.",
      kind: "escalation",
      mentions: [{ type: "human" }],
    });
    dismissOpenMentionsForComment(annaDb.db, dropped.id);

    const waiting = postComment(annaDb.db, {
      itemId: item.id,
      author: { type: "engine" },
      body: "Waiting on you about the refund.",
      kind: "escalation",
      mentions: [{ type: "human" }],
    });

    // One open row of the three, here, before anything moves.
    expect(openMentionsForHuman(annaDb.db).map((row) => row.comment.id)).toEqual([waiting.id]);

    signIn(anna);
    signIn(laptop);
    const before = counts(annaDb, support.id);
    expect(await move(support.id)).toEqual({});

    // **The review's finding.** A mention travelled as a *target* and
    // was rebuilt as `open` with nothing addressing it, so an
    // escalation somebody had answered a fortnight ago — and one they
    // had deliberately dismissed — came back open on the record and
    // landed in the signed-in person's inbox. The same number of rows,
    // and a different history: exactly what a count comparison cannot
    // see, which is why this asserts on the rows themselves.
    expect(counts(recordDb, support.id)).toEqual(before);
    const there = Object.fromEntries(
      [answered, dropped, waiting].map((comment) => [comment.id, listMentionsForComment(recordDb.db, comment.id)[0]]),
    );
    expect(there[answered.id]?.status).toBe("addressed");
    expect(there[answered.id]?.addressedBy).toBe(reply.id);
    expect(there[dropped.id]?.status).toBe("dismissed");
    expect(there[waiting.id]?.status).toBe("open");

    // …and every one of them is the signed-in person's, so the *open*
    // one is the only thing in her inbox — on her second desktop,
    // which is where her inbox is. The record's own `openMentionsForHuman`
    // asks about the server's implicit person and is nobody's inbox,
    // which is why this reads the rows there and the inbox here.
    expect(there[answered.id]?.targetId).toBe(annaPersonId);
    expect(there[waiting.id]?.targetId).toBe(annaPersonId);
    await laptop.record.sync();
    expect(openMentionsForHuman(laptopDb.db).map((row) => row.comment.id)).toEqual([waiting.id]);
    expect(needsAttention(laptopDb.db, item.id)).toBe(true);
  });

  it("closes on every machine when it is answered long after the move", async () => {
    const support = localProject("Support", "SUP");
    const item = itemOn(support.id, "A refund");
    signIn(anna);
    signIn(laptop);
    expect(await move(support.id)).toEqual({});

    // Two escalations and a question nobody has got to, all of them
    // said *after* the project moved — so they were written on a
    // replica, went up as commands, and came back down to the laptop.
    const answered = postComment(annaDb.db, {
      itemId: item.id,
      author: { type: "engine" },
      body: "Waiting on you about the amount.",
      kind: "escalation",
      mentions: [{ type: "human" }],
    });
    const dropped = postComment(annaDb.db, {
      itemId: item.id,
      author: { type: "engine" },
      body: "Waiting on you about the address.",
      kind: "escalation",
      mentions: [{ type: "human" }],
    });
    const waiting = postComment(annaDb.db, {
      itemId: item.id,
      author: { type: "engine" },
      body: "Waiting on you about the refund.",
      kind: "escalation",
      mentions: [{ type: "human" }],
    });
    await anna.record.sync();
    await laptop.record.sync();

    // All three are in front of her, on both of her machines, which is
    // the state the third acceptance criterion describes.
    expect(openMentionsForHuman(laptopDb.db).map((row) => row.comment.id).sort()).toEqual(
      [answered.id, dropped.id, waiting.id].sort(),
    );
    expect(needsAttention(laptopDb.db, item.id)).toBe(true);

    // She deals with two of them at the desk. One she replies to; one
    // she decides is not worth answering.
    // A threaded reply, which answers the one it hangs off rather than
    // everything the item is waiting on — see `resolveMentionsForComment`.
    const reply = postComment(annaDb.db, {
      itemId: item.id,
      author: { type: "human" },
      body: "It was £42.",
      parentId: answered.id,
    });
    dismissOpenMentionsForComment(annaDb.db, dropped.id);
    expect(openMentionsForHuman(annaDb.db).map((row) => row.comment.id)).toEqual([waiting.id]);

    await anna.record.sync();
    await laptop.record.sync();

    // **The review's finding.** Only the *making* of a comment was ever
    // queued, so answering one and dismissing one told nobody: the
    // record and her laptop went on showing three open escalations and
    // a `!` on an item she had already dealt with, for ever — a comment
    // is pulled once and never revisited, so nothing was ever going to
    // come back and correct them.
    const there = listMentionsForComment(recordDb.db, answered.id)[0];
    expect(there?.status).toBe("addressed");
    expect(there?.addressedBy).toBe(reply.id);
    expect(listMentionsForComment(recordDb.db, dropped.id)[0]?.status).toBe("dismissed");
    expect(listMentionsForComment(recordDb.db, waiting.id)[0]?.status).toBe("open");

    // …and the laptop's inbox is the desk's, which is the whole point
    // of one person having two of them.
    expect(openMentionsForHuman(laptopDb.db).map((row) => row.comment.id)).toEqual([waiting.id]);
    expect(listMentionsForComment(laptopDb.db, answered.id)[0]?.addressedBy).toBe(reply.id);
    expect(needsAttention(laptopDb.db, item.id)).toBe(true);

    // And when the last one goes, on the laptop this time, the desk
    // hears about it: the traffic is not one-way.
    dismissOpenMentionsForComment(laptopDb.db, waiting.id);
    await laptop.record.sync();
    await anna.record.sync();

    expect(listMentionsForComment(recordDb.db, waiting.id)[0]?.status).toBe("dismissed");
    expect(openMentionsForHuman(annaDb.db)).toEqual([]);
    expect(needsAttention(annaDb.db, item.id)).toBe(false);
    expect(needsAttention(laptopDb.db, item.id)).toBe(false);
  });

  it("arrives already closed on a desktop that was switched off at the time", async () => {
    const support = localProject("Support", "SUP");
    const item = itemOn(support.id, "A refund");
    signIn(anna);
    signIn(laptop);
    expect(await move(support.id)).toEqual({});

    // The laptop is shut. Everything below happens without it.
    laptop.online = false;
    const asked = postComment(annaDb.db, {
      itemId: item.id,
      author: { type: "engine" },
      body: "Waiting on you.",
      kind: "escalation",
      mentions: [{ type: "human" }],
    });
    dismissOpenMentionsForComment(annaDb.db, asked.id);
    await anna.record.sync();

    // It opens a week later and pulls the comment and its ending on the
    // same page — never having seen the question open. The settlement
    // waits for its comment rather than being dropped, which is what
    // makes the order of the two lists on that page not matter.
    laptop.online = true;
    await laptop.record.sync();

    expect(getComment(laptopDb.db, asked.id)).not.toBeUndefined();
    expect(listMentionsForComment(laptopDb.db, asked.id)[0]?.status).toBe("dismissed");
    expect(openMentionsForHuman(laptopDb.db)).toEqual([]);
    expect(needsAttention(laptopDb.db, item.id)).toBe(false);
  });

  it("carries an answer given while the move was running", async () => {
    const support = localProject("Support", "SUP");
    const item = itemOn(support.id, "A refund");
    const asked = postComment(annaDb.db, {
      itemId: item.id,
      author: { type: "engine" },
      body: "Waiting on you.",
      kind: "escalation",
      mentions: [{ type: "human" }],
    });
    signIn(anna);
    signIn(laptop);

    // A status is a state rather than a version — it moves between
    // open, addressed and dismissed in no particular order — so the
    // sweep compares it for difference, exactly as it does a pin.
    let answeredMidMove = false;
    const outcome = await moveProjectToRecord({
      db: annaDb.db,
      projectId: support.id,
      personId: annaPersonId,
      personName: "Anna",
      files: anna.files,
      send: async (request) => {
        const served = await serveAdopt(serving, adoptPayload(anna.deviceId, request));
        if (!answeredMidMove && request.page.mentions.length > 0) {
          answeredMidMove = true;
          dismissOpenMentionsForComment(annaDb.db, asked.id);
        }
        return served.problem === null ? { ok: true, accepted: served.accepted } : { ok: false, problem: served.problem };
      },
    });

    expect(outcome.ok).toBe(true);
    expect(answeredMidMove).toBe(true);
    expect(listMentionsForComment(recordDb.db, asked.id)[0]?.status).toBe("dismissed");
    // …so it is nobody's `!` either, on the machine whose inbox it is.
    await laptop.record.sync();
    expect(needsAttention(laptopDb.db, getItem(annaDb.db, asked.itemId)!.id)).toBe(false);
  });
});
