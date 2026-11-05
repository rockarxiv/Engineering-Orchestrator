import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IpcChannel, IpcPayload, IpcRequest, IpcResponse, IpcResult, Item, Uuid } from "@eo/core";
import type { ManagedDirectory } from "../managed/directory.js";
import { itemAuthorityCommand, listPeopleCommand } from "../ipc/identityCommands.js";
import { saveGroup } from "../db/repos/groupsRepo.js";
import { setStepOwner } from "../db/repos/pipelineStepsRepo.js";
import { buildTickInput } from "../supervisor/buildTickInput.js";
import type { DbHandle } from "../db/client.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { createPerson, getPerson } from "../db/repos/peopleRepo.js";
import { issueDevice } from "../db/repos/devicesRepo.js";
import { setSetting } from "../db/repos/settingsRepo.js";
import { MANAGED_PERSON_ID_KEY, MANAGED_PERSON_NAME_KEY } from "../identity/viewer.js";
import { getItem } from "../db/repos/itemsRepo.js";
import { getComment, listCommentsForItem, openMentionsForHuman } from "../db/repos/commentsRepo.js";
import { itemsWithQueuedMoves, pendingCommands, queuedCommandCount } from "../db/repos/recordCommandsRepo.js";
import { clearHandlerRegistry, dispatchIpc } from "../ipc/registry.js";
import { registerAllHandlers } from "../ipc/handlers.js";
import { fakePlatform } from "../testing/platform.js";
import type { Platform } from "../ipc/platform.js";
import { createLocalRecord, type LocalItemRecord } from "./localRecord.js";
import { createDeviceRecord, type DeviceRecord } from "./deviceRecord.js";
import { serveApply, serveChanges, serveRelease, serveRenew, serveWork, type ServeRecordContext } from "./serveRecord.js";
import type { RecordTransport } from "./syncStatus.js";

/**
 * A person's own actions, through the door they actually come in by
 * (EO-324, `ARCHITECTURE.md`, "The record").
 *
 * `sync.test.ts` drives the record contract; this drives the *product*.
 * Every action here is an IPC channel a renderer calls — `items:move`
 * is the drag, `items:decide` is the button on a human step,
 * `comments:post` is somebody typing — dispatched through the same
 * registry `platform.serveIpc` hangs the renderer's door on, against
 * handlers registered by the real `registerAllHandlers`.
 *
 * It exists because the gap it covers is the one that cannot be seen
 * from either side alone. A record that queues perfectly and a screen
 * that never reaches it are each fine on their own; together they are a
 * desktop that shows a person their move applied, sends it nowhere, and
 * is silently not what their organisation's board says.
 *
 * The one thing stubbed is the socket. Everything between the channel
 * and the record's own tables is the code that runs in production.
 */

const LIMITS = { globalConcurrency: 1, perAgentConcurrency: 1, perRepositoryConcurrency: 1 };

let recordDb: DbHandle;
let deviceDb: DbHandle;
let theRecord: LocalItemRecord;
let serving: ServeRecordContext;
let device: DeviceRecord;
let online: boolean;
let platform: Platform;
const directories: string[] = [];

beforeEach(() => {
  clearHandlerRegistry();
  recordDb = openMigratedTestDb();
  deviceDb = openMigratedTestDb();
  online = true;
  theRecord = createLocalRecord(recordDb.db);
  serving = {
    db: recordDb.db,
    record: theRecord,
    offerWork: (deviceId, capacity) =>
      theRecord.offerWork({ deviceId, capacity, tickInput: buildTickInput(recordDb.db, LIMITS, false) }),
  };

  // The desktop, composed as `startMain` composes it: one device record
  // over this database, and the IPC handlers registered against the
  // same one. Nothing below hands the record to a handler — that is the
  // point. A command queues because the write was made against a
  // database this machine keeps as a replica, not because whoever wrote
  // it remembered to.
  device = createDeviceRecord({
    db: deviceDb.db,
    deviceId: () => "anna-laptop",
    transport: () => transport,
  });
  platform = fakePlatform();
  directories.push(platform.userDataPath);
  registerAllHandlers(deviceDb.db, undefined, { platform });
});

afterEach(() => {
  device.stop();
  clearHandlerRegistry();
  recordDb.close();
  deviceDb.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const transport: RecordTransport = {
  async request<K extends IpcChannel>(channel: K, payload: IpcPayload<K>): Promise<IpcResult<IpcResponse<K>>> {
    if (!online) return { ok: false, error: { message: "EO could not reach https://eo.example: fetch failed" } };
    switch (channel) {
      case "record:work":
        return { ok: true, data: (await serveWork(serving, payload as IpcPayload<"record:work">)) as IpcResponse<K> };
      case "record:renew":
        return { ok: true, data: (await serveRenew(serving, payload as IpcPayload<"record:renew">)) as IpcResponse<K> };
      case "record:release":
        return { ok: true, data: (await serveRelease(serving, payload as IpcPayload<"record:release">)) as IpcResponse<K> };
      case "record:apply":
        return { ok: true, data: (await serveApply(serving, payload as IpcPayload<"record:apply">)) as IpcResponse<K> };
      case "record:changes":
        return { ok: true, data: serveChanges(serving, payload as IpcPayload<"record:changes">) as IpcResponse<K> };
      default:
        return { ok: false, error: { message: `EO has no channel called "${channel}".` } };
    }
  },
};

/** An item on the record, pulled down to the desktop — which is how one arrives in managed mode. */
async function anItemOnTheBoard(title = "Rate limiting"): Promise<Item> {
  const item = createTestItem(recordDb.db, { type: "story", title, stepId: "todo" });
  await device.sync();
  return item;
}

/**
 * What a renderer does, through the door a renderer uses.
 *
 * `IpcRequest` rather than `IpcPayload`, which is the distinction the
 * contract already draws and the one a caller is on the wrong side of:
 * a renderer sends what it has and the schema fills the defaults in, so
 * a test that had to spell out `cancelActiveRun` and `comment` on every
 * drag would be sending a shape no screen sends.
 */
async function asThePerson<K extends IpcChannel>(channel: K, payload: IpcRequest<K>): Promise<IpcResponse<K>> {
  const answer = await dispatchIpc(channel, payload);
  if (!answer.ok) throw new Error(`${channel} refused: ${answer.error.message}`);
  return answer.data as IpcResponse<K>;
}

describe("a move a person makes on a managed desktop", () => {
  it("is queued as a command by the IPC channel behind the drag", async () => {
    const item = await anItemOnTheBoard();

    const moved = await asThePerson("items:move", { itemId: item.id, toStepId: "review" });

    expect(moved.moved).toBe(true);
    // Applied here at once — a person pressing does not wait on a
    // network — and queued in the same breath.
    expect(getItem(deviceDb.db, item.id)?.stepId).toBe("review");
    const queued = pendingCommands(deviceDb.db);
    expect(queued.map((entry) => entry.kind)).toEqual(["transition"]);
    // …and the card says so, which is what the dashed border reads.
    expect(itemsWithQueuedMoves(deviceDb.db)).toEqual([item.id]);
  });

  it("reaches the record on the next sync, and stops being provisional", async () => {
    const item = await anItemOnTheBoard();
    await asThePerson("items:move", { itemId: item.id, toStepId: "review" });

    await device.sync();

    expect(getItem(recordDb.db, item.id)?.stepId).toBe("review");
    expect(queuedCommandCount(deviceDb.db)).toBe(0);
    expect(itemsWithQueuedMoves(deviceDb.db)).toEqual([]);
  });

  it("queues while offline and replays on reconnect", async () => {
    const item = await anItemOnTheBoard();

    online = false;
    await asThePerson("items:move", { itemId: item.id, toStepId: "review" });
    await device.sync();
    expect(getItem(recordDb.db, item.id)?.stepId).toBe("todo");
    expect(itemsWithQueuedMoves(deviceDb.db)).toEqual([item.id]);

    online = true;
    await device.sync();

    expect(getItem(recordDb.db, item.id)?.stepId).toBe("review");
    expect(itemsWithQueuedMoves(deviceDb.db)).toEqual([]);
  });

  it("is dropped with an inbox row when the record had already moved the item", async () => {
    const item = await anItemOnTheBoard();

    online = false;
    await asThePerson("items:move", { itemId: item.id, toStepId: "review" });

    // Somebody else moves it on the record while this desktop is away.
    theRecord.applyTransition({ itemId: item.id, toStepId: "ready_to_merge", actor: "human" });

    online = true;
    await device.sync();

    // The record won, and the person was told — in the inbox, which is
    // the query over open human mentions (invariant #4).
    expect(getItem(recordDb.db, item.id)?.stepId).toBe("ready_to_merge");
    expect(getItem(deviceDb.db, item.id)?.stepId).toBe("ready_to_merge");
    expect(itemsWithQueuedMoves(deviceDb.db)).toEqual([]);
    const inbox = openMentionsForHuman(deviceDb.db);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.comment.body).toContain(`Your move of ${item.key} was superseded by`);
  });
});

describe("what a person says on a managed desktop", () => {
  it("is queued by the IPC channel behind the message box, and reaches the record", async () => {
    const item = await anItemOnTheBoard();

    await asThePerson("comments:post", { itemId: item.id, body: "The Q3 number is wrong." });

    expect(pendingCommands(deviceDb.db).map((entry) => entry.kind)).toEqual(["comment"]);

    await device.sync();

    expect(listCommentsForItem(recordDb.db, item.id).map((comment) => comment.body)).toContain("The Q3 number is wrong.");
    expect(queuedCommandCount(deviceDb.db)).toBe(0);
  });

  it("carries the comment a move was made with, in the order it was written", async () => {
    // `items:move` posts the person's note *before* the transition, so
    // that it sits above the move in the thread and in front of
    // whichever agent the move dispatches (ARCHITECTURE.md, "Moving an item by hand"). The queue
    // has to preserve that, or the record's thread reads the other way
    // round.
    const item = await anItemOnTheBoard();

    await asThePerson("items:move", { itemId: item.id, toStepId: "review", comment: "Send it back — the Q3 number is wrong." });
    expect(pendingCommands(deviceDb.db).map((entry) => entry.kind)).toEqual(["comment", "transition"]);

    await device.sync();

    const said = listCommentsForItem(recordDb.db, item.id).map((comment) => comment.body);
    expect(said).toContain("Send it back — the Q3 number is wrong.");
    expect(getItem(recordDb.db, item.id)?.stepId).toBe("review");
  });
});

describe("a decision a person makes on a human step", () => {
  it("queues the move the route resolved, and the reason they gave with it", async () => {
    // `items:decide` names an *answer* and lets the pipeline resolve
    // where it goes (EO-310): the person presses "Send back", and the
    // route decides that means the implementer. Whatever it resolves to
    // is a move like any other, and the record has to hear about it as
    // one — along with the reason, which on a non-approving result is
    // required and is the whole point of sending it back.
    const item = createTestItem(recordDb.db, { type: "story", title: "Waiting on a person", stepId: "ready_to_merge" });
    await device.sync();

    const decided = await asThePerson("items:decide", {
      itemId: item.id,
      resultKey: "send_back",
      comment: "The Q3 number is wrong.",
    });

    expect(decided).toMatchObject({ decided: true, problem: null });
    // The reason first and the move after it, because that is the order
    // it happened in and the order an agent reads the thread.
    expect(pendingCommands(deviceDb.db).map((entry) => entry.kind)).toEqual(["comment", "transition"]);

    await device.sync();

    expect(getItem(recordDb.db, item.id)?.stepId).toBe(getItem(deviceDb.db, item.id)?.stepId);
    expect(getItem(recordDb.db, item.id)?.stepId).not.toBe("ready_to_merge");
    expect(listCommentsForItem(recordDb.db, item.id).map((comment) => comment.body)).toContain("The Q3 number is wrong.");
  });
});

describe("pinning a comment on a managed desktop", () => {
  it("is queued by the channel behind the pin, and reaches the record", async () => {
    const item = await anItemOnTheBoard();
    const said = await asThePerson("comments:post", { itemId: item.id, body: "This is the bit that matters." });
    await device.sync();

    // Days later, reading the thread back, somebody decides this is the
    // part that matters. `comments:setPinned` is the control.
    const pinned = await asThePerson("comments:setPinned", { commentId: said.commentId, pinned: true });

    expect(pinned).toMatchObject({ pinned: true, found: true });
    expect(pendingCommands(deviceDb.db).map((entry) => entry.kind)).toEqual(["pin"]);

    await device.sync();

    // On the record, because a pin is what survives context truncation
    // (ARCHITECTURE.md, "What an agent is given"): an agent dispatched on another machine reads a
    // long thread
    // with this kept and the rest cut.
    expect(getComment(recordDb.db, said.commentId as Uuid)?.pinned).toBe(true);
    expect(queuedCommandCount(deviceDb.db)).toBe(0);
  });

  it("queues taking the pin off again", async () => {
    const item = await anItemOnTheBoard();
    const said = await asThePerson("comments:post", { itemId: item.id, body: "Not so important after all." });
    await asThePerson("comments:setPinned", { commentId: said.commentId, pinned: true });
    await device.sync();

    await asThePerson("comments:setPinned", { commentId: said.commentId, pinned: false });
    await device.sync();

    expect(getComment(recordDb.db, said.commentId as Uuid)?.pinned).toBe(false);
  });
});

describe("a claim a person makes on a managed desktop", () => {
  it("is queued by the channel behind the Claim button, and the record holds it after sync", async () => {
    // A device the record can put a person to — the door resolves who
    // is claiming from it, and nothing in the payload says (EO-367).
    const anna = createPerson(recordDb.db, { name: "Anna", email: "anna@example.com" });
    const laptop = issueDevice(recordDb.db, { personId: anna.id, name: "anna-laptop", tokenHash: "hash-of-anna-laptop", secretsKeyHash: null });
    device.stop();
    device = createDeviceRecord({ db: deviceDb.db, deviceId: () => laptop.id, transport: () => transport });
    setSetting(deviceDb.db, MANAGED_PERSON_ID_KEY, anna.id);
    setSetting(deviceDb.db, MANAGED_PERSON_NAME_KEY, "Anna");
    const item = await anItemOnTheBoard();

    const claimed = await asThePerson("items:claim", { itemId: item.id });

    expect(claimed.assigneeId).toBe(anna.id);
    expect(pendingCommands(deviceDb.db).map((entry) => entry.kind)).toEqual(["claim"]);

    await device.sync();

    expect(getItem(recordDb.db, item.id)?.assigneeId).toBe(anna.id);
    expect(getItem(deviceDb.db, item.id)?.assigneeId).toBe(anna.id);
    expect(listCommentsForItem(recordDb.db, item.id).map((comment) => comment.body)).toContain("Claimed by Anna.");
    expect(getItem(recordDb.db, item.id)?.stepId).toBe("todo");
    expect(queuedCommandCount(deviceDb.db)).toBe(0);
  });
});

describe("an assignment a person makes on a managed desktop", () => {
  it("names a colleague picked off the organisation's list, and the record holds them after sync", async () => {
    // Anna's laptop, signed in, and Dana on the organisation's list —
    // and nowhere on this desktop. `people:list` is what the picker
    // reads, and reading it writes nothing here (EO-367, review).
    const anna = createPerson(recordDb.db, { name: "Anna", email: "anna@example.com" });
    const dana = createPerson(recordDb.db, { name: "Dana", email: "dana@example.com" });
    const laptop = issueDevice(recordDb.db, { personId: anna.id, name: "anna-laptop", tokenHash: "hash-of-anna-laptop", secretsKeyHash: null });
    device.stop();
    device = createDeviceRecord({ db: deviceDb.db, deviceId: () => laptop.id, transport: () => transport });
    setSetting(deviceDb.db, MANAGED_PERSON_ID_KEY, anna.id);
    setSetting(deviceDb.db, MANAGED_PERSON_NAME_KEY, "Anna");
    // The organisation, as the handlers reach it: `people:list` answered
    // from the record's own tables, the way the server answers it.
    const organisation: ManagedDirectory = {
      client: () => ({
        address: "https://eo.example",
        request: async <K extends IpcChannel>(channel: K): Promise<IpcResult<IpcResponse<K>>> =>
          channel === "people:list"
            ? { ok: true, data: (await listPeopleCommand(recordDb.db)) as IpcResponse<K> }
            : { ok: false, error: { message: `not asked of this test: ${channel}` } },
      }),
    };
    clearHandlerRegistry();
    registerAllHandlers(deviceDb.db, undefined, { platform, managed: organisation });
    const item = await anItemOnTheBoard();

    const picked = (await asThePerson("people:list", undefined)).people.find((person) => person.name === "Dana")!;
    expect(getPerson(deviceDb.db, picked.id as Uuid)).toBeUndefined();

    const assigned = await asThePerson("items:assign", { itemId: item.id, personId: picked.id });

    // Shown at once, under the record's own id, and drawn as queued.
    expect(assigned).toMatchObject({ assigneeId: dana.id, assigneeName: "Dana" });
    expect(getItem(deviceDb.db, item.id)?.assigneeId).toBe(dana.id);
    expect(pendingCommands(deviceDb.db).map((entry) => entry.kind)).toEqual(["assign"]);
    expect(itemsWithQueuedMoves(deviceDb.db)).toEqual([item.id]);

    await device.sync();

    expect(getItem(recordDb.db, item.id)?.assigneeId).toBe(dana.id);
    expect(getItem(deviceDb.db, item.id)?.assigneeId).toBe(dana.id);
    expect(listCommentsForItem(recordDb.db, item.id).map((comment) => comment.body)).toContain("Assigned to Dana by Anna.");
    expect(itemsWithQueuedMoves(deviceDb.db)).toEqual([]);
  });
});

describe("an assignment made offline, to a colleague listed while online", () => {
  it("names them on the card at once, and reaches the record on reconnect", async () => {
    // The order a person can actually do it in: open the picker while
    // the organisation answers, lose the network, then choose (EO-367,
    // review). The list the picker shows is the one it read.
    const anna = createPerson(recordDb.db, { name: "Anna", email: "anna@example.com" });
    const dana = createPerson(recordDb.db, { name: "Dana", email: "dana@example.com" });
    const laptop = issueDevice(recordDb.db, { personId: anna.id, name: "anna-laptop", tokenHash: "hash-of-anna-laptop", secretsKeyHash: null });
    device.stop();
    device = createDeviceRecord({ db: deviceDb.db, deviceId: () => laptop.id, transport: () => transport });
    setSetting(deviceDb.db, MANAGED_PERSON_ID_KEY, anna.id);
    setSetting(deviceDb.db, MANAGED_PERSON_NAME_KEY, "Anna");
    // The organisation, behind the same switch as the record: one
    // network, so when one cannot be reached neither can the other.
    const organisation: ManagedDirectory = {
      client: () => ({
        address: "https://eo.example",
        request: async <K extends IpcChannel>(channel: K): Promise<IpcResult<IpcResponse<K>>> => {
          if (!online) return { ok: false, error: { message: "EO could not reach https://eo.example: fetch failed" } };
          return channel === "people:list"
            ? { ok: true, data: (await listPeopleCommand(recordDb.db)) as IpcResponse<K> }
            : { ok: false, error: { message: `not asked of this test: ${channel}` } };
        },
      }),
    };
    clearHandlerRegistry();
    registerAllHandlers(deviceDb.db, undefined, { platform, managed: organisation });
    const item = await anItemOnTheBoard();

    const listed = await asThePerson("people:list", undefined);
    expect(listed.fromServer).toBe(true);
    const picked = listed.people.find((person) => person.name === "Dana")!;
    expect(getPerson(deviceDb.db, picked.id as Uuid)).toBeUndefined();

    online = false;
    const assigned = await asThePerson("items:assign", { itemId: item.id, personId: picked.id });

    // On the card now, under the record's id — not after the next sync.
    expect(assigned).toMatchObject({ assigneeId: dana.id, assigneeName: "Dana" });
    expect(getItem(deviceDb.db, item.id)?.assigneeId).toBe(dana.id);
    expect(getPerson(deviceDb.db, dana.id)?.name).toBe("Dana");
    expect(pendingCommands(deviceDb.db).map((entry) => entry.kind)).toEqual(["assign"]);
    expect(itemsWithQueuedMoves(deviceDb.db)).toEqual([item.id]);
    await device.sync();
    expect(getItem(recordDb.db, item.id)?.assigneeId).toBeNull();

    online = true;
    await device.sync();

    expect(getItem(recordDb.db, item.id)?.assigneeId).toBe(dana.id);
    expect(getItem(deviceDb.db, item.id)?.assigneeId).toBe(dana.id);
    expect(listCommentsForItem(recordDb.db, item.id).map((comment) => comment.body)).toContain("Assigned to Dana by Anna.");
    expect(itemsWithQueuedMoves(deviceDb.db)).toEqual([]);
  });
});

describe("a solo desktop reached through the same channels", () => {
  it("queues nothing at all", async () => {
    const solo = openMigratedTestDb();
    const record = createDeviceRecord({ db: solo.db, deviceId: () => "local", transport: () => null });
    clearHandlerRegistry();
    const soloPlatform = fakePlatform();
    directories.push(soloPlatform.userDataPath);
    registerAllHandlers(solo.db, undefined, { platform: soloPlatform });
    try {
      const item = createTestItem(solo.db, { type: "story", title: "Solo work", stepId: "todo" });

      await asThePerson("items:move", { itemId: item.id as Uuid, toStepId: "review" });
      await asThePerson("comments:post", { itemId: item.id as Uuid, body: "on my own" });

      expect(getItem(solo.db, item.id)?.stepId).toBe("review");
      // One code path, and on this one it does nothing: there is nobody
      // to send to, and rows against a record that does not exist could
      // only ever be deleted.
      expect(queuedCommandCount(solo.db)).toBe(0);
    } finally {
      record.stop();
      solo.close();
    }
  });

  it("takes a claim there and then, and queues nothing", async () => {
    const solo = openMigratedTestDb();
    const record = createDeviceRecord({ db: solo.db, deviceId: () => "local", transport: () => null });
    clearHandlerRegistry();
    const soloPlatform = fakePlatform();
    directories.push(soloPlatform.userDataPath);
    registerAllHandlers(solo.db, undefined, { platform: soloPlatform });
    try {
      const item = createTestItem(solo.db, { type: "story", title: "Solo work", stepId: "todo" });

      const claimed = await asThePerson("items:claim", { itemId: item.id as Uuid });

      expect(getItem(solo.db, item.id)?.assigneeId).toBe(claimed.assigneeId);
      expect(getComment(solo.db, claimed.commentId as Uuid)?.body).toBe("Claimed by you.");
      expect(queuedCommandCount(solo.db)).toBe(0);
    } finally {
      record.stop();
      solo.close();
    }
  });
});

/**
 * A push carries its reason as far as the policy sync (EO-328, review).
 *
 * The drain is cursored and does the same work either way, so the reason
 * exists for the one thing beside it that is rate-limited. A
 * `config:changed` arriving because an admin published must not be
 * counted as a poll and dropped inside the window — that left a freshly
 * disallowed backend dispatching for up to a minute, and the acceptance
 * criterion says a device bound to one *cannot* dispatch.
 *
 * `policy/sync.test.ts` holds what the rate limit then does with the
 * word; this holds that the word gets there at all, which is the wiring
 * the bug actually lived in.
 */
describe("why a device is syncing", () => {
  it("tells the policy sync that a push was a publish rather than a tick", async () => {
    const reasons: (string | undefined)[] = [];
    const pushed = createDeviceRecord({
      db: deviceDb.db,
      deviceId: () => "anna-laptop",
      transport: () => transport,
      policySync: (reason) => {
        reasons.push(reason);
        return Promise.resolve(null);
      },
    });

    // What the engine's tick does, and what `onChanged` does when the
    // record says something changed.
    await pushed.sync();
    await pushed.sync("published");

    expect(reasons).toEqual(["polling", "published"]);
    pushed.stop();
  });
});

describe("who may act on an item at a group's step, asked on a managed desktop (EO-368)", () => {
  it("asks the record whether the person is in the group, and reads who holds it off this machine's copy", async () => {
    const anna = createPerson(recordDb.db, { name: "Anna", email: "anna@example.com" });
    createPerson(recordDb.db, { name: "Dana", email: "dana@example.com" });
    const laptop = issueDevice(recordDb.db, { personId: anna.id, name: "anna-laptop", tokenHash: "hash-of-anna-laptop", secretsKeyHash: null });
    device.stop();
    device = createDeviceRecord({ db: deviceDb.db, deviceId: () => laptop.id, transport: () => transport });
    setSetting(deviceDb.db, MANAGED_PERSON_ID_KEY, anna.id);
    setSetting(deviceDb.db, MANAGED_PERSON_NAME_KEY, "Anna");
    const design = saveGroup(recordDb.db, { name: "Design", memberIds: [anna.id] });
    for (const db of [recordDb.db, deviceDb.db]) setStepOwner(db, "ready_to_merge", { personId: null, groupId: design.id });
    // The organisation's server, with its door: who is asking is stamped
    // from the device's credential, never sent.
    const organisation: ManagedDirectory = {
      client: () => ({
        address: "https://eo.example",
        request: async <K extends IpcChannel>(channel: K, payload: IpcPayload<K>): Promise<IpcResult<IpcResponse<K>>> => {
          if (!online) return { ok: false, error: { message: "EO could not reach https://eo.example: fetch failed" } };
          return channel === "items:authority"
            ? {
                ok: true,
                data: (await itemAuthorityCommand(recordDb.db, { ...(payload as IpcPayload<"items:authority">), actingDeviceId: laptop.id })) as IpcResponse<K>,
              }
            : { ok: false, error: { message: `not asked of this test: ${channel}` } };
        },
      }),
    };
    clearHandlerRegistry();
    registerAllHandlers(deviceDb.db, undefined, { platform, managed: organisation });
    const item = createTestItem(recordDb.db, { type: "story", title: "Launch post", stepId: "ready_to_merge" });
    await device.sync();

    expect((await asThePerson("items:authority", { itemId: item.id })).authority).toEqual({
      group: { id: design.id, name: "Design" },
      holder: null,
      you: "member",
    });

    // Claimed here and not yet synced: this machine already shows Anna
    // holding it, so the screen offers her the decision rather than
    // Claim a second time.
    await asThePerson("items:claim", { itemId: item.id });
    expect((await asThePerson("items:authority", { itemId: item.id })).authority).toMatchObject({ holder: { id: anna.id }, you: "holder" });

    // Offline, this machine's copy answers alone.
    online = false;
    expect((await asThePerson("items:authority", { itemId: item.id })).authority).toMatchObject({ you: "holder" });
    online = true;

    // Out of the group on the record, and the record's word is the one taken.
    saveGroup(recordDb.db, { id: design.id, name: "Design", memberIds: [] });
    expect((await asThePerson("items:authority", { itemId: item.id })).authority?.you).toBe("outsider");
  });
});
