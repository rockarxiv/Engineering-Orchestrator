import type { Agent, AgentProvider, Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../db/client.js";
import { createRun, listAgents, listCommentsForItem, listRunsForItem, postComment, updateRun } from "../db/repos/index.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { openAssist } from "../ipc/assistCommands.js";
import { ASSIST_ACTION } from "../roles/conversationSteps.js";
import { createRunSupervisor } from "./runSupervisor.js";
import { kindsPreparing } from "./testWorkspaceKinds.js";

/**
 * A device preflight that refuses says so once per message, not once per
 * tick (EO-802).
 *
 * An Assistant chat message is a human comment mentioning the system
 * agent, so it stays an open mention — offered again on every tick — until
 * it is answered. A refusal that does not ask whether it has already been
 * said posts the same escalation every few seconds; on Windows, a Codex
 * home EO could not make put nine of them in the Inbox within a minute.
 */

const LIMITS = { globalConcurrency: 1, perAgentConcurrency: 1, perRepositoryConcurrency: 1 };
const REASON = "System runs with a Codex home of its own, and EO could not make one. Then reply here to retry.";

let handle: DbHandle;
let systemAgent: Agent;
let providerCalls: string[];

beforeEach(() => {
  handle = openMigratedTestDb();
  systemAgent = listAgents(handle.db).find((agent) => agent.role === "system")!;
  providerCalls = [];
});

afterEach(() => {
  handle.close();
});

function provider(): AgentProvider {
  return {
    start: () => {
      providerCalls.push("start");
      throw new Error("a refused dispatch must not reach the provider");
    },
    resume: (threadId) => {
      providerCalls.push(`resume:${threadId}`);
      throw new Error("a refused resume must not reach the provider");
    },
  };
}

function refusingSupervisor() {
  const checkAuth = vi.fn(async () => ({ ok: false as const, reason: REASON }));
  const engine = createRunSupervisor({
    db: handle.db,
    provider: provider(),
    kinds: kindsPreparing("/tmp/eo/preflight-refusal"),
    limits: LIMITS,
    checkAuth,
  });
  return { engine, checkAuth };
}

/** What sending a chat message does: a human comment mentioning the agent. */
function say(itemId: Uuid, body: string) {
  return postComment(handle.db, { itemId, author: { type: "human" }, body, mentions: [{ type: "agent", agentId: systemAgent.id }] });
}

function escalations(itemId: Uuid) {
  return listCommentsForItem(handle.db, itemId).filter((comment) => comment.authorType === "engine" && comment.kind === "escalation");
}

function placeholders(itemId: Uuid) {
  return listRunsForItem(handle.db, itemId).filter((run) => run.status === "awaiting_input");
}

async function ticks(engine: { runOnce: () => Promise<void> }, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) await engine.runOnce();
}

describe("a refused device preflight", () => {
  it("refuses an open chat mention once, however many ticks offer it, and once more for the next message", async () => {
    const { engine, checkAuth } = refusingSupervisor();
    const chat = openAssist(handle.db).conversation.id as Uuid;
    const first = say(chat, "Rework the release pipeline.");

    await ticks(engine, 3);

    expect(checkAuth).toHaveBeenCalled();
    expect(escalations(chat).map((comment) => comment.body)).toEqual([REASON]);
    const parked = placeholders(chat);
    expect(parked).toHaveLength(1);
    expect(parked[0]).toMatchObject({ action: ASSIST_ACTION, initiationId: first.id, error: REASON });

    // A second message is new work, refused once for itself.
    const second = say(chat, "Try again?");
    await ticks(engine, 3);

    expect(escalations(chat).map((comment) => comment.body)).toEqual([REASON, REASON]);
    expect(placeholders(chat).map((run) => run.initiationId)).toEqual([first.id, second.id]);
    expect(providerCalls).toEqual([]);
    expect(listRunsForItem(handle.db, chat).filter((run) => run.status === "failed")).toEqual([]);
  });

  it("refuses a reply to a parked turn with a thread before the thread is resumed, once", async () => {
    const chat = openAssist(handle.db).conversation.id as Uuid;
    // A turn that asked a question and parked with its thread. The
    // message it answered is already read, so no mention of it is open.
    const asked = postComment(handle.db, { itemId: chat, author: { type: "human" }, body: "Rework the release pipeline." });
    const parked = createRun(handle.db, {
      itemId: chat,
      agentId: systemAgent.id,
      action: ASSIST_ACTION,
      status: "awaiting_input",
      threadId: "thread-parked",
      provider: systemAgent.provider,
      initiationId: asked.id,
    });
    updateRun(handle.db, parked.id, { startedAt: Date.now() - 1_000, endedAt: Date.now() - 1_000 });

    const { engine, checkAuth } = refusingSupervisor();
    // A chat reply mentions the agent, so the mention door offers it on
    // every tick as well as the reply door resuming the thread.
    const reply = say(chat, "The software one.");

    await engine.resumeItem(chat);
    await ticks(engine, 3);

    expect(checkAuth).toHaveBeenCalled();
    expect(providerCalls).toEqual([]);
    expect(escalations(chat).map((comment) => comment.body)).toEqual([REASON]);
    const runs = listRunsForItem(handle.db, chat);
    expect(runs.filter((run) => run.status === "failed")).toEqual([]);
    expect(runs.filter((run) => run.status !== "awaiting_input")).toEqual([]);
    expect(runs.find((run) => run.id !== parked.id)).toMatchObject({ status: "awaiting_input", initiationId: reply.id, error: REASON });
    expect(listCommentsForItem(handle.db, chat).map((comment) => comment.body).join("\n")).not.toMatch(/Attempt \d+ stopped/);
  });
});
