import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@eo/ui";
import { placementReason, type JobPlacement, type JobSummary, type PlacementReason } from "@eo/core";
import { RunsOn } from "./RunsOn";

/**
 * The chat layout's "Runs on" control — `jobs/RunsOn.test.tsx`, held to the
 * same claims, because what it draws is the same decision.
 *
 * "Runs on: this machine / organisation server" (EO-330,
 * the original design, invariant 12).
 *
 * What the control has to keep is the design's closing sentence — *the person
 * is never allowed to pick a place where the job would quietly fail* —
 * so the assertions here are about the option being **disabled** rather
 * than about a message appearing after somebody tried. The refusal
 * exists too (`jobs:update` makes it, and `ipc/jobCommands.test.ts`
 * holds it to account), because the screen is not the only door; what
 * the screen adds is that nobody has to meet it.
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
    threadItemId: "thread-1",
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
    ...overrides,
  };
}

function draw(options: {
  placement?: Partial<JobPlacement>;
  runsOn?: JobSummary["runsOn"];
  machine?: { name: string; lastSeenAt: number | null } | null;
  onChange?: (next: JobSummary["runsOn"]) => void;
} = {}) {
  const placement: JobPlacement = { runsOn: options.runsOn ?? "device", machineBound: [], serverBound: [], ...options.placement };
  render(
    <ThemeProvider>
      <RunsOn
        job={job({ runsOn: options.runsOn ?? "device" })}
        placement={placement}
        machine={options.machine ?? null}
        onChange={options.onChange ?? vi.fn()}
        saving={false}
      />
    </ThemeProvider>,
  );
}

/** The two options as the picker draws them. */
function option(label: string): HTMLOptionElement {
  return screen.getByRole("option", { name: new RegExp(label) }) as HTMLOptionElement;
}

describe("the picker", () => {
  it("offers both places to a job that needs nothing of either", () => {
    draw();

    expect(option("this machine").disabled).toBe(false);
    expect(option("organisation server").disabled).toBe(false);
    expect((screen.getByLabelText("Runs on") as HTMLSelectElement).value).toBe("device");
  });

  it("greys the organisation server for a job bound to this machine, and says why", () => {
    // The story's first acceptance criterion, on the screen: a personal
    // Codex login, named with the step that raised it.
    draw({ placement: { machineBound: [PERSONAL_LOGIN] } });

    expect(option("organisation server").disabled).toBe(true);
    expect(option("organisation server").textContent).toContain("not available for this job");
    expect(screen.getByText(/signed in to Codex with a personal login/)).toBeTruthy();
    // A reason is never only a fact: the fix is beside it, and this one
    // is the person's own.
    expect(screen.getByText(/backend your organisation allows an API key for/)).toBeTruthy();
  });

  it("greys this machine for a job reading an organisation secret", () => {
    // The second criterion, and the direction it is easy to get
    // backwards.
    draw({ runsOn: "server", placement: { serverBound: [ORGANISATION_SECRET] } });

    expect(option("this machine").disabled).toBe(true);
    expect(screen.getByText(/reads FLY_API_TOKEN, a secret your organisation set/)).toBeTruthy();
    expect(screen.getByText(/Ask your admin\./)).toBeTruthy();
  });

  it("does not explain a place nothing is standing in the way of", () => {
    // A person is not shown why the thing they chose is allowed.
    draw({ placement: { machineBound: [PERSONAL_LOGIN] } });

    expect(screen.queryByText(/Why "this machine"/)).toBeNull();
  });

  it("explains the job's own place when that is the one that went grey", () => {
    // Placement is derived (invariant #6), so the ground moves under a
    // job standing still: an agent re-bound to a personal login this
    // morning greys *organisation server* for a job that has been
    // running there since March. Greying a job's own place and saying
    // nothing about why is the one thing a greyed control must not do.
    draw({ runsOn: "server", placement: { machineBound: [PERSONAL_LOGIN] } });

    expect(option("organisation server").disabled).toBe(true);
    expect(screen.getByText(/Why "organisation server" is not available for this job/)).toBeTruthy();
    expect(screen.getByText(/This job can no longer run where it is\. Move it to "this machine"\./)).toBeTruthy();
  });

  it("moves the job the moment a place is picked", () => {
    const onChange = vi.fn();
    draw({ onChange });

    fireEvent.change(screen.getByLabelText("Runs on"), { target: { value: "server" } });

    expect(onChange).toHaveBeenCalledWith("server");
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
  it("says so out loud rather than leaving it to be inferred from two greyed options", () => {
    // The state the design does not name and a managed installation reaches:
    // a personal login on one step and an organisation secret on
    // another. What the person has to do about it is not "pick the
    // other one".
    draw({ placement: { machineBound: [PERSONAL_LOGIN], serverBound: [ORGANISATION_SECRET] } });

    expect(option("this machine").disabled).toBe(true);
    expect(option("organisation server").disabled).toBe(true);
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
