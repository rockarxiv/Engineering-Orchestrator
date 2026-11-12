import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@eo/ui";
import type { JobEventRow, JobOccurrenceRow, JobSummary, WebhookTrigger } from "@eo/core";
import { createQueryClient } from "../../../query/client";
import { ItemReferenceProvider } from "../../conversation/ItemReferenceProvider";
import { JobView } from "./JobView";

/**
 * One job, as a full editor, in the chat layout — `jobs/JobPage.test.tsx`
 * and `jobs/Webhook.test.tsx` are the models, and every claim they make
 * about the page is made here of the view.
 */

const PIPELINES = [{ id: "default", projectId: "p1", name: "Delivery", icon: null, entryStepId: "todo", position: 0, archivedAt: null }];
const ITEM_TYPES = [
  {
    packSlug: "developer",
    slug: "story",
    label: "Story",
    plural: "Stories",
    container: false,
    specShape: { type: "object", properties: { severity: { type: "string", title: "severity" } }, required: [] },
    actionOverrides: {},
  },
];

/** 08:00 Berlin on Monday 1 June 2026 is 06:00Z; 08:00 New York is 12:00Z. */
const MONDAY_0800_BERLIN = Date.UTC(2026, 5, 1, 6, 0);
const MONDAY_0800_NEW_YORK = Date.UTC(2026, 5, 1, 12, 0);

function job(overrides: Partial<JobSummary> = {}): JobSummary {
  return {
    id: "job-1",
    projectId: "p1",
    name: "Monday report",
    trigger: { kind: "schedule", schedule: { kind: "daily", hour: 8, minute: 0 }, timeZone: "Europe/Berlin", catchUpWithinMinutes: 180 },
    pipelineId: "default",
    template: { type: "developer:story", title: "{{job}} for {{date}}", body: null },
    ownerId: "person-1",
    pausedAt: null,
    budgetPerOccurrenceCents: 500,
    maxItemsPerHour: null,
    runsOn: "device",
    deletedAt: null,
    createdAt: 1,
    updatedAt: 1,
    nextRunAt: MONDAY_0800_BERLIN,
    lastRunAt: null,
    lastStatus: null,
    watch: null,
    pausedReason: null,
    ...overrides,
  };
}

function occurrence(overrides: Partial<JobOccurrenceRow> = {}): JobOccurrenceRow {
  return {
    id: "occ-1",
    jobId: "job-1",
    dueAt: MONDAY_0800_BERLIN,
    firedAt: MONDAY_0800_BERLIN,
    status: "fired",
    reason: null,
    itemId: "t1",
    offerCommentId: null,
    itemKey: "EO-1",
    itemTitle: "Monday report for 1 June",
    costCents: 42,
    durationMs: 90_000,
    ...overrides,
  };
}

const SECRET = "b6b8a2f0c1d24e7fa3b5c6d7e8f90112b6b8a2f0c1d24e7fa3b5c6d7e8f90112";
const WEBHOOK: WebhookTrigger = {
  kind: "webhook",
  path: "helpdesk",
  secret: SECRET,
  mapping: { title: "/issue/fields/summary", body: null, eventKey: "/delivery_id", spec: {} },
};
const LAST_PAYLOAD = JSON.stringify({ delivery_id: "evt-1", issue: { fields: { summary: "Printer on fire", priority: "P1" } } });
const HELPDESK = job({ name: "Helpdesk", trigger: WEBHOOK, template: { type: "developer:story", title: "A support request", body: null }, nextRunAt: null });

function event(overrides: Partial<JobEventRow> = {}): JobEventRow {
  return {
    id: "evt-row-1",
    jobId: "job-1",
    receivedAt: MONDAY_0800_BERLIN,
    eventKey: "evt-1",
    payload: LAST_PAYLOAD,
    outcome: "created",
    reason: null,
    itemId: "item-9",
    itemKey: "EO-9",
    itemTitle: "Printer on fire",
    ...overrides,
  };
}

interface Options {
  jobs?: (JobSummary | null)[];
  occurrences?: JobOccurrenceRow[];
  onUpdate?: (payload: unknown) => unknown;
  events?: JobEventRow[];
  heldCount?: number;
  lastPayload?: string | null;
  onTest?: () => unknown;
  session?: unknown;
  placement?: unknown;
  machine?: unknown;
}

function mockIpc(options: Options = {}) {
  // A queue, so a test can answer one thing before a save and another after.
  const answers = [...(options.jobs ?? [job()])];
  const invoke = vi.fn(async (channel: string, payload: unknown) => {
    switch (channel) {
      case "projects:list":
        return { ok: true, data: { projects: [{ id: "p1", name: "EO" }], activeProjectId: "p1" } };
      case "pipelines:list":
        return { ok: true, data: { pipelines: PIPELINES } };
      case "registry:get":
        return { ok: true, data: { roles: [], builtins: [], itemTypes: ITEM_TYPES } };
      case "items:list":
      case "items:listArchived":
        return { ok: true, data: { items: [] } };
      case "session:status":
        return { ok: true, data: options.session ?? { state: "solo" } };
      case "jobs:get":
        return { ok: true, data: { job: answers.length > 1 ? answers.shift() : answers[0], occurrences: [...(options.occurrences ?? [])] } };
      case "jobs:cost":
        return { ok: true, data: { jobId: "job-1", costCents: 142 } };
      case "jobs:placement":
        return { ok: true, data: { placement: options.placement ?? { runsOn: "device", machineBound: [], serverBound: [] }, machine: options.machine ?? null } };
      case "jobs:update":
        return { ok: true, data: options.onUpdate?.(payload) ?? { job: job(), problem: null } };
      case "jobs:runNow":
        return { ok: true, data: { fired: true, occurrence: null, itemId: "t9", problem: null } };
      case "jobs:pause":
      case "jobs:resume":
        return { ok: true, data: { job: job() } };
      case "jobs:delete":
        return { ok: true, data: { deleted: true, archivedItemCount: 2 } };
      case "jobs:events":
        return {
          ok: true,
          data: { events: options.events ?? [], heldCount: options.heldCount ?? 0, lastPayload: options.lastPayload === undefined ? LAST_PAYLOAD : options.lastPayload },
        };
      case "jobs:testEvent":
        return { ok: true, data: options.onTest?.() ?? { outcome: "created", itemId: "item-9", itemKey: "EO-9", problem: null } };
      case "jobs:regenerateSecret":
        return { ok: true, data: { job: HELPDESK, problem: null } };
      default:
        return { ok: true, data: {} };
    }
  });
  window.eo.ipc.invoke = invoke as never;
  window.eo.ipc.subscribe = vi.fn(() => () => {}) as never;
  return invoke;
}

function Where() {
  const location = useLocation();
  return <div data-testid="where">{`${location.pathname}${location.search}`}</div>;
}

function renderView() {
  return render(
    <ThemeProvider>
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter initialEntries={["/jobs/job-1"]}>
          <ItemReferenceProvider>
            <Routes>
              <Route path="/jobs/:jobId" element={<JobView jobId="job-1" />} />
              <Route path="*" element={<span data-testid="elsewhere" />} />
            </Routes>
            <Where />
          </ItemReferenceProvider>
        </MemoryRouter>
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

const calls = (invoke: ReturnType<typeof mockIpc>, channel: string) => invoke.mock.calls.filter((call: unknown[]) => call[0] === channel);

describe("what the job view states", () => {
  it("says the zone the schedule is in, and that the job runs while EO is open here", async () => {
    mockIpc();
    renderView();

    expect(await screen.findByText(/Times are in Europe\/Berlin/)).toBeInTheDocument();
    expect(screen.getByText("Runs while EO is open on this machine.")).toBeInTheDocument();
  });

  it("shows the next run in the job's zone, the last run and what it has spent", async () => {
    mockIpc();
    renderView();

    expect(await screen.findByText(/^Next run .*08:00/)).toBeInTheDocument();
    expect(screen.getByText("Last run —")).toBeInTheDocument();
    expect(screen.getByText("Spent $1.42")).toBeInTheDocument();
  });

  it("lists every occurrence, including the skipped ones", async () => {
    mockIpc({
      occurrences: [
        occurrence({ id: "occ-2", status: "skipped", firedAt: null, reason: "offline beyond grace", itemId: null, itemKey: null, itemTitle: null, costCents: 0, durationMs: null }),
        occurrence(),
      ],
    });
    renderView();

    expect(await screen.findByText("skipped: offline beyond grace")).toBeInTheDocument();
    expect(screen.getByText("Fired")).toBeInTheDocument();
    expect(screen.getByText("42¢")).toBeInTheDocument();
    expect(screen.getByText("1m 30s")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "EO-1" })).toHaveAttribute("href", "/items/t1");
  });

  it("links to its items on the board and in the archive, narrowed to the job", async () => {
    mockIpc();
    renderView();

    expect(await screen.findByRole("link", { name: "Its items on the board" })).toHaveAttribute("href", "/pipelines/default?job=job-1");
    expect(screen.getByRole("link", { name: "In the archive" })).toHaveAttribute("href", "/archive?job=job-1");
  });

  it("says there is no job here, and that its work still names it", async () => {
    mockIpc({ jobs: [null] });
    renderView();

    expect(await screen.findByText(/There is no job here/)).toBeInTheDocument();
  });
});

describe("editing the schedule and the zone", () => {
  it("sends the new schedule and shows the next run it produces", async () => {
    const invoke = mockIpc({
      jobs: [
        job(),
        job({
          trigger: { kind: "schedule", schedule: { kind: "daily", hour: 8, minute: 0 }, timeZone: "America/New_York", catchUpWithinMinutes: 180 },
          nextRunAt: MONDAY_0800_NEW_YORK,
        }),
      ],
    });
    renderView();

    const nextRun = () => screen.getByText(/^Next run /).textContent ?? "";
    await screen.findByText(/^Next run .*08:00/);
    const berlin = nextRun();

    fireEvent.change(screen.getByLabelText(/^Time zone/), { target: { value: "America/New_York" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(nextRun()).not.toBe(berlin));
    expect(nextRun()).toMatch(/08:00/);
    expect(calls(invoke, "jobs:update")[0]?.[1]).toMatchObject({
      jobId: "job-1",
      trigger: { kind: "schedule", schedule: { kind: "daily", hour: 8, minute: 0 }, timeZone: "America/New_York" },
    });
  });

  it("shows a refusal rather than pretending the edit landed", async () => {
    mockIpc({ onUpdate: () => ({ job: null, problem: '"Europe/Berln" is not a time zone this machine knows.' }) });
    renderView();

    await screen.findByText("Runs while EO is open on this machine.");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText('"Europe/Berln" is not a time zone this machine knows.')).toBeInTheDocument();
  });
});

describe("the controls a person reaches for", () => {
  it("runs it now", async () => {
    const invoke = mockIpc();
    renderView();

    fireEvent.click(await screen.findByRole("button", { name: "Run now" }));

    await waitFor(() => expect(calls(invoke, "jobs:runNow")).toHaveLength(1));
    expect(await screen.findByText("Filed.")).toBeInTheDocument();
  });

  it("pauses it", async () => {
    const invoke = mockIpc();
    renderView();

    fireEvent.click(await screen.findByRole("switch", { name: "Paused" }));

    await waitFor(() => expect(calls(invoke, "jobs:pause")).toHaveLength(1));
  });

  it("resumes a paused one, and wears the pause chip", async () => {
    const invoke = mockIpc({ jobs: [job({ pausedAt: 5, pausedReason: "budget" })] });
    renderView();

    expect(await screen.findByText("paused: daily budget reached")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch", { name: "Paused" }));

    await waitFor(() => expect(calls(invoke, "jobs:resume")).toHaveLength(1));
  });

  it("offers both answers about the work it filed, and sends the one pressed", async () => {
    const invoke = mockIpc();
    renderView();

    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    const dialog = screen.getByRole("dialog", { name: 'Delete "Monday report"?' });
    expect(within(dialog).getByRole("button", { name: "Keep them" })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Archive its items" }));

    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/jobs"));
    expect(calls(invoke, "jobs:delete")[0]?.[1]).toEqual({ jobId: "job-1", archiveItems: true });
  });

  it("keeps the items when that is the answer", async () => {
    const invoke = mockIpc();
    renderView();

    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep them" }));

    await waitFor(() => expect(calls(invoke, "jobs:delete")[0]?.[1]).toEqual({ jobId: "job-1", archiveItems: false }));
  });

  it("closes the delete question without deleting", async () => {
    const invoke = mockIpc();
    renderView();

    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(calls(invoke, "jobs:delete")).toHaveLength(0);
  });
});

describe("the Runs on control", () => {
  const SIGNED_IN = { state: "signed-in", address: "https://eo.example", email: "anna@example.com", personId: "anna", personName: "Anna", isAdmin: false, deviceId: "d1", deviceName: "Anna's MacBook" };

  it("is hidden in solo mode, and the placement is never asked", async () => {
    const invoke = mockIpc();
    renderView();

    expect(await screen.findByText("Runs while EO is open on this machine.")).toBeInTheDocument();
    expect(calls(invoke, "jobs:placement")).toHaveLength(0);
  });

  it("offers both places in managed mode, and names the machine a device job runs on", async () => {
    mockIpc({ session: SIGNED_IN, machine: { name: "Anna's MacBook", lastSeenAt: Date.now() - 3 * 60 * 60 * 1000 } });
    renderView();

    expect(await screen.findByLabelText("Runs on")).toBeInTheDocument();
    expect(screen.getByText(/Runs while EO is open on Anna's MacBook · last online 3h ago/)).toBeInTheDocument();
    expect(screen.queryByText("Runs while EO is open on this machine.")).not.toBeInTheDocument();
  });

  it("moves the job the moment a place is picked, and draws a refusal beside the control", async () => {
    const invoke = mockIpc({ session: SIGNED_IN, onUpdate: () => ({ job: null, problem: "This job cannot run on organisation server, so nothing was saved." }) });
    renderView();

    fireEvent.change(await screen.findByLabelText("Runs on"), { target: { value: "server" } });

    expect(await screen.findByText(/cannot run on organisation server/)).toBeInTheDocument();
    expect(calls(invoke, "jobs:update")[0]?.[1]).toEqual({ jobId: "job-1", runsOn: "server" });
  });
});

describe("a webhook job", () => {
  it("states the address to post to and the secret to sign with, and copies each", async () => {
    mockIpc({ jobs: [HELPDESK] });
    const written: string[] = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: (text: string) => written.push(text) } });
    renderView();

    expect(await screen.findByText("http://localhost:3000/webhooks/helpdesk")).toBeInTheDocument();
    expect(screen.getByText(SECRET)).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Copy url"));
    fireEvent.click(screen.getByLabelText("Copy signing secret"));

    expect(written).toEqual(["http://localhost:3000/webhooks/helpdesk", SECRET]);
  });

  it("asks before regenerating the secret", async () => {
    const invoke = mockIpc({ jobs: [HELPDESK] });
    renderView();

    fireEvent.click(await screen.findByRole("button", { name: "Regenerate" }));
    expect(screen.getByText(/Everything sending with the old secret starts being refused/)).toBeInTheDocument();
    expect(calls(invoke, "jobs:regenerateSecret")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Regenerate anyway" }));

    await waitFor(() => expect(calls(invoke, "jobs:regenerateSecret")).toHaveLength(1));
    expect(await screen.findByText(/The old one stops working now/)).toBeInTheDocument();
  });

  it("sends a test event and links the item it filed", async () => {
    mockIpc({ jobs: [HELPDESK] });
    renderView();

    fireEvent.click(await screen.findByRole("button", { name: "Send test event" }));

    expect(await screen.findByText(/^Created\./)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "EO-9" })).toHaveAttribute("href", "/items/item-9");
  });

  it("says what the door answered when a test event was not a creation", async () => {
    mockIpc({ jobs: [HELPDESK], onTest: () => ({ outcome: "held", itemId: null, itemKey: null, problem: "This job files at most 10 items an hour, and it has filed 10 in the last hour." }) });
    renderView();

    fireEvent.click(await screen.findByRole("button", { name: "Send test event" }));

    expect(await screen.findByText(/^Waiting\. This job files at most 10 items an hour/)).toBeInTheDocument();
  });

  it("draws a mapping row per template field, the type's spec fields included", async () => {
    mockIpc({ jobs: [HELPDESK] });
    renderView();

    expect(await screen.findByLabelText("Title pointer")).toHaveValue("/issue/fields/summary");
    expect(screen.getByLabelText("Body pointer")).toHaveValue("");
    expect(screen.getByLabelText("Severity pointer")).toHaveValue("");
    expect(screen.getByLabelText("Event key pointer")).toHaveValue("/delivery_id");
  });

  it("previews from the last payload as a pointer is typed, and sends nothing", async () => {
    const invoke = mockIpc({ jobs: [HELPDESK] });
    renderView();

    expect(await screen.findByText("Printer on fire")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Severity pointer"), { target: { value: "/issue/fields/priority" } });

    expect(await screen.findByText("P1")).toBeInTheDocument();
    expect([...calls(invoke, "jobs:update"), ...calls(invoke, "jobs:testEvent")]).toHaveLength(0);
  });

  it("says which kind of nothing a pointer found", async () => {
    mockIpc({ jobs: [HELPDESK] });
    renderView();

    fireEvent.change(await screen.findByLabelText("Body pointer"), { target: { value: "/nowhere" } });
    expect(await screen.findByText("Nothing there")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Body pointer"), { target: { value: "nowhere" } });
    expect(await screen.findByText(/has to start with \//)).toBeInTheDocument();
  });

  it("previews nothing when nothing has arrived, rather than blaming the pointer", async () => {
    mockIpc({ jobs: [HELPDESK], lastPayload: null });
    renderView();

    expect(await screen.findAllByText("Nothing has arrived yet")).toHaveLength(2);
  });

  it("saves the trigger it arrived with, with the pointers as they now stand", async () => {
    const saved: unknown[] = [];
    mockIpc({
      jobs: [HELPDESK],
      onUpdate: (payload) => {
        saved.push(payload);
        return { job: HELPDESK, problem: null };
      },
    });
    renderView();

    fireEvent.change(await screen.findByLabelText("Title pointer"), { target: { value: "/issue/fields/title" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]).toMatchObject({
      trigger: { kind: "webhook", path: "helpdesk", secret: SECRET, mapping: { title: "/issue/fields/title", eventKey: "/delivery_id" } },
    });
  });

  it("offers no way to turn a webhook job into a scheduled one", async () => {
    mockIpc({ jobs: [HELPDESK] });
    renderView();

    // Twice: the status states it as the job's trigger, and the form where the picker would be.
    await screen.findByLabelText("Title pointer");
    expect(screen.getAllByText("When an event arrives at its webhook")).toHaveLength(2);
    expect(screen.queryByRole("option", { name: "On a schedule" })).not.toBeInTheDocument();
  });

  it("lists what arrived, what it did and the item, and says how many are waiting", async () => {
    mockIpc({
      jobs: [HELPDESK],
      heldCount: 30,
      events: [
        event({ id: "evt-row-2", outcome: "deduplicated", reason: "This job has already had this event, so no second item was created.", itemId: null, itemKey: null, itemTitle: null }),
        event(),
      ],
    });
    renderView();

    fireEvent.click(await screen.findByRole("tab", { name: /Events/ }));

    const list = within(screen.getByRole("region", { name: "Events" }));
    expect(list.getByText("Deduplicated")).toBeInTheDocument();
    expect(list.getByText(/already had this event/)).toBeInTheDocument();
    expect(list.getByText("Created")).toBeInTheDocument();
    expect(list.getByRole("link", { name: "EO-9" })).toHaveAttribute("href", "/items/item-9");
    expect(list.getByText(/^30 waiting\./)).toBeInTheDocument();
  });

  it("says so plainly when nothing has been delivered yet", async () => {
    mockIpc({ jobs: [HELPDESK] });
    renderView();

    fireEvent.click(await screen.findByRole("tab", { name: /Events/ }));

    expect(screen.getByText("Nothing has been delivered here yet.")).toBeInTheDocument();
    expect(screen.queryByText(/waiting\./)).not.toBeInTheDocument();
  });
});
