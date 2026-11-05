import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "./db/client.js";
import { createTestItem, openMigratedTestDb } from "./db/testHelpers.js";
import type { Uuid } from "@eo/core";
import {
  clearSetting,
  deleteComment,
  getSetting,
  listCommentsForItem,
  needsAttention,
  setSetting,
  setItemHeld,
} from "./db/repos/index.js";
import { DEFAULT_GUARD_CONFIG, GUARDS_KEY, readGuards } from "./ipc/configCommands.js";
import { ASSIST_STEP } from "./roles/conversationSteps.js";
import { announceDailyBudgetDefault, DAILY_BUDGET_NOTICE_KEY, settleDailyBudgetNotice } from "./guardDefaultNotice.js";

let handle: DbHandle;

beforeEach(() => {
  handle = openMigratedTestDb();
  // Every database the helper makes is one being born, and says so —
  // which is what keeps the rest of the suite quiet. This file is about
  // the other kind: an installation that ran before the default existed.
  // The one test about a fresh install settles it again, explicitly, the
  // way `index.ts` does.
  clearSetting(handle.db, DAILY_BUDGET_NOTICE_KEY);
});

afterEach(() => {
  handle.close();
});

/** Every engine note anywhere in the installation, which is what "once" is counted over. */
function notices(itemIds: Uuid[]): { id: Uuid; body: string }[] {
  return itemIds.flatMap((id) =>
    listCommentsForItem(handle.db, id)
      .filter((comment) => comment.authorType === "engine")
      .map((comment) => ({ id: comment.id, body: comment.body })),
  );
}

/**
 * An installation upgraded into the daily budget (EO-211).
 *
 * A saved config that predates the guard: it has been through the
 * Guardrails screen at some point, and it says nothing about
 * `dailyBudgetCents` — so `readGuards` has just given it a ceiling it
 * did not have yesterday.
 */
function savedWithoutADailyBudget(): void {
  setSetting(handle.db, GUARDS_KEY, { globalConcurrency: 2, perItemAttemptLimit: 3 });
}

describe("the daily budget default, announced", () => {
  it("posts one note naming the figure and where to change it", () => {
    savedWithoutADailyBudget();
    const item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo" });

    announceDailyBudgetDefault(handle.db);

    const posted = notices([item.id]);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.body).toContain(`${DEFAULT_GUARD_CONFIG.dailyBudgetCents}¢`);
    expect(posted[0]!.body).toContain("$50.00");
    expect(posted[0]!.body).toContain("Guardrails");
    // What clearing it means, said where the notice is read rather than
    // only on the screen it points at.
    expect(posted[0]!.body).toContain("no ceiling at all");
  });

  /**
   * The tick calls this every time; the person hears it once.
   *
   * The condition cannot be what makes it once — the saved config still
   * says nothing about a daily budget on the second tick, and will keep
   * saying nothing until somebody opens the Guardrails screen.
   */
  it("says it once, not once per tick", () => {
    savedWithoutADailyBudget();
    const item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo" });

    announceDailyBudgetDefault(handle.db);
    announceDailyBudgetDefault(handle.db);
    announceDailyBudgetDefault(handle.db);

    expect(notices([item.id])).toHaveLength(1);
  });

  /** It is addressed to a person, which is what puts it in the Inbox. */
  it("mentions the human, so it is read rather than merely filed", () => {
    savedWithoutADailyBudget();
    const item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo" });

    announceDailyBudgetDefault(handle.db);

    expect(needsAttention(handle.db, item.id)).toBe(true);
  });

  /** A cleared field is a choice, and a choice is not news. */
  it("stays silent when the daily budget was explicitly cleared", () => {
    setSetting(handle.db, GUARDS_KEY, { ...DEFAULT_GUARD_CONFIG, dailyBudgetCents: null });
    const item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo" });

    announceDailyBudgetDefault(handle.db);

    expect(notices([item.id])).toEqual([]);
  });

  it("stays silent on an installation that saved a daily budget of its own", () => {
    setSetting(handle.db, GUARDS_KEY, { ...DEFAULT_GUARD_CONFIG, dailyBudgetCents: 250 });
    const item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo" });

    announceDailyBudgetDefault(handle.db);

    expect(notices([item.id])).toEqual([]);
  });

  /**
   * The installation the guard was written for (EO-211).
   *
   * Somebody who has used EO for a year and never opened the Guardrails
   * screen has no saved row at all — the same state a database has on
   * the day it is created, and an entirely different situation. This one
   * spent that year with no ceiling and has just been given one, so it
   * is told, exactly as a saved config missing the key is.
   */
  it("announces to an installation that never opened the Guardrails screen", () => {
    const item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo" });

    announceDailyBudgetDefault(handle.db);

    expect(notices([item.id])).toHaveLength(1);
    expect(notices([item.id])[0]!.body).toContain("It had none before");
  });

  /**
   * And the case that state exists to keep apart: a database born under
   * the ceiling, which never spent a day without one.
   *
   * `settleDailyBudgetNotice` is what `index.ts` calls for a database
   * that has never been migrated — the one moment the two are
   * distinguishable, since a saved guards row cannot tell them apart.
   */
  it("stays silent on an installation born under the ceiling", () => {
    settleDailyBudgetNotice(handle.db);
    const item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo" });

    announceDailyBudgetDefault(handle.db);

    expect(notices([item.id])).toEqual([]);
  });

  /** Settling is about this notice alone: it does not write a guard. */
  it("settles the notice without deciding anything about the budget itself", () => {
    settleDailyBudgetNotice(handle.db);

    expect(getSetting<unknown>(handle.db, GUARDS_KEY, null)).toBeNull();
    expect(readGuards(handle.db).dailyBudgetCents).toBe(DEFAULT_GUARD_CONFIG.dailyBudgetCents);
  });

  /**
   * The newest work item, and only a work item.
   *
   * A conversation is a chat the Inbox deliberately keeps out of, a
   * container sits on no step, and a held item's Inbox rows are
   * dropped — a notice on any of the three is a notice nobody receives.
   */
  it("hangs the note on the newest item somebody could be looking at", () => {
    savedWithoutADailyBudget();
    const oldest = createTestItem(handle.db, { type: "story", title: "First", stepId: "todo" });
    const newest = createTestItem(handle.db, { type: "story", title: "Second", stepId: "todo" });
    const conversation = createTestItem(handle.db, { type: "feature", title: "Help", stepId: ASSIST_STEP });
    const container = createTestItem(handle.db, { type: "feature", title: "A feature", stepId: null });
    const held = createTestItem(handle.db, { type: "story", title: "Parked", stepId: "todo" });
    setItemHeld(handle.db, held.id, Date.now());

    announceDailyBudgetDefault(handle.db);

    expect(notices([newest.id])).toHaveLength(1);
    expect(notices([oldest.id, conversation.id, container.id, held.id])).toEqual([]);
  });

  /**
   * Nowhere to post is a wait, not a silence.
   *
   * Marking it said with no comment written would lose the notice
   * entirely on the installation most likely to hit it — one upgraded
   * before its first item exists.
   */
  it("waits for an item rather than swallowing the notice", () => {
    savedWithoutADailyBudget();

    announceDailyBudgetDefault(handle.db);
    const item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo" });
    announceDailyBudgetDefault(handle.db);

    expect(notices([item.id])).toHaveLength(1);
  });

  /**
   * The marker is the memory, not the thread.
   *
   * A scan for the sentence would be undone by somebody deleting the
   * comment — a reasonable thing to do with a notice you have read — and
   * the notice would come back on the next tick, forever.
   */
  it("does not say it again when the comment it posted is deleted", () => {
    savedWithoutADailyBudget();
    const item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo" });

    announceDailyBudgetDefault(handle.db);
    deleteComment(handle.db, notices([item.id])[0]!.id);
    announceDailyBudgetDefault(handle.db);

    expect(notices([item.id])).toEqual([]);
    expect(getSetting<boolean>(handle.db, DAILY_BUDGET_NOTICE_KEY, false)).toBe(true);
  });
});
