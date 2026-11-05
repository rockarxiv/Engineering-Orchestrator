import type { Agent, Item, Run } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { createAgent, getAgent, listAgents, updateAgent } from "../db/repos/agentsRepo.js";
import { createRun, getRun, getSetting, listCommentsForItem, listRunsForItem, postComment, setSetting } from "../db/repos/index.js";
import { createProject } from "../db/repos/projectsRepo.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { createFakeProvider } from "../providers/fake.js";
import { createRunSupervisor } from "./runSupervisor.js";

/**
 * The recovery paths, held to an agent's project (EO-474).
 *
 * `tick()` never sends an agent to another project's item, but four
 * paths start an agent without asking the scheduler who staffs the
 * step: a reply to its parked run, with or without a thread to resume;
 * a boot reconciliation resuming a run a restart interrupted; and a
 * forced restart replacing a run a destructive close stopped. Each is
 * handed an agent chosen *before* — and an agent can be moved to
 * another project in between. Every case here moves it, and asserts
 * that no provider turn starts as that agent, that the thread says why,
 * and that the item is left free for whoever staffs the step for its
 * own project now.
 */

const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 5 };
/** What tells the moved agent's turns apart from everyone else's. */
const MOVED_INSTRUCTIONS = "You implement the support team's tickets.";
/** The thread the moved agent's parked or interrupted conversation is on. */
const MOVED_THREAD = "prior-thread";

let handle: DbHandle;
let support: ReturnType<typeof createProject>;
let shop: ReturnType<typeof createProject>;
let moved: Agent;
let item: Item;

beforeEach(() => {
  handle = openMigratedTestDb();
  support = createProject(handle.db, { name: "Support", keyPrefix: "SUP" });
  shop = createProject(handle.db, { name: "Shop", keyPrefix: "SHOP" });
  moved = createAgent(handle.db, { name: "Support implementer", role: "implementer", provider: "fake", instructions: MOVED_INSTRUCTIONS, projectId: support.id });
  item = createTestItem(handle.db, { type: "story", title: "Support work", stepId: "todo", projectId: support.id });
});

afterEach(() => {
  handle.close();
});

/** A provider that counts every turn — start or resume — opened as the moved agent. */
function countingProvider(): { provider: ReturnType<typeof createFakeProvider>; movedTurns: () => number } {
  const inner = createFakeProvider({ result: { message: "Done." } });
  let movedStarts = 0;
  let resumed = 0;
  return {
    provider: {
      ...inner,
      start: (...args: Parameters<typeof inner.start>) => {
        if (args[0].instructions.includes(MOVED_INSTRUCTIONS)) movedStarts += 1;
        return inner.start(...args);
      },
      // A resume carries no instructions, so it is told apart by the
      // thread: the moved agent's conversation is `MOVED_THREAD`, and an
      // agent staffing the step afterwards opens threads of its own.
      resume: (...args: Parameters<typeof inner.resume>) => {
        if (args[0] === MOVED_THREAD) resumed += 1;
        return inner.resume(...args);
      },
    },
    movedTurns: () => movedStarts + resumed,
  };
}

function runAsMoved(status: Run["status"], threadId: string | null): Run {
  return createRun(handle.db, { itemId: item.id, agentId: moved.id, action: "implement", stepId: "todo", status, provider: "fake", threadId });
}

function moveToShop(): void {
  updateAgent(handle.db, moved.id, { projectId: shop.id });
}

function engineNotes(): string[] {
  return listCommentsForItem(handle.db, item.id)
    .filter((comment) => comment.authorType === "engine")
    .map((comment) => comment.body);
}

const SAYS_WHY = 'Support implementer works for the "Shop" project only, and this ticket is on "Support"';

describe("a reply to a parked run, after its agent moved to another project", () => {
  it.each([
    ["with no thread to resume, which would start afresh", null],
    ["with a thread, which would resume it", MOVED_THREAD],
  ])("%s: starts no turn, closes the park with a sentence, and leaves the step to the project's staffing", async (_case, threadId) => {
    const parked = runAsMoved("awaiting_input", threadId);
    moveToShop();
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Please continue." });
    const { provider, movedTurns } = countingProvider();
    const supervisor = createRunSupervisor({ db: handle.db, provider, limits: LIMITS });

    await supervisor.resumeItem(item.id);

    expect(movedTurns()).toBe(0);
    expect(getRun(handle.db, parked.id)?.status).toBe("cancelled");
    expect(engineNotes().filter((body) => body.includes(SAYS_WHY))).toHaveLength(1);

    // The park is gone, so the step is staffed again — by the global
    // implementer, since Support has no implementer of its own now.
    await supervisor.runOnce();
    const global = listAgents(handle.db).find((agent) => agent.role === "implementer" && agent.projectId === null)!;
    expect(listRunsForItem(handle.db, item.id).filter((run) => run.id !== parked.id).map((run) => run.agentId)).toEqual([global.id]);
    expect(movedTurns()).toBe(0);
  });
});

describe("a boot reconciliation, after the interrupted run's agent moved to another project", () => {
  it("resumes nothing, orphans the run with a sentence, and asks nobody", async () => {
    const interrupted = runAsMoved("running", MOVED_THREAD);
    moveToShop();
    const { provider, movedTurns } = countingProvider();
    const supervisor = createRunSupervisor({ db: handle.db, provider, limits: LIMITS });

    await supervisor.reconcile();
    await supervisor.shutdown();

    expect(movedTurns()).toBe(0);
    expect(getRun(handle.db, interrupted.id)?.status).toBe("orphaned");
    const note = listCommentsForItem(handle.db, item.id).find((comment) => comment.authorType === "engine" && comment.body.includes(SAYS_WHY));
    expect(note).toBeDefined();
    // The scheduler picks the step up again by itself; nothing for a person to answer.
    expect(note?.body).toContain("The run interrupted by the restart (attempt 1) is closed rather than carried on");
  });
});

describe("a forced restart, after the stopped run's agent moved to another project", () => {
  it("starts no replacement as that agent, settles the promise with a sentence, and leaves the step to the project's staffing", async () => {
    const stopped = runAsMoved("cancelled", MOVED_THREAD);
    setSetting(handle.db, "engine.forced-restarts", [
      { cancelledRunId: stopped.id, itemId: item.id, agentId: moved.id, action: "implement", transitionOnSuccess: true, interruption: "quit" },
    ]);
    moveToShop();
    const { provider, movedTurns } = countingProvider();
    const supervisor = createRunSupervisor({ db: handle.db, provider, limits: LIMITS });

    await supervisor.runOnce();

    expect(movedTurns()).toBe(0);
    expect(getSetting(handle.db, "engine.forced-restarts", [])).toEqual([]);
    expect(engineNotes().filter((body) => body.includes(SAYS_WHY))).toHaveLength(1);
    expect(getAgent(handle.db, moved.id)?.projectId).toBe(shop.id);

    await supervisor.runOnce();
    const global = listAgents(handle.db).find((agent) => agent.role === "implementer" && agent.projectId === null)!;
    expect(listRunsForItem(handle.db, item.id).filter((run) => run.id !== stopped.id).map((run) => run.agentId)).toEqual([global.id]);
    expect(movedTurns()).toBe(0);
  });
});

describe("a dispatch whose agent moves to another project during preflight", () => {
  it("is turned back before any turn starts", async () => {
    // The scheduler picks Support's own implementer — it outranks the
    // global one there — and the agent is moved while EO asks whether
    // its backend is signed in, the first preflight await.
    const { provider, movedTurns } = countingProvider();
    const supervisor = createRunSupervisor({
      db: handle.db,
      provider,
      limits: LIMITS,
      checkAuth: async (agent) => {
        if (agent.id === moved.id) moveToShop();
        return { ok: true };
      },
    });

    await supervisor.runOnce();

    expect(getAgent(handle.db, moved.id)?.projectId).toBe(shop.id);
    expect(movedTurns()).toBe(0);
    expect(listRunsForItem(handle.db, item.id).filter((run) => run.agentId === moved.id)).toEqual([]);
  });
});
