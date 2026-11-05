import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { refineOutputSchemaFor, EMPTY_SPEC_SHAPE, developerRegistry, schemaByAction, resultSchemaFor, type ItemTypeEntry, type Item, type Uuid } from "@eo/core";
import type { DbHandle } from "../../db/client.js";
import {
  createRoute,
  createStep,
  deleteItem,
  getItem,
  itemWithDescendants,
  listPipelineSteps,
  listPipelines,
  listProjects,
  syncItemTypes,
} from "../../db/repos/index.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../../db/testHelpers.js";
import { createRoleWiring } from "./wiring.js";
import { openPullRequestForItem } from "./forge/openForItem.js";
import { applyNewItem } from "../../roles/discussion.js";

/**
 * A container is whatever a type row says is one (KAN-146, ARCHITECTURE.md, "An item type is
 * data").
 *
 * Fourteen sites used to ask whether an item's type was the word
 * `feature`. They ask the type's own `container` flag now, and the point
 * of the exercise is that a container nobody hard-coded behaves like the
 * one everybody did — so this walks a second pack's `epic` through every
 * behaviour the flag decides and asks for the feature's answer each time.
 *
 * One file rather than a case added to each of the fourteen modules'
 * tests, deliberately: what is being tested is not any one of those
 * branches but that they *agree*. A story that converted thirteen and
 * missed one would leave an Epic that decomposes and then opens a pull
 * request for itself, and the only test that fails is one that walks the
 * whole way through.
 *
 * The behaviours each module's own tests still cover for a feature, which
 * is what keeps the developer flow honest: this file is about the second
 * container, not a second copy of the first one's coverage.
 *
 * **Why it lives in the pack.** Two of the four behaviours are the
 * developer pack's own — the refine routing in `wiring.ts` and the pull
 * request in `forge/` — so a file outside `packs/developer/` walking them
 * would have to be added to `importAllowlist.test.ts`, and that list only
 * shrinks (invariant 13). The flag itself belongs to core and is tested
 * there: `db/repos/itemTypesRepo.test.ts` for the row and
 * `itemCommands.test.ts` for the channels.
 */
const EPIC: ItemTypeEntry = {
  packSlug: "planning",
  slug: "epic",
  label: "Epic",
  plural: "Epics",
  container: true,
  specShape: EMPTY_SPEC_SHAPE,
  actionOverrides: {},
};

/** And a leaf from the same pack, so "not a container" is not "not this pack". */
const TASK: ItemTypeEntry = {
  packSlug: "planning",
  slug: "task",
  label: "Task",
  plural: "Tasks",
  container: false,
  specShape: EMPTY_SPEC_SHAPE,
  actionOverrides: {},
};

/** A forge nobody is allowed to reach: every case here stops before one. */
const unreachable = async (_cli: string, args: string[]): Promise<never> => {
  throw new Error(`the forge should not have been reached: ${args.join(" ")}`);
};

describe("a container type the code never heard of (KAN-146)", () => {
  let handle: DbHandle;
  let projectId: Uuid;

  beforeEach(() => {
    handle = openMigratedTestDb();
    attachWorkspace(handle.db, { name: "acme-api", keyPrefix: "API", repoPath: "/tmp/eo-container-type", baseBranch: "main" });
    projectId = listProjects(handle.db)[0]!.id;
    // The seed path a pack takes at startup, not a hand-written row: an
    // Epic has to arrive the way a support or planning pack's type would.
    const report = syncItemTypes(handle.db, [EPIC, TASK]);
    expect(report.created).toContain("planning:epic");
  });

  afterEach(() => {
    handle.close();
  });

  // Off-board, which is where a container sits (ARCHITECTURE.md, "One work entity"): it is not
  // work, so
  // it is on no pipeline. The one test that needs a step to route from
  // says so.
  function epic(overrides: Partial<Parameters<typeof createTestItem>[1]> = {}): Item {
    return createTestItem(handle.db, {
      type: { packSlug: "planning", slug: "epic" },
      projectId,
      title: "Quarterly rate limiting",
      stepId: null,
      ...overrides,
    });
  }

  function feature(overrides: Partial<Parameters<typeof createTestItem>[1]> = {}): Item {
    return createTestItem(handle.db, { type: "feature", projectId, title: "Rate limit the API", stepId: null, ...overrides });
  }

  function task(overrides: Partial<Parameters<typeof createTestItem>[1]> = {}): Item {
    return createTestItem(handle.db, { type: { packSlug: "planning", slug: "task" }, projectId, title: "One task", stepId: "todo", ...overrides });
  }

  /**
   * A step that declares both of refine's outcomes, going to visibly
   * different places.
   *
   * The shipped pipeline has no such step — decomposition moved into
   * Discussions (migration 0030) — so the routing has to be asked of a
   * pipeline that has one, which is also the case a pack shipping its own
   * pipeline is. Different targets, so "routed as decomposed" cannot pass
   * by accident.
   */
  function refineStep(): { step: ReturnType<typeof createStep>; steps: ReturnType<typeof listPipelineSteps> } {
    const pipelineId = listPipelines(handle.db)[0]!.id;
    const step = createStep(handle.db, { pipelineId, id: "planning", position: 9, name: "Planning", ownerRole: "product-owner", entryAction: "refine" });
    createRoute(handle.db, { pipelineId, fromStepId: step.id, resultKey: "decomposed", label: "Decomposed", target: "review" });
    createRoute(handle.db, { pipelineId, fromStepId: step.id, resultKey: "clarified", label: "Clarified", target: "todo" });
    return { step, steps: listPipelineSteps(handle.db) };
  }

  it("says it is a container on the item itself, wherever the item is read", () => {
    const one = epic();

    // The flag rides on the row's join (KAN-146), so every reader — the
    // renderer, the engine's item view, the fourteen branches — is
    // holding it already and none has to look the type up again.
    expect(one.container).toBe(true);
    expect(getItem(handle.db, one.id)?.container).toBe(true);
    expect(task().container).toBe(false);
  });

  /**
   * Decomposing: `refine` on it produces a graph of work for a human to
   * approve, and routes where a refined feature routes.
   */
  it("decomposes, and routes where a refined feature routes", () => {
    const { step, steps } = refineStep();
    const plan = {
      stories: [{ title: "Return 429 past the limit", body: "…", acceptance_criteria: ["429 after 100/min"], depends_on: [], touches: [] }],
    };

    const wiring = createRoleWiring(handle.db);
    const forEpic = wiring.resolveNextState(step, steps, plan, "refine", epic({ stepId: step.id }));
    const forFeature = wiring.resolveNextState(step, steps, plan, "refine", feature({ stepId: step.id }));
    const forTask = wiring.resolveNextState(step, steps, plan, "refine", task({ stepId: step.id }));

    expect(forEpic).toEqual(forFeature);
    expect(forEpic).toMatchObject({ stepId: "review" });
    // Work is *checked* rather than broken up, and takes the other route
    // — so the flag is deciding this and not the action alone.
    expect(forTask).toMatchObject({ stepId: "todo" });
  });

  it("is asked for a decomposition rather than for a yes", () => {
    const registry = developerRegistry();

    // `refine` is two actions wearing one name (KAN-19), and which one an
    // item gets is the type's answer now rather than the word's — and
    // neither of these two overrides a thing, so each is inheriting the
    // default its kind carries (KAN-163). The
    // decomposition half is composed from the project's work types since
    // KAN-147, so what a container is asked for is that document —
    // children of a stated type — and not the story shape the pack
    // registers as its fallback.
    expect(resultSchemaFor(registry, "refine", EPIC)?.toJsonSchema()).toEqual(refineOutputSchemaFor(registry.itemTypes.values()).toJsonSchema());
    expect(resultSchemaFor(registry, "refine", TASK)?.toJsonSchema()).toEqual(schemaByAction(registry, "clarify")?.toJsonSchema());
  });

  /** No changes of its own, so the forge is never reached (EO-9/EO-7). */
  it("refuses a pull request without asking the forge", async () => {
    const outcome = await openPullRequestForItem(handle.db, epic({ git: { branch: "eo/API-1" } }), { run: unreachable });

    expect(outcome).toMatchObject({ kind: "skipped" });
    expect(outcome).toMatchObject({ detail: expect.stringContaining("nothing to open a pull request for") });
  });

  /** Children may be filed under it; under work they may not. */
  it("holds work under it, and a leaf type does not", () => {
    const parent = epic();
    // A hand-over, which is what both creation doors now pass (KAN-147):
    // the type it is, and the spec that type's shape asked for.
    const proposal = {
      type: "story",
      title: "Return 429 past the limit",
      body: "…",
      spec: { acceptance_criteria: ["429 after 100 requests in a minute"] },
      depends_on: [],
      parent: parent.key,
    };

    const filed = applyNewItem(handle.db, projectId, proposal, null);
    expect(filed.ok).toBe(true);
    expect(filed.ok && filed.created[0]?.parentId).toBe(parent.id);

    const leaf = task();
    const refused = applyNewItem(handle.db, projectId, { ...proposal, parent: leaf.key }, null);
    expect(refused).toMatchObject({ ok: false });
    expect(refused.ok === false && refused.reason).toContain("not a container");
  });

  /** And it takes them with it when it goes (KAN-30). */
  it("cascades on delete", () => {
    const parent = epic();
    const child = createTestItem(handle.db, { type: "story", projectId, parentId: parent.id, title: "Return 429 past the limit", stepId: "todo" });

    expect(itemWithDescendants(handle.db, parent.id)).toEqual([parent.id, child.id]);

    const removed = deleteItem(handle.db, parent.id);

    expect(removed.deletedItemIds).toEqual([parent.id, child.id]);
    expect(getItem(handle.db, parent.id)).toBeUndefined();
    expect(getItem(handle.db, child.id)).toBeUndefined();
  });
});
