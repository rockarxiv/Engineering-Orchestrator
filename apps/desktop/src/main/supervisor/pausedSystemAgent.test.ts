import { pageDescriptorFor, type Agent, type AgentEvent, type AgentProvider, type Item, type ModuleManifest, type Run, type Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../db/client.js";
import { archiveAgent } from "../db/repos/agentsRepo.js";
import { createProject } from "../db/repos/projectsRepo.js";
import {
  createRoute,
  createRun,
  createStep,
  getItem,
  getRun,
  listAgents,
  listAwaitingInputItemIds,
  listCommentsForItem,
  listRunsForItem,
  postComment,
  saveModule,
  setItemHeld,
  updateAgent,
  updateRun,
} from "../db/repos/index.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { sendToAssist } from "../ipc/assistCommands.js";
import { archiveProjectCommand } from "../ipc/archiveProjectCommand.js";
import { sendToScenario } from "../ipc/scenarioCommands.js";
import { createFakeProvider, type FakeProviderScript } from "../providers/fake.js";
import { validImplementResult } from "../providers/fixtures.js";
import { createRoleWiring } from "../packs/developer/wiring.js";
import { createRunSupervisor, type RunSupervisor, type RunSupervisorOptions } from "./runSupervisor.js";
import type { BuiltinRunner } from "./builtins.js";
import { findPendingResponses } from "./manualDispatch.js";
import { fakeWorkspaceKind, installedKinds } from "./testWorkspaceKinds.js";
import { NOTHING_ATTACHED } from "./workspaceKind.js";

/**
 * The system agent carries on while EO is paused (EO-615): every door a
 * pause closes, opened for a run by an agent in the `system` role and for
 * nobody else, and closing EO, which opens none of them.
 *
 * Everything is driven through the real supervisor. Only the backend is
 * scripted, so what is asserted is what a person would see: whether a run
 * exists, how it ended and what the item did.
 */

const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };
const INTAKE = { ready: true, type: "feature", understanding: "Understood.", decisions: [] };
const ANSWER = { outcome: { message: "Here you are.", questions: [], proposals: [] } };

let handle: DbHandle;
let system: Agent;
let implementer: Agent;

beforeEach(() => {
  handle = openMigratedTestDb();
  createStep(handle.db, { id: "ask", pipelineId: "default" as never, position: -1, name: "Intake", type: "agent", ownerRole: "system", entryAction: "intake" });
  createRoute(handle.db, { pipelineId: "default" as never, fromStepId: "ask", resultKey: "done", label: "Understood", target: "todo", position: 0 });
  const agents = listAgents(handle.db);
  system = agents.find((agent) => agent.role === "system")!;
  implementer = agents.find((agent) => agent.role === "implementer")!;
});

afterEach(() => {
  handle.close();
});

/** An item on the step the system role owns, which the tick offers on every pass. */
const onOwnStep = (): Item => createTestItem(handle.db, { type: "feature", title: "The system agent's", stepId: "ask" });
/** An item on an ordinary agent's step. */
const onImplementerStep = (): Item => createTestItem(handle.db, { type: "story", title: "The implementer's", stepId: "todo" });
/** An item where nothing is dispatched by itself, so only a mention or a reply runs anything on it. */
const atRest = (): Item => createTestItem(handle.db, { type: "story", title: "Waiting to merge", stepId: "ready_to_merge" });

/** A backend that answers every turn with `script`, and counts what it was asked. */
function counting(script: FakeProviderScript) {
  const inner = createFakeProvider(script);
  const start = vi.fn(inner.start.bind(inner));
  const resume = vi.fn(inner.resume.bind(inner));
  const provider: AgentProvider = { start, resume };
  return { provider, start, resume };
}

/** A backend whose turn goes on until it is stopped, so a run stays active for as long as a test needs it. */
function endless(): AgentProvider {
  const turn = async function* (opts?: { signal?: AbortSignal }): AsyncIterable<AgentEvent> {
    yield { type: "thread_started", threadId: "thr-endless" };
    await new Promise<void>((resolve) => {
      if (opts?.signal?.aborted) resolve();
      else opts?.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
  };
  return { start: (opts) => turn(opts), resume: (_thread, _message, opts) => turn(opts) };
}

/** A supervisor with EO's own roles wired in, so each action's answer is held to its real schema and posted as it is in the app. */
function supervising(options: Omit<RunSupervisorOptions, "db">): RunSupervisor {
  return createRunSupervisor({ db: handle.db, ...createRoleWiring(handle.db), ...options });
}

function pausedSupervisor(provider: AgentProvider): RunSupervisor {
  const supervisor = supervising({ provider, limits: LIMITS });
  supervisor.pause();
  return supervisor;
}

function mention(item: Item, agent: Agent) {
  return postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: `@${agent.name} a question`, mentions: [{ type: "agent", agentId: agent.id }] });
}

function parkedRun(item: Item, agent: Agent, action: string, threadId: string | null, cwd?: string): Run {
  const run = createRun(handle.db, { itemId: item.id, agentId: agent.id, action, threadId, stepId: item.stepId as string, initiationId: `first:${item.id}`, ...(cwd ? { cwd } : {}) });
  updateRun(handle.db, run.id, { status: "awaiting_input", startedAt: 1, endedAt: 2 });
  return getRun(handle.db, run.id)!;
}

function leftRunning(item: Item, agent: Agent, action: string, threadId: string, cwd?: string): Run {
  const run = createRun(handle.db, { itemId: item.id, agentId: agent.id, action, status: "queued", threadId, stepId: item.stepId as string, initiationId: `first:${item.id}`, ...(cwd ? { cwd } : {}) });
  updateRun(handle.db, run.id, { status: "running", startedAt: 1 });
  return getRun(handle.db, run.id)!;
}

const CWD = "/tmp/eo/paused-system-agent";

/** An item on the system role's step with a workspace, so a resume has something to attach before it reaches the backend. */
function onOwnStepWithWorkspace(): Item {
  const workspace = attachWorkspace(handle.db, { name: "Checkout", keyPrefix: "CHK", repoPath: CWD });
  return createTestItem(handle.db, { type: "feature", title: "The system agent's", stepId: "ask", workspaceId: workspace.id });
}

/** Workspaces whose attachment waits until `open`, which is the last await before a resumed thread reaches its backend. */
function gatedKinds() {
  let open: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    open = resolve;
  });
  let attaching = false;
  const kinds = installedKinds(
    fakeWorkspaceKind({
      cwd: CWD,
      attach: async () => {
        attaching = true;
        await held;
        return NOTHING_ATTACHED;
      },
    }),
  );
  return { kinds, open, attaching: () => attaching };
}

const plainKinds = () => installedKinds(fakeWorkspaceKind({ cwd: CWD }));

const runsOn = (item: Item) => listRunsForItem(handle.db, item.id);

describe("with EO paused, a system agent run", () => {
  it("answers a message in an assistant chat", async () => {
    const { provider, start } = counting({ result: ANSWER });
    const supervisor = pausedSupervisor(provider);
    const { conversation } = await sendToAssist(handle.db, undefined, { page: pageDescriptorFor("/chat"), conversationId: null, body: "What is waiting?", attachmentIds: [], interrupt: false });

    await supervisor.runOnce();

    expect(start).toHaveBeenCalledOnce();
    expect(listRunsForItem(handle.db, conversation.id as Uuid)[0]).toMatchObject({ agentId: system.id, status: "succeeded" });
    expect(listCommentsForItem(handle.db, conversation.id as Uuid).map((comment) => comment.body)).toContain("Here you are.");
  });

  it("answers a message in a module scenario chat", async () => {
    const manifest: ModuleManifest = {
      name: "Tag",
      description: "Tags.",
      inputs: {},
      needs: { bin: [], env: [], network: false, item: false, comment: false, attach: false, create: false },
      results: ["tagged"],
    };
    const saved = saveModule(handle.db, { slug: "tag", name: "Tag", description: "Tags.", code: "export default async () => ({ ok: true, result: 'tagged' });", manifest, source: "user" });
    if (!saved.ok) throw new Error(saved.reason);
    const { provider, start } = counting({ result: { outcome: { message: "Nothing to report.", questions: [], testId: null, diagnosis: null, change: null } } });
    const supervisor = pausedSupervisor(provider);
    const { conversation } = await sendToScenario(handle.db, undefined, { moduleId: saved.module.id, conversationId: null, body: "Does it tag?", interrupt: false });

    await supervisor.runOnce();

    expect(start).toHaveBeenCalledOnce();
    expect(listRunsForItem(handle.db, conversation.id as Uuid)[0]).toMatchObject({ agentId: system.id, status: "succeeded" });
  });

  it("answers a mention on an ordinary item, which does not wake the step the item stands on", async () => {
    const { provider } = counting({ result: INTAKE });
    const ordinary = onImplementerStep();
    const supervisor = pausedSupervisor(provider);
    mention(ordinary, system);

    await supervisor.runOnce();

    expect(runsOn(ordinary)).toHaveLength(1);
    expect(runsOn(ordinary)[0]).toMatchObject({ agentId: system.id, action: "respond" });
    expect(getItem(handle.db, ordinary.id)?.stepId).toBe("todo");
  });

  it("is dispatched by the tick on a step its role owns, and the scheduler says so about that item alone", async () => {
    const { provider, start } = counting({ result: INTAKE });
    const own = onOwnStep();
    const ordinary = onImplementerStep();
    const supervisor = pausedSupervisor(provider);
    expect(supervisor.dispatchBlockerFor(own.id)).toBeNull();
    expect(supervisor.dispatchBlockerFor(ordinary.id)).toEqual({ kind: "paused" });

    await supervisor.runOnce();

    expect(start).toHaveBeenCalledOnce();
    expect(runsOn(own)).toHaveLength(1);
    expect(runsOn(ordinary)).toEqual([]);
  });

  it("resumes its own thread on a reply to a run of its that parked", async () => {
    const { provider, resume } = counting({ result: INTAKE });
    const own = onOwnStep();
    const supervisor = pausedSupervisor(provider);
    parkedRun(own, system, "intake", "thr-parked");
    postComment(handle.db, { itemId: own.id, author: { type: "human" }, body: "Yes, that one." });

    await supervisor.resumeItem(own.id);
    await supervisor.waitForIdle();

    expect(resume).toHaveBeenCalledOnce();
    expect(resume.mock.calls[0]?.[0]).toBe("thr-parked");
    expect(runsOn(own).filter((run) => run.status === "succeeded")).toHaveLength(1);
  });

  it("picks a reply to a parked run of its up on the scheduler's own pass too", async () => {
    const { provider, resume } = counting({ result: INTAKE });
    const own = onOwnStep();
    const supervisor = pausedSupervisor(provider);
    parkedRun(own, system, "intake", "thr-parked");
    postComment(handle.db, { itemId: own.id, author: { type: "human" }, body: "Yes, that one." });

    await supervisor.runOnce();

    expect(resume).toHaveBeenCalledOnce();
  });

  it("gets its correction turn rather than ending as paused", async () => {
    let release: () => void = () => {};
    const mayReturn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider: AgentProvider = {
      async *start() {
        yield { type: "thread_started", threadId: "thr-correct" };
        await mayReturn;
        yield { type: "result", data: { malformed: true } };
      },
      resume: vi.fn(() => createFakeProvider({ result: INTAKE }).resume("thr-correct", "unused")),
    };
    const own = onOwnStep();
    const supervisor = supervising({ provider, limits: LIMITS });
    const tick = supervisor.runOnce();
    await vi.waitFor(() => expect(runsOn(own)[0]?.status).toBe("running"));

    supervisor.pause();
    release();
    await tick;
    await supervisor.waitForIdle();

    expect(provider.resume).toHaveBeenCalledOnce();
    expect(runsOn(own)[0]).toMatchObject({ status: "succeeded" });
  });
});

describe("with EO paused, anybody else", () => {
  it("starts nothing on a mention, closes nothing, and is picked up after resume", async () => {
    const { provider, start } = counting({ result: INTAKE });
    const held = atRest();
    const supervisor = pausedSupervisor(provider);
    mention(held, implementer);

    await supervisor.runOnce();
    expect(start).not.toHaveBeenCalled();
    expect(runsOn(held)).toEqual([]);

    supervisor.resume();
    await supervisor.runOnce();
    expect(runsOn(held).find((run) => run.agentId === implementer.id)?.action).toBe("respond");
  });

  it("starts nothing on a reply to its parked run, and is resumed after resume", async () => {
    const { provider, resume } = counting({ result: validImplementResult });
    const ordinary = onImplementerStep();
    const supervisor = pausedSupervisor(provider);
    parkedRun(ordinary, implementer, "implement", "thr-theirs");
    postComment(handle.db, { itemId: ordinary.id, author: { type: "human" }, body: "Carry on." });

    await supervisor.resumeItem(ordinary.id);
    await supervisor.runOnce();
    expect(resume).not.toHaveBeenCalled();

    supervisor.resume();
    await supervisor.runOnce();
    expect(resume).toHaveBeenCalledOnce();
  });

  it("does not get a correction turn", async () => {
    let release: () => void = () => {};
    const mayReturn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider: AgentProvider = {
      async *start() {
        yield { type: "thread_started", threadId: "thr-correct" };
        await mayReturn;
        yield { type: "result", data: { malformed: true } };
      },
      resume: vi.fn(() => createFakeProvider({ result: validImplementResult }).resume("thr-correct", "unused")),
    };
    const ordinary = onImplementerStep();
    const supervisor = supervising({ provider, limits: LIMITS });
    const tick = supervisor.runOnce();
    await vi.waitFor(() => expect(runsOn(ordinary)[0]?.status).toBe("running"));

    supervisor.pause();
    release();
    await tick;

    expect(provider.resume).not.toHaveBeenCalled();
    expect(runsOn(ordinary)[0]).toMatchObject({ status: "failed", error: "paused before starting a provider retry" });
  });
});

describe("a free-text reply on a parked builtin, with EO paused", () => {
  const step = vi.fn<BuiltinRunner>();
  const asking = () => ({ ok: false as const, reason: "Which should this stack on?", options: ["EO-2", "EO-3"] });

  beforeEach(() => {
    step.mockReset();
    step.mockImplementation(async () => asking());
  });

  it("is read by the system agent, and the step it would wake waits for the resume", async () => {
    const parked = createTestItem(handle.db, { type: "story", title: "Parked on a builtin", stepId: "worktree" });
    const { provider, start } = counting({ result: { status: "answered", answer: "EO-3" } });
    const supervisor = supervising({ provider, limits: LIMITS, guards: () => ({ interpretReplies: true }), builtins: { create_worktree: step } });
    await supervisor.runOnce();
    await supervisor.waitForIdle();
    start.mockClear();
    expect(step).toHaveBeenCalledOnce();

    supervisor.pause();
    const asked = listCommentsForItem(handle.db, parked.id).at(-1);
    postComment(handle.db, { itemId: parked.id, author: { type: "human" }, parentId: asked?.id ?? null, body: "whichever the rate limiter lives in" });
    await supervisor.resumeItem(parked.id);
    await supervisor.runOnce();
    await supervisor.runOnce();

    expect(runsOn(parked).filter((run) => run.action === "interpret")).toHaveLength(1);
    expect(runsOn(parked).find((run) => run.action === "interpret")).toMatchObject({ agentId: system.id, status: "succeeded" });
    expect(step).toHaveBeenCalledOnce();

    supervisor.resume();
    await supervisor.runOnce();
    await supervisor.waitForIdle();
    expect(step).toHaveBeenCalledTimes(2);
  });

  it("is asked for at once, not left for the interval", async () => {
    const parked = createTestItem(handle.db, { type: "story", title: "Parked on a builtin", stepId: "worktree" });
    const { provider } = counting({ result: { status: "answered", answer: "EO-3" } });
    const supervisor = supervising({ provider, limits: LIMITS, guards: () => ({ interpretReplies: true }), builtins: { create_worktree: step }, debounceMs: 0, tickIntervalMs: 3_600_000 });
    await supervisor.runOnce();
    await supervisor.waitForIdle();
    supervisor.pause();
    supervisor.start();
    // Past the tick `start` makes, so only the reply itself can bring one.
    await supervisor.runOnce();
    const asked = listCommentsForItem(handle.db, parked.id).at(-1);
    postComment(handle.db, { itemId: parked.id, author: { type: "human" }, parentId: asked?.id ?? null, body: "whichever the rate limiter lives in" });

    await supervisor.resumeItem(parked.id);

    await vi.waitFor(() => expect(runsOn(parked).some((run) => run.action === "interpret")).toBe(true));
    await supervisor.waitForIdle();
    supervisor.stop();
  });
});

describe("what still stops a system agent run while paused", () => {
  it("an agent switched off starts nothing, on the step or on a mention", async () => {
    const { provider, start, resume } = counting({ result: INTAKE });
    updateAgent(handle.db, system.id, { enabled: false });
    const own = onOwnStep();
    const rest = atRest();
    const supervisor = pausedSupervisor(provider);
    mention(rest, system);
    const parked = atRest();
    parkedRun(parked, system, "respond", "thr-parked");
    postComment(handle.db, { itemId: parked.id, author: { type: "human" }, body: "A reply." });

    await supervisor.runOnce();
    await supervisor.resumeItem(parked.id);

    expect(start).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    expect(runsOn(own)).toEqual([]);
    expect(supervisor.dispatchBlockerFor(own.id)).toMatchObject({ kind: "no_enabled_agent" });
  });

  it("an archived agent starts nothing, and is refused once EO is resumed, as any other agent would be", async () => {
    const { provider, start } = counting({ result: INTAKE });
    const rest = atRest();
    mention(rest, system);
    archiveAgent(handle.db, system.id);
    const supervisor = pausedSupervisor(provider);

    await supervisor.runOnce();
    expect(start).not.toHaveBeenCalled();

    supervisor.resume();
    await supervisor.runOnce();
    expect(start).not.toHaveBeenCalled();
    expect(listCommentsForItem(handle.db, rest.id).map((comment) => comment.body).join("\n")).toContain("has been archived");
  });

  it("an archived project starts nothing on any of its items", async () => {
    const project = createProject(handle.db, { name: "Shelved", keyPrefix: "SHEL" });
    const onIt = createTestItem(handle.db, { type: "story", title: "Put away", stepId: "ask", projectId: project.id });
    const { provider } = counting({ result: INTAKE });
    const supervisor = pausedSupervisor(provider);
    archiveProjectCommand(handle.db, undefined, { projectId: project.id, confirm: true });
    mention(onIt, system);

    await supervisor.runOnce();

    expect(runsOn(onIt)).toEqual([]);
  });

  it("a run parked on the step it owns keeps the tick off it", async () => {
    const { provider } = counting({ result: INTAKE });
    const own = onOwnStep();
    const supervisor = pausedSupervisor(provider);
    const parked = parkedRun(own, system, "intake", null);

    await supervisor.runOnce();

    expect(supervisor.dispatchBlockerFor(own.id)).toEqual({ kind: "awaiting_input" });
    expect(runsOn(own).map((run) => run.id)).toEqual([parked.id]);
  });

  it("a hold keeps the tick off the step it owns", async () => {
    const { provider, start } = counting({ result: INTAKE });
    const own = onOwnStep();
    setItemHeld(handle.db, own.id, Date.now());
    const supervisor = pausedSupervisor(provider);

    await supervisor.runOnce();

    expect(supervisor.dispatchBlockerFor(own.id)).toEqual({ kind: "held" });
    expect(start).not.toHaveBeenCalled();
  });
});

describe("a hold on the item, while EO is paused", () => {
  it("keeps a mention of the system agent open and starts nothing, until the hold is lifted", async () => {
    const { provider, start } = counting({ result: INTAKE });
    const rest = atRest();
    setItemHeld(handle.db, rest.id, Date.now());
    const supervisor = pausedSupervisor(provider);
    mention(rest, system);

    await supervisor.runOnce();

    expect(start).not.toHaveBeenCalled();
    expect(runsOn(rest)).toEqual([]);
    expect(findPendingResponses(handle.db, [rest.id])).toHaveLength(1);

    setItemHeld(handle.db, rest.id, null);
    await supervisor.runOnce();
    expect(start).toHaveBeenCalledOnce();
    expect(runsOn(rest)[0]).toMatchObject({ agentId: system.id, action: "respond" });
  });

  it("keeps a reply to a parked system agent run, by the person's door and the scheduler's, until the hold is lifted", async () => {
    const { provider, resume } = counting({ result: INTAKE });
    const own = onOwnStep();
    setItemHeld(handle.db, own.id, Date.now());
    const supervisor = pausedSupervisor(provider);
    parkedRun(own, system, "intake", "thr-parked");
    postComment(handle.db, { itemId: own.id, author: { type: "human" }, body: "Yes, that one." });

    await supervisor.resumeItem(own.id);
    await supervisor.runOnce();
    expect(resume).not.toHaveBeenCalled();

    setItemHeld(handle.db, own.id, null);
    await supervisor.runOnce();
    expect(resume).toHaveBeenCalledOnce();
  });

  it("does not start a dispatch whose hold landed in its preflight", async () => {
    let release: () => void = () => {};
    const authing = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { provider, start } = counting({ result: INTAKE });
    const rest = atRest();
    const supervisor = supervising({
      provider,
      limits: LIMITS,
      checkAuth: async () => {
        await authing;
        return { ok: true };
      },
    });
    supervisor.pause();
    mention(rest, system);
    const tick = supervisor.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 10));

    setItemHeld(handle.db, rest.id, Date.now());
    release();
    await tick;

    expect(start).not.toHaveBeenCalled();
    expect(findPendingResponses(handle.db, [rest.id])).toHaveLength(1);
  });

  it("does not read a reply on a parked builtin, and does not spin the scheduler over it", async () => {
    const step = vi.fn<BuiltinRunner>(async () => ({ ok: false as const, reason: "Which should this stack on?", options: ["EO-2", "EO-3"] }));
    const parked = createTestItem(handle.db, { type: "story", title: "Parked on a builtin", stepId: "worktree" });
    const { provider } = counting({ result: { status: "answered", answer: "EO-3" } });
    let asked = 0;
    const supervisor = supervising({
      provider,
      limits: LIMITS,
      guards: () => {
        asked += 1;
        return { interpretReplies: true };
      },
      builtins: { create_worktree: step },
      debounceMs: 0,
      tickIntervalMs: 3_600_000,
    });
    await supervisor.runOnce();
    supervisor.pause();
    setItemHeld(handle.db, parked.id, Date.now());
    const question = listCommentsForItem(handle.db, parked.id).at(-1);
    postComment(handle.db, { itemId: parked.id, author: { type: "human" }, parentId: question?.id ?? null, body: "whichever the rate limiter lives in" });
    supervisor.start();
    await supervisor.runOnce();

    await supervisor.resumeItem(parked.id);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const settled = asked;
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(asked).toBe(settled);
    expect(runsOn(parked).filter((run) => run.action === "interpret")).toEqual([]);
    supervisor.stop();
  });

  it("goes no further than a pause: with EO running, a mention on a held item is answered as it always was", async () => {
    const { provider, start } = counting({ result: INTAKE });
    const rest = atRest();
    setItemHeld(handle.db, rest.id, Date.now());
    const supervisor = supervising({ provider, limits: LIMITS });
    mention(rest, system);

    await supervisor.runOnce();

    expect(start).toHaveBeenCalledOnce();
  });
});

describe("EO reopening paused", () => {
  it("carries on a system agent run left running, and leaves everybody else's until resume", async () => {
    const theirs = leftRunning(onImplementerStep(), implementer, "implement", "thr-theirs");
    const mine = leftRunning(onOwnStep(), system, "intake", "thr-mine");
    const { provider, resume } = counting({ result: INTAKE });
    const supervisor = supervising({ provider, limits: LIMITS, initialPaused: true });

    expect(await supervisor.reconcile()).toEqual({ reattached: 0, resumed: 1, orphaned: 0 });
    await supervisor.waitForIdle();

    expect(resume).toHaveBeenCalledOnce();
    expect(resume.mock.calls[0]?.[0]).toBe("thr-mine");
    expect(supervisor.isPaused()).toBe(true);
    expect(getRun(handle.db, mine.id)).toMatchObject({ status: "cancelled", interruption: "restart" });
    expect(getRun(handle.db, theirs.id)?.status).toBe("running");

    supervisor.resume();
    expect(await supervisor.reconcile()).toEqual({ reattached: 0, resumed: 1, orphaned: 0 });
    await supervisor.waitForIdle();
    expect(resume.mock.calls.map((call) => call[0])).toContain("thr-theirs");
  });

  it("honours a forced close's restart of a system agent run, and keeps everybody else's for the resume", async () => {
    const own = onOwnStep();
    const ordinary = onImplementerStep();
    const closing = supervising({ provider: endless(), limits: LIMITS });
    const tick = closing.runOnce();
    await vi.waitFor(() => expect(closing.activeRunCount()).toBe(2));

    closing.beginClose({ cancelRunning: true });
    await tick;
    expect(runsOn(own)[0]).toMatchObject({ status: "cancelled", interruption: "quit", threadId: "thr-endless" });
    expect(runsOn(ordinary)[0]).toMatchObject({ status: "cancelled", interruption: "quit", threadId: "thr-endless" });
    await closing.shutdown();

    const { provider, resume } = counting({ result: INTAKE });
    const reopened = supervising({ provider, limits: LIMITS, initialPaused: true });
    await reopened.runOnce();

    expect(resume).toHaveBeenCalledOnce();
    expect(resume.mock.calls[0]?.[0]).toBe("thr-endless");
    expect(resume.mock.calls[0]?.[1]).toContain("EO was closed while you were working");
    expect(runsOn(own)).toHaveLength(2);
    expect(runsOn(ordinary)).toHaveLength(1);

    reopened.resume();
    await reopened.runOnce();
    expect(runsOn(ordinary)).toHaveLength(2);
  });
});

describe("engine_pause with cancelRunning", () => {
  it("cancels the others and leaves a running system agent run alone", async () => {
    const own = onOwnStep();
    const ordinary = onImplementerStep();
    const supervisor = supervising({ provider: endless(), limits: LIMITS });
    const tick = supervisor.runOnce();
    await vi.waitFor(() => expect(supervisor.activeRunCount()).toBe(2));

    supervisor.pause({ cancelRunning: true });

    expect(runsOn(ordinary)[0]?.status).toBe("cancelled");
    expect(runsOn(own)[0]?.status).toBe("running");
    expect(supervisor.activeRunCount()).toBeGreaterThanOrEqual(1);
    await vi.waitFor(() => expect(supervisor.activeRunCount()).toBe(1));

    supervisor.beginClose({ cancelRunning: true });
    await tick;
  });
});

describe("engine_pause with cancelRunning, on an agent switched off since", () => {
  it("still leaves the run alone, and does not call it finishing, because it is the system agent's", async () => {
    const own = onOwnStep();
    const supervisor = supervising({ provider: endless(), limits: LIMITS });
    const tick = supervisor.runOnce();
    await vi.waitFor(() => expect(supervisor.activeRunCount()).toBe(1));
    updateAgent(handle.db, system.id, { enabled: false });

    supervisor.pause({ cancelRunning: true });

    expect(runsOn(own)[0]?.status).toBe("running");
    expect(supervisor.finishingRunCount()).toBe(0);

    // A close asks nobody's role: this one stops it all the same.
    supervisor.beginClose({ cancelRunning: true });
    await tick;
    expect(runsOn(own)[0]?.status).toBe("cancelled");
  });
});

describe("how many runs a pause is waiting for", () => {
  it("leaves the system agent's out, and counts all of them once EO is closing", async () => {
    onOwnStep();
    const supervisor = supervising({ provider: endless(), limits: LIMITS });
    const tick = supervisor.runOnce();
    await vi.waitFor(() => expect(supervisor.activeRunCount()).toBe(1));

    expect(supervisor.finishingRunCount()).toBe(0);
    supervisor.pause();
    expect(supervisor.finishingRunCount()).toBe(0);
    expect(supervisor.activeRunCount()).toBe(1);

    supervisor.beginClose();
    expect(supervisor.finishingRunCount()).toBe(1);

    supervisor.beginClose({ cancelRunning: true });
    await tick;
  });

  it("counts anybody else's", async () => {
    onImplementerStep();
    const supervisor = supervising({ provider: endless(), limits: LIMITS });
    const tick = supervisor.runOnce();
    await vi.waitFor(() => expect(supervisor.activeRunCount()).toBe(1));

    supervisor.pause();
    expect(supervisor.finishingRunCount()).toBe(1);

    supervisor.beginClose({ cancelRunning: true });
    await tick;
  });
});

describe("closing EO", () => {
  it("starts no new run of any agent, by any door, whatever a Resume says", async () => {
    const { provider, start, resume } = counting({ result: INTAKE });
    const own = onOwnStep();
    const rest = atRest();
    const supervisor = supervising({ provider, limits: LIMITS });
    supervisor.beginClose();
    mention(rest, system);
    parkedRun(rest, system, "respond", "thr-parked");
    postComment(handle.db, { itemId: rest.id, author: { type: "human" }, body: "A reply." });
    expect(supervisor.dispatchBlockerFor(own.id)).toEqual({ kind: "paused" });

    await supervisor.runOnce();
    await supervisor.resumeItem(rest.id);
    supervisor.resume();
    await supervisor.runOnce();

    expect(start).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    expect(runsOn(own)).toEqual([]);
    expect(supervisor.isPaused()).toBe(true);
  });

  it("turns back a system agent dispatch already in its preflight", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { provider, start } = counting({ result: INTAKE });
    const own = onOwnStep();
    const supervisor = createRunSupervisor({
      db: handle.db,
      provider,
      limits: LIMITS,
      checkAuth: async () => {
        await held;
        return { ok: true };
      },
    });
    const tick = supervisor.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 10));

    supervisor.beginClose();
    release();
    await tick;

    expect(start).not.toHaveBeenCalled();
    expect(runsOn(own)).toEqual([]);
  });

  it("does not reach the backend for a recovered run it lands in the middle of, and keeps the run's restart", async () => {
    const own = onOwnStepWithWorkspace();
    const left = leftRunning(own, system, "intake", "thr-mine", CWD);
    const gate = gatedKinds();
    const { provider, resume } = counting({ result: INTAKE });
    const supervisor = supervising({ provider, limits: LIMITS, kinds: gate.kinds });

    const pass = supervisor.reconcile();
    await vi.waitFor(() => expect(gate.attaching()).toBe(true));
    supervisor.beginClose();
    gate.open();

    expect(await pass).toEqual({ reattached: 0, resumed: 0, orphaned: 0 });
    expect(resume).not.toHaveBeenCalled();
    // Settled, and nothing left claimed for a run that never was.
    expect(runsOn(own).find((run) => run.id !== left.id)).toMatchObject({ status: "cancelled", interruption: "quit", threadId: "thr-mine" });
    expect(supervisor.activeRunCount()).toBe(0);
    expect(supervisor.itemLock.isHeld(own.id)).toBe(false);
    await supervisor.shutdown();

    const next = counting({ result: INTAKE });
    const reopened = supervising({ provider: next.provider, limits: LIMITS, kinds: plainKinds(), initialPaused: true });
    await reopened.runOnce();
    expect(next.resume).toHaveBeenCalledOnce();
    expect(next.resume.mock.calls[0]?.[0]).toBe("thr-mine");
    expect(next.resume.mock.calls[0]?.[1]).toContain("EO was closed while you were working");
  });

  it("does not reach the backend for a reply it lands in the middle of, and the reply is read when EO next runs", async () => {
    const own = onOwnStepWithWorkspace();
    parkedRun(own, system, "intake", "thr-parked", CWD);
    postComment(handle.db, { itemId: own.id, author: { type: "human" }, body: "Yes, that one." });
    const gate = gatedKinds();
    const { provider, resume } = counting({ result: INTAKE });
    const supervisor = supervising({ provider, limits: LIMITS, kinds: gate.kinds });

    const replying = supervisor.resumeItem(own.id);
    await vi.waitFor(() => expect(gate.attaching()).toBe(true));
    supervisor.beginClose();
    gate.open();
    await replying;

    expect(resume).not.toHaveBeenCalled();
    expect(supervisor.activeRunCount()).toBe(0);
    expect(supervisor.itemLock.isHeld(own.id)).toBe(false);
    expect(listAwaitingInputItemIds(handle.db).has(own.id)).toBe(true);
    await supervisor.shutdown();

    const next = counting({ result: INTAKE });
    const reopened = supervising({ provider: next.provider, limits: LIMITS, kinds: plainKinds(), initialPaused: true });
    await reopened.runOnce();
    expect(next.resume).toHaveBeenCalledOnce();
    expect(next.resume.mock.calls[0]?.[0]).toBe("thr-parked");
    expect(next.resume.mock.calls[0]?.[1]).toContain("Yes, that one.");
  });

  it("stops a running system agent run when forced, and only then", async () => {
    const own = onOwnStep();
    const supervisor = supervising({ provider: endless(), limits: LIMITS });
    const tick = supervisor.runOnce();
    await vi.waitFor(() => expect(supervisor.activeRunCount()).toBe(1));

    supervisor.beginClose();
    expect(runsOn(own)[0]?.status).toBe("running");

    supervisor.beginClose({ cancelRunning: true });
    await tick;
    expect(runsOn(own)[0]?.status).toBe("cancelled");
    expect(getItem(handle.db, own.id)?.stepId).toBe("ask");
  });
});
