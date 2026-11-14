import { rmSync } from "node:fs";
import { ipcContract, type IpcPayload, type Item } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { itemDeps } from "../db/schema.js";
import {
  addDependency,
  getItemByKey,
  getStep,
  listAllDependencies,
  listCommentsForItem,
  listDependencies,
  listStepsForPipeline,
  transitionItem,
} from "../db/repos/index.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { updateItemText } from "../ipc/domainCommands.js";
import { getItemSections, moduleItemView } from "../ipc/domainQueries.js";
import { submitPlan } from "../ipc/planCommands.js";
import { clearHandlerRegistry } from "../ipc/registry.js";
import { answerToolCall } from "../mcpHost/server.js";
import { fakePlatform } from "../testing/platform.js";

/**
 * Setting and changing the rule a dependency waits by (EO-777), through
 * `items:update` — the item screen, `item_update` and its twin — and a
 * plan's stories. The scheduler's half of the rule is EO-776's and held
 * in `dependencyGates.test.ts` and the engine's own tests; here it is
 * what is written, what is refused, and what is said.
 */

let handle: DbHandle;
let release: Item;
let story: Item;
let other: Item;

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

/** The seeded Delivery's review step, by its name as a caller would give it. */
function reviewName(): string {
  return getStep(handle.db, "review")!.name;
}

/** Every step name on the pipeline `item` is on, as a refusal lists the usable ones. */
function usableStepNames(item: Item): string[] {
  return listStepsForPipeline(handle.db, item.pipelineId!)
    .filter((step) => !step.isTerminal)
    .map((step) => step.name);
}

function rawEdge(itemId: string, dependsOnId: string) {
  return handle.db
    .select()
    .from(itemDeps)
    .all()
    .find((row) => row.itemId === itemId && row.dependsOnId === dependsOnId);
}

function engineComments(item: Item): string[] {
  return listCommentsForItem(handle.db, item.id)
    .filter((comment) => comment.authorType === "engine")
    .map((comment) => comment.body);
}

describe("adding a dependency with a rule", () => {
  it("stores the step's id for wait: reached, and item_get reads the rule and the step's name back", () => {
    const answer = updateItemText(handle.db, { itemId: release.id, addDependsOn: [{ item: story.key, wait: "reached", step: reviewName() }] });

    expect(answer).toMatchObject({ updated: true, problem: null, dependencies: { added: [story.key], removed: [], stillWaitsFor: [story.key] } });
    expect(rawEdge(release.id, story.id)).toMatchObject({ wait: "reached", waitStepId: "review" });

    const sections = getItemSections(handle.db, { itemId: release.id, include: ["dependsOn"] });
    expect(sections?.dependsOn).toEqual([
      expect.objectContaining({ key: story.key, wait: "reached", waitStepId: "review", waitStepName: reviewName() }),
    ]);
  });

  it("takes a step name in any case, and a bare key as wait: finished beside it", () => {
    updateItemText(handle.db, { itemId: release.id, addDependsOn: [other.key, { item: story.key, wait: "reached", step: reviewName().toUpperCase() }] });

    expect(rawEdge(release.id, other.id)).toMatchObject({ wait: "finished", waitStepId: null });
    expect(rawEdge(release.id, story.id)).toMatchObject({ wait: "reached", waitStepId: "review" });
  });

  it("writes wait: none with no step, and an item waiting only by it is not held", () => {
    const answer = updateItemText(handle.db, { itemId: release.id, addDependsOn: [{ item: story.key, wait: "none" }] });

    expect(answer.dependencies?.stillWaitsFor).toEqual([]);
    expect(rawEdge(release.id, story.id)).toMatchObject({ wait: "none", waitStepId: null });
  });

  it("states each new rule in words in the one comment it leaves", () => {
    updateItemText(handle.db, {
      itemId: release.id,
      addDependsOn: [other.key, { item: story.key, wait: "reached", step: reviewName() }],
    });

    const [said] = engineComments(release);
    expect(said).toContain(`Now waits for: ${other.key} (${other.title})`);
    expect(said).toContain(`Now waits for ${story.key} (${story.title}) to reach ${reviewName()}.`);
  });
});

describe("changing the rule of an edge that exists", () => {
  it("rewrites the gate, says the old and the new rule in words, and adds no edge", () => {
    addDependency(handle.db, release.id, story.id);

    const answer = updateItemText(handle.db, { itemId: release.id, updateDependsOn: [{ item: story.key, wait: "reached", step: reviewName() }] });

    expect(answer).toMatchObject({ updated: true, problem: null, dependencies: { added: [], removed: [], updated: [story.key] } });
    expect(listDependencies(handle.db, release.id)).toEqual([expect.objectContaining({ dependsOnId: story.id, wait: "reached", waitStepId: "review" })]);
    const [said] = engineComments(release);
    expect(said).toContain(`Now waits for ${story.key} (${story.title}) to reach ${reviewName()} — before, it waits for ${story.key} (${story.title}) to finish.`);
  });

  it("frees an item when its only open edge stops waiting, and says so", () => {
    addDependency(handle.db, release.id, story.id);

    const answer = updateItemText(handle.db, { itemId: release.id, updateDependsOn: [{ item: story.key, wait: "none" }] });

    expect(answer.dependencies).toMatchObject({ updated: [story.key], stillWaitsFor: [], freed: true });
    expect(engineComments(release)[0]).toContain(`Now links to ${story.key} (${story.title}) without waiting for it`);
  });

  it("counts an edge released by an arrival as no longer held", () => {
    addDependency(handle.db, release.id, story.id);
    transitionItem(handle.db, { itemId: story.id, toStepId: "review", actor: "human", reason: "reviewing" });

    const answer = updateItemText(handle.db, { itemId: release.id, updateDependsOn: [{ item: story.key, wait: "reached", step: reviewName() }] });

    expect(answer.dependencies).toMatchObject({ stillWaitsFor: [], freed: true });
  });

  it("writes nothing and says nothing where the rule asked for is the one it has", () => {
    addDependency(handle.db, release.id, story.id);

    const answer = updateItemText(handle.db, { itemId: release.id, updateDependsOn: [{ item: story.key, wait: "finished" }] });

    expect(answer).toEqual({ updated: false, problem: null });
    expect(engineComments(release)).toEqual([]);
  });

  it("is refused for an edge that does not exist, pointing at addDependsOn", () => {
    const answer = updateItemText(handle.db, { itemId: release.id, updateDependsOn: [{ item: story.key, wait: "none" }] });

    expect(answer).toEqual({
      updated: false,
      problem: `${release.key} does not wait for ${story.key}, so there is no rule to change. Add it with addDependsOn instead.`,
    });
    expect(listAllDependencies(handle.db)).toEqual([]);
  });

  it("leaves addDependsOn refusing an edge that exists, whatever rule it asks for", () => {
    addDependency(handle.db, release.id, story.id);

    const answer = updateItemText(handle.db, { itemId: release.id, addDependsOn: [{ item: story.key, wait: "none" }] });

    expect(answer.updated).toBe(false);
    expect(answer.problem).toBe(`${release.key} already waits for ${story.key}. To change the rule it waits by, name it in updateDependsOn instead.`);
    expect(rawEdge(release.id, story.id)).toMatchObject({ wait: "finished" });
  });

  it("is refused for an item named both to change and to remove", () => {
    addDependency(handle.db, release.id, story.id);

    const answer = updateItemText(handle.db, { itemId: release.id, removeDependsOn: [story.key], updateDependsOn: [{ item: story.key, wait: "none" }] });

    expect(answer.problem).toContain(`${story.key} is named both to change and to remove`);
    expect(rawEdge(release.id, story.id)).toMatchObject({ wait: "finished" });
  });
});

describe("a rule that cannot be written", () => {
  /** Refused, with the graph, the title sent alongside and the thread exactly as they were. */
  function refused(request: Pick<IpcPayload<"items:update">, "addDependsOn" | "updateDependsOn" | "removeDependsOn">): string {
    addDependency(handle.db, release.id, other.id);
    const edges = listAllDependencies(handle.db);
    const comments = listCommentsForItem(handle.db, release.id).length;

    const answer = updateItemText(handle.db, { itemId: release.id, title: "Renamed", ...request });

    expect(answer.updated).toBe(false);
    expect(listAllDependencies(handle.db)).toEqual(edges);
    expect(getItemByKey(handle.db, release.key)?.title).toBe("Release 2.4");
    expect(listCommentsForItem(handle.db, release.id)).toHaveLength(comments);
    return answer.problem ?? "";
  }

  it("refuses a step not on the dependency's pipeline, naming the item and listing its steps, and writes nothing", () => {
    const problem = refused({ removeDependsOn: [other.key], addDependsOn: [{ item: story.key, wait: "reached", step: "Deploy" }] });

    expect(problem).toContain(`${story.key}'s pipeline has no step "Deploy"`);
    for (const name of usableStepNames(story)) expect(problem).toContain(`"${name}"`);
  });

  it("refuses the same on updateDependsOn", () => {
    const problem = refused({ updateDependsOn: [{ item: other.key, wait: "reached", step: "Deploy" }] });

    expect(problem).toContain(`${other.key}'s pipeline has no step "Deploy"`);
    expect(rawEdge(release.id, other.id)).toMatchObject({ wait: "finished", waitStepId: null });
  });

  it("refuses the terminal step, pointing to wait: finished", () => {
    const terminal = getStep(handle.db, "ready_to_merge")!.name;
    const problem = refused({ addDependsOn: [{ item: story.key, wait: "reached", step: terminal }] });

    expect(problem).toBe(
      `"${terminal}" is where ${story.key}'s pipeline finishes, so reaching it is finishing — use wait: "finished" (or leave wait out) to wait for ${story.key} to finish.`,
    );
  });

  it("refuses wait: reached with no step, listing the steps it could name", () => {
    const problem = refused({ addDependsOn: [{ item: story.key, wait: "reached" }] });

    expect(problem).toContain(`wait: "reached" needs the step of ${story.key}'s pipeline to wait for`);
    expect(problem).toContain(`"${reviewName()}"`);
  });

  it.each(["none", "finished"] as const)("refuses a step with wait: %s", (wait) => {
    const problem = refused({ addDependsOn: [{ item: story.key, wait, step: reviewName() }] });

    expect(problem).toBe(
      `A step goes only with wait: "reached", and the rule for ${story.key} is wait: "${wait}". Leave step out, or use wait: "reached" to wait for ${story.key} to reach it.`,
    );
  });

  it.each(["none", "finished"] as const)("refuses a blank step with wait: %s, through the contract as well as behind it", async (wait) => {
    const entry = { item: story.key, wait, step: "   " };
    // The contract lets it through — it is a string — so the judge is
    // what refuses it, and must.
    expect(ipcContract["items:update"].request.safeParse({ itemId: release.id, addDependsOn: [entry] }).success).toBe(true);

    expect(refused({ addDependsOn: [entry] })).toContain(`A step goes only with wait: "reached", and the rule for ${story.key} is wait: "${wait}".`);
    const update = updateItemText(handle.db, { itemId: release.id, updateDependsOn: [{ item: other.key, wait, step: "  " }] });
    expect(update.problem).toContain(`the rule for ${other.key} is wait: "${wait}"`);
    expect(rawEdge(release.id, other.id)).toMatchObject({ wait: "finished", waitStepId: null });

    const platform = fakePlatform();
    const { registerAllHandlers } = await import("../ipc/handlers.js");
    registerAllHandlers(handle.db, undefined, { platform });
    try {
      const answer = await answerToolCall({ name: "item_update", arguments: { itemId: release.key, addDependsOn: [entry] } }, "admin", true);
      // A refusal is an answer, not an error: it says nothing changed, and why.
      const text = answer.content.map((part) => ("text" in part ? part.text : "")).join("");
      expect(text).toContain(`the rule for ${story.key} is wait: "${wait}". Leave step out`);
      expect(text).toContain("Nothing has changed.");
      expect(rawEdge(release.id, story.id)).toBeUndefined();
    } finally {
      rmSync(platform.userDataPath, { recursive: true, force: true });
    }
  });

  it("refuses one item named twice with two different rules", () => {
    const problem = refused({ addDependsOn: [story.key, { item: story.key, wait: "none" }] });

    expect(problem).toContain(`${story.key} is named twice with two different rules`);
  });
});

describe("the contract and the tool", () => {
  it("takes a bare key or the object form, and updateDependsOn only in the object form", () => {
    const request = ipcContract["items:update"].request;
    expect(request.safeParse({ itemId: "x", addDependsOn: ["EO-1", { item: "EO-2", wait: "reached", step: "Review" }, { item: "EO-3", wait: "none" }] }).success).toBe(true);
    expect(request.safeParse({ itemId: "x", addDependsOn: [{ item: "EO-2", wait: "soon" }] }).success).toBe(false);
    expect(request.safeParse({ itemId: "x", updateDependsOn: [{ item: "EO-2", wait: "none" }] }).success).toBe(true);
    expect(request.safeParse({ itemId: "x", updateDependsOn: ["EO-2"] }).success).toBe(false);
  });

  it("sets and changes a rule through item_update, and item_get shows it", async () => {
    const platform = fakePlatform();
    const { registerAllHandlers } = await import("../ipc/handlers.js");
    registerAllHandlers(handle.db, undefined, { platform });
    try {
      const added = await answerToolCall({ name: "item_update", arguments: { itemId: release.key, addDependsOn: [{ item: story.key, wait: "reached", step: reviewName() }] } }, "admin", true);
      expect(added.isError).toBe(false);
      expect(JSON.stringify(added.content)).toContain(`It now waits for ${story.key}.`);

      const read = await answerToolCall({ name: "item_get", arguments: { itemId: release.key, include: ["dependsOn"] } }, "admin", true);
      expect(JSON.stringify(read.content)).toContain(`wait: \\"reached\\", step: \\"${reviewName()}\\"`);

      const changed = await answerToolCall({ name: "item_update", arguments: { itemId: release.key, updateDependsOn: [{ item: story.key, wait: "none" }] } }, "admin", true);
      expect(JSON.stringify(changed.content)).toContain(`The rule it waits by changed for ${story.key}.`);
      expect(rawEdge(release.id, story.id)).toMatchObject({ wait: "none", waitStepId: null });
    } finally {
      rmSync(platform.userDataPath, { recursive: true, force: true });
    }
  });
});

describe("what a module reads", () => {
  it("gives ctx.item()'s dependsOn the rule and the step's name", () => {
    addDependency(handle.db, release.id, story.id, { wait: "reached", stepId: "review" });
    addDependency(handle.db, release.id, other.id, { wait: "none" });

    const view = moduleItemView(handle.db, getItemByKey(handle.db, release.key)!, null);

    expect(view.dependsOn).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: story.key, wait: "reached", waitStep: reviewName() }),
        expect.objectContaining({ key: other.key, wait: "none", waitStep: null }),
      ]),
    );
  });
});

describe("a plan's stories", () => {
  const planned = (title: string, depends_on: IpcPayload<"work:submitPlan">["stories"][number]["depends_on"] = []) => ({
    title,
    body: `Body for ${title}`,
    acceptance_criteria: [`${title} is demonstrably done`],
    depends_on,
    touches: [],
  });
  const plan = (stories: ReturnType<typeof planned>[]): IpcPayload<"work:submitPlan"> => ({
    title: "Rate limit the importer",
    understanding: "Cap it.",
    decisions: [],
    stories,
  });

  it("writes { story, wait, step } as a gate on that story's step, and a bare index as finished", () => {
    const result = submitPlan(
      handle.db,
      undefined,
      plan([planned("Groundwork"), planned("Builds on it", [{ story: 0, wait: "reached", step: reviewName() }]), planned("Last", [0, { story: 1, wait: "none" }])]),
    );

    expect(result.problem).toBeNull();
    const [first, second, third] = result.storyKeys.map((key) => getItemByKey(handle.db, key)!);
    expect(rawEdge(second!.id, first!.id)).toMatchObject({ wait: "reached", waitStepId: "review" });
    expect(rawEdge(third!.id, first!.id)).toMatchObject({ wait: "finished", waitStepId: null });
    expect(rawEdge(third!.id, second!.id)).toMatchObject({ wait: "none", waitStepId: null });
  });

  it("refuses a step the plan's pipeline does not have, naming the story and listing the steps, and creates nothing", () => {
    const before = listAllDependencies(handle.db).length;
    const result = submitPlan(handle.db, undefined, plan([planned("Groundwork"), planned("Builds on it", [{ story: 0, wait: "reached", step: "Deploy" }])]));

    expect(result.created).toBe(false);
    expect(result.problem).toContain(`"Builds on it" cannot wait as it asks.`);
    expect(result.problem).toContain(`"Groundwork" (story 0 of the plan)'s pipeline has no step "Deploy"`);
    expect(result.problem).toContain(`"${reviewName()}"`);
    expect(listAllDependencies(handle.db)).toHaveLength(before);
    expect(getItemByKey(handle.db, "EO-4")).toBeUndefined();
  });

  it("judges every entry naming a story, not only the first, and creates nothing when a later one cannot be written", () => {
    const before = listAllDependencies(handle.db).length;
    const result = submitPlan(handle.db, undefined, plan([planned("Groundwork"), planned("Builds on it", [0, { story: 0, wait: "reached", step: "Nonexistent" }])]));

    expect(result.created).toBe(false);
    expect(result.problem).toContain(`"Groundwork" (story 0 of the plan)'s pipeline has no step "Nonexistent"`);
    expect(listAllDependencies(handle.db)).toHaveLength(before);
    expect(getItemByKey(handle.db, "EO-4")).toBeUndefined();
  });

  it("refuses one story named twice with two different rules, and creates nothing", () => {
    const before = listAllDependencies(handle.db).length;
    const result = submitPlan(handle.db, undefined, plan([planned("Groundwork"), planned("Builds on it", [0, { story: 0, wait: "reached", step: reviewName() }])]));

    expect(result.created).toBe(false);
    expect(result.problem).toBe(`"Builds on it" names "Groundwork" (story 0 of the plan) twice with two different rules, so it is not clear what it should wait for.`);
    expect(listAllDependencies(handle.db)).toHaveLength(before);
    expect(getItemByKey(handle.db, "EO-4")).toBeUndefined();
  });

  it("takes one story named twice with the same rule as one edge", () => {
    const result = submitPlan(handle.db, undefined, plan([planned("Groundwork"), planned("Builds on it", [{ story: 0, wait: "none" }, { story: 0, wait: "none" }])]));

    expect(result.problem).toBeNull();
    const [first, second] = result.storyKeys.map((key) => getItemByKey(handle.db, key)!);
    expect(listDependencies(handle.db, second!.id)).toHaveLength(1);
    expect(rawEdge(second!.id, first!.id)).toMatchObject({ wait: "none" });
  });
});

describe("a reached rule that can release an item onto an empty branch (EO-780)", () => {
  let child: Item;
  let parent: Item;

  beforeEach(() => {
    const repository = attachWorkspace(handle.db, { name: "api", keyPrefix: "API", repoPath: "/nowhere/api", baseBranch: "main" });
    child = createTestItem(handle.db, { type: "story", title: "Child", stepId: "todo", workspaceId: repository.id });
    parent = createTestItem(handle.db, { type: "story", title: "Parent", stepId: "worktree", workspaceId: repository.id });
  });

  it("warns in the answer and in the engine comment, and still writes the edge, for a step reachable without implementing", () => {
    // The seeded Delivery runs Worktree, then Index, then To Do — the step
    // that implements — so arriving at To Do is arriving before anything
    // is written.
    const toDo = getStep(handle.db, "todo")!.name;
    const answer = updateItemText(handle.db, { itemId: child.id, addDependsOn: [{ item: parent.key, wait: "reached", step: toDo }] });

    expect(answer).toMatchObject({ updated: true, problem: null, dependencies: { added: [parent.key] } });
    const warnings = answer.dependencies?.warnings ?? [];
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(parent.key);
    expect(warnings[0]).toContain(`"${toDo}"`);
    expect(rawEdge(child.id, parent.id)).toMatchObject({ wait: "reached", waitStepId: "todo" });
    expect(engineComments(child).at(-1)).toContain(`Warning: ${warnings[0]}`);
  });

  it("warns for a rule changed to such a step too", () => {
    addDependency(handle.db, child.id, parent.id);
    const answer = updateItemText(handle.db, { itemId: child.id, updateDependsOn: [{ item: parent.key, wait: "reached", step: getStep(handle.db, "repository_index")!.name }] });

    expect(answer.dependencies?.warnings).toHaveLength(1);
  });

  it("says nothing for a step after the implementation, or outside a git repository", () => {
    const answer = updateItemText(handle.db, { itemId: child.id, addDependsOn: [{ item: parent.key, wait: "reached", step: reviewName() }] });
    expect(answer.dependencies).not.toHaveProperty("warnings");
    expect(engineComments(child).at(-1)).not.toContain("Warning:");

    const elsewhere = updateItemText(handle.db, { itemId: release.id, addDependsOn: [{ item: story.key, wait: "reached", step: getStep(handle.db, "todo")!.name }] });
    expect(elsewhere.dependencies).not.toHaveProperty("warnings");
  });
});
