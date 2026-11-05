import type { AgentEvent, AgentProvider, AgentWriteBridgeAddress, InterruptibleStream, Item } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { listRunEvents, listRunsForItem, sumCostCentsSince } from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { createCodexProvider } from "../providers/codex.js";
import { CodexClient } from "../providers/codexClient.js";
import { toolResultEvent } from "../providers/toolResult.js";
import { sendAgentWrite } from "../mcp/writeBridge.js";
import { startTestWriteBridge, type TestWriteBridge } from "../testing/agentWrites.js";
import { fakeAppServer, note } from "../testing/fakeCodexAppServer.js";
import { createRunSupervisor, type RunSupervisorOptions } from "./runSupervisor.js";

/**
 * What an escalated run costs (KAN-24).
 *
 * The Claude SDK reports a turn's tokens and cost only on its terminal
 * message. An escalation used to walk away from the stream before that,
 * so the run recorded a spend of nothing — while the design's daily budget
 * summed `cost_cents` and its own comment called the figures exact.
 *
 * The fix is to ask the backend to wind the turn up and then keep
 * draining, so what it says on the way out is still recorded. These
 * cases pin both halves: that the accounting arrives, and that a
 * provider which *cannot* be interrupted is still abandoned at once
 * rather than held open (invariant 9).
 */
const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };

let handle: DbHandle;
let item: Item;
let writes: TestWriteBridge;

const ESCALATION_ARGS = { body: "@user which way round should this go?", mentions: ["user"], blocking: true };

const ESCALATION: AgentEvent = { type: "tool_call", name: "comment", args: ESCALATION_ARGS, callId: "call-1" };

/** The turn's write bridge, which every turn here is given: a turn without one cannot escalate at all. */
function bridgeOf(opts: { writeBridge?: AgentWriteBridgeAddress } | undefined): AgentWriteBridgeAddress {
  if (opts?.writeBridge === undefined) throw new Error("the turn was given no agent write bridge, so its comment could not be made");
  return opts.writeBridge;
}

/**
 * The tail a real backend emits once its turn has been wound up.
 *
 * Taken from an actual interrupted run: usage, then an
 * `error_during_execution` result, then a throw. Cutting a turn short is
 * not graceful and the SDK says so — a fixture that ended politely was
 * why the first version of this fix looked correct and turned every
 * escalation into a failed run.
 */
const TAIL: AgentEvent[] = [
  { type: "usage", scope: "session", tokensIn: 4200, tokensOut: 1300, costCents: 17 },
  { type: "error", message: "Claude run ended: error_during_execution", retryable: true },
];

/**
 * A stream that escalates, and — if it can be interrupted — reports its
 * usage afterwards, exactly as the SDK does.
 *
 * The escalation is made as a real one is (EO-543): the call is said,
 * and the comment is handed to EO over the turn's write bridge while the
 * call is open — which is what ends the run, not the `tool_call` in the
 * stream. EO's answer comes back as the call's `tool_result`.
 *
 * `interruptible: false` models a provider with no way to cut a turn
 * short. Its tail is *also* scripted, so a test proving we do not wait
 * for it is proving something real: the events exist and we decline to
 * consume them.
 */
function escalatingStream(interruptible: boolean, writeBridge: AgentWriteBridgeAddress): { stream: InterruptibleStream<AgentEvent>; drained: () => number } {
  let interrupted = false;
  let consumed = 0;

  // Counted as each event is handed out rather than after the yield
  // resumes — a consumer that stops never resumes the generator, so
  // counting on the way back would always miss the last event it took.
  async function* events(): AsyncIterable<AgentEvent> {
    consumed += 1;
    yield { type: "thread_started", threadId: "t-1" };
    consumed += 1;
    yield ESCALATION;
    // Posting the comment ends the turn, and the supervisor interrupts it
    // while this call is still waiting for EO's answer.
    const answer = await sendAgentWrite(writeBridge, { tool: "comment", args: ESCALATION_ARGS });
    consumed += 1;
    yield toolResultEvent({ name: "comment", callId: "call-1", ok: answer.ok, output: answer.ok ? answer.text : answer.problem });
    // A real backend only says this once told to stop. Nothing here
    // waits, but the ordering is the point being modelled.
    if (!interrupted) return;
    for (const event of TAIL) {
      consumed += 1;
      yield event;
    }
    // And then it throws, which is what a real interrupted turn does.
    throw new Error("Claude Code returned an error result: [ede_diagnostic] result_type=user stop_reason=tool_use");
  }

  const iterator = events()[Symbol.asyncIterator]();
  const stream: InterruptibleStream<AgentEvent> = {
    [Symbol.asyncIterator]: () => iterator,
    ...(interruptible
      ? {
          interrupt: async () => {
            interrupted = true;
          },
        }
      : {}),
  };

  return { stream, drained: () => consumed };
}

/** A supervisor whose agents' writes reach it over the bridge, as a real `eo` server's do (EO-543). */
function writingSupervisor(options: Omit<RunSupervisorOptions, "agentWriteBridge">) {
  const supervisor = createRunSupervisor({ ...options, agentWriteBridge: writes.agentWriteBridge });
  writes.serve(supervisor);
  return supervisor;
}

/**
 * A supervisor over one escalating turn. The stream is built when the
 * turn opens, because the bridge address it posts to is the turn's own;
 * `drained` reads the stream that turn was handed.
 */
function supervisorOver(interruptible: boolean): { runOnce: () => Promise<void>; drained: () => number } {
  let drained: () => number = () => 0;
  const open = (opts: { writeBridge?: AgentWriteBridgeAddress } | undefined): InterruptibleStream<AgentEvent> => {
    const escalating = escalatingStream(interruptible, bridgeOf(opts));
    drained = escalating.drained;
    return escalating.stream;
  };
  const supervisor = writingSupervisor({
    db: handle.db,
    limits: LIMITS,
    provider: { start: (opts) => open(opts), resume: (_threadId, _message, opts) => open(opts) },
  });
  return { runOnce: () => supervisor.runOnce(), drained: () => drained() };
}

beforeEach(async () => {
  handle = openMigratedTestDb();
  item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo" });
  writes = await startTestWriteBridge();
});

afterEach(async () => {
  await writes.close();
  handle.close();
});

describe("a run that ends in a blocking escalation", () => {
  it("records what the turn cost, instead of nothing at all", async () => {
    await supervisorOver(true).runOnce();

    const run = listRunsForItem(handle.db, item.id)[0]!;
    expect(run.status).toBe("awaiting_input");
    expect(run.costCents).toBe(17);
    expect(run.tokensIn).toBe(4200);
    expect(run.tokensOut).toBe(1300);
  });

  it("counts towards the daily budget, which is the whole reason to record it", async () => {
    // The design's guard sums cost_cents. An escalation that records nothing is
    // an escalation the budget cannot see.
    await supervisorOver(true).runOnce();

    expect(sumCostCentsSince(handle.db, 0)).toBe(17);
  });

  it("still parks the item — draining is accounting, not a second chance", async () => {
    await supervisorOver(true).runOnce();

    const run = listRunsForItem(handle.db, item.id)[0]!;
    expect(run.status).toBe("awaiting_input");
    expect(run.endedAt).not.toBeNull();
  });

  it("treats the backend's parting throw as the end of a wind-down, not a failure", async () => {
    // The regression this exists to stop: letting that throw escape
    // turned a parked escalation into a failed run, and then into a
    // retry of the very work a human was already being asked about.
    await supervisorOver(true).runOnce();

    const runs = listRunsForItem(handle.db, item.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("awaiting_input");
    expect(runs[0]!.error).toBeNull();
  });

  it("ignores what the backend says on the way out, beyond the accounting", async () => {
    // The tail carries an error event. The run's fate was settled at
    // the escalation, and a parting message must not re-decide it.
    await supervisorOver(true).runOnce();

    expect(listRunsForItem(handle.db, item.id)[0]!.status).toBe("awaiting_input");
  });

  it("files the backend's parting error as a wind-down, not a failure", async () => {
    // KAN-26. Being cut short mid-turn is not graceful and the backend
    // says so — but a transcript that shows an error on every plan-mode
    // proposal cries wolf. The words are kept; only the classification
    // changes.
    await supervisorOver(true).runOnce();

    const run = listRunsForItem(handle.db, item.id)[0]!;
    const events = listRunEvents(handle.db, run.id);
    const types = events.map((event) => event.type);

    expect(types).toContain("wind_down");
    expect(types).not.toContain("error");
    // Nothing about what the backend said is lost.
    const windDown = events.find((event) => event.type === "wind_down")!;
    expect(JSON.stringify(windDown.payload)).toContain("error_during_execution");
  });

  it("still files a genuine mid-run error as an error", async () => {
    // The reclassification applies only to the tail after *we*
    // interrupted. Something going wrong before that is a failure and
    // has to keep looking like one.
    const iterator = (async function* () {
      yield { type: "thread_started", threadId: "t-1" } as AgentEvent;
      yield { type: "error", message: "the provider fell over", retryable: true } as AgentEvent;
    })()[Symbol.asyncIterator]();
    const stream: InterruptibleStream<AgentEvent> = { [Symbol.asyncIterator]: () => iterator, interrupt: async () => {} };

    await writingSupervisor({ db: handle.db, limits: LIMITS, provider: { start: () => stream, resume: () => stream } }).runOnce();

    const run = listRunsForItem(handle.db, item.id)[0]!;
    expect(run.status).toBe("failed");
    expect(listRunEvents(handle.db, run.id).map((event) => event.type)).toContain("error");
  });

  it("is abandoned at once when the provider cannot be interrupted", async () => {
    // Invariant 9: escalation ends the run. Draining a stream with no
    // way to cut the turn short would mean waiting for the agent to
    // finish on its own, holding a subprocess open for a run that has
    // already ended. Recording nothing is the lesser evil, and the only
    // honest one.
    const supervisor = supervisorOver(false);

    await supervisor.runOnce();

    const run = listRunsForItem(handle.db, item.id)[0]!;
    expect(run.status).toBe("awaiting_input");
    // The thread, the call and EO's answer to it — which was already on
    // its way when the comment ended the turn, and is waited for only so
    // the stream can be closed — and nothing of the tail.
    expect(supervisor.drained(), "stopped at the escalation rather than reading on").toBe(3);
  });
});

/**
 * The same, on Codex (EO-373).
 *
 * Under `codex exec` there was no way into a running turn, so the
 * provider had no `interrupt` and an escalated Codex run was abandoned
 * at the escalation — the last case above — and recorded nothing at all.
 * Over `codex app-server` the supervisor's interrupt becomes
 * `turn/interrupt`, the turn ends `interrupted`, and the tokens the
 * app-server already reported for it are drained and recorded.
 *
 * The real adapter and the real client, over a stubbed app-server that
 * behaves as 0.161.0 was measured to: the agent's escalation arrives as a
 * completed call to EO's own `comment` tool, the token reading has been
 * sent, and the turn does not end until it is told to.
 */
/**
 * The `eo` server a real app-server would have started for the turn.
 *
 * The stubbed app-server runs no MCP servers, so nothing would make the
 * comment its scripted call reports — and since EO-543 it is the comment
 * being made over the bridge that ends the run, not the call appearing in
 * the stream. This makes it, with the turn's own credential, as the call
 * is read and before EO is told of it, which is the order a real call
 * goes in: the server writes while the call is open, and the app-server
 * reports it completed afterwards. Everything else, `interrupt` included,
 * is the real adapter's.
 */
function withEoServer(provider: AgentProvider): AgentProvider {
  const writing = (stream: InterruptibleStream<AgentEvent>, opts: { writeBridge?: AgentWriteBridgeAddress } | undefined): InterruptibleStream<AgentEvent> => {
    async function* events(): AsyncIterable<AgentEvent> {
      for await (const event of stream) {
        if (event.type === "tool_call" && event.name === "comment") await sendAgentWrite(bridgeOf(opts), { tool: "comment", args: event.args });
        yield event;
      }
    }
    const iterator = events()[Symbol.asyncIterator]();
    return {
      [Symbol.asyncIterator]: () => iterator,
      ...(stream.interrupt ? { interrupt: stream.interrupt.bind(stream) } : {}),
    };
  };
  return {
    start: (opts) => writing(provider.start(opts), opts),
    resume: (threadId, message, opts) => writing(provider.resume(threadId, message, opts), opts),
  };
}

describe("a Codex run that ends in a blocking escalation", () => {
  it("interrupts the turn and records the tokens it spent", async () => {
    const fake = fakeAppServer({
      after: {
        "turn/start": [
          note.turnStarted(),
          note.item({
            type: "mcpToolCall",
            id: "call-1",
            server: "eo",
            tool: "comment",
            arguments: { body: "@user which way round should this go?", mentions: ["user"], blocking: true },
            status: "completed",
            result: { content: [{ type: "text", text: "posted" }], structuredContent: null, _meta: null },
            error: null,
          }),
          note.tokenUsage({ input: 13_656, cached: 11_776, output: 145 }),
        ],
        // Nothing ends this turn but the interrupt: a supervisor that
        // walked away instead would leave these tokens unread.
        "turn/interrupt": [note.turnCompleted("interrupted")],
      },
    });
    const provider = createCodexProvider({
      executablePath: "/opt/eo/runtimes/codex/bin/codex",
      createCodex: () => new CodexClient({ executablePath: "/opt/eo/runtimes/codex/bin/codex", spawn: fake.spawn, shutdownGraceMs: 200 }),
    });

    await writingSupervisor({ db: handle.db, limits: LIMITS, provider: withEoServer(provider) }).runOnce();

    const run = listRunsForItem(handle.db, item.id)[0]!;
    expect(run.status).toBe("awaiting_input");
    expect(fake.paramsOf("turn/interrupt"), "the turn was abandoned rather than interrupted").toEqual({ threadId: "thr-fake", turnId: "turn-1" });
    expect(run.tokensIn).toBe(13_656);
    expect(run.tokensOut).toBe(145);
    expect((run.tokensIn ?? 0) + (run.tokensOut ?? 0), "an escalated Codex run recorded no usage").toBeGreaterThan(0);
    // The interrupted turn's own error is the wind-down, not a failure.
    const types = listRunEvents(handle.db, run.id).map((event) => event.type);
    expect(types).toContain("wind_down");
    expect(types).not.toContain("error");
  });
});
