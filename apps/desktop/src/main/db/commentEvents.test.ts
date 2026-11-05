import type { Comment, Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "./client.js";
import { notifyCommentPosted, onCommentPosted, onCommentsRemoved } from "./commentEvents.js";
import { deleteComment, listCommentsForItem, postComment } from "./repos/index.js";
import { createTestItem, openMigratedTestDb } from "./testHelpers.js";

/**
 * The seam that lets a comment reach the UI.
 *
 * Every writer goes through `postComment`, so one subscription covers
 * the supervisor, the six roles, the Jira import, the outbox and the
 * archive sweep — rather than an announcement hand-placed at each, which
 * is what left the thread frozen in the first place.
 */
let handle: DbHandle;

beforeEach(() => {
  handle = openMigratedTestDb();
});

afterEach(() => {
  handle.close();
});

function comment(overrides: Partial<Comment> = {}): Comment {
  return {
    id: "c1" as Uuid,
    itemId: "t1" as Uuid,
    authorType: "agent",
    authorId: null,
    runId: null,
    parentId: null,
    body: "Working on it.",
    kind: "note",
    options: null,
    pinned: false,
    jiraCommentId: null,
    createdAt: 1,
    ...overrides,
  };
}

describe("comment events", () => {
  it("tells a subscriber what was written", () => {
    const heard: string[] = [];
    onCommentPosted(handle.db, (entry) => void heard.push(entry.body));

    notifyCommentPosted(handle.db, comment({ body: "Done." }));

    expect(heard).toEqual(["Done."]);
  });

  it("stops when the subscriber lets go", () => {
    const heard: string[] = [];
    const stop = onCommentPosted(handle.db, (entry) => void heard.push(entry.body));

    stop();
    notifyCommentPosted(handle.db, comment());

    expect(heard).toEqual([]);
  });

  it("keeps one database's listeners away from another's", () => {
    // The reason this is keyed on the Db rather than being a module
    // global: tests share a process, and one test's in-memory database
    // firing another's listeners would be a genuinely confusing failure.
    const other = openMigratedTestDb();
    const heard: string[] = [];
    onCommentPosted(handle.db, (entry) => void heard.push(entry.body));

    notifyCommentPosted(other.db, comment({ body: "Not yours." }));

    expect(heard).toEqual([]);
    other.close();
  });

  it("carries on when a listener throws", () => {
    // Telling the UI about a comment must never take down the thing
    // that wrote it.
    const heard: string[] = [];
    onCommentPosted(handle.db, () => {
      throw new Error("listener is broken");
    });
    onCommentPosted(handle.db, (entry) => void heard.push(entry.body));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => notifyCommentPosted(handle.db, comment({ body: "Still delivered." }))).not.toThrow();

    expect(heard).toEqual(["Still delivered."]);
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it("fires only once the comment can be read back", () => {
    // Announcing mid-transaction would send the UI to fetch something
    // that is not there yet, which looks exactly like the staleness this
    // whole change is fixing.
    const item = createTestItem(handle.db, { type: "story", title: "Rate limiting", stepId: "todo" });
    let visibleAtNotifyTime: string[] = [];
    onCommentPosted(handle.db, () => {
      visibleAtNotifyTime = listCommentsForItem(handle.db, item.id).map((entry) => entry.body);
    });

    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Cap it at 100." });

    expect(visibleAtNotifyTime).toEqual(["Cap it at 100."]);
  });

  it("reaches a subscriber for every kind of writer, not just the supervisor", () => {
    // The point of putting the seam in postComment: an engine note, an
    // agent's, and a human's all arrive the same way.
    const item = createTestItem(handle.db, { type: "story", title: "Rate limiting", stepId: "todo" });
    const heard: string[] = [];
    onCommentPosted(handle.db, (entry) => void heard.push(entry.authorType));

    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "One." });
    postComment(handle.db, { itemId: item.id, author: { type: "engine" }, body: "Two." });

    expect(heard).toEqual(["human", "engine"]);
  });
});

describe("comment removal events", () => {
  it("names the item whose thread just lost something", () => {
    // `!`, the inbox and the dock badge all derive from mentions a
    // deleted comment may have carried or answered, so a removal makes
    // them exactly as stale as a new comment does.
    const item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo" });
    const written = postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "delete me" });

    const heard: string[] = [];
    onCommentsRemoved(handle.db, (itemId) => void heard.push(itemId));

    deleteComment(handle.db, written.id);

    expect(heard).toEqual([item.id]);
  });

  it("says nothing when there was nothing to delete", () => {
    const heard: string[] = [];
    onCommentsRemoved(handle.db, (itemId) => void heard.push(itemId));

    deleteComment(handle.db, "no-such-comment" as Uuid);

    expect(heard).toEqual([]);
  });

  it("fires only once the comment is really gone", () => {
    const item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo" });
    const written = postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "delete me" });

    let visibleWhenHeard: number | null = null;
    onCommentsRemoved(handle.db, () => {
      visibleWhenHeard = listCommentsForItem(handle.db, item.id).length;
    });

    deleteComment(handle.db, written.id);

    expect(visibleWhenHeard).toBe(0); // not announced from inside the transaction
  });

  it("carries on when a listener throws", () => {
    const item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo" });
    const written = postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "delete me" });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    onCommentsRemoved(handle.db, () => {
      throw new Error("no");
    });

    expect(() => deleteComment(handle.db, written.id)).not.toThrow();
    expect(listCommentsForItem(handle.db, item.id)).toEqual([]);
    spy.mockRestore();
  });
});
