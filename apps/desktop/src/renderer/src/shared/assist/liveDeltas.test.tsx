import { act, renderHook } from "@testing-library/react";
import type { LiveTurn } from "@eo/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyDelta, forgetRun, resetLiveDeltas, useLiveDrafts, watchForTest } from "./liveDeltas";

const CHAT = "chat-1";
const turn = (over: Partial<LiveTurn> = {}): LiveTurn => ({ runId: "run-1", startedAt: 0, steps: [], drafts: [], lastDraftId: 0, answer: "", ...over });
const delta = (id: number, offset: number, text: string, stream: "text" | "reasoning" = "text", itemId = CHAT) => ({ runId: "run-1", itemId, draft: { id, stream }, offset, text });

afterEach(() => resetLiveDeltas());

/** The words a window draws while a turn writes them (`liveDeltas.ts`). */
describe("live drafts in a window", () => {
  it("draws pushed words the view has not heard of yet, appended in order", () => {
    const { result } = renderHook(({ live }) => useLiveDrafts(live, CHAT, () => undefined), { initialProps: { live: turn() } });
    act(() => {
      applyDelta(delta(1, 0, "Rate "));
      applyDelta(delta(1, 5, "limited."));
    });
    expect(result.current).toEqual([{ id: 1, stream: "text", text: "Rate limited." }]);
  });

  it("cuts a repeated piece to what is new, and ignores one wholly repeated", () => {
    const { result } = renderHook(() => useLiveDrafts(turn(), CHAT, () => undefined));
    act(() => {
      applyDelta(delta(1, 0, "abc"));
      applyDelta(delta(1, 1, "bcde"));
      applyDelta(delta(1, 0, "ab"));
    });
    expect(result.current[0]?.text).toBe("abcde");
  });

  it("asks for the view when it missed the start of a draft, then extends the view's copy with what it held and what comes next", () => {
    const onGap = vi.fn();
    const { result, rerender } = renderHook(({ live }) => useLiveDrafts(live, CHAT, onGap), { initialProps: { live: turn() } });
    act(() => applyDelta(delta(1, 10, "ABC")));
    expect(onGap).toHaveBeenCalledTimes(1);
    expect(result.current).toEqual([]);

    // The view, read again, has the start; the held piece goes on after it,
    // and a later piece extends that without another gap.
    rerender({ live: turn({ drafts: [{ id: 1, stream: "text", text: "0123456789" }], lastDraftId: 1 }) });
    expect(result.current).toEqual([{ id: 1, stream: "text", text: "0123456789ABC" }]);
    act(() => applyDelta(delta(1, 13, "DE")));
    expect(result.current[0]?.text).toBe("0123456789ABCDE");
    expect(onGap).toHaveBeenCalledTimes(1);
  });

  it("draws whichever of the view and the pushes has said more", () => {
    const { result } = renderHook(() => useLiveDrafts(turn({ drafts: [{ id: 1, stream: "text", text: "All do" }], lastDraftId: 1 }), CHAT, () => undefined));
    expect(result.current[0]?.text).toBe("All do");
    act(() => applyDelta(delta(1, 6, "ne.")));
    expect(result.current[0]?.text).toBe("All done.");
  });

  it("stops drawing a draft the view no longer lists once it has become a step", () => {
    const { result, rerender } = renderHook(({ live }) => useLiveDrafts(live, CHAT, () => undefined), { initialProps: { live: turn() } });
    act(() => {
      applyDelta(delta(1, 0, "Found it."));
      applyDelta(delta(2, 0, "Thinking", "reasoning"));
    });
    expect(result.current.map((draft) => draft.id)).toEqual([1, 2]);
    rerender({ live: turn({ drafts: [{ id: 2, stream: "reasoning", text: "Thinking" }], lastDraftId: 2 }) });
    expect(result.current.map((draft) => draft.id)).toEqual([2]);
  });

  it("lets go when the last surface drawing the chat goes, and starts again from the view", () => {
    const onGap = vi.fn();
    const first = renderHook(() => useLiveDrafts(turn(), CHAT, onGap));
    act(() => applyDelta(delta(1, 0, "Half way")));
    first.unmount();
    // Nothing is kept for a chat nobody is drawing; the next surface finds
    // a gap at its first piece and reads the view, which has the start.
    const again = renderHook(({ live }) => useLiveDrafts(live, CHAT, onGap), { initialProps: { live: turn() } });
    act(() => applyDelta(delta(1, 8, " there")));
    expect(onGap).toHaveBeenCalledTimes(1);
    again.rerender({ live: turn({ drafts: [{ id: 1, stream: "text", text: "Half way" }], lastDraftId: 1 }) });
    expect(again.result.current[0]?.text).toBe("Half way there");
  });

  it("keeps nothing for a conversation no surface is drawing, and lets a run go when it ends", () => {
    const stop = watchForTest(CHAT);
    applyDelta(delta(1, 0, "stray", "text", "another-chat"));
    const { result } = renderHook(() => useLiveDrafts(turn({ lastDraftId: 0 }), CHAT, () => undefined));
    expect(result.current).toEqual([]);
    act(() => applyDelta(delta(1, 0, "mine")));
    expect(result.current).toHaveLength(1);
    act(() => forgetRun("run-1"));
    expect(result.current).toEqual([]);
    stop();
  });

  it("draws nothing with no turn running", () => {
    const { result } = renderHook(() => useLiveDrafts(null, CHAT, () => undefined));
    act(() => applyDelta(delta(1, 0, "stray")));
    expect(result.current).toEqual([]);
  });
});
