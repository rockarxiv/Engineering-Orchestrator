import type { ReactElement } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { createQueryClient } from "../../../../query/client";
import { ArchiveSection } from "./ArchiveSection";
import { GuardrailsSection } from "./GuardrailsSection";

/** Settings → Guardrails and → Archive in the chat layout, as `Settings.test.tsx` asserts the classic sections. */

type Call = { channel: string; payload: unknown };

const GUARDS = {
  globalConcurrency: 1,
  perRepositoryConcurrency: 1,
  perAgentConcurrency: 1,
  perItemAttemptLimit: 3,
  wallClockTimeoutMs: 30 * 60_000,
  perItemBudgetCents: null,
  dailyBudgetCents: 5_000,
  interpretReplies: true,
  agentMentionDepth: 3,
  watchRoundTripsPerItem: 5,
  memoryDeliveryChars: 4_000,
  memoryScopeMaxEntries: 200,
  memoryScopeMaxChars: 40_000,
  skillStaleAfterRuns: 20,
  skillArchiveAfterRuns: 50,
  trialsFirst: true,
  trialRoundsPerDraft: 8,
  trialBudgetCentsPerDraft: null,
  trialStopOnRepeatedFailure: true,
  runMemoryMaxMb: null,
};

type Options = {
  /** A run timeout under this is refused, as a module step's own limit would refuse it. */
  refusalBelowMs?: number;
  /** How long `guards:set` takes to answer, so a second edit can be made while the first is in flight. */
  guardsReplyMs?: number;
  /** A write carrying this value for the field fails outright. */
  failWhen?: { field: string; value: unknown };
  /** What `guards:runMemory` says about this computer (EO-738). */
  runMemory?: { applies: boolean; reason: string | null; totalMb: number; defaultMb: number; effectiveMb: number };
};

const SCOPED_LINUX = { applies: true, reason: null, totalMb: 15_217, defaultMb: 11_412, effectiveMb: 11_412 };

function renderWith(ui: ReactElement, { refusalBelowMs = 0, guardsReplyMs = 0, failWhen, runMemory = SCOPED_LINUX }: Options = {}) {
  const calls: Call[] = [];
  let guards = { ...GUARDS };
  const failing = (payload: unknown) =>
    failWhen !== undefined && (payload as Record<string, unknown>)[failWhen.field] === failWhen.value;
  let settings = { doNotDisturb: false, archiveAfterDays: 14 as number | null, jiraPullMinutes: 5, branchPrefix: "eo", pipelineVersionsToKeep: 20, moduleVersionsToKeep: 20 };
  const fallback = window.eo.ipc.invoke;
  window.eo.ipc.invoke = vi.fn(async (channel: string, payload: unknown) => {
    calls.push({ channel, payload });
    if (channel === "guards:get") return { ok: true, data: guards };
    if (channel === "guards:runMemory") return { ok: true, data: runMemory };
    if (channel === "guards:set") {
      if (guardsReplyMs > 0) await new Promise((resolve) => setTimeout(resolve, guardsReplyMs));
      if (failing(payload)) return { ok: false, error: { code: "INTERNAL", message: "The database is locked." } };
      // The one write this channel declines (EO-162): a run timeout under
      // a module step's own time limit.
      const asked = payload as typeof GUARDS;
      if (asked.wallClockTimeoutMs < refusalBelowMs) {
        return { ok: true, data: { saved: false, guards, problems: ['"Merge" may run for 20 minutes, which is longer than the run timeout of 5 minutes.'] } };
      }
      guards = asked;
      return { ok: true, data: { saved: true, guards, problems: [] } };
    }
    if (channel === "settings:get") return { ok: true, data: settings };
    if (channel === "settings:set") {
      if (failing(payload)) return { ok: false, error: { code: "INTERNAL", message: "The database is locked." } };
      settings = { ...settings, ...(payload as Partial<typeof settings>) };
      return { ok: true, data: settings };
    }
    return fallback(channel as never, payload as never);
  }) as never;

  const client = createQueryClient();
  const wrap = (node: ReactElement) => (
    <QueryClientProvider client={client}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>
  );
  const { rerender } = render(wrap(ui));
  return { calls, stored: () => ({ guards, settings }), rerender: (node: ReactElement) => rerender(wrap(node)) };
}

const written = (calls: Call[], channel: string) => calls.filter((call) => call.channel === channel).map((call) => call.payload);

describe("the run memory limit (EO-738)", () => {
  it("is a box where this computer gives each run a scope, blank for EO's default, which it names", async () => {
    const { calls } = renderWith(<GuardrailsSection />);
    const guardrails = await screen.findByRole("region", { name: "Guardrails" });
    const box = await within(guardrails).findByLabelText("Memory per run (MB, blank = EO's default)");
    expect(box).toHaveValue(null);
    expect(within(guardrails).getByText(/three quarters of its 15,217 MB, shared across a global concurrency of 1 — 11,412 MB/)).toBeTruthy();

    fireEvent.change(box, { target: { value: "4096" } });
    fireEvent.blur(box);
    await waitFor(() => expect(written(calls, "guards:set").at(-1)).toMatchObject({ runMemoryMaxMb: 4096, perItemAttemptLimit: 3 }));

    // The same box, still there: the save does not take it away.
    expect(box).toBeInTheDocument();
    fireEvent.change(box, { target: { value: "" } });
    fireEvent.blur(box);
    await waitFor(() => expect(written(calls, "guards:set").at(-1)).toMatchObject({ runMemoryMaxMb: null }));
  });

  it("refuses a value outside its range by name, and writes nothing", async () => {
    const { calls } = renderWith(<GuardrailsSection />);
    const guardrails = await screen.findByRole("region", { name: "Guardrails" });
    const box = await within(guardrails).findByLabelText("Memory per run (MB, blank = EO's default)");
    fireEvent.change(box, { target: { value: "100" } });
    fireEvent.blur(box);
    expect(await within(guardrails).findByRole("alert")).toHaveTextContent(/runMemoryMaxMb.*from 256 to 1,048,576/);
    expect(written(calls, "guards:set")).toEqual([]);
  });

  it("is no control at all where it does not apply, and says why", async () => {
    renderWith(<GuardrailsSection />, { runMemory: { applies: false, reason: "macOS has no systemd", totalMb: 16_384, defaultMb: 12_288, effectiveMb: 12_288 } });
    const guardrails = await screen.findByRole("region", { name: "Guardrails" });
    expect(await within(guardrails).findByText("Does not apply on this computer")).toBeTruthy();
    expect(within(guardrails).getByText(/Applies on Linux only.*macOS has no systemd/)).toBeTruthy();
    expect(within(guardrails).queryByLabelText(/Memory per run/)).toBeNull();
  });
});

describe("the guardrails section", () => {
  it("draws every limit, and the one checkbox is the system agent reading replies", async () => {
    renderWith(<GuardrailsSection />);
    const guardrails = await screen.findByRole("region", { name: "Guardrails" });

    expect(await within(guardrails).findByLabelText("Global concurrency")).toHaveValue(1);
    expect(within(guardrails).getByLabelText("Per-repository concurrency")).toHaveValue(1);
    expect(within(guardrails).getByLabelText("Per-agent concurrency")).toHaveValue(1);
    expect(within(guardrails).getByLabelText("Attempt limit per initiation")).toHaveValue(3);
    expect(within(guardrails).getByLabelText("Run timeout (minutes)")).toHaveValue(30);
    expect(within(guardrails).getByLabelText("Per-ticket budget (cents, blank = none)")).toHaveValue(null);
    expect(within(guardrails).queryByText(/Pause the engine/)).not.toBeInTheDocument();
    expect(within(guardrails).getByRole("checkbox", { name: /read replies to a step/i })).toBeChecked();
  });

  it("says only the attempt limit applies to the system agent (EO-616)", async () => {
    renderWith(<GuardrailsSection />);

    expect(await screen.findByText(/only the attempt limit applies to the system agent/)).toBeTruthy();
  });

  it("writes the whole configuration back with one field changed", async () => {
    const { calls } = renderWith(<GuardrailsSection />);
    const guardrails = await screen.findByRole("region", { name: "Guardrails" });

    fireEvent.click(await within(guardrails).findByRole("checkbox", { name: /read replies to a step/i }));
    await waitFor(() => expect(written(calls, "guards:set").at(-1)).toMatchObject({ interpretReplies: false, perItemAttemptLimit: 3 }));

    fireEvent.change(within(guardrails).getByLabelText("Per-ticket budget (cents, blank = none)"), { target: { value: "250" } });
    fireEvent.blur(within(guardrails).getByDisplayValue("250"));
    await waitFor(() => expect(written(calls, "guards:set").at(-1)).toMatchObject({ perItemBudgetCents: 250 }));
  });

  it("shows the agent-to-agent mention cap, and what resets it (EO-212)", async () => {
    const { calls } = renderWith(<GuardrailsSection />);
    const guardrails = await screen.findByRole("region", { name: "Guardrails" });

    const field = await within(guardrails).findByLabelText("Agent-to-agent mentions before a person is asked");
    expect(field).toHaveValue(3);
    expect(within(guardrails).getByText(/Counted since the last comment of yours/)).toBeInTheDocument();
    fireEvent.change(field, { target: { value: "5" } });
    fireEvent.blur(field);
    await waitFor(() => expect(written(calls, "guards:set").at(-1)).toMatchObject({ agentMentionDepth: 5, perItemAttemptLimit: 3 }));
  });

  it("shows the watch round-trip guardrail at its default, and what resets it (EO-456)", async () => {
    const { calls } = renderWith(<GuardrailsSection />);
    const guardrails = await screen.findByRole("region", { name: "Guardrails" });

    const field = await within(guardrails).findByLabelText(/^Watch round trips per /);
    expect(field).toHaveValue(5);
    expect(within(guardrails).getByText(/steps that keep checking may send/)).toBeInTheDocument();
    fireEvent.change(field, { target: { value: "8" } });
    fireEvent.blur(field);
    await waitFor(() => expect(written(calls, "guards:set").at(-1)).toMatchObject({ watchRoundTripsPerItem: 8, agentMentionDepth: 3 }));
  });

  it("shows how much memory a run is given whole, and saves a change (EO-478)", async () => {
    const { calls } = renderWith(<GuardrailsSection />);
    const guardrails = await screen.findByRole("region", { name: "Guardrails" });

    const field = await within(guardrails).findByLabelText("Memory given whole, in characters");
    expect(field).toHaveValue(4000);
    expect(within(guardrails).getByText(/a small model picks the entries that bear on the task/)).toBeInTheDocument();
    fireEvent.change(field, { target: { value: "6000" } });
    fireEvent.blur(field);
    await waitFor(() => expect(written(calls, "guards:set").at(-1)).toMatchObject({ memoryDeliveryChars: 6000 }));
  });

  it("shows each memory scope's caps, and saves a change (EO-480)", async () => {
    const { calls } = renderWith(<GuardrailsSection />);
    const guardrails = await screen.findByRole("region", { name: "Guardrails" });

    const entries = await within(guardrails).findByLabelText("Memory entries per scope");
    const chars = within(guardrails).getByLabelText("Memory characters per scope");
    expect(entries).toHaveValue(200);
    expect(chars).toHaveValue(40000);
    expect(within(guardrails).getByText(/Entries a person wrote are never rewritten/)).toBeInTheDocument();
    fireEvent.change(entries, { target: { value: "150" } });
    fireEvent.blur(entries);
    await waitFor(() => expect(written(calls, "guards:set").at(-1)).toMatchObject({ memoryScopeMaxEntries: 150, memoryScopeMaxChars: 40_000 }));
  });

  it("shows when an agent's unused skill goes stale and is archived, and saves a change (EO-720)", async () => {
    const { calls } = renderWith(<GuardrailsSection />);
    const guardrails = await screen.findByRole("region", { name: "Guardrails" });

    const stale = await within(guardrails).findByLabelText("Runs without a load before a skill is stale");
    const archive = within(guardrails).getByLabelText("Runs without a load before a skill is archived");
    expect(stale).toHaveValue(20);
    expect(archive).toHaveValue(50);
    expect(within(guardrails).getByText(/Skills a person wrote, and locked skills, are never archived by EO/)).toBeInTheDocument();
    fireEvent.change(archive, { target: { value: "80" } });
    fireEvent.blur(archive);
    await waitFor(() => expect(written(calls, "guards:set").at(-1)).toMatchObject({ skillStaleAfterRuns: 20, skillArchiveAfterRuns: 80 }));
  });

  it("says a default applies to the daily budget and what clearing it costs (EO-211)", async () => {
    const { calls } = renderWith(<GuardrailsSection />);
    const guardrails = await screen.findByRole("region", { name: "Guardrails" });

    const daily = await within(guardrails).findByLabelText("Daily budget (cents, blank = none)");
    expect(daily).toHaveValue(5_000);
    expect(within(guardrails).getByText(/EO applies a default here unless you say otherwise/)).toBeInTheDocument();
    expect(within(guardrails).getByText(/clearing the field removes the ceiling/)).toBeInTheDocument();

    fireEvent.change(daily, { target: { value: "" } });
    fireEvent.blur(daily);
    await waitFor(() => expect(written(calls, "guards:set").at(-1)).toMatchObject({ dailyBudgetCents: null }));
  });

  it("says the run timeout is also the ceiling on a module step's own limit", async () => {
    renderWith(<GuardrailsSection />);
    expect(await screen.findByText(/Also the most a module step may be given/)).toBeInTheDocument();
  });

  it("shows why a run timeout was refused instead of silently reverting", async () => {
    renderWith(<GuardrailsSection />, { refusalBelowMs: 10 * 60_000 });
    const guardrails = await screen.findByRole("region", { name: "Guardrails" });

    const timeout = await within(guardrails).findByLabelText("Run timeout (minutes)");
    fireEvent.change(timeout, { target: { value: "5" } });
    fireEvent.blur(timeout);

    const alert = await within(guardrails).findByRole("alert");
    expect(alert).toHaveTextContent("Not saved");
    expect(alert).toHaveTextContent("Merge");
    expect(alert).toHaveTextContent("20 minutes");
    // The box keeps what was typed, so the person can see what was refused.
    expect(timeout).toHaveValue(5);
  });

  it("keeps what is typed while typing, and saves once when typing pauses (EO-563)", async () => {
    const { calls } = renderWith(<GuardrailsSection />);
    const guardrails = await screen.findByRole("region", { name: "Guardrails" });
    const field = await within(guardrails).findByLabelText("Agent-to-agent mentions before a person is asked");

    for (const typed of ["1", "12", "120"]) {
      fireEvent.change(field, { target: { value: typed } });
      expect(field).toHaveValue(Number(typed));
    }
    expect(written(calls, "guards:set")).toHaveLength(0);

    // No blur: the pause alone saves it.
    await waitFor(() => expect(written(calls, "guards:set")).toHaveLength(1));
    expect(written(calls, "guards:set")[0]).toMatchObject({ agentMentionDepth: 120 });
    expect(field).toHaveValue(120);

    // And it stays 120 once the stored value is read back, with no second save.
    await waitFor(() => expect(calls.filter((call) => call.channel === "guards:get").length).toBeGreaterThan(1));
    expect(field).toHaveValue(120);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(written(calls, "guards:set")).toHaveLength(1);
    expect(field).toHaveValue(120);
  });

  it("saves two quick edits to different fields without the second undoing the first (EO-563)", async () => {
    const { calls, stored } = renderWith(<GuardrailsSection />, { guardsReplyMs: 50 });
    const guardrails = await screen.findByRole("region", { name: "Guardrails" });
    const mentions = await within(guardrails).findByLabelText("Agent-to-agent mentions before a person is asked");
    const trips = within(guardrails).getByLabelText(/^Watch round trips per /);

    fireEvent.change(mentions, { target: { value: "7" } });
    fireEvent.blur(mentions);
    // The first is still waiting on its reply.
    fireEvent.change(trips, { target: { value: "9" } });
    fireEvent.blur(trips);

    await waitFor(() => expect(written(calls, "guards:set")).toHaveLength(2));
    await waitFor(() => expect(stored().guards).toMatchObject({ agentMentionDepth: 7, watchRoundTripsPerItem: 9 }));
    expect(written(calls, "guards:set").at(-1)).toMatchObject({ agentMentionDepth: 7, watchRoundTripsPerItem: 9 });
    expect(mentions).toHaveValue(7);
    expect(trips).toHaveValue(9);
  });

  it("keeps both edits when the section is left and opened again between them (EO-563)", async () => {
    const { calls, stored, rerender } = renderWith(<GuardrailsSection />, { guardsReplyMs: 50 });
    const mentions = await screen.findByLabelText("Agent-to-agent mentions before a person is asked");
    fireEvent.change(mentions, { target: { value: "7" } });
    fireEvent.blur(mentions);

    // Another section, then back, while 7 is still on its way.
    rerender(<p>Elsewhere</p>);
    rerender(<GuardrailsSection />);
    const trips = await screen.findByLabelText(/^Watch round trips per /);
    fireEvent.change(trips, { target: { value: "9" } });
    fireEvent.blur(trips);

    await waitFor(() => expect(written(calls, "guards:set")).toHaveLength(2));
    await waitFor(() => expect(stored().guards).toMatchObject({ agentMentionDepth: 7, watchRoundTripsPerItem: 9 }));
    expect(written(calls, "guards:set").at(-1)).toMatchObject({ agentMentionDepth: 7, watchRoundTripsPerItem: 9 });
    await waitFor(() => expect(screen.getByLabelText("Agent-to-agent mentions before a person is asked")).toHaveValue(7));
    expect(screen.getByLabelText(/^Watch round trips per /)).toHaveValue(9);
  });

  it("keeps saying a field was not saved while another field saves, until that field saves (EO-563)", async () => {
    const { stored } = renderWith(<GuardrailsSection />, { failWhen: { field: "memoryDeliveryChars", value: 6000 } });
    const guardrails = await screen.findByRole("region", { name: "Guardrails" });
    const memory = await within(guardrails).findByLabelText("Memory given whole, in characters");
    const mentions = within(guardrails).getByLabelText("Agent-to-agent mentions before a person is asked");

    fireEvent.change(memory, { target: { value: "6000" } });
    fireEvent.blur(memory);
    expect(await within(guardrails).findByRole("alert")).toHaveTextContent("The database is locked.");

    fireEvent.change(mentions, { target: { value: "7" } });
    fireEvent.blur(mentions);
    await waitFor(() => expect(stored().guards.agentMentionDepth).toBe(7));
    await waitFor(() => expect(mentions).toHaveValue(7));
    // 6000 is still in its box and still unsaved, and the screen still says so.
    expect(memory).toHaveValue(6000);
    expect(within(guardrails).getByRole("alert")).toHaveTextContent("The database is locked.");

    // Its own successful save is what clears it.
    fireEvent.change(memory, { target: { value: "5000" } });
    fireEvent.blur(memory);
    await waitFor(() => expect(within(guardrails).queryByRole("alert")).not.toBeInTheDocument());
    expect(stored().guards).toMatchObject({ memoryDeliveryChars: 5000, agentMentionDepth: 7 });
  });

  it("shows a failed save and keeps what was typed (EO-563)", async () => {
    const { calls } = renderWith(<GuardrailsSection />, { failWhen: { field: "memoryDeliveryChars", value: 6000 } });
    const guardrails = await screen.findByRole("region", { name: "Guardrails" });
    const field = await within(guardrails).findByLabelText("Memory given whole, in characters");

    fireEvent.change(field, { target: { value: "6000" } });
    fireEvent.blur(field);

    const alert = await within(guardrails).findByRole("alert");
    expect(alert).toHaveTextContent("Not saved");
    expect(alert).toHaveTextContent("The database is locked.");
    expect(written(calls, "guards:set")).toHaveLength(1);
    expect(field).toHaveValue(6000);
    // Still there once the stored value has been read back.
    await waitFor(() => expect(calls.filter((call) => call.channel === "guards:get").length).toBeGreaterThan(1));
    expect(field).toHaveValue(6000);
  });
});

describe("the archive section", () => {
  it("saves a number of days, and blank as never", async () => {
    const { calls } = renderWith(<ArchiveSection />);

    const field = await screen.findByLabelText("Archive after (days done, blank = never)");
    expect(field).toHaveValue(14);
    expect(screen.getByText(/A ticket that is blocked or still in progress is never archived/)).toBeInTheDocument();

    fireEvent.change(field, { target: { value: "0" } });
    fireEvent.blur(field);
    await waitFor(() => expect(written(calls, "settings:set").at(-1)).toEqual({ archiveAfterDays: 0 }));
    fireEvent.change(field, { target: { value: "" } });
    fireEvent.blur(field);
    await waitFor(() => expect(written(calls, "settings:set").at(-1)).toEqual({ archiveAfterDays: null }));
  });

  it("keeps what is typed while typing, and saves once when typing pauses (EO-563)", async () => {
    const { calls } = renderWith(<ArchiveSection />);
    const field = await screen.findByLabelText("Archive after (days done, blank = never)");

    for (const typed of ["1", "12", "120"]) {
      fireEvent.change(field, { target: { value: typed } });
      expect(field).toHaveValue(Number(typed));
    }
    await waitFor(() => expect(written(calls, "settings:set")).toEqual([{ archiveAfterDays: 120 }]));
    expect(field).toHaveValue(120);
  });

  it("shows a failed save and keeps what was typed (EO-563)", async () => {
    const { calls } = renderWith(<ArchiveSection />, { failWhen: { field: "archiveAfterDays", value: 30 } });
    const field = await screen.findByLabelText("Archive after (days done, blank = never)");

    fireEvent.change(field, { target: { value: "30" } });
    fireEvent.blur(field);

    expect(await screen.findByRole("alert")).toHaveTextContent("Not saved: The database is locked.");
    expect(written(calls, "settings:set")).toEqual([{ archiveAfterDays: 30 }]);
    expect(field).toHaveValue(30);
  });

  it("opens the archive itself", async () => {
    renderWith(<ArchiveSection />);
    expect(await screen.findByRole("link", { name: "Open the archive" })).toHaveAttribute("href", "/archive");
  });
});
