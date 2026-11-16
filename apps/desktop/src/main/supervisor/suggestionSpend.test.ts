import { pageDescriptorFor, type AgentProvider, type SuggestionSpend, type Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { listRunsForItem, listSideCalls } from "../db/repos/index.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { sendToAssist } from "../ipc/assistCommands.js";
import { createRunSupervisor } from "./runSupervisor.js";

/**
 * What a suggested next message spent (EO-808): reported by the adapter
 * that made it with a turn of its own (`onSuggestionSpend`), and recorded
 * as a `prompt_suggestion` side call's row on the run, the way the
 * learning review's fork is.
 */
const LIMITS = { globalConcurrency: 1, perAgentConcurrency: 1, perRepositoryConcurrency: 1 };

let handle: DbHandle;
beforeEach(() => {
  handle = openMigratedTestDb();
});
afterEach(() => {
  handle.close();
});

/** A backend that answers the chat's turn and reports what a suggestion after it spent. */
function suggestingProvider(spends: SuggestionSpend[]): AgentProvider {
  return {
    start(opts) {
      return (async function* () {
        yield { type: "thread_started" as const, threadId: "thr-1" };
        for (const spend of spends) opts.onSuggestionSpend?.(spend);
        yield { type: "result" as const, data: { outcome: { message: "Hi.", questions: [], proposals: [] } } };
      })();
    },
    resume() {
      return (async function* () {})();
    },
  };
}

const usage = { type: "usage" as const, scope: "turn" as const, tokensIn: 400, tokensOut: 10, cacheReadTokens: 300, model: "gpt-6.1-sol", costCents: 0, costMicrocents: 12_345 };

describe("what a suggested next message spent (EO-808)", () => {
  it("is recorded as a prompt_suggestion side call on the chat's run, succeeded or failed as its turn ended", async () => {
    const supervisor = createRunSupervisor({
      db: handle.db,
      limits: LIMITS,
      provider: suggestingProvider([
        { usage, startedAt: 1_000, durationMs: 250, completed: true },
        { usage: { type: "usage", scope: "turn", tokensIn: 400, tokensOut: 10, model: "gpt-6.1-sol", costCents: 2 }, startedAt: 2_000, durationMs: 40, completed: false },
      ]),
    });
    const chat = (await sendToAssist(handle.db, undefined, { page: pageDescriptorFor("/chat"), conversationId: null, body: "What is waiting?", attachmentIds: [], interrupt: false })).conversation;
    await supervisor.runOnce();

    const [run] = listRunsForItem(handle.db, chat.id as Uuid);
    expect(run).toBeDefined();
    expect(listSideCalls(handle.db).filter((call) => call.purpose === "prompt_suggestion")).toEqual([
      expect.objectContaining({ itemId: chat.id, runId: run!.id, backend: run!.provider, model: "gpt-6.1-sol", tokensIn: 400, tokensOut: 10, costMicrocents: 12_345, startedAt: 1_000, durationMs: 250, outcome: "succeeded", reason: null }),
      expect.objectContaining({ runId: run!.id, costMicrocents: 2_000_000, outcome: "failed", reason: "error" }),
    ]);
  });

  it("records nothing for a turn whose backend reported none", async () => {
    const supervisor = createRunSupervisor({ db: handle.db, limits: LIMITS, provider: suggestingProvider([]) });
    await sendToAssist(handle.db, undefined, { page: pageDescriptorFor("/chat"), conversationId: null, body: "What is waiting?", attachmentIds: [], interrupt: false });
    await supervisor.runOnce();
    expect(listSideCalls(handle.db).filter((call) => call.purpose === "prompt_suggestion")).toEqual([]);
  });
});
