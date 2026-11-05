import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRevealed } from "./useRevealed";

describe("revealing text as it is written", () => {
  let now = 0;
  let frames: FrameRequestCallback[] = [];
  beforeEach(() => {
    now = 0;
    frames = [];
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  const frame = (ms: number) =>
    act(() => {
      now += ms;
      const due = frames.splice(0);
      for (const callback of due) callback(now);
    });

  it("shows what was there when it was first drawn, then paces what arrives after, draining the backlog in about a quarter second", () => {
    const { result, rerender } = renderHook(({ text }) => useRevealed(text), { initialProps: { text: "Kitchen timers " } });
    expect(result.current).toBe("Kitchen timers ");
    rerender({ text: `Kitchen timers ${"x".repeat(200)}` });
    expect(result.current).toBe("Kitchen timers ");
    frame(16);
    expect(result.current.length).toBeGreaterThan("Kitchen timers ".length);
    expect(result.current.length).toBeLessThan(215);
    for (let index = 0; index < 30; index++) frame(16);
    expect(result.current).toBe(`Kitchen timers ${"x".repeat(200)}`);
  });

  it("paces a block that begins after the turn is on screen from its first word, even when it arrives whole", () => {
    const { result } = renderHook(() => useRevealed("A whole paragraph that arrived in one piece.", true));
    expect(result.current).toBe("");
    frame(16);
    expect(result.current.length).toBeGreaterThan(0);
    expect(result.current.length).toBeLessThan(44);
    for (let index = 0; index < 30; index++) frame(16);
    expect(result.current).toBe("A whole paragraph that arrived in one piece.");
  });

  it("jumps straight to a text that does not continue what was shown", () => {
    const { result, rerender } = renderHook(({ text }) => useRevealed(text), { initialProps: { text: "First draft" } });
    rerender({ text: "Another block" });
    expect(result.current).toBe("Another block");
  });
});
