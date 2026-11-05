import { parsedResultOf, type Item } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Uuid } from "@eo/core";
import { needsAttention } from "../db/repos/commentsRepo.js";
import { listRunsForItem } from "../db/repos/runsRepo.js";
import { transitionItem } from "../db/repos/transitionsRepo.js";
import { getItem } from "../db/repos/itemsRepo.js";
import { createStep } from "../db/repos/pipelineStepsRepo.js";
import type { DbHandle } from "../db/client.js";
import { comments } from "../db/schema.js";
import { createRoute } from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { createFakeProvider } from "../providers/fake.js";
import { malformedResultFixture, validImplementResult } from "../providers/fixtures.js";
import { createRunSupervisor } from "./runSupervisor.js";

const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };

/**
 * A provider whose first N results are malformed and whose next one is
 * valid — the shape of the re-prompt path (A-02). Each resume() delivers
 * the next scripted result, so the supervisor's correction message is
 * what advances it.
 */
function providerYielding(results: unknown[]) {
  let index = 0;
  let threads = 0;
  const promptsSeen: string[] = [];

  async function* emit(): AsyncIterable<{ type: "result"; data: unknown }> {
    const data = results[Math.min(index, results.length - 1)];
    index += 1;
    yield { type: "result", data };
  }

  return {
    promptsSeen,
    provider: {
      async *start() {
        threads += 1;
        yield { type: "thread_started" as const, threadId: `t${threads}` };
        yield* emit();
      },
      async *resume(_threadId: string, message: string) {
        promptsSeen.push(message);
        yield* emit();
      },
    },
  };
}

describe("result validation (A-02)", () => {
  let handle: DbHandle;
  let item: Item;

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
    item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo" });
  });

  afterEach(() => {
    handle.close();
  });

  /** Moves the shared story out of the scheduler's way so a test's own item is the only dispatchable work. */
  function parkBaseStory(): void {
    transitionItem(handle.db, { itemId: item.id, toStepId: "ready_to_merge", actor: "human" });
  }

  it("persists both the raw and the parsed result on success", async () => {
    const supervisor = createRunSupervisor({
      db: handle.db,
      provider: createFakeProvider({ result: validImplementResult }),
      limits: LIMITS,
    });

    await supervisor.runOnce();

    const [run] = listRunsForItem(handle.db, item.id);
    expect(run?.status).toBe("succeeded");
    // raw is exactly what the agent said; parsed has zod's defaults filled in.
    expect(run?.result).toEqual({
      raw: validImplementResult,
      parsed: { ...validImplementResult, files_changed: [], tests_run: false },
    });
    expect(parsedResultOf(run?.result ?? null)).toMatchObject({ branch: "eo/EO-1" });
  });

  it("re-prompts with the specific validation error, and a corrected result then succeeds", async () => {
    const { provider, promptsSeen } = providerYielding([{ nope: true }, validImplementResult]);
    const supervisor = createRunSupervisor({ db: handle.db, provider, limits: LIMITS });

    await supervisor.runOnce();

    expect(promptsSeen).toHaveLength(1);
    expect(promptsSeen[0]).toContain("branch"); // the field that was missing, so the agent can fix it
    expect(promptsSeen[0]).toContain("implement"); // and which action's schema it failed

    const [run] = listRunsForItem(handle.db, item.id);
    expect(run?.status).toBe("succeeded");
    expect(getItem(handle.db, item.id)?.stepId).toBe("review"); // recovered, and the pipeline moved on
  });

  it("escalates after two failed corrections rather than discarding the run", async () => {
    const { provider, promptsSeen } = providerYielding([{ nope: true }]); // never corrects
    const supervisor = createRunSupervisor({ db: handle.db, provider, limits: LIMITS });

    await supervisor.runOnce();

    expect(promptsSeen).toHaveLength(2); // the story's "max 2 retries"

    const [run] = listRunsForItem(handle.db, item.id);
    expect(run?.status).toBe("awaiting_input"); // parked for a human, not failed and forgotten
    expect(run?.error).toContain("validation");
    expect(getItem(handle.db, item.id)?.stepId).toBe("todo"); // never moved on a result we couldn't trust

    // the design / invariant #8 — nothing is dropped silently.
    expect(needsAttention(handle.db, item.id)).toBe(true);
    const posted = handle.db.select().from(comments).all();
    expect(posted.some((comment) => comment.authorType === "engine" && comment.kind === "escalation")).toBe(true);
  });

  it("a malformed result never moves the item, even though the run reached a 'result'", async () => {
    const supervisor = createRunSupervisor({ db: handle.db, provider: createFakeProvider(malformedResultFixture), limits: LIMITS });

    await supervisor.runOnce();

    expect(getItem(handle.db, item.id)?.stepId).toBe("todo");
    expect(listRunsForItem(handle.db, item.id)[0]?.status).toBe("awaiting_input");
  });

  it("a refine result whose depends_on is out of range is rejected before any item is created", async () => {
    parkBaseStory();
    const feature = createTestItem(handle.db, { type: "feature", title: "F", stepId: "plan" });
    const { provider, promptsSeen } = providerYielding([
      {
        children: [
          { type: "story", title: "A", body: "", acceptance_criteria: ["it works"] },
          { type: "story", title: "B", body: "", acceptance_criteria: ["it works"], depends_on: [7] },
        ],
      },
    ]);
    const supervisor = createRunSupervisor({ db: handle.db, provider, limits: LIMITS });

    await supervisor.runOnce();

    expect(promptsSeen[0]).toContain("depends_on index 7");
    const run = listRunsForItem(handle.db, feature.id)[0];
    expect(run?.status).toBe("awaiting_input");
    expect(getItem(handle.db, feature.id)?.stepId).toBe("plan"); // stayed put — nothing downstream was built
  });

  it("a refine result that would create a cycle is rejected with a readable path", async () => {
    parkBaseStory();
    const feature = createTestItem(handle.db, { type: "feature", title: "F", stepId: "plan" });
    const { provider, promptsSeen } = providerYielding([
      {
        children: [
          { type: "story", title: "A", body: "", acceptance_criteria: ["it works"], depends_on: [1] },
          { type: "story", title: "B", body: "", acceptance_criteria: ["it works"], depends_on: [0] },
        ],
      },
    ]);
    const supervisor = createRunSupervisor({ db: handle.db, provider, limits: LIMITS });

    await supervisor.runOnce();

    expect(promptsSeen[0]).toContain("cycle");
    expect(promptsSeen[0]).toContain("→");
    expect(listRunsForItem(handle.db, feature.id)[0]?.status).toBe("awaiting_input");
  });

  it("an action with no registered schema is left alone — workflow states are data (invariant #7)", async () => {
    // A stage this codebase has never heard of, added the way a user
    // would add one: a `workflow_states` row, not a code change. Its
    // action has no schema, so whatever comes back is accepted as-is.
    //
    // This used to point at `intake`, which was only an example of an
    // unregistered action by accident — and stopped being one when
    // intake got a schema (KAN-32). A made-up stage is what the
    // invariant actually claims.
    parkBaseStory();
    createStep(handle.db, { id: "triage", pipelineId: "default" as Uuid, position: -1, name: "Triage", ownerRole: "system", entryAction: "assess_risk" });
    const feature = createTestItem(handle.db, { type: "feature", title: "F", stepId: "triage" });
    const supervisor = createRunSupervisor({
      db: handle.db,
      provider: createFakeProvider({ result: { anything: "goes" } }),
      limits: LIMITS,
    });

    await supervisor.runOnce();

    const run = listRunsForItem(handle.db, feature.id)[0];
    expect(run?.status).toBe("succeeded");
    expect(parsedResultOf(run?.result ?? null)).toEqual({ anything: "goes" });
  });
});
