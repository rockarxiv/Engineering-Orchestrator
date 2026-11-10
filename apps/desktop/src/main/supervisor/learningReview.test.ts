import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FOLDER_KIND,
  LEARNING_REVIEW_EVENT,
  LEARNING_REVIEW_TIMEOUT_MS,
  MEMORY_EXTRACTED_EVENT,
  MEMORY_NOTE_DEFINITION,
  MEMORY_NOTE_TOOL_NAME,
  SYSTEM_ROLE,
  type AgentEvent,
  type AgentForkResult,
  type AgentProvider,
  type AgentProviderResumeOptions,
  type AgentWriteAnswer,
  type AgentWriteRequest,
  type Item,
  type MemoryScope,
  type Uuid,
} from "@eo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../db/client.js";
import {
  createProject,
  createWorkspace,
  deleteItem,
  getItem,
  getRun,
  listAgents,
  listCommentsForItem,
  listMemories,
  listRunEvents,
  listRunsForItem,
  listSideCalls,
  postComment,
} from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { sendAgentWrite } from "../mcp/writeBridge.js";
import { createFakeProvider, type FakeProviderScript } from "../providers/fake.js";
import { startTestWriteBridge, type TestWriteBridge } from "../testing/agentWrites.js";
import { openAssistConversation } from "../roles/assist.js";
import { createRunSupervisor } from "./runSupervisor.js";

/** Where a succeeded implement run sends an item from To Do on the default pipeline. */
const AFTER_IMPLEMENT = "review";
const LIMITS = { globalConcurrency: 1, perAgentConcurrency: 1, perRepositoryConcurrency: 1 };
const RESULT = { branch: "eo/PAY-1", summary: "Did the work.", handoff: "Nothing to flag." };
/** Sixty words: what `memory_extract`, the fallback, still needs before it is asked. A review needs none. */
const LONG_RESULT = { ...RESULT, summary: "word ".repeat(60).trim() };
const PARKS = { toolCall: { name: "comment", args: { body: "@user need input", mentions: ["user"], blocking: true } } };

/** What a scripted review turn does on the fork: writes it asks EO for, then whether it hangs, then what it spent. */
interface ReviewScript {
  writes?: AgentWriteRequest[];
  /** Waits for the turn's signal before going on, as a turn running past its limit would. */
  hang?: boolean;
  /** Waits for this before going on. */
  until?: Promise<void>;
  /** The fork is refused, as a backend refuses a thread it does not have. */
  refuse?: boolean;
  /** The turn fails once opened. */
  failWith?: string;
}

/**
 * The learning review (EO-717), driven through a real dispatch on the
 * fake backend: the run as the fake plays it, and the review as a fork
 * scripted here — opened on the run's thread, making its writes over the
 * credential EO handed it, as the `eo` server would.
 */
describe("the learning review after a run", () => {
  let handle: DbHandle;
  let folder: string;
  let item: Item;
  let project: MemoryScope;
  let writes: TestWriteBridge;

  beforeEach(async () => {
    writes = await startTestWriteBridge();
    handle = openMigratedTestDb();
    folder = mkdtempSync(join(tmpdir(), "eo-learning-review-"));
    const w = createWorkspace(handle.db, { kind: FOLDER_KIND, config: { path: folder } });
    const p = createProject(handle.db, { name: "Payments", keyPrefix: "PAY", workspaceIds: [w.id] });
    project = { kind: "project", id: p.id };
    item = createTestItem(handle.db, { type: "story", title: "Add CSV export", stepId: "todo", projectId: p.id, workspaceId: w.id });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await writes.close();
    handle.close();
    rmSync(folder, { recursive: true, force: true });
  });

  /** The fake backend for the run, with a fork that plays `review` and records what it was asked. */
  function reviewing(script: FakeProviderScript, review: ReviewScript = {}) {
    const fake = createFakeProvider(script);
    const forks: { threadId: string; message: string; opts: AgentProviderResumeOptions }[] = [];
    const answers: AgentWriteAnswer[] = [];
    const resumes: { threadId: string; message: string }[] = [];
    const provider: AgentProvider = {
      ...fake,
      resume(threadId, message, opts) {
        resumes.push({ threadId, message });
        return fake.resume(threadId, message, opts);
      },
      async fork(threadId, message, opts): Promise<AgentForkResult> {
        forks.push({ threadId, message, opts: opts ?? {} });
        if (review.refuse) return { ok: false, reason: "thread_not_found", threadId, message: `No thread "${threadId}".` };
        const forkId = `fork-of-${threadId}`;
        async function* events(): AsyncIterable<AgentEvent> {
          yield { type: "thread_started", threadId: forkId, model: "the-agents-model" };
          for (const write of review.writes ?? []) answers.push(await sendAgentWrite(opts!.writeBridge!, write));
          if (review.until) await review.until;
          if (review.hang) await new Promise<void>((resolve) => opts!.signal!.addEventListener("abort", () => resolve(), { once: true }));
          yield { type: "usage", scope: "turn", tokensIn: 1_000, tokensOut: 50, costCents: 2 };
          if (review.failWith) {
            yield { type: "error", message: review.failWith, retryable: false };
            return;
          }
          yield { type: "output", text: "Saved what was worth saving." };
        }
        return { ok: true, threadId: forkId, events: events() };
      },
    };
    return { provider, forks, answers, resumes };
  }

  /** A side-call provider for `memory_extract`, the fallback, answering with one note. */
  function extractor() {
    const asked: string[] = [];
    const provider: AgentProvider = {
      ...createFakeProvider({}),
      async *sideCall() {
        asked.push("memory_extract");
        yield { type: "result", data: { notes: [{ scope: "project", text: "Extracted: seed the fixtures first." }] } } satisfies AgentEvent;
      },
    };
    return { provider, asked };
  }

  function supervisorOver(agent: AgentProvider, side: AgentProvider = extractor().provider) {
    const supervisor = createRunSupervisor({
      db: handle.db,
      provider: agent,
      limits: LIMITS,
      agentWriteBridge: writes.agentWriteBridge,
      sideCalls: { provider: () => side, smallModel: async () => null },
    });
    writes.serve(supervisor);
    return supervisor;
  }

  const onlyRun = () => listRunsForItem(handle.db, item.id)[0]!;
  const eventsOf = (runId: Uuid, type: string) => listRunEvents(handle.db, runId).filter((event) => event.type === type).map((event) => event.payload);
  const reviewEvents = (runId = onlyRun().id) => eventsOf(runId, LEARNING_REVIEW_EVENT);
  const extractCalls = () => listSideCalls(handle.db).filter((call) => call.purpose === "memory_extract");
  const note = (text: string): AgentWriteRequest => ({ tool: MEMORY_NOTE_TOOL_NAME, args: { scope: "project", text } });

  it("forks the run's thread and sends one review turn served memory_note alone, whose notes are recorded with their ids", async () => {
    const { provider, forks, answers } = reviewing({ result: RESULT }, { writes: [note("Seed the fixtures database before the integration tests.")] });
    const side = extractor();

    await supervisorOver(provider, side.provider).runOnce();

    const run = onlyRun();
    expect(run.status).toBe("succeeded");
    expect(getItem(handle.db, item.id)?.stepId).toBe(AFTER_IMPLEMENT);
    expect(forks).toHaveLength(1);
    // The run's own thread, forked; the review prompt with the definition word for word.
    expect(forks[0]!.threadId).toBe(run.threadId);
    expect(forks[0]!.message).toContain(MEMORY_NOTE_DEFINITION);
    // A credential for memory_note alone, memory_read's scopes, and none
    // of the run's other tools: no attached servers, no index, nothing to
    // attach from.
    expect(forks[0]!.opts.writeBridge?.writes).toEqual([MEMORY_NOTE_TOOL_NAME]);
    expect(forks[0]!.opts.memoryScopes).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "project", id: project.id })]));
    expect(forks[0]!.opts.toolDirectory).toBeUndefined();
    expect(forks[0]!.opts.repositoryMcp).toBeUndefined();
    expect(forks[0]!.opts.attachFrom).toBeUndefined();
    // Nor skills, nor EO's administrative server, whichever backend it is on.
    expect(forks[0]!.opts.withoutSkills).toBe(true);
    expect(forks[0]!.opts.withoutAdminServer).toBe(true);

    expect(answers).toEqual([expect.objectContaining({ ok: true })]);
    const written = listMemories(handle.db, project);
    expect(written).toEqual([
      expect.objectContaining({ body: "Seed the fixtures database before the integration tests.", source: { type: "run", runId: run.id, itemId: item.id, extracted: true } }),
    ]);
    expect(reviewEvents()).toEqual([{ type: LEARNING_REVIEW_EVENT, outcome: "written", entryIds: [written[0]!.id], reason: null, forkThreadId: `fork-of-${run.threadId}` }]);
    // It replaces extraction: no memory_extract call and no memory_extracted event.
    expect(side.asked).toEqual([]);
    expect(eventsOf(run.id, MEMORY_EXTRACTED_EVENT)).toEqual([]);
    // What the fork spent is counted where side calls are, against the run.
    expect(listSideCalls(handle.db).filter((call) => call.purpose === "learning_review")).toEqual([
      expect.objectContaining({ runId: run.id, itemId: item.id, model: "the-agents-model", tokensIn: 1_000, tokensOut: 50, outcome: "succeeded" }),
    ]);
    // The run's thread is still its own.
    expect(getRun(handle.db, run.id)?.threadId).toBe(run.threadId);
  });

  it("records a review that wrote nothing as nothing_to_save", async () => {
    const { provider, forks } = reviewing({ result: RESULT });

    await supervisorOver(provider).runOnce();

    expect(forks).toHaveLength(1);
    expect(reviewEvents()).toEqual([{ type: LEARNING_REVIEW_EVENT, outcome: "nothing_to_save", entryIds: [], reason: null, forkThreadId: expect.any(String) }]);
    expect(listMemories(handle.db, project)).toEqual([]);
    expect(extractCalls()).toEqual([]);
  });

  it("refuses every other write the review asks for, and posts nothing", async () => {
    const { provider, answers } = reviewing(
      { result: RESULT },
      {
        writes: [
          { tool: "comment", args: { body: "From the review." } },
          { tool: "attachment_add", args: { paths: ["a.txt"] } },
          { tool: "repository_checkout", args: { repository: "EO", branch: "main" } },
          note("Kept."),
        ],
      },
    );
    const supervisor = supervisorOver(provider);

    await supervisor.runOnce();

    expect(answers.slice(0, 3)).toEqual([
      expect.objectContaining({ ok: false, code: "TOOL_NOT_SERVED" }),
      expect.objectContaining({ ok: false, code: "TOOL_NOT_SERVED" }),
      expect.objectContaining({ ok: false, code: "TOOL_NOT_SERVED" }),
    ]);
    expect(answers[3]).toEqual(expect.objectContaining({ ok: true }));
    expect(listCommentsForItem(handle.db, item.id).filter((comment) => comment.body === "From the review.")).toEqual([]);
    expect(listMemories(handle.db, project).map((entry) => entry.body)).toEqual(["Kept."]);
    // And EO's own half refuses it too, whatever reached it.
    expect(await supervisor.handleAgentWrite(item.id, { tool: "comment", args: { body: "x" } }, [MEMORY_NOTE_TOOL_NAME])).toEqual(expect.objectContaining({ ok: false, code: "TOOL_NOT_SERVED" }));
  });

  it("leaves the item's own thread alone: a reply resumes the original thread and is not sent the review", async () => {
    const { provider, forks, resumes } = reviewing({ steps: [PARKS, { output: "continuing" }], result: RESULT }, { writes: [note("Parked runs keep their thread.")] });
    const supervisor = supervisorOver(provider);

    await supervisor.runOnce();
    const parked = onlyRun();
    expect(parked.status).toBe("awaiting_input");
    expect(forks.map((fork) => fork.threadId)).toEqual([parked.threadId]);
    expect(reviewEvents(parked.id)).toEqual([expect.objectContaining({ outcome: "written" })]);

    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "go ahead" });
    await supervisor.resumeItem(item.id);

    expect(resumes.map((turn) => turn.threadId)).toEqual([parked.threadId]);
    expect(resumes[0]!.message).not.toContain("# Learning review");
    const reply = listRunsForItem(handle.db, item.id).at(-1)!;
    expect(reply.threadId).toBe(parked.threadId);
  });

  it("falls back to memory_extract when the thread cannot be forked, and says so", async () => {
    const { provider, forks } = reviewing({ result: LONG_RESULT }, { refuse: true });
    const side = extractor();

    await supervisorOver(provider, side.provider).runOnce();

    const run = onlyRun();
    expect(forks).toHaveLength(1);
    expect(side.asked).toEqual(["memory_extract"]);
    expect(extractCalls()).toEqual([expect.objectContaining({ runId: run.id, outcome: "succeeded" })]);
    const extracted = listMemories(handle.db, project);
    expect(extracted.map((entry) => entry.body)).toEqual(["Extracted: seed the fixtures first."]);
    expect(eventsOf(run.id, MEMORY_EXTRACTED_EVENT)).toEqual([expect.objectContaining({ outcome: "written", entryIds: [extracted[0]!.id] })]);
    expect(reviewEvents()).toEqual([{ type: LEARNING_REVIEW_EVENT, outcome: "fell_back", entryIds: [], reason: `thread_not_found: No thread "${run.threadId}".`, forkThreadId: null }]);
  });

  it("falls back on a backend that cannot fork", async () => {
    const forkless: AgentProvider = { ...createFakeProvider({ result: LONG_RESULT }) };
    delete forkless.fork;
    const side = extractor();

    await supervisorOver(forkless, side.provider).runOnce();

    expect(side.asked).toEqual(["memory_extract"]);
    expect(reviewEvents()).toEqual([expect.objectContaining({ outcome: "fell_back", reason: expect.stringContaining("cannot fork a thread") })]);
  });

  it("records a review turn that fails as failed, without falling back", async () => {
    const { provider } = reviewing({ result: RESULT }, { failWith: "the model fell over" });
    const side = extractor();

    await supervisorOver(provider, side.provider).runOnce();

    expect(side.asked).toEqual([]);
    expect(reviewEvents()).toEqual([expect.objectContaining({ outcome: "failed", reason: expect.stringContaining("the model fell over") })]);
    expect(getItem(handle.db, item.id)?.stepId).toBe(AFTER_IMPLEMENT);
  });

  it("stops a review past its time limit and records it as failed, keeping what it wrote, and the item has already moved", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const { provider, forks } = reviewing({ result: RESULT }, { writes: [note("Written before the limit.")], hang: true });
    const side = extractor();

    const tick = supervisorOver(provider, side.provider).runOnce();
    await vi.waitFor(() => expect(listMemories(handle.db, project)).toHaveLength(1));
    expect(forks).toHaveLength(1);
    expect(getRun(handle.db, onlyRun().id)?.status).toBe("succeeded");
    expect(getItem(handle.db, item.id)?.stepId).toBe(AFTER_IMPLEMENT);

    await vi.advanceTimersByTimeAsync(LEARNING_REVIEW_TIMEOUT_MS);
    await tick;

    const written = listMemories(handle.db, project);
    expect(reviewEvents()).toEqual([{ type: LEARNING_REVIEW_EVENT, outcome: "failed", entryIds: [written[0]!.id], reason: expect.stringContaining("limit"), forkThreadId: expect.any(String) }]);
    expect(side.asked).toEqual([]);
    expect(getItem(handle.db, item.id)?.stepId).toBe(AFTER_IMPLEMENT);
    expect(listSideCalls(handle.db).filter((call) => call.purpose === "learning_review")).toEqual([expect.objectContaining({ outcome: "failed", reason: "timeout" })]);
  });

  it("holds the run's slot until the review returns: no other run starts meanwhile", async () => {
    let release: () => void = () => {};
    const until = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { provider, forks } = reviewing({ result: RESULT }, { until });
    const supervisor = supervisorOver(provider);

    const first = supervisor.runOnce();
    await vi.waitFor(() => expect(forks).toHaveLength(1));
    expect(onlyRun().status).toBe("succeeded");
    // Work waiting for the one global slot, in a workspace of its own and
    // ahead of the review step the first item moved to, so that nothing
    // but the global limit stands between it and a dispatch.
    const elsewhere = createWorkspace(handle.db, { kind: FOLDER_KIND, config: { path: mkdtempSync(join(folder, "other-")) } });
    const otherProject = createProject(handle.db, { name: "Reports", keyPrefix: "REP", workspaceIds: [elsewhere.id] });
    const waiting = createTestItem(handle.db, { type: "story", title: "Add PDF export", stepId: "todo", projectId: otherProject.id, workspaceId: elsewhere.id, priority: 10 });

    const second = supervisor.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(listRunsForItem(handle.db, waiting.id)).toEqual([]);

    release();
    await first;
    await second;
    await supervisor.runOnce();
    expect(listRunsForItem(handle.db, waiting.id).length).toBeGreaterThan(0);
  });

  it("forks the system agent's run too, without EO's administrative server, served memory_note alone", async () => {
    const conversation = openAssistConversation(handle.db, project.id as Uuid);
    deleteItem(handle.db, item.id);
    const systemAgent = listAgents(handle.db).find((agent) => agent.role === SYSTEM_ROLE)!;
    postComment(handle.db, { itemId: conversation.id, author: { type: "human" }, body: "How do we bill this?", mentions: [{ type: "agent", agentId: systemAgent.id }] });
    const { provider, forks, answers } = reviewing(
      { result: { message: "word ".repeat(60).trim() } },
      { writes: [{ tool: "comment", args: { body: "From the system agent's review." } }, note("Billing is monthly, in arrears.")] },
    );
    const side = extractor();

    await supervisorOver(provider, side.provider).runOnce();

    const [run] = listRunsForItem(handle.db, conversation.id);
    expect(run?.agentId).toBe(systemAgent.id);
    // Its own thread, forked — not a fallback.
    expect(forks.map((fork) => fork.threadId)).toEqual([run!.threadId]);
    expect(side.asked).toEqual([]);
    // Without the administrative server either adapter otherwise gives
    // every turn of the system agent's, and with a credential for
    // memory_note alone: any other write is refused.
    expect(forks[0]!.opts.withoutAdminServer).toBe(true);
    expect(forks[0]!.opts.writeBridge?.writes).toEqual([MEMORY_NOTE_TOOL_NAME]);
    expect(answers).toEqual([expect.objectContaining({ ok: false, code: "TOOL_NOT_SERVED" }), expect.objectContaining({ ok: true })]);
    expect(listCommentsForItem(handle.db, conversation.id).filter((comment) => comment.body === "From the system agent's review.")).toEqual([]);
    const written = listMemories(handle.db, project);
    expect(written.map((entry) => entry.body)).toEqual(["Billing is monthly, in arrears."]);
    expect(reviewEvents(run!.id)).toEqual([expect.objectContaining({ outcome: "written", entryIds: [written[0]!.id] })]);
  });

  describe("is not asked for, as extraction is not", () => {
    it("a run that called memory_note itself", async () => {
      const { provider, forks } = reviewing({ steps: [{ toolCall: { name: MEMORY_NOTE_TOOL_NAME, args: { scope: "project", text: "Its own." } } }], result: RESULT });

      await supervisorOver(provider).runOnce();

      expect(forks).toEqual([]);
      expect(reviewEvents()).toEqual([]);
    });

    it("a run that was cancelled", async () => {
      const { provider, forks } = reviewing({ steps: [{ sleepMs: 5_000 }], result: RESULT });
      const supervisor = supervisorOver(provider);

      const tick = supervisor.runOnce();
      await vi.waitFor(() => expect(listRunsForItem(handle.db, item.id)[0]?.status).toBe("running"));
      supervisor.cancelRun(onlyRun().id);
      await tick;

      expect(onlyRun().status).toBe("cancelled");
      expect(forks).toEqual([]);
      expect(reviewEvents()).toEqual([]);
    });

    it("a run that was interrupted", async () => {
      const { provider, forks } = reviewing({ steps: [{ sleepMs: 5_000 }], result: RESULT });
      const supervisor = supervisorOver(provider);

      const tick = supervisor.runOnce();
      await vi.waitFor(() => expect(listRunsForItem(handle.db, item.id)[0]?.status).toBe("running"));
      await supervisor.shutdown();
      await tick;

      expect(onlyRun().interruption).not.toBeNull();
      expect(forks).toEqual([]);
      expect(reviewEvents()).toEqual([]);
    });

    it("a run on a preview item", async () => {
      const preview = createTestItem(handle.db, { type: "story", title: "Weekly report", stepId: "todo", projectId: project.id as Uuid, previewAt: Date.now() });
      deleteItem(handle.db, item.id);
      const { provider, forks } = reviewing({ result: RESULT });

      await supervisorOver(provider).runOnce();

      const [run] = listRunsForItem(handle.db, preview.id);
      expect(run).toBeDefined();
      expect(forks).toEqual([]);
      expect(reviewEvents(run!.id)).toEqual([]);
    });

    it("a run with no memory scope", async () => {
      const loose = createTestItem(handle.db, { type: "story", title: "No project", stepId: "todo" });
      deleteItem(handle.db, item.id);
      const { provider, forks } = reviewing({ result: RESULT });

      await supervisorOver(provider).runOnce();

      const [run] = listRunsForItem(handle.db, loose.id);
      expect(run).toBeDefined();
      expect(forks).toEqual([]);
      expect(reviewEvents(run!.id)).toEqual([]);
    });
  });
});
