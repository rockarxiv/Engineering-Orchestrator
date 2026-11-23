import { pageDescriptorFor, SUGGESTED_REPLY_EVENT, type Agent, type AgentEvent, type AgentProvider, type AgentProviderStartOptions, type SuggestedReplyUse, type Uuid } from "@eo/core";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { deleteItem, listRunsForItem, readSuggestedReplyRecord, recordSuggestedReplyUse, updateAgent } from "../db/repos/index.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { recordSuggestedReplyUseCommand, sendToAssist } from "../ipc/assistCommands.js";
import { assistAgent } from "../roles/assist.js";
import { createRunSupervisor } from "./runSupervisor.js";
import type { SuggestedReply } from "./suggestedReplies.js";

/**
 * What the person did with a suggested reply shown in the composer
 * (EO-895): recorded beside what EO-810 recorded of the same suggestion,
 * keyed by the run it follows, the same whichever backend made it, and
 * never as a comment, a message or a run event.
 */
const LIMITS = { globalConcurrency: 1, perAgentConcurrency: 1, perRepositoryConcurrency: 1 };
const ANSWER = { outcome: { message: "Filed it as a draft.", questions: [], proposals: [] } };
const TEXT = "publish it";
const usage = { type: "usage" as const, scope: "turn" as const, tokensIn: 400, tokensOut: 10, cacheReadTokens: 300, model: "gpt-6.1-sol", costCents: 0, costMicrocents: 12_345 };

let handle: DbHandle;
beforeEach(() => {
  handle = openMigratedTestDb();
});
afterEach(() => {
  handle.close();
});

/**
 * A chat turn's backend, shaped as each one hands EO its suggestion. Both
 * send it as a `prompt_suggestion` after the turn's result. Codex makes it
 * with a turn of its own, so it also reports what that spent and what
 * became of it (EO-808, EO-810); Claude's CLI makes its own and says
 * neither.
 */
function backendFor(agent: Agent): AgentProvider {
  const turn = (opts: AgentProviderStartOptions | undefined) =>
    (async function* (): AsyncGenerator<AgentEvent> {
      yield { type: "thread_started", threadId: "thr-1" };
      yield { type: "result", data: ANSWER };
      if (opts?.suggestNextMessage !== true) return;
      if (agent.provider === "codex") {
        opts.onSuggestionSpend?.({ usage, fork: { mode: "prediction" }, startedAt: 1_000, durationMs: 250, completed: true });
        opts.onSuggestionOutcome?.({ kind: "emitted", text: TEXT, answer: `{"suggestion":"${TEXT}"}` });
      }
      yield { type: "prompt_suggestion", text: TEXT, threadId: "thr-1" };
    })();
  return { start: (opts) => turn(opts), resume: (_thread, _message, opts) => turn(opts as AgentProviderStartOptions | undefined) };
}

/** One action of `SuggestedReplyUse`, less the suggestion it names. */
type UseAction = SuggestedReplyUse extends infer Use ? (Use extends unknown ? Omit<Use, "conversationId" | "runId"> : never) : never;

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(check()).toBe(true);
}

/** Rows in the tables none of these actions may write. */
function written(): { comments: number; messages: number; runEvents: number } {
  const count = (table: string) => handle.db.get<{ n: number }>(sql.raw(`select count(*) as n from ${table}`)).n;
  return { comments: count("comments"), messages: count("messages"), runEvents: count("run_events") };
}

/** An assistant chat on `backend` whose one turn's suggestion has reached the window. */
async function suggestedOn(backend: "claude" | "codex") {
  const assistant = assistAgent(handle.db);
  updateAgent(handle.db, assistant!.id as Uuid, { provider: backend });
  const replies: SuggestedReply[] = [];
  const supervisor = createRunSupervisor({ db: handle.db, limits: LIMITS, provider: backendFor, onSuggestedReply: (reply) => replies.push(reply) });
  const conversation = (await sendToAssist(handle.db, undefined, { page: pageDescriptorFor("/chat"), conversationId: null, body: "Draft a release pipeline.", attachmentIds: [], interrupt: false })).conversation;
  await supervisor.runOnce();
  await supervisor.waitForIdle();
  await until(() => replies.length === 1);
  const [run] = listRunsForItem(handle.db, conversation.id as Uuid);
  expect(run?.provider).toBe(backend);
  expect(replies[0]).toEqual({ conversationId: conversation.id, runId: run!.id, text: TEXT });
  const use = (action: UseAction) =>
    recordSuggestedReplyUseCommand(handle.db, supervisor, { conversationId: conversation.id, runId: run!.id, ...action } as SuggestedReplyUse).recorded;
  return { supervisor, conversationId: conversation.id, runId: run!.id as Uuid, use };
}

describe("what the person did with a suggested reply (EO-895)", () => {
  describe.each(["claude", "codex"] as const)("made by %s", (backend) => {
    it("records shown once, accepted, and the message sent from it unedited", async () => {
      const { runId, use } = await suggestedOn(backend);
      const before = written();

      expect(use({ action: "shown" })).toBe(true);
      expect(use({ action: "shown" })).toBe(false);
      expect(use({ action: "accepted" })).toBe(true);
      expect(use({ action: "sent", edited: false })).toBe(true);
      expect(use({ action: "sent", edited: true })).toBe(false);

      expect(readSuggestedReplyRecord(handle.db, runId).uses.map(({ action, edited, dismissedBy }) => ({ action, edited, dismissedBy }))).toEqual([
        { action: "shown", edited: null, dismissedBy: null },
        { action: "accepted", edited: null, dismissedBy: null },
        { action: "sent", edited: false, dismissedBy: null },
      ]);
      expect(written()).toEqual(before);
    });

    it("records a suggestion accepted and sent edited", async () => {
      const { runId, use } = await suggestedOn(backend);
      use({ action: "shown" });
      use({ action: "accepted" });
      use({ action: "sent", edited: true });
      expect(readSuggestedReplyRecord(handle.db, runId).uses.map((row) => [row.action, row.edited])).toEqual([
        ["shown", null],
        ["accepted", null],
        ["sent", true],
      ]);
    });

    it("records a suggestion typed over as dismissed, and no accepted after it", async () => {
      const { runId, use } = await suggestedOn(backend);
      const before = written();
      use({ action: "shown" });
      expect(use({ action: "dismissed", by: "typed_over" })).toBe(true);
      expect(use({ action: "accepted" })).toBe(false);
      expect(use({ action: "dismissed", by: "newer_turn" })).toBe(false);
      expect(readSuggestedReplyRecord(handle.db, runId).uses.map((row) => [row.action, row.dismissedBy])).toEqual([
        ["shown", null],
        ["dismissed", "typed_over"],
      ]);
      expect(written()).toEqual(before);
    });
  });

  it("is read joined to the same suggestion's EO-808 spend and EO-810 outcome", async () => {
    const { runId, use } = await suggestedOn("codex");
    use({ action: "shown" });
    use({ action: "accepted" });
    use({ action: "sent", edited: false });

    const record = readSuggestedReplyRecord(handle.db, runId);
    expect(record.spend).toEqual([expect.objectContaining({ runId, purpose: "prompt_suggestion", tokensIn: 400, costMicrocents: 12_345, forkMode: "prediction", outcome: "succeeded" })]);
    expect(record.outcomes).toEqual([{ kind: "emitted", text: TEXT, answer: `{"suggestion":"${TEXT}"}` }]);
    expect(record.uses.map((row) => [row.runId, row.action])).toEqual([
      [runId, "shown"],
      [runId, "accepted"],
      [runId, "sent"],
    ]);
  });

  it("a Claude suggestion's record has its uses and nothing EO-810 could not have recorded", async () => {
    const { runId, use } = await suggestedOn("claude");
    use({ action: "shown" });
    expect(readSuggestedReplyRecord(handle.db, runId)).toEqual(expect.objectContaining({ spend: [], outcomes: [], uses: [expect.objectContaining({ action: "shown" })] }));
  });

  it("is refused for a run that made no suggestion for that chat, or another chat's", async () => {
    const { supervisor, conversationId, runId } = await suggestedOn("codex");
    expect(recordSuggestedReplyUseCommand(handle.db, supervisor, { conversationId, runId: "not-a-run", action: "shown" })).toEqual({ recorded: false });
    expect(recordSuggestedReplyUseCommand(handle.db, supervisor, { conversationId: "another-chat", runId, action: "shown" })).toEqual({ recorded: false });
    expect(recordSuggestedReplyUseCommand(handle.db, undefined, { conversationId, runId, action: "shown" })).toEqual({ recorded: false });
    expect(readSuggestedReplyRecord(handle.db, runId).uses).toEqual([]);
  });
});

describe("the order of a suggestion's actions (EO-895)", () => {
  it("takes accepted only after shown, sent only after accepted, and dismissed never after accepted", async () => {
    const { runId } = await suggestedOn("codex");
    expect(recordSuggestedReplyUse(handle.db, { runId, action: "accepted" })).toBe(false);
    expect(recordSuggestedReplyUse(handle.db, { runId, action: "dismissed", by: "left" })).toBe(false);
    expect(recordSuggestedReplyUse(handle.db, { runId, action: "shown" })).toBe(true);
    expect(recordSuggestedReplyUse(handle.db, { runId, action: "sent", edited: false })).toBe(false);
    expect(recordSuggestedReplyUse(handle.db, { runId, action: "accepted" })).toBe(true);
    expect(recordSuggestedReplyUse(handle.db, { runId, action: "dismissed", by: "left" })).toBe(false);
    expect(readSuggestedReplyRecord(handle.db, runId).uses.map((row) => row.action)).toEqual(["shown", "accepted"]);
  });

  it("goes with its chat's runs when the chat is deleted", async () => {
    const { conversationId, runId, use } = await suggestedOn("codex");
    use({ action: "shown" });
    const types = handle.db.all<{ type: string }>(sql`select type from run_events where run_id = ${runId}`).map((row) => row.type);
    expect(types.filter((type) => type === SUGGESTED_REPLY_EVENT)).toHaveLength(1);
    deleteItem(handle.db, conversationId as Uuid);
    expect(handle.db.all(sql`select * from suggested_reply_uses`)).toEqual([]);
    expect(handle.db.all(sql`pragma foreign_key_check`)).toEqual([]);
  });
});
