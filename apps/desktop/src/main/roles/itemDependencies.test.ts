import { rmSync } from "node:fs";
import { ipcContract, type Item } from "@eo/core";
import { tick } from "@eo/engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import {
  addDependency,
  createProject,
  createRun,
  getItem,
  listAgents,
  listAllDependencies,
  listCommentsForItem,
  listDependencies,
  transitionItem,
} from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { updateItemText } from "../ipc/domainCommands.js";
import { listItemSummaries } from "../ipc/domainQueries.js";
import { clearHandlerRegistry } from "../ipc/registry.js";
import { answerToolCall } from "../mcpHost/server.js";
import { buildTickInput } from "../supervisor/buildTickInput.js";
import { fakePlatform } from "../testing/platform.js";
import { changeItemDependencies } from "./itemDependencies.js";

/**
 * Changing what an existing item waits for (EO-600).
 *
 * Everything here goes through `items:update` — the channel the item
 * screen, `item_update` and `ticket_update` all reach — except where a
 * test is about the shared function itself. The reorder card's half of
 * the same rule is held in `discussion.test.ts`.
 */

let handle: DbHandle;
let release: Item;
let story: Item;
let other: Item;

const limits = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 5 };

beforeEach(() => {
  handle = openMigratedTestDb();
  release = createTestItem(handle.db, { type: "story", title: "Release 2.4", stepId: "todo" });
  story = createTestItem(handle.db, { type: "story", title: "Rate limit the import", stepId: "todo" });
  other = createTestItem(handle.db, { type: "story", title: "Retry the export", stepId: "todo" });
});

afterEach(() => {
  clearHandlerRegistry();
  handle.close();
});

function dispatched(): string[] {
  return tick(buildTickInput(handle.db, limits, false)).map((dispatch) => dispatch.item.id as string);
}

function engineComments(item: Item) {
  return listCommentsForItem(handle.db, item.id).filter((comment) => comment.authorType === "engine");
}

function waitsFor(item: Item): string[] {
  return listDependencies(handle.db, item.id)
    .map((edge) => getItem(handle.db, edge.dependsOnId)!.key)
    .sort();
}

describe("adding a dependency", () => {
  it("blocks an item that waited on nothing until the item it now waits for is finished", () => {
    expect(dispatched()).toContain(release.id);

    const answer = updateItemText(handle.db, { itemId: release.id, addDependsOn: [story.key] });

    expect(answer).toEqual({ updated: true, problem: null, dependencies: { added: [story.key], removed: [], stillWaitsFor: [story.key], freed: false } });
    expect(waitsFor(release)).toEqual([story.key]);
    // items_list reads this summary: "waiting on 1".
    expect(listItemSummaries(handle.db, null).items.find((summary) => summary.id === release.id)?.openDependencyCount).toBe(1);
    expect(dispatched()).not.toContain(release.id);

    transitionItem(handle.db, { itemId: story.id, toStepId: "ready_to_merge", actor: "human", reason: "finished" });

    expect(listItemSummaries(handle.db, null).items.find((summary) => summary.id === release.id)?.openDependencyCount).toBe(0);
    expect(dispatched()).toContain(release.id);
  });

  it("takes an item by its id as well as its key, and a key in any case", () => {
    expect(updateItemText(handle.db, { itemId: release.id, addDependsOn: [story.id, other.key.toLowerCase()] }).updated).toBe(true);
    expect(waitsFor(release)).toEqual([story.key, other.key].sort());
  });

  it("writes it alongside the call's other fields", () => {
    expect(updateItemText(handle.db, { itemId: release.id, title: "Release 2.4.1", addDependsOn: [story.key] }).updated).toBe(true);
    expect(getItem(handle.db, release.id)?.title).toBe("Release 2.4.1");
    expect(waitsFor(release)).toEqual([story.key]);
  });
});

describe("removing a dependency", () => {
  it("leaves an item whose last open dependency it was dispatchable on the next tick, and says so", () => {
    addDependency(handle.db, release.id, story.id);
    expect(dispatched()).not.toContain(release.id);

    const answer = updateItemText(handle.db, { itemId: release.id, removeDependsOn: [story.id] });

    expect(answer).toEqual({ updated: true, problem: null, dependencies: { added: [], removed: [story.key], stillWaitsFor: [], freed: true } });
    expect(listDependencies(handle.db, release.id)).toHaveLength(0);
    expect(dispatched()).toContain(release.id);
    expect(engineComments(release).at(-1)?.body).toContain("so it can be picked up on the next tick");
  });

  it("does not say it freed an item that still waits for something open", () => {
    addDependency(handle.db, release.id, story.id);
    addDependency(handle.db, release.id, other.id);

    const answer = updateItemText(handle.db, { itemId: release.id, removeDependsOn: [story.key] });

    expect(answer.dependencies).toEqual({ added: [], removed: [story.key], stillWaitsFor: [other.key], freed: false });
    expect(dispatched()).not.toContain(release.id);
  });
});

describe("the comment an applied change leaves", () => {
  it("is exactly one engine comment naming what was added, what was removed and who asked", () => {
    addDependency(handle.db, release.id, other.id);
    const before = engineComments(release).length;

    updateItemText(handle.db, { itemId: release.id, addDependsOn: [story.key], removeDependsOn: [other.key] });

    const comments = engineComments(release);
    expect(comments).toHaveLength(before + 1);
    const body = comments.at(-1)!.body;
    expect(body).toContain(`What ${release.key} waits for was changed by you.`);
    expect(body).toContain(`Now waits for: ${story.key} (Rate limit the import)`);
    expect(body).toContain(`No longer waits for: ${other.key} (Retry the export)`);
  });

  it("is not posted for a call that changes nothing about what the item waits for", () => {
    const before = engineComments(release).length;
    updateItemText(handle.db, { itemId: release.id, title: "Release 2.5" });
    expect(engineComments(release)).toHaveLength(before);
    expect(updateItemText(handle.db, { itemId: release.id, addDependsOn: [], removeDependsOn: [] })).toEqual({ updated: false, problem: null });
  });
});

describe("a refused change", () => {
  /**
   * Every refusal names the items by key, and leaves the graph — and
   * the call's other changes, a removal and a title here — exactly as
   * they were. The removal is asked for first, so a refusal that only
   * looked at additions after writing removals would show here.
   */
  function refusedLeavesEverything(addDependsOn: string[], removeDependsOn: string[] = [story.key]): string {
    addDependency(handle.db, release.id, story.id);
    const edges = listAllDependencies(handle.db);
    const comments = listCommentsForItem(handle.db, release.id).length;

    const answer = updateItemText(handle.db, { itemId: release.id, title: "Renamed", removeDependsOn, addDependsOn });

    expect(answer.updated).toBe(false);
    expect(answer.dependencies).toBeUndefined();
    expect(listAllDependencies(handle.db)).toEqual(edges);
    expect(getItem(handle.db, release.id)?.title).toBe("Release 2.4");
    expect(listCommentsForItem(handle.db, release.id)).toHaveLength(comments);
    return answer.problem ?? "";
  }

  it("refuses an item that does not exist, by the name it was given", () => {
    expect(refusedLeavesEverything(["EO-999"])).toMatch(/^There is no \w+ EO-999\.$/);
  });

  it("refuses the item itself", () => {
    expect(refusedLeavesEverything([release.key])).toBe(`${release.key} cannot depend on itself.`);
  });

  it("refuses an item on another project", () => {
    const project = createProject(handle.db, { name: "Elsewhere", keyPrefix: "ELS" });
    const foreign = createTestItem(handle.db, { type: "story", title: "Somebody else's", stepId: "todo", projectId: project.id });
    expect(refusedLeavesEverything([foreign.key])).toBe(`${foreign.key} is on a different project from ${release.key}.`);
  });

  it("refuses an edge to add that is already there", () => {
    addDependency(handle.db, release.id, other.id);
    expect(refusedLeavesEverything([other.key])).toBe(`${release.key} already waits for ${other.key}. To change the rule it waits by, name it in updateDependsOn instead.`);
  });

  it("refuses an edge to remove that is not there", () => {
    expect(refusedLeavesEverything([], [story.key, other.key])).toBe(`${release.key} does not wait for ${other.key}, so there is nothing to remove.`);
  });

  it("refuses an addition that closes a cycle once merged into the live graph", () => {
    addDependency(handle.db, other.id, release.id);
    const problem = refusedLeavesEverything([other.key]);
    expect(problem).toMatch(new RegExp(`^${release.key} cannot wait for ${other.key} — that would make the dependencies circular: `));
    expect(problem).toMatch(new RegExp(`(${release.key} → ${other.key} → ${release.key}|${other.key} → ${release.key} → ${other.key})\\.$`));
  });

  it("refuses an item named both to add and to remove", () => {
    expect(refusedLeavesEverything([story.key])).toBe(`${story.key} is named both to add and to remove, so it is not clear whether ${release.key} should wait for it.`);
  });

  it("refuses by the reorder card's rule while an agent is working on the item", () => {
    // `refuseIfUntouchable`, the guard the reorder card and an amendment
    // are held to.
    createRun(handle.db, { itemId: release.id, agentId: listAgents(handle.db)[0]!.id, action: "implement", status: "running" });
    const answer = updateItemText(handle.db, { itemId: release.id, addDependsOn: [story.key] });
    expect(answer.updated).toBe(false);
    expect(answer.problem).toMatch(/agent/);
    expect(listDependencies(handle.db, release.id)).toHaveLength(0);
  });
});

describe("the shared function, outside any caller's transaction", () => {
  it("leaves a removal unapplied when an addition in the same change is refused", () => {
    addDependency(handle.db, release.id, story.id);
    addDependency(handle.db, other.id, release.id);

    const outcome = changeItemDependencies(handle.db, release, { remove: [story.key], add: [other.key] }, "Reordered.");

    expect(outcome.ok).toBe(false);
    expect(waitsFor(release)).toEqual([story.key]);
  });
});

describe("items:update and the tools over it", () => {
  it("validates the two lists in the contract", () => {
    const request = ipcContract["items:update"].request;
    expect(request.safeParse({ itemId: "x", addDependsOn: ["EO-1"], removeDependsOn: [] }).success).toBe(true);
    expect(request.safeParse({ itemId: "x", addDependsOn: "EO-1" }).success).toBe(false);
    expect(request.safeParse({ itemId: "x", removeDependsOn: [""] }).success).toBe(false);
  });

  it.each(["item_update", "ticket_update"])("passes them through %s, and says what the change did", async (tool) => {
    const platform = fakePlatform();
    const { registerAllHandlers } = await import("../ipc/handlers.js");
    registerAllHandlers(handle.db, undefined, { platform });
    try {
      const added = await answerToolCall({ name: tool, arguments: { [tool === "item_update" ? "itemId" : "ticketId"]: release.key, addDependsOn: [story.key] } }, "admin", true);
      expect(added.isError).toBe(false);
      expect(JSON.stringify(added.content)).toContain(`It now waits for ${story.key}.`);
      expect(waitsFor(release)).toEqual([story.key]);

      const removed = await answerToolCall({ name: tool, arguments: { [tool === "item_update" ? "itemId" : "ticketId"]: release.id, removeDependsOn: [story.key] } }, "admin", true);
      expect(JSON.stringify(removed.content)).toContain("so it can be picked up on the next tick");
      expect(waitsFor(release)).toEqual([]);

      const refused = await answerToolCall({ name: tool, arguments: { [tool === "item_update" ? "itemId" : "ticketId"]: release.id, addDependsOn: [release.key] } }, "admin", true);
      expect(JSON.stringify(refused.content)).toContain(`${release.key} cannot depend on itself.`);
    } finally {
      rmSync(platform.userDataPath, { recursive: true, force: true });
    }
  });
});
