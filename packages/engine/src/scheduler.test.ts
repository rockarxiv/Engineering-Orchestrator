import { acceptanceCriteriaOf } from "@eo/core";
import type { Agent, Run, RunStatus, Item, Uuid, PipelineStep } from "@eo/core";
import { describe, expect, it } from "vitest";
import { dispatchBlocker, dispatchBlockers, hasDispatchableItem, tick, type CapacityKeyOf, type DispatchGate, type TickInput } from "./scheduler.js";


/** Any `item_types` row: these fixtures never read the type's row, only the word on it. */
const STORY_TYPE_ID = "0199aa00-0000-7000-8000-000000000001" as Uuid;
function makeItem(id: string, overrides: Partial<Item> = {}): Item {
  return {
    id: id as Uuid,
    key: `EO-${id}`,
    typeId: STORY_TYPE_ID,
    type: "story",
    typeLabel: "Story",
    container: false,
    parentId: null,
    workspaceId: null,
    projectId: null,
    title: id,
    body: null,
    spec: null,
    pipelineId: "p1" as Uuid,
    stepId: "todo",
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

function makeState(id: string, overrides: Partial<PipelineStep> = {}): PipelineStep {
  return {
    id,
    pipelineId: "p1" as Uuid,
    position: 0,
    name: id,
    type: "agent",
    ownerRole: "implementer",
    entryAction: "implement",
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
    ...overrides,
  };
}

function makeAgent(id: string, overrides: Partial<Agent> = {}): Agent {
  return {
    id: id as Uuid,
    name: id,
    role: "implementer",
    provider: "fake",
    model: null,
    instructions: "",
    promptHash: null,
    config: {},
    enabled: true,
    archivedAt: null,
    deletedAt: null,
    projectId: null,
    ...overrides,
  };
}

function makeRun(itemId: string, agentId: string, status: RunStatus = "running"): Run {
  return {
    // Nothing the scheduler asks depends on when the row last changed;
    // it is on the type because a *replica* pages on it (EO-324).
    updatedAt: 0,
    id: `run-${itemId}-${agentId}` as Uuid,
    itemId: itemId as Uuid,
    agentId: agentId as Uuid,
    action: "implement",
    status,
    threadId: null,
    provider: null,
    runtimeSource: null,
    instructionsHash: null,
    agentAttachmentsHash: null,
    itemFilesHash: null,
    threadLost: false,
    interruption: null,
    cwd: null,
    pid: null,
    initiationId: null,
    attempt: 1,
    result: null,
    verification: null,
    checks: null,
    error: null,
    tokensIn: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    turns: null,
    turnsScope: null,
    stepId: null,
    tokensOut: null,
    costCents: null,
    startedAt: null,
    endedAt: null,
    dryRun: false,
  };
}

/**
 * The developer pack's two scheduling functions, as far as this package
 * can see them (KAN-161).
 *
 * A copy of what `packs/developer/scheduling.ts` supplies, because this
 * package cannot import the main process. Every test below runs with
 * them, so what they prove is what EO actually schedules — the rules
 * themselves are the pack's and are asserted there. What the engine owns
 * is that a bucket is capped, that a gate's answer is carried back
 * whole, and that the absence of either changes nothing else.
 */
const PACK_CAPACITY_KEY: CapacityKeyOf = (item) => item.workspaceId ?? "";
const PACK_DISPATCH_GATE: DispatchGate = (item, step) =>
  step.entryAction === "review" && acceptanceCriteriaOf(item).length === 0 ? { kind: "no_acceptance_criteria" } : null;

function baseInput(overrides: Partial<TickInput> = {}): TickInput {
  return {
    items: [],
    deps: [],
    steps: [],
    agents: [],
    activeRuns: [],
    awaitingInput: new Set(),
    heldItemIds: new Set(),
    limits: { globalConcurrency: 10, perAgentConcurrency: 10, perRepositoryConcurrency: 10 },
    paused: false,
    capacityKeyOf: PACK_CAPACITY_KEY,
    dispatchGate: PACK_DISPATCH_GATE,
    ...overrides,
  };
}

/**
 * An item finishing on an older version of its pipeline (EO-327,
 * the original design).
 *
 * "An item binds to the version it entered on and finishes there" is
 * about running as well as routing, and the scheduler is where running
 * begins: told this item's own step definition, it dispatches by that
 * rather than by whatever the live row says now. The map exists because
 * the ordinary index is keyed by `(pipelineId, stepId)` and two items on
 * one step under two versions are two different definitions.
 */
describe("tick — a step definition bound to one item", () => {
  const live = makeState("todo", { type: "user", ownerRole: null, entryAction: null });
  const asItEntered = makeState("todo", { type: "agent", ownerRole: "implementer", entryAction: "implement" });

  it("dispatches by the definition the item entered on, not the live one", () => {
    const item = makeItem("A", { pipelineVersionId: "v1" });
    const result = tick(
      baseInput({
        items: [item],
        steps: [live],
        stepsByItem: new Map([[item.id as string, asItEntered]]),
        agents: [makeAgent("agent-1")],
      }),
    );

    expect(result.map((dispatch) => [dispatch.item.id, dispatch.action])).toEqual([["A", "implement"]]);
  });

  it("leaves every other item on the live definition", () => {
    const bound = makeItem("A", { pipelineVersionId: "v1" });
    const current = makeItem("B");
    const result = tick(
      baseInput({
        items: [bound, current],
        steps: [live],
        stepsByItem: new Map([[bound.id as string, asItEntered]]),
        agents: [makeAgent("agent-1")],
      }),
    );

    // B is on a human step as the pipeline stands, so nothing dispatches
    // for it — which is the behaviour every item had before versions.
    expect(result.map((dispatch) => dispatch.item.id)).toEqual(["A"]);
  });

  /**
   * Held to the same rule as the index under it: a step it names must
   * belong to this item's pipeline and be the one the item is standing
   * on, so a stale entry cannot dispatch one pipeline's item against
   * another's step.
   */
  it("ignores an entry that names another pipeline's step", () => {
    const item = makeItem("A", { pipelineVersionId: "v1" });
    const elsewhere = makeState("todo", { pipelineId: "p2" as Uuid, type: "agent" });
    const result = tick(
      baseInput({
        items: [item],
        steps: [live],
        stepsByItem: new Map([[item.id as string, elsewhere]]),
        agents: [makeAgent("agent-1")],
      }),
    );

    expect(result).toEqual([]);
  });

  it("says what is in the way of an item whose own version has no role on the step", () => {
    const item = makeItem("A", { pipelineVersionId: "v1" });
    const blocker = dispatchBlocker(
      baseInput({ items: [item], steps: [asItEntered], stepsByItem: new Map([[item.id as string, live]]), agents: [makeAgent("agent-1")] }),
      item.id,
    );

    // The live row would run; the item's own version says a person acts
    // here, and that is the answer the item is owed.
    expect(blocker).toEqual({ kind: "step_not_dispatchable", stepId: "todo" });
  });
});

describe("tick — skip conditions", () => {
  it("1. skips an item in a human-owned state (owner_role === null)", () => {
    const result = tick(
      baseInput({
        items: [makeItem("A", { stepId: "review" })],
        steps: [makeState("review", { ownerRole: null })],
        agents: [makeAgent("agent-1")],
      }),
    );
    expect(result).toEqual([]);
  });

  it("2. skips an item with an open (non-terminal) dependency", () => {
    const result = tick(
      baseInput({
        items: [makeItem("A"), makeItem("B", { stepId: "todo" })],
        deps: [{ itemId: "A" as Uuid, dependsOnId: "B" as Uuid }],
        steps: [makeState("todo", { isTerminal: false })],
        agents: [makeAgent("agent-1")],
      }),
    );
    expect(result.map((d) => d.item.id)).toEqual(["B"]); // B has no deps of its own
  });

  it("2b. dispatches once the dependency's state is terminal", () => {
    const result = tick(
      baseInput({
        items: [makeItem("A"), makeItem("B", { stepId: "done" })],
        deps: [{ itemId: "A" as Uuid, dependsOnId: "B" as Uuid }],
        steps: [makeState("todo"), makeState("done", { isTerminal: true, ownerRole: null })],
        agents: [makeAgent("agent-1")],
      }),
    );
    expect(result.map((d) => d.item.id)).toEqual(["A"]);
  });

  /**
   * The archive deadlock (EO-335).
   *
   * `deps` is unfiltered and `items` is not, so an edge outlives the
   * item it points at. Every one of these three cases used to answer
   * "open dependency", because the lookup missed and a miss read as
   * "has not finished" — and the first of them is reached by doing
   * everything right: finish the dependency, let the sweep put it away,
   * and watch the dependent never run again.
   */
  it("2c. dispatches when the only dependency is finished and archived — hidden from `items`, still in `dependencyItems`", () => {
    const archived = makeItem("B", { stepId: "done", archivedAt: 1_000 });
    const result = tick(
      baseInput({
        items: [makeItem("A")],
        dependencyItems: [makeItem("A"), archived],
        deps: [{ itemId: "A" as Uuid, dependsOnId: "B" as Uuid }],
        steps: [makeState("todo"), makeState("done", { isTerminal: true, ownerRole: null })],
        agents: [makeAgent("agent-1")],
      }),
    );
    expect(result.map((d) => d.item.id)).toEqual(["A"]);
  });

  it("2d. still blocks on a hidden dependency that has *not* finished", () => {
    // Hidden from the candidate list without being done — an item whose
    // project is mid-transfer (EO-325) is the real one. Widening the
    // lookup must not turn "we are not allowed to touch it" into "it
    // finished".
    const blocker = dispatchBlocker(
      baseInput({
        items: [makeItem("A")],
        dependencyItems: [makeItem("A"), makeItem("B", { stepId: "todo" })],
        deps: [{ itemId: "A" as Uuid, dependsOnId: "B" as Uuid }],
        steps: [makeState("todo")],
        agents: [makeAgent("agent-1")],
      }),
      "A",
    );
    expect(blocker).toEqual({ kind: "open_dependency" });
  });

  it("2e. does not block on an edge pointing at no item at all", () => {
    const result = tick(
      baseInput({
        items: [makeItem("A")],
        dependencyItems: [makeItem("A")],
        deps: [{ itemId: "A" as Uuid, dependsOnId: "gone" as Uuid }],
        steps: [makeState("todo")],
        agents: [makeAgent("agent-1")],
      }),
    );
    expect(result.map((d) => d.item.id)).toEqual(["A"]);
  });

  it("3. skips an item awaiting a reply", () => {
    const result = tick(
      baseInput({
        items: [makeItem("A")],
        steps: [makeState("todo")],
        agents: [makeAgent("agent-1")],
        awaitingInput: new Set(["A"]),
      }),
    );
    expect(result).toEqual([]);
  });

  it("3b. skips a held item even when it is otherwise dispatchable", () => {
    const result = tick(
      baseInput({
        items: [makeItem("A")],
        steps: [makeState("todo")],
        agents: [makeAgent("agent-1")],
        heldItemIds: new Set(["A"]),
      }),
    );
    expect(result).toEqual([]);
  });

  it("3c. skips an item whose retry is not due yet, and says until when", () => {
    const input = baseInput({
      items: [makeItem("A"), makeItem("B")],
      steps: [makeState("todo")],
      agents: [makeAgent("agent-1")],
      retryAfter: new Map([["A", 1_700_000_030_000]]),
    });
    expect(tick(input).map((dispatch) => dispatch.item.id)).toEqual(["B"]);
    expect(dispatchBlocker(input, "A")).toEqual({ kind: "retry_backoff", until: 1_700_000_030_000 });
  });

  it("3d. holds an item on a step that keeps checking until its next check is due, and says when (EO-456)", () => {
    const input = baseInput({
      items: [makeItem("A", { stepId: "watch" }), makeItem("B", { stepId: "watch" })],
      steps: [makeState("watch", { type: "builtin", ownerRole: null, entryAction: "check", watch: { everyMinutes: 5, giveUpAfterHours: 168 } })],
      agents: [],
      watchingUntil: new Map([["A", { nextCheckAt: 1_700_000_300_000, giveUpAt: 1_700_604_800_000 }]]),
    });
    // B's check is due — its watch is not in the map — so it is the one
    // dispatched, with no agent, exactly as a builtin step's run is.
    expect(tick(input).map((dispatch) => [dispatch.item.id, dispatch.agent, dispatch.action])).toEqual([["B", null, "check"]]);
    expect(dispatchBlocker(input, "A")).toEqual({ kind: "watching", nextCheckAt: 1_700_000_300_000, giveUpAt: 1_700_604_800_000 });
    expect(dispatchBlockers(input).map(({ item, blocker }) => [item.id, blocker.kind])).toEqual([["A", "watching"]]);
  });

  it("3e. holds every watch the host says is held, whether or not its check is due (EO-457)", () => {
    const watchStep = makeState("watch", { type: "builtin", ownerRole: null, entryAction: "check", watch: { everyMinutes: 5, giveUpAfterHours: 168 } });
    const offline = baseInput({
      items: [makeItem("A", { stepId: "watch" }), makeItem("B", { stepId: "watch" })],
      steps: [watchStep],
      agents: [],
      watchingUntil: new Map([["A", { nextCheckAt: 1_700_000_300_000, giveUpAt: 1_700_604_800_000 }]]),
      watchesHeld: new Map([
        ["A", { reason: "offline" as const }],
        ["B", { reason: "offline" as const }],
      ]),
    });
    expect(tick(offline)).toEqual([]);
    // Offline is named over the wait between checks: nobody knows when it ends.
    expect(dispatchBlocker(offline, "A")).toEqual({ kind: "watch_held", reason: "offline" });
    expect(dispatchBlocker(offline, "B")).toEqual({ kind: "watch_held", reason: "offline" });

    const waking = baseInput({
      items: [makeItem("A", { stepId: "watch" }), makeItem("B", { stepId: "watch" }), makeItem("C", { stepId: "watch" })],
      steps: [watchStep],
      agents: [],
      watchingUntil: new Map([
        ["A", { nextCheckAt: 1_700_000_300_000, giveUpAt: 1_700_604_800_000 }],
        ["B", { nextCheckAt: 1_700_000_030_000, giveUpAt: 1_700_604_800_000 }],
      ]),
      watchesHeld: new Map([
        ["A", { reason: "waking" as const, until: 1_700_000_060_000 }],
        ["B", { reason: "waking" as const, until: 1_700_000_060_000 }],
        ["C", { reason: "waking" as const, until: 1_700_000_060_000 }],
      ]),
    });
    expect(tick(waking)).toEqual([]);
    // A check already an hour off is still that check; one the hold outlasts is held by it.
    expect(dispatchBlocker(waking, "A")?.kind).toBe("watching");
    expect(dispatchBlocker(waking, "B")).toEqual({ kind: "watch_held", reason: "waking", until: 1_700_000_060_000 });
    expect(dispatchBlocker(waking, "C")).toEqual({ kind: "watch_held", reason: "waking", until: 1_700_000_060_000 });
  });

  it("4. skips an item that already has an active run", () => {
    const result = tick(
      baseInput({
        items: [makeItem("A")],
        steps: [makeState("todo")],
        agents: [makeAgent("agent-1")],
        activeRuns: [makeRun("A", "agent-1")],
      }),
    );
    expect(result).toEqual([]);
  });

  it("5a. skips when no agent has the required role", () => {
    const result = tick(
      baseInput({
        items: [makeItem("A")],
        steps: [makeState("todo", { ownerRole: "implementer" })],
        agents: [makeAgent("agent-1", { role: "reviewer" })],
      }),
    );
    expect(result).toEqual([]);
  });

  it("5b. skips a disabled agent", () => {
    const result = tick(
      baseInput({
        items: [makeItem("A")],
        steps: [makeState("todo")],
        agents: [makeAgent("agent-1", { enabled: false })],
      }),
    );
    expect(result).toEqual([]);
  });

  it("5b-ii. skips an archived agent, and says the role has nobody rather than that it is busy", () => {
    // An archived agent staffs nothing (EO-186). Getting this wrong in
    // the safe-looking direction — counting one, because the switch it
    // was retired with says `enabled` — is the quietest failure the
    // scheduler has: the step reports no blocker and dispatches nothing,
    // forever. So both answers are asserted, because they come from the
    // same rule and must not come apart.
    const input = baseInput({
      items: [makeItem("A")],
      steps: [makeState("todo")],
      agents: [makeAgent("agent-1", { archivedAt: 1_700_000_000_000 })],
    });

    expect(tick(input)).toEqual([]);
    expect(dispatchBlocker(input, "A")).toEqual({ kind: "no_enabled_agent", role: "implementer" });
  });

  it("5b-iii. dispatches to the live holder of a role one of whose agents is archived", () => {
    // The other half: archiving one agent must not take the role with
    // it, or "retire the one nobody uses" would park the column.
    const result = tick(
      baseInput({
        items: [makeItem("A")],
        steps: [makeState("todo")],
        agents: [makeAgent("agent-1", { archivedAt: 1_700_000_000_000 }), makeAgent("agent-2")],
      }),
    );

    expect(result.map((dispatch) => dispatch.agent?.id)).toEqual(["agent-2"]);
  });

  it("5c. skips an agent at per-agent capacity, but picks a different agent with room", () => {
    const result = tick(
      baseInput({
        items: [makeItem("A")],
        steps: [makeState("todo")],
        agents: [makeAgent("agent-1"), makeAgent("agent-2")],
        activeRuns: [makeRun("existing", "agent-1")],
        limits: { globalConcurrency: 10, perAgentConcurrency: 1, perRepositoryConcurrency: 10 },
      }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.agent?.id).toBe("agent-2");
  });

  it("6. the global pause flag stops every dispatch, even an otherwise-eligible one", () => {
    const result = tick(
      baseInput({
        items: [makeItem("A")],
        steps: [makeState("todo")],
        agents: [makeAgent("agent-1")],
        paused: true,
      }),
    );
    expect(result).toEqual([]);
  });
});

describe("tick — never dispatches two runs for the same item", () => {
  it("dispatches at most one run per item even with multiple eligible agents", () => {
    const result = tick(
      baseInput({
        items: [makeItem("A")],
        steps: [makeState("todo")],
        agents: [makeAgent("agent-1"), makeAgent("agent-2")],
      }),
    );
    expect(result).toHaveLength(1);
  });
});

describe("tick — concurrency caps", () => {
  it("caps at globalConcurrency: with 1 and three ready items, exactly one dispatch is returned", () => {
    const result = tick(
      baseInput({
        items: [makeItem("A"), makeItem("B"), makeItem("C")],
        steps: [makeState("todo")],
        agents: [makeAgent("agent-1", { role: "implementer" })],
        limits: { globalConcurrency: 1, perAgentConcurrency: 10, perRepositoryConcurrency: 10 },
      }),
    );
    expect(result).toHaveLength(1);
  });

  it("leaves the slots side calls hold free (EO-477): one reserved under a cap of 1 dispatches nothing, under 2 dispatches one", () => {
    const input = {
      items: [makeItem("A"), makeItem("B"), makeItem("C")],
      steps: [makeState("todo")],
      agents: [makeAgent("agent-1", { role: "implementer" })],
    };
    expect(tick(baseInput({ ...input, limits: { globalConcurrency: 1, perAgentConcurrency: 10, perRepositoryConcurrency: 10 }, reservedSlots: 1 }))).toEqual([]);
    expect(tick(baseInput({ ...input, limits: { globalConcurrency: 2, perAgentConcurrency: 10, perRepositoryConcurrency: 10 }, reservedSlots: 1 }))).toHaveLength(1);
    // None reserved is the tick it always was.
    expect(tick(baseInput({ ...input, limits: { globalConcurrency: 2, perAgentConcurrency: 10, perRepositoryConcurrency: 10 } }))).toHaveLength(2);
  });

  it("respects perAgentConcurrency across multiple ready items for the same agent", () => {
    const result = tick(
      baseInput({
        items: [makeItem("A"), makeItem("B"), makeItem("C")],
        steps: [makeState("todo")],
        agents: [makeAgent("agent-1")],
        limits: { globalConcurrency: 10, perAgentConcurrency: 2, perRepositoryConcurrency: 10 },
      }),
    );
    expect(result).toHaveLength(2);
  });

  it("accounts for already-active runs against both caps, not just this tick's new dispatches", () => {
    const result = tick(
      baseInput({
        items: [makeItem("A"), makeItem("B")],
        steps: [makeState("todo")],
        agents: [makeAgent("agent-1")],
        activeRuns: [makeRun("existing-1", "agent-1"), makeRun("existing-2", "agent-1")],
        limits: { globalConcurrency: 3, perAgentConcurrency: 5, perRepositoryConcurrency: 10 },
      }),
    );
    // 2 active runs already consume 2 of the 3 global slots.
    expect(result).toHaveLength(1);
  });
});

describe("tick — ordering", () => {
  it("under a global cap, picks the highest-priority item first", () => {
    const result = tick(
      baseInput({
        items: [makeItem("low", { priority: 0 }), makeItem("high", { priority: 10 })],
        steps: [makeState("todo")],
        agents: [makeAgent("agent-1")],
        limits: { globalConcurrency: 1, perAgentConcurrency: 10, perRepositoryConcurrency: 10 },
      }),
    );
    expect(result.map((d) => d.item.id)).toEqual(["high"]);
  });

  it("breaks priority ties with the older item (created_at ascending)", () => {
    const result = tick(
      baseInput({
        items: [
          makeItem("newer", { priority: 5, createdAt: 200 }),
          makeItem("older", { priority: 5, createdAt: 100 }),
        ],
        steps: [makeState("todo")],
        agents: [makeAgent("agent-1")],
        limits: { globalConcurrency: 1, perAgentConcurrency: 10, perRepositoryConcurrency: 10 },
      }),
    );
    expect(result.map((d) => d.item.id)).toEqual(["older"]);
  });

  // EO-582: what the host puts first in line is offered the slot before
  // anything else — whatever its priority or age — and only the order
  // changes.
  it("offers a slot to what is first in line ahead of higher-priority, older work", () => {
    const result = tick(
      baseInput({
        items: [makeItem("live", { priority: 10, createdAt: 100 }), makeItem("trial", { priority: 0, createdAt: 200 })],
        steps: [makeState("todo")],
        agents: [makeAgent("agent-1")],
        limits: { globalConcurrency: 1, perAgentConcurrency: 10, perRepositoryConcurrency: 10 },
        firstInLine: new Set(["trial"]),
      }),
    );
    expect(result.map((d) => d.item.id)).toEqual(["trial"]);
  });

  it("orders by priority, then age, within what is first in line and without it", () => {
    const result = tick(
      baseInput({
        items: [
          makeItem("live-old", { priority: 0, createdAt: 1 }),
          makeItem("trial-new", { priority: 0, createdAt: 300 }),
          makeItem("trial-urgent", { priority: 5, createdAt: 400 }),
          makeItem("trial-old", { priority: 0, createdAt: 200 }),
          makeItem("live-urgent", { priority: 9, createdAt: 2 }),
        ],
        steps: [makeState("todo")],
        agents: [makeAgent("agent-1")],
        limits: { globalConcurrency: 5, perAgentConcurrency: 10, perRepositoryConcurrency: 10 },
        firstInLine: new Set(["trial-new", "trial-urgent", "trial-old"]),
      }),
    );
    expect(result.map((d) => d.item.id)).toEqual(["trial-urgent", "trial-old", "trial-new", "live-urgent", "live-old"]);
  });

  it("first in line changes no cap: a blocked or capped item stays where it was", () => {
    const result = tick(
      baseInput({
        items: [makeItem("live"), makeItem("trial", { heldAt: 1 })],
        steps: [makeState("todo")],
        agents: [makeAgent("agent-1")],
        heldItemIds: new Set(["trial"]),
        limits: { globalConcurrency: 1, perAgentConcurrency: 10, perRepositoryConcurrency: 10 },
        firstInLine: new Set(["trial"]),
      }),
    );
    expect(result.map((d) => d.item.id)).toEqual(["live"]);
  });

  it("is deterministic: the same input always yields the same output, in the same order", () => {
    const input = baseInput({
      items: [makeItem("A", { priority: 1 }), makeItem("B", { priority: 2 }), makeItem("C", { priority: 1 })],
      steps: [makeState("todo")],
      agents: [makeAgent("agent-1"), makeAgent("agent-2")],
      limits: { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 },
    });

    const first = tick(input);
    const second = tick(input);
    expect(second).toEqual(first);
  });
});

describe("many repositories (D-04)", () => {
  const twoProjects = () => ({
    items: [
      makeItem("api-1", { workspaceId: "api" as Uuid }),
      makeItem("api-2", { workspaceId: "api" as Uuid }),
      makeItem("web-1", { workspaceId: "web" as Uuid }),
    ],
    steps: [makeState("todo")],
    agents: [makeAgent("agent-1")],
  });

  it("advances every repository, not just one", () => {
    // The engine has no notion of an "active" repository — that is a view
    // concept. Work in a repo you are not looking at still progresses.
    const result = tick(
      baseInput({
        ...twoProjects(),
        limits: { globalConcurrency: 10, perAgentConcurrency: 10, perRepositoryConcurrency: 10 },
      }),
    );

    expect(new Set(result.map((dispatch) => dispatch.item.workspaceId))).toEqual(new Set(["api", "web"]));
  });

  it("caps each repository independently, so one busy repo can't starve another", () => {
    const result = tick(
      baseInput({
        ...twoProjects(),
        limits: { globalConcurrency: 10, perAgentConcurrency: 10, perRepositoryConcurrency: 1 },
      }),
    );

    // One from each — not both of api's just because they sorted first.
    expect(result.map((dispatch) => dispatch.item.id)).toEqual(["api-1", "web-1"]);
  });

  it("counts runs already in flight against their repository's cap", () => {
    const result = tick(
      baseInput({
        ...twoProjects(),
        activeRuns: [makeRun("api-1", "agent-1")],
        limits: { globalConcurrency: 10, perAgentConcurrency: 10, perRepositoryConcurrency: 1 },
      }),
    );

    // api is full because of the live run; web is free.
    expect(result.map((dispatch) => dispatch.item.id)).toEqual(["web-1"]);
  });

  it("still obeys the global cap across repositories", () => {
    // Both caps apply. Invariant #10 holds out of the box because both
    // default to 1 — raising only the per-repository cap changes nothing.
    const result = tick(
      baseInput({
        ...twoProjects(),
        limits: { globalConcurrency: 1, perAgentConcurrency: 10, perRepositoryConcurrency: 10 },
      }),
    );

    expect(result).toHaveLength(1);
  });

  it("treats items with no repository as one bucket rather than as unlimited", () => {
    // EO before a repo is attached: those items all run in the same
    // place, so they compete for the same slot.
    const result = tick(
      baseInput({
        items: [makeItem("loose-1"), makeItem("loose-2")],
        steps: [makeState("todo")],
        agents: [makeAgent("agent-1")],
        limits: { globalConcurrency: 10, perAgentConcurrency: 10, perRepositoryConcurrency: 1 },
      }),
    );

    expect(result).toHaveLength(1);
  });

  it("counts an in-flight run on a repository-less item against that shared bucket", () => {
    // The mirror of the named-repository case above. A loose item runs in
    // the process cwd, so a live run there fills the one slot its peers
    // share — attributing it to nothing would put a second agent in the
    // working tree the live run is already using.
    const result = tick(
      baseInput({
        items: [makeItem("loose-1"), makeItem("loose-2")],
        steps: [makeState("todo")],
        agents: [makeAgent("agent-1")],
        activeRuns: [makeRun("loose-1", "agent-1")],
        limits: { globalConcurrency: 10, perAgentConcurrency: 10, perRepositoryConcurrency: 1 },
      }),
    );

    expect(result).toEqual([]);
  });
});

describe("step kinds", () => {
  it("dispatches a built-in step with no agent", () => {
    // EO runs the function itself, so there is no role to staff. Before
    // this, cutting a worktree happened inside dispatch and an item
    // waiting for one looked exactly like an item nothing was doing.
    const result = tick(
      baseInput({
        items: [makeItem("A", { stepId: "worktree" })],
        steps: [makeState("worktree", { type: "builtin", ownerRole: null, entryAction: "create_worktree" })],
        agents: [],
      }),
    );

    expect(result).toEqual([expect.objectContaining({ agent: null, action: "create_worktree" })]);
  });

  it("will not dispatch a built-in step that names no function", () => {
    // The validator rejects this at save time; reaching it means the row
    // was edited around that check, and running nothing beats guessing.
    const result = tick(
      baseInput({
        items: [makeItem("A", { stepId: "worktree" })],
        steps: [makeState("worktree", { type: "builtin", ownerRole: null, entryAction: null })],
        agents: [],
      }),
    );

    expect(result).toEqual([]);
  });

  it("never dispatches a terminal step, whatever it says it does", () => {
    // A terminal step that also ran something would run it on every tick:
    // the item has arrived nowhere new, so it never has an active run.
    const result = tick(
      baseInput({
        items: [makeItem("A", { stepId: "done" })],
        steps: [makeState("done", { isTerminal: true })],
        agents: [makeAgent("agent-1")],
      }),
    );

    expect(result).toEqual([]);
  });

  it("leaves a `user` step alone — that is the engine handing off", () => {
    const result = tick(
      baseInput({
        items: [makeItem("A", { stepId: "sign_off" })],
        steps: [makeState("sign_off", { type: "user", ownerRole: null, entryAction: null })],
        agents: [makeAgent("agent-1")],
      }),
    );

    expect(result).toEqual([]);
  });

  it("spends no agent capacity on a built-in run", () => {
    // A builtin holds a repository slot, because it touches the same
    // working tree — but there is no agent for it to keep busy.
    const result = tick(
      baseInput({
        items: [makeItem("A"), makeItem("B", { stepId: "worktree" })],
        steps: [makeState("todo"), makeState("worktree", { position: 1, type: "builtin", ownerRole: null, entryAction: "create_worktree" })],
        agents: [makeAgent("agent-1")],
        activeRuns: [{ ...makeRun("existing", "agent-1"), agentId: null }],
        limits: { globalConcurrency: 10, perAgentConcurrency: 1, perRepositoryConcurrency: 10 },
      }),
    );

    // The builtin already running took no slot from the implementer.
    expect(result.map((dispatch) => dispatch.item.id)).toContain("A");
  });
});

/**
 * A review needs something to judge against (EO-213).
 *
 * EO-204 reached a merge request on its thirteenth implementation run,
 * and eleven of its twelve rejections opened with the same sentence: the
 * item declared no acceptance criteria and the reviewer reported on
 * something anyway. Nine of those twelve carried exactly one blocking
 * issue — the shape EO-200 exists to prevent, running with nothing to
 * hold it to. So the dispatch does not happen at all.
 */
describe("a review with nothing to judge against", () => {
  const reviewStep = (overrides: Partial<PipelineStep> = {}): PipelineStep =>
    makeState("review", { position: 1, ownerRole: "reviewer", entryAction: "review", ...overrides });

  const reviewer = (): Agent => makeAgent("agent-1", { role: "reviewer" });

  function reviewInput(item: Item): TickInput {
    return baseInput({ items: [item], steps: [reviewStep()], agents: [reviewer()] });
  }

  const declaring = (...criteria: string[]): Partial<Item> => ({
    stepId: "review",
    spec: { acceptance_criteria: criteria },
  });

  it("is not dispatched, and the blocker names the reason", () => {
    const input = reviewInput(makeItem("A", { stepId: "review" }));

    expect(tick(input)).toEqual([]);
    expect(dispatchBlocker(input, "A")).toEqual({ kind: "no_acceptance_criteria" });
  });

  it("dispatches exactly as before once one criterion is there", () => {
    const input = reviewInput(makeItem("A", declaring("Returns 429 after 100 requests in a minute.")));

    expect(dispatchBlocker(input, "A")).toBeNull();
    expect(tick(input).map((dispatch) => [dispatch.action, dispatch.agent?.id])).toEqual([["review", "agent-1"]]);
  });

  it("counts a criterion nobody wrote as no criterion", () => {
    // The scheduler and `summariseCriteriaCoverage` have to agree about
    // what "declared" means. A list holding one blank string counting
    // here and not there would dispatch a review that could never be
    // judged — which is the failure, not a near miss of it.
    expect(dispatchBlocker(reviewInput(makeItem("A", declaring("   ", ""))), "A")).toEqual({ kind: "no_acceptance_criteria" });
    expect(dispatchBlocker(reviewInput(makeItem("A", { stepId: "review", spec: { acceptance_criteria: "not a list" } })), "A")).toEqual({
      kind: "no_acceptance_criteria",
    });
  });

  it("holds a bug to the same rule, and makes no criterion out of its `expected`", () => {
    // The tempting shortcut, refused: a bug's four reproduction fields
    // are its intake bar, and turning `expected` into a criterion would
    // be EO declaring one nobody wrote. That is the thing EO-200's whole
    // design refuses to do, so a bug is refused like anything else and a
    // person says in one line whether `expected` is the bar.
    const bug = makeItem("A", {
      type: "bug",
      stepId: "review",
      spec: {
        steps_to_reproduce: "Send 101 requests.",
        expected: "The 101st is refused with a 429.",
        actual: "It succeeds.",
        environment: "0.4.1, linux",
      },
    });

    expect(tick(reviewInput(bug))).toEqual([]);
    expect(dispatchBlocker(reviewInput(bug), "A")).toEqual({ kind: "no_acceptance_criteria" });
  });

  it("says nothing about any step that is not judging the item", () => {
    // Keyed on the action, so an implementer step with no criteria is
    // dispatched exactly as it always was — this is about what a review
    // needs, not about what an item must carry.
    const input = baseInput({ items: [makeItem("A")], steps: [makeState("todo")], agents: [makeAgent("agent-1")] });

    expect(dispatchBlocker(input, "A")).toBeNull();
    expect(tick(input)).toHaveLength(1);
  });

  it("applies to any step that runs `review`, whatever it is called and whoever owns it", () => {
    // Invariant #7: inserting a `qa` step that reviews takes no
    // TypeScript, so the rule cannot be keyed on the shipped pipeline's
    // step id or on the reviewer role.
    const input = baseInput({
      items: [makeItem("A", { stepId: "qa" })],
      steps: [makeState("qa", { position: 1, ownerRole: "qa", entryAction: "review" })],
      agents: [makeAgent("agent-1", { role: "qa" })],
    });

    expect(dispatchBlocker(input, "A")).toEqual({ kind: "no_acceptance_criteria" });
  });

  it("offers the whole board's blockers in one pass, and none at all while paused", () => {
    // What the supervisor asks so it can say out loud which reviews it
    // is turning away. Paused is deliberately not among the answers: it
    // is a fact about the installation, and refusing every item on the
    // board for it would be EO reporting its own switch.
    const input = baseInput({
      items: [makeItem("A", { stepId: "review" }), makeItem("B", declaring("Something checkable."))],
      steps: [reviewStep()],
      agents: [reviewer()],
    });

    expect(dispatchBlockers(input).map((blocked) => [blocked.item.id, blocked.blocker.kind])).toEqual([["A", "no_acceptance_criteria"]]);
    expect(dispatchBlockers({ ...input, paused: true })).toEqual([]);
  });
});

/**
 * The two things the scheduler now takes as data (ARCHITECTURE.md, "The core is domain-neutral",
 * KAN-161).
 *
 * It used to read `item.workspaceId` for a capacity bucket and check
 * acceptance criteria before a review, which made a domain-neutral
 * scheduler know what a repository is and what work is judged against.
 * Both arrive as functions now — and a core with no pack installed
 * supplies neither, which is what these fix in place.
 */
describe("scheduling with no pack installed", () => {
  const loose = (id: string, workspaceId: string): Item => makeItem(id, { workspaceId: workspaceId as Uuid });

  const board = () => ({
    items: [loose("api-1", "api"), loose("api-2", "api"), loose("web-1", "web")],
    steps: [makeState("todo")],
    agents: [makeAgent("agent-1")],
  });

  it("caps nothing but the global limit when every item is in no bucket", () => {
    // `capacityKeyOf` answering null for everything: three items in
    // what used to be two repositories, a per-bucket cap of 1, and
    // nothing turned away for it.
    const result = tick(
      baseInput({
        ...board(),
        capacityKeyOf: () => null,
        limits: { globalConcurrency: 10, perAgentConcurrency: 10, perRepositoryConcurrency: 1 },
      }),
    );

    expect(result.map((dispatch) => dispatch.item.id)).toEqual(["api-1", "api-2", "web-1"]);
  });

  it("still obeys the global cap with nothing bucketed", () => {
    // The cap that is policy rather than a bucket (invariant #10). It is
    // the only one left, so it has to be the one that holds.
    const result = tick(
      baseInput({
        ...board(),
        capacityKeyOf: () => null,
        limits: { globalConcurrency: 2, perAgentConcurrency: 10, perRepositoryConcurrency: 1 },
      }),
    );

    expect(result).toHaveLength(2);
  });

  it("counts an in-flight run against nothing when its item is in no bucket", () => {
    // The mirror of the shared-bucket case: with no bucket to attribute
    // it to, a live run consumes a global slot and no more.
    const result = tick(
      baseInput({
        ...board(),
        capacityKeyOf: () => null,
        activeRuns: [makeRun("api-1", "agent-1")],
        limits: { globalConcurrency: 10, perAgentConcurrency: 10, perRepositoryConcurrency: 1 },
      }),
    );

    expect(result.map((dispatch) => dispatch.item.id)).toEqual(["api-2", "web-1"]);
  });

  it("dispatches a review with no criteria when nothing gates it", () => {
    // The rule is the developer pack's, not the engine's: with no gate
    // supplied there is nothing to refuse, and the review runs.
    const withGate = baseInput({
      items: [makeItem("A", { stepId: "review" })],
      steps: [makeState("review", { position: 1, ownerRole: "reviewer", entryAction: "review" })],
      agents: [makeAgent("agent-1", { role: "reviewer" })],
    });
    // Taken away rather than set to undefined: an absent gate is what a
    // core with no pack has, and `exactOptionalPropertyTypes` is right
    // that the two are not the same value.
    const ungated: TickInput = { ...withGate };
    delete ungated.dispatchGate;

    expect(dispatchBlocker(ungated, "A")).toBeNull();
    expect(tick(ungated).map((dispatch) => dispatch.action)).toEqual(["review"]);
  });

  it("carries a gate's own refusal back whole, whatever it says", () => {
    // The engine never reads a refusal — the caller turns it into words
    // (invariant #8). A kind it has never heard of has to survive the
    // trip unchanged, or a second pack's rule would arrive as EO's.
    const gated = baseInput({
      items: [makeItem("A")],
      steps: [makeState("todo")],
      agents: [makeAgent("agent-1")],
      dispatchGate: () => ({ kind: "budget_spent", overBy: 4 }),
    });

    expect(dispatchBlocker(gated, "A")).toEqual({ kind: "budget_spent", overBy: 4 });
    expect(tick(gated)).toEqual([]);
    expect(dispatchBlockers(gated).map((blocked) => blocked.blocker)).toEqual([{ kind: "budget_spent", overBy: 4 }]);
  });

  it("asks the gate about the step the item is actually on", () => {
    const seen: string[] = [];
    tick(
      baseInput({
        items: [makeItem("A", { stepId: "qa" })],
        steps: [makeState("qa", { entryAction: "review", ownerRole: "qa" })],
        agents: [makeAgent("agent-1", { role: "qa" })],
        dispatchGate: (item, step) => {
          seen.push(`${item.id}@${step.id}`);
          return null;
        },
      }),
    );

    expect(seen).toEqual(["A@qa"]);
  });
});

describe("tick — agents scoped to a project (EO-474)", () => {
  const P = "0199aa00-0000-7000-8000-0000000000a1" as Uuid;
  const Q = "0199aa00-0000-7000-8000-0000000000a2" as Uuid;

  it("never dispatches a project's agent for an item of another project, or of none", () => {
    const input = baseInput({
      items: [makeItem("A", { projectId: Q }), makeItem("B", { projectId: null })],
      steps: [makeState("todo")],
      agents: [makeAgent("p-implementer", { projectId: P })],
    });

    expect(tick(input)).toEqual([]);
    // Said as a role with nobody, not as a busy agent: nobody staffs it.
    expect(dispatchBlocker(input, "A")).toEqual({ kind: "no_enabled_agent", role: "implementer" });
    expect(dispatchBlocker(input, "B")).toEqual({ kind: "no_enabled_agent", role: "implementer" });
  });

  it("dispatches a project's agent for that project's item", () => {
    const result = tick(
      baseInput({
        items: [makeItem("A", { projectId: P })],
        steps: [makeState("todo")],
        agents: [makeAgent("p-implementer", { projectId: P })],
      }),
    );

    expect(result.map((dispatch) => dispatch.agent?.id)).toEqual(["p-implementer"]);
  });

  it("dispatches only the project's own implementer when there is a global one too — whichever is listed first", () => {
    const own = makeAgent("p-implementer", { projectId: P });
    const global = makeAgent("global-implementer");
    for (const agents of [
      [global, own],
      [own, global],
    ]) {
      const result = tick(baseInput({ items: [makeItem("A", { projectId: P })], steps: [makeState("todo")], agents }));
      expect(result.map((dispatch) => dispatch.agent?.id)).toEqual(["p-implementer"]);
    }
  });

  it("dispatches the global implementer for a project with none of its own", () => {
    const result = tick(
      baseInput({
        items: [makeItem("A", { projectId: P }), makeItem("B", { projectId: Q })],
        steps: [makeState("todo")],
        agents: [makeAgent("global-implementer"), makeAgent("q-reviewer", { projectId: Q, role: "reviewer" })],
      }),
    );

    // Q's own agent is in another role, so it outranks nobody here.
    expect(result.map((dispatch) => [dispatch.item.id, dispatch.agent?.id])).toEqual([
      ["A", "global-implementer"],
      ["B", "global-implementer"],
    ]);
  });

  it("leaves a project's item waiting for its own busy implementer rather than handing it to the global one", () => {
    const input = baseInput({
      items: [makeItem("A", { projectId: P })],
      steps: [makeState("todo")],
      agents: [makeAgent("p-implementer", { projectId: P }), makeAgent("global-implementer")],
      activeRuns: [makeRun("other", "p-implementer")],
      limits: { globalConcurrency: 10, perAgentConcurrency: 1, perRepositoryConcurrency: 10 },
    });

    expect(tick(input)).toEqual([]);
    // A queue, not a reason: nothing is wrong with the item.
    expect(dispatchBlocker(input, "A")).toBeNull();
  });

  it("falls back to the global implementer when the project's own is switched off or archived", () => {
    for (const own of [makeAgent("p-implementer", { projectId: P, enabled: false }), makeAgent("p-implementer", { projectId: P, archivedAt: 1 })]) {
      const result = tick(baseInput({ items: [makeItem("A", { projectId: P })], steps: [makeState("todo")], agents: [own, makeAgent("global-implementer")] }));
      expect(result.map((dispatch) => dispatch.agent?.id)).toEqual(["global-implementer"]);
    }
  });
});

/**
 * Whether anything is waiting to be dispatched (EO-577): what memory
 * consolidation asks before it takes the global slot, so it never takes
 * it from pipeline work.
 */
describe("hasDispatchableItem", () => {
  it("is true for a queued item with an agent to run it, even with every slot taken", () => {
    const queued = baseInput({ items: [makeItem("A")], steps: [makeState("todo")], agents: [makeAgent("agent-1")] });
    expect(hasDispatchableItem(queued)).toBe(true);
    const full = { ...queued, items: [makeItem("A"), makeItem("B")], activeRuns: [makeRun("B", "agent-1")], limits: { globalConcurrency: 1, perAgentConcurrency: 1, perRepositoryConcurrency: 1 } };
    expect(tick(full)).toEqual([]);
    expect(hasDispatchableItem(full)).toBe(true);
  });

  it("is false when every item is blocked — finished, waiting on a dependency, held, already running or unstaffed — and while paused", () => {
    const steps = [makeState("todo"), makeState("done", { isTerminal: true, ownerRole: null, entryAction: null }), makeState("review", { ownerRole: "reviewer", entryAction: "review" })];
    const input = baseInput({
      items: [makeItem("finished", { stepId: "done" }), makeItem("blocked"), makeItem("held"), makeItem("running"), makeItem("unstaffed", { stepId: "review" })],
      deps: [{ itemId: "blocked" as Uuid, dependsOnId: "running" as Uuid }],
      steps,
      agents: [makeAgent("agent-1")],
      heldItemIds: new Set(["held" as Uuid]),
      activeRuns: [makeRun("running", "agent-1")],
    });
    expect(hasDispatchableItem(input)).toBe(false);
    const queued = baseInput({ items: [makeItem("A")], steps: [makeState("todo")], agents: [makeAgent("agent-1")], paused: true });
    expect(hasDispatchableItem(queued)).toBe(false);
  });
});

describe("the roles a pause does not hold (EO-615)", () => {
  const ROLE = "steward";
  const paused = (overrides: Partial<TickInput> = {}): TickInput =>
    baseInput({
      items: [makeItem("exempt", { stepId: "own" }), makeItem("other"), makeItem("builtin", { stepId: "run" }), makeItem("module", { stepId: "script" })],
      steps: [
        makeState("own", { ownerRole: ROLE, entryAction: "tend" }),
        makeState("todo"),
        // Each names the exempt role, so what turns them away is what they
        // are: EO running a function, with nobody to exempt.
        makeState("run", { type: "builtin", ownerRole: ROLE, entryAction: "create_worktree" }),
        makeState("script", { type: "module", ownerRole: ROLE, entryAction: "deploy" }),
      ],
      agents: [makeAgent("steward-1", { role: ROLE }), makeAgent("agent-1")],
      paused: true,
      pauseExemptRoles: new Set([ROLE]),
      ...overrides,
    });

  it("dispatches an agent step its role owns, and nothing else", () => {
    expect(tick(paused()).map((dispatch) => [dispatch.item.id, dispatch.agent?.id])).toEqual([["exempt", "steward-1"]]);
  });

  it("answers null for that step, and paused for any other agent, builtin or module step", () => {
    const input = paused();
    expect(dispatchBlocker(input, "exempt")).toBeNull();
    expect(dispatchBlocker(input, "other")).toEqual({ kind: "paused" });
    expect(dispatchBlocker(input, "builtin")).toEqual({ kind: "paused" });
    expect(dispatchBlocker(input, "module")).toEqual({ kind: "paused" });
    expect(dispatchBlocker(input, "nobody")).toEqual({ kind: "paused" });
  });

  it("holds everything when no role is named, and is nothing at all when EO is not paused", () => {
    expect(tick(paused({ pauseExemptRoles: new Set() }))).toEqual([]);
    expect(tick(paused({ pauseExemptRoles: undefined as never }))).toEqual([]);
    expect(dispatchBlocker(paused({ pauseExemptRoles: new Set() }), "exempt")).toEqual({ kind: "paused" });
    expect(tick(paused({ paused: false })).map((dispatch) => dispatch.item.id).sort()).toEqual(["builtin", "exempt", "module", "other"]);
  });

  it("leaves every other blocker standing on a step it exempts", () => {
    const input = paused();
    const answers: [Partial<TickInput>, string][] = [
      [{ heldItemIds: new Set(["exempt" as Uuid]) }, "held"],
      [{ awaitingInput: new Set(["exempt" as Uuid]) }, "awaiting_input"],
      [{ deps: [{ itemId: "exempt" as Uuid, dependsOnId: "other" as Uuid }] }, "open_dependency"],
      [{ activeRuns: [makeRun("exempt", "steward-1")] }, "run_active"],
      [{ agents: [makeAgent("agent-1")] }, "no_enabled_agent"],
      [{ agents: [makeAgent("steward-1", { role: ROLE, enabled: false })] }, "no_enabled_agent"],
    ];
    for (const [overrides, kind] of answers) {
      expect(tick({ ...input, ...overrides })).toEqual([]);
      expect(dispatchBlocker({ ...input, ...overrides }, "exempt")).toMatchObject({ kind });
    }
  });

  it("reads the role off the step the item is bound to, not the live one", () => {
    const bound = new Map([["exempt", makeState("own", { ownerRole: "reviewer", entryAction: "tend" })]]);
    expect(dispatchBlocker(paused({ stepsByItem: bound }), "exempt")).toEqual({ kind: "paused" });
  });

  it("reports only what stands in front of an exempt step, and counts it as waiting", () => {
    const held = paused({ heldItemIds: new Set(["exempt" as Uuid]) });
    expect(dispatchBlockers(held).map((blocked) => [blocked.item.id, blocked.blocker.kind])).toEqual([["exempt", "held"]]);
    expect(hasDispatchableItem(held)).toBe(false);
    expect(hasDispatchableItem(paused())).toBe(true);
  });
});

describe("uncappedRoles (EO-616)", () => {
  const ROLE = "steward";
  const FULL = { globalConcurrency: 1, perAgentConcurrency: 1, perRepositoryConcurrency: 1 };
  /** Every cap full: a run in the one bucket there is, by the one agent of each role. */
  const full = (overrides: Partial<TickInput> = {}): TickInput =>
    baseInput({
      items: [makeItem("busy"), makeItem("other"), makeItem("first", { stepId: "steward" }), makeItem("second", { stepId: "steward" }), makeItem("builtin", { stepId: "setup" })],
      steps: [
        makeState("todo"),
        makeState("steward", { ownerRole: ROLE, entryAction: "intake" }),
        makeState("setup", { type: "builtin", ownerRole: ROLE, entryAction: "setup" }),
      ],
      agents: [makeAgent("steward-1", { role: ROLE }), makeAgent("agent-1")],
      activeRuns: [makeRun("busy", "agent-1"), makeRun("busy", "steward-1")],
      limits: FULL,
      capacityKeyOf: () => "the-one-checkout",
      uncappedRoles: new Set([ROLE]),
      ...overrides,
    });

  it("dispatches an agent step its role owns past all three caps, and nothing else", () => {
    expect(tick(full()).map((dispatch) => [dispatch.item.id, dispatch.agent?.id])).toEqual([
      ["first", "steward-1"],
      ["second", "steward-1"],
    ]);
  });

  it("holds the same step when no role is named", () => {
    expect(tick(full({ uncappedRoles: new Set() }))).toEqual([]);
    expect(tick(full({ uncappedRoles: undefined as never }))).toEqual([]);
  });

  it("reaches a step behind work the cap has already turned away", () => {
    const input = full({ activeRuns: [], items: [makeItem("other"), makeItem("waiting"), makeItem("first", { stepId: "steward" })] });
    expect(tick(input).map((dispatch) => dispatch.item.id)).toEqual(["other", "first"]);
  });

  it("takes a slot from other work as any run does", () => {
    const input = full({ activeRuns: [], items: [makeItem("first", { stepId: "steward" }), makeItem("other")] });
    expect(tick(input).map((dispatch) => dispatch.item.id)).toEqual(["first"]);
  });

  it("prefers an agent with room, and leaves every blocker standing", () => {
    const spare = makeAgent("steward-2", { role: ROLE });
    expect(tick(full({ agents: [makeAgent("steward-1", { role: ROLE }), spare] }))[0]?.agent?.id).toBe("steward-2");
    const input = full({ items: [makeItem("first", { stepId: "steward" })], activeRuns: [makeRun("first", "steward-1")] });
    expect(tick(input)).toEqual([]);
    expect(dispatchBlocker(input, "first")).toEqual({ kind: "run_active" });
  });
});
