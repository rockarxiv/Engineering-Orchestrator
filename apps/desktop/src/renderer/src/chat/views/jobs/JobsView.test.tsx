import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@eo/ui";
import type { JobSummary } from "@eo/core";
import { createQueryClient } from "../../../query/client";
import { JobsView } from "./JobsView";

/** The Jobs list in the chat layout (`jobs/JobsList.test.tsx` is the model). */

const PIPELINES = [{ id: "default", projectId: "p1", name: "Delivery", icon: null, entryStepId: "todo", position: 0, archivedAt: null }];
const ITEM_TYPES = [
  { packSlug: "developer", slug: "story", label: "Story", plural: "Stories", container: false, specShape: { type: "object", properties: {} }, actionOverrides: {} },
];

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
    pausedReason: null,
    ...overrides,
  };
}

function mockIpc(options: { jobs?: JobSummary[]; onCreate?: (payload: unknown) => unknown } = {}) {
  const invoke = vi.fn(async (channel: string, payload: unknown) => {
    switch (channel) {
      case "projects:list":
        return { ok: true, data: { projects: [{ id: "p1", name: "EO" }], activeProjectId: "p1" } };
      case "pipelines:list":
        return { ok: true, data: { pipelines: PIPELINES } };
      case "registry:get":
        return { ok: true, data: { roles: [], builtins: [], itemTypes: ITEM_TYPES } };
      case "jobs:list":
        return { ok: true, data: { jobs: [...(options.jobs ?? [])] } };
      case "jobs:create":
        return { ok: true, data: options.onCreate?.(payload) ?? { job: job(), problem: null } };
      default:
        return { ok: true, data: {} };
    }
  });
  window.eo.ipc.invoke = invoke as never;
  window.eo.ipc.subscribe = vi.fn(() => () => {}) as never;
  return invoke;
}

function renderList() {
  return render(
    <ThemeProvider>
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter initialEntries={["/jobs"]}>
          <Routes>
            <Route path="/jobs" element={<JobsView />} />
            <Route path="/jobs/:jobId" element={<span data-testid="job-page" />} />
          </Routes>
        </MemoryRouter>
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

  it("makes a job from the form and opens its view", async () => {
    const invoke = mockIpc();
    renderList();

    fireEvent.click(await screen.findByRole("button", { name: "New job" }));
    await screen.findByRole("option", { name: "Delivery" });
    await screen.findByRole("option", { name: "Story" });
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "Monday report" } });
    fireEvent.change(screen.getByLabelText(/^Pipeline/), { target: { value: "default" } });
    fireEvent.change(screen.getByLabelText(/^Type/), { target: { value: "developer:story" } });
    fireEvent.change(screen.getByLabelText(/^Title/), { target: { value: "{{job}} for {{date}}" } });
    fireEvent.click(screen.getByRole("button", { name: "Create job" }));

    await screen.findByTestId("job-page");
    expect(invoke.mock.calls.find((call: unknown[]) => call[0] === "jobs:create")?.[1]).toMatchObject({
      projectId: "p1",
      name: "Monday report",
      pipelineId: "default",
      template: { type: "developer:story", title: "{{job}} for {{date}}", body: null },
    });
  });

  it("shows the refusal beside the form, and stays on the form", async () => {
    mockIpc({ onCreate: () => ({ job: null, problem: "That pipeline no longer exists." }) });
    renderList();

    fireEvent.click(await screen.findByRole("button", { name: "New job" }));
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "Monday report" } });
    fireEvent.click(screen.getByRole("button", { name: "Create job" }));

    await waitFor(() => expect(screen.getByText("That pipeline no longer exists.")).toBeInTheDocument());
    expect(screen.queryByTestId("job-page")).not.toBeInTheDocument();
  });

  it("offers a weekday only for a weekly schedule, and an expression for cron", async () => {
    mockIpc();
    renderList();

    fireEvent.click(await screen.findByRole("button", { name: "New job" }));
    expect(screen.queryByLabelText("Day")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Schedule"), { target: { value: "weekly" } });
    expect(screen.getByLabelText("Day")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Schedule"), { target: { value: "cron" } });
    expect(screen.getByLabelText(/^Expression/)).toHaveValue("0 8 * * 1");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("button", { name: "Create job" })).not.toBeInTheDocument();
  });
});
