import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useAppVersion } from "./useAppVersion";

describe("useAppVersion", () => {
  it("resolves the version from the invoke round-trip", async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true, data: { version: "1.2.3" } });
    window.eo.ipc.invoke = invoke;

    const { result } = renderHook(() => useAppVersion());

    await waitFor(() => expect(result.current).toBe("1.2.3"));
    expect(invoke).toHaveBeenCalledWith("app:getVersion", undefined);
  });

  it("leaves the version unset when the main process returns an error envelope", async () => {
    window.eo.ipc.invoke = vi.fn().mockResolvedValue({ ok: false, error: { message: "boom" } });

    const { result } = renderHook(() => useAppVersion());

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(result.current).toBeUndefined();
  });
});
