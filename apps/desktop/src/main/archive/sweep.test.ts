import type { Uuid } from "@eo/core";
import { dispatchBlocker, readySet, tick } from "@eo/engine";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import {
  addDependency,
  getItem,
  listAgents,
  listArchivedItems,
  listCommentsForItem,
  listRunsForItem,
  createRun,
  postComment,
  setItemArchived,
  transitionItem,
  updateItem,
  projectForWorkspace,
} from "../db/repos/index.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { listInbox, listItemSummaries } from "../ipc/domainQueries.js";
import { findByJiraKey } from "../packs/developer/jira/import.js";
import { buildEligibilityInput, buildTickInput } from "../supervisor/buildTickInput.js";
import { findPendingResponses } from "../supervisor/manualDispatch.js";
import { setArchiveAfterDays, sweepArchive } from "./sweep.js";

/**
 * Finished work leaving the project on its own (KAN-33).
 *
 * The risk this story carries is not that an item fails to disappear —
 * that is visible immediately. It is an item that disappears from the
 * project and is still handed to an agent, which nobody would notice
 * until an archived story turned up with a fresh run on it. Hence a
 * case per read path that means "the working project".
 */
const DAY = 24 * 60 * 60 * 1000;
const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };

let handle: DbHandle;
let projectId: Uuid;
let workspaceId: Uuid;

beforeEach(() => {
  handle = openMigratedTestDb();
  workspaceId = attachWorkspace(handle.db, { name: "app", keyPrefix: "APP", repoPath: "/tmp/app" }).id;
  // The project the repository was attached with — the one carrying the
  // prefix (KAN-128), not a second one wanting the same. One project,
  // not the first of a list: a workspace belongs to the project that
  // holds it since KAN-130.
  projectId = projectForWorkspace(handle.db, workspaceId)!.id;
});

afterEach(() => {
  handle.close();
});

/** An item that reached a terminal state `daysAgo` days ago, by the route a real one takes. */
function finished(daysAgo: number, overrides: { parentId?: Uuid; type?: string } = {}) {
  const item = createTestItem(handle.db, {
    type: overrides.type ?? "story",
    title: "Rate limiting",
    stepId: "todo",
    projectId,
    workspaceId,
    parentId: overrides.parentId ?? null,
  });
  transitionItem(handle.db, { itemId: item.id, toStepId: "ready_to_merge", actor: "human" });
  // The transition wrote `Date.now()`; rewind it, because the whole
  // question is how long ago this happened.
  handle.db.run(sql`update transitions set ts = ${Date.now() - daysAgo * DAY} where item_id = ${item.id}`);
  return item;
}

describe("the archive sweep", () => {
  it("puts away work that has been finished longer than the delay", () => {
    const old = finished(20);

    expect(sweepArchive(handle.db)).toEqual({ archived: 1, disabled: false });
    expect(getItem(handle.db, old.id)?.archivedAt).not.toBeNull();
  });

  it("leaves work that finished recently", () => {
    const fresh = finished(3);

    expect(sweepArchive(handle.db).archived).toBe(0);
    expect(getItem(handle.db, fresh.id)?.archivedAt).toBeNull();
  });

  it("never archives an unfinished item, however old", () => {
    const stuck = createTestItem(handle.db, { type: "story", title: "Blocked forever", stepId: "todo", projectId, workspaceId });
    handle.db.run(`update items set updated_at = ${Date.now() - 400 * DAY} where id = '${stuck.id}'` as never);

    expect(sweepArchive(handle.db).archived).toBe(0);
    expect(getItem(handle.db, stuck.id)?.archivedAt).toBeNull();
  });

  it("clocks from when the work finished, not from the last edit", () => {
    // The reason `updated_at` is not the source: a comment on a done
    // item would reset its clock, and a busy thread could keep
    // finished work on the project forever.
    const old = finished(20);
    updateItem(handle.db, old.id, { title: "Renamed today" });
    postComment(handle.db, { itemId: old.id, author: { type: "human" }, body: "One more thought." });

    expect(sweepArchive(handle.db).archived).toBe(1);
  });

  it("deletes nothing", () => {
    // The whole distinction from KAN-30. Archiving keeps the record; it
    // is what makes putting it back a restore rather than a rebuild.
    const old = finished(20);
    const agent = listAgents(handle.db)[0]!;
    createRun(handle.db, { itemId: old.id, agentId: agent.id, action: "implement", status: "succeeded" });
    postComment(handle.db, { itemId: old.id, author: { type: "human" }, body: "Shipped." });

    sweepArchive(handle.db);

    expect(listRunsForItem(handle.db, old.id)).toHaveLength(1);
    expect(listCommentsForItem(handle.db, old.id).some((comment) => comment.body === "Shipped.")).toBe(true);
  });

  it("says why the item left", () => {
    const old = finished(20);

    sweepArchive(handle.db);

    const note = listCommentsForItem(handle.db, old.id).find((comment) => comment.authorType === "engine");
    expect(note?.body).toContain("Archived");
    expect(note?.body).toContain("20 days ago");
    expect(note?.body).toContain("Nothing was deleted");
  });

  it("finds nothing on a second pass", () => {
    finished(20);
    sweepArchive(handle.db);

    expect(sweepArchive(handle.db).archived).toBe(0);
  });

  it("does nothing at all when archiving is turned off", () => {
    const old = finished(400);
    setArchiveAfterDays(handle.db, null);

    expect(sweepArchive(handle.db)).toEqual({ archived: 0, disabled: true });
    expect(getItem(handle.db, old.id)?.archivedAt).toBeNull();
  });

  it("archives as soon as work is done when the delay is zero", () => {
    // Zero is a real setting, which is why "off" is null rather than 0 —
    // a falsy check would make the two indistinguishable.
    const justNow = finished(0);
    setArchiveAfterDays(handle.db, 0);

    expect(sweepArchive(handle.db).archived).toBe(1);
    expect(getItem(handle.db, justNow.id)?.archivedAt).not.toBeNull();
  });

  it("dates a feature by its stories, the only clock it has", () => {
    // A feature is off the pipeline (ARCHITECTURE.md, "One work entity"): it never transitions into
    // a
    // terminal step, so it has no finish time of its own. Reading only
    // its own transitions and falling back to "now" made every archived
    // feature announce itself as finished today, in the same sentence as
    // the fortnight it had supposedly waited.
    const feature = createTestItem(handle.db, { type: "feature", title: "Rate limiting", stepId: null, projectId, workspaceId });
    finished(20, { parentId: feature.id });

    sweepArchive(handle.db);

    expect(getItem(handle.db, feature.id)?.archivedAt).not.toBeNull();
    const note = listCommentsForItem(handle.db, feature.id).find((comment) => comment.authorType === "engine");
    expect(note?.body).toContain("20 days ago");
  });

  it("dates a feature by its newest story, not its oldest", () => {
    // Two stories, both old enough to be taken on their own. The clock is
    // the *last* one to finish: a feature whose final story landed 20 days
    // ago has been finished 20 days, not the 40 since the first one.
    //
    // This is the only place that distinction is observable. Inside
    // `archivableItems` the same comparison is masked — a feature is not
    // eligible until every story under it is, so by then the oldest and
    // newest both clear the limit and taking either gives the same
    // decision. Here it is the number a person reads.
    const feature = createTestItem(handle.db, { type: "feature", title: "Rate limiting", stepId: null, projectId, workspaceId });
    finished(40, { parentId: feature.id });
    finished(20, { parentId: feature.id });

    sweepArchive(handle.db);

    const note = listCommentsForItem(handle.db, feature.id).find((comment) => comment.authorType === "engine");
    expect(note?.body).toContain("20 days ago");
    expect(note?.body).not.toContain("40 days ago");
  });

  it("waits for a feature's stories before taking the feature", () => {
    const feature = finished(30, { type: "feature" });
    createTestItem(handle.db, { type: "story", title: "Still going", stepId: "todo", projectId, workspaceId, parentId: feature.id });

    sweepArchive(handle.db);

    expect(getItem(handle.db, feature.id)?.archivedAt).toBeNull();
  });
});

/**
 * The part worth being paranoid about. An archived item that is
 * invisible but still schedulable would be discovered by an agent
 * running on it, not by anyone reading the project.
 */
describe("where an archived item stops appearing", () => {
  function archivedItem() {
    const item = finished(20);
    sweepArchive(handle.db);
    return item;
  }

  it("is gone from the project", () => {
    const item = archivedItem();

    expect(listItemSummaries(handle.db, projectId).items.map((entry) => entry.id)).not.toContain(item.id);
  });

  it("is gone from the scheduler's view of the world", () => {
    const item = archivedItem();

    expect(buildTickInput(handle.db, LIMITS, false).items.map((entry) => entry.id)).not.toContain(item.id);
  });

  it("is gone from the ready set", () => {
    const item = archivedItem();
    const input = buildTickInput(handle.db, LIMITS, false);

    expect(readySet(input.items, input.deps).map((entry) => entry.id)).not.toContain(item.id);
  });

  it("is gone from the inbox, even holding an open question", () => {
    const item = finished(20);
    const agent = listAgents(handle.db)[0]!;
    postComment(handle.db, {
      itemId: item.id,
      author: { type: "agent", agentId: agent.id },
      kind: "question",
      mentions: [{ type: "human" }],
      body: "Anything else?",
    });
    expect(listInbox(handle.db, projectId).items).toHaveLength(1);

    sweepArchive(handle.db);

    expect(listInbox(handle.db, projectId).items).toEqual([]);
  });

  it("is not dispatched for a mention that is still open", () => {
    // The failure that would go unnoticed: the mention path is a second
    // entry point into the scheduler, and it takes its item list
    // separately from the tick input.
    const item = finished(20);
    const agent = listAgents(handle.db)[0]!;
    postComment(handle.db, {
      itemId: item.id,
      author: { type: "human" },
      body: `@${agent.role} one more thing`,
      mentions: [{ type: "agent", agentId: agent.id }],
    });
    sweepArchive(handle.db);

    const live = buildTickInput(handle.db, LIMITS, false).items.map((entry) => entry.id);

    expect(live).not.toContain(item.id);
    expect(findPendingResponses(handle.db, live)).toEqual([]);
  });

  it("is still found by a Jira import, so it is not imported twice", () => {
    // About existence rather than about the project. Answering this from
    // the live set would create a second copy of the same issue the
    // moment the first was tidied away.
    const item = finished(20);
    updateItem(handle.db, item.id, { jiraKey: "ACME-7" });
    sweepArchive(handle.db);

    expect(findByJiraKey(handle.db, "ACME-7")?.id).toBe(item.id);
  });
});

describe("putting one back", () => {
  it("restores it exactly, because nothing was deleted", () => {
    const item = finished(20);
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Shipped." });
    sweepArchive(handle.db);
    expect(listArchivedItems(handle.db, projectId).map((entry) => entry.id)).toEqual([item.id]);

    setItemArchived(handle.db, item.id, null);

    const restored = getItem(handle.db, item.id)!;
    expect(restored.archivedAt).toBeNull();
    expect(restored.stepId).toBe("ready_to_merge");
    expect(listItemSummaries(handle.db, projectId).items.map((entry) => entry.id)).toContain(item.id);
    expect(listCommentsForItem(handle.db, item.id).some((comment) => comment.body === "Shipped.")).toBe(true);
  });
});

/**
 * What archiving must *not* do to the rest of the board (EO-335).
 *
 * The sweep takes the item away and leaves its `item_deps` rows behind —
 * `listAllDependencies` is unfiltered and always was. So every edge
 * pointing at a swept item stops resolving, and the scheduler read that
 * failure to resolve as "the dependency has not finished". Which made
 * finishing a story and letting EO tidy it away the thing that
 * deadlocked everything waiting on it, permanently and silently: the
 * item never comes back to the live list, so no later tick can change
 * its mind.
 *
 * Both halves are asserted together on purpose. One decides what runs
 * and the other decides what the person is told is holding it up, and a
 * bug where they disagree is a person staring at a card that says it is
 * waiting for nothing.
 */
describe("a dependency that has been archived", () => {
  function waitingOn(dependency: Uuid) {
    const waiting = createTestItem(handle.db, { type: "story", title: "Waits on it", stepId: "todo", projectId, workspaceId });
    addDependency(handle.db, waiting.id, dependency);
    return waiting;
  }

  const openDepsFor = (id: Uuid): number | undefined =>
    listItemSummaries(handle.db, projectId).items.find((entry) => entry.id === id)?.openDependencyCount;

  it("stops blocking its dependents once it is finished and swept away", () => {
    const dependency = finished(20);
    const waiting = waitingOn(dependency.id);

    // Finished but still on the project: already not blocking.
    expect(openDepsFor(waiting.id)).toBe(0);
    expect(tick(buildTickInput(handle.db, LIMITS, false)).map((dispatch) => dispatch.item.id)).toContain(waiting.id);

    expect(sweepArchive(handle.db).archived).toBe(1);
    expect(getItem(handle.db, dependency.id)?.archivedAt).not.toBeNull();

    // And after: the same answer, from both halves.
    expect(openDepsFor(waiting.id)).toBe(0);
    expect(dispatchBlocker(buildEligibilityInput(handle.db, false), waiting.id)).toBeNull();
    expect(tick(buildTickInput(handle.db, LIMITS, false)).map((dispatch) => dispatch.item.id)).toContain(waiting.id);
  });

  it("goes on blocking them when it was put away without finishing", () => {
    // Archiving by hand is not finishing (`items:setArchived`), and
    // widening the lookup must not quietly turn one into the other.
    const unfinished = createTestItem(handle.db, { type: "story", title: "Never got there", stepId: "todo", projectId, workspaceId });
    const waiting = waitingOn(unfinished.id);
    setItemArchived(handle.db, unfinished.id, Date.now());

    expect(openDepsFor(waiting.id)).toBe(1);
    expect(dispatchBlocker(buildEligibilityInput(handle.db, false), waiting.id)).toEqual({ kind: "open_dependency" });
    expect(tick(buildTickInput(handle.db, LIMITS, false)).map((dispatch) => dispatch.item.id)).not.toContain(waiting.id);
  });
});
