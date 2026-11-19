import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@eo/ui";
import type { JobEventRow, JobOccurrenceRow, JobSummary, JobWatchCheckRow, WebhookTrigger } from "@eo/core";
import { createQueryClient } from "../../../query/client";
import { whenOf } from "../../../shared/jobs/format";
import { ItemReferenceProvider } from "../../conversation/ItemReferenceProvider";
import { JobView } from "./JobView";

/**
 * One job in the chat layout, read-only apart from Pause, Resume and Run
 * now (EO-787): making, changing and deleting a job, and a webhook's new
 * secret and test event, are the assistant's job cards and outside
 * agents' tools.
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

/** 08:00 Berlin on Monday 1 June 2026 is 06:00Z. */
const MONDAY_0800_BERLIN = Date.UTC(2026, 5, 1, 6, 0);

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
    workspaceId: null,
    workspaceName: null,
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
  events?: JobEventRow[];
  heldCount?: number;
  lastPayload?: string | null;
  session?: unknown;
  placement?: unknown;
  machine?: unknown;
  checks?: JobWatchCheckRow[];
  /** What `jobs:update` answers a save of the repository with (EO-856). */
  updateProblem?: string | null;
}

/** The project's repositories, as `workspaces:list` gives them (EO-856). */
const WORKSPACES = [
  { id: "w-api", projectId: "p1", kind: "git", label: "api", summary: "", problem: null, position: 0, itemCount: 0, config: {} },
  { id: "w-web", projectId: "p1", kind: "git", label: "web", summary: "", problem: null, position: 1, itemCount: 0, config: {} },
];

function mockIpc(options: Options = {}) {
  // A queue, so a test can answer one thing before a save and another after.
  const answers = [...(options.jobs ?? [job()])];
  const invoke = vi.fn(async (channel: string, _payload?: unknown) => {
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
      case "jobs:runNow":
        return { ok: true, data: { fired: true, occurrence: null, itemId: "t9", problem: null } };
      case "jobs:pause":
      case "jobs:resume":
        return { ok: true, data: { job: job() } };
      case "workspaces:list":
        return { ok: true, data: { workspaces: WORKSPACES } };
      case "jobs:update": {
        const problem = options.updateProblem ?? null;
        const workspaceId = (_payload as { workspaceId: string | null }).workspaceId;
        return { ok: true, data: { job: problem === null ? job({ workspaceId }) : null, problem } };
      }
      case "jobs:checks":
        return { ok: true, data: { checks: options.checks ?? [], nextBefore: null } };
      case "jobs:events":
        return {
          ok: true,
          data: { events: options.events ?? [], heldCount: options.heldCount ?? 0, lastPayload: options.lastPayload === undefined ? LAST_PAYLOAD : options.lastPayload },
        };
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

describe("what it was set up with", () => {
  it("states the trigger, pipeline, template and budget as text", async () => {
    mockIpc({ jobs: [job({ template: { type: "developer:story", title: "{{job}} for {{date}}", body: "What shipped this week." } })] });
    renderView();

    const definition = within(await screen.findByLabelText("Definition"));
    expect(definition.getByText("Daily at 08:00")).toBeInTheDocument();
    expect(definition.getByText("180 minutes")).toBeInTheDocument();
    expect(await definition.findByText("Delivery")).toBeInTheDocument();
    expect(await definition.findByText("Story")).toBeInTheDocument();
    expect(definition.getByText("{{job}} for {{date}}")).toBeInTheDocument();
    expect(definition.getByText("What shipped this week.")).toBeInTheDocument();
    expect(definition.getByText("$5.00")).toBeInTheDocument();
  });

  it("offers no form, no Save and no Delete — only the repository's picker", async () => {
    const invoke = mockIpc();
    renderView();

    await screen.findByLabelText("Definition");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getAllByRole("combobox").map((box) => box.getAttribute("aria-label"))).toEqual(["Repository"]);
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    expect([...calls(invoke, "jobs:update"), ...calls(invoke, "jobs:delete")]).toHaveLength(0);
  });

  it("says when a job has no budget", async () => {
    mockIpc({ jobs: [job({ budgetPerOccurrenceCents: null })] });
    renderView();

    expect(within(await screen.findByLabelText("Definition")).getByText("None")).toBeInTheDocument();
  });
});

describe("the repository its items are filed on (EO-856)", () => {
  const picker = async () => (await within(await screen.findByLabelText("Definition")).findByRole("combobox", { name: "Repository" })) as HTMLSelectElement;

  it("shows — when the job names none, and offers the project's repositories", async () => {
    mockIpc();
    renderView();

    const select = await picker();
    await waitFor(() => expect([...select.options].map((option) => option.text)).toEqual(["—", "api", "web"]));
    expect(select.value).toBe("");
    expect(select.selectedOptions[0]?.text).toBe("—");
  });

  it("shows the one it names", async () => {
    mockIpc({ jobs: [job({ workspaceId: "w-web", workspaceName: "web" })] });
    renderView();

    const select = await picker();
    await waitFor(() => expect(select.selectedOptions[0]?.text).toBe("web"));
  });

  it("names one that has left the project rather than showing none", async () => {
    mockIpc({ jobs: [job({ workspaceId: "w-gone", workspaceName: "old" })] });
    renderView();

    const select = await picker();
    await waitFor(() => expect(select.selectedOptions[0]?.text).toBe("old — no longer on this project"));
  });

  it("sets, changes and clears it through jobs:update", async () => {
    const invoke = mockIpc();
    renderView();
    const select = await picker();
    await waitFor(() => expect(select.options).toHaveLength(3));

    fireEvent.change(select, { target: { value: "w-api" } });
    await waitFor(() => expect(calls(invoke, "jobs:update").at(-1)?.[1]).toEqual({ jobId: "job-1", workspaceId: "w-api" }));

    fireEvent.change(select, { target: { value: "w-web" } });
    await waitFor(() => expect(calls(invoke, "jobs:update").at(-1)?.[1]).toEqual({ jobId: "job-1", workspaceId: "w-web" }));

    fireEvent.change(select, { target: { value: "" } });
    await waitFor(() => expect(calls(invoke, "jobs:update").at(-1)?.[1]).toEqual({ jobId: "job-1", workspaceId: null }));
  });

  it("shows the refusal when the save is refused", async () => {
    const problem = '"Delivery" starts new work on a branch of the item\'s own repository, and this job names none.';
    mockIpc({ jobs: [job({ workspaceId: "w-api", workspaceName: "api" })], updateProblem: problem });
    renderView();
    const select = await picker();
    await waitFor(() => expect(select.options).toHaveLength(3));

    fireEvent.change(select, { target: { value: "" } });

    expect(await screen.findByRole("alert")).toHaveTextContent(problem);
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

});

describe("Runs on", () => {
  const SIGNED_IN = { state: "signed-in", address: "https://eo.example", email: "anna@example.com", personId: "anna", personName: "Anna", isAdmin: false, deviceId: "d1", deviceName: "Anna's MacBook" };

  it("is a sentence in solo mode, and the placement is never asked", async () => {
    const invoke = mockIpc();
    renderView();

    expect(await screen.findByText("Runs while EO is open on this machine.")).toBeInTheDocument();
    expect(calls(invoke, "jobs:placement")).toHaveLength(0);
  });

  it("states the place in managed mode, and names the machine a device job runs on", async () => {
    mockIpc({ session: SIGNED_IN, machine: { name: "Anna's MacBook", lastSeenAt: Date.now() - 3 * 60 * 60 * 1000 } });
    renderView();

    expect(await screen.findByText("Runs on this machine")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: /Runs on/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Runs while EO is open on Anna's MacBook · last online 3h ago/)).toBeInTheDocument();
    expect(screen.queryByText("Runs while EO is open on this machine.")).not.toBeInTheDocument();
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

  it("offers no Regenerate secret or Send test event button", async () => {
    const invoke = mockIpc({ jobs: [HELPDESK] });
    renderView();

    await screen.findByText(SECRET);
    expect(screen.queryByRole("button", { name: /Regenerate/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /test event/ })).not.toBeInTheDocument();
    expect([...calls(invoke, "jobs:regenerateSecret"), ...calls(invoke, "jobs:testEvent")]).toHaveLength(0);
  });

  it("draws a read-only mapping row per template field, the type's spec fields included", async () => {
    mockIpc({ jobs: [HELPDESK] });
    renderView();

    expect(within(await screen.findByLabelText("Title pointer")).getByText("/issue/fields/summary")).toBeInTheDocument();
    expect(within(screen.getByLabelText("Body pointer")).getByText("—")).toBeInTheDocument();
    expect(within(screen.getByLabelText("Severity pointer")).getByText("—")).toBeInTheDocument();
    expect(within(screen.getByLabelText("Event key pointer")).getByText("/delivery_id")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Field mapping" })).queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("previews each pointer from the last payload", async () => {
    mockIpc({ jobs: [HELPDESK] });
    renderView();

    expect(within(await screen.findByLabelText("Title pointer")).getByText("Printer on fire")).toBeInTheDocument();
    expect(within(screen.getByLabelText("Event key pointer")).getByText("evt-1")).toBeInTheDocument();
    expect(within(screen.getByLabelText("Body pointer")).getByText("The template's own text")).toBeInTheDocument();
  });

  it("says which kind of nothing a pointer found", async () => {
    const mapping = { ...WEBHOOK.mapping, body: "/nowhere", spec: { severity: "nowhere" } };
    mockIpc({ jobs: [{ ...HELPDESK, trigger: { ...WEBHOOK, mapping } }] });
    renderView();

    expect(within(await screen.findByLabelText("Body pointer")).getByText("Nothing there")).toBeInTheDocument();
    expect(within(screen.getByLabelText("Severity pointer")).getByText(/has to start with \//)).toBeInTheDocument();
  });

  it("previews nothing when nothing has arrived, rather than blaming the pointer", async () => {
    mockIpc({ jobs: [HELPDESK], lastPayload: null });
    renderView();

    expect(await screen.findAllByText("Nothing has arrived yet")).toHaveLength(2);
  });

  it("states its trigger and offers no way to turn it into a scheduled one", async () => {
    mockIpc({ jobs: [HELPDESK] });
    renderView();

    // Twice: the status states it, and the definition lists it.
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

describe("a watch job's checks (EO-800)", () => {
  const WATCH = job({
    name: "PR intake",
    trigger: { kind: "watch", moduleId: "pr-watch", inputs: {}, everyMinutes: 60, waitWhileOpen: false },
    nextRunAt: null,
  });

  function check(overrides: Partial<JobWatchCheckRow>): JobWatchCheckRow {
    return {
      id: "check-1",
      jobId: "job-1",
      startedAt: MONDAY_0800_BERLIN,
      endedAt: MONDAY_0800_BERLIN + 4_000,
      answer: "waiting",
      detail: "",
      findingCount: 0,
      filedItemIds: [],
      filedItems: [],
      output: "",
      ...overrides,
    };
  }

  it("lists each check newest first with its time, duration, answer, detail, findings and filed items, and opens its output", async () => {
    const invoke = mockIpc({
      jobs: [WATCH],
      checks: [
        check({
          id: "filed",
          startedAt: MONDAY_0800_BERLIN + 2 * 3_600_000,
          endedAt: MONDAY_0800_BERLIN + 2 * 3_600_000 + 65_000,
          detail: "2 open pull requests.",
          findingCount: 2,
          filedItemIds: ["item-9"],
          filedItems: [{ id: "item-9", key: "EO-9", title: "Bump zod" }],
          output: "$ gh pr list --repo eo/eo --json number,title",
        }),
        check({ id: "failed", startedAt: MONDAY_0800_BERLIN + 3_600_000, endedAt: MONDAY_0800_BERLIN + 3_600_000 + 2_000, answer: "failed", detail: "gh is not signed in." }),
        check({ id: "waiting", detail: "Nothing open." }),
      ],
    });
    renderView();

    fireEvent.click(await screen.findByRole("tab", { name: /Checks/ }));

    const list = within(await screen.findByRole("region", { name: "Check history" }));
    const rows = list.getAllByRole("listitem");
    expect(rows).toHaveLength(3);

    const [filed, failed, waiting] = rows.map((row) => within(row));
    expect(filed!.getByText("Waiting")).toBeInTheDocument();
    expect(filed!.getByText("2 open pull requests.")).toBeInTheDocument();
    expect(filed!.getByText("2 findings")).toBeInTheDocument();
    expect(filed!.getByText("1m 5s")).toBeInTheDocument();
    // A watch job has no zone of its own, so its times are the machine's.
    expect(filed!.getByText(whenOf(MONDAY_0800_BERLIN + 2 * 3_600_000))).toBeInTheDocument();
    expect(filed!.getByRole("link", { name: "EO-9" })).toHaveAttribute("href", "/items/item-9");

    expect(failed!.getByText("Failed")).toBeInTheDocument();
    expect(failed!.getByText("gh is not signed in.")).toBeInTheDocument();
    expect(failed!.getByText("0 findings")).toBeInTheDocument();
    expect(failed!.getByText("2s")).toBeInTheDocument();
    expect(failed!.queryByRole("link")).not.toBeInTheDocument();

    expect(waiting!.getByText("Waiting")).toBeInTheDocument();
    expect(waiting!.getByText("Nothing open.")).toBeInTheDocument();
    expect(waiting!.getByText("4s")).toBeInTheDocument();
    expect(waiting!.getByText(whenOf(MONDAY_0800_BERLIN))).toBeInTheDocument();

    // The output is hidden until the row is opened.
    expect(screen.queryByText(/gh pr list/)).not.toBeInTheDocument();
    const toggle = filed!.getByRole("button", { name: "Output" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(filed!.getByLabelText("Output")).toHaveTextContent("$ gh pr list --repo eo/eo --json number,title");

    expect(calls(invoke, "jobs:checks")[0]?.[1]).toEqual({ jobId: "job-1" });
  });

  it("says so when it has not checked yet", async () => {
    mockIpc({ jobs: [WATCH] });
    renderView();

    fireEvent.click(await screen.findByRole("tab", { name: /Checks/ }));
    expect(within(await screen.findByRole("region", { name: "Check history" })).getByText("It has not checked yet.")).toBeInTheDocument();
  });

  it("is not offered for a manual, schedule or webhook job", async () => {
    for (const other of [job({ trigger: { kind: "manual" }, nextRunAt: null }), job(), HELPDESK]) {
      const invoke = mockIpc({ jobs: [other] });
      const view = renderView();
      await screen.findByRole("region", { name: "Record" });
      expect(screen.queryByRole("tab", { name: /Checks/ })).not.toBeInTheDocument();
      expect(calls(invoke, "jobs:checks")).toHaveLength(0);
      view.unmount();
    }
  });
});
