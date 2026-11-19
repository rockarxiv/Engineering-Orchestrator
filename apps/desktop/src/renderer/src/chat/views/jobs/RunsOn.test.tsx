import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@eo/ui";
import { placementReason, type JobPlacement, type JobSummary, type PlacementReason } from "@eo/core";
import { RunsOn } from "./RunsOn";

/**
 * The chat layout's "Runs on" line (EO-330, the original design,
 * invariant 12), stated rather than picked since EO-787: a job is moved
 * by the assistant's card or an outside agent's tool, and `jobs:update`
 * refuses a place the job would quietly fail in (`ipc/jobCommands.test.ts`
 * holds that to account). What the page keeps is every reason a place is
 * unavailable, each with what would clear it.
 */

const PERSONAL_LOGIN = placementReason({
  kind: "personal-login",
  subject: "Implementer",
  stepName: "To Do",
  detail: "Codex",
});
const ORGANISATION_SECRET = placementReason({ kind: "organisation-secret", subject: "FLY_API_TOKEN", stepName: "Deploy" });

function job(overrides: Partial<JobSummary> = {}): JobSummary {
  return {
    id: "job-1",
    projectId: "p1",
    name: "Monday report",
    trigger: { kind: "schedule", schedule: { kind: "daily", hour: 8, minute: 0 }, timeZone: "Europe/Berlin", catchUpWithinMinutes: 180 },
    pipelineId: "default",
    template: null,
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
    workspaceId: null,
    workspaceName: null,
    ...overrides,
  };
}

function draw(options: {
  placement?: Partial<JobPlacement>;
  runsOn?: JobSummary["runsOn"];
  machine?: { name: string; lastSeenAt: number | null } | null;
} = {}) {
  const placement: JobPlacement = { runsOn: options.runsOn ?? "device", machineBound: [], serverBound: [], ...options.placement };
  render(
    <ThemeProvider>
      <RunsOn job={job({ runsOn: options.runsOn ?? "device" })} placement={placement} machine={options.machine ?? null} />
    </ThemeProvider>,
  );
}

describe("where it runs, and why not elsewhere", () => {
  it("states the place as text, with nothing to pick", () => {
    draw();

    expect(screen.getByText("Runs on this machine")).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("option")).toBeNull();
  });

  it("says why the organisation server is unavailable for a job bound to this machine", () => {
    // A personal Codex login, named with the step that raised it.
    draw({ placement: { machineBound: [PERSONAL_LOGIN] } });

    expect(screen.getByText(/Why "organisation server" is not available for this job/)).toBeTruthy();
    expect(screen.getByText(/signed in to Codex with a personal login/)).toBeTruthy();
    // A reason is never only a fact: the fix is beside it, and this one
    // is the person's own.
    expect(screen.getByText(/backend your organisation allows an API key for/)).toBeTruthy();
  });

  it("says why this machine is unavailable for a job reading an organisation secret", () => {
    draw({ runsOn: "server", placement: { serverBound: [ORGANISATION_SECRET] } });

    expect(screen.getByText(/Why "this machine" is not available for this job/)).toBeTruthy();
    expect(screen.getByText(/reads FLY_API_TOKEN, a secret your organisation set/)).toBeTruthy();
    expect(screen.getByText(/Ask your admin\./)).toBeTruthy();
  });

  it("does not explain a place nothing is standing in the way of", () => {
    draw({ placement: { machineBound: [PERSONAL_LOGIN] } });

    expect(screen.queryByText(/Why "this machine"/)).toBeNull();
  });

  it("explains the job's own place when that is the one that became unavailable, and points at the assistant", () => {
    // Placement is derived (invariant #6), so the ground moves under a
    // job standing still: an agent re-bound to a personal login this
    // morning rules out *organisation server* for a job that has been
    // running there since March.
    draw({ runsOn: "server", placement: { machineBound: [PERSONAL_LOGIN] } });

    expect(screen.getByText("Runs on organisation server — not available for this job")).toBeTruthy();
    expect(screen.getByText(/Why "organisation server" is not available for this job/)).toBeTruthy();
    expect(screen.getByText(/This job can no longer run where it is\. Ask the assistant to move it to "this machine"\./)).toBeTruthy();
  });
});

describe("what the job says about itself once it is placed", () => {
  it("names the machine and when it was last online", () => {
    // ARCHITECTURE.md, "Where a job runs"'s own sentence, which is what managed mode makes both
    // possible and necessary: "this machine" means nothing to somebody
    // reading a colleague's job.
    draw({ machine: { name: "Anna's MacBook", lastSeenAt: Date.now() - 3 * 60 * 60 * 1000 } });

    expect(screen.getByText(/Runs while EO is open on Anna's MacBook · last online 3h ago/)).toBeTruthy();
  });

  it("says a server job needs nobody's laptop open", () => {
    draw({ runsOn: "server" });

    expect(screen.getByText(/whether or not any desktop is open/)).toBeTruthy();
  });
});

describe("the copyable summary", () => {
  it("gives the admin one line per reason, and says it copied", () => {
    const writeText = vi.fn();
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const second: PlacementReason = placementReason({ kind: "local-mcp-server", subject: "reports", stepName: "Collect" });
    draw({ placement: { machineBound: [PERSONAL_LOGIN, second] } });

    fireEvent.click(screen.getByRole("button", { name: 'Copy why "organisation server" is unavailable' }));

    const copied = writeText.mock.calls[0]?.[0] as string;
    expect(copied.split("\n")).toHaveLength(3);
    expect(copied).toContain('"Monday report" cannot run on organisation server.');
    expect(copied).toContain("reports");
    // Said on the button itself, which is where the person's eye
    // already is. Its accessible name goes on naming the place, so a
    // stranded job's two buttons stay tellable apart.
    expect(screen.getByRole("button", { name: 'Copy why "organisation server" is unavailable' }).textContent).toBe("Copied");
  });
});

describe("a job with nowhere to run", () => {
  it("says so out loud rather than leaving it to be inferred from two lists of reasons", () => {
    // The state the design does not name and a managed installation reaches:
    // a personal login on one step and an organisation secret on
    // another. What the person has to do about it is not "pick the
    // other one".
    draw({ placement: { machineBound: [PERSONAL_LOGIN], serverBound: [ORGANISATION_SECRET] } });

    expect(screen.getByText(/Neither place can run this job as it stands/)).toBeTruthy();
    // Both lists are drawn, each with its own copyable summary: an
    // admin can answer four reasons one at a time and cannot answer two
    // places at once.
    expect(screen.getByText(/Why "this machine" is not available/)).toBeTruthy();
    expect(screen.getByText(/Why "organisation server" is not available/)).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /^Copy why/ })).toHaveLength(2);
    // And not the "move it" line, because there is nowhere to move it
    // to — the sentence above is the one that fits.
    expect(screen.queryByText(/Move it to/)).toBeNull();
  });
});
