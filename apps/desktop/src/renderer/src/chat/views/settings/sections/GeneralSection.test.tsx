import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { createQueryClient } from "../../../../query/client";
import { ViewPublisher } from "../../../../shared/view/ViewPublisher";
import { GeneralSection } from "./GeneralSection";

/** Lets a mutation that was fired reach its IPC call before a test says none was made. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

/**
 * Settings → General in the chat layout: the branch prefix, the day's
 * spend, and how many versions pipelines and modules keep — the classic
 * General section's four panels, and its behaviour box for box.
 */

type Call = { channel: string; payload: unknown };

function renderGeneral(branchPrefix = "eo", daily: unknown = { costCents: 1234 }) {
  const calls: Call[] = [];
  // Stateful, so a write is what the next read answers with — the round
  // trip the real bridge gives the renderer.
  let settings = { doNotDisturb: false, archiveAfterDays: 14, jiraPullMinutes: 5, branchPrefix, pipelineVersionsToKeep: 20, moduleVersionsToKeep: 20 };
  const fallback = window.eo.ipc.invoke;
  window.eo.ipc.invoke = vi.fn(async (channel: string, payload: unknown) => {
    calls.push({ channel, payload });
    if (channel === "settings:get") return { ok: true, data: settings };
    if (channel === "settings:set") {
      settings = { ...settings, ...(payload as Partial<typeof settings>) };
      return { ok: true, data: settings };
    }
    if (channel === "costs:getDaily") return { ok: true, data: daily };
    return fallback(channel as never, payload as never);
  }) as never;

  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter>
        <ViewPublisher>
          <GeneralSection />
        </ViewPublisher>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return calls;
}

function lastUnsavedEdits(calls: Call[]): { field: string; value: string }[] {
  const publishes = calls.filter((call) => call.channel === "view:publish");
  return ((publishes.at(-1)?.payload as { unsavedEdits?: { field: string; value: string }[] } | undefined)?.unsavedEdits) ?? [];
}

describe("the branch prefix", () => {
  it("shows the stored prefix and saves an edit through the settings round trip", async () => {
    const calls = renderGeneral("lyudvig");

    const input = await screen.findByLabelText("Branch prefix");
    expect(input).toHaveValue("lyudvig");
    expect(screen.getByText("lyudvig/<KEY>")).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "acme" } });

    await waitFor(() => expect(calls.find((call) => call.channel === "settings:set")?.payload).toEqual({ branchPrefix: "acme" }));
    await waitFor(() => expect(input).toHaveValue("acme"));
  });

  it("never sends an empty prefix, and reports the cleared box as typed and not saved", async () => {
    const calls = renderGeneral("lyudvig");

    const input = await screen.findByLabelText("Branch prefix");
    fireEvent.change(input, { target: { value: "" } });

    expect(input).toHaveValue("");
    await waitFor(() => expect(lastUnsavedEdits(calls)).toEqual([{ field: "Branch prefix", value: "" }]));
    // Asked only once anything sent would have arrived: a mutation runs its
    // call a tick after it is fired.
    await settle();
    expect(calls.some((call) => call.channel === "settings:set")).toBe(false);
  });

  it("stops reporting a prefix once it is stored, and says nothing for one nobody touched", async () => {
    const calls = renderGeneral("lyudvig");

    const input = await screen.findByLabelText("Branch prefix");
    expect(lastUnsavedEdits(calls)).toEqual([]);

    fireEvent.change(input, { target: { value: "acme" } });
    await waitFor(() => expect(lastUnsavedEdits(calls)).toEqual([]));
  });
});

describe("spend", () => {
  it("shows what today has cost", async () => {
    renderGeneral();
    expect(await screen.findByText("12.34 USD")).toBeInTheDocument();
  });

  it("lists EO's own short model calls as their own line under the day's figure (EO-477)", async () => {
    renderGeneral("eo", { date: "2026-10-19", costCents: 1234, sideCalls: [{ group: "memory_upkeep", label: "Memory upkeep", costCents: 34 }] });
    expect(await screen.findByText("12.34 USD")).toBeInTheDocument();
    expect(screen.getByText("Agent runs")).toBeInTheDocument();
    expect(screen.getByText("12.00 USD")).toBeInTheDocument();
    expect(screen.getByText("Memory upkeep")).toBeInTheDocument();
    expect(screen.getByText("0.34 USD")).toBeInTheDocument();
  });

  it("draws no breakdown on a day every cent of which was a run's", async () => {
    renderGeneral("eo", { date: "2026-10-19", costCents: 1234, sideCalls: [] });
    expect(await screen.findByText("12.34 USD")).toBeInTheDocument();
    expect(screen.queryByText("Memory upkeep")).not.toBeInTheDocument();
  });
});

describe("versions to keep (EO-359, EO-360)", () => {
  it("shows both at twenty and saves a whole number of one or more", async () => {
    const calls = renderGeneral();

    const pipelines = await screen.findByLabelText("Pipeline versions to keep");
    const modules = await screen.findByLabelText("Module versions to keep");
    expect(pipelines).toHaveValue(20);
    expect(modules).toHaveValue(20);

    fireEvent.change(pipelines, { target: { value: "5" } });
    await waitFor(() => expect(calls.find((call) => call.channel === "settings:set")?.payload).toEqual({ pipelineVersionsToKeep: 5 }));

    fireEvent.change(modules, { target: { value: "3" } });
    await waitFor(() => expect(calls.filter((call) => call.channel === "settings:set").at(-1)?.payload).toEqual({ moduleVersionsToKeep: 3 }));
  });

  it("refuses anything that is not a whole number of one or more, and says so", async () => {
    const calls = renderGeneral();

    const input = await screen.findByLabelText("Pipeline versions to keep");
    for (const value of ["0", "2.5", ""]) {
      fireEvent.change(input, { target: { value } });
      expect(screen.getByRole("alert")).toHaveTextContent("A whole number, 1 or more.");
    }
    await settle();
    expect(calls.some((call) => call.channel === "settings:set")).toBe(false);
  });

  it("names the project's own word for its work in the note", async () => {
    renderGeneral();
    expect(await screen.findByText(/never one a ticket is still finishing on, archived tickets included/)).toBeInTheDocument();
  });
});
