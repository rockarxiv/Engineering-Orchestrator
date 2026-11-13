import type { PipelineStep, Item, Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestItem, openMigratedTestDb } from "../../db/testHelpers.js";
import type { DbHandle } from "../../db/client.js";
import { syncItemTypes } from "../../db/repos/index.js";
import { createDispatchGate } from "./scheduling.js";


/** Any `item_types` row: these fixtures never read the type's row, only the word on it. */
const STORY_TYPE_ID = "0199aa00-0000-7000-8000-000000000001" as Uuid;
/**
 * The scheduling decision this pack makes for the engine (platform
 * ARCHITECTURE.md, "The core is domain-neutral", KAN-161).
 *
 * The scheduler used to make it itself: it refused a review of an item
 * with no acceptance criteria, which is not true of an installation that
 * is not about software, so it moved here — unchanged, which is what
 * these hold it to.
 *
 * There were two. Which bucket a run consumes left again in EO-296, one
 * level further down: **concurrency is per shared filesystem**, so the
 * question belongs to the thing that prepares a filesystem rather than
 * to the pack as a whole. `workspaceKinds.test.ts` is where it is held
 * now, and the empty-string bucket every workspace-less item shared went
 * with the process directory they all used to run in.
 */

function item(overrides: Partial<Item> = {}): Item {
  return {
    id: "t-1" as Uuid,
    key: "EO-1",
    typeId: STORY_TYPE_ID,
    type: "story",
    typeLabel: "Story",
    container: false,
    parentId: null,
    workspaceId: null,
    projectId: null,
    title: "A story",
    body: null,
    spec: null,
    pipelineId: "p1" as Uuid,
    stepId: "review",
    pipelineVersionId: null,
    priority: 0,
    extensions: {},
    archivedAt: null,
    heldAt: null,
    previewAt: null,
    trialAt: null,
    createdBy: null,
    assigneeId: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function step(overrides: Partial<PipelineStep> = {}): PipelineStep {
  return {
    id: "review",
    pipelineId: "p1" as Uuid,
    position: 1,
    name: "Review",
    type: "agent",
    ownerRole: "reviewer",
    entryAction: "review",
    instructionsSummary: null,
    isTerminal: false,
    planMode: false,
    workspaceMode: "isolated",
    workspaceId: null,
    offBoard: false,
    inputs: {},
    timeoutMs: null,
    watch: null,
    ownerPersonId: null,
    ownerGroupId: null,
    results: [],
    moduleVersion: null,
    ...overrides,
  };
}

describe("what this pack requires before a step runs", () => {
  const declaring = (...criteria: string[]): Partial<Item> => ({ spec: { acceptance_criteria: criteria } });

  // The gate asks the item's type which field holds its criteria
  // (KAN-147), so it is built with a database. These fixtures name a
  // type row that does not exist, which falls back to the name every
  // item written before that story used — `acceptance_criteria`.
  let handle: DbHandle;
  let developerDispatchGate: ReturnType<typeof createDispatchGate>;

  beforeEach(() => {
    handle = openMigratedTestDb();
    developerDispatchGate = createDispatchGate(handle.db);
  });

  afterEach(() => {
    handle.close();
  });

  it("refuses a review of an item that declares nothing to judge it against", () => {
    expect(developerDispatchGate(item(), step())).toEqual({ kind: "no_acceptance_criteria" });
  });

  it("allows it once one criterion is there", () => {
    expect(developerDispatchGate(item(declaring("Returns 429 after 100 requests in a minute.")), step())).toBeNull();
  });

  it("counts a criterion nobody wrote as no criterion", () => {
    // The gate and `summariseCriteriaCoverage` have to agree about what
    // "declared" means. A list holding one blank string counting here
    // and not there would dispatch a review that could never be judged.
    expect(developerDispatchGate(item(declaring("   ", "")), step())).toEqual({ kind: "no_acceptance_criteria" });
    expect(developerDispatchGate(item({ spec: { acceptance_criteria: "not a list" } }), step())).toEqual({ kind: "no_acceptance_criteria" });
  });

  it("holds a bug to the same rule, and makes no criterion out of its `expected`", () => {
    // A bug's four reproduction fields are its intake bar; turning
    // `expected` into a criterion would be EO declaring one nobody
    // wrote.
    const bug = item({
      type: "bug",
      spec: { steps_to_reproduce: "Send 101 requests.", expected: "The 101st is refused with a 429.", actual: "It succeeds.", environment: "0.4.1, linux" },
    });

    expect(developerDispatchGate(bug, step())).toEqual({ kind: "no_acceptance_criteria" });
  });

  it("says nothing about a step that is not judging the item", () => {
    // Keyed on the action, so an implementer step with no criteria is
    // dispatched exactly as it always was.
    expect(developerDispatchGate(item(), step({ id: "todo", name: "To Do", entryAction: "implement", ownerRole: "implementer" }))).toBeNull();
  });

  it("applies to any step that runs `review`, whatever it is called and whoever owns it", () => {
    // Invariant #7: inserting a `qa` step that reviews takes no
    // TypeScript, so the rule cannot be keyed on the shipped pipeline's
    // step id or on the reviewer role.
    expect(developerDispatchGate(item({ stepId: "qa" }), step({ id: "qa", name: "QA", ownerRole: "qa" }))).toEqual({ kind: "no_acceptance_criteria" });
  });

  it("reads the criteria by the name the item's type declares (KAN-147)", () => {
    // A pack's `Case` whose bar is called `outcomes`. Asking it for an
    // `acceptance_criteria` it never had would turn away every review of
    // one for good — while the refusal posted on the item names the
    // field the type actually declares, so a person would do exactly what
    // the thread asked and watch nothing happen.
    syncItemTypes(handle.db, [
      {
        packSlug: "support",
        slug: "case",
        label: "Case",
        plural: "Cases",
        container: false,
        specShape: {
          type: "object",
          properties: { outcomes: { type: "array", items: { type: "string" }, "x-eo-criteria": true } },
          required: [],
        },
        actionOverrides: {},
      },
    ]);
    const withOutcomes = createTestItem(handle.db, { type: "case", title: "ACME cannot sign in", stepId: "review", spec: { outcomes: ["They can sign in"] } });
    const withTheOtherWord = createTestItem(handle.db, {
      type: "case",
      title: "Globex cannot sign in",
      stepId: "review",
      spec: { acceptance_criteria: ["They can sign in"] },
    });

    expect(developerDispatchGate(withOutcomes, step())).toBeNull();
    // And the conventional name declares nothing on a type that never
    // said it had that field.
    expect(developerDispatchGate(withTheOtherWord, step())).toEqual({ kind: "no_acceptance_criteria" });
  });
});
