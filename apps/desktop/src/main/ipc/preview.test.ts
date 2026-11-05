import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Agent, Item, Uuid } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import { createRun, listAgents, needsAttention, postComment, setItemArchived, updateRun } from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { formatDateKey } from "../dateUtils.js";
import { createInboxNotifier } from "../notifications.js";
import { getDailyCost, getItemCost } from "./costHandlers.js";
import { listArchivedSummaries, listInbox, listItemSummaries } from "./domainQueries.js";

/**
 * A preview, excluded everywhere (EO-313, ARCHITECTURE.md, "Preview").
 *
 * The bug this closes is not a crash. It is that a preview looked
 * exactly like work: it landed on the human step, put a number on the
 * inbox badge, added to the day's spend, and showed a green tick beside
 * "post to Slack" that a non-developer reads as posted. `runs.dryRun`
 * could not carry any of that — it marks one run, and a preview is a
 * whole item walking a whole pipeline.
 *
 * So these are tests over the *queries*, one per exclusion the story
 * names, because each of them is a separate place the mark has to be
 * read and any one of them left out is a preview reading as real on the
 * screen somebody happened to be looking at.
 *
 * The one thing a preview is deliberately not excluded from is the
 * board and the scheduler. A preview nothing dispatched and nobody could
 * see would show no one anything.
 */

let handle: DbHandle;
let implementer: Agent;

/** A preview and a piece of real work, side by side — every test below is a comparison. */
function preview(title = "Weekly report"): Item {
  return createTestItem(handle.db, { type: "story", title, stepId: "todo", previewAt: Date.now() });
}

function real(title = "Rate limit the API"): Item {
  return createTestItem(handle.db, { type: "story", title, stepId: "todo" });
}

/** An agent asking the person something — one inbox row, and one `!`. */
function ask(itemId: Uuid): void {
  postComment(handle.db, {
    itemId,
    author: { type: "agent", agentId: implementer.id },
    body: "@user 429 or 503?",
    mentions: [{ type: "human" }],
    kind: "escalation",
  });
}

/** The same, with the item's run parked — which is what makes a row blocking, and what notifies. */
function parked(itemId: Uuid): void {
  const run = createRun(handle.db, { itemId, agentId: implementer.id, action: "implement", threadId: "t" });
  updateRun(handle.db, run.id, { status: "awaiting_input" });
  ask(itemId);
}

function costedRun(itemId: Uuid, costCents: number): void {
  const run = createRun(handle.db, { itemId, agentId: implementer.id, action: "implement", status: "succeeded" });
  updateRun(handle.db, run.id, { costCents, startedAt: Date.now(), endedAt: Date.now() });
}

beforeEach(() => {
  handle = openMigratedTestDb();
  implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
});

afterEach(() => {
  handle.close();
});

describe("the inbox", () => {
  it("does not count a preview's open mentions", () => {
    ask(real().id);
    ask(preview().id);

    // Two rows, one item waiting on anybody. The badge is EO deciding
    // whether to interrupt somebody, and a preview has no claim on that.
    expect(listInbox(handle.db, null).summary.openCount).toBe(1);
  });

  it("does not count a preview as blocking, and does not let one answer \"everything is blocked\"", () => {
    const parked = preview();
    ask(parked.id);
    const run = createRun(handle.db, { itemId: parked.id, agentId: implementer.id, action: "implement", status: "awaiting_input" });
    expect(run.status).toBe("awaiting_input");

    const summary = listInbox(handle.db, null).summary;
    expect(summary.blockingCount).toBe(0);
    // A preview parked on a question would otherwise have said "yes" to
    // "is the whole pipeline stuck?" for as long as it sat there.
    expect(summary.everythingBlocked).toBe(false);
  });

  /**
   * The counterpart, and the reason the exclusion is over the counts
   * rather than over the list: a preview that reaches a human step is
   * waiting on somebody to press a button, and a row nobody can see is
   * a preview that stops walking.
   */
  it("still lists the preview's rows, marked, so the preview can be answered", () => {
    ask(preview().id);

    const rows = listInbox(handle.db, null).items;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.preview).toBe(true);
  });
});

describe("the notification", () => {
  /**
   * The badge already leaves a preview out, and a toast is the louder
   * half of the same interruption. Nothing may knock on somebody's
   * screen about an item EO has just told them is not real.
   */
  it("does not interrupt anybody over a preview, and still does over real work", () => {
    const notified: string[] = [];
    const notifier = createInboxNotifier(handle.db, { notify: (row) => void notified.push(row.itemId), setBadge: () => {} });

    // The first pass records what already exists rather than announcing
    // it, so everything below is a mention that arrived while EO was up.
    notifier.refresh();

    const rehearsal = preview();
    const work = real();
    parked(rehearsal.id);
    parked(work.id);
    notifier.refresh();

    expect(notified).toEqual([work.id]);
  });
});

describe("the archive", () => {
  it("never shows a preview, however it came to be archived", () => {
    const put = real();
    const rehearsal = preview();
    setItemArchived(handle.db, put.id, Date.now());
    setItemArchived(handle.db, rehearsal.id, Date.now());

    expect(listArchivedSummaries(handle.db, null).items.map((row) => row.key)).toEqual([put.key]);
  });
});

describe("the daily cost", () => {
  it("leaves a preview's runs out of the day's total", () => {
    costedRun(real().id, 250);
    costedRun(preview().id, 900);

    expect(getDailyCost(handle.db, { date: formatDateKey(Date.now()) }).costCents).toBe(250);
  });

  it("is nought on a day that was nothing but previews", () => {
    costedRun(preview().id, 900);

    expect(getDailyCost(handle.db, { date: formatDateKey(Date.now()) }).costCents).toBe(0);
  });
});

/**
 * The other cost question, and the one a person is most likely to ask
 * *of a preview specifically* — it is the number on the item they are
 * watching, two inches from the banner saying nothing cost money.
 *
 * The day's total above is cross-item and a preview is a small part of
 * it; this one is the preview and nothing else, so a figure here is the
 * banner contradicted rather than merely inflated.
 */
describe("the cost of one item", () => {
  it("is nought for a preview, whatever its runs recorded", () => {
    const rehearsal = preview();
    costedRun(rehearsal.id, 900);
    costedRun(rehearsal.id, 250);

    expect(getItemCost(handle.db, { itemId: rehearsal.id })).toEqual({ itemId: rehearsal.id, costCents: 0, sideCalls: [] });
  });

  it("is untouched for real work", () => {
    const work = real();
    costedRun(work.id, 250);
    costedRun(preview().id, 900);

    expect(getItemCost(handle.db, { itemId: work.id })).toEqual({ itemId: work.id, costCents: 250, sideCalls: [] });
  });
});

describe("the ! marker", () => {
  it("is never raised on a preview", () => {
    const rehearsal = preview();
    const work = real();
    ask(rehearsal.id);
    ask(work.id);

    expect(needsAttention(handle.db, work.id)).toBe(true);
    expect(needsAttention(handle.db, rehearsal.id)).toBe(false);
  });
});

describe("the board", () => {
  /**
   * The exclusion stops at the surfaces that count things. A preview
   * belongs on the board — that is where it is watched — and the mark
   * travels with it so the card can wear its banner.
   */
  it("shows a preview like anything else, marked", () => {
    const rehearsal = preview();
    real();

    const byKey = new Map(listItemSummaries(handle.db, null).items.map((row) => [row.key, row]));
    expect(byKey.size).toBe(2);
    expect(byKey.get(rehearsal.key)?.preview).toBe(true);
    expect([...byKey.values()].filter((row) => row.preview)).toHaveLength(1);
  });
});
