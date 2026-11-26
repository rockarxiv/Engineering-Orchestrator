import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { CHAT_IDLE_BEFORE_REVIEW_MS, FOLDER_KIND, LEARNING_REVIEW_EVENT, SYSTEM_ROLE, type AgentProvider, type Item, type Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import {
  appendRunEvent,
  createProject,
  createRoute,
  createRun,
  createStep,
  createWorkspace,
  getItem,
  listAgents,
  listRunEvents,
  listRunsForItem,
  listSideCalls,
  postComment,
  saveActionDefinition,
  setActionLearningReview,
  updateAgent,
  updateRun,
} from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { createClaudeProvider } from "../providers/claude.js";
import { createCodexProvider } from "../providers/codex.js";
import { CodexClient, dropWarmCodexThread } from "../providers/codexClient.js";
import { startTestWriteBridge, type TestWriteBridge } from "../testing/agentWrites.js";
import { openAssistConversation, postAssistReply } from "../roles/assist.js";
import { ASSIST_ACTION } from "../roles/conversationSteps.js";
import { fakeAppServer, note } from "../testing/fakeCodexAppServer.js";
import { learningReviewSkippedEvent } from "../memory/learningReview.js";
import { createRunSupervisor } from "./runSupervisor.js";

/**
 * Whether an action's runs get a learning review is a person's setting
 * on the action (EO-911), and it does the same on either backend
 * (invariant 12).
 *
 * Run through **the real adapters** — Claude's over a stubbed `query`,
 * Codex's over a stubbed app-server — so what is counted is whether the
 * backend itself was asked to fork the run's thread: a `query` resuming
 * with `forkSession`, a `thread/fork` request. A scripted provider would
 * show only that the supervisor did not call it.
 *
 * The action is one the implementer defines for itself, on a step of
 * its own, so the setting is the one a person saves; the same run with
 * the setting on is the case that shows the count can be other than
 * zero. And an assistant chat's `assist`, which EO runs for itself and
 * reviews once the chat has gone quiet (EO-788): the setting is on the
 * system agent's role, and is asked as each thread's review would start,
 * so a setting changed since the turn ended is the one that counts.
 */
const LIMITS = { globalConcurrency: 1, perAgentConcurrency: 1, perRepositoryConcurrency: 1 };
const EXECUTABLE = "/opt/eo/runtimes/codex/bin/codex";
const ANSWER = { result: "done", summary: "Checked the export against the brief." };

type BackendName = "claude" | "codex";

interface Backend {
  provider: AgentProvider;
  /** How many times the backend was asked to fork a thread: `query` with `forkSession` on Claude, `thread/fork` on Codex. */
  forks: () => number;
  /** How many turns the backend was asked for in all, forks included. */
  turns: () => number;
}

/** What an assistant chat's turn answers in: a reply, and nothing to ask or propose. */
const CHAT_ANSWER = { message: "The export is a CSV of the ledger.", questions: [], proposals: [] };

function backend(name: BackendName, answer: Record<string, unknown> = ANSWER): Backend {
  if (name === "codex") {
    const fake = fakeAppServer({
      model: "gpt-6.1-sol",
      after: { "turn/start": [note.turnStarted(), note.agentMessage(JSON.stringify(answer)), note.tokenUsage({ input: 10, output: 10 }), note.turnCompleted()] },
    });
    return {
      provider: createCodexProvider({
        executablePath: EXECUTABLE,
        createCodex: () => new CodexClient({ executablePath: EXECUTABLE, spawn: fake.spawn, shutdownGraceMs: 200 }),
        // The hook a review's fork refuses its other calls with (EO-732), as the app installs it; trusted without asking the CLI.
        searchHookCommandPath: "/opt/eo/hook.mjs",
        searchHookTrust: async () => ({ key: "/<session-flags>/config.toml:pre_tool_use:0:0", hash: "sha256:abc123" }),
      }),
      forks: () => fake.sent.filter((message) => message.method === "thread/fork").length,
      turns: () => fake.sent.filter((message) => message.method === "turn/start").length,
    };
  }
  const calls: { forkSession?: boolean }[] = [];
  const messages = [
    { type: "system", subtype: "init", session_id: "sess_1" },
    { type: "result", subtype: "success", result: JSON.stringify(answer), structured_output: answer, total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 10 }, session_id: "sess_1" },
  ] as unknown as SDKMessage[];
  const runQuery = ((args: { options?: { forkSession?: boolean } }) => {
    calls.push({ ...(args.options?.forkSession === undefined ? {} : { forkSession: args.options.forkSession }) });
    return (async function* () {
      for (const message of messages) yield message;
    })();
  }) as never;
  return {
    provider: createClaudeProvider({ runQuery, enableCommentTool: false }),
    forks: () => calls.filter((call) => call.forkSession === true).length,
    turns: () => calls.length,
  };
}

describe.each<BackendName>(["claude", "codex"])("the learning review after a run of a role's own action, on %s (EO-911)", (name) => {
  let handle: DbHandle;
  let folder: string;
  let item: Item;
  let writes: TestWriteBridge;

  beforeEach(async () => {
    writes = await startTestWriteBridge();
    handle = openMigratedTestDb();
    folder = mkdtempSync(join(tmpdir(), "eo-911-"));
    const workspace = createWorkspace(handle.db, { kind: FOLDER_KIND, config: { path: folder } });
    const project = createProject(handle.db, { name: "Payments", keyPrefix: "PAY", workspaceIds: [workspace.id] });
    // The implementer, on the backend under test, on a step running an action it defines for itself.
    const implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
    updateAgent(handle.db, implementer.id, { provider: name });
    createStep(handle.db, { id: "check", pipelineId: "default" as Uuid, position: 15, name: "Check", type: "agent", agentId: implementer.id, entryAction: "check" });
    createRoute(handle.db, { pipelineId: "default" as Uuid, fromStepId: "check", resultKey: "done", label: "Done", target: "review" });
    item = createTestItem(handle.db, { type: "story", title: "Add CSV export", stepId: "check", projectId: project.id, workspaceId: workspace.id });
  });

  afterEach(async () => {
    dropWarmCodexThread();
    await writes.close();
    handle.close();
    rmSync(folder, { recursive: true, force: true });
  });

  function define(learningReview: boolean | undefined): void {
    const saved = saveActionDefinition(handle.db, {
      role: "implementer",
      action: "check",
      description: "Checks the work against the brief.",
      results: [{ key: "done", label: "Done", meaning: "The check is finished." }],
      ...(learningReview === undefined ? {} : { learningReview }),
    });
    expect(saved.ok).toBe(true);
  }

  async function runOnceOn(over: Backend): Promise<void> {
    const supervisor = createRunSupervisor({
      db: handle.db,
      provider: over.provider,
      limits: LIMITS,
      agentWriteBridge: writes.agentWriteBridge,
      sideCalls: { provider: () => over.provider, smallModel: async () => null },
    });
    writes.serve(supervisor);
    await supervisor.runOnce();
    await supervisor.shutdown();
  }

  const onlyRun = () => listRunsForItem(handle.db, item.id)[0]!;
  const reviewEvents = () => listRunEvents(handle.db, onlyRun().id).filter((event) => event.type === LEARNING_REVIEW_EVENT);
  const reviewCalls = () => listSideCalls(handle.db).filter((call) => call.purpose === "learning_review");

  const skippedEvent = (role: string, action: string) => ({
    type: LEARNING_REVIEW_EVENT,
    outcome: "skipped",
    review: "full",
    entryIds: [],
    skillIds: [],
    reason: `The learning review is off for the ${role} role's "${action}" action, so this run was not reviewed.`,
    forkThreadId: null,
    skip: "action_off",
  });

  it("forks no thread, makes no side call, and records the skip and why for an action whose learning review is off", async () => {
    define(false);
    const over = backend(name);

    await runOnceOn(over);

    expect(onlyRun().status).toBe("succeeded");
    expect(getItem(handle.db, item.id)?.stepId).toBe("review");
    // The run's own turn reached the backend; nothing after it did.
    expect(over.turns()).toBe(1);
    expect(over.forks()).toBe(0);
    expect(reviewCalls()).toEqual([]);
    // No extraction in its place either.
    expect(listSideCalls(handle.db)).toEqual([]);
    expect(reviewEvents().map((event) => event.payload)).toEqual([skippedEvent("implementer", "check")]);
  });

  it("takes a setting made after the definition, as the next run asks it", async () => {
    define(undefined);
    setActionLearningReview(handle.db, "implementer", "check", false);
    const over = backend(name);

    await runOnceOn(over);

    expect(over.forks()).toBe(0);
    expect(reviewEvents().map((event) => event.payload)).toEqual([skippedEvent("implementer", "check")]);
  });

  it("forks the run's thread for its review when the setting is on, and when nobody set it", async () => {
    define(undefined);
    const over = backend(name);

    await runOnceOn(over);

    expect(onlyRun().status).toBe("succeeded");
    expect(over.forks()).toBe(1);
    expect(reviewCalls()).toEqual([expect.objectContaining({ runId: onlyRun().id })]);
    expect(reviewEvents()).toEqual([expect.objectContaining({ payload: expect.objectContaining({ outcome: "nothing_to_save" }) })]);
  });
});

describe.each<BackendName>(["claude", "codex"])("the learning review of an assistant chat, on %s (EO-911)", (name) => {
  let handle: DbHandle;
  let folder: string;
  let chat: Item;
  let writes: TestWriteBridge;
  let clock: number;

  beforeEach(async () => {
    writes = await startTestWriteBridge();
    handle = openMigratedTestDb();
    folder = mkdtempSync(join(tmpdir(), "eo-911-chat-"));
    const workspace = createWorkspace(handle.db, { kind: FOLDER_KIND, config: { path: folder } });
    const project = createProject(handle.db, { name: "Payments", keyPrefix: "PAY", workspaceIds: [workspace.id] });
    chat = openAssistConversation(handle.db, project.id as Uuid);
    clock = Date.now();
  });

  afterEach(async () => {
    dropWarmCodexThread();
    await writes.close();
    handle.close();
    rmSync(folder, { recursive: true, force: true });
  });

  const systemAgent = () => listAgents(handle.db).find((agent) => agent.role === SYSTEM_ROLE)!;

  /**
   * The person's message to the system agent, the turn it starts, and then
   * the chat left quiet past the idle time — with `meanwhile` done between
   * the turn's end and the chat going quiet.
   */
  async function chatThenQuiet(over: Backend, meanwhile: () => void = () => {}): Promise<void> {
    const system = systemAgent();
    updateAgent(handle.db, system.id, { provider: name });
    const supervisor = createRunSupervisor({
      db: handle.db,
      provider: over.provider,
      limits: LIMITS,
      now: () => clock,
      agentWriteBridge: writes.agentWriteBridge,
      sideCalls: { provider: () => over.provider, smallModel: async () => null },
      onRunSucceeded: (item, agent, action, parsedResult, runId) => {
        if (action === ASSIST_ACTION) postAssistReply(handle.db, item, agent.id, runId, parsedResult);
      },
    });
    writes.serve(supervisor);
    postComment(handle.db, { itemId: chat.id, author: { type: "human" }, body: "What does the export hold?", mentions: [{ type: "agent", agentId: system.id }] });
    await supervisor.runOnce();
    meanwhile();
    clock += CHAT_IDLE_BEFORE_REVIEW_MS + 1_000;
    await supervisor.runOnce();
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    await supervisor.runOnce();
    await supervisor.shutdown();
  }

  const chatRuns = () => listRunsForItem(handle.db, chat.id).filter((run) => run.action === ASSIST_ACTION);
  const reviewEvents = () => chatRuns().flatMap((run) => listRunEvents(handle.db, run.id).filter((event) => event.type === LEARNING_REVIEW_EVENT).map((event) => event.payload));

  it("records the skip and forks nothing once the chat is quiet, where assist's learning review is off", async () => {
    setActionLearningReview(handle.db, SYSTEM_ROLE, ASSIST_ACTION, false);
    const over = backend(name, CHAT_ANSWER);

    await chatThenQuiet(over);

    expect(chatRuns().map((run) => run.status)).toEqual(["succeeded"]);
    expect(over.turns()).toBe(1);
    expect(over.forks()).toBe(0);
    expect(listSideCalls(handle.db)).toEqual([]);
    expect(reviewEvents()).toEqual([expect.objectContaining({ outcome: "skipped", skip: "action_off", forkThreadId: null })]);
  });

  it("reviews the quiet chat on a fork where nobody set anything", async () => {
    const over = backend(name, CHAT_ANSWER);

    await chatThenQuiet(over);

    expect(chatRuns().map((run) => run.status)).toEqual(["succeeded"]);
    expect(over.forks()).toBe(1);
    expect(reviewEvents()).toEqual([expect.objectContaining({ outcome: "nothing_to_save" })]);
  });

  it("records the skip of a review still owed when assist's learning review is turned off after the turn ended", async () => {
    const over = backend(name, CHAT_ANSWER);

    await chatThenQuiet(over, () => setActionLearningReview(handle.db, SYSTEM_ROLE, ASSIST_ACTION, false));

    expect(over.turns()).toBe(1);
    expect(over.forks()).toBe(0);
    expect(listSideCalls(handle.db)).toEqual([]);
    expect(reviewEvents()).toEqual([expect.objectContaining({ outcome: "skipped", skip: "action_off", forkThreadId: null })]);
  });

  it("reviews a run that ended with the setting off where it is turned back on before the chat is quiet", async () => {
    setActionLearningReview(handle.db, SYSTEM_ROLE, ASSIST_ACTION, false);
    const over = backend(name, CHAT_ANSWER);

    await chatThenQuiet(over, () => setActionLearningReview(handle.db, SYSTEM_ROLE, ASSIST_ACTION, true));

    expect(over.forks()).toBe(1);
    expect(reviewEvents()).toEqual([expect.objectContaining({ outcome: "nothing_to_save" })]);
  });

  /** An `assist` run of the system agent's on its own thread, ended long enough ago for the chat to be quiet. */
  function endedChatRun(threadId: string): Uuid {
    const run = createRun(handle.db, { itemId: chat.id, agentId: systemAgent().id, action: ASSIST_ACTION, status: "succeeded", threadId, provider: name, cwd: folder });
    updateRun(handle.db, run.id, { endedAt: clock - CHAT_IDLE_BEFORE_REVIEW_MS - 1_000 });
    return run.id;
  }

  async function quietPass(provider: AgentProvider): Promise<void> {
    const supervisor = createRunSupervisor({
      db: handle.db,
      provider,
      limits: LIMITS,
      now: () => clock,
      agentWriteBridge: writes.agentWriteBridge,
      sideCalls: { provider: () => provider, smallModel: async () => null },
    });
    writes.serve(supervisor);
    await supervisor.runOnce();
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    await supervisor.runOnce();
    await supervisor.shutdown();
  }

  const eventsOf = (runId: Uuid) => listRunEvents(handle.db, runId).filter((event) => event.type === LEARNING_REVIEW_EVENT).map((event) => event.payload);

  it("asks the setting again before each thread's fork, so turning it off during one thread's review starts no other", async () => {
    updateAgent(handle.db, systemAgent().id, { provider: name });
    const first = endedChatRun("thread-a");
    const second = endedChatRun("thread-b");
    const over = backend(name, CHAT_ANSWER);
    // The person turns it off while the first thread's review is under way.
    const provider = new Proxy(over.provider, {
      get(target, property) {
        const value: unknown = Reflect.get(target, property, target);
        if (property === "fork" && typeof value === "function") {
          return (...args: unknown[]) => {
            setActionLearningReview(handle.db, SYSTEM_ROLE, ASSIST_ACTION, false);
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });

    await quietPass(provider);

    expect(over.forks()).toBe(1);
    expect(eventsOf(first)).toEqual([expect.objectContaining({ outcome: "nothing_to_save" })]);
    expect(eventsOf(second)).toEqual([expect.objectContaining({ outcome: "skipped", skip: "action_off", forkThreadId: null })]);
  });

  it("reviews an older thread's run that is still owed, where a newer thread's run carries a skip (the skip settles its own run only)", async () => {
    updateAgent(handle.db, systemAgent().id, { provider: name });
    // Thread A's run ended with reviews on and has not been reviewed; thread
    // B's carries the skip of a review turned off for it; reviews are on now.
    const older = endedChatRun("thread-a");
    const newer = endedChatRun("thread-b");
    appendRunEvent(handle.db, newer, LEARNING_REVIEW_EVENT, learningReviewSkippedEvent("full", SYSTEM_ROLE, ASSIST_ACTION));
    const over = backend(name, CHAT_ANSWER);

    await quietPass(over.provider);

    expect(over.forks()).toBe(1);
    expect(eventsOf(older)).toEqual([expect.objectContaining({ outcome: "nothing_to_save" })]);
    // B is not reviewed again on top of its skip.
    expect(eventsOf(newer)).toEqual([expect.objectContaining({ outcome: "skipped", skip: "action_off" })]);
  });
});
