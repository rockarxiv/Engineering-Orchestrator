import { describe, expect, it } from "vitest";
import { createQueryClient } from "./client";

/**
 * Pins the refresh policy, so a plausible-sounding revert is not silent.
 *
 * "The main process pushes when something changes, so focus refetch is
 * redundant" reads perfectly reasonable — and it is how the app came to
 * leave a posted reply invisible until the screen was remounted, because
 * five write paths turned out to emit no push at all. The backstop is
 * there for the pushes nobody has noticed are missing yet.
 */
describe("the query client's refresh policy", () => {
  it("refetches on focus, so a missed push heals when you come back", () => {
    expect(createQueryClient().getDefaultOptions().queries?.refetchOnWindowFocus).toBe(true);
  });

  it("keeps a stale window, so returning to the window is not a stampede", () => {
    expect(createQueryClient().getDefaultOptions().queries?.staleTime).toBe(30_000);
  });

  it("still does not poll — pushes remain the mechanism", () => {
    expect(createQueryClient().getDefaultOptions().queries?.refetchInterval).toBeUndefined();
  });

  it("surfaces a failed IPC call rather than retrying it", () => {
    expect(createQueryClient().getDefaultOptions().queries?.retry).toBe(false);
  });
});
