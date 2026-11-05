import { describe, expect, it } from "vitest";
import { groupTranscriptEvents, summarise } from "./activity";
import type { TranscriptEventView } from "./useTranscript";

/**
 * Folding machine activity in a transcript (moved here from the classic
 * layout's `transcript/activity.test.tsx` with EO-529; the folded row's
 * own rendering went with that layout).
 */

/** `seq` is allocated per run, so the run has to be part of the fixture. */
function event(seq: number, type: string, payload: unknown = {}, runId = "run-1"): TranscriptEventView {
  return { seq, ts: 1_700_000_000_000 + seq, type, payload, runId };
}

describe("folding machine activity", () => {
  it("folds a consecutive run of tool calls into one item", () => {
    const items = groupTranscriptEvents([
      event(1, "output", { text: "working on it" }),
      event(2, "tool_call", { name: "read" }),
      event(3, "tool_call", { name: "grep" }),
      event(4, "file_edit", { path: "src/a.ts" }),
    ]);

    expect(items.map((item) => item.kind)).toEqual(["event", "activity"]);
    expect(items[1]).toMatchObject({ kind: "activity", summary: "2 tool calls, 1 file edited" });
  });

  it("folds a result with the call it answers, and counts the pair once (EO-169)", () => {
    const items = groupTranscriptEvents([
      event(1, "output", { text: "working on it" }),
      event(2, "tool_call", { name: "Bash", callId: "toolu_1" }),
      event(3, "tool_result", { name: "Bash", callId: "toolu_1", ok: true, output: "2 passed" }),
      event(4, "tool_call", { name: "Grep", callId: "toolu_2" }),
      event(5, "tool_result", { name: "Grep", callId: "toolu_2", ok: true, output: "no matches" }),
    ]);

    // "4 tool calls" about two greps would be the summary lying in the
    // direction of looking busier, which is the same rule the file
    // counts distinct edited paths under.
    expect(items.map((item) => item.kind)).toEqual(["event", "activity"]);
    expect(items[1]).toMatchObject({ kind: "activity", summary: "2 tool calls" });
    expect(items[1]).toMatchObject({ events: [{ seq: 2 }, { seq: 3 }, { seq: 4 }, { seq: 5 }] });
  });

  it("never drops or reorders an event", () => {
    const events = [
      event(1, "tool_call", { name: "read" }),
      event(2, "output", { text: "hm" }),
      event(3, "tool_call", { name: "grep" }),
      event(4, "tool_call", { name: "sed" }),
      event(5, "error", { message: "boom" }),
    ];

    const seqs = groupTranscriptEvents(events).flatMap((item) =>
      item.kind === "activity" ? item.events.map((e) => e.seq) : [item.event.seq],
    );

    expect(seqs).toEqual([1, 2, 3, 4, 5]);
  });

  it("leaves an interception in the open, between the calls it sits among", () => {
    // The point of recording it is that somebody can see it (EO-168).
    // Folded in with the tool calls either side it would be back where
    // it started — happening, and invisible to whoever is watching.
    const items = groupTranscriptEvents([
      event(1, "tool_call", { name: "Bash" }),
      event(2, "search_interception", { tool: "Bash", kind: "symbol", needle: "transitionItem", suggestion: "…" }),
      event(3, "tool_call", { name: "Bash" }),
      event(4, "tool_call", { name: "Bash" }),
    ]);

    expect(items.map((item) => item.kind)).toEqual(["event", "event", "activity"]);
    expect(items[1]).toMatchObject({ kind: "event", event: { type: "search_interception" } });
  });

  it("leaves a lone event loose rather than hiding it behind a chevron", () => {
    // One tool call folded is a click in exchange for nothing.
    const items = groupTranscriptEvents([event(1, "tool_call", { name: "read" })]);

    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe("event");
  });

  it("never folds an error", () => {
    const items = groupTranscriptEvents([
      event(1, "tool_call", { name: "read" }),
      event(2, "error", { message: "boom" }),
      event(3, "tool_call", { name: "grep" }),
    ]);

    // The error stands between two runs, each too short to fold.
    expect(items.map((item) => item.kind)).toEqual(["event", "event", "event"]);
    expect(items[1]).toMatchObject({ kind: "event", event: { type: "error" } });
  });

  it("never folds narration, so the readable spine survives", () => {
    const items = groupTranscriptEvents([
      event(1, "output", { text: "one" }),
      event(2, "output", { text: "two" }),
    ]);

    expect(items.map((item) => item.kind)).toEqual(["event", "event"]);
  });

  it("never folds an unrecognised type", () => {
    // `type` is open (D-02) and an unknown event is exactly what you are
    // looking for when debugging whatever emitted it.
    const items = groupTranscriptEvents([
      event(1, "some_future_kind", { detail: "surprise" }),
      event(2, "some_future_kind", { detail: "again" }),
    ]);

    expect(items.map((item) => item.kind)).toEqual(["event", "event"]);
  });

  it("gives each item a stable key", () => {
    const items = groupTranscriptEvents([
      event(1, "output", { text: "a" }),
      event(2, "tool_call", { name: "read" }),
      event(3, "tool_call", { name: "grep" }),
    ]);

    expect(items.map((item) => item.key)).toEqual(["erun-1:1", "arun-1:2"]);
  });

  it("keeps keys unique across the turns of one conversation", () => {
    /*
     * `run_events.seq` is allocated per run and every run starts at 0, so a
     * group that was resumed after an escalation contains each seq twice.
     * Keying on seq alone produced duplicate React keys, and React drops
     * children when keys collide — the second turn's events vanished from
     * the transcript, and expanding one folded block toggled another.
     */
    const turn = (runId: string) => [
      event(0, "thread_started", { threadId: runId }, runId),
      event(1, "tool_call", { name: "read" }, runId),
      event(2, "output", { text: "thinking" }, runId),
      event(3, "tool_call", { name: "grep" }, runId),
      event(4, "tool_call", { name: "sed" }, runId),
    ];

    const items = groupTranscriptEvents([...turn("run-1"), ...turn("run-2")]);

    expect(new Set(items.map((item) => item.key)).size).toBe(items.length);

    // And the same inside a block, which can span a turn boundary.
    const inner = items.flatMap((item) => (item.kind === "activity" ? item.events : []));
    expect(new Set(inner.map((e) => `${e.runId}:${e.seq}`)).size).toBe(inner.length);
  });

  it("distinguishes unknown file paths across turns when summarising", () => {
    // The fallback key for a path-less file_edit must not merge two turns'
    // distinct edits into one "1 file edited".
    const summary = summarise([
      event(1, "file_edit", {}, "run-1"),
      event(1, "file_edit", {}, "run-2"),
    ]);

    expect(summary).toBe("2 files edited");
  });
});

describe("what the folded line says", () => {
  it("counts files distinct, not per edit", () => {
    // Three edits to one file is one file touched, and saying otherwise
    // would be a small lie in the direction of looking busier.
    const summary = summarise([
      event(1, "file_edit", { path: "src/a.ts" }),
      event(2, "file_edit", { path: "src/a.ts" }),
      event(3, "file_edit", { path: "src/a.ts" }),
    ]);

    expect(summary).toBe("1 file edited");
  });

  it("singularises", () => {
    expect(summarise([event(1, "tool_call", {}), event(2, "result", {})])).toBe("1 tool call, 1 result");
  });

  it("does not name the parts nobody came for", () => {
    const summary = summarise([
      event(1, "tool_call", { name: "read" }),
      event(2, "usage", { tokensIn: 10 }),
      event(3, "thread_started", { threadId: "t" }),
    ]);

    expect(summary).toBe("1 tool call");
  });

  it("still says how much it is hiding when there is nothing to name", () => {
    const summary = summarise([event(1, "usage", { tokensIn: 10 }), event(2, "usage", { tokensIn: 20 })]);

    expect(summary).toBe("2 events");
  });
});
