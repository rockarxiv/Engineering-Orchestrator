import {
  AGENT_WRITE_TOOLS,
  type AgentEvent,
  type AgentForkResult,
  type AgentProvider,
  type AgentProviderResumeOptions,
  type AgentProviderStartOptions,
  type AgentSideCallOptions,
  type AgentWriteBridgeAddress,
  type AgentWriteTool,
  type UsageEvent,
} from "@eo/core";
import { agentWriteToolResult, sendAgentWrite } from "../mcp/writeBridge.js";
import { toolResultEvent, toolResultText } from "./toolResult.js";

export interface FakeProviderStep {
  sleepMs?: number;
  /** Words as they are generated (`OutputDeltaEvent`), before the block they belong to. */
  delta?: { stream: "text" | "reasoning"; text: string };
  reasoning?: string;
  output?: string;
  /**
   * A tool call. `answer`, on any tool but the `eo` server's writes, is
   * what the tool said back: the call is given an id and answered with a
   * `tool_result`, as a real backend reports a read it made — which is
   * what EO reads a run's log for (a draft whose pipeline the turn read,
   * EO-534). Without it the call is said and never answered.
   */
  toolCall?: { name: string; args: unknown; answer?: string };
  fileEdit?: string;
}

export interface FakeProviderScript {
  steps?: FakeProviderStep[];
  /**
   * What the scripted run reports it consumed.
   *
   * `scope` defaults to a session total — the Claude shape — because a
   * script states a whole run's usage in one line rather than turn by
   * turn. A script that wants the Codex shape says `scope: "turn"` and
   * gets readings that add up.
   */
  usage?: Omit<UsageEvent, "type" | "scope"> & { scope?: UsageEvent["scope"] };
  /**
   * Script the Codex shape: a turn-level output schema, so every message
   * comes back marked `schemaConstrained` (EO-199).
   *
   * Whole-script rather than per-step because that is how the real thing
   * works — the schema goes to `runStreamed` for the turn, so it is all
   * of a turn's messages or none of them. A script that leaves this off
   * gets the Claude shape, where the schema constrains the answer alone
   * and a message in that shape is one the agent chose to write.
   */
  turnLevelSchema?: boolean;
  /**
   * How this backend hands a tool's answer back — to the agent, and to EO
   * as the `tool_result` it records (EO-543).
   *
   * A scripted call to one of the `eo` server's write tools — `comment`,
   * `attachment_add`, `memory_note` — is made the way a real turn makes
   * it: handed to EO over the turn's `writeBridge`, which writes and
   * answers. `text` (the default) passes the answer back as its text, as
   * Codex does; `structured` passes back the tool's `structuredContent`
   * instead, as Claude Code does — the shape that once left every write
   * on Claude told "done" and never made, while this fake, returning the
   * text, kept the suite green.
   */
  toolResults?: "text" | "structured";
  /** Set this to script "return malformed output" — the fake provider emits it verbatim, unvalidated. */
  result?: unknown;
  /** Set this to script "throw mid-stream" — thrown after steps/usage, instead of ever emitting a result. */
  throwMessage?: string;
  // Neither `result` nor `throwMessage` set: the stream ends after its
  // steps without ever emitting a result — scripts "hangs past the
  // timeout" when combined with a long final sleepMs and a short caller
  // timeout in the test driving it.
}

type Action =
  | { kind: "sleep"; ms: number }
  | { kind: "delta"; stream: "text" | "reasoning"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "output"; text: string }
  | { kind: "toolCall"; name: string; args: unknown; answer?: string }
  | { kind: "fileEdit"; path: string };

function flattenSteps(steps: FakeProviderStep[]): Action[] {
  const actions: Action[] = [];
  for (const step of steps) {
    if (step.sleepMs) actions.push({ kind: "sleep", ms: step.sleepMs });
    if (step.delta) actions.push({ kind: "delta", stream: step.delta.stream, text: step.delta.text });
    if (step.reasoning !== undefined) actions.push({ kind: "reasoning", text: step.reasoning });
    if (step.output !== undefined) actions.push({ kind: "output", text: step.output });
    if (step.toolCall) actions.push({ kind: "toolCall", name: step.toolCall.name, args: step.toolCall.args, ...(step.toolCall.answer === undefined ? {} : { answer: step.toolCall.answer }) });
    if (step.fileEdit) actions.push({ kind: "fileEdit", path: step.fileEdit });
  }
  return actions;
}

function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

function cancellableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(abortError());
      },
      { once: true },
    );
  });
}

const NEVER_ABORTS = new AbortController().signal;

function isWriteTool(name: string): name is AgentWriteTool {
  return (AGENT_WRITE_TOOLS as readonly string[]).includes(name);
}

/**
 * Scriptable via a fixture (see fixtures.ts): one instance replays one
 * script. Each start() gets a fresh thread; resume() continues that
 * thread's script from wherever it left off rather than restarting.
 *
 * Progress is tracked per action (a flattened step), and — this is the
 * subtlety — marked *before* yielding an event, not after: a generator
 * suspends exactly at `yield`, so code placed after it never runs unless
 * the consumer calls next() again. If the consumer receives an event and
 * then abandons the iterator (simulating a crash), marking progress
 * after the yield would never happen and resume() would replay that
 * event. A sleep action is the opposite case — nothing is yielded, so
 * progress only advances once the await actually completes; an abort
 * mid-sleep correctly leaves it to be retried on resume.
 */
export function createFakeProvider(script: FakeProviderScript): AgentProvider {
  const actions = flattenSteps(script.steps ?? []);
  const nextIndexByThread = new Map<string, number>();
  let threadCounter = 0;

  async function* runFrom(
    threadId: string,
    startIndex: number,
    signal: AbortSignal | undefined,
    writeBridge?: AgentWriteBridgeAddress,
  ): AsyncIterable<AgentEvent> {
    const effectiveSignal = signal ?? NEVER_ABORTS;

    for (let i = startIndex; i < actions.length; i++) {
      if (effectiveSignal.aborted) throw abortError();
      const action = actions[i]!;

      if (action.kind === "sleep") {
        await cancellableSleep(action.ms, effectiveSignal);
        nextIndexByThread.set(threadId, i + 1);
        continue;
      }

      nextIndexByThread.set(threadId, i + 1);
      if (action.kind === "output") {
        yield { type: "output", text: action.text, ...(script.turnLevelSchema ? { schemaConstrained: true } : {}) };
      } else if (action.kind === "delta") {
        yield { type: "output_delta", stream: action.stream, text: action.text };
      } else if (action.kind === "reasoning") {
        yield { type: "reasoning", text: action.text };
      } else if (action.kind === "toolCall") {
        if (writeBridge === undefined || !isWriteTool(action.name)) {
          if (action.answer === undefined || isWriteTool(action.name)) {
            yield { type: "tool_call", name: action.name, args: action.args };
            continue;
          }
          // A read, answered with what the script says it said.
          const callId = `${threadId}-call-${String(i)}`;
          yield { type: "tool_call", name: action.name, args: action.args, callId };
          yield toolResultEvent({ name: action.name, callId, ok: true, output: action.answer });
          continue;
        }
        // One of the `eo` server's write tools, on a turn that has
        // somewhere to send it: the call is said, made through EO, and
        // answered with what EO said — as a real backend running the
        // `eo` server would (EO-543).
        const callId = `${threadId}-call-${String(i)}`;
        yield { type: "tool_call", name: action.name, args: action.args, callId };
        const result = agentWriteToolResult(await sendAgentWrite(writeBridge, { tool: action.name, args: action.args }));
        yield toolResultEvent({
          name: action.name,
          callId,
          ok: result.isError !== true,
          output: script.toolResults === "structured" ? JSON.stringify(result.structuredContent) : toolResultText(result.content),
        });
      } else {
        yield { type: "file_edit", path: action.path };
      }
    }

    if (script.usage) {
      yield { type: "usage", scope: "session", ...script.usage };
    }
    if (script.throwMessage) {
      throw new Error(script.throwMessage);
    }
    if (script.result !== undefined) {
      yield { type: "result", data: script.result };
    }
  }

  return {
    async *start(opts: AgentProviderStartOptions): AsyncIterable<AgentEvent> {
      threadCounter += 1;
      const threadId = `fake-thread-${threadCounter}`;
      nextIndexByThread.set(threadId, 0);
      yield { type: "thread_started", threadId };
      yield* runFrom(threadId, 0, opts.signal, opts.writeBridge);
    },
    async *resume(threadId: string, _message: string, opts?: AgentProviderResumeOptions): AsyncIterable<AgentEvent> {
      const startIndex = nextIndexByThread.get(threadId) ?? 0;
      yield* runFrom(threadId, startIndex, opts?.signal, opts?.writeBridge);
    },
    // A fork is a new thread that carries on from where the forked one
    // got to (EO-716): its own progress, copied, so what it plays is
    // never played again by a resume of the original. A thread this
    // provider never started is refused, as a real backend refuses one.
    async fork(threadId: string, _message: string, opts?: AgentProviderResumeOptions): Promise<AgentForkResult> {
      const from = nextIndexByThread.get(threadId);
      if (from === undefined) return { ok: false, reason: "thread_not_found", threadId, message: `The fake provider has no thread "${threadId}" to fork.` };
      threadCounter += 1;
      const forkId = `fake-thread-${threadCounter}`;
      nextIndexByThread.set(forkId, from);
      async function* events(): AsyncIterable<AgentEvent> {
        yield { type: "thread_started", threadId: forkId };
        yield* runFrom(forkId, from!, opts?.signal, opts?.writeBridge);
      }
      return { ok: true, threadId: forkId, events: events() };
    },
    // A side call plays the whole script once, from the start, on a
    // thread nobody can resume (EO-477): no `thread_started`, because a
    // side call keeps none.
    async *sideCall(opts: AgentSideCallOptions): AsyncIterable<AgentEvent> {
      threadCounter += 1;
      const threadId = `fake-side-call-${threadCounter}`;
      try {
        yield* runFrom(threadId, 0, opts.signal);
      } finally {
        nextIndexByThread.delete(threadId);
      }
    },
  };
}
