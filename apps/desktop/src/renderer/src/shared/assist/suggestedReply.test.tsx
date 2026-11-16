import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applySuggestedReply, resetSuggestedReplies, useSuggestedReply } from "./suggestedReply";

/** The window's copy of each chat's suggested reply (EO-809). */
describe("a chat's suggested reply in the window", () => {
  afterEach(() => resetSuggestedReplies());

  function listen() {
    const listeners = new Map<string, (payload: unknown) => void>();
    window.eo.ipc.subscribe = vi.fn((channel: string, callback: (payload: unknown) => void) => {
      listeners.set(channel, callback);
      return () => listeners.delete(channel);
    }) as never;
    return (channel: string, payload: unknown) => act(() => listeners.get(channel)?.(payload));
  }

  it("is the pushed one, for the chat it names", () => {
    const push = listen();
    const { result } = renderHook(() => useSuggestedReply("chat-1"));
    push("assist:suggestion", { conversationId: "chat-1", runId: "run-1", text: "yes" });
    push("assist:suggestion", { conversationId: "chat-2", runId: "run-2", text: "no" });
    expect(result.current.suggestion).toEqual({ runId: "run-1", text: "yes" });
  });

  it("goes when the chat being drawn changes, and does not come back with it", () => {
    listen();
    const { result, rerender } = renderHook(({ id }) => useSuggestedReply(id), { initialProps: { id: "chat-1" } });
    act(() => applySuggestedReply({ conversationId: "chat-1", runId: "run-1", text: "yes" }));
    expect(result.current.suggestion?.text).toBe("yes");
    rerender({ id: "chat-2" });
    expect(result.current.suggestion).toBeNull();
    rerender({ id: "chat-1" });
    expect(result.current.suggestion).toBeNull();
  });

  it("goes when a run starts in the chat, and when it is let go of", () => {
    const push = listen();
    const { result } = renderHook(() => useSuggestedReply("chat-1"));
    push("assist:suggestion", { conversationId: "chat-1", runId: "run-1", text: "yes" });
    push("runs:changed", { runId: "run-9", itemId: "other", status: "running" });
    expect(result.current.suggestion?.text).toBe("yes");
    push("runs:changed", { runId: "run-2", itemId: "chat-1", status: "queued" });
    expect(result.current.suggestion).toBeNull();

    push("assist:suggestion", { conversationId: "chat-1", runId: "run-2", text: "go ahead" });
    act(() => result.current.clear());
    expect(result.current.suggestion).toBeNull();
  });
});
