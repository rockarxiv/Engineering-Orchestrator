import { ITEM_COMMENTS_PAGE, ITEM_SECTIONS, ItemDetailSchema, ipcContract, type Item, type ItemDetail, type Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { addDependency, createRun, createStep, listAgents, postComment, postOutputComment, transitionItem, updateRun } from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { getItemDetail, getItemSections, listItemSummaries } from "./domainQueries.js";

/**
 * Reading part of an item rather than all of it (EO-540): the sections a
 * call names, the comments and runs narrowed in the statements that read
 * them, and nothing read for a section left out.
 */

let handle: DbHandle;
let item: Item;
const T0 = 1_760_000_000_000;

beforeEach(() => {
  handle = openMigratedTestDb();
  item = createTestItem(handle.db, { type: "story", title: "Rate limit the import", stepId: "todo", spec: { acceptance_criteria: ["429 after 100 req/min"] } });
});

afterEach(() => {
  handle.close();
});

function implementerId(): Uuid {
  return listAgents(handle.db).find((agent) => agent.role === "implementer")!.id;
}

/** A thread of five, one a minute, the second and fourth pinned. */
function thread(on: Item = item) {
  return [0, 1, 2, 3, 4].map((n) =>
    postComment(handle.db, { itemId: on.id, author: { type: "human" }, body: `comment ${n}`, createdAt: T0 + n * 60_000, pinned: n === 1 || n === 3 }),
  );
}

/** A full item: a thread, three runs, a move and a dependency. */
function busyItem() {
  thread();
  const agentId = implementerId();
  const runs = [0, 1, 2].map(() => createRun(handle.db, { itemId: item.id, agentId, action: "implement" }));
  updateRun(handle.db, runs[0]!.id, { status: "failed", error: "tests failed" });
  transitionItem(handle.db, { itemId: item.id, toStepId: "review", actor: "human", reason: "manual" });
  const dependency = createTestItem(handle.db, { type: "story", title: "First", stepId: "todo" });
  addDependency(handle.db, item.id, dependency.id);
  return { runs, dependency };
}

/** Every statement the database is asked to prepare while `read` runs. */
function statementsDuring(read: () => void): string[] {
  // The connection drizzle prepares every statement on — the same seam
  // itemListFilters.test.ts watches. Nothing above it can see what the
  // database was actually asked.
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

/**
 * The statements that read each section's rows, told apart by what each
 * reads from. Not every mention of a table: the ticket's own
 * `needsAttention` asks whether any comment on it has an open mention of
 * a person, which is a fact about the item (invariant 6) and not a read
 * of its thread. Nor is when it entered its step (EO-570): one `max`
 * over its arrivals, not its history of moves.
 */
const SECTION_READS: Record<string, RegExp> = {
  thread: /from "comments" left join "jira_comment_links"/,
  awaiting: /from "comment_mentions" inner join "comments"/,
  attachments: /from "attachments"/,
  transitions: /from "transitions" where/,
  dependsOn: /from "item_deps"/,
  runs: /from "runs"/,
};
const reads = (statements: string[], section: string) => statements.filter((source) => SECTION_READS[section]!.test(source));

/**
 * The screens' read of the item, without the one thing only the screens
 * are told: how many comments came before their page (EO-559). Equal to
 * the whole item wherever the thread fits on one page.
 */
function detailOf(on: Item = item): ItemDetail {
  const page = getItemDetail(handle.db, { itemId: on.id })!;
  const { earlierComments, ...detail } = page;
  expect(earlierComments).toBe(0);
  return detail;
}

describe("items:getSections with none of the new parameters", () => {
  it("answers what items:get answers while the thread fits on one page", () => {
    busyItem();

    expect(getItemSections(handle.db, { itemId: item.id })).toEqual(detailOf());
    // Through the schemas both answers are parsed by, which is what a
    // dispatched call is handed: the same keys, in the same order.
    const sections = ipcContract["items:getSections"].response.parse(getItemSections(handle.db, { itemId: item.id }));
    const detail = ItemDetailSchema.parse(getItemDetail(handle.db, { itemId: item.id }));
    expect(JSON.stringify(sections)).toBe(JSON.stringify(detail));
  });

  it("answers the whole thread where items:get answers its newest page (EO-559)", () => {
    const total = ITEM_COMMENTS_PAGE + 30;
    for (let n = 0; n < total; n++) postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: `comment ${n}`, createdAt: T0 + n * 1_000 });

    const whole = getItemSections(handle.db, { itemId: item.id })!;
    expect(whole.comments).toHaveLength(total);
    expect(whole).not.toHaveProperty("earlierComments");

    const page = getItemDetail(handle.db, { itemId: item.id })!;
    expect(page.comments).toHaveLength(ITEM_COMMENTS_PAGE);
    expect(page.earlierComments).toBe(30);
    expect(page.comments).toEqual(whole.comments!.slice(30));
  });

  it("still answers null for an item that does not exist", () => {
    expect(getItemSections(handle.db, { itemId: "00000000-0000-0000-0000-000000000000" })).toBeNull();
    expect(getItemSections(handle.db, { itemId: "00000000-0000-0000-0000-000000000000", include: ["ticket"] })).toBeNull();
  });

  it("answers every section the same when all are named", () => {
    busyItem();

    const named = getItemSections(handle.db, { itemId: item.id, include: [...ITEM_SECTIONS] });
    expect(named).toEqual(detailOf());
  });
});

describe("items:getSections with include", () => {
  it("answers only the ticket's fields for include ['ticket']", () => {
    busyItem();

    const answer = getItemSections(handle.db, { itemId: item.id, include: ["ticket"] })!;
    expect(Object.keys(answer).sort()).toEqual(["attachmentSync", "item", "watch"]);
    expect(answer.item).toEqual(getItemDetail(handle.db, { itemId: item.id })!.item);
  });

  it("answers each section on its own, and nothing beside it", () => {
    busyItem();
    const whole = getItemDetail(handle.db, { itemId: item.id })!;

    expect(getItemSections(handle.db, { itemId: item.id, include: ["comments"] })).toEqual({ comments: whole.comments, currentOutput: whole.currentOutput });
    expect(getItemSections(handle.db, { itemId: item.id, include: ["runs"] })).toEqual({ runs: whole.runs });
    expect(getItemSections(handle.db, { itemId: item.id, include: ["transitions"] })).toEqual({ transitions: whole.transitions });
    expect(getItemSections(handle.db, { itemId: item.id, include: ["dependsOn"] })).toEqual({ dependsOn: whole.dependsOn });
    expect(getItemSections(handle.db, { itemId: item.id, include: ["decision"] })).toEqual({ decision: whole.decision });
    expect(getItemSections(handle.db, { itemId: item.id, include: ["runs", "dependsOn"] })).toEqual({ runs: whole.runs, dependsOn: whole.dependsOn });
  });

  it("refuses an empty include and a section that does not exist", () => {
    const request = ipcContract["items:getSections"].request;
    expect(request.safeParse({ itemId: item.id, include: [] }).success).toBe(false);
    expect(request.safeParse({ itemId: item.id, include: ["history"] }).success).toBe(false);
    expect(request.safeParse({ itemId: item.id, commentsLimit: 0 }).success).toBe(false);
    expect(request.safeParse({ itemId: item.id, runsLimit: 1.5 }).success).toBe(false);
  });
});

describe("narrowing the comments and the runs", () => {
  const bodies = (answer: ReturnType<typeof getItemSections>) => answer!.comments!.map((comment) => comment.body);

  it("keeps the newest N comments, in thread order", () => {
    thread();
    expect(bodies(getItemSections(handle.db, { itemId: item.id, commentsLimit: 2 }))).toEqual(["comment 3", "comment 4"]);
    expect(bodies(getItemSections(handle.db, { itemId: item.id, commentsLimit: 50 }))).toHaveLength(5);
  });

  it("keeps the comments posted at or after commentsSince", () => {
    thread();
    expect(bodies(getItemSections(handle.db, { itemId: item.id, commentsSince: T0 + 3 * 60_000 }))).toEqual(["comment 3", "comment 4"]);
    expect(bodies(getItemSections(handle.db, { itemId: item.id, commentsSince: T0 + 10 * 60_000 }))).toEqual([]);
  });

  it("keeps only the pinned comments for pinnedOnly, and every one for pinnedOnly false", () => {
    thread();
    expect(bodies(getItemSections(handle.db, { itemId: item.id, pinnedOnly: true }))).toEqual(["comment 1", "comment 3"]);
    expect(bodies(getItemSections(handle.db, { itemId: item.id, pinnedOnly: false }))).toHaveLength(5);
  });

  it("combines the three", () => {
    thread();
    expect(bodies(getItemSections(handle.db, { itemId: item.id, pinnedOnly: true, commentsLimit: 1 }))).toEqual(["comment 3"]);
    expect(bodies(getItemSections(handle.db, { itemId: item.id, pinnedOnly: true, commentsSince: T0 + 2 * 60_000 }))).toEqual(["comment 3"]);
    expect(bodies(getItemSections(handle.db, { itemId: item.id, commentsSince: T0 + 60_000, commentsLimit: 2 }))).toEqual(["comment 3", "comment 4"]);
  });

  it("keeps the newest N runs, oldest first, and leaves the other sections whole", () => {
    const { runs } = busyItem();
    const whole = getItemDetail(handle.db, { itemId: item.id })!;

    const answer = getItemSections(handle.db, { itemId: item.id, runsLimit: 2 })!;
    expect(answer.runs!.map((run) => run.id)).toEqual([runs[1]!.id, runs[2]!.id]);
    expect(answer.comments).toEqual(whole.comments);
    expect(answer.item).toEqual(whole.item);
  });

  it("still answers the output when the window leaves the comment it is out", () => {
    // The output is lifted above the thread on a step a person decides
    // on (EO-311). A window of the newest comment alone does not hold
    // it, and the panel must not lose its author for that.
    createStep(handle.db, {
      id: "approval",
      pipelineId: "default" as Uuid,
      position: 21,
      name: "Approval",
      type: "user",
      results: [{ key: "approved", label: "Approve", tone: "success", requiresComment: false }],
    });
    const onApproval = createTestItem(handle.db, { type: "story", title: "Q3 post", stepId: "approval" });
    const agentId = implementerId();
    const output = postOutputComment(handle.db, { itemId: onApproval.id, author: { type: "agent", agentId }, body: "The draft", createdAt: T0 });
    postComment(handle.db, { itemId: onApproval.id, author: { type: "human" }, body: "later", createdAt: T0 + 60_000 });

    const whole = getItemDetail(handle.db, { itemId: onApproval.id })!;
    const windowed = getItemSections(handle.db, { itemId: onApproval.id, commentsLimit: 1 })!;
    expect(windowed.comments!.map((comment) => comment.body)).toEqual(["later"]);
    expect(windowed.currentOutput).toEqual(whole.currentOutput);
    expect(windowed.currentOutput).toMatchObject({ commentId: output.id, body: "The draft" });
    expect(windowed.currentOutput?.authorName).not.toBe("EO");
  });
});

describe("the query path", () => {
  /** The reads of a whole run history: every run of an item, with no LIMIT. */
  const runHistories = (statements: string[]) => statements.filter((source) => /from "runs"/.test(source) && !/limit \?/.test(source));
  /** The read of every dependency edge there is, with no WHERE. */
  const everyEdge = (statements: string[]) => statements.filter((source) => /from "item_deps"/.test(source) && !/where/.test(source));

  /** Other work on the same board, each with a run history of its own. */
  function crowdedBoard() {
    const agentId = implementerId();
    for (let n = 0; n < 20; n += 1) {
      const other = createTestItem(handle.db, { type: "story", title: `Other ${n}`, stepId: "todo" });
      for (let r = 0; r < 3; r += 1) createRun(handle.db, { itemId: other.id, agentId, action: "implement" });
    }
  }

  it("reads nothing for a section left out", () => {
    busyItem();
    crowdedBoard();

    const whole = statementsDuring(() => getItemSections(handle.db, { itemId: item.id }));
    const ownOnly = statementsDuring(() => getItemSections(handle.db, { itemId: item.id, include: ["ticket"] }));

    // The whole item reads each of them; the ticket alone reads none.
    for (const section of ["thread", "awaiting", "attachments", "transitions"]) {
      expect(reads(whole, section), section).not.toHaveLength(0);
      expect(reads(ownOnly, section), section).toHaveLength(0);
    }
    // The ticket's own fields name its latest run and count its open
    // dependencies. Each is asked of the database for this item alone —
    // one run, by LIMIT, and this item's edges, by WHERE — and no run
    // history and no table of edges is read to answer them: not this
    // item's, and not the rest of the board's.
    expect(runHistories(ownOnly)).toEqual([]);
    expect(everyEdge(ownOnly)).toEqual([]);
    expect(reads(ownOnly, "runs")).toHaveLength(1);
    expect(reads(ownOnly, "runs")[0]).toMatch(/where "runs"\."item_id" = \? order by coalesce\("runs"\."started_at", 0\) desc, "runs"\."id" desc limit \?/);
    expect(reads(ownOnly, "dependsOn")).toHaveLength(1);
    expect(reads(ownOnly, "dependsOn")[0]).toMatch(/where "item_deps"\."item_id" = \?/);
    // When it entered its step is the one read of `transitions`: its
    // latest arrival, by aggregate, and not the list of its moves.
    expect(ownOnly.filter((source) => /from "transitions"/.test(source))).toHaveLength(1);
    expect(ownOnly.find((source) => /from "transitions"/.test(source))).toMatch(/max\("transitions"\."ts"\)/);
  });

  it("reads no run history for the ticket's fields beside a limited runs section", () => {
    busyItem();
    crowdedBoard();

    const statements = statementsDuring(() => getItemSections(handle.db, { itemId: item.id, include: ["ticket", "runs"], runsLimit: 1 }));

    expect(runHistories(statements)).toEqual([]);
    // The latest run the ticket is named by, and the one the section asked for.
    expect(reads(statements, "runs")).toHaveLength(2);
  });

  it("gives the ticket the summary the board gives it", () => {
    // The fields a card carries, read for one item, are the board's
    // answer for it: the latest run by the same order, ties and
    // not-yet-started runs included, and the same open dependencies.
    const { dependency } = busyItem();
    crowdedBoard();
    const agentId = implementerId();
    const unstarted = createRun(handle.db, { itemId: item.id, agentId, action: "review" });
    updateRun(handle.db, unstarted.id, { status: "queued" });
    const finished = createTestItem(handle.db, { type: "story", title: "Done already", stepId: "todo" });
    transitionItem(handle.db, { itemId: finished.id, toStepId: "ready_to_merge", actor: "human" });
    addDependency(handle.db, item.id, finished.id);
    const feature = createTestItem(handle.db, { type: "feature", title: "Import pipeline", stepId: null });
    createTestItem(handle.db, { type: "story", title: "Under it", stepId: "todo", parentId: feature.id });
    createTestItem(handle.db, { type: "story", title: "Also under it", stepId: "review", parentId: feature.id });

    const board = listItemSummaries(handle.db, null).items;
    for (const one of [item, dependency, finished, feature]) {
      const own = getItemSections(handle.db, { itemId: one.id, include: ["ticket"] })!.item!;
      const card = board.find((entry) => entry.id === one.id)!;
      expect(own, one.title).toMatchObject(card);
      expect(getItemDetail(handle.db, { itemId: one.id })!.item, one.title).toMatchObject(card);
    }
    expect(board.find((entry) => entry.id === item.id)).toMatchObject({ openDependencyCount: 1 });
  });

  it("reads only the comments' tables for include ['comments'], and only the runs table for include ['runs']", () => {
    busyItem();

    const comments = statementsDuring(() => getItemSections(handle.db, { itemId: item.id, include: ["comments"] }));
    expect(reads(comments, "thread")).toHaveLength(1);
    for (const section of ["runs", "transitions", "dependsOn"]) expect(reads(comments, section), section).toHaveLength(0);

    const runs = statementsDuring(() => getItemSections(handle.db, { itemId: item.id, include: ["runs"] }));
    expect(reads(runs, "runs")).toHaveLength(1);
    for (const section of ["thread", "awaiting", "attachments", "transitions", "dependsOn"]) expect(reads(runs, section), section).toHaveLength(0);
  });

  it("narrows the comments and the runs in the statements that read them", () => {
    busyItem();

    const statements = statementsDuring(() =>
      getItemSections(handle.db, { itemId: item.id, include: ["comments", "runs"], commentsLimit: 2, commentsSince: T0, pinnedOnly: true, runsLimit: 1 }),
    );
    const thread = reads(statements, "thread");
    expect(thread).toHaveLength(1);
    expect(thread[0]).toMatch(/"comments"\."created_at" >= \?/);
    expect(thread[0]).toMatch(/"comments"\."pinned" = \?/);
    expect(thread[0]).toMatch(/order by "comments"\."created_at" desc, "comments"\."id" desc limit \?/);
    expect(reads(statements, "runs")).toHaveLength(1);
    expect(reads(statements, "runs")[0]).toMatch(/order by "runs"\."id" desc limit \?/);
  });
});
