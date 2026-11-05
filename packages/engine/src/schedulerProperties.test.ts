import type { Agent, PipelineStep, Run, Item, Uuid } from "@eo/core";
import { describe, expect, it } from "vitest";
import { tick, type TickInput } from "./scheduler.js";
import type { Edge } from "./dag.js";


/** Any `item_types` row: these fixtures never read the type's row, only the word on it. */
const STORY_TYPE_ID = "0199aa00-0000-7000-8000-000000000001" as Uuid;
/**
 * Which bucket an item's run consumes — the developer pack's answer,
 * since that is the installation these properties are about (KAN-161).
 *
 * Items with no repository share one: they all run in the process cwd.
 * The scheduler takes this as input now, so it is both what the
 * generator caps its in-flight runs by and what the property below
 * counts — one definition, and no way for the two to drift.
 */
const bucketOf = (item: Item) => item.workspaceId ?? "__projectless__";

/**
 * Properties of one scheduler tick, checked over many generated states.
 *
 * The caps are the safety story: invariant #10 keeps concurrency at 1
 * until the loop is provably reliable, and `perRepositoryConcurrency`
 * exists so one busy repository cannot starve the others. A cap that
 * leaks is two agents in one worktree, which is the failure that does not
 * announce itself — it looks like a confusing diff.
 *
 * Example tests cover the arrangements somebody drew. These generate the
 * arrangements nobody drew: every mix of paused, held, awaiting input,
 * runs already in flight, repo-less items, several pipelines, and caps
 * from 1 to 3.
 */

function rng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

const ROLES = ["implementer", "reviewer"] as const;

function agentFor(role: string, index: number): Agent {
  return {
    id: `a-${role}-${index}` as Uuid,
    name: `${role} ${index}`,
    role,
    provider: "fake",
    model: null,
    instructions: "x",
    promptHash: null,
    config: {},
    enabled: true,
    archivedAt: null,
    deletedAt: null,
    projectId: null,
  };
}

function stepFor(pipelineId: string, position: number, role: string): PipelineStep {
  return {
    id: `${pipelineId}-s${position}`,
    pipelineId: pipelineId as Uuid,
    position,
    name: `Step ${position}`,
    type: "agent",
    ownerRole: role,
    entryAction: role === "reviewer" ? "review" : "implement",
    instructionsSummary: null,
    isTerminal: false,
    planMode: false,
    workspaceMode: "isolated" as const,
    workspaceId: null,
    offBoard: false,
    inputs: {},
    timeoutMs: null,
    watch: null,
    ownerPersonId: null,
    ownerGroupId: null,
    results: [],
  };
}

interface Generated {
  seed: number;
  input: TickInput;
}

function generate(seed: number): Generated {
  const random = rng(seed);
  const pipelineCount = 1 + Math.floor(random() * 2);
  const steps: PipelineStep[] = [];
  for (let p = 0; p < pipelineCount; p++) {
    for (let s = 0; s < 2; s++) steps.push(stepFor(`p${p}`, s, ROLES[s % ROLES.length]!));
  }

  const agents = [agentFor("implementer", 0), agentFor("implementer", 1), agentFor("reviewer", 0)];
  const repositories: (Uuid | null)[] = ["r0" as Uuid, "r1" as Uuid, null];

  const itemCount = Math.floor(random() * 12);
  const items: Item[] = [];
  for (let n = 0; n < itemCount; n++) {
    const pipelineId = `p${Math.floor(random() * pipelineCount)}`;
    const step = steps.filter((candidate) => candidate.pipelineId === pipelineId)[Math.floor(random() * 2)]!;
    items.push({
      id: `t${n}` as Uuid,
      key: `EO-${n}`,
      typeId: STORY_TYPE_ID,
      type: "story",
      typeLabel: "Story",
      container: false,
      parentId: null,
      workspaceId: repositories[Math.floor(random() * repositories.length)]!,
      projectId: null,
      title: `Ticket ${n}`,
      body: null,
      spec: null,
      pipelineId: pipelineId as Uuid,
      stepId: random() < 0.1 ? null : step.id,
      pipelineVersionId: null,
      priority: Math.floor(random() * 3),
      extensions: {},
      archivedAt: null,
      heldAt: null,
      previewAt: null,
      trialAt: null,
      createdBy: null,
      assigneeId: null,
      createdAt: n,
      updatedAt: n,
    });
  }

  // Dependencies only ever point backwards, so the graph stays acyclic.
  const deps: Edge[] = [];
  for (let a = 0; a < items.length; a++) {
    for (let b = 0; b < a; b++) {
      if (random() < 0.15) deps.push({ itemId: items[a]!.id, dependsOnId: items[b]!.id });
    }
  }

  const limits = {
    globalConcurrency: 1 + Math.floor(random() * 3),
    perAgentConcurrency: 1 + Math.floor(random() * 3),
    perRepositoryConcurrency: 1 + Math.floor(random() * 3),
  };

  // In-flight runs are generated *within* the caps, because a state that
  // already breaches them is one the scheduler never produced and cannot
  // be asked to repair. Generating them freely was my first attempt, and
  // it failed three properties by handing `tick` an input it could only
  // have inherited from a different set of limits — the assertion caught
  // the generator, not the code.
  const activeRuns: Run[] = [];
  const runsByAgent = new Map<string, number>();
  const runsByBucket = new Map<string, number>();
  for (const item of items) {
    if (random() >= 0.25) continue;
    const agent = agents[Math.floor(random() * agents.length)]!;
    const bucket = bucketOf(item);
    if (activeRuns.length >= limits.globalConcurrency) break;
    if ((runsByAgent.get(agent.id) ?? 0) >= limits.perAgentConcurrency) continue;
    if ((runsByBucket.get(bucket) ?? 0) >= limits.perRepositoryConcurrency) continue;

    runsByAgent.set(agent.id, (runsByAgent.get(agent.id) ?? 0) + 1);
    runsByBucket.set(bucket, (runsByBucket.get(bucket) ?? 0) + 1);
    activeRuns.push({
      id: `run-${item.id}` as Uuid,
      itemId: item.id,
      agentId: agent.id,
      action: "implement",
      status: "running",
      startedAt: 0,
      endedAt: null,
    } as Run);
  }

  const awaitingInput = new Set<string>(items.filter(() => random() < 0.15).map((item) => item.id));
  const heldItemIds = new Set<string>(items.filter(() => random() < 0.15).map((item) => item.id));

  return { seed, input: { items, deps, steps, agents, activeRuns, awaitingInput, heldItemIds, limits, capacityKeyOf: bucketOf, paused: random() < 0.15 } };
}

const CASES = Array.from({ length: 400 }, (_, n) => generate(n + 1));

describe("one scheduler tick", () => {
  it("never exceeds the global cap, counting runs already in flight", () => {
    for (const { seed, input } of CASES) {
      const dispatches = tick(input);
      const total = dispatches.length + input.activeRuns.length;
      expect({ seed, withinCap: total <= input.limits.globalConcurrency }).toEqual({ seed, withinCap: true });
    }
  });

  it("never exceeds a repository's cap, counting runs already in flight there", () => {
    // The bug this guards is precise: an in-flight run on a repo-less
    // item used to count against no bucket at all, so a second loose
    // item dispatched straight into the working tree the live one was
    // already using.
    for (const { seed, input } of CASES) {
      const byId = new Map(input.items.map((item) => [item.id, item]));
      const counts = new Map<string, number>();
      for (const run of input.activeRuns) {
        const item = byId.get(run.itemId as Uuid);
        if (item) counts.set(bucketOf(item), (counts.get(bucketOf(item)) ?? 0) + 1);
      }
      for (const dispatch of tick(input)) {
        const bucket = bucketOf(dispatch.item);
        counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
      }
      for (const [bucket, count] of counts) {
        expect({ seed, bucket, within: count <= input.limits.perRepositoryConcurrency }).toEqual({ seed, bucket, within: true });
      }
    }
  });

  it("never exceeds an agent's cap", () => {
    for (const { seed, input } of CASES) {
      const counts = new Map<string, number>();
      // A builtin run has no agent and consumes no agent's capacity — it
      // takes the global and repository slots instead, which is what
      // actually matters, since it touches the same working tree.
      for (const run of input.activeRuns) {
        if (run.agentId === null) continue;
        counts.set(run.agentId, (counts.get(run.agentId) ?? 0) + 1);
      }
      for (const dispatch of tick(input)) {
        if (!dispatch.agent) continue;
        counts.set(dispatch.agent.id, (counts.get(dispatch.agent.id) ?? 0) + 1);
      }
      for (const [agentId, count] of counts) {
        expect({ seed, agentId, within: count <= input.limits.perAgentConcurrency }).toEqual({ seed, agentId, within: true });
      }
    }
  });

  it("never dispatches the same item twice in one tick", () => {
    for (const { seed, input } of CASES) {
      const ids = tick(input).map((dispatch) => dispatch.item.id);
      expect({ seed, unique: new Set(ids).size === ids.length }).toEqual({ seed, unique: true });
    }
  });

  it("never dispatches an item that already has a run in flight", () => {
    for (const { seed, input } of CASES) {
      const busy = new Set(input.activeRuns.map((run) => run.itemId));
      for (const dispatch of tick(input)) {
        expect({ seed, id: dispatch.item.id, busy: busy.has(dispatch.item.id) }).toEqual({ seed, id: dispatch.item.id, busy: false });
      }
    }
  });

  it("dispatches nothing at all while paused", () => {
    for (const { seed, input } of CASES) {
      expect({ seed, dispatched: tick({ ...input, paused: true }).length }).toEqual({ seed, dispatched: 0 });
    }
  });

  it("dispatches only an agent step owned by a role the pause exempts", () => {
    for (const { seed, input } of CASES) {
      const exempt = input.steps.find((step) => step.ownerRole !== null)?.ownerRole;
      if (!exempt) continue;
      for (const dispatch of tick({ ...input, paused: true, pauseExemptRoles: new Set([exempt]) })) {
        const step = input.steps.find((candidate) => candidate.id === dispatch.stepId && candidate.pipelineId === dispatch.item.pipelineId);
        expect({ seed, type: step?.type, role: step?.ownerRole }).toEqual({ seed, type: "agent", role: exempt });
      }
    }
  });

  it("never dispatches a held item, or one awaiting a reply", () => {
    for (const { seed, input } of CASES) {
      for (const dispatch of tick(input)) {
        expect({ seed, id: dispatch.item.id, held: input.heldItemIds.has(dispatch.item.id) }).toEqual({ seed, id: dispatch.item.id, held: false });
        expect({ seed, id: dispatch.item.id, awaiting: input.awaitingInput.has(dispatch.item.id) }).toEqual({ seed, id: dispatch.item.id, awaiting: false });
      }
    }
  });

  it("never dispatches an item that is off the pipeline", () => {
    for (const { seed, input } of CASES) {
      for (const dispatch of tick(input)) {
        expect({ seed, id: dispatch.item.id, stepless: dispatch.item.stepId === null }).toEqual({ seed, id: dispatch.item.id, stepless: false });
      }
    }
  });

  it("only ever matches an item against a step of its own pipeline", () => {
    // Two pipelines may both have a step at position 3 owned by the same
    // role; crossing them runs the wrong action on the wrong item.
    for (const { seed, input } of CASES) {
      const stepById = new Map(input.steps.map((step) => [step.id, step]));
      for (const dispatch of tick(input)) {
        const step = stepById.get(dispatch.item.stepId!)!;
        expect({ seed, id: dispatch.item.id, samePipeline: step.pipelineId === dispatch.item.pipelineId }).toEqual({ seed, id: dispatch.item.id, samePipeline: true });
      }
    }
  });

  it("never dispatches an item whose dependency is still live", () => {
    for (const { seed, input } of CASES) {
      const active = new Set(input.items.map((item) => item.id));
      for (const dispatch of tick(input)) {
        const blocked = input.deps.some((edge) => edge.itemId === dispatch.item.id && active.has(edge.dependsOnId));
        expect({ seed, id: dispatch.item.id, blocked }).toEqual({ seed, id: dispatch.item.id, blocked: false });
      }
    }
  });

  it("gives the same answer twice for the same input", () => {
    // Stated in the docstring: pure, no clock, same input same output in
    // the same order. A tick that reordered itself would make everything
    // downstream of it unreproducible.
    for (const { seed, input } of CASES) {
      const once = tick(input).map((dispatch) => `${dispatch.item.id}:${dispatch.agent?.id ?? "-"}:${dispatch.action}`);
      const twice = tick(input).map((dispatch) => `${dispatch.item.id}:${dispatch.agent?.id ?? "-"}:${dispatch.action}`);
      expect({ seed, once }).toEqual({ seed, once: twice });
    }
  });

  it("staffs an agent step with an agent whose role owns it", () => {
    for (const { seed, input } of CASES) {
      const stepById = new Map(input.steps.map((step) => [step.id, step]));
      for (const dispatch of tick(input)) {
        const step = stepById.get(dispatch.item.stepId!)!;
        if (step.type !== "agent") continue;
        expect({ seed, id: dispatch.item.id, role: dispatch.agent?.role }).toEqual({ seed, id: dispatch.item.id, role: step.ownerRole });
      }
    }
  });
});
