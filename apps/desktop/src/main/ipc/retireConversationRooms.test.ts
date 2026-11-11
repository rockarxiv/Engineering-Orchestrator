import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { developerType, uuidv7, type Item, type Uuid } from "@eo/core";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AttachmentStorage } from "../attachments/storage.js";
import type { DbHandle } from "../db/client.js";
import {
  appendRunEvent,
  createItem,
  createProject,
  createRun,
  getItem,
  insertAttachments,
  jobForConversation,
  listAttachmentsForItem,
  listCommentsForItem,
  listMentionsForComment,
  listOccurrences,
  listRunEvents,
  listRunsForItem,
  listTransitionsForItem,
  postComment,
  setItemArchived,
} from "../db/repos/index.js";
import { keyCounters, transitions } from "../db/schema.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { recordItemsFromConversation } from "../jobs/fromDiscussion.js";
import { assistAgent, openAssistConversation } from "../roles/assist.js";
import { SCENARIO_STEP } from "../roles/conversationSteps.js";
import { retireConversationRooms } from "./retireConversationRooms.js";

/**
 * Deleting what Discussions and the Architecture panel left behind
 * (EO-526).
 *
 * Every kind of conversation EO holds, seeded the same way and side by
 * side — so what the startup step tells apart is the room and nothing
 * else: a DISC and an ARCH conversation, which go, beside an assistant
 * chat and a scenario chat, which stay.
 */
let handle: DbHandle;
let directory: string;
let storage: AttachmentStorage;
let projectId: Uuid;

beforeEach(() => {
  handle = openMigratedTestDb();
  projectId = createProject(handle.db, { name: "Acme", keyPrefix: "ACME" }).id as Uuid;
  directory = mkdtempSync(join(tmpdir(), "eo retire rooms "));
  storage = new AttachmentStorage(join(directory, "managed"));
});

afterEach(() => {
  handle.close();
  rmSync(directory, { recursive: true, force: true });
});

/** A conversation on one of the two retired rooms' steps, as the rooms themselves opened one. */
function retiredRoom(stepId: "discussion" | "architecture", keyPrefix: "DISC" | "ARCH"): Item {
  const created = createItem(handle.db, {
    type: developerType("feature"),
    title: stepId === "discussion" ? "Conversation" : "Pipeline configuration",
    stepId,
    projectId,
    keyPrefix,
    ...(stepId === "architecture" ? { spec: { architect: { pipelineId: "default" } } } : {}),
  });
  if (!created.ok) throw new Error(created.problem);
  return created.item;
}

function scenarioChat(): Item {
  const created = createItem(handle.db, {
    type: developerType("feature"),
    title: "Scenarios: Deploy",
    stepId: SCENARIO_STEP,
    projectId,
    keyPrefix: "SCN",
  });
  if (!created.ok) throw new Error(created.problem);
  return created.item;
}

/** Work a conversation filed, so its `from-discussion` job has something to record. */
function filedWork(title: string): Item {
  const created = createItem(handle.db, { type: developerType("story"), title, stepId: "todo", projectId });
  if (!created.ok) throw new Error(created.problem);
  return created.item;
}

interface Seeded {
  item: Item;
  commentId: Uuid;
  runId: Uuid;
  attachmentPath: string;
  filed: Item;
}

/**
 * What a conversation owns: a comment with a mention, a run with an
 * event, a file attached on disk, a transition, and the `from-discussion`
 * job that records the work it filed.
 */
async function furnish(item: Item, label: string): Promise<Seeded> {
  const comment = postComment(handle.db, {
    itemId: item.id,
    author: { type: "human" },
    body: `About ${label}`,
    mentions: [{ type: "agent", agentId: assistAgent(handle.db)!.id }],
  });

  const run = createRun(handle.db, { itemId: item.id, agentId: assistAgent(handle.db)!.id, action: "respond", status: "succeeded" });
  appendRunEvent(handle.db, run.id, "output", { type: "output", text: `Looking at ${label}` });

  const source = join(directory, `${label}.txt`);
  writeFileSync(source, `notes on ${label}`);
  const [draft] = await storage.stagePaths([source]);
  const prepared = await storage.prepare([draft!.id]);
  insertAttachments(handle.db, prepared.map((record) => ({ ...record, itemId: item.id, commentId: comment.id })));
  await storage.finish(prepared);

  handle.db
    .insert(transitions)
    .values({ id: uuidv7(), itemId: item.id, fromStepId: null, toStepId: item.stepId!, actor: "human", ts: Date.now() })
    .run();

  const filed = filedWork(`Filed from ${label}`);
  recordItemsFromConversation(handle.db, item, [filed]);

  return { item, commentId: comment.id, runId: run.id, attachmentPath: listAttachmentsForItem(handle.db, item.id)[0]!.path, filed };
}

/** Everything `furnish` wrote, read back. */
function owned(seeded: Seeded) {
  const job = jobForConversation(handle.db, seeded.item.id);
  return {
    item: getItem(handle.db, seeded.item.id) !== undefined,
    comments: listCommentsForItem(handle.db, seeded.item.id).length,
    mentions: listMentionsForComment(handle.db, seeded.commentId).length,
    runs: listRunsForItem(handle.db, seeded.item.id).length,
    runEvents: listRunEvents(handle.db, seeded.runId).length,
    attachments: listAttachmentsForItem(handle.db, seeded.item.id).length,
    file: existsSync(seeded.attachmentPath),
    transitions: listTransitionsForItem(handle.db, seeded.item.id).length,
    job: job !== undefined,
    occurrences: job === undefined ? 0 : listOccurrences(handle.db, job.id as Uuid).length,
  };
}

const KEPT = { item: true, comments: 1, mentions: 1, runs: 1, runEvents: 1, attachments: 1, file: true, transitions: 1, job: true, occurrences: 1 };
const GONE = { item: false, comments: 0, mentions: 0, runs: 0, runEvents: 0, attachments: 0, file: false, transitions: 0, job: false, occurrences: 0 };

async function seedEveryRoom() {
  return {
    discussion: await furnish(retiredRoom("discussion", "DISC"), "discussion"),
    architecture: await furnish(retiredRoom("architecture", "ARCH"), "architecture"),
    assistant: await furnish(openAssistConversation(handle.db, projectId), "assistant"),
    scenario: await furnish(scenarioChat(), "scenario"),
  };
}

function keyCounter(prefix: string): number | undefined {
  return handle.db.select().from(keyCounters).where(eq(keyCounters.prefix, prefix)).get()?.nextValue;
}

describe("retiring Discussions and the Architecture panel at startup", () => {
  it("seeds each room the same way, so the deletion below is told apart by the room alone", async () => {
    const rooms = await seedEveryRoom();

    expect(rooms.discussion.item.key).toMatch(/^DISC-\d+$/);
    expect(rooms.architecture.item.key).toMatch(/^ARCH-\d+$/);
    expect(rooms.assistant.item.key).toMatch(/^ASK-\d+$/);
    expect(rooms.scenario.item.key).toMatch(/^SCN-\d+$/);
    for (const seeded of Object.values(rooms)) expect(owned(seeded), seeded.item.key).toEqual(KEPT);
  });

  it("deletes exactly the DISC and ARCH conversations, with everything under them, and leaves every other room alone", async () => {
    const rooms = await seedEveryRoom();

    await expect(retireConversationRooms(handle.db, storage)).resolves.toBe(2);

    expect(owned(rooms.discussion)).toEqual(GONE);
    expect(owned(rooms.architecture)).toEqual(GONE);
    for (const kept of [rooms.assistant, rooms.scenario]) {
      expect(owned(kept), kept.item.key).toEqual(KEPT);
    }
    // The work a discussion filed is the project's, not the conversation's.
    expect(getItem(handle.db, rooms.discussion.filed.id)).toBeDefined();
    expect(getItem(handle.db, rooms.architecture.filed.id)).toBeDefined();
  });

  it("removes every row before it returns, leaving only the files in flight", async () => {
    const rooms = await seedEveryRoom();

    const pending = retireConversationRooms(handle.db, storage);
    // Not awaited yet: this is the state the engine starts against.
    expect(getItem(handle.db, rooms.discussion.item.id)).toBeUndefined();
    expect(getItem(handle.db, rooms.architecture.item.id)).toBeUndefined();
    expect(listRunsForItem(handle.db, rooms.discussion.item.id)).toEqual([]);
    await pending;
    expect(existsSync(rooms.discussion.attachmentPath)).toBe(false);
  });

  it("deletes a conversation that was ended as well as one still open", async () => {
    const ended = retiredRoom("discussion", "DISC");
    setItemArchived(handle.db, ended.id, Date.now());

    await expect(retireConversationRooms(handle.db, storage)).resolves.toBe(1);
    expect(getItem(handle.db, ended.id)).toBeUndefined();
  });

  it("keeps the DISC and ARCH key counters", async () => {
    await seedEveryRoom();
    const before = { disc: keyCounter("DISC"), arch: keyCounter("ARCH") };
    expect(before.disc).toBeDefined();
    expect(before.arch).toBeDefined();

    await retireConversationRooms(handle.db, storage);

    expect({ disc: keyCounter("DISC"), arch: keyCounter("ARCH") }).toEqual(before);
  });

  it("deletes nothing and fails nothing on a second start", async () => {
    const rooms = await seedEveryRoom();
    await retireConversationRooms(handle.db, storage);

    await expect(retireConversationRooms(handle.db, storage)).resolves.toBe(0);
    for (const kept of [rooms.assistant, rooms.scenario]) {
      expect(owned(kept), kept.item.key).toEqual(KEPT);
    }
  });

  it("does nothing on an installation that never had either room", async () => {
    await expect(retireConversationRooms(handle.db, storage)).resolves.toBe(0);
  });
});
