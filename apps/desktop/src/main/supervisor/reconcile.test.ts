import { McpServerDraftSchema, parsedResultOf, type Agent, type Item, UNSCOPED_RUN } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentAttachmentsHash } from "../agentAttachments/fingerprint.js";
import { archiveAgent, createAgent, listAgents } from "../db/repos/agentsRepo.js";
import { setAgentAttachment } from "../db/repos/agentAttachmentsRepo.js";
import { saveMcpServer } from "../db/repos/mcpServersRepo.js";
import { promptHash } from "../roles/prompts.js";
import { findReusableThread } from "./threadReuse.js";
import { comments } from "../db/schema.js";
import { createRun, getRun, listRunsForItem, updateRun } from "../db/repos/runsRepo.js";
import { getItem } from "../db/repos/itemsRepo.js";
import { listTransitionsForItem } from "../db/repos/transitionsRepo.js";
import type { DbHandle } from "../db/client.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { createFakeProvider } from "../providers/fake.js";
import { validImplementResult, validImplementResultParsed } from "../providers/fixtures.js";
import { createRunSupervisor } from "./runSupervisor.js";
import { saveModule } from "../db/repos/modulesRepo.js";
import { openScenarioConversation, scenarioAgent, SCENARIO_ACTION, SCENARIO_STEP } from "../roles/scenario.js";
import { fakeWorkspaceKind, installedKinds } from "./testWorkspaceKinds.js";
import { NOTHING_ATTACHED } from "./workspaceKind.js";

const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };

/** Every action on an item shares one worktree — `createWorktreeWorkspace` sees to that. */
const CWD = "/tmp/eo/worktrees/EO-106";

describe("reconcile", () => {
  let handle: DbHandle;
  let item: Item;
  let implementer: Agent;

  beforeEach(() => {
    handle = openMigratedTestDb();
    item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo" });
    implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
  });

  afterEach(() => {
    handle.close();
  });

  it("a run with no thread_id is orphaned, the item stays put with an audit trail, and an engine comment explains it", async () => {
    const stale = createRun(handle.db, { itemId: item.id, agentId: implementer.id, action: "implement", status: "queued" });
    updateRun(handle.db, stale.id, { status: "running", startedAt: Date.now() });

    const supervisor = createRunSupervisor({ db: handle.db, provider: createFakeProvider({}), limits: LIMITS });
    const summary = await supervisor.reconcile();

    expect(summary).toEqual({ reattached: 0, resumed: 0, orphaned: 1 });
    expect(getRun(handle.db, stale.id)?.status).toBe("orphaned");
    expect(getItem(handle.db, item.id)?.stepId).toBe("todo"); // reverted to — which is unchanged, since dispatch never advances item.stepId

    const txs = listTransitionsForItem(handle.db, item.id);
    expect(txs).toHaveLength(1);
    expect(txs[0]).toMatchObject({ fromStepId: "todo", toStepId: "todo", actor: "engine" });

    const posted = handle.db.select().from(comments).all();
    expect(posted).toHaveLength(1);
    expect(posted[0]?.authorType).toBe("engine");
    expect(posted[0]?.body).toContain("orphaned");
  });

  it("kill -9 then relaunch: a run with a thread_id resumes on the same thread with context intact", async () => {
    // One fake provider instance models the provider's own externally
    // persisted session store (the original design: "Codex persists in
    // ~/.codex/sessions") — it outlives the crashed process even though
    // the supervisor driving it does not.
    const provider = createFakeProvider({ steps: [{ output: "step one" }, { output: "step two" }], result: validImplementResult });

    // Simulate a run that made it partway through its script before the
    // app was force-quit: consume just the thread_started event, then
    // abandon the iterator — a real crash wouldn't run any more of our
    // code either.
    const controller = new AbortController();
    const stream = provider.start({ instructions: "", context: "", cwd: ".", signal: controller.signal });
    const first = await stream[Symbol.asyncIterator]().next();
    if (first.done || first.value.type !== "thread_started") throw new Error("expected thread_started");
    const threadId = first.value.threadId;

    const interrupted = createRun(handle.db, {
      itemId: item.id,
      agentId: implementer.id,
      action: "implement",
      status: "queued",
      threadId,
      runtimeSource: "managed",
    });
    updateRun(handle.db, interrupted.id, { status: "running", startedAt: Date.now() });

    // A fresh supervisor models the relaunched process.
    const supervisor = createRunSupervisor({
      db: handle.db,
      provider,
      runtimeSource: () => "configured",
      limits: LIMITS,
    });
    const summary = await supervisor.reconcile();
    expect(summary).toEqual({ reattached: 0, resumed: 1, orphaned: 0 });

    expect(getRun(handle.db, interrupted.id)?.status).toBe("cancelled");
    // Interrupted rather than failed, so it is not an attempt the agent
    // spent, and the run that carries it on takes the same number.
    expect(getRun(handle.db, interrupted.id)?.interruption).toBe("restart");

    const runs = listRunsForItem(handle.db, item.id);
    const resumedRun = runs.find((run) => run.id !== interrupted.id)!;
    expect(resumedRun.threadId).toBe(threadId);
    expect(resumedRun.attempt).toBe(interrupted.attempt);
    expect(resumedRun.runtimeSource).toBe("configured");

    // Let the resumed stream (kicked off in the background by reconcile()) finish.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const finished = getRun(handle.db, resumedRun.id)!;
    expect(finished.status).toBe("succeeded");
    expect(parsedResultOf(finished.result)).toEqual(validImplementResultParsed); // reached the same scripted result — continuity, not a restart
  });

  /**
   * A module's scenario chat (EO-356) is a conversation, not a stage: a
   * turn recovered after a crash must finish where it started. Routed
   * like a stage, its null result falls back by position to the
   * off-board step beside it, and the thread a module page opens would
   * be gone from the room.
   */
  it("finishes a recovered scenario turn without moving its conversation off the scenario step", async () => {
    const saved = saveModule(handle.db, {
      slug: "merge-pr",
      name: "Merge pull request",
      description: "Merges.",
      code: "export default async () => ({ ok: true, result: 'merged' })",
      manifest: { name: "Merge pull request", description: "Merges.", inputs: {}, needs: { bin: [], env: [], network: false, item: false, comment: false, attach: false, create: false }, results: ["merged"] },
    });
    if (!saved.ok) throw new Error(saved.reason);
    const conversation = openScenarioConversation(handle.db, saved.module, null);
    const system = scenarioAgent(handle.db)!;

    const provider = createFakeProvider({ steps: [{ output: "thinking" }], result: JSON.stringify({ message: "It passed." }) });
    const controller = new AbortController();
    const first = await provider.start({ instructions: "", context: "", cwd: ".", signal: controller.signal })[Symbol.asyncIterator]().next();
    if (first.done || first.value.type !== "thread_started") throw new Error("expected thread_started");

    const interrupted = createRun(handle.db, { itemId: conversation.id, agentId: system.id, action: SCENARIO_ACTION, status: "queued", threadId: first.value.threadId });
    updateRun(handle.db, interrupted.id, { status: "running", startedAt: Date.now() });

    const supervisor = createRunSupervisor({ db: handle.db, provider, limits: LIMITS });
    expect(await supervisor.reconcile()).toMatchObject({ resumed: 1 });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const resumed = listRunsForItem(handle.db, conversation.id).find((run) => run.id !== interrupted.id)!;
    expect(getRun(handle.db, resumed.id)?.status).toBe("succeeded");
    expect(getItem(handle.db, conversation.id)?.stepId).toBe(SCENARIO_STEP);
  });

  it("does not resume a thread whose agent was archived while the app was down", async () => {
    // The window this loop exists for is the window an agent can be
    // retired in (EO-186), and recovery is the last dispatch path that
    // would have handed a thread back to one. A second agent on the role
    // is what makes archiving the first legal in the first place, and is
    // who the item is for now.
    createAgent(handle.db, { name: "Second Implementer", role: "implementer", provider: "fake", instructions: "Writes the code." });
    const inner = createFakeProvider({ result: validImplementResult });
    const resume = vi.fn(inner.resume.bind(inner));
    const start = vi.fn(inner.start.bind(inner));

    const interrupted = createRun(handle.db, {
      itemId: item.id,
      agentId: implementer.id,
      action: "implement",
      status: "queued",
      threadId: "thr_retired",
      cwd: CWD,
    });
    updateRun(handle.db, interrupted.id, { status: "running", startedAt: Date.now() });
    archiveAgent(handle.db, implementer.id);

    const summary = await createRunSupervisor({ db: handle.db, provider: { start, resume }, limits: LIMITS }).reconcile();

    // No backend was spoken to, in either direction, and no continuation
    // row was written to speak with.
    expect(resume).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(listRunsForItem(handle.db, item.id).map((run) => run.id)).toEqual([interrupted.id]);

    // Orphaned rather than left running: the item is handed back where
    // it stands, which is what lets the scheduler dispatch the step to
    // the agent that does hold the role now.
    expect(summary).toEqual({ reattached: 0, resumed: 0, orphaned: 1 });
    expect(getRun(handle.db, interrupted.id)?.status).toBe("orphaned");
    expect(getRun(handle.db, interrupted.id)?.error).toContain("archived");
    expect(getItem(handle.db, item.id)?.stepId).toBe("todo");

    // And said out loud, naming the role rather than the retired agent
    // as what happens next.
    const posted = handle.db.select().from(comments).all();
    expect(posted).toHaveLength(1);
    expect(posted[0]?.body).toContain("was archived while EO was not running");
    expect(posted[0]?.body).toContain('the "implementer" role');
  });

  it("does not resume a recovered thread when the agent is archived while the query server is resolved", async () => {
    // The last await before the backend is spoken to on this path
    // (EO-186), and the one where the continuation row already exists.
    // Rarer than the check above it and handled differently for that
    // reason: the row is closed as cancelled rather than left running
    // for the next reconciliation to find.
    createAgent(handle.db, { name: "Second Implementer", role: "implementer", provider: "fake", instructions: "Writes the code." });
    const inner = createFakeProvider({ result: validImplementResult });
    const resume = vi.fn(inner.resume.bind(inner));

    const interrupted = createRun(handle.db, {
      itemId: item.id,
      agentId: implementer.id,
      action: "implement",
      status: "queued",
      threadId: "thr_retired_late",
      cwd: CWD,
    });
    updateRun(handle.db, interrupted.id, { status: "running", startedAt: Date.now() });

    await createRunSupervisor({
      db: handle.db,
      provider: { start: inner.start.bind(inner), resume },
      limits: LIMITS,
      // The recovery path's last await before the backend: what the
      // workspace lends is resolved there, and this archives the agent
      // inside it.
      kinds: installedKinds(
        fakeWorkspaceKind({
          attach: async (_item, agent) => {
            archiveAgent(handle.db, agent.id);
            return NOTHING_ATTACHED;
          },
        }),
      ),
    }).reconcile();

    expect(resume).not.toHaveBeenCalled();

    // The continuation row exists, because this window opens after it is
    // written — and it is closed, with the reason on it.
    const runs = listRunsForItem(handle.db, item.id);
    expect(runs).toHaveLength(2);
    const continuation = runs.find((run) => run.id !== interrupted.id)!;
    expect(continuation.status).toBe("cancelled");
    expect(continuation.error).toContain("was archived before this recovery reached");

    // And said out loud: the row it continued was written off as
    // "resumed on the same thread" a moment earlier, which is no longer
    // what happened.
    const posted = handle.db.select().from(comments).all();
    expect(posted.map((comment) => comment.body).join("\n")).toContain("was archived while EO was picking this ticket back up");
  });

  it("defers boot-time thread resumption while initially paused", async () => {
    const inner = createFakeProvider({ result: validImplementResult });
    const resume = vi.fn(inner.resume.bind(inner));
    const interrupted = createRun(handle.db, {
      itemId: item.id,
      agentId: implementer.id,
      action: "implement",
      status: "queued",
      threadId: "thr_deferred",
    });
    updateRun(handle.db, interrupted.id, { status: "running", startedAt: Date.now() });
    const supervisor = createRunSupervisor({
      db: handle.db,
      provider: { start: inner.start.bind(inner), resume },
      limits: LIMITS,
      initialPaused: true,
    });

    expect(await supervisor.reconcile()).toEqual({ reattached: 0, resumed: 0, orphaned: 0 });
    expect(resume).not.toHaveBeenCalled();
    expect(getRun(handle.db, interrupted.id)?.status).toBe("running");

    supervisor.resume();
    expect(await supervisor.reconcile()).toEqual({ reattached: 0, resumed: 1, orphaned: 0 });
    expect(resume).toHaveBeenCalledOnce();
    await vi.waitFor(() => {
      const resumed = listRunsForItem(handle.db, item.id).find((run) => run.id !== interrupted.id);
      expect(resumed?.status).toBe("succeeded");
    });
  });

  it("resumes in the worktree the crashed run was working in", async () => {
    // Found live against the real Claude SDK: sessions are keyed by
    // working directory, so a resume from anywhere else fails with "No
    // conversation found". Codex fails the worse way — it resumes fine
    // and edits whatever directory the app is in, i.e. the EO checkout.
    const seen: { cwd?: string }[] = [];
    const provider = createFakeProvider({ result: validImplementResult });
    const spy = {
      start: provider.start,
      resume: (threadId: string, message: string, opts?: { cwd?: string }) => {
        seen.push({ ...(opts?.cwd ? { cwd: opts.cwd } : {}) });
        return provider.resume(threadId, message, opts);
      },
    };

    const interrupted = createRun(handle.db, {
      itemId: item.id,
      agentId: implementer.id,
      action: "implement",
      status: "queued",
      threadId: "thr_crashed",
      cwd: "/tmp/worktrees/EO-7",
    });
    updateRun(handle.db, interrupted.id, { status: "running", startedAt: Date.now() });

    await createRunSupervisor({ db: handle.db, provider: spy, limits: LIMITS }).reconcile();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(seen).toEqual([{ cwd: "/tmp/worktrees/EO-7" }]);
    // and the continuation run records it too, so the *next* crash resumes there as well
    const resumed = listRunsForItem(handle.db, item.id).find((run) => run.id !== interrupted.id)!;
    expect(resumed.cwd).toBe("/tmp/worktrees/EO-7");
  });

  /**
   * What the recovered run says the thread was born with.
   *
   * The continuation is a resume, and a resume re-sends neither the
   * instructions nor the configuration that decides the tool surface —
   * so the row reconcile writes has to carry both forward from the run
   * it is continuing. It is also the newest row behind that thread, so
   * it is the one `findReusableThread` weighs up next.
   */
  it("carries the crashed run's instructions and tool surface into the continuation", async () => {
    const github = saveMcpServer(handle.db, McpServerDraftSchema.parse({ name: "github", transport: "stdio", command: "gh-mcp" }));
    expect(github.ok).toBe(true);
    if (!github.ok) return;
    setAgentAttachment(handle.db, { agentId: implementer.id, kind: "mcpServer", id: github.server.id, attached: true });
    const bornWith = agentAttachmentsHash(handle.db, implementer.id, UNSCOPED_RUN);

    const interrupted = createRun(handle.db, {
      itemId: item.id,
      agentId: implementer.id,
      action: "implement",
      status: "queued",
      threadId: "thr_crashed",
      provider: implementer.provider,
      instructionsHash: promptHash(implementer.instructions),
      agentAttachmentsHash: bornWith,
      cwd: CWD,
    });
    updateRun(handle.db, interrupted.id, { status: "running", startedAt: Date.now() });

    await createRunSupervisor({ db: handle.db, provider: createFakeProvider({ result: validImplementResult }), limits: LIMITS }).reconcile();

    const resumed = listRunsForItem(handle.db, item.id).find((run) => run.id !== interrupted.id)!;
    expect(resumed.agentAttachmentsHash).toBe(bornWith);
    expect(resumed.instructionsHash).toBe(promptHash(implementer.instructions));
    await vi.waitFor(() => expect(getRun(handle.db, resumed.id)?.status).toBe("succeeded"));
  });

  /**
   * The bug that carrying it forward prevents.
   *
   * `agentAttachmentsHash` reads a null as the *empty* surface, not as
   * an unknown one — a run predating the column had nothing attached,
   * because nothing could be. That is right for a row from before the
   * migration and wrong for a row this process wrote a moment ago: a
   * recovered run left with a null would claim its thread was born with
   * no tools, and the next dispatch would happily resume it after
   * somebody detached a server, handing the agent back a tool they had
   * just taken away.
   */
  it("refuses to reuse a recovered thread once an attached server is detached", async () => {
    const github = saveMcpServer(handle.db, McpServerDraftSchema.parse({ name: "github", transport: "stdio", command: "gh-mcp" }));
    expect(github.ok).toBe(true);
    if (!github.ok) return;
    setAgentAttachment(handle.db, { agentId: implementer.id, kind: "mcpServer", id: github.server.id, attached: true });

    const interrupted = createRun(handle.db, {
      itemId: item.id,
      agentId: implementer.id,
      action: "implement",
      status: "queued",
      threadId: "thr_crashed",
      provider: implementer.provider,
      instructionsHash: promptHash(implementer.instructions),
      agentAttachmentsHash: agentAttachmentsHash(handle.db, implementer.id, UNSCOPED_RUN),
      cwd: CWD,
    });
    updateRun(handle.db, interrupted.id, { status: "running", startedAt: Date.now() });

    await createRunSupervisor({ db: handle.db, provider: createFakeProvider({ result: validImplementResult }), limits: LIMITS }).reconcile();
    const resumed = listRunsForItem(handle.db, item.id).find((run) => run.id !== interrupted.id)!;
    await vi.waitFor(() => expect(getRun(handle.db, resumed.id)?.status).toBe("succeeded"));

    // Before the detach the recovered thread is exactly what the next
    // dispatch should carry on — otherwise the assertion below would
    // pass for the wrong reason.
    expect(findReusableThread(handle.db, { itemId: item.id, agent: implementer, cwd: CWD }).kind).toBe("resume");

    setAgentAttachment(handle.db, { agentId: implementer.id, kind: "mcpServer", id: github.server.id, attached: false });

    const decision = findReusableThread(handle.db, { itemId: item.id, agent: implementer, cwd: CWD });
    expect(decision.kind).toBe("refused");
    expect(decision.kind === "resume" ? "" : decision.reason).toContain("MCP servers or skills attached");
  });

  it("is idempotent — running it twice changes nothing the second time", async () => {
    const stale = createRun(handle.db, { itemId: item.id, agentId: implementer.id, action: "implement", status: "queued" });
    updateRun(handle.db, stale.id, { status: "running", startedAt: Date.now() });

    const supervisor = createRunSupervisor({ db: handle.db, provider: createFakeProvider({}), limits: LIMITS });
    expect(await supervisor.reconcile()).toEqual({ reattached: 0, resumed: 0, orphaned: 1 });
    expect(await supervisor.reconcile()).toEqual({ reattached: 0, resumed: 0, orphaned: 0 });

    expect(listRunsForItem(handle.db, item.id)).toHaveLength(1); // no duplicate work
    expect(listTransitionsForItem(handle.db, item.id)).toHaveLength(1);
    expect(handle.db.select().from(comments).all()).toHaveLength(1);
  });

  it("a stubbed liveness check can claim a run is still ours, and reconcile leaves it untouched", async () => {
    const stale = createRun(handle.db, {
      itemId: item.id,
      agentId: implementer.id,
      action: "implement",
      status: "queued",
      threadId: "some-thread",
    });
    updateRun(handle.db, stale.id, { status: "running", startedAt: Date.now(), pid: 42 });

    const supervisor = createRunSupervisor({
      db: handle.db,
      provider: createFakeProvider({}),
      limits: LIMITS,
      isOurLiveProcess: (run) => run.pid === 42,
    });
    const summary = await supervisor.reconcile();

    expect(summary).toEqual({ reattached: 1, resumed: 0, orphaned: 0 });
    expect(getRun(handle.db, stale.id)?.status).toBe("running"); // left exactly as it was
    expect(listRunsForItem(handle.db, item.id)).toHaveLength(1); // no resume run created
  });

  it("a recycled pid is not mistaken for a live one under the default liveness check", async () => {
    // process.pid is the only pid the default checker ever calls "ours" —
    // any other number (however plausible-looking, e.g. a pid recycled by
    // the OS from an unrelated dead process) must fall through, not be
    // treated as alive.
    const recycledPid = process.pid === 1 ? 2 : 1;
    const stale = createRun(handle.db, { itemId: item.id, agentId: implementer.id, action: "implement", status: "queued" });
    updateRun(handle.db, stale.id, { status: "running", startedAt: Date.now(), pid: recycledPid });

    const supervisor = createRunSupervisor({ db: handle.db, provider: createFakeProvider({}), limits: LIMITS });
    const summary = await supervisor.reconcile();

    expect(summary).toEqual({ reattached: 0, resumed: 0, orphaned: 1 }); // fell through to orphan, not reattach
  });

  it("start() reconciles before its first tick, freeing the item for a fresh dispatch in the same cycle", async () => {
    const stale = createRun(handle.db, { itemId: item.id, agentId: implementer.id, action: "implement", status: "queued" });
    updateRun(handle.db, stale.id, { status: "running", startedAt: Date.now() });

    const supervisor = createRunSupervisor({
      db: handle.db,
      provider: createFakeProvider({ result: validImplementResult }),
      limits: LIMITS,
    });

    supervisor.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    supervisor.stop();

    expect(getRun(handle.db, stale.id)?.status).toBe("orphaned"); // reconciled first
    const runs = listRunsForItem(handle.db, item.id);
    expect(runs.some((run) => run.id !== stale.id)).toBe(true); // and the freed item got a fresh dispatch, not a stuck one
  });
});
