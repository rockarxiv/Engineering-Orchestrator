import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { JobSummary, ModuleView } from "@eo/core";
import { createQueryClient } from "../../../query/client";
import { PipelineTitle } from "./header";
import { watchIntakesOf } from "./WatchIntake";

/**
 * What feeds a pipeline from a watch (EO-754), on the head the board and
 * the graph share: the job's name, the module and how often it checks,
 * linking to the job — and nothing for a pipeline no watch job files onto.
 */

const MODULE = { id: "mod-alerts", name: "Dependabot alerts" } as ModuleView;

function job(overrides: Partial<JobSummary> = {}): JobSummary {
  return {
    id: "job-1",
    projectId: "p1",
    name: "Dependabot",
    trigger: { kind: "watch", moduleId: "mod-alerts", inputs: {}, everyMinutes: 30, waitWhileOpen: false },
    pipelineId: "deps",
    template: { type: "developer:story", title: "Update a dependency", body: null },
    ownerId: "person-1",
    pausedAt: null,
    pausedReason: null,
    budgetPerOccurrenceCents: null,
    maxItemsPerHour: null,
    runsOn: "device",
    deletedAt: null,
    createdAt: 1,
    updatedAt: 1,
    nextRunAt: null,
    lastRunAt: null,
    lastStatus: null,
    watch: null,
    ...overrides,
  };
}

function renderHead(jobs: JobSummary[]) {
  const invoke = vi.fn(async (channel: string, _payload?: unknown) => {
    if (channel === "jobs:list") return { ok: true, data: { jobs } };
    if (channel === "modules:list") return { ok: true, data: { modules: [MODULE] } };
    return { ok: true, data: {} };
  });
  window.eo.ipc.invoke = invoke as never;
  window.eo.ipc.subscribe = vi.fn(() => () => {}) as never;
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={["/pipelines/deps"]}>
        <PipelineTitle name="Dependency update" pipelineId="deps" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return invoke;
}

describe("a pipeline's head says what watch feeds it", () => {
  it("names the job, its module and how often it checks, linking to the job", async () => {
    const invoke = renderHead([job()]);

    const link = await screen.findByRole("link", { name: "Fed by Dependabot · Dependabot alerts, every 30 minutes" });
    expect(link).toHaveAttribute("href", "/jobs/job-1");
    expect(invoke.mock.calls.find((call: unknown[]) => call[0] === "jobs:list")?.[1]).toEqual({ pipelineId: "deps" });
  });

  it("says nothing for a pipeline only other kinds of job file onto", async () => {
    const invoke = renderHead([job({ trigger: { kind: "manual" } })]);

    await waitFor(() => expect(invoke.mock.calls.some((call: unknown[]) => call[0] === "jobs:list")).toBe(true));
    expect(screen.queryByText(/^Fed by/)).not.toBeInTheDocument();
  });
});

describe("watchIntakesOf", () => {
  it("names a module it cannot find by its id, says a paused job is paused, and leaves out a deleted one", () => {
    const intakes = watchIntakesOf(
      [job({ trigger: { kind: "watch", moduleId: "gone", inputs: {}, everyMinutes: 1, waitWhileOpen: false }, pausedAt: 5 }), job({ id: "job-2", deletedAt: 9 })],
      [MODULE],
    );
    expect(intakes).toEqual([{ jobId: "job-1", jobName: "Dependabot", moduleName: "gone", everyMinutes: 1, paused: true }]);
  });
});
