import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type IpcChannel, type IpcPayload, type IpcResponse, type IpcResult, type Item, type StepWatch, type Uuid } from "@eo/core";
import { dispatchBlocker } from "@eo/engine";
import type { DbHandle } from "../db/client.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { createRoute, createStep, getItemWatch, listCommentsForItem, listRunEvents, listRunsForItem } from "../db/repos/index.js";
import { createPerson } from "../db/repos/peopleRepo.js";
import { runEventDevices } from "../db/repos/runEventsRepo.js";
import { issueDevice } from "../db/repos/devicesRepo.js";
import { buildEligibilityInput, buildTickInput } from "../supervisor/buildTickInput.js";
import { createRunSupervisor, type RunSupervisor } from "../supervisor/runSupervisor.js";
import type { BuiltinOutcome, BuiltinRunner } from "../supervisor/builtins.js";
import { createLocalRecord, type LocalItemRecord } from "./localRecord.js";
import { createDeviceRecord, type DeviceRecord } from "./deviceRecord.js";
import { serveApply, serveChanges, serveRelease, serveRenew, serveWork, type ServeRecordContext } from "./serveRecord.js";
import type { RecordTransport } from "./syncStatus.js";

/**
 * Keep checking across two desktops and one record (EO-456,
 * `ARCHITECTURE.md`, "A step", "The record").
 *
 * A watch is shared state. The record's scheduler holds the item from its
 * own copy of the watch row, and whichever device it leases the item to
 * next carries the same watch on — its clock, its failure streak, the
 * news it has already posted — rather than starting one of its own.
 *
 * Three databases in one process and the record contract between them,
 * through the same `serve*` functions `server/http.ts` puts behind its
 * door (as `sync.test.ts` does), with a supervisor on each desktop and one
 * fake clock for all three machines.
 */

const LIMITS = { globalConcurrency: 1, perAgentConcurrency: 1, perRepositoryConcurrency: 1 };
const MINUTE = 60_000;
const START = 1_800_000_000_000;
const WATCH: StepWatch = { everyMinutes: 5, giveUpAfterHours: 168 };

let clock: number;
let recordDb: DbHandle;
let theRecord: LocalItemRecord;
let serving: ServeRecordContext;
let anna: Desktop;
let dana: Desktop;
let item: Item;
/** A device whose transcripts the record turns down, as a batch it could not take. */
let refusingEventsFrom: string | null = null;
/** A device the record cannot hear from, for what it sends rather than what it is told. */
let silenced: string | null = null;
/** How far each machine's clock is from the record's. */
const skews = new Map<string, number>();
/** The runs each machine was told gained lines from a pull. */
const pulledLines = new Map<string, string[]>();

interface Desktop {
  handle: DbHandle;
  record: DeviceRecord;
  deviceId: string;
  /** What this machine's check answers, in order. */
  answers: BuiltinOutcome[];
  check: ReturnType<typeof vi.fn<BuiltinRunner>>;
  supervisor: RunSupervisor;
}

/** The step that keeps checking, the step it sends work to, and its routes — on every machine, by the same ids. */
function seedSteps(handle: DbHandle): void {
  createStep(handle.db, { id: "watch", pipelineId: "default" as Uuid, position: 15, name: "Wait for it", type: "builtin", entryAction: "create_worktree", watch: WATCH });
  createStep(handle.db, { id: "fix", pipelineId: "default" as Uuid, position: 16, name: "Fix it", type: "user" });
  createRoute(handle.db, { pipelineId: "default" as Uuid, fromStepId: "watch", resultKey: "arrived", label: "Arrived", target: "terminal", position: 0 });
  createRoute(handle.db, { pipelineId: "default" as Uuid, fromStepId: "watch", resultKey: "broke", label: "Broke", target: "fix", position: 1 });
}

function deviceFor(name: string, machine: string): string {
  const person = createPerson(recordDb.db, { name, email: `${name.toLowerCase()}@example.com` });
  return issueDevice(recordDb.db, { personId: person.id, name: machine, tokenHash: `hash-of-${machine}`, secretsKeyHash: null }).id;
}

/** The record contract, straight into the record's database. */
function transport(): RecordTransport {
  return {
    async request<K extends IpcChannel>(channel: K, payload: IpcPayload<K>): Promise<IpcResult<IpcResponse<K>>> {
      const answer = await (async (): Promise<unknown> => {
        switch (channel) {
          case "record:work":
            return serveWork(serving, payload as IpcPayload<"record:work">);
          case "record:renew":
            return serveRenew(serving, payload as IpcPayload<"record:renew">);
          case "record:release":
            return serveRelease(serving, payload as IpcPayload<"record:release">);
          case "record:apply": {
            const apply = payload as IpcPayload<"record:apply">;
            if (apply.deviceId === silenced) return null;
            if (apply.deviceId === refusingEventsFrom && apply.commands.some((command) => command.kind === "runEvents")) {
              return { results: apply.commands.map((command) => ({ id: command.id, applied: false, superseded: null, problem: "Not now.", heldBy: null, holder: null, notPermitted: null })) };
            }
            return serveApply(serving, apply);
          }
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

function desktop(name: string, machine: string): Desktop {
  const handle = openMigratedTestDb();
  seedSteps(handle);
  const deviceId = deviceFor(name, machine);
  const record = createDeviceRecord({
    db: handle.db,
    deviceId: () => deviceId,
    transport: () => transport(),
    pullPageSize: 500,
    onRunEvents: (runId) => pulledLines.set(machine, [...(pulledLines.get(machine) ?? []), runId]),
  });
  const answers: BuiltinOutcome[] = [];
  const check = vi.fn<BuiltinRunner>(async () => answers.shift() ?? { ok: true, result: "waiting", detail: "" });
  const supervisor = createRunSupervisor({
    db: handle.db,
    provider: { start: () => { throw new Error("a check must not reach a provider"); } } as never,
    limits: LIMITS,
    now: () => clock + (skews.get(machine) ?? 0),
    record,
    deviceId,
    builtins: { create_worktree: check },
    guards: { interpretReplies: false },
  });
  return { handle, record, deviceId, answers, check, supervisor };
}

const waiting = (news: { id: string; text: string }[] = []): BuiltinOutcome => ({ ok: true, result: "waiting", detail: "", news });

const saying = (detail: string): BuiltinOutcome => ({ ok: true, result: "waiting", detail });

/** The lines of the item's runs on one machine, in the transcript's order. */
const linesOn = (db: DbHandle["db"]): string[] =>
  listRunsForItem(db, item.id).flatMap((run) => listRunEvents(db, run.id).map((event) => (event.payload as { text: string }).text));

/** What the record's own scheduler says about the item, from the record's own tables. */
function recordBlocker() {
  return dispatchBlocker(buildEligibilityInput(recordDb.db, false, {}, clock), item.id);
}

beforeEach(() => {
  clock = START;
  refusingEventsFrom = null;
  silenced = null;
  skews.clear();
  pulledLines.clear();
  recordDb = openMigratedTestDb();
  seedSteps(recordDb);
  theRecord = createLocalRecord(recordDb.db, { now: () => clock });
  serving = {
    db: recordDb.db,
    record: theRecord,
    // The record's own scheduler, from the record's own tables and on the
    // shared clock — which is what makes its watch rows the ones that hold.
    offerWork: (deviceId, capacity) => theRecord.offerWork({ deviceId, capacity, tickInput: buildTickInput(recordDb.db, LIMITS, false, {}, clock) }),
  };
  anna = desktop("Anna", "anna-laptop");
  dana = desktop("Dana", "dana-desktop");
  item = createTestItem(recordDb.db, { type: "story", title: "Wait for the signature", stepId: "watch" });
});

afterEach(() => {
  anna.record.stop();
  dana.record.stop();
  anna.handle.close();
  dana.handle.close();
  recordDb.close();
});

describe("a watch on an organisation's record", () => {
  it("reaches the record before the lease is given back, so the record holds the item and says until when", async () => {
    await anna.supervisor.runOnce();

    expect(anna.check).toHaveBeenCalledTimes(1);
    expect(getItemWatch(recordDb.db, item.id, "watch")).toMatchObject({ checks: 1, startedAt: START, nextCheckAt: START + 5 * MINUTE });
    // Ahead of the quiet run, which follows on Anna's next sync: the next
    // device can have the watch without having the run.
    expect(listRunsForItem(recordDb.db, item.id)).toEqual([]);
    expect(recordBlocker()).toEqual({ kind: "watching", nextCheckAt: START + 5 * MINUTE, giveUpAt: START + 168 * 60 * MINUTE });

    // The other desktop asks straight away, and is offered nothing.
    await dana.supervisor.runOnce();
    expect(dana.check).not.toHaveBeenCalled();
    // …but has the watch, and says the same thing about it.
    expect(dana.supervisor.dispatchBlockerFor(item.id)).toMatchObject({ kind: "watching", nextCheckAt: START + 5 * MINUTE });
  });

  it("is carried on by the next device leased the item: the same clock, and news posted once across both", async () => {
    anna.answers.push(
      waiting([
        { id: "job-1", text: "Lint failed" },
        { id: "comment-7", text: "Please rename this" },
      ]),
    );
    dana.answers.push(
      waiting([
        { id: "comment-7", text: "Please rename this" },
        { id: "job-2", text: "Tests failed" },
      ]),
    );

    await anna.supervisor.runOnce();
    await dana.supervisor.runOnce();
    clock += 5 * MINUTE;
    // Anna is away; Dana's machine is the one asking.
    await dana.supervisor.runOnce();

    expect(dana.check).toHaveBeenCalledTimes(1);
    expect(getItemWatch(recordDb.db, item.id, "watch")).toMatchObject({
      startedAt: START,
      checks: 2,
      postedNewsIds: ["job-1", "comment-7", "job-2"],
      nextCheckAt: START + 10 * MINUTE,
    });
    await dana.record.sync();
    const news = listCommentsForItem(recordDb.db, item.id).map((comment) => comment.body);
    expect(news).toHaveLength(2);
    expect(news[1]).toContain("> Tests failed");
    expect(news[1]).not.toContain("Please rename this");
  });

  it("keeps the failure streak and the retry's wait when the next failure happens on another device", async () => {
    anna.answers.push({ ok: false, reason: "the service answered 503" });
    dana.answers.push({ ok: false, reason: "the service answered 503 again" });

    await anna.supervisor.runOnce();
    expect(getItemWatch(recordDb.db, item.id, "watch")).toMatchObject({ consecutiveFailures: 1, nextCheckAt: START + MINUTE });

    // Inside the minute's backoff: nothing offered to anybody.
    clock = START + 30_000;
    await dana.supervisor.runOnce();
    expect(dana.check).not.toHaveBeenCalled();

    clock = START + MINUTE;
    await dana.supervisor.runOnce();

    expect(dana.check).toHaveBeenCalledTimes(1);
    // The second failure in a row, not a first — so the wait is two minutes.
    expect(getItemWatch(recordDb.db, item.id, "watch")).toMatchObject({
      consecutiveFailures: 2,
      lastError: "the service answered 503 again",
      nextCheckAt: START + 3 * MINUTE,
    });
  });

  it("does not let a stale report from a machine that went quiet wind the watch back", async () => {
    await anna.supervisor.runOnce();
    clock += 5 * MINUTE;
    await dana.supervisor.runOnce();
    expect(getItemWatch(recordDb.db, item.id, "watch")?.checks).toBe(2);

    // Anna's first report arriving late, after Dana carried the watch on.
    const late = await serveApply(serving, {
      deviceId: anna.deviceId,
      commands: [
        {
          kind: "watch",
          id: "late-report",
          itemId: item.id,
          stepId: "watch",
          initiationId: getItemWatch(recordDb.db, item.id, "watch")!.initiationId,
          startedAt: START,
          lastCheckedAt: START,
          nextCheckAt: START + 5 * MINUTE,
          checks: 1,
          consecutiveFailures: 0,
          lastError: null,
          postedNewsIds: [],
          updatedAt: 0,
        },
      ],
    });

    expect(late.results[0]?.applied).toBe(true);
    expect(getItemWatch(recordDb.db, item.id, "watch")).toMatchObject({ checks: 2, nextCheckAt: START + 10 * MINUTE });
  });

  it("leaves out a late report about an earlier stay, even one showing more checks than the current watch", async () => {
    // Stay 1: Anna checks, and the record holds where that watch got to.
    await anna.supervisor.runOnce();
    const firstStay = getItemWatch(recordDb.db, item.id, "watch")!;

    // Anna's next report about stay 1 — queued on her machine, which then
    // went quiet. Further on than anything the record has seen, and
    // carrying a failure streak and news of its own.
    const lateFromAnna = {
      kind: "watch" as const,
      id: "late-from-an-earlier-stay",
      itemId: item.id,
      stepId: "watch",
      initiationId: firstStay.initiationId,
      startedAt: firstStay.startedAt,
      lastCheckedAt: START + 5 * MINUTE,
      nextCheckAt: START + 99 * MINUTE,
      checks: 7,
      consecutiveFailures: 4,
      lastError: "the service answered 503",
      postedNewsIds: ["old-news"],
      updatedAt: 0,
    };

    // Meanwhile Dana's check sends the item to be fixed, and a person
    // puts it back: stay 2 begins, and Dana's machine checks it.
    dana.answers.push({ ok: true, result: "broke", detail: "" }, waiting([{ id: "new-news", text: "Signed by one of two" }]));
    clock += 5 * MINUTE;
    await dana.supervisor.runOnce();
    theRecord.applyTransition({ itemId: item.id, toStepId: "watch", actor: "human", reason: "fixed" });
    await dana.supervisor.runOnce();

    const secondStay = getItemWatch(recordDb.db, item.id, "watch")!;
    expect(secondStay.initiationId).not.toBe(firstStay.initiationId);
    expect(secondStay).toMatchObject({ startedAt: clock, checks: 1, consecutiveFailures: 0, postedNewsIds: ["new-news"], nextCheckAt: clock + 5 * MINUTE });

    // And now Anna's report arrives.
    const answered = await serveApply(serving, { deviceId: anna.deviceId, commands: [lateFromAnna] });

    expect(answered.results[0]?.applied).toBe(true);
    expect(getItemWatch(recordDb.db, item.id, "watch")).toMatchObject({
      initiationId: secondStay.initiationId,
      startedAt: secondStay.startedAt,
      checks: 1,
      consecutiveFailures: 0,
      postedNewsIds: ["new-news"],
      nextCheckAt: clock + 5 * MINUTE,
    });
    // The record goes on holding the item on the current watch's clock.
    expect(recordBlocker()).toMatchObject({ kind: "watching", nextCheckAt: clock + 5 * MINUTE });
    clock += MINUTE;
    await dana.supervisor.runOnce();
    expect(dana.check).toHaveBeenCalledTimes(2);
  });
});

describe("a quiet run carried across two devices (EO-618)", () => {
  it("keeps every line when the next device holds only part of the transcript", async () => {
    anna.answers.push(saying("one"), saying("two"), saying("three"));
    dana.answers.push(saying("four"));

    await anna.supervisor.runOnce();
    await anna.record.sync();
    await dana.record.sync();
    clock += 5 * MINUTE;
    await anna.supervisor.runOnce();
    clock += 5 * MINUTE;
    await anna.supervisor.runOnce();

    // Dana is leased the item holding the run and less than all of it.
    clock += 5 * MINUTE;
    await dana.supervisor.runOnce();
    expect(dana.check).toHaveBeenCalledTimes(1);
    expect(linesOn(dana.handle.db)).toContain("four");
    expect(linesOn(dana.handle.db)).not.toContain("three");

    await anna.record.sync();
    await dana.record.sync();

    const [run, ...others] = listRunsForItem(recordDb.db, item.id);
    expect(others).toEqual([]);
    expect(run).toMatchObject({ status: "succeeded", startedAt: null });
    expect(linesOn(recordDb.db)).toEqual(["one", "two", "three", "four"]);

    // A third machine reading both devices' lines in one page keeps who
    // wrote which, because a run with two writers is two groups on the wire.
    const ben = desktop("Ben", "ben-box");
    await ben.record.sync();
    expect(linesOn(ben.handle.db)).toEqual(["one", "two", "three", "four"]);
    expect(runEventDevices(ben.handle.db, run!.id)).toEqual(new Set([anna.deviceId, dana.deviceId]));
    ben.record.stop();
    ben.handle.close();
  });

  it("keeps every line when the next device's clock is behind by the interval between checks", async () => {
    anna.answers.push(saying("one"), saying("two"));
    dana.answers.push(saying("three"));

    await anna.supervisor.runOnce();
    await anna.record.sync();
    await dana.record.sync();

    // Anna's second check, which reaches the record neither as a watch nor
    // as a transcript: the next device goes on from the first.
    silenced = anna.deviceId;
    clock += 5 * MINUTE;
    await anna.supervisor.runOnce();
    expect(getItemWatch(recordDb.db, item.id, "watch")?.checks).toBe(1);

    // Five minutes on, Dana's clock reads what Anna's did at "two": two
    // checks, one moment by the clocks that ran them.
    skews.set("dana-desktop", -5 * MINUTE);
    clock += 5 * MINUTE;
    await dana.supervisor.runOnce();
    expect(dana.check).toHaveBeenCalledTimes(1);
    const whenWritten = (db: DbHandle["db"], line: string) =>
      listRunsForItem(db, item.id)
        .flatMap((run) => listRunEvents(db, run.id))
        .filter((event) => (event.payload as { text: string }).text === line)
        .map((event) => event.ts);
    expect(whenWritten(dana.handle.db, "three")).toEqual(whenWritten(anna.handle.db, "two"));
    expect(linesOn(dana.handle.db)).not.toContain("two");

    silenced = null;
    await anna.record.sync();
    await dana.record.sync();
    await anna.record.sync();

    expect(listRunsForItem(recordDb.db, item.id)).toHaveLength(1);
    expect(linesOn(recordDb.db)).toEqual(["one", "two", "three"]);
    expect(linesOn(dana.handle.db)).toEqual(["one", "two", "three"]);
    expect(linesOn(anna.handle.db)).toEqual(["one", "two", "three"]);
  });

  it("reads in the order the checks ran, on the record's clock, however far apart the devices' are", async () => {
    anna.answers.push(saying("one"));
    dana.answers.push(saying("two"));
    skews.set("anna-laptop", 60 * MINUTE);

    await anna.supervisor.runOnce();
    await anna.record.sync();
    clock += 65 * MINUTE;
    await dana.supervisor.runOnce();
    await dana.record.sync();

    expect(linesOn(recordDb.db)).toEqual(["one", "two"]);
  });

  it("delivers every line to both replicas when the later one syncs first", async () => {
    anna.answers.push(saying("one"), saying("two"));
    dana.answers.push(saying("three"));

    await anna.supervisor.runOnce();
    await anna.record.sync();
    await dana.record.sync();
    clock += 5 * MINUTE;
    await anna.supervisor.runOnce();
    clock += 5 * MINUTE;
    await dana.supervisor.runOnce();

    // Dana sends "three" and reads past it before Anna has sent "two".
    await dana.record.sync();
    await anna.record.sync();
    expect(linesOn(dana.handle.db)).toEqual(["one", "three"]);

    pulledLines.clear();
    await dana.record.sync();
    await anna.record.sync();

    expect(linesOn(recordDb.db)).toEqual(["one", "two", "three"]);
    expect(linesOn(dana.handle.db)).toEqual(["one", "two", "three"]);
    expect(linesOn(anna.handle.db)).toEqual(["one", "two", "three"]);
    // And Dana's open transcript is told, which is what sends it to look.
    expect(pulledLines.get("dana-desktop")).toEqual(listRunsForItem(dana.handle.db, item.id).map((run) => run.id));
  });

  it("makes one run when the next device has not heard of it", async () => {
    anna.answers.push(saying("one"));
    dana.answers.push(saying("two"));

    await anna.supervisor.runOnce();
    clock += 5 * MINUTE;
    await dana.supervisor.runOnce();
    expect(listRunsForItem(dana.handle.db, item.id).map((run) => run.id)).toEqual(listRunsForItem(anna.handle.db, item.id).map((run) => run.id));

    await anna.record.sync();
    await dana.record.sync();

    expect(listRunsForItem(recordDb.db, item.id)).toHaveLength(1);
    expect(linesOn(recordDb.db)).toEqual(["one", "two"]);
  });

  it("makes a new run on each device alike when the item comes back to the step", async () => {
    await anna.supervisor.runOnce();
    await anna.record.sync();
    theRecord.applyTransition({ itemId: item.id, toStepId: "fix", actor: "human", reason: "sent back" });
    theRecord.applyTransition({ itemId: item.id, toStepId: "watch", actor: "human", reason: "fixed" });
    clock += MINUTE;
    await dana.supervisor.runOnce();
    await dana.record.sync();

    expect(listRunsForItem(recordDb.db, item.id)).toHaveLength(2);
    expect(linesOn(recordDb.db)).toEqual(["Still waiting.", "Still waiting."]);
  });

  it("still sends a device's own line when a pull would carry the bookmark past it", async () => {
    anna.answers.push(saying("one"), saying("two"));
    dana.answers.push(saying("three"));

    await anna.supervisor.runOnce();
    await anna.record.sync();
    await dana.record.sync();
    clock += 5 * MINUTE;
    await anna.supervisor.runOnce();
    clock += 5 * MINUTE;
    await dana.supervisor.runOnce();

    // Dana cannot send "three", and her pull brings "two" all the same.
    await anna.record.sync();
    refusingEventsFrom = dana.deviceId;
    await dana.record.sync();
    expect(linesOn(recordDb.db)).toEqual(["one", "two"]);

    refusingEventsFrom = null;
    await dana.record.sync();
    expect(linesOn(recordDb.db)).toEqual(["one", "two", "three"]);
  });
});
