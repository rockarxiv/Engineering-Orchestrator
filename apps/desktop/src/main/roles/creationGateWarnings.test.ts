import type { IpcPayload, Item } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { getItemByKey, getStep, listCommentsForItem, listDependencies } from "../db/repos/index.js";
import { attachWorkspace, openMigratedTestDb } from "../db/testHelpers.js";
import { submitItem } from "../ipc/itemCommands.js";
import { submitPlan } from "../ipc/planCommands.js";

/**
 * The warning a `reached` rule earns when its step can be reached before
 * anything is implemented (EO-780), through the doors that write edges
 * as they create: a single item handed over (`work:submitItem`, which a
 * module's creation and an approved proposal share through
 * `applyNewItem`) and a plan's stories (`work:submitPlan`). The change
 * door's half is in `itemDependencyGates.test.ts`.
 *
 * Every item here is in a git repository on the seeded Delivery, which
 * runs Worktree, then Index, then To Do — the step that implements.
 */

let handle: DbHandle;

beforeEach(() => {
  handle = openMigratedTestDb();
  attachWorkspace(handle.db, { name: "api", keyPrefix: "API", repoPath: "/nowhere/api", baseBranch: "main" });
});

afterEach(() => {
  handle.close();
});

const stepName = (id: string): string => getStep(handle.db, id)!.name;

function story(title: string, dependsOn: IpcPayload<"work:submitItem">["dependsOn"] = []): IpcPayload<"work:submitItem"> {
  return {
    type: "story",
    title,
    body: `Body for ${title}`,
    acceptanceCriteria: [`${title} is demonstrably done`],
    touches: [],
    dependsOn,
    stepsToReproduce: "",
    expected: "",
    actual: "",
    environment: "",
  };
}

function engineNotes(item: Item): string[] {
  return listCommentsForItem(handle.db, item.id)
    .filter((comment) => comment.authorType === "engine")
    .map((comment) => comment.body);
}

describe("a single item handed over", () => {
  it("warns in the answer and in an engine comment, and still writes the edge, for a step reachable without implementing", () => {
    const parent = getItemByKey(handle.db, submitItem(handle.db, undefined, story("Parent")).key!)!;

    const answer = submitItem(handle.db, undefined, story("Child", [{ item: parent.key, wait: "reached", step: stepName("todo") }]));

    expect(answer).toMatchObject({ created: true, problem: null });
    expect(answer.warnings).toHaveLength(1);
    expect(answer.warnings![0]).toContain(parent.key);
    expect(answer.warnings![0]).toContain(`"${stepName("todo")}"`);
    const child = getItemByKey(handle.db, answer.key!)!;
    expect(listDependencies(handle.db, child.id)).toEqual([expect.objectContaining({ dependsOnId: parent.id, wait: "reached", waitStepId: "todo" })]);
    expect(engineNotes(child).some((body) => body.includes(`Warning: ${answer.warnings![0]}`))).toBe(true);
  });

  it("says nothing for a step after the implementation", () => {
    const parent = getItemByKey(handle.db, submitItem(handle.db, undefined, story("Parent")).key!)!;

    const answer = submitItem(handle.db, undefined, story("Child", [{ item: parent.key, wait: "reached", step: stepName("review") }]));

    expect(answer.created).toBe(true);
    expect(answer).not.toHaveProperty("warnings");
    expect(engineNotes(getItemByKey(handle.db, answer.key!)!).some((body) => body.includes("Warning:"))).toBe(false);
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
  const plan = (stories: ReturnType<typeof planned>[]): IpcPayload<"work:submitPlan"> => ({ title: "Rate limit the importer", understanding: "Cap it.", decisions: [], stories });

  it("warns in the answer and on the story, and still writes the edge, for a child gated on its parent's step before implementing", () => {
    const answer = submitPlan(handle.db, undefined, plan([planned("Groundwork"), planned("Builds on it", [{ story: 0, wait: "reached", step: stepName("repository_index") }])]));

    expect(answer).toMatchObject({ created: true, problem: null });
    const [first, second] = answer.storyKeys.map((key) => getItemByKey(handle.db, key)!);
    expect(answer.warnings).toHaveLength(1);
    expect(answer.warnings![0]).toContain(first!.key);
    expect(listDependencies(handle.db, second!.id)).toEqual([expect.objectContaining({ dependsOnId: first!.id, wait: "reached", waitStepId: "repository_index" })]);
    expect(engineNotes(second!).some((body) => body.includes(`Warning: ${answer.warnings![0]}`))).toBe(true);
    expect(engineNotes(first!).some((body) => body.includes("Warning:"))).toBe(false);
  });

  it("says nothing for a plan whose rules wait past the implementation", () => {
    const answer = submitPlan(handle.db, undefined, plan([planned("Groundwork"), planned("Builds on it", [{ story: 0, wait: "reached", step: stepName("review") }])]));

    expect(answer.created).toBe(true);
    expect(answer).not.toHaveProperty("warnings");
  });
});
