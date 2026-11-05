import type { Item, Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { deleteItem, getItem, listJobs, listOccurrences } from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { openAssistConversation } from "../roles/assist.js";
import { recordItemsFromConversation } from "./fromDiscussion.js";
import { originOfItem } from "./origin.js";

let handle: DbHandle;

beforeEach(() => {
  handle = openMigratedTestDb();
});

afterEach(() => {
  handle.close();
});

function story(title: string): Item {
  return createTestItem(handle.db, { type: "story", title, stepId: "todo", projectId: null });
}

describe("an item created by pressing Create in a conversation", () => {
  it("is recorded as a from-discussion occurrence on a job that owns the conversation as its thread", () => {
    const conversation = openAssistConversation(handle.db, null);
    const created = story("Page the importer");

    recordItemsFromConversation(handle.db, conversation, [created]);

    const jobs = listJobs(handle.db, null);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.trigger).toEqual({ kind: "from-discussion", conversationId: conversation.id });
    // The conversation *is* the thread: a job's guard channel is the one
    // the conversation already is, so no second item is created.
    expect(jobs[0]?.threadItemId).toBe(conversation.id);
    // And no template or pipeline, because the conversation supplied
    // the item and the approval resolved the placement.
    expect(jobs[0]?.template).toBeNull();
    expect(jobs[0]?.pipelineId).toBeNull();
  });

  it("names the job after the conversation, so the item's rail can say where it came from", () => {
    const conversation = openAssistConversation(handle.db, null);
    const created = story("Page the importer");

    recordItemsFromConversation(handle.db, conversation, [created]);

    expect(originOfItem(handle.db, created.id)).toMatchObject({
      jobName: `Conversation ${conversation.key}`,
      trigger: "from-discussion",
    });
  });

  it("reuses the conversation's job on the second Create rather than filing a second one", () => {
    const conversation = openAssistConversation(handle.db, null);

    recordItemsFromConversation(handle.db, conversation, [story("First")]);
    recordItemsFromConversation(handle.db, conversation, [story("Second")]);

    const jobs = listJobs(handle.db, null);
    expect(jobs).toHaveLength(1);
    expect(listOccurrences(handle.db, jobs[0]!.id as Uuid)).toHaveLength(2);
  });

  it("records every item a plan created, not just the first", () => {
    // Approving a plan creates a container and its children in one act.
    // An occurrence per press would leave all but one of them unable to
    // say where they came from.
    const conversation = openAssistConversation(handle.db, null);
    const items = [story("The feature"), story("Story one"), story("Story two")];

    recordItemsFromConversation(handle.db, conversation, items);

    for (const item of items) {
      expect(originOfItem(handle.db, item.id)?.jobName).toBe(`Conversation ${conversation.key}`);
    }
  });

  it("keeps two conversations' jobs apart", () => {
    const first = openAssistConversation(handle.db, null);
    const second = openAssistConversation(handle.db, null);
    const fromFirst = story("First");
    const fromSecond = story("Second");

    recordItemsFromConversation(handle.db, first, [fromFirst]);
    recordItemsFromConversation(handle.db, second, [fromSecond]);

    expect(listJobs(handle.db, null)).toHaveLength(2);
    expect(originOfItem(handle.db, fromFirst.id)?.jobName).toBe(`Conversation ${first.key}`);
    expect(originOfItem(handle.db, fromSecond.id)?.jobName).toBe(`Conversation ${second.key}`);
  });

  it("records nothing when the approval created nothing", () => {
    const conversation = openAssistConversation(handle.db, null);

    recordItemsFromConversation(handle.db, conversation, []);

    expect(listJobs(handle.db, null)).toEqual([]);
  });

  it("says nothing about an item a person filed themselves", () => {
    expect(originOfItem(handle.db, story("Typed by hand").id)).toBeNull();
  });

  it("does not stop the conversation from being deleted", () => {
    // `jobs.thread_item_id` is a real foreign key, so a conversation
    // that owns a job would otherwise be undeletable — a feature that
    // already exists, broken by a table it has never heard of. The job
    // goes with the thread, and its occurrences with the job.
    const conversation = openAssistConversation(handle.db, null);
    const created = story("Page the importer");
    recordItemsFromConversation(handle.db, conversation, [created]);

    expect(() => deleteItem(handle.db, conversation.id)).not.toThrow();

    expect(listJobs(handle.db, null)).toEqual([]);
    // The item it made is untouched: an occurrence's `item_id` carries
    // no foreign key in either direction.
    expect(getItem(handle.db, created.id)?.title).toBe("Page the importer");
    expect(originOfItem(handle.db, created.id)).toBeNull();
  });
});
