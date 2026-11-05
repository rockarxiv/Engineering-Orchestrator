import { ITEM_COMMENTS_PAGE, ipcContract, type Item, type Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { createStep, deleteItem, listAgents, postComment, postOutputComment } from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { getEarlierItemComments, getItemDetail, getItemSections } from "./domainQueries.js";

/**
 * The item page's thread, a page at a time (EO-559): `items:get` carries
 * the newest `ITEM_COMMENTS_PAGE` comments and how many came before
 * them, and `items:earlierComments` reads back the rest on demand.
 */

let handle: DbHandle;
let item: Item;
const T0 = 1_760_000_000_000;

beforeEach(() => {
  handle = openMigratedTestDb();
  item = createTestItem(handle.db, { type: "story", title: "Rate limit the import", stepId: "todo" });
});

afterEach(() => {
  handle.close();
});

/** A thread of `count` comments, one a second unless `sameMoment` stamps them all alike. */
function thread(count: number, on: Item = item, sameMoment = false) {
  return Array.from({ length: count }, (_, n) =>
    postComment(handle.db, { itemId: on.id, author: { type: "human" }, body: `comment ${n}`, createdAt: sameMoment ? T0 : T0 + n * 1_000 }),
  );
}

/** Every statement the database is asked to prepare while `read` runs (the seam itemSections.test.ts watches). */
function statementsDuring(read: () => void): string[] {
  const client = (handle.db as unknown as { $client: { prepare: (source: string) => unknown } }).$client;
  const prepare = client.prepare.bind(client);
  const seen: string[] = [];
  client.prepare = (source: string) => {
    seen.push(source);
    return prepare(source);
  };
  try {
    read();
  } finally {
    client.prepare = prepare;
  }
  return seen;
}

describe("items:get", () => {
  it("carries the whole of a thread that fits on one page, and says nothing came before it", () => {
    thread(3);

    const detail = getItemDetail(handle.db, { itemId: item.id })!;
    expect(detail.comments.map((comment) => comment.body)).toEqual(["comment 0", "comment 1", "comment 2"]);
    expect(detail.earlierComments).toBe(0);
  });

  it("carries the newest page of a longer thread, oldest first, and the count of earlier ones", () => {
    thread(ITEM_COMMENTS_PAGE + 25);

    const detail = ipcContract["items:get"].response.parse(getItemDetail(handle.db, { itemId: item.id }))!;
    expect(detail.comments).toHaveLength(ITEM_COMMENTS_PAGE);
    expect(detail.comments[0]?.body).toBe("comment 25");
    expect(detail.comments.at(-1)?.body).toBe(`comment ${ITEM_COMMENTS_PAGE + 24}`);
    // Survives the contract's parse: the renderer is told, not left to guess.
    expect(detail.earlierComments).toBe(25);
  });

  it("asks the database for a page of the thread, not all of it", () => {
    thread(ITEM_COMMENTS_PAGE + 5);

    const statements = statementsDuring(() => getItemDetail(handle.db, { itemId: item.id }));
    const threadReads = statements.filter((source) => /from "comments" left join "jira_comment_links"/.test(source));
    expect(threadReads.length).toBeGreaterThan(0);
    for (const source of threadReads) expect(source).toMatch(/limit \?/);
  });

  it("still lifts an output that is older than the page above the thread", () => {
    createStep(handle.db, {
      id: "approval",
      pipelineId: "default" as Uuid,
      position: 21,
      name: "Approval",
      type: "user",
      results: [{ key: "approved", label: "Approve", tone: "success", requiresComment: false }],
    });
    const onApproval = createTestItem(handle.db, { type: "story", title: "Q3 post", stepId: "approval" });
    const agentId = listAgents(handle.db).find((agent) => agent.role === "implementer")!.id;
    const output = postOutputComment(handle.db, { itemId: onApproval.id, author: { type: "agent", agentId }, body: "The draft", createdAt: T0 - 1_000 });
    thread(ITEM_COMMENTS_PAGE, onApproval);

    const detail = getItemDetail(handle.db, { itemId: onApproval.id })!;
    expect(detail.comments.some((comment) => comment.id === output.id)).toBe(false);
    expect(detail.earlierComments).toBe(1);
    expect(detail.currentOutput).toMatchObject({ commentId: output.id, body: "The draft" });
    expect(detail.currentOutput).toEqual(getItemSections(handle.db, { itemId: onApproval.id })!.currentOutput);
  });
});

describe("items:get held at a start (from)", () => {
  it("carries that comment and every one after it, however many have come since", () => {
    const posted = thread(ITEM_COMMENTS_PAGE + 25);
    const anchor = posted[25]!;
    // Thirty more arrive: unheld, the page would slide past the anchor.
    for (let n = 0; n < 30; n++) postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: `later ${n}`, createdAt: T0 + 1_000_000 + n });

    const held = ipcContract["items:get"].response.parse(getItemDetail(handle.db, ipcContract["items:get"].request.parse({ itemId: item.id, from: anchor.id })))!;
    expect(held.comments[0]?.id).toBe(anchor.id);
    expect(held.comments).toHaveLength(ITEM_COMMENTS_PAGE + 30);
    expect(held.comments.at(-1)?.body).toBe("later 29");
    expect(held.earlierComments).toBe(25);

    const unheld = getItemDetail(handle.db, { itemId: item.id })!;
    expect(unheld.comments[0]?.body).toBe("comment 55");
  });

  it("holds by the thread's order where comments share a millisecond", () => {
    const posted = thread(10, item, true);
    const whole = getItemSections(handle.db, { itemId: item.id })!.comments!;
    const anchor = whole[4]!;

    const held = getItemDetail(handle.db, { itemId: item.id, from: anchor.id })!;
    expect(held.comments.map((comment) => comment.id)).toEqual(whole.slice(4).map((comment) => comment.id));
    expect(held.earlierComments).toBe(4);
    expect(posted).toHaveLength(10);
  });

  it("answers the newest page where the start it was held at is gone, so the caller can tell", () => {
    const posted = thread(ITEM_COMMENTS_PAGE + 5);
    const other = createTestItem(handle.db, { type: "story", title: "Elsewhere", stepId: "todo" });
    const [elsewhere] = thread(1, other);

    for (const from of ["no-such-comment", elsewhere!.id]) {
      const answer = getItemDetail(handle.db, { itemId: item.id, from })!;
      expect(answer.comments).toHaveLength(ITEM_COMMENTS_PAGE);
      expect(answer.comments[0]?.id).toBe(posted[5]!.id);
      expect(answer.earlierComments).toBe(5);
    }
  });
});

describe("items:earlierComments", () => {
  it("reads back the whole thread a page at a time, with no comment missed or repeated", () => {
    const total = ITEM_COMMENTS_PAGE * 2 + 30;
    thread(total);

    const first = getItemDetail(handle.db, { itemId: item.id })!;
    const pages = [first.comments];
    let earlier = first.earlierComments;
    const counts = [earlier];
    while (earlier > 0) {
      const before = pages[0]![0]!.id;
      const page = ipcContract["items:earlierComments"].response.parse(
        getEarlierItemComments(handle.db, ipcContract["items:earlierComments"].request.parse({ itemId: item.id, before })),
      );
      pages.unshift(page.comments);
      earlier = page.earlier;
      counts.push(earlier);
    }

    expect(pages.map((page) => page.length)).toEqual([30, ITEM_COMMENTS_PAGE, ITEM_COMMENTS_PAGE]);
    expect(counts).toEqual([ITEM_COMMENTS_PAGE + 30, 30, 0]);
    expect(pages.flat().map((comment) => comment.body)).toEqual(Array.from({ length: total }, (_, n) => `comment ${n}`));
    // Drawn exactly as the whole read draws them.
    expect(pages.flat()).toEqual(getItemSections(handle.db, { itemId: item.id })!.comments);
  });

  it("pages by the thread's own order where comments share a millisecond", () => {
    thread(ITEM_COMMENTS_PAGE + 7, item, true);

    const first = getItemDetail(handle.db, { itemId: item.id })!;
    const page = getEarlierItemComments(handle.db, { itemId: item.id, before: first.comments[0]!.id, limit: ITEM_COMMENTS_PAGE });
    const whole = getItemSections(handle.db, { itemId: item.id })!.comments!;
    expect([...page.comments, ...first.comments].map((comment) => comment.id)).toEqual(whole.map((comment) => comment.id));
    expect(page.earlier).toBe(0);
  });

  it("honours a smaller limit", () => {
    thread(10);
    const whole = getItemSections(handle.db, { itemId: item.id })!.comments!;

    const page = getEarlierItemComments(handle.db, { itemId: item.id, before: whole[8]!.id, limit: 3 });
    expect(page.comments.map((comment) => comment.body)).toEqual(["comment 5", "comment 6", "comment 7"]);
    expect(page.earlier).toBe(5);
  });

  it("answers an empty page for a comment the thread does not hold, and for an item that is gone", () => {
    thread(3);
    const other = createTestItem(handle.db, { type: "story", title: "Elsewhere", stepId: "todo" });
    const [elsewhere] = thread(2, other);

    expect(getEarlierItemComments(handle.db, { itemId: item.id, before: elsewhere!.id, limit: 50 })).toEqual({ comments: [], earlier: 0 });
    expect(getEarlierItemComments(handle.db, { itemId: item.id, before: "no-such-comment", limit: 50 })).toEqual({ comments: [], earlier: 0 });

    deleteItem(handle.db, other.id);
    expect(getEarlierItemComments(handle.db, { itemId: other.id, before: elsewhere!.id, limit: 50 })).toEqual({ comments: [], earlier: 0 });
  });

  it("refuses a limit that is not a positive whole number of at most 500", () => {
    const request = ipcContract["items:earlierComments"].request;
    expect(request.parse({ itemId: item.id, before: "x" }).limit).toBe(ITEM_COMMENTS_PAGE);
    expect(request.safeParse({ itemId: item.id, before: "x", limit: 0 }).success).toBe(false);
    expect(request.safeParse({ itemId: item.id, before: "x", limit: 501 }).success).toBe(false);
    expect(request.safeParse({ itemId: item.id, before: "x", limit: 1.5 }).success).toBe(false);
  });
});
