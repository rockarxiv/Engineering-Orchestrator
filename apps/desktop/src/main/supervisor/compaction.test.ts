import type { AgentEvent, AgentProvider, InterruptibleStream, Item } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listAgents } from "../db/repos/agentsRepo.js";
import { postComment } from "../db/repos/commentsRepo.js";
import { listRunsForItem } from "../db/repos/runsRepo.js";
import { listRunEvents } from "../db/repos/runEventsRepo.js";
import type { DbHandle } from "../db/client.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { createFakeProvider } from "../providers/fake.js";
import { validImplementResult } from "../providers/fixtures.js";
import { createRunSupervisor } from "./runSupervisor.js";

const LIMITS = { globalConcurrency: 1, perAgentConcurrency: 1, perRepositoryConcurrency: 1 };

/** A turn that is compacted part-way, and can be spoken to, as both backends' turns can. */
function compactedTurn(result: unknown, takesMessages = true): { start: AgentProvider["start"]; resume: AgentProvider["resume"]; steer: ReturnType<typeof vi.fn> } {
  const steer = vi.fn(async () => takesMessages);
  const events: AgentEvent[] = [
    { type: "thread_started", threadId: "the-long-thread" },
    { type: "output", text: "Reading the module." },
    { type: "compacted", trigger: "auto", tokensBefore: 180_000 },
    { type: "output", text: "Carrying on." },
    { type: "result", data: result },
  ];
  const turn = (): InterruptibleStream<AgentEvent> => {
    const iterator = (async function* () {
      for (const event of events) yield event;
    })();
    return { [Symbol.asyncIterator]: () => iterator, steer };
  };
  return { start: () => turn(), resume: () => turn(), steer };
}

/**
 * After the backend compacts a conversation, the brief the run was seeded
 * with is a summary of itself; EO restates it into the turn, and records
 * that it did (`CompactedEvent`).
 */
describe("a run whose conversation is compacted", () => {
  let handle: DbHandle;
  let item: Item;

  beforeEach(() => {
    handle = openMigratedTestDb();
    item = createTestItem(handle.db, {
      type: "story",
      title: "Rate-limit the export endpoint",
      stepId: "todo",
      spec: { acceptance_criteria: ["Returns 429 after 100 requests in a minute."] },
    });
  });

  afterEach(() => {
    handle.close();
  });

  it("is told what it is working on again, and the transcript says so", async () => {
    const { start, resume, steer } = compactedTurn(validImplementResult);
    const supervisor = createRunSupervisor({ db: handle.db, provider: { ...createFakeProvider({ result: validImplementResult }), start, resume }, limits: LIMITS });

    await supervisor.runOnce();
    await supervisor.waitForIdle();

    expect(steer).toHaveBeenCalledOnce();
    const said = steer.mock.calls[0]?.[0] as string;
    expect(said).toContain("From EO, not from a person");
    expect(said).toContain("compacted");
    expect(said).toContain(item.key);
    expect(said).toContain("Rate-limit the export endpoint");
    expect(said).toContain("Returns 429 after 100 requests in a minute.");
    const stored = listRunEvents(handle.db, listRunsForItem(handle.db, item.id)[0]!.id).map((event) => event.type);
    expect(stored).toEqual(expect.arrayContaining(["compacted", "reminder"]));
    expect(stored.indexOf("reminder")).toBe(stored.indexOf("compacted") + 1);
    const reminder = listRunEvents(handle.db, listRunsForItem(handle.db, item.id)[0]!.id).find((event) => event.type === "reminder");
    expect(reminder?.payload).toMatchObject({ delivered: true });
  });

  it("does not wait on the reminder before reading the rest of the turn, which is what answers it on Codex", async () => {
    // A steer answered over the same stream the turn arrives on: it
    // settles only once the turn has moved past the compaction.
    let answer!: (taken: boolean) => void;
    const steer = vi.fn(() => new Promise<boolean>((resolve) => (answer = resolve)));
    const turn = (): InterruptibleStream<AgentEvent> => {
      const iterator = (async function* (): AsyncGenerator<AgentEvent> {
        yield { type: "thread_started", threadId: "the-long-thread" };
        yield { type: "compacted" };
        yield { type: "output", text: "Carrying on." };
        answer(true);
        yield { type: "result", data: validImplementResult };
      })();
      return { [Symbol.asyncIterator]: () => iterator, steer };
    };
    const supervisor = createRunSupervisor({ db: handle.db, provider: { ...createFakeProvider({ result: validImplementResult }), start: () => turn(), resume: () => turn() }, limits: LIMITS });

    await supervisor.runOnce();
    await supervisor.waitForIdle();

    const run = listRunsForItem(handle.db, item.id)[0]!;
    expect(run.status).toBe("succeeded");
    expect(listRunEvents(handle.db, run.id).find((event) => event.type === "reminder")?.payload).toMatchObject({ delivered: true });
  });

  it("restates the brief once per stretch of work, not after every compaction of a window that keeps filling", async () => {
    const steer = vi.fn(async () => true);
    const turn = (): InterruptibleStream<AgentEvent> => {
      const iterator = (async function* (): AsyncGenerator<AgentEvent> {
        yield { type: "thread_started", threadId: "the-full-thread" };
        yield { type: "compacted" };
        yield { type: "output", text: "Noted." };
        // Compacted again before doing anything: no second reminder.
        yield { type: "compacted" };
        yield { type: "output", text: "Still noted." };
        // Work, then compacted again: that one is reminded.
        yield { type: "tool_call", name: "Bash", args: { command: "pnpm test" }, callId: "call-1" };
        yield { type: "tool_result", name: "Bash", callId: "call-1", ok: true, output: "ok", truncated: false };
        yield { type: "compacted" };
        yield { type: "result", data: validImplementResult };
      })();
      return { [Symbol.asyncIterator]: () => iterator, steer };
    };
    const supervisor = createRunSupervisor({ db: handle.db, provider: { ...createFakeProvider({ result: validImplementResult }), start: () => turn(), resume: () => turn() }, limits: LIMITS });

    await supervisor.runOnce();
    await supervisor.waitForIdle();

    expect(steer).toHaveBeenCalledTimes(2);
    const stored = listRunEvents(handle.db, listRunsForItem(handle.db, item.id)[0]!.id).map((event) => event.type);
    expect(stored.filter((type) => type === "compacted")).toHaveLength(3);
    expect(stored.filter((type) => type === "reminder")).toHaveLength(2);
  });

  it("records a reminder the turn would not take as not delivered, rather than as said", async () => {
    const { start, resume } = compactedTurn(validImplementResult, false);
    const supervisor = createRunSupervisor({ db: handle.db, provider: { ...createFakeProvider({ result: validImplementResult }), start, resume }, limits: LIMITS });

    await supervisor.runOnce();
    await supervisor.waitForIdle();

    const reminder = listRunEvents(handle.db, listRunsForItem(handle.db, item.id)[0]!.id).find((event) => event.type === "reminder");
    expect(reminder?.payload).toMatchObject({ delivered: false });
  });

  it("leaves a conversation as it is: it is its own brief", async () => {
    const { start, resume } = compactedTurn({ message: "Answered." });
    const reviewer = listAgents(handle.db).find((agent) => agent.role === "reviewer")!;
    const asked = createTestItem(handle.db, { type: "feature", title: "A question", stepId: "ready_to_merge" });
    postComment(handle.db, { itemId: asked.id, author: { type: "human" }, body: "@reviewer what changed?", mentions: [{ type: "agent", agentId: reviewer.id }] });
    const supervisor = createRunSupervisor({ db: handle.db, provider: { ...createFakeProvider({ result: { message: "Answered." } }), start, resume }, limits: LIMITS });

    await supervisor.runOnce();
    await supervisor.waitForIdle();

    const reply = listRunsForItem(handle.db, asked.id).find((run) => run.action === "respond");
    expect(reply).toBeDefined();
    // Per run: the story's own implement run, on the same provider, is
    // reminded as it should be; the reply is not.
    const stored = listRunEvents(handle.db, reply!.id).map((event) => event.type);
    expect(stored).toContain("compacted");
    expect(stored).not.toContain("reminder");
  });
});
