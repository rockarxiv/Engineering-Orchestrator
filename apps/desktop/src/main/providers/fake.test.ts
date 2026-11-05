import { describe, expect, it } from "vitest";
import type { AgentEvent, AgentWriteAnswer, AgentWriteRequest } from "@eo/core";
import { startAgentWriteBridge } from "../mcp/writeBridge.js";
import { createFakeProvider } from "./fake.js";
import {
  blockingEscalationFixture,
  crashMidStreamFixture,
  hangsPastTimeoutFixture,
  happyPathFixture,
  malformedResultFixture,
} from "./fixtures.js";

async function collect(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("createFakeProvider — happy path", () => {
  it("drives a full pipeline: thread_started, output, usage, result — zero API calls or cost", async () => {
    const provider = createFakeProvider(happyPathFixture);
    const controller = new AbortController();

    const events = await collect(
      provider.start({ instructions: "implement it", context: "", cwd: "/tmp", signal: controller.signal }),
    );

    expect(events[0]).toEqual({ type: "thread_started", threadId: expect.stringMatching(/^fake-thread-/) });
    expect(events.some((e) => e.type === "output")).toBe(true);
    expect(events.some((e) => e.type === "file_edit")).toBe(true);
    expect(events.at(-2)).toMatchObject({ type: "usage", costCents: 3 });
    expect(events.at(-1)).toEqual({ type: "result", data: happyPathFixture.result });
  });
});

describe("createFakeProvider — failure modes are all scriptable", () => {
  it("emits a blocking escalation comment tool call", async () => {
    const provider = createFakeProvider(blockingEscalationFixture);
    const controller = new AbortController();
    const events = await collect(
      provider.start({ instructions: "", context: "", cwd: "/tmp", signal: controller.signal }),
    );

    const toolCall = events.find((e) => e.type === "tool_call");
    expect(toolCall).toMatchObject({
      type: "tool_call",
      name: "comment",
      args: { mentions: ["user"], blocking: true },
    });
    // A blocking escalation does not produce a result — the run ends awaiting a reply.
    expect(events.some((e) => e.type === "result")).toBe(false);
  });

  it("returns malformed output verbatim — validation is the caller's job, not the provider's", async () => {
    const provider = createFakeProvider(malformedResultFixture);
    const controller = new AbortController();
    const events = await collect(
      provider.start({ instructions: "", context: "", cwd: "/tmp", signal: controller.signal }),
    );

    const result = events.find((e) => e.type === "result");
    expect(result).toEqual({ type: "result", data: { thisFieldDoesNotExist: true } });
  });

  it("throws mid-stream rather than completing", async () => {
    const provider = createFakeProvider(crashMidStreamFixture);
    const controller = new AbortController();

    await expect(
      collect(provider.start({ instructions: "", context: "", cwd: "/tmp", signal: controller.signal })),
    ).rejects.toThrow("simulated provider crash");
  });

  it("hangs past a caller-enforced timeout — never yields a result", async () => {
    const provider = createFakeProvider(hangsPastTimeoutFixture);
    const controller = new AbortController();
    const iterator = provider.start({ instructions: "", context: "", cwd: "/tmp", signal: controller.signal })[
      Symbol.asyncIterator
    ]();
    await iterator.next(); // thread_started — resolves immediately, doesn't touch the scripted sleep

    const raceResult = await Promise.race([
      iterator.next().then(() => "resolved" as const),
      new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 50)),
    ]);

    expect(raceResult).toBe("timed-out");
    controller.abort(); // avoid leaking the 24h timer past the test
  });
});

describe("createFakeProvider — cancellation", () => {
  it("stops the stream promptly on abort, even mid-sleep", async () => {
    const provider = createFakeProvider({ steps: [{ sleepMs: 2000, output: "should never arrive" }] });
    const controller = new AbortController();

    const started = Date.now();
    const promise = collect(
      provider.start({ instructions: "", context: "", cwd: "/tmp", signal: controller.signal }),
    );
    setTimeout(() => controller.abort(), 20);

    await expect(promise).rejects.toThrow(/abort/i);
    expect(Date.now() - started).toBeLessThan(500); // well under the scripted 2000ms sleep
  });
});

describe("createFakeProvider — resume", () => {
  it("continues a scripted thread from where it left off, rather than restarting", async () => {
    const provider = createFakeProvider({
      steps: [{ output: "step 0" }, { output: "step 1" }, { output: "step 2" }],
      result: { done: true },
    });
    const controller = new AbortController();

    const iterator = provider.start({ instructions: "", context: "", cwd: "/tmp", signal: controller.signal })[
      Symbol.asyncIterator
    ]();

    const threadStarted = await iterator.next();
    expect(threadStarted.value).toMatchObject({ type: "thread_started" });
    const threadId = (threadStarted.value as { threadId: string }).threadId;

    const firstStepOutput = await iterator.next();
    expect(firstStepOutput.value).toEqual({ type: "output", text: "step 0" });

    // Simulate a crash/interrupt here — abandon the iterator before it
    // reaches step 1.
    const resumed = await collect(provider.resume(threadId, "continue"));

    expect(resumed.filter((e) => e.type === "output")).toEqual([
      { type: "output", text: "step 1" },
      { type: "output", text: "step 2" },
    ]);
    expect(resumed.at(-1)).toEqual({ type: "result", data: { done: true } });
  });
});

/**
 * A scripted call to one of the `eo` server's write tools is made the way
 * a real turn makes it: handed to EO over the turn's bridge, and answered
 * with what EO said (EO-543). How that answer comes back is the backend's
 * — its text, as Codex returns it, or its structuredContent, as Claude
 * Code does — and the fake can be either.
 */
describe("createFakeProvider — writes through EO", () => {
  const WRITES: { tool: AgentWriteRequest["tool"]; args: Record<string, unknown> }[] = [
    { tool: "comment", args: { body: "fyi" } },
    { tool: "attachment_add", args: { paths: ["shot.png"] } },
    { tool: "memory_note", args: { scope: "project", text: "A fact." } },
  ];

  async function turnAgainst(answer: AgentWriteAnswer, toolResults?: "text" | "structured") {
    const asked: { itemId: string; request: AgentWriteRequest }[] = [];
    const bridge = await startAgentWriteBridge(async (itemId, request) => {
      asked.push({ itemId, request });
      return answer;
    });
    try {
      const provider = createFakeProvider({ steps: WRITES.map(({ tool, args }) => ({ toolCall: { name: tool, args } })), ...(toolResults ? { toolResults } : {}) });
      const events = await collect(provider.start({ instructions: "", context: "", cwd: "/tmp", signal: new AbortController().signal, writeBridge: bridge.tokenFor("item-1") }));
      return { asked, events };
    } finally {
      await bridge.close();
    }
  }

  const NOTED: AgentWriteAnswer = { ok: true, text: "EO did it.", data: { id: "w-1" } };

  it("hands each write to EO and records the call and EO's answer, as its text by default", async () => {
    const { asked, events } = await turnAgainst(NOTED);

    expect(asked).toEqual(WRITES.map(({ tool, args }) => ({ itemId: "item-1", request: { tool, args } })));
    const results = events.filter((event) => event.type === "tool_result");
    expect(results.map((event) => event.type === "tool_result" && { name: event.name, ok: event.ok, output: event.output })).toEqual(
      WRITES.map(({ tool }) => ({ name: tool, ok: true, output: "EO did it." })),
    );
    // Each answer joined to its call.
    const calls = events.filter((event) => event.type === "tool_call");
    expect(calls.map((event) => event.type === "tool_call" && event.callId)).toEqual(results.map((event) => event.type === "tool_result" && event.callId));
  });

  it("returns the structuredContent instead, as Claude Code does — and the write is made just the same", async () => {
    const { asked, events } = await turnAgainst(NOTED, "structured");

    expect(asked).toHaveLength(WRITES.length);
    const outputs = events.flatMap((event) => (event.type === "tool_result" ? [JSON.parse(event.output) as unknown] : []));
    expect(outputs).toEqual(WRITES.map(() => ({ id: "w-1", text: "EO did it." })));
  });

  it("records a refusal as one, in either mode", async () => {
    const refused: AgentWriteAnswer = { ok: false, code: "WRITE_REFUSED", problem: "Not this time." };
    for (const mode of ["text", "structured"] as const) {
      const { events } = await turnAgainst(refused, mode);
      const results = events.filter((event) => event.type === "tool_result");
      expect(results.every((event) => event.type === "tool_result" && !event.ok && event.output.includes("Not this time."))).toBe(true);
    }
  });

  it("only says the call was made on a turn given nowhere to send it", async () => {
    const provider = createFakeProvider({ steps: [{ toolCall: { name: "comment", args: { body: "fyi" } } }] });
    const events = await collect(provider.start({ instructions: "", context: "", cwd: "/tmp", signal: new AbortController().signal }));
    expect(events.map((event) => event.type)).toEqual(["thread_started", "tool_call"]);
  });
});
