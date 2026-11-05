import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitStateOf, jiraStateOf, type Item, type Uuid } from "@eo/core";
import type { DbHandle } from "../client.js";
import {
  addDependency,
  createRun,
  createRunEventBuffer,
  enqueueOutbox,
  listAgents,
  listAllDependencies,
  listCommentsForItem,
  listRunEvents,
  listRunsForItem,
  openMentionsForHuman,
  pendingPushesForItem,
  postComment,
  setItemArchived,
  sumCostCentsSince,
  transitionItem,
  updateRun,
  updateItem,
} from "./index.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../testHelpers.js";
import {
  clearJiraPullPending,
  deleteItem,
  getItem,
  getItemByJiraKey,
  hasJiraPullPending,
  isJiraPullPending,
  linkJiraKey,
  listItems,
  listJiraPullPending,
  setJiraSync,
  type CreateItemInput,
} from "./itemsRepo.js";

describe("itemsRepo", () => {
  let handle: DbHandle;

  beforeEach(() => {
    handle = openMigratedTestDb();
  });

  afterEach(() => {
    handle.close();
  });

  it("creates an item with a generated id and a sequential human-readable key", () => {
    const first = createTestItem(handle.db, { type: "feature", title: "First", stepId: null });
    expect(first.key).toBe("EO-1");
    expect(first.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.createdAt).toBe(first.updatedAt);

    const second = createTestItem(handle.db, { type: "story", title: "Second", stepId: "todo" });
    expect(second.key).toBe("EO-2");
  });

  it("assigns keys with no gaps or duplicates under a 100-insert loop", () => {
    const keys = Array.from(
      { length: 100 },
      (_, i) => createTestItem(handle.db, { type: "story", title: `Ticket ${i}`, stepId: "todo" }).key,
    );

    expect(new Set(keys).size).toBe(100);
    const numbers = keys.map((key) => Number(key.replace("EO-", ""))).sort((a, b) => a - b);
    expect(numbers).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
  });

  it("enforces the state foreign key", () => {
    expect(() => createTestItem(handle.db, { type: "story", title: "Bad", stepId: "not_a_real_state" })).toThrow();
  });

});

/**
 * Deleting an item for real (KAN-30).
 *
 * Every case here uses an item that has actually been *worked* —
 * comments, a run, run events, a queued push — because the old
 * one-line `delete from items` passed a test on a bare item and
 * could not have deleted a real one: foreign keys are ON, and nothing
 * referencing `items.id` cascades.
 */
describe("deleteItem", () => {
  let handle: DbHandle;
  let agentId: Uuid;
  let workspaceId: Uuid;

  beforeEach(() => {
    handle = openMigratedTestDb();
    agentId = listAgents(handle.db)[0]!.id;
    workspaceId = attachWorkspace(handle.db, { name: "app", keyPrefix: "APP", repoPath: "/tmp/app" }).id;
  });

  afterEach(() => {
    handle.close();
  });

  /** An item with something on it: the only kind worth testing a delete against. */
  function workedItem(overrides: { parentId?: Uuid } = {}) {
    const item = createTestItem(handle.db, {
      type: overrides.parentId ? "story" : "feature",
      title: "Rate limiting",
      stepId: "todo",
      workspaceId,
      parentId: overrides.parentId ?? null,
    });

    const question = postComment(handle.db, {
      itemId: item.id,
      author: { type: "agent", agentId },
      kind: "question",
      mentions: [{ type: "human" }],
      body: "Per key or per account?",
    });
    const run = createRun(handle.db, { itemId: item.id, agentId, action: "refine", status: "succeeded" });
    const events = createRunEventBuffer(handle.db);
    events.append(run.id, "stdout", { text: "working" });
    events.flush();
    events.dispose();
    transitionItem(handle.db, { itemId: item.id, toStepId: "review", actor: "human" });
    enqueueOutbox(handle.db, { itemId: item.id, workspaceId, channel: "jira", kind: "comment", payload: {} });

    return { item, run, questionId: question.id };
  }

  it("removes an item that has been worked on, with everything written about it", () => {
    const { item, run } = workedItem();

    expect(deleteItem(handle.db, item.id).deletedItemIds).toEqual([item.id]);

    expect(getItem(handle.db, item.id)).toBeUndefined();
    expect(listCommentsForItem(handle.db, item.id)).toEqual([]);
    expect(listRunsForItem(handle.db, item.id)).toEqual([]);
    expect(listRunEvents(handle.db, run.id)).toEqual([]);
    expect(pendingPushesForItem(handle.db, item.id)).toEqual([]);
  });

  it("takes the stories under a feature with it", () => {
    const feature = workedItem();
    const first = workedItem({ parentId: feature.item.id });
    const second = workedItem({ parentId: feature.item.id });

    const { deletedItemIds } = deleteItem(handle.db, feature.item.id);

    expect(new Set(deletedItemIds)).toEqual(new Set([feature.item.id, first.item.id, second.item.id]));
    expect(getItem(handle.db, first.item.id)).toBeUndefined();
    expect(getItem(handle.db, second.item.id)).toBeUndefined();
  });

  it("leaves a sibling feature and its stories completely alone", () => {
    const doomed = workedItem();
    const survivor = workedItem();
    const survivorStory = workedItem({ parentId: survivor.item.id });

    deleteItem(handle.db, doomed.item.id);

    expect(getItem(handle.db, survivor.item.id)).toBeDefined();
    expect(getItem(handle.db, survivorStory.item.id)).toBeDefined();
    expect(listCommentsForItem(handle.db, survivor.item.id)).toHaveLength(1);
    expect(listRunsForItem(handle.db, survivor.item.id)).toHaveLength(1);
    expect(listRunEvents(handle.db, survivor.run.id)).toHaveLength(1);
  });

  it("cuts dependency edges pointing both ways", () => {
    // An edge *into* the deleted item dangles just as badly as one out
    // of it, and only one of the two directions is obvious.
    const doomed = workedItem();
    const before = workedItem();
    const after = workedItem();
    addDependency(handle.db, doomed.item.id, before.item.id);
    addDependency(handle.db, after.item.id, doomed.item.id);

    deleteItem(handle.db, doomed.item.id);

    expect(listAllDependencies(handle.db)).toEqual([]);
    expect(getItem(handle.db, after.item.id)).toBeDefined();
  });

  it("clears the mentions its comments raised, so the inbox does not keep pointing at it", () => {
    const { item } = workedItem();
    expect(openMentionsForHuman(handle.db)).toHaveLength(1);

    deleteItem(handle.db, item.id);

    expect(openMentionsForHuman(handle.db)).toEqual([]);
  });

  it("is a no-op on an item that is already gone", () => {
    // Two windows, or a double-click. Deleting nothing is the right
    // answer to "delete this thing that isn't there".
    const { item } = workedItem();
    deleteItem(handle.db, item.id);

    expect(deleteItem(handle.db, item.id)).toEqual({ deletedItemIds: [item.id] });
  });

  it("lowers the recorded spend for the days it ran on", () => {
    // Not a bug — the documented cost of a hard delete. `sumCostCentsSince`
    // totals runs by time, so a deleted item takes its spend out of the
    // budget guard's history. Pinned here so it is a decision rather than
    // a discovery.
    const { item, run } = workedItem();
    updateRun(handle.db, run.id, { costCents: 981, startedAt: Date.now() });
    expect(sumCostCentsSince(handle.db, 0)).toBe(981);

    deleteItem(handle.db, item.id);

    expect(sumCostCentsSince(handle.db, 0)).toBe(0);
  });
});

/**
 * The Jira link and the per-item sync switch (EO-122).
 *
 * The two are deliberately independent: the key says *which* issue this
 * item mirrors, the switch says whether EO talks to it. Everything
 * here is local — no test needs a Jira, because linking never asks one.
 */
describe("linkJiraKey and setJiraSync", () => {
  let handle: DbHandle;
  let workspaceId: Uuid;

  beforeEach(() => {
    handle = openMigratedTestDb();
    workspaceId = attachWorkspace(handle.db, { name: "app", keyPrefix: "APP", repoPath: "/tmp/app" }).id;
  });

  afterEach(() => {
    handle.close();
  });

  function story(overrides: Partial<Parameters<typeof createTestItem>[1]> = {}) {
    return createTestItem(handle.db, { type: "story", title: "Rate limiting", stepId: "todo", workspaceId, ...overrides });
  }

  it("defaults an item with no parent to syncing", () => {
    // What every row did before the column existed, and what the
    // migration gives every row that predates it.
    expect(jiraStateOf(story()).sync).toBe(true);
  });

  it("creates a story under a sync-disabled feature with sync off", () => {
    const feature = createTestItem(handle.db, { type: "feature", title: "Limits", stepId: null, workspaceId });
    setJiraSync(handle.db, feature.id, false);

    const child = story({ parentId: feature.id });

    expect(jiraStateOf(child).sync).toBe(false);
    // Read back rather than trusted from the return value: the column is
    // what every gate tests.
    expect(jiraStateOf(getItem(handle.db, child.id)!).sync).toBe(false);
  });

  it("leaves a story under a syncing feature syncing, and lets the caller say otherwise", () => {
    const feature = createTestItem(handle.db, { type: "feature", title: "Limits", stepId: null, workspaceId });

    expect(jiraStateOf(story({ parentId: feature.id })).sync).toBe(true);
    // An explicit value beats the parent — `work_submit_plan` says so per
    // item, and inheritance is only the answer when nobody said.
    expect(jiraStateOf(story({ parentId: feature.id, jiraSync: false })).sync).toBe(false);
  });

  it("does not re-read the parent afterwards", () => {
    // Inheritance happens once, at creation (the pinned decision on
    // EO-121). Silencing the feature later leaves the story where it was.
    const feature = createTestItem(handle.db, { type: "feature", title: "Limits", stepId: null, workspaceId });
    const child = story({ parentId: feature.id });

    setJiraSync(handle.db, feature.id, false);

    expect(jiraStateOf(getItem(handle.db, child.id)!).sync).toBe(true);
  });

  it("attaches a key, trimmed and upper-cased", () => {
    const item = story();

    const result = linkJiraKey(handle.db, item.id, "  kan-123 ");

    expect(result).toMatchObject({ ok: true });
    expect(jiraStateOf(getItem(handle.db, item.id)!).key).toBe("KAN-123");
    // Canonical spelling matters beyond tidiness: `findByJiraKey` and
    // `jira/pull.ts` both match keys exactly.
    expect(getItemByJiraKey(handle.db, "KAN-123")?.id).toBe(item.id);
  });

  it("refuses something that is not a Jira issue key, and says what one looks like", () => {
    const item = story();

    const result = linkJiraKey(handle.db, item.id, "not a key");

    expect(result).toEqual({ ok: false, problem: '"not a key" is not a Jira issue key. They look like KAN-123.' });
    expect(jiraStateOf(getItem(handle.db, item.id)!).key).toBeNull();
  });

  it("refuses a key another item already holds, naming that item", () => {
    // One issue, one item (the pinned decision on EO-121): two
    // claimants make the Jira-key-to-item mapping ambiguous. The
    // refusal names the holder because "already linked" with no subject
    // leaves somebody hunting the board for it.
    const holder = story();
    linkJiraKey(handle.db, holder.id, "KAN-123");
    const other = story();

    const result = linkJiraKey(handle.db, other.id, "kan-123");

    expect(result).toEqual({ ok: false, problem: `${holder.key} is already linked to KAN-123.` });
    expect(jiraStateOf(getItem(handle.db, other.id)!).key).toBeNull();
  });

  it("counts an archived item as a holder", () => {
    // Tidying an item away is not releasing its issue — otherwise the
    // key could be handed to a second item and the mapping back from
    // Jira would have two answers.
    const holder = story();
    linkJiraKey(handle.db, holder.id, "KAN-123");
    setItemArchived(handle.db, holder.id, Date.now());

    expect(linkJiraKey(handle.db, story().id, "KAN-123")).toEqual({ ok: false, problem: `${holder.key} is already linked to KAN-123.` });
  });

  it("accepts an item being relinked to the key it already holds", () => {
    // A form resubmitted unchanged. Refusing here would make the item
    // its own blocker.
    const item = story();
    linkJiraKey(handle.db, item.id, "KAN-123");

    const relinked = linkJiraKey(handle.db, item.id, "KAN-123");
    expect(relinked.ok).toBe(true);
    expect(jiraStateOf(relinked.ok ? relinked.item : item).key).toBe("KAN-123");
  });

  it("clears the Jira id on every link, because it belongs to the old issue", () => {
    const item = createTestItem(handle.db, { type: "story", title: "Imported", stepId: "todo", workspaceId, jiraKey: "KAN-1", jiraId: "10001" });

    linkJiraKey(handle.db, item.id, "KAN-2");

    expect(jiraStateOf(getItem(handle.db, item.id)!)).toMatchObject({ key: "KAN-2", id: null });
  });

  it("clears the key and drops that item's pending Jira pushes", () => {
    // The outbox is a queue, not a ledger — invariant 3 is about
    // `run_events`. Leaving four entries to fail one by one would
    // produce a run of "no longer mirrored" notes for something the
    // person just asked for deliberately.
    const item = story();
    linkJiraKey(handle.db, item.id, "KAN-123");
    enqueueOutbox(handle.db, { itemId: item.id, workspaceId, channel: "jira", kind: "status", payload: { toStepId: "review" } });
    enqueueOutbox(handle.db, { itemId: item.id, workspaceId, channel: "forge", kind: "comment", payload: {} });
    const bystander = story();
    enqueueOutbox(handle.db, { itemId: bystander.id, workspaceId, channel: "jira", kind: "status", payload: { toStepId: "review" } });

    const result = linkJiraKey(handle.db, item.id, null);

    expect(result.ok).toBe(true);
    expect(jiraStateOf(getItem(handle.db, item.id)!).key).toBeNull();
    expect(pendingPushesForItem(handle.db, item.id, "jira")).toEqual([]);
    // Only the Jira channel: unlinking from Jira must not silently
    // delete a pending pull request, the same rule
    // `discardPushesForProject` is written to.
    expect(pendingPushesForItem(handle.db, item.id, "forge")).toHaveLength(1);
    expect(pendingPushesForItem(handle.db, bystander.id, "jira")).toHaveLength(1);
  });

  it("frees the key for another item once it is cleared", () => {
    const first = story();
    linkJiraKey(handle.db, first.id, "KAN-123");
    linkJiraKey(handle.db, first.id, null);
    const second = story();

    expect(linkJiraKey(handle.db, second.id, "KAN-123")).toMatchObject({ ok: true });
    expect(getItemByJiraKey(handle.db, "KAN-123")?.id).toBe(second.id);
  });

  it("switches sync off without losing which issue it was", () => {
    // The whole point of a switch that is not the key: turning it back
    // on resumes against the same issue rather than asking for the key
    // to be typed again.
    const item = story();
    linkJiraKey(handle.db, item.id, "KAN-123");

    const off = setJiraSync(handle.db, item.id, false);
    expect(off.ok && jiraStateOf(off.item)).toMatchObject({ sync: false, key: "KAN-123" });
    const on = setJiraSync(handle.db, item.id, true);
    expect(on.ok && jiraStateOf(on.item)).toMatchObject({ sync: true, key: "KAN-123" });
  });

  it("refuses in a sentence rather than throwing when the item is gone", () => {
    // Two windows, one of them deleting. A race, not programmer error.
    const item = story();
    deleteItem(handle.db, item.id);

    expect(linkJiraKey(handle.db, item.id, "KAN-123")).toEqual({ ok: false, problem: "That ticket no longer exists." });
    expect(setJiraSync(handle.db, item.id, false)).toEqual({ ok: false, problem: "That ticket no longer exists." });
  });
});

/**
 * The marker that turns a link into a backfill (EO-127).
 *
 * Attaching cannot call Jira — the submit and update paths are
 * synchronous, and the pinned decision on EO-121 is that a Jira which is
 * down never costs somebody the item they just submitted. So the
 * intent is written beside the key and `jira/pull.ts` acts on it later.
 */
describe("marking an item for the pull that follows attaching", () => {
  let handle: DbHandle;
  let workspaceId: Uuid;

  beforeEach(() => {
    handle = openMigratedTestDb();
    workspaceId = attachWorkspace(handle.db, { name: "api", keyPrefix: "API", repoPath: "/tmp/api" }).id;
  });

  afterEach(() => {
    handle.close();
  });

  function story(overrides: Partial<CreateItemInput> = {}): Item {
    return createTestItem(handle.db, { type: "story", title: "Work", stepId: "todo", workspaceId, ...overrides });
  }

  it("marks the item in the same statement that writes the key", () => {
    const item = story();
    expect(isJiraPullPending(handle.db, item.id)).toBe(false);

    linkJiraKey(handle.db, item.id, "KAN-123");

    expect(isJiraPullPending(handle.db, item.id)).toBe(true);
  });

  it("marks an item moved from one issue to another", () => {
    // Nothing about the old issue says what the new one holds.
    const item = story({ jiraKey: "KAN-1" });
    clearJiraPullPending(handle.db, item.id, "KAN-1");

    linkJiraKey(handle.db, item.id, "KAN-2");

    expect(isJiraPullPending(handle.db, item.id)).toBe(true);
  });

  it("marks nothing when the item is relinked to the key it already holds", () => {
    // A form resubmitted unchanged writes nothing, so it asks for
    // nothing either.
    const item = story();
    linkJiraKey(handle.db, item.id, "KAN-123");
    clearJiraPullPending(handle.db, item.id, "KAN-123");

    linkJiraKey(handle.db, item.id, "KAN-123");

    expect(isJiraPullPending(handle.db, item.id)).toBe(false);
  });

  it("clears the marker when the key is cleared", () => {
    // A pull outstanding against an issue this item no longer mirrors
    // would read the issue it was just detached from.
    const item = story();
    linkJiraKey(handle.db, item.id, "KAN-123");

    linkJiraKey(handle.db, item.id, null);

    expect(isJiraPullPending(handle.db, item.id)).toBe(false);
  });

  it("marks nothing when a key is attached to an item whose sync is off", () => {
    // The point of the switch: attaching with sync off pulls nothing.
    const item = story({ jiraSync: false });

    linkJiraKey(handle.db, item.id, "KAN-123");

    expect(jiraStateOf(getItem(handle.db, item.id)!).key).toBe("KAN-123");
    expect(isJiraPullPending(handle.db, item.id)).toBe(false);
  });

  it("asks for the backlog when sync is switched on over a key", () => {
    // An item that sat off for a week missed everything written on its
    // issue, and no sweep will find it: `pullProject` asks Jira what
    // moved recently, not what this item missed.
    const item = story({ jiraKey: "KAN-123", jiraSync: false });

    setJiraSync(handle.db, item.id, true);

    expect(isJiraPullPending(handle.db, item.id)).toBe(true);
  });

  it("clears the marker when sync is switched off", () => {
    const item = story();
    linkJiraKey(handle.db, item.id, "KAN-123");

    setJiraSync(handle.db, item.id, false);

    expect(isJiraPullPending(handle.db, item.id)).toBe(false);
  });

  it("asks for nothing when sync is switched on over an item holding no key", () => {
    const item = story({ jiraSync: false });

    setJiraSync(handle.db, item.id, true);

    expect(isJiraPullPending(handle.db, item.id)).toBe(false);
  });

  it("marks an item created already attached, which is what the submit paths do", () => {
    // `work_submit_ticket` and `work_submit_plan` create the item with
    // its key rather than linking afterwards, and a key sent that way
    // must not read its issue any less than the same key sent to
    // `ticket_update` a second later.
    expect(isJiraPullPending(handle.db, story({ jiraKey: "KAN-123" }).id)).toBe(true);
    expect(isJiraPullPending(handle.db, story({ jiraKey: "KAN-124", jiraSync: false }).id)).toBe(false);
    expect(isJiraPullPending(handle.db, story().id)).toBe(false);
  });

  it("leaves a key written through updateItem unmarked, because EO created that issue", () => {
    // `jira/push.ts` records the key of an issue EO has just created.
    // There is nothing on the far side to read back that EO did not
    // itself send a moment ago.
    const item = story();

    updateItem(handle.db, item.id, { jiraKey: "KAN-123", jiraId: "10001" });

    expect(isJiraPullPending(handle.db, item.id)).toBe(false);
  });

  it("lists what is waiting, oldest first, and says when nothing is", () => {
    expect(listJiraPullPending(handle.db)).toEqual([]);
    expect(hasJiraPullPending(handle.db)).toBe(false);

    const first = story({ jiraKey: "KAN-1" });
    const second = story({ jiraKey: "KAN-2" });

    expect(listJiraPullPending(handle.db).map((entry) => entry.id)).toEqual([first.id, second.id]);
    expect(hasJiraPullPending(handle.db)).toBe(true);

    clearJiraPullPending(handle.db, first.id, "KAN-1");

    expect(listJiraPullPending(handle.db).map((entry) => entry.id)).toEqual([second.id]);
  });

  it("clears nothing when the item has moved on to another issue (EO-127)", () => {
    // The race the marker exists to survive: a pull of KAN-1 finishes
    // after somebody relinked the item to KAN-2, and the marker it
    // finds is KAN-2's, set and never yet acted on. Clearing it would
    // strand KAN-2 — the ordinary sweep only sees issues that moved, and
    // a freshly attached one has not.
    const item = story({ jiraKey: "KAN-1" });
    linkJiraKey(handle.db, item.id, "KAN-2");

    clearJiraPullPending(handle.db, item.id, "KAN-1");

    expect(isJiraPullPending(handle.db, item.id)).toBe(true);
  });

  it("lists an archived item that is still waiting", () => {
    // An archived item still holds its key and is still pulled, so one
    // attached and then archived must not keep a marker nothing clears.
    const item = story({ jiraKey: "KAN-1" });
    setItemArchived(handle.db, item.id, Date.now());

    expect(listJiraPullPending(handle.db).map((entry) => entry.id)).toEqual([item.id]);
  });
});

/**
 * KAN-148: the item row holds what every item has, and the pack's state
 * is a row of its own.
 *
 * The behaviour the rest of this file reads through the accessor,
 * checked here at the table it actually lives in — because "a row exists
 * only when there is something to say" is what the accessor's defaults
 * rest on, and nothing else would notice it being broken until an
 * installation had one `item_extensions` row per item saying nothing.
 */
describe("an item's pack state", () => {
  let handle: DbHandle;
  let workspaceId: Uuid;

  beforeEach(() => {
    handle = openMigratedTestDb();
    workspaceId = attachWorkspace(handle.db, { name: "app", keyPrefix: "APP", repoPath: "/tmp/app" }).id;
  });

  afterEach(() => {
    handle.close();
  });

  function story(overrides: Partial<Parameters<typeof createTestItem>[1]> = {}) {
    return createTestItem(handle.db, { type: "story", title: "Rate limiting", stepId: "todo", workspaceId, ...overrides });
  }

  const extensionRows = (itemId: Uuid): { extension: string }[] =>
    handle.db.all<{ extension: string }>(sql`SELECT extension FROM item_extensions WHERE item_id = ${itemId}`);

  it("writes no row for an item Jira has never heard of", () => {
    const item = story();

    expect(extensionRows(item.id)).toEqual([]);
    expect(item.extensions).toEqual({});
    // And the absent row reads as the column defaults, which is the
    // whole bargain.
    expect(jiraStateOf(item)).toEqual({ key: null, id: null, sync: true, pullPending: false });
  });

  it("writes one row for an item that has something to say, and reads it back onto the item", () => {
    const item = story({ jiraKey: "KAN-7" });

    expect(extensionRows(item.id)).toEqual([{ extension: "jira" }]);
    expect(getItem(handle.db, item.id)?.extensions).toEqual({ jira: { key: "KAN-7", id: null, sync: true, pullPending: true } });
  });

  it("takes the row away again when the item goes back to saying nothing", () => {
    // Detaching a syncing item leaves no key, no id, no marker and the
    // switch where it was — which is the default state, and a stored
    // payload asserting it would be a second spelling of "no row".
    const item = story({ jiraKey: "KAN-7" });
    clearJiraPullPending(handle.db, item.id, "KAN-7");

    linkJiraKey(handle.db, item.id, null);

    expect(extensionRows(item.id)).toEqual([]);
  });

  it("keeps the row when all that is left is the switch", () => {
    // Somebody who silenced an item and then detached it has not asked
    // for it to start talking again.
    const item = story({ jiraKey: "KAN-7", jiraSync: false });

    linkJiraKey(handle.db, item.id, null);

    expect(extensionRows(item.id)).toEqual([{ extension: "jira" }]);
    expect(jiraStateOf(getItem(handle.db, item.id)!)).toEqual({ key: null, id: null, sync: false, pullPending: false });
  });

  it("goes with the item when the item is deleted", () => {
    // By the foreign key rather than by a line in `deleteItem`: a link
    // to a pack's state on an item that is gone is not a record of
    // anything.
    const item = story({ jiraKey: "KAN-7" });

    deleteItem(handle.db, item.id);

    expect(handle.db.all(sql`SELECT * FROM item_extensions`)).toEqual([]);
  });

  it("lists an item's extensions in one statement", () => {
    // The list reads are one extra query for the page, not one per item.
    const first = story({ jiraKey: "KAN-1" });
    const second = story();

    const listed = listItems(handle.db, workspaceId);

    expect(listed.find((entry) => entry.id === first.id)?.extensions).toMatchObject({ jira: { key: "KAN-1" } });
    expect(listed.find((entry) => entry.id === second.id)?.extensions).toEqual({});
  });
});

/**
 * The branch and the pull request, as the git workspace's state on an
 * item (KAN-169, `ARCHITECTURE.md`, "One work entity").
 *
 * The same bargain the `jira` slot above strikes, and these check the
 * three halves of it that only the repo can prove: a row exists exactly
 * when there is something to say, a patch naming one field leaves the
 * other where it was, and a row that goes back to saying nothing is
 * removed rather than stored as a payload asserting silence.
 */
describe("an item's git state", () => {
  let handle: DbHandle;
  let workspaceId: Uuid;

  beforeEach(() => {
    handle = openMigratedTestDb();
    workspaceId = attachWorkspace(handle.db, { name: "app", keyPrefix: "APP", repoPath: "/tmp/app" }).id;
  });

  afterEach(() => {
    handle.close();
  });

  function story(overrides: Partial<Parameters<typeof createTestItem>[1]> = {}) {
    return createTestItem(handle.db, { type: "story", title: "Rate limiting", stepId: "todo", workspaceId, ...overrides });
  }

  const gitRows = (itemId: Uuid): unknown[] => handle.db.all(sql`SELECT * FROM item_extensions WHERE item_id = ${itemId} AND extension = 'git'`);

  it("writes no row for an item nothing has cut a branch for", () => {
    // Which is every item at the moment it is created, and every item
    // on a workspace kind that cuts no branch at all (ARCHITECTURE.md, "The four kinds").
    const item = story();

    expect(gitRows(item.id)).toEqual([]);
    expect(gitStateOf(item)).toEqual({ branch: null, pullRequest: null, baseBranch: null, namedBranch: false, attachedAt: null, reference: null });
  });

  it("records a branch a dispatch cut, and reads it back onto the item", () => {
    const item = story();

    updateItem(handle.db, item.id, { git: { branch: "eo/APP-1" } });

    expect(gitRows(item.id)).toHaveLength(1);
    expect(gitStateOf(getItem(handle.db, item.id)!)).toEqual({ branch: "eo/APP-1", pullRequest: null, baseBranch: null, namedBranch: false, attachedAt: null, reference: null });
  });

  it("leaves the branch where it was when only the pull request is patched", () => {
    // The two writers each know one field — the dispatch cuts the
    // branch, `open_pull_request` learns the URL — so a patch of one
    // that cleared the other would lose whichever happened first.
    const item = story({ git: { branch: "eo/APP-1" } });

    updateItem(handle.db, item.id, { git: { pullRequest: "https://github.com/acme/app/pull/3" } });

    expect(gitStateOf(getItem(handle.db, item.id)!)).toEqual({ branch: "eo/APP-1", pullRequest: "https://github.com/acme/app/pull/3", baseBranch: null, namedBranch: false, attachedAt: null, reference: null });
  });

  it("takes the row away again when the item goes back to saying nothing", () => {
    const item = story({ git: { branch: "eo/APP-1" } });

    updateItem(handle.db, item.id, { git: { branch: null } });

    expect(gitRows(item.id)).toEqual([]);
    expect(gitStateOf(getItem(handle.db, item.id)!)).toEqual({ branch: null, pullRequest: null, baseBranch: null, namedBranch: false, attachedAt: null, reference: null });
  });

  it("keeps a pack's state and a workspace kind's state side by side", () => {
    // The point of the mechanism: two extensions on one item, neither
    // needing to know the other exists.
    const item = story({ jiraKey: "KAN-7", git: { branch: "eo/APP-1" } });

    const read = getItem(handle.db, item.id)!;
    expect(jiraStateOf(read).key).toBe("KAN-7");
    expect(gitStateOf(read).branch).toBe("eo/APP-1");
  });
});
