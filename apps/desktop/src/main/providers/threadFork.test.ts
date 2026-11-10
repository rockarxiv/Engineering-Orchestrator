import { ThreadNotFoundError, type AgentEvent, type InterruptibleStream } from "@eo/core";
import { describe, expect, it } from "vitest";
import { createScriptedProvider } from "./scripted.js";
import { openedFork } from "./threadFork.js";

function streamOf(events: AgentEvent[], thenThrow?: Error): InterruptibleStream<AgentEvent> {
  return (async function* () {
    yield* events;
    if (thenThrow) throw thenThrow;
  })();
}

async function collect(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("openedFork (EO-716)", () => {
  it("answers with the copy's id once the backend names it, and hands back the whole turn, what was read ahead included", async () => {
    const turn: AgentEvent[] = [{ type: "skills_delivered", slugs: ["a"] }, { type: "thread_started", threadId: "copy" }, { type: "output", text: "hi" }, { type: "result", data: "hi" }];
    const forked = await openedFork("original", streamOf(turn));
    if (!forked.ok) throw new Error(forked.message);
    expect(forked.threadId).toBe("copy");
    expect(await collect(forked.events)).toEqual(turn);
  });

  it("answers a missing thread as thread_not_found, naming it, rather than throwing", async () => {
    const forked = await openedFork("gone", streamOf([], new ThreadNotFoundError({ threadId: "gone", provider: "claude" })));
    expect(forked).toMatchObject({ ok: false, reason: "thread_not_found", threadId: "gone" });
  });

  it("answers any other refusal as failed, with the backend's words, rather than throwing", async () => {
    const forked = await openedFork("t-1", streamOf([], new Error("database is locked")));
    expect(forked).toMatchObject({ ok: false, reason: "failed", threadId: "t-1" });
    expect(forked.ok ? "" : forked.message).toContain("database is locked");
  });

  it("answers a turn that ends before it opens a thread as failed, with its last error", async () => {
    const forked = await openedFork("t-1", streamOf([{ type: "error", message: "refused", retryable: false }]));
    expect(forked).toEqual({ ok: false, reason: "failed", threadId: "t-1", message: "refused" });
  });
});

describe("the scripted provider's fork (EO-716)", () => {
  it("forks on the route that started the thread, and the copy is resumable on that route", async () => {
    const provider = createScriptedProvider([{ when: (context) => context.includes("EO-1"), script: { steps: [{ output: "one" }], result: "done" } }]);
    const opened = await collect(provider.start({ instructions: "", context: "EO-1", cwd: "/tmp", signal: new AbortController().signal }));
    const original = opened[0]?.type === "thread_started" ? opened[0].threadId : "";

    const forked = await provider.fork!(original, "review it");
    if (!forked.ok) throw new Error(forked.message);
    expect(forked.threadId).toMatch(/^r0:fake-thread-/);
    expect(forked.threadId).not.toBe(original);
    expect((await collect(forked.events))[0]).toEqual({ type: "thread_started", threadId: forked.threadId });

    expect(await provider.fork!("r9:nowhere", "review it")).toMatchObject({ ok: false, reason: "thread_not_found", threadId: "r9:nowhere" });
  });
});
