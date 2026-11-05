import { gitStateOf } from "@eo/core";
import type { Item } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { getItem, listCommentsForItem, listRunsForItem } from "../db/repos/index.js";
import { createRoute, createStep } from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb, REVIEWABLE_SPEC } from "../db/testHelpers.js";
import { createRoleWiring } from "../packs/developer/wiring.js";
import { createRunSupervisor } from "../supervisor/runSupervisor.js";
import { createDemoProvider, DEMO_LIMIT_REACHED } from "./demo.js";

/**
 * What a fresh install does (KAN-34).
 *
 * Driven through the real supervisor and the real schemas rather than
 * asserted against a copy of them: the whole failure was a fake result
 * that looked fine in isolation and satisfied nothing in practice, and
 * only a run can tell those apart.
 */
const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };

let handle: DbHandle;

function supervisor() {
  return createRunSupervisor({
    db: handle.db,
    limits: LIMITS,
    provider: createDemoProvider(),
    ...createRoleWiring(handle.db),
  });
}

function engineNotes(item: Item): string[] {
  return listCommentsForItem(handle.db, item.id)
    .filter((comment) => comment.authorType === "engine")
    .map((comment) => comment.body);
}

beforeEach(() => {
  handle = openMigratedTestDb();
  // `intake` and `refine` are actions, not columns (ARCHITECTURE.md, "A column is a responsibility,
  // not a status") — a
  // conversation drives them now. These configure steps that run them,
  // which is exactly what a person could do and all these tests need.
  createStep(handle.db, { id: "ask", pipelineId: "default" as never, position: -2, name: "Intake", type: "agent", ownerRole: "system", entryAction: "intake" });
  createStep(handle.db, { id: "plan", pipelineId: "default" as never, position: -1, name: "Refine", type: "agent", ownerRole: "system", entryAction: "refine" });
  createRoute(handle.db, { pipelineId: "default" as never, fromStepId: "ask", resultKey: "done", label: "Understood", target: "plan", position: 0 });
  createRoute(handle.db, { pipelineId: "default" as never, fromStepId: "ask", resultKey: "classified_non_feature", label: "Already written", target: "todo", position: 1 });
  createRoute(handle.db, { pipelineId: "default" as never, fromStepId: "plan", resultKey: "decomposed", label: "Decomposed", target: "todo", position: 0 });
  createRoute(handle.db, { pipelineId: "default" as never, fromStepId: "plan", resultKey: "clarified", label: "Clarified", target: "todo", position: 1 });
});

afterEach(() => {
  handle.close();
});

describe("a fresh install with no agent configured", () => {
  it("takes a described feature in rather than failing validation", async () => {
    // The reported symptom: the first thing anyone did produced
    // `ready: Invalid input: expected true`.
    const feature = createTestItem(handle.db, { type: "feature", title: "Rate limiting", stepId: "ask" });

    await supervisor().runOnce();

    const run = listRunsForItem(handle.db, feature.id)[0];
    expect(run?.status, run?.error ?? "").toBe("succeeded");
    expect(getItem(handle.db, feature.id)?.stepId).toBe("plan");
  });

  it("pins what it understood, like a real intake would", async () => {
    const feature = createTestItem(handle.db, { type: "feature", title: "Rate limiting", stepId: "ask" });

    await supervisor().runOnce();

    const pinned = listCommentsForItem(handle.db, feature.id).filter((comment) => comment.pinned);
    expect(pinned).toHaveLength(1);
    expect(pinned[0]?.body).toContain("Configure a real backend");
  });

  it("decomposes into a plan and routes it onward", async () => {
    // The part worth seeing before committing to a backend: a feature
    // becomes something a human is asked to approve.
    const feature = createTestItem(handle.db, { type: "feature", title: "Rate limiting", stepId: "ask" });

    const engine = supervisor();
    await engine.runOnce(); // intake understands it
    await engine.runOnce(); // refine decomposes it

    // Asserted on what is in the thread rather than on which step it
    // stopped at: the point of the demo provider is that a fresh install
    // shows something real before anyone configures a backend.
    expect(listRunsForItem(handle.db, feature.id).every((run) => run.status === "succeeded")).toBe(true);
    const proposal = listCommentsForItem(handle.db, feature.id).find((comment) => comment.body.includes("Placeholder story"));
    expect(proposal, "the decomposition is in the thread").toBeDefined();
  });

  it("classifies a bug-shaped description down its own edge (KAN-38)", async () => {
    // The one thing worth seeing about KAN-4/EO-5 without a real backend:
    // a description that reads as a bug reaches the review gate already
    // classified, with the fields a bug needs and no decomposition.
    const item = createTestItem(handle.db, { type: "feature", title: "Login times out", stepId: "ask", body: "This looks like a bug when retrying." });

    await supervisor().runOnce();

    const run = listRunsForItem(handle.db, item.id)[0];
    expect(run?.status, run?.error ?? "").toBe("succeeded");
    const updated = getItem(handle.db, item.id);
    expect(updated?.type).toBe("bug");
    expect(updated?.stepId).toBe("todo");

    const classification = listCommentsForItem(handle.db, item.id).find((comment) => comment.authorType === "agent");
    expect(classification?.body).toContain("Steps to reproduce");
  });

  it("stops at implement, saying why in the thread", async () => {
    // Not a schema error, and not G-02's "claimed a branch with no
    // commits" — both of those read like a bug rather than "you have not
    // set up an agent yet".
    const story = createTestItem(handle.db, { type: "story", title: "Do the thing", stepId: "todo" });

    await supervisor().runOnce();

    expect(listRunsForItem(handle.db, story.id)[0]?.status).toBe("failed");
    expect(engineNotes(story).join("\n")).toContain("No coding agent is configured");
    expect(engineNotes(story).join("\n")).toContain("Agents");
  });

  it("does not pretend to have written code", async () => {
    // A claimed branch would be a lie the verifier has to catch. The
    // demo never makes the claim.
    const story = createTestItem(handle.db, { type: "story", title: "Do the thing", stepId: "todo" });

    await supervisor().runOnce();

    expect(getItem(handle.db, story.id)?.stepId).toBe("todo");
    expect(gitStateOf(getItem(handle.db, story.id)!).branch).toBeNull();
  });

  it("reviews without claiming to have read anything", async () => {
    const story = createTestItem(handle.db, { type: "story", title: "Do the thing", stepId: "review", spec: REVIEWABLE_SPEC });

    await supervisor().runOnce();

    expect(listRunsForItem(handle.db, story.id)[0]?.status).toBe("succeeded");
    expect(listCommentsForItem(handle.db, story.id).some((comment) => comment.body.includes("cannot review code"))).toBe(true);
  });
});

describe("a run that fails", () => {
  it("says so in the thread rather than only in the run record", async () => {
    // Every other stopping point posts — a tripped guard, a rejected
    // claim, a review. A failed run left `runs.error` set and the thread
    // silent, so the one place a person looks said nothing at all.
    const story = createTestItem(handle.db, { type: "story", title: "Do the thing", stepId: "todo" });

    await supervisor().runOnce();

    expect(engineNotes(story)[0]).toContain("Attempt 1 stopped");
    expect(engineNotes(story)[0]).toContain(DEMO_LIMIT_REACHED.split("\n")[0]);
  });

  it("does not interrupt anyone until the attempts run out", async () => {
    // The scheduler retries, so mentioning a human on each failure would
    // be three inbox items for one problem. The attempt-limit guard is
    // what finally asks.
    const story = createTestItem(handle.db, { type: "story", title: "Do the thing", stepId: "todo" });

    await supervisor().runOnce();

    const notes = listCommentsForItem(handle.db, story.id).filter((comment) => comment.authorType === "engine");
    expect(notes.every((comment) => comment.kind === "note")).toBe(true);
  });
});
