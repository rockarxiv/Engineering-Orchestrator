import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@eo/ui";
import type { JobEventRow, JobSummary, JobWatchState, ModuleView, WatchTrigger } from "@eo/core";
import { createQueryClient } from "../../../query/client";
import { ItemReferenceProvider } from "../../conversation/ItemReferenceProvider";
import { JobView } from "./JobView";

/**
 * A watch job on its Job page (EO-754): what it was set up with, read-only
 * since EO-787, and how its checks stand — checking normally, failing,
 * paused, and waiting on an item it filed — with what it found on the
 * Events tab.
 */

const PIPELINES = [{ id: "deps", projectId: "p1", name: "Dependency update", icon: null, entryStepId: "todo", position: 0, archivedAt: null }];
const ITEM_TYPES = [
  { packSlug: "developer", slug: "story", label: "Story", plural: "Stories", container: false, specShape: { type: "object", properties: {} }, actionOverrides: {} },
];

function module(overrides: Partial<ModuleView> = {}): ModuleView {
  return {
    id: "mod-alerts",
    slug: "dependabot-alerts",
    name: "Dependabot alerts",
    description: "Finds open Dependabot pull requests.",
    code: "export default async () => ({ ok: true, result: 'waiting' })",
    manifest: {
      name: "Dependabot alerts",
      description: "Finds open Dependabot pull requests.",
      inputs: {
        repo: { type: "string", description: "The repository to read.", default: "rockarxiv/eo" },
        limit: { type: "number", description: "How many at most." },
        drafts: { type: "boolean", description: "Include drafts.", default: false },
      },
      needs: { bin: ["gh"], env: [], network: true, item: false, comment: false, attach: false, create: false },
      results: ["broken"],
      watch: true,
    },
    originalScript: null,
    source: "user",
    approvedAt: 1,
    createdAt: 1,
    updatedAt: 1,
    archivedAt: null,
    usedByStepCount: 0,
    portability: [],
    machineSpecific: [],
    testRun: null,
    testsStale: false,
    testCount: 0,
    ...overrides,
  };
}

const MODULES = [
  module(),
  module({ id: "mod-unapproved", name: "Unapproved watcher", approvedAt: null }),
  module({ id: "mod-once", name: "Runs once", manifest: { ...module().manifest, watch: false } }),
];

const TRIGGER: WatchTrigger = { kind: "watch", moduleId: "mod-alerts", inputs: { repo: "rockarxiv/web" }, everyMinutes: 30, waitWhileOpen: true };
const AT = Date.UTC(2026, 10, 12, 9, 0);

function state(overrides: Partial<JobWatchState> = {}): JobWatchState {
  return {
    lastCheckedAt: AT,
    lastAnswer: "waiting",
    nextCheckAt: AT + 30 * 60_000,
    consecutiveFailures: 0,
    lastError: null,
    waitingForItemId: null,
    waitingForItemKey: null,
    ...overrides,
  };
}

function job(overrides: Partial<JobSummary> = {}): JobSummary {
  return {
    id: "job-1",
    projectId: "p1",
    name: "Dependabot",
    trigger: TRIGGER,
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
    watch: state(),
    ...overrides,
  };
}

function event(overrides: Partial<JobEventRow> = {}): JobEventRow {
  return {
    id: "evt-1",
    jobId: "job-1",
    receivedAt: AT,
    eventKey: "pr-412",
    payload: "",
    outcome: "created",
    reason: null,
    itemId: "item-7",
    itemKey: "DEP-7",
    itemTitle: "Bump vite",
    ...overrides,
  };
}

interface Options {
  job?: JobSummary;
  events?: JobEventRow[];
}

function mockIpc(options: Options = {}) {
  const invoke = vi.fn(async (channel: string, _payload?: unknown) => {
    switch (channel) {
      case "projects:list":
        return { ok: true, data: { projects: [{ id: "p1", name: "EO" }], activeProjectId: "p1" } };
      case "pipelines:list":
        return { ok: true, data: { pipelines: PIPELINES } };
      case "registry:get":
        return { ok: true, data: { roles: [], builtins: [], itemTypes: ITEM_TYPES } };
      case "modules:list":
        return { ok: true, data: { modules: MODULES } };
      case "session:status":
        return { ok: true, data: { state: "solo" } };
      case "jobs:list":
        return { ok: true, data: { jobs: [] } };
      case "jobs:get":
        return { ok: true, data: { job: options.job ?? job(), occurrences: [] } };
      case "jobs:cost":
        return { ok: true, data: { jobId: "job-1", costCents: 0 } };
      case "jobs:events":
        return { ok: true, data: { events: options.events ?? [], heldCount: 0, lastPayload: null } };
      default:
        return { ok: true, data: {} };
    }
  });
  window.eo.ipc.invoke = invoke as never;
  window.eo.ipc.subscribe = vi.fn(() => () => {}) as never;
  return invoke;
}

function renderAt(path: string) {
  return render(
    <ThemeProvider>
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter initialEntries={[path]}>
          <ItemReferenceProvider>
            <Routes>
              <Route path="/jobs/:jobId" element={<JobView jobId="job-1" />} />
            </Routes>
          </ItemReferenceProvider>
        </MemoryRouter>
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

describe("what a watch job was set up with", () => {
  it("states its module, the inputs it sets, its interval and Wait while open, with nothing to change", async () => {
    const invoke = mockIpc();
    renderAt("/jobs/job-1");

    const definition = within(await screen.findByLabelText("Definition"));
    expect(definition.getByText("When its module finds something, checking every 30 minutes")).toBeInTheDocument();
    expect(await definition.findByText("Dependabot alerts")).toBeInTheDocument();
    expect(definition.getByText("rockarxiv/web")).toBeInTheDocument();
    expect(definition.getByText(/^Yes: no check runs/)).toBeInTheDocument();
    // An input the trigger leaves out is the module's default, and is not listed.
    expect(definition.queryByText(/limit/)).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(invoke.mock.calls.some((call: unknown[]) => call[0] === "jobs:update")).toBe(false);
  });

  it("names a module that is no longer installed by its id", async () => {
    mockIpc({ job: job({ trigger: { ...TRIGGER, moduleId: "mod-gone", inputs: {}, waitWhileOpen: false } }) });
    renderAt("/jobs/job-1");

    const definition = within(await screen.findByLabelText("Definition"));
    expect(await definition.findByText("mod-gone (not installed)")).toBeInTheDocument();
    expect(definition.getByText("No")).toBeInTheDocument();
  });
});

describe("a watch job's page", () => {
  it("says when it last checked and what it answered, and when it checks next", async () => {
    mockIpc();
    renderAt("/jobs/job-1");

    const checks = await screen.findByLabelText("Checks");
    expect(within(checks).getByText(/^Last checked .*, and answered waiting\.$/)).toBeInTheDocument();
    expect(within(checks).getByText(/^Next check /)).toBeInTheDocument();
    expect(within(checks).queryByText(/failed check/)).not.toBeInTheDocument();
    // Run now is refused for a watch job, so it is not offered.
    expect(screen.queryByRole("button", { name: "Run now" })).not.toBeInTheDocument();
  });

  it("says how many checks failed in a row and the last error", async () => {
    mockIpc({ job: job({ watch: state({ lastAnswer: "failed", consecutiveFailures: 3, lastError: "gh: not logged in" }) }) });
    renderAt("/jobs/job-1");

    const checks = await screen.findByLabelText("Checks");
    expect(within(checks).getByText("3 failed checks in a row. Last error: gh: not logged in")).toBeInTheDocument();
  });

  it("says a paused job does not check until it is resumed", async () => {
    mockIpc({ job: job({ pausedAt: AT, pausedReason: "watch", watch: state({ lastAnswer: "broken", nextCheckAt: null }) }) });
    renderAt("/jobs/job-1");

    const checks = await screen.findByLabelText("Checks");
    expect(within(checks).getByText(/answered broken\./)).toBeInTheDocument();
    expect(within(checks).getByText("Paused: it does not check again until you resume it.")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Paused" })).toHaveAttribute("aria-checked", "true");
  });

  it("names the item it is waiting for", async () => {
    mockIpc({ job: job({ watch: state({ waitingForItemId: "item-7", waitingForItemKey: "DEP-7" }) }) });
    renderAt("/jobs/job-1");

    const checks = await screen.findByLabelText("Checks");
    expect(within(checks).getByRole("link", { name: "DEP-7" })).toHaveAttribute("href", "/items/item-7");
    expect(within(checks).getByText("Next check once that item is finished.")).toBeInTheDocument();
  });

  it("lists each finding filed or refused on its Events tab, with its key and its item or reason", async () => {
    mockIpc({
      events: [
        event({ id: "evt-2", eventKey: "pr-413", outcome: "refused", reason: "Dependency update needs a repository.", itemId: null, itemKey: null, itemTitle: null }),
        event(),
      ],
    });
    renderAt("/jobs/job-1");

    fireEvent.click(await screen.findByRole("tab", { name: /Events/ }));
    const list = within(screen.getByRole("region", { name: "Events" }));
    expect(list.getByText("pr-413")).toBeInTheDocument();
    expect(list.getByText("Dependency update needs a repository.")).toBeInTheDocument();
    expect(list.getByText("pr-412")).toBeInTheDocument();
    expect(list.getByRole("link", { name: "DEP-7" })).toHaveAttribute("href", "/items/item-7");
  });

  it("says plainly when it has found nothing yet", async () => {
    mockIpc();
    renderAt("/jobs/job-1");

    fireEvent.click(await screen.findByRole("tab", { name: /Events/ }));
    expect(screen.getByText("It has not found anything yet.")).toBeInTheDocument();
  });
});
