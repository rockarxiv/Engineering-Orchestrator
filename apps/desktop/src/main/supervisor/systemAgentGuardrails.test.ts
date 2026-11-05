import { NO_POLICY, NOT_ALLOWED_BY_YOUR_ORGANISATION, type Agent, type AgentEvent, type AgentProvider, type Item, type Run, type Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../db/client.js";
import {
  createRoute,
  createRun,
  createStep,
  getItem,
  getJob,
  getRun,
  listAgents,
  listCommentsForItem,
  listRunsForItem,
  listTransitionsForItem,
  postComment,
  sumCostCentsForItem,
  sumCostCentsSince,
  transitionItem,
  updateAgent,
  updateRun,
} from "../db/repos/index.js";
import { leaseFor } from "../db/repos/leasesRepo.js";
import { createPerson } from "../db/repos/peopleRepo.js";
import { createProject, markProjectOnTheRecord } from "../db/repos/projectsRepo.js";
import { setSetting } from "../db/repos/settingsRepo.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { MANAGED_PERSON_ID_KEY } from "../identity/viewer.js";
import { fireJob } from "../jobs/fire.js";
import { createJob } from "../jobs/jobs.js";
import { writePolicy } from "../policy/policy.js";
import { createFakeProvider, type FakeProviderScript } from "../providers/fake.js";
import { validImplementResult } from "../providers/fixtures.js";
import { attemptLimitStop } from "./attemptLimit.js";
import { createRunSupervisor, type RunSupervisor, type RunSupervisorOptions } from "./runSupervisor.js";
import { kindsPreparing } from "./testWorkspaceKinds.js";

/**
 * Only the attempt limit applies to a system agent run (EO-616): each
 * guardrail lifted for an agent in the `system` role and standing for
 * everybody else, and what the decision on EO-614 keeps. Driven through
 * the real supervisor with a scripted backend, so what is asserted is
 * what a person would see.
 */

const ROOMY = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };
const FULL = { globalConcurrency: 1, perAgentConcurrency: 1, perRepositoryConcurrency: 1 };
const INTAKE = { ready: true, type: "feature", understanding: "Understood.", decisions: [] };
const ANSWER = { outcome: { message: "Here you are.", questions: [], proposals: [] } };
const MINUTE = 60_000;

let handle: DbHandle;
let system: Agent;
let implementer: Agent;
let reviewer: Agent;

beforeEach(() => {
  handle = openMigratedTestDb();
  createStep(handle.db, { id: "ask", pipelineId: "default" as never, position: -1, name: "Intake", type: "agent", ownerRole: "system", entryAction: "intake" });
  createRoute(handle.db, { pipelineId: "default" as never, fromStepId: "ask", resultKey: "done", label: "Understood", target: "ready_to_merge", position: 0 });
  const agents = listAgents(handle.db);
  system = agents.find((agent) => agent.role === "system")!;
  implementer = agents.find((agent) => agent.role === "implementer")!;
  reviewer = agents.find((agent) => agent.role === "reviewer")!;
});

afterEach(() => {
  handle.close();
});

const onOwnStep = (overrides: Partial<Parameters<typeof createTestItem>[1]> = {}): Item =>
  createTestItem(handle.db, { type: "feature", title: "The system agent's", stepId: "ask", ...overrides });
const onImplementerStep = (overrides: Partial<Parameters<typeof createTestItem>[1]> = {}): Item =>
  createTestItem(handle.db, { type: "story", title: "The implementer's", stepId: "todo", ...overrides });
const runsOn = (item: Item): Run[] => listRunsForItem(handle.db, item.id);
const escalations = (item: Item): string[] =>
  listCommentsForItem(handle.db, item.id)
    .filter((comment) => comment.kind === "escalation")
    .map((comment) => comment.body);

function supervising(options: Omit<RunSupervisorOptions, "db">): RunSupervisor {
  return createRunSupervisor({ db: handle.db, ...options });
}

/** A backend that answers every turn with `script`, and counts what it was asked. */
function counting(script: FakeProviderScript) {
  const inner = createFakeProvider(script);
  const start = vi.fn(inner.start.bind(inner));
  const resume = vi.fn(inner.resume.bind(inner));
  const provider: AgentProvider = { start, resume };
  return { provider, start, resume };
}

/** A backend whose turn goes on until it is stopped, saying nothing. */
function endless(): AgentProvider {
  const turn = async function* (opts?: { signal?: AbortSignal }): AsyncIterable<AgentEvent> {
    yield { type: "thread_started", threadId: "thr-endless" };
    await new Promise<void>((resolve) => {
      if (opts?.signal?.aborted) resolve();
      else opts?.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    // As both backends end a turn they were stopped in.
    throw Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
  };
  return { start: (opts) => turn(opts), resume: (_thread, _message, opts) => turn(opts) };
}

/** A finished run that cost `costCents` today. */
function spend(item: Item, costCents: number): void {
  const run = createRun(handle.db, { itemId: item.id, agentId: null, action: "implement", status: "succeeded" });
  updateRun(handle.db, run.id, { costCents, startedAt: Date.now(), endedAt: Date.now() });
}

function initiationOf(item: Item): string {
  const entry = listTransitionsForItem(handle.db, item.id)
    .filter((transition) => transition.toStepId === item.stepId)
    .at(-1);
  return entry?.id ?? `initial:${item.id}:${item.stepId}`;
}

/** `times` runs of the initiation the scheduler would dispatch, each cut short without failing. */
function interrupted(item: Item, agent: Agent, action: string, times: number): void {
  for (let i = 0; i < times; i++) {
    const run = createRun(handle.db, { itemId: item.id, agentId: agent.id, action, stepId: item.stepId as string, status: "queued", initiationId: initiationOf(item) });
    updateRun(handle.db, run.id, { status: "cancelled", interruption: "restart", startedAt: 1, endedAt: 2 });
  }
}

function leftRunning(item: Item, agent: Agent, action: string, threadId: string): Run {
  const run = createRun(handle.db, { itemId: item.id, agentId: agent.id, action, status: "queued", threadId, stepId: item.stepId as string, initiationId: initiationOf(item) });
  updateRun(handle.db, run.id, { status: "running", startedAt: 1 });
  return getRun(handle.db, run.id)!;
}

describe("the budgets", () => {
  it("start and finish a system agent run with both spent, passing no cap, and refuse anybody else's", async () => {
    const own = onOwnStep();
    const theirs = onImplementerStep();
    spend(own, 1_000);
    spend(theirs, 1_000);
    const { provider, start } = counting({ steps: [{ output: "working" }], usage: { tokensIn: 10, tokensOut: 10, costCents: 500 }, result: INTAKE });
    const supervisor = supervising({ provider, limits: ROOMY, guards: { perItemBudgetCents: 100, dailyBudgetCents: 100 } });

    await supervisor.runOnce();

    expect(start).toHaveBeenCalledOnce();
    expect(start.mock.calls[0]?.[0]).not.toHaveProperty("budgetCents");
    expect(runsOn(own).find((run) => run.action === "intake")).toMatchObject({ status: "succeeded", agentId: system.id });
    expect(escalations(own)).toEqual([]);

    const refused = runsOn(theirs).find((run) => run.status === "awaiting_input");
    expect(refused?.error).toContain("Per-ticket cost budget");
    expect(refused?.threadId).toBeNull();
  });

  it("still hand anybody else's turn what is left of them, as a cap", async () => {
    onImplementerStep();
    const { provider, start } = counting({ result: validImplementResult });
    const supervisor = supervising({ provider, limits: ROOMY, guards: { dailyBudgetCents: 300 } });

    await supervisor.runOnce();

    expect(start.mock.calls[0]?.[0]).toMatchObject({ budgetCents: 300 });
  });

  it("record what a system agent run spent, in totals that can still stop another agent", async () => {
    const own = onOwnStep();
    const { provider } = counting({ steps: [{ output: "working" }], usage: { tokensIn: 10, tokensOut: 10, costCents: 600 }, result: INTAKE });
    const supervisor = supervising({ provider, limits: ROOMY, guards: { perItemBudgetCents: 500, dailyBudgetCents: 500 } });

    await supervisor.runOnce();

    expect(sumCostCentsForItem(handle.db, own.id)).toBe(600);
    expect(sumCostCentsSince(handle.db, 0)).toBe(600);

    // On that same item the per-ticket total has gone, and on another the day's.
    const sent = transitionItem(handle.db, { itemId: own.id, toStepId: "todo", actor: "human" });
    const other = onImplementerStep();
    await supervisor.runOnce();

    expect(runsOn(sent).find((run) => run.status === "awaiting_input")?.error).toContain("Per-ticket cost budget");
    expect(runsOn(other).find((run) => run.status === "awaiting_input")?.error).toContain("Daily cost budget");
  });

  it("of a job's occurrence neither refuse a system agent run nor pause the job", async () => {
    const created = createJob(handle.db, {
      projectId: null,
      name: "Morning report",
      trigger: { kind: "manual" },
      pipelineId: "default",
      template: { type: "developer:story", title: "A report", body: null },
      budgetPerOccurrenceCents: 50,
    });
    if (!created.ok) throw new Error(created.problem);
    const fired = fireJob(handle.db, created.job, { dueAt: Date.now() }).item!;
    const filed = transitionItem(handle.db, { itemId: fired.id, toStepId: "ask", actor: "human" });
    spend(filed, 60);
    const { provider, start } = counting({ result: INTAKE });

    await supervising({ provider, limits: ROOMY }).runOnce();

    expect(start).toHaveBeenCalledOnce();
    expect(runsOn(filed).find((run) => run.action === "intake")?.status).toBe("succeeded");
    expect(escalations(filed)).toEqual([]);
    expect(getJob(handle.db, created.job.id as Uuid)?.pausedAt).toBeNull();
  });
});

describe("the wall clock", () => {
  it("does not stop a system agent run, and stops anybody else's", async () => {
    const own = onOwnStep();
    const theirs = onImplementerStep();
    const supervisor = supervising({ provider: endless(), limits: ROOMY, guards: { wallClockTimeoutMs: 20 } });

    const tick = supervisor.runOnce();
    await vi.waitFor(() => expect(runsOn(theirs)[0]?.error).toContain("Wall-clock timeout"));
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(runsOn(own)[0]?.status).toBe("running");
    supervisor.cancelRun(runsOn(own)[0]!.id);
    await tick;
  });
});

describe("the silence limit", () => {
  const LIMIT = 10 * MINUTE;
  let clock: number;

  beforeEach(() => {
    clock = Date.now() + 3_600_000;
  });

  /** A watchdog pass every thirty seconds, as the app makes them. */
  function passTime(supervisor: RunSupervisor, ms: number): void {
    for (let gone = 0; gone < ms; gone += 30_000) {
      clock += 30_000;
      supervisor.watchLiveRuns();
    }
  }

  async function quiet(items: number, options: Partial<RunSupervisorOptions> = {}) {
    const supervisor = supervising({ provider: endless(), limits: ROOMY, guards: { inactivityTimeoutMs: LIMIT }, now: () => clock, ...options });
    const tick = supervisor.runOnce();
    await vi.waitFor(() => expect(supervisor.activeRunCount()).toBe(items));
    supervisor.watchLiveRuns();
    return { supervisor, tick };
  }

  it("does not stop a silent system agent run, and stops anybody else's", async () => {
    const own = onOwnStep();
    const theirs = onImplementerStep();
    const { supervisor, tick } = await quiet(2);

    passTime(supervisor, LIMIT + 2 * MINUTE);
    await vi.waitFor(() => expect(runsOn(theirs)[0]).toMatchObject({ status: "awaiting_input" }));

    expect(runsOn(theirs)[0]?.error).toContain("No word from");
    expect(runsOn(own)[0]?.status).toBe("running");
    expect(escalations(own)).toEqual([]);
    supervisor.cancelRun(runsOn(own)[0]!.id);
    await tick;
  });

  it("still carries a system agent run on in its own thread when it stays silent after a wake", async () => {
    const own = onOwnStep();
    const { supervisor, tick } = await quiet(1);

    clock += 60 * MINUTE;
    supervisor.watchLiveRuns();
    passTime(supervisor, LIMIT + MINUTE);
    await tick;

    expect(runsOn(own)[0]).toMatchObject({ status: "cancelled", interruption: "sleep", threadId: "thr-endless" });

    const { provider, resume } = counting({ result: INTAKE });
    await supervising({ provider, limits: ROOMY, now: () => clock }).runOnce();

    expect(resume).toHaveBeenCalledOnce();
    expect(resume.mock.calls[0]?.[0]).toBe("thr-endless");
    expect(resume.mock.calls[0]?.[1]).toContain("The computer went to sleep while you were working");
  });
});

describe("the interruption ceiling", () => {
  it("does not refuse a system agent dispatch at five, and refuses anybody else's", async () => {
    const own = onOwnStep();
    const theirs = onImplementerStep();
    interrupted(own, system, "intake", 5);
    interrupted(theirs, implementer, "implement", 5);
    const { provider, start } = counting({ result: INTAKE });

    await supervising({ provider, limits: ROOMY }).runOnce();

    expect(start).toHaveBeenCalledOnce();
    expect(runsOn(own).some((run) => run.status === "succeeded")).toBe(true);
    expect(escalations(own)).toEqual([]);
    expect(runsOn(theirs).find((run) => run.status === "awaiting_input")?.error).toContain("interrupted 5 times");
  });

  it("carries on a system agent run at boot past it, and orphans anybody else's", async () => {
    const own = onOwnStep();
    const theirs = onImplementerStep();
    interrupted(own, system, "intake", 5);
    interrupted(theirs, implementer, "implement", 5);
    const mine = leftRunning(own, system, "intake", "thr-mine");
    const stale = leftRunning(theirs, implementer, "implement", "thr-theirs");
    const { provider, resume } = counting({ result: INTAKE });
    const supervisor = supervising({ provider, limits: ROOMY });

    expect(await supervisor.reconcile()).toEqual({ reattached: 0, resumed: 1, orphaned: 1 });
    await supervisor.waitForIdle();

    expect(resume).toHaveBeenCalledOnce();
    expect(resume.mock.calls[0]?.[0]).toBe("thr-mine");
    expect(getRun(handle.db, mine.id)).toMatchObject({ status: "cancelled", interruption: "restart" });
    expect(getRun(handle.db, stale.id)?.error).toContain("not carried on again");
  });

  it("does not stop a forced restart of a system agent run in its own thread, and stops anybody else's", async () => {
    const own = onOwnStep();
    const theirs = onImplementerStep();
    interrupted(own, system, "intake", 4);
    interrupted(theirs, implementer, "implement", 4);
    const closing = supervising({ provider: endless(), limits: ROOMY });
    const tick = closing.runOnce();
    await vi.waitFor(() => expect(closing.activeRunCount()).toBe(2));
    closing.beginClose({ cancelRunning: true });
    await tick;
    await closing.shutdown();

    const { provider, start, resume } = counting({ result: INTAKE });
    await supervising({ provider, limits: ROOMY }).runOnce();

    expect(start).not.toHaveBeenCalled();
    expect(resume).toHaveBeenCalledOnce();
    expect(resume.mock.calls[0]?.[0]).toBe("thr-endless");
    expect(resume.mock.calls[0]?.[1]).toContain("EO was closed while you were working");
    expect(runsOn(own).some((run) => run.status === "succeeded")).toBe(true);
    expect(escalations(theirs).join("\n")).toContain("interrupted 5 times");
  });
});

describe("the mention depth", () => {
  const hop = (item: Item, from: Agent, to: Agent) =>
    postComment(handle.db, { itemId: item.id, author: { type: "agent", agentId: from.id }, body: "over to you", mentions: [{ type: "agent", agentId: to.id }] });

  it("answers a mention of the system agent past the cap, and refuses one of anybody else", async () => {
    const answered = createTestItem(handle.db, { type: "story", title: "Asking", stepId: "ready_to_merge" });
    const refused = createTestItem(handle.db, { type: "story", title: "Chatting", stepId: "ready_to_merge" });
    hop(answered, implementer, reviewer);
    hop(answered, reviewer, system);
    hop(refused, implementer, reviewer);
    hop(refused, reviewer, implementer);
    const { provider } = counting({ result: ANSWER });

    await supervising({ provider, limits: ROOMY, guards: { agentMentionDepth: 1 } }).runOnce();

    expect(runsOn(answered).map((run) => [run.agentId, run.action])).toContainEqual([system.id, "respond"]);
    expect(escalations(answered)).toEqual([]);
    expect(runsOn(refused).filter((run) => run.agentId === implementer.id)).toEqual([]);
    expect(escalations(refused)).toHaveLength(1);
  });
});

describe("the concurrency caps", () => {
  const CWD = "/tmp/eo/system-agent-guardrails";

  it("all full, dispatch every item on a system-owned step and leave any other waiting", async () => {
    const workspace = attachWorkspace(handle.db, { name: "Checkout", keyPrefix: "CHK", repoPath: CWD });
    const busy = onImplementerStep({ workspaceId: workspace.id });
    const supervisor = supervising({ provider: endless(), limits: FULL, kinds: kindsPreparing(CWD) });
    const first = supervisor.runOnce();
    await vi.waitFor(() => expect(supervisor.activeRunCount()).toBe(1));

    const own = onOwnStep({ workspaceId: workspace.id });
    const ownToo = onOwnStep({ workspaceId: workspace.id });
    const waiting = onImplementerStep({ workspaceId: workspace.id });
    const second = supervisor.runOnce();
    await vi.waitFor(() => expect(supervisor.activeRunCount()).toBe(3));

    // Both past the global and the bucket's cap, and two of one agent past its own.
    expect(runsOn(own)[0]).toMatchObject({ agentId: system.id, status: "running" });
    expect(runsOn(ownToo)[0]).toMatchObject({ agentId: system.id, status: "running" });
    expect(runsOn(waiting)).toEqual([]);
    expect(runsOn(busy)).toHaveLength(1);

    supervisor.beginClose({ cancelRunning: true });
    await Promise.all([first, second]);
  });

  it("are offered past through offerWork at a capacity of nought, once, and nothing else is", async () => {
    const own = onOwnStep();
    onImplementerStep();
    const supervisor = supervising({ provider: endless(), limits: FULL });

    expect((await supervisor.offerWork("anna-laptop", 0)).map((offer) => offer.dispatch.item.id)).toEqual([own.id]);
    expect(leaseFor(handle.db, own.id)?.deviceId).toBe("anna-laptop");
    // Claimed, so nobody is offered it again whatever the capacity says.
    expect(await supervisor.offerWork("dana-desktop", 0)).toEqual([]);
  });

  it("count a system agent run against other work, which is left the slots it leaves", async () => {
    onOwnStep();
    const theirs = onImplementerStep();
    const supervisor = supervising({ provider: endless(), limits: FULL });

    const offers = await supervisor.offerWork("anna-laptop", 1);

    expect(offers).toHaveLength(1);
    expect(offers[0]?.dispatch.item.id).not.toBe(theirs.id);
  });

  it("never start two runs on one item", async () => {
    const own = onOwnStep();
    const supervisor = supervising({ provider: endless(), limits: FULL });
    const first = supervisor.runOnce();
    await vi.waitFor(() => expect(supervisor.activeRunCount()).toBe(1));

    const second = supervisor.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(runsOn(own)).toHaveLength(1);
    expect(supervisor.activeRunCount()).toBe(1);
    supervisor.beginClose({ cancelRunning: true });
    await Promise.all([first, second]);
  });

  it("offer nothing to a process that is no device, which still answers one that is", async () => {
    const own = onOwnStep();
    const supervisor = supervising({ provider: endless(), limits: FULL, dispatches: false });

    await supervisor.runOnce();
    expect(runsOn(own)).toEqual([]);
    expect(leaseFor(handle.db, own.id)).toBeNull();

    expect((await supervisor.offerWork("anna-laptop", 0)).map((offer) => offer.dispatch.item.id)).toEqual([own.id]);
  });
});

describe("what still applies to a system agent run", () => {
  it("the attempt limit, with the stop everybody else gets", async () => {
    const own = onOwnStep();
    const failed = createRun(handle.db, { itemId: own.id, agentId: system.id, action: "intake", stepId: "ask", status: "queued", initiationId: initiationOf(own), attempt: 1 });
    updateRun(handle.db, failed.id, { status: "failed", error: "it fell over", startedAt: 1, endedAt: 2 });
    const { provider, start } = counting({ result: INTAKE });

    await supervising({ provider, limits: ROOMY, guards: { perItemAttemptLimit: 1 } }).runOnce();

    expect(start).not.toHaveBeenCalled();
    expect(escalations(own)).toEqual([attemptLimitStop(1, "intake", 1)]);
  });

  it("the organisation's list of allowed backends", async () => {
    updateAgent(handle.db, system.id, { provider: "codex" });
    writePolicy(handle.db, { ...NO_POLICY, allowedBackends: ["claude"], publishedAt: 1 });
    const own = onOwnStep();
    const { provider, start } = counting({ result: INTAKE });

    await supervising({ provider, limits: ROOMY }).runOnce();

    expect(start).not.toHaveBeenCalled();
    expect(escalations(own).join("\n")).toContain(NOT_ALLOWED_BY_YOUR_ORGANISATION);
  });

  it("the organisation's budget per person, however little capacity is left", async () => {
    const anna = createPerson(handle.db, { name: "Anna", email: "anna@example.com" });
    setSetting(handle.db, MANAGED_PERSON_ID_KEY, anna.id);
    const project = createProject(handle.db, { name: "Support", keyPrefix: "SUP" });
    markProjectOnTheRecord(handle.db, project.id, anna.id);
    writePolicy(handle.db, { ...NO_POLICY, perPersonDailyBudgetCents: 1_000, publishedAt: 1 });
    spend(onOwnStep({ projectId: project.id }), 1_000);
    const next = onOwnStep({ projectId: project.id });
    const { provider, start } = counting({ result: INTAKE });

    expect(await supervising({ provider, limits: FULL }).offerWork("anna-laptop", 0)).toEqual([]);

    expect(start).not.toHaveBeenCalled();
    expect(getItem(handle.db, next.id)?.stepId).toBe("ask");
    expect(escalations(next).join("\n")).toContain("Your organisation");
  });
});
