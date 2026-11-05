import type { AgentEvent, AgentProvider, Item } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { countSearchInterceptions, listRunEvents } from "../db/repos/runEventsRepo.js";
import { listRunsForItem } from "../db/repos/runsRepo.js";
import type { DbHandle } from "../db/client.js";
import { createTestItem, openMigratedTestDb, REVIEWABLE_SPEC } from "../db/testHelpers.js";
import { createRoleWiring } from "../packs/developer/wiring.js";
import { createRunSupervisor } from "./runSupervisor.js";

const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };

let handle: DbHandle;
let item: Item;

/** A backend that emits exactly this list and stops. */
function emitting(events: AgentEvent[]): AgentProvider {
  async function* stream(): AsyncIterable<AgentEvent> {
    for (const event of events) yield event;
  }
  return { start: () => stream(), resume: () => stream() };
}

const approval = JSON.stringify({ outcome: { verdict: "approve", feedback: "Fine." } });

const grep = (command: string, callId?: string): AgentEvent => ({ type: "tool_call", ...(callId ? { callId } : {}), name: "Bash", args: { command } });

const nudged = (needle: string, callId = "toolu_1"): AgentEvent => ({
  type: "search_interception",
  tool: "Bash",
  callId,
  kind: "symbol",
  needle,
  // A stand-in vocabulary, never the real index's: what the index is
  // called is one directory's business (`repositoryIntelligence/`), and a
  // fixture that named it would be a second place to change.
  suggestion: `That searched the whole checkout for \`${needle}\`. Use \`mcp__repo__idx_symbol\`. Your command was not blocked and has run.`,
});

/**
 * An interception, all the way through to the durable log (EO-168).
 *
 * The adapter's own tests prove the event is produced; this proves it
 * *lands* — in `run_events`, the append-only substrate the transcript
 * already renders and every measurement in this area has come out of.
 * No table was added for it and none needed to be: the log's `type` is
 * open by design (D-02), so a new kind is a new payload shape rather
 * than a schema change.
 */
describe("an interception on the run's record", () => {
  beforeEach(() => {
    handle = openMigratedTestDb();
    item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "review", spec: REVIEWABLE_SPEC });
  });

  afterEach(() => {
    handle.close();
  });

  const runOnce = async (events: AgentEvent[]) => {
    await createRunSupervisor({ db: handle.db, provider: emitting(events), limits: LIMITS, ...createRoleWiring(handle.db) }).runOnce();
    const run = listRunsForItem(handle.db, item.id).find((candidate) => candidate.action === "review")!;
    return { run, events: listRunEvents(handle.db, run.id) };
  };

  it("appends it beside the call that triggered it, and adds nothing else to the log", async () => {
    const { run, events } = await runOnce([
      { type: "thread_started", threadId: "thr_1" },
      grep("grep -rn transitionItem ."),
      nudged("transitionItem"),
      { type: "result", data: approval },
    ]);

    // The trailing `review_verdict` is EO-200's measurement row, written
    // after the stream has ended and the buffer has been disposed. It is
    // in the list because this assertion is exhaustive on purpose — the
    // point being that nothing was inserted *into* the stream — and it
    // is at the end because that is where an append-only log puts a fact
    // learned after the fact.
    expect(events.map((event) => event.type)).toEqual(["thread_started", "tool_call", "search_interception", "result", "review_verdict"]);
    // Contiguous, so the interception can be read against what the agent
    // did next rather than merely counted.
    expect(events.map((event) => event.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(events[2]?.payload).toMatchObject({
      tool: "Bash",
      callId: "toolu_1",
      kind: "symbol",
      needle: "transitionItem",
      suggestion: expect.stringContaining("mcp__repo__idx_symbol"),
    });
    // Nothing already in the log was rewritten to make room for it
    // (invariant #3): the tool call it is about is exactly as it arrived.
    expect(events[1]?.payload).toMatchObject({ name: "Bash", args: { command: "grep -rn transitionItem ." } });
    expect(run.status).toBe("succeeded");
  });

  it("tells a run that was never nudged from one that was nudged and ignored it", async () => {
    // The distinction the log could not draw, at the level the
    // measurement is actually taken. Both runs search the tree three
    // times and neither calls the index; the only difference between
    // them is whether EO ever spoke.
    const searches: AgentEvent[] = [grep("grep -rn transitionItem ."), grep("rg RunEvent apps packages"), grep("find . -name '*.ts'")];

    const quiet = await runOnce([{ type: "thread_started", threadId: "thr_quiet" }, ...searches, { type: "result", data: approval }]);
    expect(countSearchInterceptions(handle.db, quiet.run.id)).toBe(0);

    item = createTestItem(handle.db, { type: "story", title: "Another story", stepId: "review", spec: REVIEWABLE_SPEC });
    const ignored = await runOnce([
      { type: "thread_started", threadId: "thr_ignored" },
      searches[0]!,
      nudged("transitionItem"),
      searches[1]!,
      nudged("RunEvent"),
      searches[2]!,
      { type: "result", data: approval },
    ]);
    expect(countSearchInterceptions(handle.db, ignored.run.id)).toBe(2);

    // Same shell calls on both. Before this event existed that was the
    // whole of the evidence, and it pointed at two opposite fixes.
    for (const outcome of [quiet, ignored]) {
      expect(outcome.events.filter((event) => event.type === "tool_call")).toHaveLength(3);
    }
  });

  it("counts two identical parallel searches as two, on the strength of their call ids", async () => {
    // A model asking for the same broad search twice in one message
    // lands two `tool_call`s and then two interceptions whose tool,
    // kind, needle and sentence are character-for-character identical.
    // What stops that log being equally consistent with one call
    // nudged twice — an inflated count nobody could see — is that the
    // rows carry different call ids.
    const { run, events } = await runOnce([
      { type: "thread_started", threadId: "thr_parallel" },
      grep("grep -rn transitionItem .", "toolu_1"),
      grep("cat packages/core/src/execution.ts", "toolu_2"),
      grep("grep -rn transitionItem .", "toolu_3"),
      nudged("transitionItem", "toolu_1"),
      nudged("transitionItem", "toolu_3"),
      { type: "result", data: approval },
    ]);

    expect(countSearchInterceptions(handle.db, run.id)).toBe(2);

    // The join, done off the persisted rows exactly as a query would do
    // it, on the one field all three event kinds spell the same way:
    // `tool_call.callId` is the key, and a result pairs on it too. Neither content nor position could do this —
    // the two greps are identical, and the call sitting between them was
    // never intercepted.
    const callsById = new Map(
      events.flatMap((event) => {
        const payload = event.payload as { callId?: unknown; args?: { command?: unknown } };
        return event.type === "tool_call" && typeof payload.callId === "string" ? [[payload.callId, payload.args?.command] as const] : [];
      }),
    );
    const joined = events
      .filter((event) => event.type === "search_interception")
      .map((event) => callsById.get(String((event.payload as { callId?: unknown }).callId)));

    expect(joined).toEqual(["grep -rn transitionItem .", "grep -rn transitionItem ."]);
    // Two calls, not one joined to twice, and not the `cat`.
    expect(new Set(events.filter((e) => e.type === "search_interception").map((e) => (e.payload as { callId?: unknown }).callId)).size).toBe(2);
  });
});
