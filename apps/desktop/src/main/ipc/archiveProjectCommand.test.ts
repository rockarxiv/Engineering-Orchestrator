import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LOCAL_PERSON_ID, type Uuid } from "@eo/core";
import { dispatchBlocker } from "@eo/engine";
import type { DbHandle } from "../db/client.js";
import {
  createProject,
  createRun,
  getItem,
  getProject,
  getSetting,
  listAgents,
  listCommentsForItem,
  listRunsForItem,
  postComment,
  setItemArchived,
  setSetting,
  updateRun,
} from "../db/repos/index.js";
import { markProjectOnTheRecord } from "../db/repos/projectsRepo.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { archivedProjectBlocker, buildEligibilityInput } from "../supervisor/buildTickInput.js";
import { createItemLock } from "../supervisor/itemLock.js";
import { recordStop, stopStands } from "../supervisor/stoppedByHand.js";
import { archiveProjectCommand, restoreProjectCommand, stoppedByArchiveNote } from "./archiveProjectCommand.js";
import { managedProjectRefusal } from "./deleteProjectCommand.js";
import { listArchivedSummaries, listInbox, listItemSummaries } from "./domainQueries.js";
import { holdItem, resumeHeldItem, type EngineHandle } from "./domainCommands.js";
import { listProjectsCommand, setActiveProjectCommand } from "./projectCommands.js";
import { ACTIVE_PROJECT_KEY, activeProjectId } from "./repositoryCommands.js";

/**
 * Archiving and restoring a project (EO-347).
 *
 * The command's own bookkeeping, and what the rest of the main process
 * reads off the one column it writes: the scheduler's input, the
 * explanation on an item, the switcher's list and the Inbox. That a
 * real supervisor dispatches nothing while the project is archived and
 * everything again after is `supervisor/archivedProject.test.ts`.
 */

let handle: DbHandle;

beforeEach(() => {
  handle = openMigratedTestDb();
});

afterEach(() => {
  handle.close();
});

function fakeEngine(): EngineHandle & { cancelled: { runId: string; reason: string | undefined }[]; notified: number } {
  const state = {
    cancelled: [] as { runId: string; reason: string | undefined }[],
    notified: 0,
  };
  return Object.assign(state, {
    resumeItem: async () => {},
    cancelRun: (runId: string, reason?: string) => void state.cancelled.push({ runId, reason }),
    steerRun: () => Promise.resolve("no-live-run" as const),
    pause: () => {},
    resume: () => {},
    isPaused: () => false,
    dispatchBlockerFor: () => null,
    activeRunCount: () => 0,
    finishingRunCount: () => 0,
    notifyStateChange: () => {
      state.notified += 1;
    },
    itemLock: createItemLock(),
    offerWork: async () => [],
  });
}

function project(name: string, keyPrefix: string) {
  return createProject(handle.db, { name, keyPrefix });
}

function storyOn(projectId: Uuid, title: string, stepId = "todo") {
  return createTestItem(handle.db, { type: "story", title, stepId, projectId });
}

function runningOn(itemId: Uuid) {
  const agent = listAgents(handle.db).find((entry) => entry.role === "implementer")!;
  return createRun(handle.db, { itemId, agentId: agent.id, action: "implement", status: "running" });
}

function archive(projectId: Uuid, confirm: boolean, engine: EngineHandle = fakeEngine()) {
  return archiveProjectCommand(handle.db, engine, { projectId, confirm });
}

function candidates(): string[] {
  return buildEligibilityInput(handle.db, false).items.map((item) => item.id);
}

describe("projects:archive", () => {
  it("without confirmation changes nothing, and says how many unfinished tickets pause and which agents would stop", () => {
    const shop = project("Shop", "SHOP");
    storyOn(shop.id, "Cart");
    storyOn(shop.id, "Shipped", "ready_to_merge");
    const busy = storyOn(shop.id, "Checkout");
    runningOn(busy.id);
    const engine = fakeEngine();

    const answer = archive(shop.id, false, engine);

    expect(answer).toMatchObject({ archived: false, problem: null, name: "Shop", unfinishedCount: 2 });
    expect(answer.running).toEqual([{ itemKey: busy.key, title: "Checkout" }]);
    expect(getProject(handle.db, shop.id)?.archivedAt).toBeNull();
    expect(engine.cancelled).toEqual([]);
  });

  it("refuses a project on the organisation's record, and offers nothing to confirm", () => {
    const theirs = project("Theirs", "ORG");
    markProjectOnTheRecord(handle.db, theirs.id, LOCAL_PERSON_ID);

    for (const confirm of [false, true]) {
      const answer = archive(theirs.id, confirm);
      expect(answer).toMatchObject({ archived: false, problem: managedProjectRefusal("Theirs", "archived") });
    }
    expect(getProject(handle.db, theirs.id)?.archivedAt).toBeNull();
  });

  it("refuses a project that is already archived, and one that does not exist", () => {
    const shop = project("Shop", "SHOP");
    archive(shop.id, true);

    expect(archive(shop.id, true).problem).toMatch(/already archived/);
    expect(archive("01900000-0000-7000-8000-00000000dead" as Uuid, true).problem).toBe("That project no longer exists.");
  });

  it("stops the run in flight as superseded, and says why on that item", () => {
    const shop = project("Shop", "SHOP");
    const busy = storyOn(shop.id, "Checkout");
    const run = runningOn(busy.id);
    const engine = fakeEngine();

    const answer = archive(shop.id, true, engine);

    expect(answer).toMatchObject({ archived: true, problem: null });
    expect(getProject(handle.db, shop.id)?.archivedAt).not.toBeNull();
    // Superseded: the archive says its own sentence, and a person's stop
    // would leave the item standing still after the restore.
    expect(engine.cancelled).toEqual([{ runId: run.id, reason: "superseded" }]);
    const notes = listCommentsForItem(handle.db, busy.id).filter((comment) => comment.authorType === "engine");
    expect(notes.map((comment) => comment.body)).toEqual([stoppedByArchiveNote("Shop", "To Do")]);
    expect(notes[0]?.runId).toBe(run.id);
    expect(engine.notified).toBeGreaterThan(0);
  });

  it("clears the stand-off an earlier stop left on an item whose run it cancelled, as a resume does", () => {
    const shop = project("Shop", "SHOP");
    const busy = storyOn(shop.id, "Checkout");
    const quiet = storyOn(shop.id, "Untouched");
    recordStop(handle.db, busy.id, "entry-1");
    recordStop(handle.db, quiet.id, "entry-1");
    runningOn(busy.id);

    archive(shop.id, true);

    expect(stopStands(handle.db, busy.id, "entry-1")).toBe(false);
    // An item the archive did not stop keeps whatever a person decided
    // about it: this is not the archive's to undo.
    expect(stopStands(handle.db, quiet.id, "entry-1")).toBe(true);
  });

  it("moves the window to another live project, or to none when none is left", () => {
    const shop = project("Shop", "SHOP");
    const web = project("Web", "WEB");
    setSetting(handle.db, ACTIVE_PROJECT_KEY, shop.id);

    expect(archive(shop.id, true).activeProjectId).toBe(web.id);
    expect(getSetting(handle.db, ACTIVE_PROJECT_KEY, null)).toBe(web.id);

    expect(archive(web.id, true).activeProjectId).toBeNull();
    expect(activeProjectId(handle.db)).toBeNull();
    expect(listProjectsCommand(handle.db).activeProjectId).toBeNull();
  });
});

describe("the scheduler, while a project is archived", () => {
  it("leaves its tickets out, and names the project when asked why one is not moving", () => {
    const shop = project("Shop", "SHOP");
    const web = project("Web", "WEB");
    const cart = storyOn(shop.id, "Cart");
    const other = storyOn(web.id, "Homepage");

    archive(shop.id, true);

    expect(candidates()).not.toContain(cart.id);
    expect(candidates()).toContain(other.id);
    expect(archivedProjectBlocker(handle.db, cart.id)).toEqual({ kind: "project_archived", projectName: "Shop" });
    expect(archivedProjectBlocker(handle.db, other.id)).toBeNull();
    // Nothing was written onto the item itself.
    expect(getItem(handle.db, cart.id)?.heldAt).toBeNull();
  });

  it("says so when an item on it is resumed from a hold, rather than promising a pickup", () => {
    const shop = project("Shop", "SHOP");
    const cart = storyOn(shop.id, "Cart");
    holdItem(handle.db, undefined, { itemId: cart.id, cancelActiveRun: false, comment: "" });
    archive(shop.id, true);

    resumeHeldItem(handle.db, undefined, { itemId: cart.id, cancelActiveRun: false });

    const last = listCommentsForItem(handle.db, cart.id).at(-1);
    expect(last?.body).toContain('its project, "Shop", is archived');
    expect(last?.body).toContain('Restore "Shop"');
  });

  it("puts every paused item back on restore, on the step it was on", () => {
    const shop = project("Shop", "SHOP");
    const cart = storyOn(shop.id, "Cart");
    const review = storyOn(shop.id, "Checkout", "review");
    archive(shop.id, true);

    const answer = restoreProjectCommand(handle.db, fakeEngine(), { projectId: shop.id });

    expect(answer).toMatchObject({ restored: true, problem: null, name: "Shop", unfinishedCount: 2 });
    expect(candidates()).toEqual(expect.arrayContaining([cart.id, review.id]));
    expect(getItem(handle.db, cart.id)?.stepId).toBe("todo");
    expect(getItem(handle.db, review.id)?.stepId).toBe("review");
    expect(archivedProjectBlocker(handle.db, cart.id)).toBeNull();
  });

  it("keeps an item held through an archive and a restore", () => {
    const shop = project("Shop", "SHOP");
    const held = storyOn(shop.id, "Held by hand");
    const free = storyOn(shop.id, "Free");
    holdItem(handle.db, undefined, { itemId: held.id, cancelActiveRun: false, comment: "" });

    archive(shop.id, true);
    restoreProjectCommand(handle.db, fakeEngine(), { projectId: shop.id });

    expect(getItem(handle.db, held.id)?.heldAt).not.toBeNull();
    expect(dispatchBlocker(buildEligibilityInput(handle.db, false), held.id)).toEqual({ kind: "held" });
    expect(dispatchBlocker(buildEligibilityInput(handle.db, false), free.id)).not.toEqual({ kind: "held" });
  });

  it("refuses to restore a project that is not archived", () => {
    const shop = project("Shop", "SHOP");

    expect(restoreProjectCommand(handle.db, fakeEngine(), { projectId: shop.id })).toMatchObject({
      restored: false,
      problem: '"Shop" is not archived.',
    });
  });
});

describe("what an archived project looks like to the rest of EO", () => {
  it("is listed with when it was archived, and is never the project the window shows", () => {
    const shop = project("Shop", "SHOP");
    const web = project("Web", "WEB");
    archive(shop.id, true);
    // A setting written before the archive, or by anything else, is not
    // followed onto a project with no board.
    setSetting(handle.db, ACTIVE_PROJECT_KEY, shop.id);

    const listed = listProjectsCommand(handle.db);

    expect(listed.projects.find((entry) => entry.id === shop.id)?.archivedAt).not.toBeNull();
    expect(listed.projects.find((entry) => entry.id === web.id)?.archivedAt).toBeNull();
    expect(listed.activeProjectId).toBe(web.id);
    expect(setActiveProjectCommand(handle.db, { id: shop.id }).activeProjectId).toBe(web.id);
  });

  it("is back in the list as live once restored", () => {
    const shop = project("Shop", "SHOP");
    archive(shop.id, true);

    restoreProjectCommand(handle.db, fakeEngine(), { projectId: shop.id });

    expect(listProjectsCommand(handle.db).projects.find((entry) => entry.id === shop.id)?.archivedAt).toBeNull();
    expect(listProjectsCommand(handle.db).activeProjectId).toBe(shop.id);
  });

  it("keeps its tickets' questions out of the Inbox every project is counted from", () => {
    const shop = project("Shop", "SHOP");
    const web = project("Web", "WEB");
    const cart = storyOn(shop.id, "Cart");
    const home = storyOn(web.id, "Homepage");
    for (const item of [cart, home]) {
      postComment(handle.db, { itemId: item.id, author: { type: "engine" }, body: "Which colour?", mentions: [{ type: "human" }], kind: "escalation" });
    }
    expect(listInbox(handle.db).items.map((row) => row.itemId).sort()).toEqual([cart.id, home.id].sort());

    archive(shop.id, true);

    expect(listInbox(handle.db).items.map((row) => row.itemId)).toEqual([home.id]);
    expect(listInbox(handle.db).summary.openCount).toBe(1);

    restoreProjectCommand(handle.db, fakeEngine(), { projectId: shop.id });
    expect(listInbox(handle.db).items.map((row) => row.itemId).sort()).toEqual([cart.id, home.id].sort());
  });

  it("shows none of its tickets to a read that names it, and all of them again once restored", () => {
    // The window never names an archived project, but `items:list` and
    // `inbox:list` take an explicit id — `tickets_list` passes whatever
    // an agent asks for — and a board drawn for one is the thing
    // archiving takes out of sight.
    const shop = project("Shop", "SHOP");
    const cart = storyOn(shop.id, "Cart");
    const old = storyOn(shop.id, "Old");
    setItemArchived(handle.db, old.id, Date.now());
    postComment(handle.db, { itemId: cart.id, author: { type: "engine" }, body: "Which colour?", mentions: [{ type: "human" }], kind: "escalation" });

    archive(shop.id, true);

    expect(listItemSummaries(handle.db, shop.id).items).toEqual([]);
    expect(listArchivedSummaries(handle.db, shop.id).items).toEqual([]);
    expect(listInbox(handle.db, shop.id).items).toEqual([]);
    expect(listInbox(handle.db, shop.id).summary.openCount).toBe(0);

    restoreProjectCommand(handle.db, fakeEngine(), { projectId: shop.id });

    expect(listItemSummaries(handle.db, shop.id).items.map((row) => row.id)).toEqual([cart.id]);
    expect(listArchivedSummaries(handle.db, shop.id).items.map((row) => row.id)).toEqual([old.id]);
    expect(listInbox(handle.db, shop.id).items.map((row) => row.itemId)).toEqual([cart.id]);
  });

  it("does not let its tickets decide whether everything else is waiting on a person", () => {
    // Everything on Web is waiting on an answer. An item on Shop that
    // is not would keep "everything is blocked" false — about work the
    // engine is not going to move whatever anybody answers.
    const shop = project("Shop", "SHOP");
    const web = project("Web", "WEB");
    storyOn(shop.id, "Cart");
    const home = storyOn(web.id, "Homepage");
    const implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
    const parked = createRun(handle.db, { itemId: home.id, agentId: implementer.id, action: "implement", threadId: "t" });
    updateRun(handle.db, parked.id, { status: "awaiting_input" });
    postComment(handle.db, {
      itemId: home.id,
      author: { type: "agent", agentId: implementer.id },
      body: "Which colour?",
      mentions: [{ type: "human" }],
      kind: "escalation",
    });
    expect(listInbox(handle.db).summary.everythingBlocked).toBe(false);

    archive(shop.id, true);

    expect(listInbox(handle.db).summary.everythingBlocked).toBe(true);
    expect(listInbox(handle.db, web.id).summary.everythingBlocked).toBe(true);
  });

  it("leaves its runs where they were: nothing is deleted", () => {
    const shop = project("Shop", "SHOP");
    const busy = storyOn(shop.id, "Checkout");
    const run = runningOn(busy.id);

    archive(shop.id, true);

    expect(listRunsForItem(handle.db, busy.id).map((entry) => entry.id)).toEqual([run.id]);
    expect(getItem(handle.db, busy.id)).toBeDefined();
  });
});
