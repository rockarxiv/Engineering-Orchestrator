import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StepTeamSchema, type IpcChannel, type IpcPayload, type IpcResponse, type IpcResult, type Item, type RecordTeamSessionCommand, type StepTeam, type Uuid } from "@eo/core";
import type { Db, DbHandle } from "../db/client.js";
import { agents } from "../db/schema.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { createProject, markProjectOnTheRecord } from "../db/repos/projectsRepo.js";
import { createPerson } from "../db/repos/peopleRepo.js";
import { issueDevice } from "../db/repos/devicesRepo.js";
import { grantLease, leaseFor, releaseLease } from "../db/repos/leasesRepo.js";
import { createRun } from "../db/repos/runsRepo.js";
import { appendRunEvent, listRunEvents } from "../db/repos/runEventsRepo.js";
import { getComment, listCommentsForItem, postComment } from "../db/repos/commentsRepo.js";
import { pendingCommands } from "../db/repos/recordCommandsRepo.js";
import {
  acceptTeamReport,
  endTeamAttempt,
  endTeamSession,
  getTeamSessionRecord,
  openTeamSession,
  startTeamAttempt,
  teamSessionCommand,
} from "../db/repos/teamSessionsRepo.js";
import { buildTickInput } from "../supervisor/buildTickInput.js";
import { createLocalRecord, type LocalItemRecord } from "./localRecord.js";
import { createDeviceRecord, type DeviceRecord } from "./deviceRecord.js";
import { serveApply, serveChanges, serveRelease, serveRenew, serveWork, type ServeRecordContext } from "./serveRecord.js";
import type { RecordTransport } from "./syncStatus.js";

/**
 * Team sessions between machines (EO-844): a desktop runs one on an item
 * its organisation's record holds, the record takes it only from the
 * device whose current session it is, and another desktop reads it back
 * whole — the session, every attempt, the evidence each was given, which
 * comment carries each report and who wrote it, and every attempt's
 * transcript in order. Two databases and a record, through the same
 * `serve*` functions the server puts behind its door, as `sync.test.ts`
 * does.
 */

const LIMITS = { globalConcurrency: 1, perAgentConcurrency: 1, perRepositoryConcurrency: 1 };
const AGENT_ID = "01a1eee0-0000-7000-8000-00000000a6e1" as Uuid;

const TEAM: StepTeam = StepTeamSchema.parse({
  coordination: "independent",
  participants: [
    { key: "security", role: "reviewer", instructions: "Look for ways in." },
    { key: "clarity", role: "reviewer", instructions: "Read it as a newcomer.", required: false },
  ],
  outcomes: [
    { key: "clear", label: "Nothing found" },
    { key: "blocking", label: "Blocking issue" },
  ],
  completion: { rules: [{ when: "any", outcomes: ["blocking"], result: "rejected" }], fallback: "approved" },
});

let recordDb: DbHandle;
let annaDb: DbHandle;
let danaDb: DbHandle;
let serving: ServeRecordContext;
let theRecord: LocalItemRecord;
let anna: DeviceRecord;
let dana: DeviceRecord;
let annaDevice: string;
let danaDevice: string;
let item: Item;

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
          case "record:apply":
            return serveApply(serving, payload as IpcPayload<"record:apply">);
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

function deviceFor(name: string, machine: string): string {
  const person = createPerson(recordDb.db, { name, email: `${name.toLowerCase()}@example.com` });
  return issueDevice(recordDb.db, { personId: person.id, name: machine, tokenHash: `hash-of-${machine}`, secretsKeyHash: null }).id;
}

/** The same reviewer on every machine, as a project's agents are once they have travelled. */
function reviewerOn(db: Db): void {
  db.insert(agents).values({ id: AGENT_ID, name: "Rita", role: "reviewer", provider: "fake", instructions: "Review." }).run();
}

function leaseTo(deviceId: string): void {
  const held = leaseFor(recordDb.db, item.id);
  if (held !== null) releaseLease(recordDb.db, item.id, held.deviceId);
  grantLease(recordDb.db, { itemId: item.id, deviceId, now: Date.now(), ttlMs: 10 * 60_000 });
}

/** A participant's attempt with a run behind it, on a device. */
function attemptOn(db: Db, sessionId: string, key: string, supersedes?: string) {
  const run = createRun(db, { itemId: item.id, agentId: AGENT_ID, action: "review", stepId: "todo", status: "running" });
  const started = startTeamAttempt(db, {
    sessionId,
    assignmentKey: key,
    role: "reviewer",
    agentId: AGENT_ID,
    instructions: `Attempt at ${key}.`,
    runId: run.id,
    evidenceBaseline: { kind: "git-worktree", ref: `tree-of-${key}` },
    ...(supersedes === undefined ? {} : { supersedes }),
  });
  if (!started.ok) throw new Error(started.problem);
  return { attempt: started.attempt, run };
}

/** A whole session as the record serves it, without what only the record stamps. */
function withoutStamps(record: ReturnType<typeof getTeamSessionRecord>) {
  if (record === undefined) return undefined;
  return {
    session: { ...record.session, updatedAt: 0, deviceId: null },
    attempts: record.attempts.map((attempt) => ({ ...attempt, updatedAt: 0 })),
  };
}

beforeEach(async () => {
  recordDb = openMigratedTestDb();
  annaDb = openMigratedTestDb();
  danaDb = openMigratedTestDb();
  theRecord = createLocalRecord(recordDb.db);
  serving = {
    db: recordDb.db,
    record: theRecord,
    offerWork: (deviceId, capacity) => theRecord.offerWork({ deviceId, capacity, tickInput: buildTickInput(recordDb.db, LIMITS, false) }),
  };
  annaDevice = deviceFor("Anna", "anna-laptop");
  danaDevice = deviceFor("Dana", "dana-desktop");
  const owner = createPerson(recordDb.db, { name: "Owner", email: "owner@example.com" });
  const project = createProject(recordDb.db, { name: "Support", keyPrefix: "SUP" });
  markProjectOnTheRecord(recordDb.db, project.id, owner.id as Uuid);
  for (const db of [recordDb.db, annaDb.db, danaDb.db]) reviewerOn(db);
  item = createTestItem(recordDb.db, { type: "story", title: "Review the change", stepId: "todo", projectId: project.id });
  anna = createDeviceRecord({ db: annaDb.db, deviceId: () => annaDevice, transport: () => transport(), pullPageSize: 500 });
  dana = createDeviceRecord({ db: danaDb.db, deviceId: () => danaDevice, transport: () => transport(), pullPageSize: 500 });
  await anna.sync();
  await dana.sync();
  leaseTo(annaDevice);
});

afterEach(() => {
  anna.stop();
  dana.stop();
  recordDb.close();
  annaDb.close();
  danaDb.close();
});

describe("a team session on an item the organisation's record holds", () => {
  it("reaches another desktop whole: identity, attempts, evidence, attributed reports and transcripts in order", async () => {
    const parent = createRun(annaDb.db, { itemId: item.id, agentId: null, action: "review", stepId: "todo", status: "running" });
    const session = openTeamSession(annaDb.db, { itemId: item.id, stepId: "todo", team: TEAM, runId: parent.id });
    const failed = attemptOn(annaDb.db, session.id, "security");
    endTeamAttempt(annaDb.db, failed.attempt.id, { status: "failed", error: "The run timed out." });
    const retry = attemptOn(annaDb.db, session.id, "security", failed.attempt.id);
    for (const line of ["reading", "found it", "writing"]) appendRunEvent(annaDb.db, retry.run.id, "output", { text: line });
    const report = acceptTeamReport(annaDb.db, { attemptId: retry.attempt.id, outcome: "blocking", report: "The token is logged in clear." });
    const clarity = attemptOn(annaDb.db, session.id, "clarity");
    acceptTeamReport(annaDb.db, { attemptId: clarity.attempt.id, outcome: "clear", report: "Reads well." });
    expect(endTeamSession(annaDb.db, { sessionId: session.id, status: "finalized", result: "rejected" }).ok).toBe(true);

    await anna.sync();
    expect(pendingCommands(annaDb.db)).toEqual([]);
    const onRecord = getTeamSessionRecord(recordDb.db, session.id)!;
    expect(onRecord.session.deviceId).toBe(annaDevice);
    expect(withoutStamps(onRecord)).toEqual(withoutStamps(getTeamSessionRecord(annaDb.db, session.id)));

    await dana.sync();
    const there = getTeamSessionRecord(danaDb.db, session.id)!;
    expect(withoutStamps(there)).toEqual(withoutStamps(getTeamSessionRecord(annaDb.db, session.id)));
    expect(there.session.deviceId).toBe(annaDevice);
    expect(there.attempts.map((one) => [one.assignmentKey, one.attempt, one.status, one.supersededBy, one.evidenceBaseline?.ref])).toEqual([
      ["security", 1, "failed", retry.attempt.id, "tree-of-security"],
      ["security", 2, "completed", null, "tree-of-security"],
      ["clarity", 1, "completed", null, "tree-of-clarity"],
    ]);
    // The report is there, attributed to the agent and the attempt's run.
    const reportThere = getComment(danaDb.db, (report.ok ? report.comment.id : "") as Uuid)!;
    expect(reportThere).toMatchObject({ authorType: "agent", authorId: AGENT_ID, runId: retry.run.id });
    expect(reportThere.body).toContain("The token is logged in clear.");
    // …and the attempt's transcript, in the order it was written.
    expect(listRunEvents(danaDb.db, retry.run.id).map((event) => [event.seq, (event.payload as { text: string }).text])).toEqual([
      [0, "reading"],
      [1, "found it"],
      [2, "writing"],
    ]);
  });

  it("replayed takes nothing twice: one session, one accepted report per attempt, one comment", async () => {
    const session = openTeamSession(annaDb.db, { itemId: item.id, stepId: "todo", team: TEAM });
    const { attempt } = attemptOn(annaDb.db, session.id, "security");
    acceptTeamReport(annaDb.db, { attemptId: attempt.id, outcome: "clear", report: "Nothing to see." });
    endTeamAttempt(annaDb.db, attemptOn(annaDb.db, session.id, "clarity").attempt.id, { status: "failed", error: "Crashed." });
    endTeamSession(annaDb.db, { sessionId: session.id, status: "finalized", result: "approved" });
    const queued = pendingCommands(annaDb.db).map((entry) => entry.command);

    await anna.sync();
    const comments = listCommentsForItem(recordDb.db, item.id).length;
    const again = await serveApply(serving, { deviceId: annaDevice, commands: queued });

    // Every older copy of the session adds nothing to what the record holds, so it is acknowledged and writes nothing.
    expect(again.results.every((result) => result.applied)).toBe(true);
    expect(listCommentsForItem(recordDb.db, item.id)).toHaveLength(comments);
    const held = getTeamSessionRecord(recordDb.db, session.id)!;
    expect(held.session).toMatchObject({ status: "finalized", result: "approved" });
    expect(held.attempts.filter((one) => one.reportCommentId !== null)).toHaveLength(1);
  });

  it("from a device that no longer holds the item is refused, and accepts nothing", async () => {
    const session = openTeamSession(annaDb.db, { itemId: item.id, stepId: "todo", team: TEAM });
    const { attempt } = attemptOn(annaDb.db, session.id, "security");
    await anna.sync();
    leaseTo(danaDevice);

    acceptTeamReport(annaDb.db, { attemptId: attempt.id, outcome: "clear", report: "Late." });
    const accepted = teamSessionCommand(annaDb.db, session.id)!;
    const answer = await serveApply(serving, { deviceId: annaDevice, commands: [accepted] });
    expect(answer.results[0]).toMatchObject({ applied: false, problem: "Another device holds this item now, so a team session reported from here is stale." });

    endTeamSession(annaDb.db, { sessionId: session.id, status: "finalized", result: "approved" });
    const finalised = await serveApply(serving, { deviceId: annaDevice, commands: [teamSessionCommand(annaDb.db, session.id)!] });
    expect(finalised.results[0]?.applied).toBe(false);

    const held = getTeamSessionRecord(recordDb.db, session.id)!;
    expect(held.session.status).toBe("open");
    expect(held.attempts[0]?.reportCommentId).toBeNull();
    // Nor may the device now holding it report the first one's session as its own.
    const asDana = await serveApply(serving, { deviceId: danaDevice, commands: [teamSessionCommand(annaDb.db, session.id)!] });
    expect(asDana.results[0]).toMatchObject({ applied: false, problem: "That team session belongs to another device, so this one cannot report it." });
  });

  it("superseded cannot accept a contribution or finalise, while its successor is current", async () => {
    const old = openTeamSession(annaDb.db, { itemId: item.id, stepId: "todo", team: TEAM });
    const { attempt } = attemptOn(annaDb.db, old.id, "security");
    await anna.sync();
    const fresh = openTeamSession(annaDb.db, { itemId: item.id, stepId: "todo", team: TEAM });
    await anna.sync();
    expect(getTeamSessionRecord(recordDb.db, old.id)!.session).toMatchObject({ status: "superseded", supersededBy: fresh.id });

    // A late copy of the old session, as a device that missed the supersession would send it: still open, a report accepted, and then finalised.
    const report = postComment(recordDb.db, { itemId: item.id, author: { type: "agent", agentId: AGENT_ID }, body: "Late." });
    const copy = teamSessionCommand(annaDb.db, old.id)!;
    const accepting: RecordTeamSessionCommand = {
      ...copy,
      session: { ...copy.session, status: "open", supersededBy: null, endedAt: null },
      attempts: copy.attempts.map((one) => (one.id === attempt.id ? { ...one, status: "completed", outcome: "clear", reportCommentId: report.id, acceptedAt: Date.now() } : one)),
    };
    const finalising: RecordTeamSessionCommand = { ...accepting, id: `${accepting.id}:final`, session: { ...accepting.session, status: "finalized", result: "approved" } };

    const answer = await serveApply(serving, { deviceId: annaDevice, commands: [accepting, finalising] });
    expect(answer.results.map((result) => [result.applied, result.problem])).toEqual([
      [false, "That team session was superseded, so it takes no more contributions."],
      [false, "That team session was superseded, so it takes no more contributions."],
    ]);
    expect(getTeamSessionRecord(recordDb.db, old.id)!.attempts[0]?.reportCommentId).toBeNull();
    expect(getTeamSessionRecord(recordDb.db, fresh.id)!.session.status).toBe("open");
  });

  it("left open by a device that lost the item is superseded by the one that holds it now", async () => {
    const first = openTeamSession(annaDb.db, { itemId: item.id, stepId: "todo", team: TEAM });
    await anna.sync();
    leaseTo(danaDevice);
    await dana.sync();
    expect(getTeamSessionRecord(danaDb.db, first.id)?.session.status).toBe("open");

    const second = openTeamSession(danaDb.db, { itemId: item.id, stepId: "todo", team: TEAM });
    await dana.sync();

    expect(pendingCommands(danaDb.db)).toEqual([]);
    expect(getTeamSessionRecord(recordDb.db, first.id)!.session).toMatchObject({ status: "superseded", supersededBy: second.id, deviceId: annaDevice });
    expect(getTeamSessionRecord(recordDb.db, second.id)!.session).toMatchObject({ status: "open", deviceId: danaDevice });
  });
});
