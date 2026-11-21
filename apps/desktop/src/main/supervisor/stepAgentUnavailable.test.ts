import type { Agent } from "@eo/core";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { archiveAgent, createAgent, deleteAgent, listAgents, updateAgent } from "../db/repos/agentsRepo.js";
import { listCommentsForItem } from "../db/repos/commentsRepo.js";
import { listRunsForItem } from "../db/repos/runsRepo.js";
import { pipelineSteps } from "../db/schema.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { createFakeProvider } from "../providers/fake.js";
import { validImplementResult } from "../providers/fixtures.js";
import { createRunSupervisor } from "./runSupervisor.js";

const LIMITS = { globalConcurrency: 1, perAgentConcurrency: 1, perRepositoryConcurrency: 1 };

/**
 * An item on a step whose agent cannot run it (EO-875, invariant 8).
 *
 * The seeded To do step names the seeded Implementer. A second enabled
 * implementer stands beside it in every case, because that is the
 * failure this guards against: with the step's own agent disabled,
 * archived or deleted, the item must not be handed to another agent of
 * the same kind. It waits, and its thread says once which agent it is
 * and what to do.
 */
describe("a step whose agent cannot run", () => {
  let handle: DbHandle;
  let named: Agent;
  let other: Agent;

  beforeEach(() => {
    handle = openMigratedTestDb();
    named = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
    other = createAgent(handle.db, { name: "Implementer on Codex", role: "implementer", provider: "fake", instructions: "Implement.", enabled: true });
  });

  afterEach(() => {
    handle.close();
  });

  async function tickTwice() {
    const supervisor = createRunSupervisor({ db: handle.db, provider: createFakeProvider({ result: validImplementResult }), limits: LIMITS });
    await supervisor.runOnce();
    await supervisor.waitForIdle();
    await supervisor.runOnce();
    await supervisor.waitForIdle();
  }

  const engineNotes = (itemId: string) => listCommentsForItem(handle.db, itemId as never).filter((comment) => comment.authorType === "engine" && comment.kind === "note");

  it.each([
    {
      why: "disabled",
      make: () => updateAgent(handle.db, named.id, { enabled: false }),
      says: "Nothing will run \"To Do\" for this ticket: Implementer, the agent this step names, is disabled. Enable Implementer in Agents, or choose another agent on the step.",
    },
    {
      why: "archived",
      make: () => archiveAgent(handle.db, named.id),
      says: "Nothing will run \"To Do\" for this ticket: Implementer, the agent this step names, has been archived. Choose another agent on the step.",
    },
    {
      why: "deleted",
      make: () => deleteAgent(handle.db, named.id),
      says: "Nothing will run \"To Do\" for this ticket: Implementer, the agent this step names, has been deleted. Choose another agent on the step.",
    },
  ])("is not dispatched when its agent is $why, is never handed to another of its kind, and says so once", async ({ make, says }) => {
    make();
    const item = createTestItem(handle.db, { type: "story", title: "Something to build", stepId: "todo" });

    await tickTwice();

    // Nobody ran it — not the step's agent, and not the other implementer.
    expect(listRunsForItem(handle.db, item.id)).toEqual([]);
    // Said once, for this stay on the step, with the agent and the fix.
    const notes = engineNotes(item.id);
    expect(notes.map((note) => note.body)).toEqual([`${says} It is not handed to another agent of the same kind.`]);
    expect(other.enabled).toBe(true);
  });

  it("says a step that names no agent has nobody to run it", async () => {
    handle.db.update(pipelineSteps).set({ agentId: null }).where(eq(pipelineSteps.id, "todo")).run();
    const item = createTestItem(handle.db, { type: "story", title: "Something to build", stepId: "todo" });

    await tickTwice();

    expect(listRunsForItem(handle.db, item.id)).toEqual([]);
    expect(engineNotes(item.id).map((note) => note.body)).toEqual([
      'Nothing will run "To Do" for this ticket: this step names no agent, so nobody can run it. Choose an agent for the step. It is not handed to another agent of the same kind.',
    ]);
  });

  it("runs the item with its step's agent once that agent is enabled again", async () => {
    updateAgent(handle.db, named.id, { enabled: false });
    const item = createTestItem(handle.db, { type: "story", title: "Something to build", stepId: "todo" });
    await tickTwice();
    expect(listRunsForItem(handle.db, item.id)).toEqual([]);

    updateAgent(handle.db, named.id, { enabled: true });
    await tickTwice();

    // The implementation, and only by the agent the step names.
    const runs = listRunsForItem(handle.db, item.id).filter((run) => run.stepId === "todo");
    expect(runs.length).toBeGreaterThan(0);
    expect(new Set(runs.map((run) => run.agentId))).toEqual(new Set([named.id]));
  });
});
