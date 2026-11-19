import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@eo/ui";
import type { JobSummary, JobWatchState, WatchTrigger } from "@eo/core";
import { whenOf } from "../../../shared/jobs/format";
import { createQueryClient } from "../../../query/client";
import { AskAssistantContext, type AskAssistant } from "../../askAssistant";
import { JobsView } from "./JobsView";

/** The Jobs list in the chat layout (`jobs/JobsList.test.tsx` is the model). */

const PIPELINES = [{ id: "default", projectId: "p1", name: "Delivery", icon: null, entryStepId: "todo", position: 0, archivedAt: null }];
const ITEM_TYPES = [
  { packSlug: "developer", slug: "story", label: "Story", plural: "Stories", container: false, specShape: { type: "object", properties: {} }, actionOverrides: {} },
];

const WATCH: WatchTrigger = { kind: "watch", moduleId: "mod-alerts", inputs: {}, everyMinutes: 30, waitWhileOpen: true };
const WATCH_STATE: JobWatchState = {
  lastCheckedAt: null,
  lastAnswer: null,
  nextCheckAt: null,
  consecutiveFailures: 0,
  lastError: null,
  waitingForItemId: null,
  waitingForItemKey: null,
};

function job(overrides: Partial<JobSummary> = {}): JobSummary {
  return {
    id: "job-1",
    projectId: "p1",
    name: "Monday report",
    trigger: { kind: "schedule", schedule: { kind: "weekly", weekday: 1, hour: 8, minute: 0 }, timeZone: "Europe/Berlin", catchUpWithinMinutes: 180 },
    pipelineId: "default",
    template: { type: "developer:story", title: "{{job}}", body: null },
    ownerId: "person-1",
    pausedAt: null,
    budgetPerOccurrenceCents: null,
    maxItemsPerHour: null,
    runsOn: "device",
    deletedAt: null,
    createdAt: 1,
    updatedAt: 1,
    nextRunAt: Date.UTC(2026, 5, 1, 6, 0),
    lastRunAt: null,
    lastStatus: null,
    watch: null,
    workspaceId: null,
    workspaceName: null,
    pausedReason: null,
    ...overrides,
  };
}

function mockIpc(options: { jobs?: JobSummary[] } = {}) {
  const invoke = vi.fn(async (channel: string, _payload?: unknown) => {
    switch (channel) {
      case "projects:list":
        return { ok: true, data: { projects: [{ id: "p1", name: "EO" }], activeProjectId: "p1" } };
      case "pipelines:list":
        return { ok: true, data: { pipelines: PIPELINES } };
      case "registry:get":
        return { ok: true, data: { roles: [], builtins: [], itemTypes: ITEM_TYPES } };
      case "jobs:list":
        return { ok: true, data: { jobs: [...(options.jobs ?? [])] } };
      default:
        return { ok: true, data: {} };
    }
  });
  window.eo.ipc.invoke = invoke as never;
  window.eo.ipc.subscribe = vi.fn(() => () => {}) as never;
  return invoke;
}

function renderList(askAssistant: AskAssistant | null = null) {
  return render(
    <ThemeProvider>
      <QueryClientProvider client={createQueryClient()}>
        <AskAssistantContext.Provider value={askAssistant}>
          <MemoryRouter initialEntries={["/jobs"]}>
            <Routes>
              <Route path="/jobs" element={<JobsView />} />
              <Route path="/jobs/:jobId" element={<span data-testid="job-page" />} />
              <Route path="/chat" element={<span data-testid="chat" />} />
            </Routes>
          </MemoryRouter>
        </AskAssistantContext.Provider>
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

describe("the Jobs list in the chat layout", () => {
  it("says what has never been set up, rather than showing an empty list", async () => {
    mockIpc();
    renderList();

    expect(await screen.findByText(/Nothing files work on its own here yet/)).toBeInTheDocument();
  });

  it("names each job, its trigger, and when it last and next comes round in its own zone", async () => {
    mockIpc({ jobs: [job()] });
    renderList();

    expect(await screen.findByText("Monday report")).toBeInTheDocument();
    expect(screen.getByText("Mondays at 08:00")).toBeInTheDocument();
    expect(screen.getByText(/^Next run .*08:00/)).toBeInTheDocument();
    expect(screen.getByText(/Last run —/)).toBeInTheDocument();
  });

  it("says when a watch job last checked and checks next, rather than its calendar's dashes", async () => {
    const at = Date.UTC(2026, 10, 12, 9, 0);
    mockIpc({
      jobs: [
        job({
          name: "Dependabot",
          trigger: WATCH,
          nextRunAt: null,
          watch: { ...WATCH_STATE, lastCheckedAt: at, nextCheckAt: at + 30 * 60_000 },
        }),
      ],
    });
    renderList();

    expect(await screen.findByText(`Last checked ${whenOf(at)}`)).toBeInTheDocument();
    expect(screen.getByText(`Next check ${whenOf(at + 30 * 60_000)}`)).toBeInTheDocument();
    expect(screen.queryByText(/Next run/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Last run/)).not.toBeInTheDocument();
  });

  it("says a paused watch job is paused, and one that never checked has not", async () => {
    mockIpc({ jobs: [job({ name: "Dependabot", trigger: WATCH, nextRunAt: null, pausedAt: 5, pausedReason: "by hand", watch: WATCH_STATE })] });
    renderList();

    expect(await screen.findByText("Paused")).toBeInTheDocument();
    expect(screen.getByText("Not checked yet")).toBeInTheDocument();
  });

  it("names the item a watch job waits for before it checks again", async () => {
    mockIpc({ jobs: [job({ name: "Dependabot", trigger: WATCH, nextRunAt: null, watch: { ...WATCH_STATE, waitingForItemId: "item-7", waitingForItemKey: "DEP-7" } })] });
    renderList();

    expect(await screen.findByText("Next check once DEP-7 is finished")).toBeInTheDocument();
  });

  it("wears the chip a paused job has, and says which kind of pause it is", async () => {
    mockIpc({ jobs: [job({ pausedAt: 5, pausedReason: "budget" }), job({ id: "job-2", name: "Nightly sweep", pausedAt: 5, pausedReason: "by hand" })] });
    renderList();

    expect(await screen.findByText("paused: daily budget reached")).toBeInTheDocument();
    expect(screen.getByText("paused")).toBeInTheDocument();
  });

  it("opens a job's own view from its row", async () => {
    mockIpc({ jobs: [job()] });
    renderList();

    fireEvent.click(await screen.findByRole("link", { name: /Monday report/ }));

    expect(await screen.findByTestId("job-page")).toBeInTheDocument();
  });

  it("has no New job button and no form, and says who sets jobs up instead", async () => {
    const invoke = mockIpc({ jobs: [job()] });
    renderList();

    expect(await screen.findByText("Jobs are set up by the assistant, or by an agent connected to EO.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /New job/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create job" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(invoke.mock.calls.some((call: unknown[]) => call[0] === "jobs:create")).toBe(false);
  });

  it("opens the assistant conversation from that line", async () => {
    mockIpc();
    const askAssistant = vi.fn();
    renderList(askAssistant);

    fireEvent.click(await screen.findByRole("button", { name: "Ask the assistant" }));

    expect(askAssistant).toHaveBeenCalledTimes(1);
  });

  it("goes to the chat when there is no conversation column to open", async () => {
    mockIpc();
    renderList();

    fireEvent.click(await screen.findByRole("button", { name: "Ask the assistant" }));

    expect(await screen.findByTestId("chat")).toBeInTheDocument();
  });
});
