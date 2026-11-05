import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { parsedResultOf, type Agent, type Item } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listAgents } from "../db/repos/agentsRepo.js";
import { createRun, getRun, listRunsForItem, updateRun } from "../db/repos/runsRepo.js";
import type { DbHandle } from "../db/client.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { createClaudeProvider } from "../providers/claude.js";
import { validImplementResult, validImplementResultParsed } from "../providers/fixtures.js";
import { createRunSupervisor } from "./runSupervisor.js";

/**
 * Restart recovery on a session the CLI has something to finish first
 * (EO-495).
 *
 * EO-487's recovery resumed a Claude session killed mid-tool-call. The
 * resumed CLI closed out the interrupted turn — an empty `success`, 0
 * turns, echoing no message — before it read EO's recovery prompt. The
 * supervisor took that as the recovery's result, failed it against the
 * implement schema, and opened a correction on the same thread, killing
 * the process that was about to do the recovery.
 *
 * Driven through the real Claude adapter over a fake SDK, since telling
 * the two results apart is the adapter's job and the supervisor is where
 * mistaking them cost a correction. The SDK messages are the shapes the
 * pinned CLI was measured writing.
 */

const LIMITS = { globalConcurrency: 1, perAgentConcurrency: 1, perRepositoryConcurrency: 1 };
const THREAD = "fa8d3c92-7319-404e-bf6f-2f76487e9de1";

const init = (fields: Record<string, unknown> = {}): SDKMessage => ({ type: "system", subtype: "init", session_id: THREAD, ...fields }) as unknown as SDKMessage;

const result = (fields: Record<string, unknown>): SDKMessage =>
  ({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "",
    num_turns: 1,
    total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
    session_id: THREAD,
    ...fields,
  }) as unknown as SDKMessage;

/** What the resumed CLI writes for the turn the kill interrupted: nothing asked of the model, nothing echoed. */
const interruptedTurnClosed = (): SDKMessage => result({ num_turns: 0 });

/** A turn's input, read as the CLI reads it: the first message now, the rest as they come. */
type Turn = { prompt: string; uuid: string | undefined; messages: SDKMessage[] };

/**
 * A fake SDK whose every `query` is a resume of the one session. `script`
 * says what the CLI writes on each, given the message EO sent it.
 */
function fakeCli(script: ((turn: { prompt: string; uuid: string }) => SDKMessage[])[]) {
  const turns: Turn[] = [];
  const runQuery = vi.fn((params: { prompt: AsyncIterable<SDKUserMessage>; options?: Record<string, unknown> }) =>
    (async function* () {
      const first = await params.prompt[Symbol.asyncIterator]().next();
      const content = first.done ? "" : first.value.message.content;
      const prompt = typeof content === "string" ? content : content.map((block) => ("text" in block ? block.text : "")).join("");
      const uuid = first.done ? undefined : first.value.uuid;
      const messages = script[turns.length]?.({ prompt, uuid: uuid ?? "" }) ?? [];
      turns.push({ prompt, uuid, messages });
      yield* messages;
    })(),
  );
  return { runQuery, turns };
}

describe("restart recovery on a session with an interrupted turn to close (EO-495)", () => {
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

  /** A run the app died in the middle of, on a thread recovery can resume. */
  function interruptedRun() {
    const run = createRun(handle.db, { itemId: item.id, agentId: implementer.id, action: "implement", status: "queued", threadId: THREAD });
    updateRun(handle.db, run.id, { status: "running", startedAt: Date.now() });
    return run;
  }

  async function recover(runQuery: ReturnType<typeof fakeCli>["runQuery"]) {
    const interrupted = interruptedRun();
    const supervisor = createRunSupervisor({ db: handle.db, provider: createClaudeProvider({ runQuery: runQuery as never, enableCommentTool: false }), limits: LIMITS });
    expect(await supervisor.reconcile()).toMatchObject({ resumed: 1 });
    const continuation = () => listRunsForItem(handle.db, item.id).find((run) => run.id !== interrupted.id)!;
    await vi.waitFor(() => expect(getRun(handle.db, continuation().id)?.status).not.toBe("running"));
    return getRun(handle.db, continuation().id)!;
  }

  it("reads past the interrupted turn's closing result to the recovery's own, and opens no correction", async () => {
    const { runQuery, turns } = fakeCli([
      ({ uuid }) => [
        init(),
        interruptedTurnClosed(),
        init({ user_message_uuids: [uuid] }),
        { type: "assistant", message: { content: [{ type: "text", text: "Committing what the restart interrupted." }] }, session_id: THREAD } as unknown as SDKMessage,
        result({ num_turns: 4, structured_output: validImplementResult, user_message_uuid: uuid, user_message_uuids: [uuid] }),
      ],
    ]);

    const recovered = await recover(runQuery);

    // One process on the thread: no correction was opened.
    expect(runQuery).toHaveBeenCalledTimes(1);
    expect(turns[0]?.uuid).toEqual(expect.any(String));
    expect(recovered.status).toBe("succeeded");
    expect(parsedResultOf(recovered.result)).toEqual(validImplementResultParsed);
  });

  it("still corrects a recovery whose only result is the empty one", async () => {
    const { runQuery, turns } = fakeCli([
      () => [init(), interruptedTurnClosed()],
      ({ uuid }) => [init({ user_message_uuids: [uuid] }), result({ num_turns: 1, structured_output: validImplementResult, user_message_uuids: [uuid] })],
    ]);

    const recovered = await recover(runQuery);

    expect(runQuery).toHaveBeenCalledTimes(2);
    expect(turns[1]?.prompt).toContain("did not match the required schema");
    expect(recovered.status).toBe("succeeded");
    expect(parsedResultOf(recovered.result)).toEqual(validImplementResultParsed);
  });

  it("still corrects a recovery whose own result is invalid", async () => {
    const { runQuery, turns } = fakeCli([
      ({ uuid }) => [init(), interruptedTurnClosed(), init({ user_message_uuids: [uuid] }), result({ num_turns: 2, result: "Done, I think.", user_message_uuids: [uuid] })],
      ({ uuid }) => [init({ user_message_uuids: [uuid] }), result({ num_turns: 1, structured_output: validImplementResult, user_message_uuids: [uuid] })],
    ]);

    const recovered = await recover(runQuery);

    expect(runQuery).toHaveBeenCalledTimes(2);
    expect(turns[1]?.prompt).toContain("did not match the required schema");
    expect(recovered.status).toBe("succeeded");
  });
});
