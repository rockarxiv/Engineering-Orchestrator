import { ItemDetailSchema, ITEM_COMMENTS_PAGE, type Item } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { createRun, listAgents, postComment, transitionItem } from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { getItemDetail, getItemSections, resolveItemKey } from "../ipc/domainQueries.js";
import { clearHandlerRegistry, registerHandler } from "../ipc/registry.js";
import { toLegacyShape } from "./legacyNames.js";
import { renderItem } from "./render.js";
import { answerToolCall } from "./server.js";

/**
 * `item_get` and `ticket_get` reading part of an item (EO-540), through
 * the same door every client's call comes in by.
 */

let handle: DbHandle;
let item: Item;
const T0 = 1_760_000_000_000;

beforeEach(() => {
  handle = openMigratedTestDb();
  const opts = { exposeErrorDetails: true };
  registerHandler("items:getSections", (payload) => getItemSections(handle.db, payload), opts);
  registerHandler("items:resolveKey", (payload) => resolveItemKey(handle.db, payload), opts);

  item = createTestItem(handle.db, { type: "story", title: "Rate limit the import", stepId: "todo", body: "Use a token bucket.", spec: { acceptance_criteria: ["429 after 100 req/min"] } });
  const agentId = listAgents(handle.db).find((agent) => agent.role === "implementer")!.id;
  for (const n of [0, 1, 2, 3]) {
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: `comment ${n}`, createdAt: T0 + n * 60_000, pinned: n === 2 });
  }
  createRun(handle.db, { itemId: item.id, agentId, action: "implement" });
  createRun(handle.db, { itemId: item.id, agentId, action: "review", status: "running" });
  transitionItem(handle.db, { itemId: item.id, toStepId: "review", actor: "human", reason: "manual" });
});

afterEach(() => {
  clearHandlerRegistry();
  handle.close();
});

function call(name: string, args: Record<string, unknown>) {
  return answerToolCall({ name, arguments: args }, "admin", true);
}

function textOf(result: Awaited<ReturnType<typeof call>>): string {
  const first = result.content[0];
  return first?.type === "text" ? first.text : "";
}

describe("item_get with none of the new parameters", () => {
  it("answers exactly as before, under both names and either id", async () => {
    // What `items:get` put on the wire before item_get had sections: the
    // detail as its schema parses it on the way out. (The screens' read
    // has since been windowed — EO-559 — and also says how many comments
    // came before its page; item_get never said that and does not now.)
    const detail = ItemDetailSchema.parse(getItemDetail(handle.db, { itemId: item.id }));
    for (const [name, args] of [
      ["item_get", { itemId: item.id }],
      ["ticket_get", { ticketId: item.id }],
      ["item_get", { itemId: item.key }],
    ] as const) {
      const result = await call(name, args);
      expect(result.isError, name).toBe(false);
      // The text the old renderer gave for the whole item, and the whole
      // item as data, in the spelling clients registered against.
      expect(textOf(result), name).toBe(renderItem(detail));
      expect(JSON.stringify(result.structuredContent), name).toBe(JSON.stringify(toLegacyShape(detail)));
    }
  });
});

describe("item_get on a thread longer than the screens' page (EO-559)", () => {
  it("still answers the whole thread under both names, though items:get answers its newest page", async () => {
    // Four comments are there already; this makes the thread outgrow
    // the item page's window by a good margin.
    const extra = ITEM_COMMENTS_PAGE + 20;
    for (let n = 0; n < extra; n++) {
      postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: `later ${n}`, createdAt: T0 + 3_600_000 + n * 1_000 });
    }
    const total = 4 + extra;
    const page = getItemDetail(handle.db, { itemId: item.id })!;
    expect(page.comments).toHaveLength(ITEM_COMMENTS_PAGE);
    expect(page.earlierComments).toBe(total - ITEM_COMMENTS_PAGE);

    for (const [name, args] of [
      ["item_get", { itemId: item.id }],
      ["ticket_get", { ticketId: item.id }],
    ] as const) {
      // Asked whole, the answer is over the host's character budget, and
      // the budget — not a window — is what leaves the thread out; it
      // counts every comment, as it always did.
      const whole = await call(name, args);
      expect(whole.isError, name).toBe(false);
      expect(textOf(whole), name).toContain(`\`comments\` (`);
      expect(textOf(whole), name).toContain(`${total} entries`);
      expect(whole.structuredContent, name).not.toHaveProperty("earlierComments");

      // Asked for what fits, every comment comes back, oldest first.
      const result = await call(name, { ...args, fields: ["comments.body"] });
      expect(result.isError, name).toBe(false);
      const data = result.structuredContent as { comments: { body: string }[] };
      expect(data.comments.map((comment) => comment.body), name).toEqual([
        ...[0, 1, 2, 3].map((n) => `comment ${n}`),
        ...Array.from({ length: extra }, (_, n) => `later ${n}`),
      ]);
      expect(data, name).not.toHaveProperty("earlierComments");
    }
  });
});

describe("item_get with include", () => {
  it("returns only the ticket's fields for include ['ticket'], and renders only those", async () => {
    const result = await call("item_get", { itemId: item.id, include: ["ticket"] });

    expect(result.isError).toBe(false);
    const data = result.structuredContent as Record<string, unknown>;
    // `ticket` is `item` in the spelling clients registered against.
    expect(Object.keys(data).sort()).toEqual(["attachmentSync", "ticket", "watch"]);

    const text = textOf(result);
    expect(text.startsWith(`# ${item.key} — Rate limit the import`)).toBe(true);
    expect(text).toContain("## Description");
    expect(text).toContain("429 after 100 req/min");
    for (const absent of ["## Thread", "## Runs", "## Transitions", "## Decision", "## Waits for", "comment 0", "a run is in progress"]) {
      expect(text, absent).not.toContain(absent);
    }
  });

  it("renders only the sections included, starting at the first of them", async () => {
    const result = await call("item_get", { itemId: item.id, include: ["transitions", "decision"] });

    expect(Object.keys(result.structuredContent as Record<string, unknown>).sort()).toEqual(["decision", "transitions"]);
    const text = textOf(result);
    expect(text.startsWith("## Decision")).toBe(true);
    expect(text).toContain("## Transitions");
    expect(text).toMatch(/todo → review, by human — manual/);
    expect(text).not.toContain(item.key);
    expect(text).not.toContain("## Thread");
  });

  it("says so where a section asked for came back empty", async () => {
    const result = await call("item_get", { itemId: item.id, include: ["comments", "dependsOn"], commentsSince: T0 + 3_600_000 });

    expect(result.structuredContent).toMatchObject({ comments: [], dependsOn: [] });
    expect(textOf(result)).toContain("No comments match.");
    expect(textOf(result)).toContain("it waits on no other ticket");
  });

  it("refuses a section EO does not have, in a sentence", async () => {
    const result = await call("item_get", { itemId: item.id, include: ["history"] });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/[A-Z].*\./);
  });
});

describe("item_get with the limits", () => {
  it("narrows the comments in the data and in the text", async () => {
    const result = await call("ticket_get", { ticketId: item.id, include: ["comments"], commentsLimit: 2 });

    const comments = (result.structuredContent as { comments: { body: string }[] }).comments;
    expect(comments.map((comment) => comment.body)).toEqual(["comment 2", "comment 3"]);
    expect(textOf(result)).not.toContain("comment 1");
    expect(textOf(result)).toContain("comment 3");

    const pinned = await call("item_get", { itemId: item.id, pinnedOnly: true });
    expect((pinned.structuredContent as { comments: { body: string }[] }).comments.map((comment) => comment.body)).toEqual(["comment 2"]);
    // Every section still comes back; only the thread was narrowed.
    expect(pinned.structuredContent).toHaveProperty("ticket");
    expect(pinned.structuredContent).toHaveProperty("runs");
  });

  it("narrows the runs to the newest N", async () => {
    const result = await call("item_get", { itemId: item.id, include: ["runs"], runsLimit: 1 });

    const runs = (result.structuredContent as { runs: { action: string }[] }).runs;
    expect(runs.map((run) => run.action)).toEqual(["review"]);
    expect(textOf(result)).toContain("## Runs");
    expect(textOf(result)).not.toContain("implement");
  });
});
