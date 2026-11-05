import { pageDescriptorFor, type AgentPrewarmTurn, type AgentProvider, type AgentProviderStartOptions, type Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { createRun, listAgents } from "../db/repos/index.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { sendToAssist } from "../ipc/assistCommands.js";
import { ASSIST_ACTION } from "../roles/conversationSteps.js";
import { createRunSupervisor } from "./runSupervisor.js";

/**
 * Starting the backend while a person types (`prewarmConversation`): the
 * warm-up has to be asked for the very turn the dispatch then starts, or
 * the provider can never adopt it.
 */
const LIMITS = { globalConcurrency: 1, perAgentConcurrency: 1, perRepositoryConcurrency: 1 };

let handle: DbHandle;
beforeEach(() => {
  handle = openMigratedTestDb();
});
afterEach(() => {
  handle.close();
});

/** A provider that records what it is asked and answers every turn at once. */
function recording() {
  const prewarms: AgentPrewarmTurn[] = [];
  const starts: AgentProviderStartOptions[] = [];
  const drops: number[] = [];
  const provider: AgentProvider = {
    start(opts) {
      starts.push(opts);
      return (async function* () {
        yield { type: "thread_started" as const, threadId: "thr-1" };
        yield { type: "result" as const, data: { outcome: { message: "Hi.", questions: [], proposals: [] } } };
      })();
    },
    resume() {
      return (async function* () {})();
    },
    prewarm(turn) {
      prewarms.push(turn);
    },
    dropWarm() {
      drops.push(Date.now());
    },
  };
  return { provider, prewarms, starts, drops };
}

const systemAgentId = () => listAgents(handle.db).find((agent) => agent.role === "system")!.id as Uuid;

describe("warming the backend for the turn being typed", () => {
  it("asks the provider for exactly the turn the dispatch then starts", async () => {
    const { provider, prewarms, starts } = recording();
    const supervisor = createRunSupervisor({ db: handle.db, limits: LIMITS, provider });
    // A chat with a message in it, so there is a conversation to warm for.
    const chat = (await sendToAssist(handle.db, undefined, { page: pageDescriptorFor("/chat"), conversationId: null, body: "What is waiting?", attachmentIds: [], interrupt: false })).conversation;

    expect(await supervisor.prewarmConversation(chat.id as Uuid, systemAgentId())).toBe(true);
    await supervisor.runOnce();

    expect(prewarms).toHaveLength(1);
    expect(starts).toHaveLength(1);
    const { kind, instructions, ...warmed } = prewarms[0] as Extract<AgentPrewarmTurn, { kind: "start" }>;
    expect(kind).toBe("start");
    const { context, signal, instructions: started, attachments, ...dispatched } = starts[0]!;
    void context;
    void signal;
    void attachments;
    expect(instructions).toBe(started);
    expect(warmed).toEqual(dispatched);
    expect(warmed.warmKey).toEqual(expect.any(String));
  });

  it("warms nothing while a turn is running, off a conversation, or for a provider that cannot", async () => {
    const { provider, prewarms } = recording();
    const supervisor = createRunSupervisor({ db: handle.db, limits: LIMITS, provider });
    const chat = (await sendToAssist(handle.db, undefined, { page: pageDescriptorFor("/chat"), conversationId: null, body: "Hello", attachmentIds: [], interrupt: false })).conversation;
    createRun(handle.db, { itemId: chat.id as Uuid, agentId: systemAgentId(), action: ASSIST_ACTION, status: "running" });
    expect(await supervisor.prewarmConversation(chat.id as Uuid, systemAgentId())).toBe(false);
    expect(await supervisor.prewarmConversation("not-an-item" as Uuid, systemAgentId())).toBe(false);

    const bare = createRunSupervisor({ db: handle.db, limits: LIMITS, provider: { start: provider.start, resume: provider.resume } });
    const other = (await sendToAssist(handle.db, undefined, { page: pageDescriptorFor("/chat"), conversationId: null, body: "Again", attachmentIds: [], interrupt: false })).conversation;
    expect(await bare.prewarmConversation(other.id as Uuid, systemAgentId())).toBe(false);
    expect(prewarms).toEqual([]);
  });
});

describe("letting a warm backend go", () => {
  it("on a quit, and not on a pause, which the system agent's chats carry on through (EO-615)", async () => {
    const { provider, drops, prewarms } = recording();
    const supervisor = createRunSupervisor({ db: handle.db, limits: LIMITS, provider });
    const chat = (await sendToAssist(handle.db, undefined, { page: pageDescriptorFor("/chat"), conversationId: null, body: "Hello", attachmentIds: [], interrupt: false })).conversation;
    expect(await supervisor.prewarmConversation(chat.id as Uuid, systemAgentId())).toBe(true);
    supervisor.pause();
    expect(drops).toHaveLength(0);
    // And a chat is warmed while paused as it is any other time.
    expect(await supervisor.prewarmConversation(chat.id as Uuid, systemAgentId())).toBe(true);
    expect(prewarms).toHaveLength(2);
    await supervisor.shutdown();
    expect(drops).toHaveLength(1);
  });

  it("on a pause, for anybody else, and on a close, for the system agent too", async () => {
    const { provider, drops, prewarms } = recording();
    const supervisor = createRunSupervisor({ db: handle.db, limits: LIMITS, provider });
    const chat = (await sendToAssist(handle.db, undefined, { page: pageDescriptorFor("/chat"), conversationId: null, body: "Hello", attachmentIds: [], interrupt: false })).conversation;
    const implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!.id as Uuid;

    expect(await supervisor.prewarmConversation(chat.id as Uuid, implementer)).toBe(true);
    supervisor.pause();
    expect(drops).toHaveLength(1);
    expect(await supervisor.prewarmConversation(chat.id as Uuid, implementer)).toBe(false);

    expect(await supervisor.prewarmConversation(chat.id as Uuid, systemAgentId())).toBe(true);
    supervisor.beginClose();
    expect(drops).toHaveLength(2);
    expect(await supervisor.prewarmConversation(chat.id as Uuid, systemAgentId())).toBe(false);
    expect(prewarms).toHaveLength(2);
  });

  it("warms nothing while a dispatch holds the item", async () => {
    const { provider, prewarms } = recording();
    const supervisor = createRunSupervisor({ db: handle.db, limits: LIMITS, provider });
    const chat = (await sendToAssist(handle.db, undefined, { page: pageDescriptorFor("/chat"), conversationId: null, body: "Hello", attachmentIds: [], interrupt: false })).conversation;
    const hold = supervisor.itemLock.acquire(chat.id);
    expect(await supervisor.prewarmConversation(chat.id as Uuid, systemAgentId())).toBe(false);
    hold?.();
    expect(prewarms).toEqual([]);
  });
});
