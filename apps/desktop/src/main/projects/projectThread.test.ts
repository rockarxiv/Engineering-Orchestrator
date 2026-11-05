import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { developerType, type Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AttachmentStorage } from "../attachments/storage.js";
import { setArchiveAfterDays, sweepArchive } from "../archive/sweep.js";
import type { DbHandle } from "../db/client.js";
import {
  createItem,
  createProject,
  createRun,
  getItem,
  getProject,
  getStep,
  listItemsForProject,
  needsAttention,
  postComment,
} from "../db/repos/index.js";
import { beginAdoption } from "../db/repos/projectsRepo.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { deleteItemCommand } from "../ipc/deleteItemCommand.js";
import { deleteProjectCommand } from "../ipc/deleteProjectCommand.js";
import { listArchivedSummaries, listInbox, listItemSummaries } from "../ipc/domainQueries.js";
import { createLocalRecord } from "../record/localRecord.js";
import {
  PROJECT_THREAD_STEP,
  PROJECT_THREAD_TITLE,
  findProjectThread,
  isProjectThread,
  openProjectThread,
} from "./projectThread.js";

/**
 * A thread for each project (EO-471, ARCHITECTURE.md, "One channel").
 *
 * The accessor, and the four places an off-board item has to stay out
 * of or behave like any other: the board and the archive, the sweep, the
 * inbox, and delete. The organisation's half — a desktop asking the
 * record for a moved project's thread — is `record/projectThread.test.ts`.
 */

let handle: DbHandle;
let scratch: string;

beforeEach(() => {
  handle = openMigratedTestDb();
  scratch = mkdtempSync(join(tmpdir(), "eo project thread "));
});

afterEach(() => {
  handle.close();
  rmSync(scratch, { recursive: true, force: true });
});

function project(name = "Shop", keyPrefix = "SHOP") {
  return createProject(handle.db, { name, keyPrefix });
}

function threadOf(projectId: Uuid) {
  const answer = openProjectThread(handle.db, projectId);
  if (!answer.ok) throw new Error(answer.problem);
  return answer.item;
}

/** No Jira: the type is read off the command, so this test reaches into no pack. */
const NO_JIRA: Parameters<typeof deleteItemCommand>[2] = {
  credentials: {
    directory: "/nonexistent",
    store: { isEncryptionAvailable: () => false, encryptString: () => Buffer.from(""), decryptString: () => "" },
  },
  fetchImpl: async () => new Response("{}", { status: 200 }),
};

describe("the project-thread accessor", () => {
  it("makes the thread on the first call and answers the same item on the second", async () => {
    const shop = project();
    expect(findProjectThread(handle.db, shop.id)).toBeUndefined();
    const record = createLocalRecord(handle.db);

    const first = await record.projectThread(shop.id);
    const second = await record.projectThread(shop.id);

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.item.id).toBe(first.item.id);
    expect(first.item).toMatchObject({
      key: "SHOP-NOTES",
      title: PROJECT_THREAD_TITLE,
      stepId: PROJECT_THREAD_STEP,
      projectId: shop.id,
    });
    expect(isProjectThread(first.item)).toBe(true);
    expect(listItemsForProject(handle.db, shop.id).filter(isProjectThread)).toHaveLength(1);
  });

  it("makes exactly one item when called many times at once", async () => {
    const shop = project();
    const record = createLocalRecord(handle.db);

    const answers = await Promise.all(Array.from({ length: 8 }, () => record.projectThread(shop.id)));

    const ids = new Set(answers.map((answer) => (answer.ok ? answer.item.id : answer.problem)));
    expect(ids.size).toBe(1);
    expect(listItemsForProject(handle.db, shop.id).filter(isProjectThread)).toHaveLength(1);
  });

  it("gives each project its own, keyed by the project rather than by a counter", () => {
    const shop = project();
    const admin = project("Admin", "ADM");

    const one = threadOf(shop.id);
    const other = threadOf(admin.id);

    expect(other.id).not.toBe(one.id);
    expect(other.projectId).toBe(admin.id);
    expect([one.key, other.key]).toEqual(["SHOP-NOTES", "ADM-NOTES"]);
  });

  it("takes no number from the project's own sequence", () => {
    const shop = project();
    threadOf(shop.id);

    const story = createItem(handle.db, { type: developerType("story"), title: "First story", stepId: "todo", projectId: shop.id });

    expect(story.ok && story.item.key).toBe("SHOP-1");
  });

  it("is held to one per project by the database, whoever writes the second", () => {
    const shop = project();
    threadOf(shop.id);

    // A writer that skipped the accessor — another connection racing this
    // one is the case — cannot make a second, even under a key of its own.
    expect(() =>
      createItem(handle.db, { type: developerType("feature"), title: "Another", stepId: PROJECT_THREAD_STEP, projectId: shop.id, key: "SHOP-OTHER-NOTES" }),
    ).toThrow(/UNIQUE/);
    expect(listItemsForProject(handle.db, shop.id).filter(isProjectThread)).toHaveLength(1);
  });

  it("says why there is none for a project that does not exist", () => {
    const answer = openProjectThread(handle.db, "0190d1b2-0000-7000-8000-000000000000" as Uuid);

    expect(answer).toEqual({ ok: false, problem: "That project no longer exists, so it has no thread." });
  });

  it("makes none while the project is moving to the record, and says so", () => {
    const shop = project();
    beginAdoption(handle.db, shop.id);

    const answer = openProjectThread(handle.db, shop.id);

    expect(answer.ok).toBe(false);
    expect(answer.ok ? "" : answer.problem).toMatch(/Shop is moving to your organisation's record/);
    expect(findProjectThread(handle.db, shop.id)).toBeUndefined();
  });
});

describe("where the project thread does not appear", () => {
  it("sits on an off-board step, so it is on no board and in no column", () => {
    const shop = project();
    const thread = threadOf(shop.id);

    expect(getStep(handle.db, PROJECT_THREAD_STEP)).toMatchObject({ offBoard: true, isTerminal: false, ownerRole: null });
    expect(listItemSummaries(handle.db, shop.id).items.map((item) => item.id)).not.toContain(thread.id);
  });

  it("is never archived by the sweep, and so is in no archive listing", () => {
    const shop = project();
    const thread = threadOf(shop.id);
    setArchiveAfterDays(handle.db, 0);

    const swept = sweepArchive(handle.db, Date.now() + 365 * 24 * 60 * 60 * 1000);

    expect(swept.archived).toBe(0);
    expect(getItem(handle.db, thread.id)?.archivedAt).toBeNull();
    expect(listArchivedSummaries(handle.db, shop.id).items.map((item) => item.id)).not.toContain(thread.id);
  });
});

describe("a mention on the project thread", () => {
  it("reaches the inbox, the open count and the item's `!`, like a mention anywhere else", () => {
    const shop = project();
    const thread = threadOf(shop.id);

    postComment(handle.db, {
      itemId: thread.id,
      author: { type: "engine" },
      kind: "question",
      body: "A skill is proposed for this project. Save it?",
      options: ["Save", "Discard"],
      mentions: [{ type: "human" }],
      parseBodyMentions: false,
    });

    const inbox = listInbox(handle.db, shop.id);
    expect(inbox.items.map((row) => row.itemId)).toEqual([thread.id]);
    expect(inbox.summary.openCount).toBe(1);
    expect(needsAttention(handle.db, thread.id)).toBe(true);
  });

  it("counts toward the blocking count when what posted it is waiting on the reply", () => {
    const shop = project();
    const thread = threadOf(shop.id);
    const run = createRun(handle.db, { itemId: thread.id, agentId: null, action: "consolidate", status: "awaiting_input" });

    postComment(handle.db, {
      itemId: thread.id,
      runId: run.id,
      author: { type: "engine" },
      kind: "question",
      body: "Which of these two procedures is current?",
      mentions: [{ type: "human" }],
      parseBodyMentions: false,
    });

    const inbox = listInbox(handle.db, shop.id);
    expect(inbox.items.find((row) => row.itemId === thread.id)?.blocking).toBe(true);
    expect(inbox.summary.blockingCount).toBe(1);
  });
});

describe("deleting the project thread", () => {
  it("is refused with a sentence while its project exists", async () => {
    const shop = project();
    const thread = threadOf(shop.id);

    const result = await deleteItemCommand(handle.db, undefined, NO_JIRA, { itemId: thread.id, cancelActiveRun: false, discardUncommitted: false, deleteInJira: false }, new AttachmentStorage(join(scratch, "files")));

    expect(result.deleted).toBe(false);
    expect(result.problem).toBe("SHOP-NOTES is Shop's notes, which stay as long as the project does. Deleting the project removes them with it.");
    expect(getItem(handle.db, thread.id)).toBeDefined();
  });

  it("goes with its project when the project is deleted", async () => {
    const shop = project();
    project("Admin", "ADM");
    const thread = threadOf(shop.id);

    const result = await deleteProjectCommand(handle.db, undefined, { projectId: shop.id, confirm: true }, new AttachmentStorage(join(scratch, "files")));

    expect(result.problem).toBeNull();
    expect(getProject(handle.db, shop.id)).toBeUndefined();
    expect(getItem(handle.db, thread.id)).toBeUndefined();
  });
});
