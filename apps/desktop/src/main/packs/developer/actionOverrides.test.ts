import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { developerRegistry, EMPTY_SPEC_SHAPE, refineOutputSchemaFor, resultSchemaFor, schemaByAction, type Item, type ItemTypeEntry } from "@eo/core";
import type { DbHandle } from "../../db/client.js";
import { createRoute, createStep, getItem, getItemType, listCommentsForItem, listItems, listRunsForItem, syncItemTypes } from "../../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../../db/testHelpers.js";
import { createScriptedProvider } from "../../providers/scripted.js";
import { buildDispatchContext } from "../../supervisor/buildDispatchContext.js";
import { createRunSupervisor } from "../../supervisor/runSupervisor.js";
import { developerSectionRenderers } from "./sections.js";
import { createRoleWiring } from "./wiring.js";

/**
 * What `refine` means is the item type's answer (KAN-163, ARCHITECTURE.md, "An item type is data").
 *
 * Five sites encoded one sentence — *refine on a container decomposes it
 * and on a leaf clarifies what is already written* — as the schema a
 * result is held to, the prompt an agent is given, the graph check that
 * follows, the key the run routes on and the comment the thread ends up
 * with. The container flag replaced the word `feature` in all five
 * (KAN-146) and was still not enough: a pack may ship a leaf whose
 * `refine` means a third thing, and a flag has no way to say so.
 *
 * So the fact is data on the type row, and this file is what holds the
 * five to it. Three types from a pack nobody wrote, none of which core
 * has heard of:
 *
 * - an `epic` that overrides nothing and is a container, which must be
 *   decomposed because that is what its kind inherits;
 * - a `task` that overrides nothing and is a leaf, which must be checked
 *   for the same reason;
 * - a `spike` that is a leaf and says its `refine` decomposes, which must
 *   be decomposed *against* what its flag would have said.
 *
 * The third is the one the flag could not do, and every assertion about
 * it is an assertion that some site is reading the row rather than the
 * flag. The developer pack's own three types keep their behaviour in
 * `clarify.test.ts`, `refine.test.ts` and `wiring.test.ts`, which is
 * where the regression would show.
 */
const PLANNING = "planning";

const EPIC: ItemTypeEntry = {
  packSlug: PLANNING,
  slug: "epic",
  label: "Epic",
  plural: "Epics",
  container: true,
  specShape: EMPTY_SPEC_SHAPE,
  actionOverrides: {},
};

const TASK: ItemTypeEntry = { ...EPIC, slug: "task", label: "Task", plural: "Tasks", container: false };

/**
 * And the leaf that is decomposed anyway.
 *
 * Written the way a pack writes one: three names the registry can
 * resolve — a schema a role declares, a key its step routes on, and a
 * poster the pack registered. A spike is a plausible reason to want it,
 * since what comes out of one is the work it turned out to imply.
 */
const SPIKE: ItemTypeEntry = {
  ...TASK,
  slug: "spike",
  label: "Spike",
  plural: "Spikes",
  actionOverrides: { refine: { schema: "refine", resultKey: "decomposed", poster: "refine_proposal" } },
};

const CLARIFIED = { ready: true, understanding: "Measure the cost of the third-party call before deciding." };

const PLAN = {
  children: [
    { type: "task", title: "Time the call", body: "Under load.", depends_on: [] },
    { type: "task", title: "Write up what it costs", body: "One page.", depends_on: [0] },
  ],
};

/** The same plan with its two children waiting on each other, which is not a plan. */
const CIRCULAR = {
  children: [
    { type: "task", title: "Time the call", body: "Under load.", depends_on: [1] },
    { type: "task", title: "Write up what it costs", body: "One page.", depends_on: [0] },
  ],
};

describe("what refine means, as the type's own data (KAN-163)", () => {
  let handle: DbHandle;

  beforeEach(() => {
    handle = openMigratedTestDb();
    // The seed path a pack takes at startup rather than hand-written
    // rows: these have to arrive the way a planning pack's types would.
    syncItemTypes(handle.db, [EPIC, TASK, SPIKE]);
    // `refine` is an action rather than a column (ARCHITECTURE.md, "A column is a responsibility,
    // not a status"), so a step that
    // runs it is configured here — exactly what a person could do. The
    // two outcomes go to visibly different places, so "routed as
    // decomposed" cannot pass by accident.
    createStep(handle.db, { id: "plan", pipelineId: "default" as never, position: -1, name: "Refine", type: "agent", ownerRole: "system", entryAction: "refine" });
    createRoute(handle.db, { pipelineId: "default" as never, fromStepId: "plan", resultKey: "decomposed", label: "Decomposed", target: "review", position: 0 });
    createRoute(handle.db, { pipelineId: "default" as never, fromStepId: "plan", resultKey: "clarified", label: "Clarified", target: "todo", position: 1 });
  });

  afterEach(() => {
    handle.close();
  });

  function itemOf(slug: string): Item {
    return createTestItem(handle.db, { type: { packSlug: PLANNING, slug }, title: `A ${slug}`, body: "Something to work out.", stepId: "plan" });
  }

  function supervisorReturning(result: unknown) {
    return createRunSupervisor({
      db: handle.db,
      limits: { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 },
      provider: createScriptedProvider([{ when: (context) => context.includes(`"refine" action`), script: { result } }]),
      ...createRoleWiring(handle.db),
    });
  }

  const typeRowOf = (item: Item) => getItemType(handle.db, item.typeId);

  /** The shape the run is held to — the first of the five sites. */
  describe("the shape the answer is held to", () => {
    it("gives a type that overrides nothing what its kind inherits", () => {
      const registry = developerRegistry();

      expect(resultSchemaFor(registry, "refine", typeRowOf(itemOf("epic")))?.toJsonSchema()).toEqual(
        refineOutputSchemaFor(registry.itemTypes.values()).toJsonSchema(),
      );
      expect(resultSchemaFor(registry, "refine", typeRowOf(itemOf("task")))?.toJsonSchema()).toEqual(schemaByAction(registry, "clarify")?.toJsonSchema());
    });

    it("gives a leaf that says it decomposes the decomposition shape, against its own flag", () => {
      const registry = developerRegistry();

      expect(resultSchemaFor(registry, "refine", typeRowOf(itemOf("spike")))?.toJsonSchema()).toEqual(
        refineOutputSchemaFor(registry.itemTypes.values()).toJsonSchema(),
      );
    });
  });

  /** The prompt — the second — through the assembly that builds a real one. */
  describe("the prompt an agent is given", () => {
    it("tells the product owner not to decompose work that is checked", async () => {
      const context = await buildDispatchContext(handle.db, itemOf("task"), "refine", developerSectionRenderers);

      expect(context).toContain("do not decompose it");
    });

    it("says nothing of the sort to a leaf whose type says it decomposes", async () => {
      const context = await buildDispatchContext(handle.db, itemOf("spike"), "refine", developerSectionRenderers);

      expect(context).not.toContain("do not decompose it");
      // And neither does a container's, which is the case that must not
      // have moved: this is the byte-for-byte prompt it always had.
      expect(await buildDispatchContext(handle.db, itemOf("epic"), "refine", developerSectionRenderers)).not.toContain("do not decompose it");
    });
  });

  /**
   * And the last three together, which is how they are actually met: one
   * run, whose answer is validated, whose graph is walked, which routes
   * somewhere and leaves something in the thread.
   */
  describe("a run against a leaf that overrides nothing", () => {
    it("is checked rather than broken up, and leaves the note that says so", async () => {
      const task = itemOf("task");

      await supervisorReturning(CLARIFIED).runOnce();

      expect(listRunsForItem(handle.db, task.id)[0]?.status).toBe("succeeded");
      expect(getItem(handle.db, task.id)?.stepId).toBe("todo");
      const note = listCommentsForItem(handle.db, task.id).at(-1);
      expect(note?.kind).toBe("note");
      expect(note?.body).toContain("Measure the cost of the third-party call");
      // Nothing was invented under it: the person who wrote it decided.
      expect(listItems(handle.db).filter((candidate) => candidate.id !== task.id)).toEqual([]);
    });

    it("refuses a decomposition, so an agent that ignored the instruction cannot quietly succeed", async () => {
      const task = itemOf("task");

      await supervisorReturning(PLAN).runOnce();

      expect(getItem(handle.db, task.id)?.stepId).toBe("plan");
      expect(listCommentsForItem(handle.db, task.id).some((comment) => comment.kind === "decision")).toBe(false);
    });
  });

  describe("a run against a leaf whose type says refine decomposes", () => {
    it("is decomposed: the plan is posted for approval and the run routes as one", async () => {
      const spike = itemOf("spike");

      await supervisorReturning(PLAN).runOnce();

      expect(listRunsForItem(handle.db, spike.id)[0]?.status).toBe("succeeded");
      // The result key, read off the type row rather than derived from
      // the flag — which would have sent it to `todo` as a clarification.
      expect(getItem(handle.db, spike.id)?.stepId).toBe("review");
      // And the poster the type named, which posts a plan rather than a
      // note: nothing is created until a person approves it.
      const proposal = listCommentsForItem(handle.db, spike.id).find((comment) => comment.kind === "decision");
      expect(proposal?.body).toContain("Time the call");
      expect(listItems(handle.db).filter((candidate) => candidate.id !== spike.id)).toEqual([]);
    });

    it("has its dependency graph walked, which a clarification has none to walk", async () => {
      const spike = itemOf("spike");

      await supervisorReturning(CIRCULAR).runOnce();

      // The check is on the shape that was demanded, not on the kind of
      // item: a leaf answering with a decomposition gets the same walk a
      // container's answer gets, and a cycle deadlocks the scheduler if
      // it reaches the table.
      // The refusal is the graph's, not the schema's: the children
      // parsed, and what stopped the run was the cycle between them.
      expect(listCommentsForItem(handle.db, spike.id).at(-1)?.body).toContain("their dependency graph is invalid");
      expect(getItem(handle.db, spike.id)?.stepId).toBe("plan");
      expect(listItems(handle.db).filter((candidate) => candidate.id !== spike.id)).toEqual([]);
      expect(listCommentsForItem(handle.db, spike.id).some((comment) => comment.kind === "decision")).toBe(false);
    });

    it("refuses the clarification its flag alone would have asked for", async () => {
      const spike = itemOf("spike");

      await supervisorReturning(CLARIFIED).runOnce();

      expect(getItem(handle.db, spike.id)?.stepId).toBe("plan");
      expect(listCommentsForItem(handle.db, spike.id).some((comment) => comment.body.includes("Ready to implement"))).toBe(false);
    });
  });

  describe("a run against a container that overrides nothing", () => {
    it("is decomposed, exactly as a feature is", async () => {
      const epic = itemOf("epic");

      await supervisorReturning(PLAN).runOnce();

      expect(listRunsForItem(handle.db, epic.id)[0]?.status).toBe("succeeded");
      expect(getItem(handle.db, epic.id)?.stepId).toBe("review");
      expect(listCommentsForItem(handle.db, epic.id).find((comment) => comment.kind === "decision")?.body).toContain("Time the call");
    });
  });
});
