import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { FOLDER_KIND, LEARNING_REVIEW_EVENT, type AgentProvider, type Item, type Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { createProject, createRoute, createStep, createWorkspace, getItem, listAgents, listRunEvents, listRunsForItem, listSideCalls, saveActionDefinition, updateAgent } from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { createClaudeProvider } from "../providers/claude.js";
import { createCodexProvider } from "../providers/codex.js";
import { CodexClient, dropWarmCodexThread } from "../providers/codexClient.js";
import { startTestWriteBridge, type TestWriteBridge } from "../testing/agentWrites.js";
import { fakeAppServer, note } from "../testing/fakeCodexAppServer.js";
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
 * zero.
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

function backend(name: BackendName): Backend {
  if (name === "codex") {
    const fake = fakeAppServer({
      model: "gpt-6.1-sol",
      after: { "turn/start": [note.turnStarted(), note.agentMessage(JSON.stringify(ANSWER)), note.tokenUsage({ input: 10, output: 10 }), note.turnCompleted()] },
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
    { type: "result", subtype: "success", result: JSON.stringify(ANSWER), structured_output: ANSWER, total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 10 }, session_id: "sess_1" },
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

  it("forks no thread and records no review for an action whose learning review is off", async () => {
    define(false);
    const over = backend(name);

    await runOnceOn(over);

    expect(onlyRun().status).toBe("succeeded");
    expect(getItem(handle.db, item.id)?.stepId).toBe("review");
    // The run's own turn reached the backend; nothing after it did.
    expect(over.turns()).toBe(1);
    expect(over.forks()).toBe(0);
    expect(reviewCalls()).toEqual([]);
    // Skipped as the other skips are: no event, as for a cancelled run.
    expect(reviewEvents()).toEqual([]);
  });

  it("forks the run's thread for its review when the setting is on, and when nobody set it", async () => {
    define(undefined);
    const over = backend(name);

    await runOnceOn(over);

    expect(onlyRun().status).toBe("succeeded");
    expect(over.forks()).toBe(1);
    expect(reviewCalls()).toEqual([expect.objectContaining({ runId: onlyRun().id })]);
    expect(reviewEvents()).toHaveLength(1);
  });
});
