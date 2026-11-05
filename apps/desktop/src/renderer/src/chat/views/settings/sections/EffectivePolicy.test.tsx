import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createQueryClient } from "../../../../query/client";
import { EffectivePolicy } from "./EffectivePolicy";

describe("the effective policy rail", () => {
  it("counts the repositories, the pipelines and only the live agents", async () => {
    const fallback = window.eo.ipc.invoke;
    window.eo.ipc.invoke = vi.fn(async (channel: string, payload: unknown) => {
      if (channel === "repositories:list") return { ok: true, data: { repositories: [{ id: "r1" }, { id: "r2" }] } };
      if (channel === "pipelines:list") return { ok: true, data: { pipelines: [{ id: "p1" }] } };
      if (channel === "agents:list") return { ok: true, data: { agents: [{ id: "a1", archivedAt: null }, { id: "a2", archivedAt: 1 }, { id: "a3", archivedAt: null }, { id: "a4", archivedAt: null }] } };
      return fallback(channel as never, payload as never);
    }) as never;

    render(
      <QueryClientProvider client={createQueryClient()}>
        <EffectivePolicy />
      </QueryClientProvider>,
    );

    expect(screen.getByText("Effective policy")).toBeInTheDocument();
    expect(await screen.findByText("2")).toBeInTheDocument();
    expect(await screen.findByText("1")).toBeInTheDocument();
    expect(await screen.findByText("3")).toBeInTheDocument();
    // Never a loading line: the rail sits beside the section a person is in.
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
