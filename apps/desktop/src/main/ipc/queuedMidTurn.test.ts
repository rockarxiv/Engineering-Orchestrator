import { HUMAN_MESSAGE_EVENT, type Agent, type Item, type ModuleManifest, type Run, type Uuid } from "@eo/core";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AttachmentStorage } from "../attachments/storage.js";
import type { DbHandle } from "../db/client.js";
import {
  createRun,
  dismissOpenMentionsForComment,
  getItem,
  listCommentsForItem,
  listMentionsForComment,
  listRunEvents,
  listRunsForItem,
  saveModule,
  updateRun,
} from "../db/repos/index.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { SCENARIO_ACTION } from "../roles/conversationSteps.js";
import { scenarioAgent } from "../roles/scenario.js";
import { buildFollowUpContext } from "../supervisor/buildDispatchContext.js";
import { createItemLock } from "../supervisor/itemLock.js";
import { findPendingResponses } from "../supervisor/manualDispatch.js";
import type { EngineHandle } from "./domainCommands.js";
import { sendToScenario } from "./scenarioCommands.js";

/**
 * A message sent into a room while its agent is mid-turn (EO-396).
 *
 * The scenario chat does not speak into a running turn: it posts a
 * comment whose mention starts the next one. That comment is older than
 * the `endedAt` the running turn goes on to get, and — unlike the
 * composers that steer — the room writes no `human_message` row saying it
 * was left over. So the turn the message started resumed the thread and
 * was told nothing new had been said. (Discussions and the Architecture
 * panel sent the same way until EO-526 removed them.)
 *
 * A list of rooms rather than one file, for the reason the fix is in
 * `followUpComments` rather than in a send function: the promise is the
 * same promise in each, and a room added here fails until it keeps it.
 */

const HEADING = "New comments since your last run";
const NOTHING_NEW = "Nothing new has been said";

const manifest: ModuleManifest = {
  name: "Merge pull request",
  description: "Merges once CI passes.",
  inputs: {},
  needs: { bin: [], env: [], network: false, item: false, comment: false, attach: false, create: false },
  results: ["merged"],
};

interface Room {
  channel: string;
  action: string;
  /** Whether this room's composer takes files at all. */
  files: boolean;
  agent: () => Agent;
  /** Sends as the room's own command does, and answers with the conversation it landed in. */
  send: (engine: EngineHandle, conversationId: string | null, body: string, attachmentIds: string[], storage: AttachmentStorage, interrupt?: boolean) => Promise<string>;
}

let handle: DbHandle;
let directory: string;
let storage: AttachmentStorage;
let moduleId: string;

const rooms: Room[] = [
  {
    channel: "scenario:send",
    action: SCENARIO_ACTION,
    files: true,
    agent: () => scenarioAgent(handle.db)!,
    send: async (engine, conversationId, body, attachmentIds, files, interrupt = false) =>
      (await sendToScenario(handle.db, engine, { moduleId, conversationId, body, attachmentIds, interrupt }, files)).conversation.id,
  },
];

function fakeEngine(): EngineHandle {
  return {
    resumeItem: vi.fn(async () => {}),
    cancelRun: vi.fn(),
    steerRun: vi.fn(async () => "steered" as const),
    pause: vi.fn(),
    resume: vi.fn(),
    isPaused: () => false,
    dispatchBlockerFor: () => null,
    activeRunCount: () => 1,
    finishingRunCount: () => 0,
    notifyStateChange: vi.fn(),
    itemLock: createItemLock(),
    offerWork: async () => [],
  };
}

beforeEach(() => {
  handle = openMigratedTestDb();
  directory = mkdtempSync(join(tmpdir(), "eo queued mid turn "));
  storage = new AttachmentStorage(join(directory, "managed"));
  const saved = saveModule(handle.db, { slug: "merge-pr", name: manifest.name, description: manifest.description, code: "export default async () => ({ ok: true, result: 'merged' });", manifest, source: "user", approve: true });
  if (!saved.ok) throw new Error(saved.reason);
  moduleId = saved.module.id;
});

afterEach(() => {
  handle.close();
  rmSync(directory, { recursive: true, force: true });
});

const rowOf = (id: string): Item => getItem(handle.db, id as Uuid)!;

function newestHumanComment(conversationId: string) {
  return listCommentsForItem(handle.db, conversationId as Uuid).filter((comment) => comment.authorType === "human").at(-1)!;
}

/** A turn in flight on the room's newest message — the row the supervisor would have written. */
function turnOn(room: Room, conversationId: string): Run {
  return createRun(handle.db, {
    itemId: conversationId as Uuid,
    agentId: room.agent().id,
    action: room.action,
    status: "running",
    threadId: "thread-1",
    initiationId: newestHumanComment(conversationId).id,
  });
}

/**
 * The turn ends: its own request is closed and its row is terminal.
 *
 * No reply is posted, and not to save a line. A bare agent comment
 * addresses every open mention aimed at its author, the queued one
 * included; each room's own reply function narrows that to the run's
 * initiation, and going round
 * them here would close the mention this is about to count on.
 *
 * `endedAt` is pushed out past the clock on purpose. A test runs inside
 * a millisecond, and a comment sharing one with the end of its run is
 * carried by the watermark's tie-break whatever else is true — which
 * would let these pass with the fix taken out. A turn that outlasts the
 * message sent into it is the case that was broken, so it is the case
 * that is built.
 */
function finish(run: Run): Run {
  if (run.initiationId) dismissOpenMentionsForComment(handle.db, run.initiationId as Uuid);
  return updateRun(handle.db, run.id, { status: "succeeded", endedAt: Date.now() + 60_000 });
}

const followUp = (room: Room, conversationId: string, priorRun: Run) =>
  buildFollowUpContext(handle.db, rowOf(conversationId), room.agent(), room.action, priorRun).fullText;

async function stagedScreenshot(): Promise<string> {
  const path = join(directory, "screen.png");
  writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const [draft] = await storage.stagePaths([path]);
  return draft!.id;
}

describe.each(rooms)("a message sent through $channel while a turn is running", (room) => {
  it("is queued rather than delivered, and is in the next turn's prompt exactly once", async () => {
    const engine = fakeEngine();
    const conversationId = await room.send(engine, null, "How should review work?", [], storage);
    const running = turnOn(room, conversationId);

    await room.send(engine, conversationId, "And put QA before it.", [], storage);
    const queued = newestHumanComment(conversationId);
    expect(queued.body).toBe("And put QA before it.");

    // Still a queue: nothing was said into the turn, the turn was not
    // cut off, and the mention that will start the next one is open.
    expect(engine.steerRun).not.toHaveBeenCalled();
    expect(engine.cancelRun).not.toHaveBeenCalled();
    expect(listRunsForItem(handle.db, conversationId as Uuid).map((run) => [run.id, run.status])).toEqual([[running.id, "running"]]);
    expect(listRunEvents(handle.db, running.id).filter((event) => event.type === HUMAN_MESSAGE_EVENT)).toEqual([]);
    expect(listMentionsForComment(handle.db, queued.id).find((mention) => mention.targetType === "agent")?.status).toBe("open");

    const ended = finish(running);
    // The premise the bug needs: the message is older than the watermark.
    expect(queued.createdAt).toBeLessThan(ended.endedAt!);
    expect(findPendingResponses(handle.db, [conversationId as Uuid]).map((pending) => pending.action)).toEqual([room.action]);

    const prompt = followUp(room, conversationId, ended);
    expect(prompt).toContain(HEADING);
    expect(prompt).toContain("And put QA before it.");
    expect(prompt).not.toContain(NOTHING_NEW);
    // Only what the turn had not seen, which the message that started
    // it is not.
    expect(prompt).not.toContain("How should review work?");

    // The turn that message started, and then the one after it — woken
    // by something else, with the queued message long since read.
    const next = finish(turnOn(room, conversationId));
    expect(findPendingResponses(handle.db, [conversationId as Uuid])).toEqual([]);
    const after = followUp(room, conversationId, next);
    expect(after).not.toContain("And put QA before it.");
    expect(after).toContain(NOTHING_NEW);
  });

  it.runIf(room.files)("carries the files of a queued message sent with no words", async () => {
    const conversationId = await room.send(fakeEngine(), null, "Why is this step red?", [], storage);
    const running = turnOn(room, conversationId);

    // What was first seen (ASK-21): a screenshot, seconds after the
    // message it belonged to, with nothing typed.
    const attachmentId = await stagedScreenshot();
    await room.send(fakeEngine(), conversationId, "", [attachmentId], storage);

    const prompt = followUp(room, conversationId, finish(running));
    expect(prompt).toContain(HEADING);
    expect(prompt).not.toContain(NOTHING_NEW);
    expect(prompt).toContain(`ID: ${attachmentId}; name: screen.png`);
  });

  it("still interrupts when asked to, and the message that replaced the turn is in the next one", async () => {
    const engine = fakeEngine();
    const conversationId = await room.send(engine, null, "Keep working.", [], storage);
    const running = turnOn(room, conversationId);

    await room.send(engine, conversationId, "Actually, do this instead.", [], storage, true);

    expect(engine.cancelRun).toHaveBeenCalledExactlyOnceWith(running.id, "superseded");
    expect(engine.steerRun).not.toHaveBeenCalled();
    // The fake cancels nothing, so the row ends here as the supervisor
    // would have ended it — after the message, which is the order a
    // cancellation that takes a moment leaves them in.
    const cancelled = updateRun(handle.db, running.id, { status: "cancelled", endedAt: Date.now() + 60_000 });
    expect(followUp(room, conversationId, cancelled)).toContain("Actually, do this instead.");
  });
});
