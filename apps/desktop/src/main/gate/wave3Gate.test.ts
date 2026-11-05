import { parsedResultOf, refineChildren, type Agent, type Item } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { createTestItem, openMigratedTestDb, REVIEWABLE_SPEC } from "../db/testHelpers.js";
import {
  addDependency,
  createRun,
  getRun,
  getItem,
  listAgents,
  listRunsForItem,
  listItems,
  needsAttention,
  postComment,
  updateRun,
} from "../db/repos/index.js";
import { createScriptedProvider } from "../providers/scripted.js";
import { buildDispatchContext } from "../supervisor/buildDispatchContext.js";
import { BUILTIN_RUNNERS } from "../packs/developer/builtins.js";
import { createRunSupervisor } from "../supervisor/runSupervisor.js";
import { startTestWriteBridge } from "../testing/agentWrites.js";

/**
 * ── The Wave 3 gate ───────────────────────────────────────────────
 *
 * "Seed a feature; the fake PO emits three dependency-ordered stories;
 *  the fake implementer picks up only unblocked ones; everything reaches
 *  ready_to_merge; a fake escalation parks an item and resumes after a
 *  reply; kill -9 mid-flight resumes correctly."
 *
 * Everything the engine is responsible for runs for real here: the
 * scheduler, dispatch, transitions, dependency ordering, escalation,
 * resume, and crash reconciliation. Only the agents are fake.
 *
 * Two things are supplied by this harness rather than production code,
 * both deliberately, because they belong to stories that haven't landed:
 *
 *  1. Applying the PO's refine output — creating story items and their
 *     dependency edges — is R-01's job (Phase 3). The gate does it here,
 *     which is what "drive it from a CLI or a throwaway table" means.
 *  2. Routing a refined `feature` to a terminal state instead of down
 *     the implementer path. Also R-01's; the default next-state rule is
 *     a straight walk down the pipeline and knows nothing about types.
 */

const STORY_A = "Extract the rate limiter";
const STORY_B = "Wire it into the API";
const STORY_C = "Document the limits";

/** What the fake PO returns from refine — a real RefineOutput (A-02), validated by the engine on the way back. */
const REFINE_OUTPUT = {
  children: [
    { type: "story", title: STORY_A, body: "Pull the limiter out.", acceptance_criteria: ["the limiter is its own module"], depends_on: [], touches: ["src/limiter.ts"] },
    { type: "story", title: STORY_B, body: "Call it from the API.", acceptance_criteria: ["the API rejects over-limit callers"], depends_on: [0], touches: ["src/api.ts"] },
    { type: "story", title: STORY_C, body: "Write it down.", acceptance_criteria: ["the limits are documented"], depends_on: [1], touches: ["docs/limits.md"] },
  ],
};

describe("Wave 3 gate", () => {
  let handle: DbHandle;
  let implementer: Agent;

  beforeEach(() => {
    handle = openMigratedTestDb();
    implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
  });

  afterEach(() => {
    handle.close();
  });

  /**
   * Stands in for R-01: turn the PO's refine result into real items +
   * edges, and retire the feature itself — its children carry the work
   * from here, so it must not continue down the implementer path. R-01
   * will own both halves; the engine's own next-state rule is a straight
   * walk down the pipeline and knows nothing about item types.
   */
  function applyRefineOutput(feature: Item): Item[] {
    const children = refineChildren(REFINE_OUTPUT);
    const stories = children.map((story) =>
      createTestItem(handle.db, { type: "story", title: story.title, stepId: "todo", parentId: feature.id, spec: REVIEWABLE_SPEC }),
    );
    children.forEach((story, index) => {
      for (const dependsOnIndex of story.depends_on) {
        addDependency(handle.db, stories[index]!.id, stories[dependsOnIndex]!.id);
      }
    });
    // The feature is not moved anywhere: it is on no pipeline at all
    // (ARCHITECTURE.md, "One work entity"), and whether it is finished is a question about these
    // three.
    return stories;
  }

  function makeSupervisor(overrides: Parameters<typeof createRunSupervisor>[0] extends infer T ? Partial<T> : never = {}) {
    return createRunSupervisor({
      db: handle.db,
      // Above 1 on purpose: with a cap of 1 the stories would serialise
      // anyway and prove nothing about dependency ordering. The gate is
      // what earns the right to raise this (CLAUDE.md invariant #10).
      limits: { globalConcurrency: 3, perAgentConcurrency: 3, perRepositoryConcurrency: 10 },
      // Routed on the requested action, which the assembled context now
      // states outright — the product owner owns two of them and one
      // instructions string, so nothing else distinguishes its dispatches.
      provider: createScriptedProvider([
        {
          when: (context) => context.includes(`"intake" action`),
          script: { result: { ready: true, understanding: "Cap anonymous callers on the public API." } },
        },
        { when: (context) => context.includes(`"refine" action`), script: { result: REFINE_OUTPUT } },
        { when: (context) => context.includes(`"implement" action`), script: { result: { branch: "eo/impl", summary: "Did it.", handoff: "Straightforward; nothing to flag." } } },
        { when: (context) => context.includes(`"review" action`), script: { result: { verdict: "approve", feedback: "LGTM" } } },
      ]),
      // The developer pack's functions, because the last step of the
      // shipped pipeline runs one and the supervisor ships none of its
      // own (KAN-144).
      builtins: BUILTIN_RUNNERS,
      // R-01's job; see the header note.
      resolveNextState: (currentState, states) => {
        const next = states.filter((state) => state.position > currentState.position).sort((a, b) => a.position - b.position)[0];
        return next ? { stepId: next.id, pipelineId: next.pipelineId } : null;
      },
      ...overrides,
    });
  }

  it("drives three dependency-ordered stories to ready_to_merge, in order", async () => {
    // Understanding and decomposing happen in Discussions now (ARCHITECTURE.md, "A column is a
    // responsibility, not a status"), and
    // `discussion.test.ts` covers that half. This is the half where the
    // engine has work somebody approved and has to actually deliver it.
    const feature = createTestItem(handle.db, { type: "feature", title: "Rate limiting", stepId: null });
    const supervisor = makeSupervisor();

    const [storyA, storyB, storyC] = applyRefineOutput(feature);
    expect(listItems(handle.db).filter((item) => item.parentId === feature.id)).toHaveLength(3);

    // ── The implementer picks up only unblocked stories ─────────────
    await supervisor.runOnce();
    expect(listRunsForItem(handle.db, storyA!.id)).toHaveLength(1); // unblocked — dispatched
    expect(listRunsForItem(handle.db, storyB!.id)).toHaveLength(0); // blocked by A
    expect(listRunsForItem(handle.db, storyC!.id)).toHaveLength(0); // blocked by B

    // ── Everything reaches ready_to_merge, in dependency order ──────
    for (let i = 0; i < 12; i++) await supervisor.runOnce();

    for (const story of [storyA, storyB, storyC]) {
      expect(getItem(handle.db, story!.id)?.stepId).toBe("ready_to_merge");
    }

    const startedAt = (item: Item): number => Math.min(...listRunsForItem(handle.db, item.id).map((run) => run.startedAt ?? 0));
    expect(startedAt(storyA!)).toBeLessThanOrEqual(startedAt(storyB!));
    expect(startedAt(storyB!)).toBeLessThanOrEqual(startedAt(storyC!));
  });

  it("a fake escalation parks an item, and a human reply resumes it to completion", async () => {
    const story = createTestItem(handle.db, { type: "story", title: "Needs a decision", stepId: "todo", spec: REVIEWABLE_SPEC });
    // The agent's comment reaches EO over the bridge, as a real one's does (EO-543).
    const writes = await startTestWriteBridge();

    const supervisor = createRunSupervisor({
      db: handle.db,
      agentWriteBridge: writes.agentWriteBridge,
      limits: { globalConcurrency: 3, perAgentConcurrency: 3, perRepositoryConcurrency: 10 },
      builtins: BUILTIN_RUNNERS,
      provider: createScriptedProvider([
        {
          when: (context) => context.includes(`"implement" action`),
          script: {
            steps: [
              { output: "Looking at this..." },
              { toolCall: { name: "comment", args: { body: "@user which limit should I use?", mentions: ["user"], blocking: true } } },
              // Only replayed after the human answers — resume() continues this same script.
              { output: "Thanks, proceeding." },
            ],
            result: { branch: "eo/decided", summary: "Used 100 req/min.", handoff: "Straightforward; nothing to flag." },
          },
        },
        { when: (context) => context.includes(`"review" action`), script: { result: { verdict: "approve", feedback: "LGTM" } } },
      ]),
      // The same stand-in for R-01 that `makeSupervisor` uses, for the
      // same reason: this gate is about parking and resuming, and the
      // supervisor's own default now routes on the reported result key
      // rather than walking positions (KAN-144).
      resolveNextState: (currentState, states) => {
        const next = states.filter((state) => state.position > currentState.position).sort((a, b) => a.position - b.position)[0];
        return next ? { stepId: next.id, pipelineId: next.pipelineId } : null;
      },
    });

    writes.serve(supervisor);

    // ── Parked ──────────────────────────────────────────────────────
    await supervisor.runOnce();
    const parkedRun = listRunsForItem(handle.db, story.id)[0]!;
    expect(parkedRun.status).toBe("awaiting_input");
    expect(getItem(handle.db, story.id)?.stepId).toBe("todo"); // an escalation is not progress
    expect(needsAttention(handle.db, story.id)).toBe(true); // the `!` marker, derived

    // The scheduler must leave it alone while it waits.
    await supervisor.runOnce();
    expect(listRunsForItem(handle.db, story.id)).toHaveLength(1);

    // ── The human replies ───────────────────────────────────────────
    postComment(handle.db, { itemId: story.id, author: { type: "human" }, body: "Use 100 req/min." });
    expect(needsAttention(handle.db, story.id)).toBe(false); // the reply addressed the mention

    await supervisor.resumeItem(story.id);

    const resumedRun = listRunsForItem(handle.db, story.id).find((run) => run.id !== parkedRun.id)!;
    expect(resumedRun.threadId).toBe(parkedRun.threadId); // same thread — continuity, not a restart
    expect(resumedRun.attempt).toBe(2);
    expect(resumedRun.status).toBe("succeeded");

    // ── And the pipeline carries on ─────────────────────────────────
    for (let i = 0; i < 4; i++) await supervisor.runOnce();
    expect(getItem(handle.db, story.id)?.stepId).toBe("ready_to_merge");
    await writes.close();
  });

  it("kill -9 mid-run: on relaunch the run resumes on the same thread and completes", async () => {
    const story = createTestItem(handle.db, { type: "story", title: "Interrupted work", stepId: "todo" });

    // One provider instance outlives the "crash", modelling the fact
    // that a real provider persists its sessions outside the app
    // (the original design: "Codex persists in ~/.codex/sessions").
    const provider = createScriptedProvider([
      {
        when: (context) => context.includes(`"implement" action`),
        script: { steps: [{ output: "step one" }, { output: "step two" }], result: { branch: "eo/survived", summary: "Finished after the restart.", handoff: "Straightforward; nothing to flag." } },
      },
      { when: (context) => context.includes(`"review" action`), script: { result: { verdict: "approve", feedback: "LGTM" } } },
    ]);

    // ── The process that dies ───────────────────────────────────────
    // Built by hand rather than by running a supervisor and rewinding
    // it: kill -9 means our code stops executing *mid-stream*, so the
    // faithful shape is a thread that opened and a run row that never
    // reached a terminal status — and, crucially, an item that never
    // got transitioned, because the transition happens after the run
    // completes. Running to completion first and rewinding only the run
    // would leave the item already advanced, which no crash produces.
    const stream = provider.start({
      instructions: implementer.instructions,
      context: await buildDispatchContext(handle.db, story, "implement"), // the same context the supervisor would have built
      cwd: ".",
      signal: new AbortController().signal,
    });
    const first = await stream[Symbol.asyncIterator]().next();
    if (first.done || first.value.type !== "thread_started") throw new Error("expected thread_started");

    const interruptedRun = createRun(handle.db, {
      itemId: story.id,
      agentId: implementer.id,
      action: "implement",
      status: "queued",
      threadId: first.value.threadId,
    });
    updateRun(handle.db, interruptedRun.id, { status: "running", startedAt: Date.now() });

    // ── Relaunch ────────────────────────────────────────────────────
    const relaunched = createRunSupervisor({ db: handle.db, provider, limits: { globalConcurrency: 1, perAgentConcurrency: 1, perRepositoryConcurrency: 10 } });
    const summary = await relaunched.reconcile();
    expect(summary).toEqual({ reattached: 0, resumed: 1, orphaned: 0 });

    expect(getRun(handle.db, interruptedRun.id)?.status).toBe("cancelled");

    const resumedRun = listRunsForItem(handle.db, story.id).find((run) => run.id !== interruptedRun.id)!;
    expect(resumedRun.threadId).toBe(interruptedRun.threadId); // same thread — context intact
    // The same attempt carried on: an interruption is not one the agent spent.
    expect(getRun(handle.db, interruptedRun.id)?.interruption).toBe("restart");
    expect(resumedRun.attempt).toBe(interruptedRun.attempt);

    await new Promise((resolve) => setTimeout(resolve, 30)); // let the resumed stream finish
    expect(getRun(handle.db, resumedRun.id)?.status).toBe("succeeded");
    expect(parsedResultOf(getRun(handle.db, resumedRun.id)?.result ?? null)).toMatchObject({ branch: "eo/survived" });
    expect(getItem(handle.db, story.id)?.stepId).toBe("review"); // the interrupted work landed after all
  });

  it("no dispatch happens before reconciliation on relaunch", async () => {
    const story = createTestItem(handle.db, { type: "story", title: "Orphan me", stepId: "todo" });
    const supervisor = makeSupervisor();

    // A run with no thread, left `running` — nothing to resume.
    await supervisor.runOnce();
    const run = listRunsForItem(handle.db, story.id)[0]!;
    updateRun(handle.db, run.id, { status: "running", threadId: null, result: null, endedAt: null });

    const relaunched = makeSupervisor();
    relaunched.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    relaunched.stop();

    expect(getRun(handle.db, run.id)?.status).toBe("orphaned");
    // Orphaning explains itself and asks for a human (ARCHITECTURE.md, "Guardrails", invariant #8).
    expect(needsAttention(handle.db, story.id)).toBe(true);
  });
});
