import { pageDescriptorFor, type AgentEvent, type AgentProvider, type AgentProviderResumeOptions, type AgentProviderStartOptions, type InterruptibleStream, type Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { getRun, listCommentsForItem, listRunEvents, listRunsForItem } from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { sendToAssist, updateAssistSettings } from "../ipc/assistCommands.js";
import { validImplementResult } from "../providers/fixtures.js";
import { createRunSupervisor } from "./runSupervisor.js";
import { createSuggestedReplies, type SuggestedReply } from "./suggestedReplies.js";

/**
 * A suggested reply in the assistant's chat (EO-809): asked for by the
 * system agent's chat turns alone, read past the turn's `result` without
 * holding the run, shown and never stored.
 */
const LIMITS = { globalConcurrency: 1, perAgentConcurrency: 1, perRepositoryConcurrency: 1 };
const ANSWER = { outcome: { message: "Filed it as a draft.", questions: [], proposals: [] } };

let handle: DbHandle;
beforeEach(() => {
  handle = openMigratedTestDb();
});
afterEach(() => {
  handle.close();
});

/** A gate a test opens when it wants the backend's suggestion to arrive. */
function gate() {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

/**
 * A backend that answers each turn at once, then — where it was asked —
 * sends a suggestion once `later` opens, as Claude does after `result`.
 * Records what each turn was opened with, and whether its stream was
 * aborted or let go.
 */
function backend(options: { result?: unknown; suggestion?: string | null; later?: Promise<void> } = {}) {
  const starts: AgentProviderStartOptions[] = [];
  const resumes: (AgentProviderResumeOptions | undefined)[] = [];
  const ended: string[] = [];
  const turn = (opts: { signal?: AbortSignal | undefined; suggestNextMessage?: boolean | undefined } | undefined): InterruptibleStream<AgentEvent> =>
    (async function* (): AsyncGenerator<AgentEvent> {
      try {
        yield { type: "thread_started", threadId: "thr-1" };
        yield { type: "result", data: options.result ?? ANSWER };
        if (opts?.suggestNextMessage !== true || options.suggestion === null) return;
        const aborted = new Promise<"aborted">((resolve) => opts.signal?.addEventListener("abort", () => resolve("aborted"), { once: true }));
        if ((await Promise.race([options.later ?? Promise.resolve(), aborted])) === "aborted") {
          ended.push("aborted");
          return;
        }
        yield { type: "prompt_suggestion", text: options.suggestion ?? "publish it", threadId: "thr-1" };
      } finally {
        ended.push("ended");
      }
    })();
  const provider: AgentProvider = {
    start(opts) {
      starts.push(opts);
      return turn(opts);
    },
    resume(_threadId, _message, opts) {
      resumes.push(opts);
      return turn(opts);
    },
  };
  return { provider, starts, resumes, ended };
}

async function chat(body = "Draft a release pipeline.") {
  return (await sendToAssist(handle.db, undefined, { page: pageDescriptorFor("/chat"), conversationId: null, body, attachmentIds: [], interrupt: false })).conversation;
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(check()).toBe(true);
}

describe("which runs ask for a suggested reply", () => {
  it("a turn of the system agent's chat asks while \"Suggested replies\" is on, which it is by default", async () => {
    const { provider, starts } = backend();
    const supervisor = createRunSupervisor({ db: handle.db, limits: LIMITS, provider });
    await chat();
    await supervisor.runOnce();
    await supervisor.waitForIdle();
    expect(starts).toHaveLength(1);
    expect(starts[0]!.suggestNextMessage).toBe(true);
  });

  it("does not ask once it is turned off", async () => {
    const { provider, starts } = backend();
    const supervisor = createRunSupervisor({ db: handle.db, limits: LIMITS, provider });
    const conversation = await chat();
    updateAssistSettings(handle.db, { conversationId: conversation.id, suggestReplies: false });
    await supervisor.runOnce();
    await supervisor.waitForIdle();
    expect(starts).toHaveLength(1);
    expect(starts[0]).not.toHaveProperty("suggestNextMessage");
  });

  it("an item's run on a pipeline step never asks", async () => {
    const { provider, starts } = backend({ result: validImplementResult });
    createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo" });
    const supervisor = createRunSupervisor({ db: handle.db, limits: LIMITS, provider });
    await supervisor.runOnce();
    await supervisor.waitForIdle();
    expect(starts.length).toBeGreaterThan(0);
    for (const opts of starts) expect(opts).not.toHaveProperty("suggestNextMessage");
  });
});

describe("a suggestion that arrives after the turn", () => {
  it("reaches the chat after the run has ended, and is never a run event or a comment", async () => {
    const later = gate();
    const { provider } = backend({ suggestion: "publish it", later: later.opened });
    const replies: SuggestedReply[] = [];
    const supervisor = createRunSupervisor({ db: handle.db, limits: LIMITS, provider, onSuggestedReply: (reply) => replies.push(reply) });
    const conversation = await chat();
    await supervisor.runOnce();
    await supervisor.waitForIdle();

    // The run ended at its result, with the suggestion still to come.
    const [run] = listRunsForItem(handle.db, conversation.id as Uuid);
    expect(getRun(handle.db, run!.id)?.status).toBe("succeeded");
    expect(replies).toEqual([]);

    later.open();
    await until(() => replies.length === 1);
    expect(replies[0]).toEqual({ conversationId: conversation.id, runId: run!.id, text: "publish it" });

    expect(listRunEvents(handle.db, run!.id).map((event) => event.type)).not.toContain("prompt_suggestion");
    expect(listCommentsForItem(handle.db, conversation.id as Uuid).some((comment) => comment.body.includes("publish it"))).toBe(false);
  });

  it("is dropped, and its making stopped, once the person says something in the chat", async () => {
    const later = gate();
    const { provider, ended } = backend({ later: later.opened });
    const replies: SuggestedReply[] = [];
    const supervisor = createRunSupervisor({ db: handle.db, limits: LIMITS, provider, onSuggestedReply: (reply) => replies.push(reply) });
    const conversation = await chat();
    await supervisor.runOnce();
    await supervisor.waitForIdle();

    supervisor.dropSuggestedReply(conversation.id as Uuid);
    await until(() => ended.includes("aborted"));
    later.open();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(replies).toEqual([]);
  });

  it("is dropped when a newer turn starts in the chat before it arrives", async () => {
    const later = gate();
    const { provider, ended } = backend({ later: later.opened });
    const replies: SuggestedReply[] = [];
    const supervisor = createRunSupervisor({ db: handle.db, limits: LIMITS, provider, onSuggestedReply: (reply) => replies.push(reply) });
    const conversation = await chat();
    await supervisor.runOnce();
    await supervisor.waitForIdle();

    await sendToAssist(handle.db, undefined, { page: pageDescriptorFor("/chat"), conversationId: conversation.id, body: "And the next one?", attachmentIds: [], interrupt: false });
    // The person's message alone does not reach the supervisor here (the
    // engine's comment hook does that): the newer turn starting does.
    await supervisor.runOnce();
    await supervisor.waitForIdle();
    await until(() => ended.includes("aborted"));

    // Only the newer turn's suggestion is passed on, once it comes.
    later.open();
    await until(() => replies.length === 1);
    const runs = listRunsForItem(handle.db, conversation.id as Uuid);
    expect(runs).toHaveLength(2);
    // Oldest first, by their UUIDv7 ids.
    const newest = runs.at(-1)!;
    expect(replies.map((reply) => reply.runId)).toEqual([newest.id]);
  });
});

describe("reading a turn's stream past its result", () => {
  /** A stream that yields a result, then waits on `later` before its suggestion; records being let go. */
  function stream(later: Promise<void>, signal: AbortSignal | undefined) {
    const log: string[] = [];
    const events = (async function* (): AsyncGenerator<AgentEvent> {
      try {
        yield { type: "result", data: {} };
        await Promise.race([later, new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }))]);
        if (signal?.aborted) return;
        yield { type: "heartbeat" };
        yield { type: "prompt_suggestion", text: "  yes  ", threadId: "t" };
        yield { type: "output", text: "never read" };
      } finally {
        log.push("ended");
      }
    })();
    return { events, log };
  }

  function provider(later: Promise<void>, made: { log: string[] }[]): AgentProvider {
    const open = (opts?: { signal?: AbortSignal | undefined }) => {
      const made_ = stream(later, opts?.signal);
      made.push(made_);
      return made_.events;
    };
    return { start: (opts) => open(opts), resume: (_t, _m, opts) => open(opts) };
  }

  it("leaves a turn that asked for none exactly as it was", async () => {
    const replies = createSuggestedReplies({ onSuggestion: () => undefined });
    const made: { log: string[] }[] = [];
    const turn = replies.wrap(provider(Promise.resolve(), made), "chat", "run").start({ cwd: "/", context: "" } as AgentProviderStartOptions);
    expect(replies.reading(turn).stream).toBe(turn);
  });

  it("does not end the turn when the run lets go, and passes the suggestion on trimmed", async () => {
    const got: SuggestedReply[] = [];
    const replies = createSuggestedReplies({ onSuggestion: (reply) => got.push(reply) });
    const made: { log: string[] }[] = [];
    const later = gate();
    const turn = replies.wrap(provider(later.opened, made), "chat", "run-1").start({ cwd: "/", context: "", suggestNextMessage: true } as AgentProviderStartOptions);
    const reading = replies.reading(turn);
    const iterator = reading.stream[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ type: "result" });
    reading.afterResult();
    await iterator.return?.(undefined);
    expect(made[0]!.log).toEqual([]);

    later.open();
    await until(() => got.length === 1);
    expect(got).toEqual([{ conversationId: "chat", runId: "run-1", text: "yes" }]);
    await until(() => made[0]!.log.includes("ended"));
  });

  it("gives up once the wait runs out, and ends the turn", async () => {
    const got: SuggestedReply[] = [];
    const replies = createSuggestedReplies({ onSuggestion: (reply) => got.push(reply), waitMs: 10 });
    const made: { log: string[] }[] = [];
    const turn = replies.wrap(provider(new Promise(() => undefined), made), "chat", "run-1").start({ cwd: "/", context: "", suggestNextMessage: true } as AgentProviderStartOptions);
    const reading = replies.reading(turn);
    const iterator = reading.stream[Symbol.asyncIterator]();
    await iterator.next();
    reading.afterResult();
    await until(() => made[0]!.log.includes("ended"));
    expect(got).toEqual([]);
  });

  it("stops the last turn's when a newer turn on the same chat opens, and not another chat's", async () => {
    const got: SuggestedReply[] = [];
    const replies = createSuggestedReplies({ onSuggestion: (reply) => got.push(reply) });
    const made: { log: string[] }[] = [];
    const later = gate();
    const backend_ = provider(later.opened, made);
    for (const [conversation, run] of [
      ["chat", "run-1"],
      ["other", "run-2"],
    ] as const) {
      const turn = replies.wrap(backend_, conversation, run).start({ cwd: "/", context: "", suggestNextMessage: true } as AgentProviderStartOptions);
      const reading = replies.reading(turn);
      await reading.stream[Symbol.asyncIterator]().next();
      reading.afterResult();
    }
    // A newer turn in "chat", asking for nothing itself.
    replies.wrap(backend_, "chat", "run-3").resume("t", "next", {});
    await until(() => made[0]!.log.includes("ended"));
    later.open();
    await until(() => got.length === 1);
    expect(got).toEqual([{ conversationId: "other", runId: "run-2", text: "yes" }]);
  });
});
