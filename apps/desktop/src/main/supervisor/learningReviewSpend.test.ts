import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { FOLDER_KIND, MICROCENTS_PER_CENT, type AgentProvider, type Item } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../db/client.js";
import { createProject, createWorkspace, listRunsForItem, listSideCalls } from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { createClaudeProvider } from "../providers/claude.js";
import { createCodexProvider } from "../providers/codex.js";
import { CodexClient, dropWarmCodexThread } from "../providers/codexClient.js";
import { codexModelPrice, codexTurnCostMicrocents } from "../providers/codexPricing.js";
import { validImplementResult } from "../providers/fixtures.js";
import { startTestWriteBridge, type TestWriteBridge } from "../testing/agentWrites.js";
import { fakeAppServer, note } from "../testing/fakeCodexAppServer.js";
import { createRunSupervisor } from "./runSupervisor.js";

/**
 * What a learning review's `side_calls` row records (EO-733), through
 * each real adapter: the fork's own spend, never the reviewed run's again.
 *
 * Both backends hand the fork the original's running total. Codex's
 * `thread/fork` copies the thread's token totals into the copy and
 * restates nothing before the turn, so the fork's first reading carries
 * the whole run; the client reads where the copy began off that
 * reading's own response (`last`). Claude's result is a session reading
 * the supervisor's tally takes the run's total off, as it does a resumed
 * run's. Either way the row is the fork's own turn.
 */

const LIMITS = { globalConcurrency: 1, perAgentConcurrency: 1, perRepositoryConcurrency: 1 };
const EXECUTABLE = "/opt/eo/runtimes/codex/bin/codex";

describe("a learning review's spend row", () => {
  let handle: DbHandle;
  let folder: string;
  let item: Item;
  let writes: TestWriteBridge;

  beforeEach(async () => {
    writes = await startTestWriteBridge();
    handle = openMigratedTestDb();
    folder = mkdtempSync(join(tmpdir(), "eo-review-spend-"));
    const workspace = createWorkspace(handle.db, { kind: FOLDER_KIND, config: { path: folder } });
    const project = createProject(handle.db, { name: "Payments", keyPrefix: "PAY", workspaceIds: [workspace.id] });
    item = createTestItem(handle.db, { type: "story", title: "Add CSV export", stepId: "todo", projectId: project.id, workspaceId: workspace.id });
  });

  afterEach(async () => {
    dropWarmCodexThread();
    await writes.close();
    handle.close();
    rmSync(folder, { recursive: true, force: true });
  });

  async function runAndReview(provider: AgentProvider) {
    const supervisor = createRunSupervisor({ db: handle.db, provider, limits: LIMITS, agentWriteBridge: writes.agentWriteBridge });
    writes.serve(supervisor);
    await supervisor.runOnce();
    const runs = listRunsForItem(handle.db, item.id);
    expect(runs).toHaveLength(1);
    const reviews = listSideCalls(handle.db).filter((call) => call.purpose === "learning_review");
    expect(reviews).toHaveLength(1);
    return { run: runs[0]!, review: reviews[0]! };
  }

  it("on Codex, records the fork's own input, cached input and output, and their cost — not the run it copied", async () => {
    // The run: one turn, 1,000,000 in (300,000 of it cached) and 100,000 out.
    const run = fakeAppServer({
      after: { "turn/start": [note.turnStarted(), note.agentMessage(JSON.stringify(validImplementResult)), note.tokenUsage({ input: 1_000_000, cached: 300_000, output: 100_000 }), note.turnCompleted()] },
    });
    // The review on the copy: 300,000 in (200,000 cached) and 20,000 out of
    // its own, read as the copy's running total — the run's and its own.
    const own = { input: 300_000, cached: 200_000, output: 20_000 };
    const fork = fakeAppServer({
      forkId: "thr-fork",
      after: {
        "turn/start": [
          note.turnStarted("turn-1", "thr-fork"),
          note.agentMessage("Nothing worth keeping.", "msg-1", "turn-1", "thr-fork"),
          note.tokenUsage({ input: 1_300_000, cached: 500_000, output: 120_000 }, "turn-1", "thr-fork", own),
          note.turnCompleted("completed", null, "turn-1", "thr-fork"),
        ],
      },
    });
    let launches = 0;
    const provider = createCodexProvider({
      executablePath: EXECUTABLE,
      // The review's fork refuses its other calls through EO's hook (EO-732),
      // and is not run without it.
      searchHookCommandPath: "/opt/eo/hook.mjs",
      searchHookTrust: async () => ({ key: "/<session-flags>/config.toml:pre_tool_use:0:0", hash: "sha256:stand-in" }),
      createCodex: () => new CodexClient({ executablePath: EXECUTABLE, spawn: (launches++ === 0 ? run : fork).spawn, shutdownGraceMs: 200 }),
    });

    const { run: reviewed, review } = await runAndReview(provider);

    expect(fork.paramsOf("thread/fork")).toMatchObject({ threadId: reviewed.threadId });
    expect(reviewed.tokensIn).toBe(1_000_000);
    const price = codexModelPrice("gpt-6.1-sol")!;
    expect(review).toMatchObject({
      runId: reviewed.id,
      tokensIn: own.input,
      tokensOut: own.output,
      // The cached share is priced as cached: 100,000 uncached, 200,000
      // cached and 20,000 out — the row has no column of its own for it.
      costMicrocents: codexTurnCostMicrocents({ input_tokens: own.input, cached_input_tokens: own.cached, output_tokens: own.output }, price),
      outcome: "succeeded",
    });
  });

  it("on Claude, records the fork's own tokens and cost, as it did before EO-733", async () => {
    const totalSoFar = (sessionId: string, inputTokens: number, outputTokens: number, usd: number, fields: Record<string, unknown> = {}) =>
      ({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "",
        num_turns: 1,
        total_cost_usd: usd,
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
        modelUsage: { "claude-opus": { inputTokens, outputTokens, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },
        session_id: sessionId,
        ...fields,
      }) as unknown as SDKMessage;
    const init = (sessionId: string) => ({ type: "system", subtype: "init", session_id: sessionId }) as unknown as SDKMessage;
    // The run, then its fork — a copy of the session whose result restores
    // the run's cost state and goes on from it.
    const turns = [
      [init("sess-run"), totalSoFar("sess-run", 1_000_000, 100_000, 10, { structured_output: validImplementResult })],
      [init("sess-fork"), totalSoFar("sess-fork", 1_300_000, 120_000, 13, { result: "Nothing worth keeping." })],
    ];
    let calls = 0;
    const runQuery = vi.fn(() => {
      const messages = turns[calls++] ?? [];
      return (async function* () {
        yield* messages;
      })();
    });

    const { run, review } = await runAndReview(createClaudeProvider({ runQuery: runQuery as never, enableCommentTool: false }));

    expect(run.threadId).toBe("sess-run");
    expect(run.tokensIn).toBe(1_000_000);
    expect(review).toMatchObject({ runId: run.id, tokensIn: 300_000, tokensOut: 20_000, costMicrocents: 300 * MICROCENTS_PER_CENT, outcome: "succeeded" });
  });
});
