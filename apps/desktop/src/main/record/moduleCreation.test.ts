import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CustomModule, IpcPayload, Item, ModuleCreation, ModuleManifest, RecordAdoptCounts, Uuid } from "@eo/core";
import { dispatchBlocker } from "@eo/engine";
import { buildTickInput } from "../supervisor/buildTickInput.js";
import type { DbHandle } from "../db/client.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import {
  createProject,
  createRun,
  createRunEventBuffer,
  deleteItem,
  getItem,
  getItemByKey,
  getItemOrigin,
  getModule,
  getRun,
  listAllDependencies,
  removeDependency,
  updateItem,
  listCommentsForItem,
  listItemsForProject,
  listRunEvents,
  recordItemOrigin,
  saveModule,
  setItemArchived,
} from "../db/repos/index.js";
import { createPerson } from "../db/repos/peopleRepo.js";
import { issueDevice } from "../db/repos/devicesRepo.js";
import { setSetting } from "../db/repos/settingsRepo.js";
import { MANAGED_PERSON_ID_KEY } from "../identity/viewer.js";
import { AttachmentStorage } from "../attachments/storage.js";
import { getItemDetail, listItemSummaries } from "../ipc/domainQueries.js";
import { publishSectionCommand } from "../ipc/sectionCommands.js";
import { createModuleRunnerLookup } from "../modules/registry.js";
import { postModuleCreation } from "../modules/moduleCreations.js";
import { buildEligibilityInput } from "../supervisor/buildTickInput.js";
import { preparingAt } from "../supervisor/testWorkspaceKinds.js";
import { createLocalRecord, type LocalItemRecord } from "./localRecord.js";
import { createDeviceRecord, type DeviceRecord } from "./deviceRecord.js";
import { moveProjectToRecord } from "./adopt.js";
import {
  serveAdopt,
  serveApply,
  serveChanges,
  serveCreateItem,
  serveRelease,
  serveRenew,
  serveWork,
  type ServeRecordContext,
} from "./serveRecord.js";
import type { RecordTransport } from "./syncStatus.js";

/**
 * `ctx.createItem` where the item belongs to an organisation (EO-433).
 *
 * Three databases in one process, as `sync.test.ts` has them: the
 * record, and two of one person's desktops. A desktop's tables are a
 * replica of an organisation's project, so an item a module created
 * there and nowhere else would be work the organisation's board never
 * shows — the module told it succeeded, and nobody else able to see it.
 * So the creation is asked of the record, and these tests look at the
 * *record's* database for the item.
 *
 * And the other direction a project's rows travel: handed to a record,
 * and mirrored down to a second desktop. What made an item goes with
 * it, or the two guards that read it — a repeat answers with the item
 * already made, a generation 3 item cannot create — stop holding the
 * moment a project changes hands.
 */

const store = {
  isEncryptionAvailable: () => true,
  encryptString: (text: string) => Buffer.from(`enc:${text}`),
  decryptString: (buffer: Buffer) => buffer.toString().replace(/^enc:/, ""),
};
const hostPath = join(dirname(fileURLToPath(import.meta.url)), "..", "modules", "moduleHost.mjs");
const launcher = { execPath: process.execPath, hostPath, hostEnv: { ELECTRON_RUN_AS_NODE: "1" } };
const LIMITS = { globalConcurrency: 1, perAgentConcurrency: 1, perRepositoryConcurrency: 1 };

const NEEDS = { bin: [], env: [], network: false, item: false, comment: false, attach: false, create: true };
const manifest: ModuleManifest = { name: "Release", description: "Files the follow-up.", inputs: {}, needs: NEEDS, results: ["ok"] };
const STORY = { type: "story", title: "Write the changelog", body: "For 2.0.", spec: { acceptance_criteria: ["The changelog lists 2.0."] }, pipeline: "Delivery" };
const CODE = `export default async function run(ctx) {
  const answer = await ctx.createItem({ idempotencyKey: "changelog", ...${JSON.stringify(STORY)} });
  return { ok: true, result: "ok", detail: JSON.stringify(answer) };
}`;

interface Desktop {
  handle: DbHandle;
  record: DeviceRecord;
  online: boolean;
  deviceId: string;
  files: AttachmentStorage;
}

let recordDb: DbHandle;
let annaDb: DbHandle;
let laptopDb: DbHandle;
let theRecord: LocalItemRecord;
let serving: ServeRecordContext;
let anna: Desktop;
let laptop: Desktop;
let annaPersonId: Uuid;
let root: string;
let work: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "eo record create "));
  work = join(root, "work");
  mkdirSync(work);
  recordDb = openMigratedTestDb();
  annaDb = openMigratedTestDb();
  laptopDb = openMigratedTestDb();
  theRecord = createLocalRecord(recordDb.db);
  serving = {
    db: recordDb.db,
    record: theRecord,
    attachments: new AttachmentStorage(join(root, "record-files")),
    offerWork: (deviceId, capacity) => theRecord.offerWork({ deviceId, capacity, tickInput: buildTickInput(recordDb.db, LIMITS, false) }),
  };
  const person = createPerson(recordDb.db, { name: "Anna", email: "anna@example.com" });
  annaPersonId = person.id;
  anna = desktop(annaDb, issueDevice(recordDb.db, { personId: person.id, name: "anna-desk", tokenHash: "h1", secretsKeyHash: null }).id, "anna");
  laptop = desktop(laptopDb, issueDevice(recordDb.db, { personId: person.id, name: "anna-laptop", tokenHash: "h2", secretsKeyHash: null }).id, "laptop");
});

afterEach(() => {
  anna.record.stop();
  laptop.record.stop();
  recordDb.close();
  annaDb.close();
  laptopDb.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
});

function desktop(handle: DbHandle, deviceId: string, name: string): Desktop {
  const machine: Desktop = { handle, online: true, deviceId, files: new AttachmentStorage(join(root, `${name}-files`)), record: undefined as unknown as DeviceRecord };
  const transport: RecordTransport = {
    async request(channel, payload) {
      if (!machine.online) return { ok: false, error: { message: "EO could not reach https://eo.example: fetch failed" } };
      const answer = await answerOnTheRecord(channel, payload);
      return answer === null ? { ok: false, error: { message: `EO has no channel called "${channel}".` } } : { ok: true, data: answer as never };
    },
  };
  machine.record = createDeviceRecord({ db: handle.db, deviceId: () => deviceId, transport: () => transport, pullPageSize: 500 });
  return machine;
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
    case "record:createItem":
      return await serveCreateItem(serving, payload as IpcPayload<"record:createItem">);
    default:
      return null;
  }
}

function saved(handle: DbHandle, slug: string, needs: ModuleManifest["needs"] = NEEDS): CustomModule {
  const result = saveModule(handle.db, { slug, name: "Release", description: "Files the follow-up.", code: CODE, manifest: { ...manifest, needs }, approve: true });
  if (!result.ok) throw new Error(result.reason);
  return result.module;
}

/** The organisation's module, published, and on Anna's desktop under the record's own id. */
async function publishedModule(needs: ModuleManifest["needs"] = NEEDS): Promise<CustomModule> {
  const theirs = saved(recordDb, "release", needs);
  publishSectionCommand(recordDb.db, { section: "pipelines", pipelineId: null, versionNumber: null });
  await anna.record.sync();
  const landed = getModule(annaDb.db, theirs.id);
  if (!landed) throw new Error("the published module did not reach the desktop");
  return landed;
}

/** Runs the module on Anna's desktop, on `item`, through the registry and a real host. */
async function runOnAnna(module: CustomModule, item: Item) {
  const row = createRun(annaDb.db, { itemId: item.id, agentId: null, action: module.id, status: "running", provider: "module" });
  const buffer = createRunEventBuffer(annaDb.db);
  const lookup = createModuleRunnerLookup({ db: annaDb.db, launcher, secrets: { directory: join(root, "secrets"), store }, record: anna.record });
  const outcome = await lookup(module.id)!({
    db: annaDb.db,
    item,
    prepareWorkspace: preparingAt(work),
    report: (text: string) => {
      buffer.append(row.id, "output", { type: "output", text });
      buffer.flush();
    },
    runId: row.id,
  });
  if (!outcome.ok) throw new Error(outcome.reason);
  return {
    runId: row.id,
    answer: JSON.parse(outcome.detail) as { created: boolean; key?: string; existing?: boolean; reason?: string },
    transcript: listRunEvents(annaDb.db, row.id)
      .map((event) => (event.payload as { text?: string }).text ?? "")
      .join(""),
  };
}

const titles = (handle: DbHandle): string[] => listItemsForProject(handle.db, null).map((item) => item.title);

describe("a leased module on a signed-in desktop creating work", () => {
  /** An item the record holds, pulled to Anna's desktop and leased to it. */
  async function leasedToAnna(): Promise<Item> {
    const onRecord = createTestItem(recordDb.db, { type: "story", title: "Ship 2.0", stepId: "todo" });
    await anna.record.sync();
    const lease = theRecord.grantLease({ itemId: onRecord.id, deviceId: anna.deviceId });
    expect(lease).not.toBeNull();
    const here = getItem(annaDb.db, onRecord.id);
    if (!here) throw new Error("the record's item did not reach the desktop");
    return here;
  }

  it("creates the item on the organisation's record, not only on the desktop", async () => {
    const module = await publishedModule();
    const item = await leasedToAnna();

    const result = await runOnAnna(module, item);

    expect(result.answer).toEqual({ created: true, key: expect.any(String), existing: false });
    const made = getItemByKey(recordDb.db, result.answer.key!);
    expect(made).toMatchObject({ title: "Write the changelog", body: "For 2.0.", pipelineId: "default", stepId: "worktree", spec: { acceptance_criteria: ["The changelog lists 2.0."] } });
    expect(getItemOrigin(recordDb.db, made!.id)).toMatchObject({ originItemId: item.id, runId: result.runId, moduleId: module.id, idempotencyKey: "changelog", generation: 1 });

    // Both notes, on the record, and the new item's naming a run the
    // record was sent with the request.
    expect(getRun(recordDb.db, result.runId)?.itemId).toBe(item.id);
    expect(listCommentsForItem(recordDb.db, item.id).map((comment) => comment.body)).toEqual([`**Release** (module) created ${made!.key}: Write the changelog`]);
    expect(listCommentsForItem(recordDb.db, made!.id)).toMatchObject([{ authorType: "engine", runId: result.runId, body: `Created by **Release** (module) from its run on ${item.key}.` }]);

    // Nothing was written to the replica by the creation itself…
    expect(getItemByKey(annaDb.db, made!.key)).toBeUndefined();
    // …and the pull brings the record's item, its origin and the note.
    await anna.record.sync();
    expect(getItemByKey(annaDb.db, made!.key)?.id).toBe(made!.id);
    expect(getItemOrigin(annaDb.db, made!.id)).toMatchObject({ originItemId: item.id, idempotencyKey: "changelog", generation: 1 });
    expect(listCommentsForItem(annaDb.db, item.id).map((comment) => comment.body)).toContain(`**Release** (module) created ${made!.key}: Write the changelog`);
    // One item, on both, after the round trip.
    expect(titles(recordDb).filter((title) => title === "Write the changelog")).toHaveLength(1);
    expect(titles(annaDb).filter((title) => title === "Write the changelog")).toHaveLength(1);
  });

  it("answers a later run with the item the record already made", async () => {
    const module = await publishedModule();
    const item = await leasedToAnna();
    const first = await runOnAnna(module, item);

    const again = await runOnAnna(module, item);

    expect(again.answer).toEqual({ created: true, key: first.answer.key, existing: true });
    expect(titles(recordDb).filter((title) => title === "Write the changelog")).toHaveLength(1);
  });

  it("creates nothing anywhere, and says so, when the record cannot be reached", async () => {
    const module = await publishedModule();
    const item = await leasedToAnna();
    anna.online = false;

    const result = await runOnAnna(module, item);

    expect(result.answer.created).toBe(false);
    expect(result.answer.reason).toContain("could not be reached");
    expect(result.transcript).toContain("EO did not create an item");
    expect(titles(recordDb)).not.toContain("Write the changelog");
    expect(titles(annaDb)).not.toContain("Write the changelog");
  });

  it("is refused by the record for a machine that does not hold the item", async () => {
    const module = await publishedModule();
    const onRecord = createTestItem(recordDb.db, { type: "story", title: "Ship 2.0", stepId: "todo" });
    await anna.record.sync();
    theRecord.grantLease({ itemId: onRecord.id, deviceId: laptop.deviceId });

    const result = await runOnAnna(module, getItem(annaDb.db, onRecord.id)!);

    expect(result.answer.created).toBe(false);
    expect(result.answer.reason).toContain("does not hold");
    expect(titles(recordDb)).not.toContain("Write the changelog");
  });

  it("is refused by the record when its own copy of the manifest does not declare needs.create", async () => {
    const module = await publishedModule({ ...NEEDS, create: false });
    const item = await leasedToAnna();
    // The desktop's copy says otherwise. The record reads its own.
    const answer = await anna.record.createItemFromModule({
      module: { ...module, manifest: { ...module.manifest, needs: NEEDS } },
      item,
      runId: createRun(annaDb.db, { itemId: item.id, agentId: null, action: module.id, status: "running", provider: "module" }).id,
      creation: { idempotencyKey: "changelog", ...STORY },
      atCap: false,
    });

    expect(answer).toMatchObject({ created: false });
    expect((answer as { reason: string }).reason).toContain("needs.create");
    expect(titles(recordDb)).not.toContain("Write the changelog");
  });

  /**
   * Waiting on a project an organisation holds (EO-434). The edges are
   * the record's to write, with the item — it is the record that
   * decides what work is handed to a device, so it is the record's
   * graph that has to hold. And the desktop has to be told: its board
   * and its item page read its own copy of the graph, and an edge only
   * the record knew would leave a held item looking free.
   */
  it("writes who waits for whom on the record, and the pull brings it to the desktop's board and item page", async () => {
    const module = await publishedModule();
    const item = await leasedToAnna();
    const runId = createRun(annaDb.db, { itemId: item.id, agentId: null, action: module.id, status: "running", provider: "module" }).id;
    const ask = (creation: Partial<ModuleCreation> & { idempotencyKey: string }) => anna.record.createItemFromModule({ module, item, runId, creation: { ...STORY, ...creation }, atCap: false });

    const held = await ask({ idempotencyKey: "blocks-this", wait: "this_waits" });
    const waiting = await ask({ idempotencyKey: "after-this", wait: "created_waits" });
    expect(held).toMatchObject({ created: true, existing: false });
    expect(waiting).toMatchObject({ created: true, existing: false });
    const blocker = getItemByKey(recordDb.db, (held as { key: string }).key)!;
    const follower = getItemByKey(recordDb.db, (waiting as { key: string }).key)!;

    const edges = (handle: DbHandle) => listAllDependencies(handle.db).map((edge) => `${edge.itemId}>${edge.dependsOnId}`).sort();
    const expected = [`${item.id}>${blocker.id}`, `${follower.id}>${item.id}`].sort();
    expect(edges(recordDb)).toEqual(expected);
    expect(listCommentsForItem(recordDb.db, item.id).map((comment) => comment.body)).toContain(
      `**Release** (module) created ${blocker.key}: Write the changelog\n\n${item.key} now waits for ${blocker.key}.`,
    );

    expect(dispatchBlocker(buildEligibilityInput(recordDb.db, false), follower.id as Uuid)).toEqual({ kind: "open_dependency" });
    expect(dispatchBlocker(buildEligibilityInput(recordDb.db, false), blocker.id as Uuid)).toBeNull();

    // Nothing was written to the replica by the creations themselves…
    expect(edges(annaDb)).toEqual([]);
    // …and the pull brings both edges. The originating item's own row
    // did not change, so the one it waits by arrives with the new item.
    await anna.record.sync();
    expect(edges(annaDb)).toEqual(expected);
    const onBoard = (id: string) => listItemSummaries(annaDb.db, getItem(annaDb.db, item.id)!.projectId).items.find((entry) => entry.id === id);
    expect(onBoard(item.id)?.openDependencyCount).toBe(1);
    expect(getItemDetail(annaDb.db, { itemId: item.id })?.dependsOn.map((entry) => entry.key)).toEqual([blocker.key]);
    expect(onBoard(follower.id)?.openDependencyCount).toBe(1);
    expect(getItemDetail(annaDb.db, { itemId: follower.id })?.dependsOn.map((entry) => entry.key)).toEqual([item.key]);
    // Pulled again, as every reconnect does: still one of each.
    await anna.record.sync();
    expect(edges(annaDb)).toEqual(expected);

    // An edge a repeat adds reaches the desktop too, though no item is new.
    expect(await ask({ idempotencyKey: "after-this", wait: "created_waits", dependsOn: [blocker.key] })).toMatchObject({ created: true, existing: true });
    await anna.record.sync();
    expect(edges(annaDb)).toEqual([...expected, `${follower.id}>${blocker.id}`].sort());

    // And one the record no longer has is taken off the desktop when
    // the item at its end is next sent.
    removeDependency(recordDb.db, follower.id as Uuid, blocker.id as Uuid);
    updateItem(recordDb.db, follower.id as Uuid, {});
    await anna.record.sync();
    expect(edges(annaDb)).toEqual(expected);

    // A wait the record does not know is refused by the record itself,
    // whatever the device that sent it thought of it.
    const unknown = await ask({ idempotencyKey: "odd", wait: "both" as never });
    expect(unknown).toMatchObject({ created: false });
    expect(titles(recordDb).filter((title) => title === "Write the changelog")).toHaveLength(2);
  });

  it("holds the record's cap of ten to its own count, and still answers a repeat past it", async () => {
    const module = await publishedModule();
    const item = await leasedToAnna();
    const runId = createRun(annaDb.db, { itemId: item.id, agentId: null, action: module.id, status: "running", provider: "module" }).id;
    const ask = (idempotencyKey: string) => anna.record.createItemFromModule({ module, item, runId, creation: { ...STORY, idempotencyKey }, atCap: false });

    for (let index = 0; index < 10; index += 1) expect(await ask(`k${index}`)).toMatchObject({ created: true, existing: false });
    // The device never says it is at the cap; the record counts.
    expect(await ask("one-more")).toMatchObject({ created: false });
    expect(await ask("k4")).toMatchObject({ created: true, existing: true });
    expect(titles(recordDb).filter((title) => title === "Write the changelog")).toHaveLength(10);
  });
});

describe("a project handed to a record, with items a module created on it", () => {
  function signIn(machine: Desktop): void {
    setSetting(machine.handle.db, MANAGED_PERSON_ID_KEY, annaPersonId);
  }

  async function move(projectId: Uuid): Promise<void> {
    const outcome = await moveProjectToRecord({
      db: annaDb.db,
      projectId,
      personId: annaPersonId,
      personName: "Anna",
      files: anna.files,
      send: async (request) => {
        const served = (await answerOnTheRecord("record:adopt", {
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
    if (!outcome.ok) throw new Error(outcome.problem);
  }

  it("keeps what made each one, so a repeat still answers and a generation 3 item still cannot create", async () => {
    const project = createProject(annaDb.db, { name: "Support", keyPrefix: "SUP", managed: false });
    const on = (title: string): Item => createTestItem(annaDb.db, { type: "story", title, stepId: "todo", projectId: project.id });
    const module = saved(annaDb, "release");
    const create = (item: Item, idempotencyKey: string) => {
      const answer = postModuleCreation(annaDb.db, { module, item, runId: null }, { ...STORY, idempotencyKey });
      if (!answer.created) throw new Error(answer.reason);
      return getItemByKey(annaDb.db, answer.key)!;
    };

    const origin = on("Ship 2.0");
    const child = create(origin, "changelog");
    // Archived before the move: still answers a repeat afterwards.
    const archived = create(origin, "release-notes");
    setItemArchived(annaDb.db, archived.id, Date.now());
    // Its originating item deleted before the move: still knows its generation.
    const doomed = on("Ship 1.9");
    const orphan = create(doomed, "changelog");
    deleteItem(annaDb.db, doomed.id);
    // And the end of a chain.
    const deep = on("Third in a chain");
    recordItemOrigin(annaDb.db, { itemId: deep.id, originItemId: child.id, runId: null, moduleId: module.id, idempotencyKey: "deep", generation: 3 });

    signIn(anna);
    signIn(laptop);
    await move(project.id);

    // On the record.
    expect(getItemOrigin(recordDb.db, child.id)).toMatchObject({ originItemId: origin.id, moduleId: module.id, idempotencyKey: "changelog", generation: 1 });
    expect(getItemOrigin(recordDb.db, archived.id)).toMatchObject({ originItemId: origin.id, idempotencyKey: "release-notes", generation: 1 });
    expect(getItemOrigin(recordDb.db, orphan.id)).toMatchObject({ originItemId: null, idempotencyKey: "changelog", generation: 1 });
    expect(getItemOrigin(recordDb.db, deep.id)).toMatchObject({ originItemId: child.id, generation: 3 });
    expect(getItemOrigin(recordDb.db, origin.id)).toBeUndefined();

    // A later run on the record: the same key is the same item, archived or not…
    const theirs = saved(recordDb, "release");
    const there = (id: Uuid): Item => getItem(recordDb.db, id)!;
    const before = listItemsForProject(recordDb.db, project.id).length;
    expect(postModuleCreation(recordDb.db, { module: theirs, item: there(origin.id), runId: null }, { ...STORY, idempotencyKey: "changelog" })).toEqual({ created: true, key: child.key, existing: true });
    expect(postModuleCreation(recordDb.db, { module: theirs, item: there(origin.id), runId: null }, { ...STORY, idempotencyKey: "release-notes" })).toEqual({
      created: true,
      key: archived.key,
      existing: true,
    });
    // …and the chain is as long as it was.
    const refused = postModuleCreation(recordDb.db, { module: theirs, item: there(deep.id), runId: null }, { ...STORY, idempotencyKey: "fourth" });
    expect(refused).toMatchObject({ created: false });
    expect((refused as { reason: string }).reason).toContain("generation 3");
    expect(listItemsForProject(recordDb.db, project.id)).toHaveLength(before);
    // A created item's own child is generation 2, not 1.
    const grandchild = postModuleCreation(recordDb.db, { module: theirs, item: there(child.id), runId: null }, { ...STORY, idempotencyKey: "next" });
    expect(grandchild).toMatchObject({ created: true, existing: false });
    expect(getItemOrigin(recordDb.db, getItemByKey(recordDb.db, (grandchild as { key: string }).key)!.id)?.generation).toBe(2);

    // And mirrored down to the person's other desktop.
    await laptop.record.sync();
    expect(getItemOrigin(laptopDb.db, child.id)).toMatchObject({ originItemId: origin.id, idempotencyKey: "changelog", generation: 1 });
    expect(getItemOrigin(laptopDb.db, orphan.id)).toMatchObject({ originItemId: null, generation: 1 });
    expect(getItemOrigin(laptopDb.db, deep.id)).toMatchObject({ originItemId: child.id, generation: 3 });
  });
});
