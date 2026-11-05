import { act, renderHook, waitFor } from "@testing-library/react";
import type { RunEventView } from "@eo/core";
import { describe, expect, it, vi } from "vitest";
import { useTranscript } from "./useTranscript";


function event(seq: number, type = "output", payload: unknown = { text: `line ${seq}` }): RunEventView {
  return { seq, ts: 1000 + seq, type, payload };
}

/**
 * A fake log that can grow between calls, so the tail can be exercised
 * the way it actually behaves: paging forward over an append-only
 * substrate rather than refetching a value.
 */
function fakeLog(initial: RunEventView[] = []) {
  let events = [...initial];
  let subscriber: ((payload: { runId: string }) => void) | undefined;

  window.eo.ipc.invoke = vi.fn(async (channel: string, payload: unknown) => {
    if (channel === "runs:listEvents") {
      const { fromSeq, limit } = payload as { fromSeq: number; limit: number };
      const slice = events.filter((entry) => entry.seq >= fromSeq).slice(0, limit);
      const more = events.filter((entry) => entry.seq >= fromSeq).length > slice.length;
      return { ok: true, data: { events: slice, nextSeq: more ? slice.at(-1)!.seq + 1 : null, total: events.length } };
    }
    return { ok: true, data: {} };
  }) as never;

  window.eo.ipc.subscribe = vi.fn((_channel: string, callback: (payload: { runId: string }) => void) => {
    subscriber = callback;
    return () => {
      subscriber = undefined;
    };
  }) as never;

  return {
    append(more: RunEventView[]) {
      events = [...events, ...more];
    },
    /** A line that reached this machine after later ones did, as `runs:listEvents` serves it: in `seq` order. */
    insert(line: RunEventView) {
      events = [...events, line].sort((left, right) => left.seq - right.seq);
    },
    reads() {
      return vi.mocked(window.eo.ipc.invoke).mock.calls.filter(([channel]) => channel === "runs:listEvents").map(([, payload]) => (payload as { fromSeq: number }).fromSeq);
    },
    signal(runId = "r1") {
      subscriber?.({ runId });
    },
  };
}

describe("useTranscript", () => {
  it("pages through the whole log rather than stopping at the first page", async () => {
    fakeLog(Array.from({ length: 1200 }, (_, index) => event(index)));

    const { result } = renderHook(() => useTranscript(["r1"]));

    await waitFor(() => expect(result.current.events).toHaveLength(1200));
    expect(result.current.events[0]?.seq).toBe(0); // the very first event is not skipped
    expect(result.current.events.at(-1)?.seq).toBe(1199);
  });

  it("takes in a line that lands behind what is on screen, once and in its place, without reopening", async () => {
    const log = fakeLog([event(1_000), event(3_000)]);
    const { result } = renderHook(() => useTranscript(["r1"]));
    await waitFor(() => expect(result.current.events).toHaveLength(2));

    log.insert(event(2_000));
    act(() => log.signal());

    await waitFor(() => expect(result.current.events.map((line) => line.seq)).toEqual([1_000, 2_000, 3_000]));

    // And carries on from the end, neither reading it again nor repeating it.
    log.append([event(4_000)]);
    act(() => log.signal());
    await waitFor(() => expect(result.current.events.map((line) => line.seq)).toEqual([1_000, 2_000, 3_000, 4_000]));
    expect(log.reads().at(-1)).toBe(3_001);
  });

  it("takes in a late line and a new one that arrive together", async () => {
    const log = fakeLog([event(1_000), event(3_000)]);
    const { result } = renderHook(() => useTranscript(["r1"]));
    await waitFor(() => expect(result.current.events).toHaveLength(2));

    log.insert(event(2_000));
    log.append([event(4_000)]);
    act(() => log.signal());

    await waitFor(() => expect(result.current.events.map((line) => line.seq)).toEqual([1_000, 2_000, 3_000, 4_000]));
  });

  it("re-reads nothing when a signal brings only what is ahead of it", async () => {
    const log = fakeLog([event(0), event(1)]);
    const { result } = renderHook(() => useTranscript(["r1"]));
    await waitFor(() => expect(result.current.events).toHaveLength(2));

    log.append([event(2)]);
    act(() => log.signal());
    await waitFor(() => expect(result.current.events).toHaveLength(3));

    expect(log.reads()).toEqual([0, 2]);
  });

  it("appends only what is new when the run produces more", async () => {
    const log = fakeLog([event(0), event(1)]);
    const { result } = renderHook(() => useTranscript(["r1"]));
    await waitFor(() => expect(result.current.events).toHaveLength(2));

    log.append([event(2), event(3)]);
    act(() => log.signal());

    await waitFor(() => expect(result.current.events).toHaveLength(4));
    expect(result.current.events.map((entry) => entry.seq)).toEqual([0, 1, 2, 3]); // no duplicates
  });

  it("does not drop events when signals arrive faster than fetches", async () => {
    // A chatty agent out-produces the round trip. Overlapping fetches
    // would interleave pages and duplicate rows, and ignoring a signal
    // outright would stall the tail one batch short of the end.
    const log = fakeLog([event(0)]);
    const { result } = renderHook(() => useTranscript(["r1"]));
    await waitFor(() => expect(result.current.events).toHaveLength(1));

    act(() => {
      log.append([event(1)]);
      log.signal();
      log.append([event(2)]);
      log.signal();
      log.append([event(3)]);
      log.signal();
    });

    await waitFor(() => expect(result.current.events).toHaveLength(4));
    expect(result.current.events.map((entry) => entry.seq)).toEqual([0, 1, 2, 3]);
  });

  it("ignores a signal for a different run", async () => {
    const log = fakeLog([event(0)]);
    const { result } = renderHook(() => useTranscript(["r1"]));
    await waitFor(() => expect(result.current.events).toHaveLength(1));

    log.append([event(1)]);
    act(() => log.signal("some-other-run"));

    // Nothing fetched, so the new event is not picked up by this signal.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(result.current.events).toHaveLength(1);
  });

  it("reads every turn of a resumed run as one log, in the order they happened", async () => {
    const perRun: Record<string, RunEventView[]> = {
      r1: [event(0, "output", { text: "before the question" })],
      r2: [event(0, "output", { text: "after the answer" })],
    };
    window.eo.ipc.invoke = vi.fn(async (_channel: string, payload: unknown) => {
      const { runId } = payload as { runId: string };
      return { ok: true, data: { events: perRun[runId] ?? [], nextSeq: null } };
    }) as never;
    window.eo.ipc.subscribe = vi.fn(() => () => {}) as never;

    const { result } = renderHook(() => useTranscript(["r1", "r2"]));

    await waitFor(() => expect(result.current.events).toHaveLength(2));
    expect(result.current.events.map((entry) => (entry.payload as { text: string }).text)).toEqual([
      "before the question",
      "after the answer",
    ]);
  });

  it("does not re-read the whole conversation when a reply adds a turn", async () => {
    // The group gains a run mid-flight. Blanking the transcript and
    // fetching it all again would throw away what is already on screen
    // at the exact moment the agent picks the work back up.
    const fetched: string[] = [];
    window.eo.ipc.invoke = vi.fn(async (_channel: string, payload: unknown) => {
      const { runId } = payload as { runId: string };
      fetched.push(runId);
      return { ok: true, data: { events: [event(0, "output", { text: runId })], nextSeq: null } };
    }) as never;
    window.eo.ipc.subscribe = vi.fn(() => () => {}) as never;

    const { result, rerender } = renderHook(({ ids }: { ids: string[] }) => useTranscript(ids), {
      initialProps: { ids: ["r1"] },
    });
    await waitFor(() => expect(result.current.events).toHaveLength(1));

    rerender({ ids: ["r1", "r2"] });

    await waitFor(() => expect(result.current.events).toHaveLength(2));
    expect(fetched).toEqual(["r1", "r2"]); // r1 was not fetched a second time
  });

  it("starts over when the run changes rather than appending one log onto another", async () => {
    fakeLog([event(0), event(1)]);
    const { result, rerender } = renderHook(({ id }: { id: string }) => useTranscript([id]), { initialProps: { id: "r1" } });
    await waitFor(() => expect(result.current.events).toHaveLength(2));

    rerender({ id: "r2" });

    await waitFor(() => expect(result.current.events).toHaveLength(2));
    expect(result.current.events.map((entry) => entry.seq)).toEqual([0, 1]); // not 4 entries
  });
});
