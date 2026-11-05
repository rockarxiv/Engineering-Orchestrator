import { describe, expect, it } from "vitest";
import {
  ANYWHERE,
  ASK_YOUR_ADMIN,
  DEFAULT_JOB_RUNS_ON,
  jobMachineLine,
  placementAllows,
  placementReason,
  placementRefusal,
  placementStranded,
  placementSummary,
  reasonsAgainst,
  runsOnLabel,
  type JobPlacement,
  type PlacementReason,
} from "./placement.js";

/**
 * What a pipeline's needs mean for where its job may run (EO-330,
 * `ARCHITECTURE.md`, "Where a job runs").
 *
 * The decision and the words, with no machine under either. What the
 * facts *are* is `apps/desktop/src/main/jobs/placement.ts`'s question
 * and is tested there against a real database; this is the half that
 * says which option is greyed and what is written beside it.
 */

const PERSONAL_LOGIN = placementReason({ kind: "personal-login", subject: "Implementer", stepName: "Write it", detail: "Codex" });
const ORGANISATION_SECRET = placementReason({ kind: "organisation-secret", subject: "FLY_API_TOKEN", stepName: "Deploy" });

function placement(overrides: Partial<JobPlacement> = {}): JobPlacement {
  return { runsOn: "device", machineBound: [], serverBound: [], ...overrides };
}

describe("which place is greyed", () => {
  it("lets a job with no reasons at all go either way", () => {
    expect(placementAllows(ANYWHERE, "device")).toBe(true);
    expect(placementAllows(ANYWHERE, "server")).toBe(true);
    expect(placementStranded(ANYWHERE)).toBe(false);
  });

  it("greys the server for a machine-bound reason, and this machine for a server-bound one", () => {
    // The direction is the whole of it, and the easy thing to get
    // backwards: a reason that *binds the job to this machine* is a
    // reason the server cannot have it.
    const machineBound = placement({ machineBound: [PERSONAL_LOGIN] });
    expect(placementAllows(machineBound, "server")).toBe(false);
    expect(placementAllows(machineBound, "device")).toBe(true);
    expect(reasonsAgainst(machineBound, "server")).toEqual([PERSONAL_LOGIN]);

    const serverBound = placement({ serverBound: [ORGANISATION_SECRET] });
    expect(placementAllows(serverBound, "device")).toBe(false);
    expect(placementAllows(serverBound, "server")).toBe(true);
  });

  it("calls a job with reasons in both directions stranded, rather than picking one", () => {
    // The design does not name this state and a managed installation reaches
    // it: a personal login on one step and an organisation secret on
    // another. Neither place is offered, because neither would work.
    const both = placement({ machineBound: [PERSONAL_LOGIN], serverBound: [ORGANISATION_SECRET] });

    expect(placementStranded(both)).toBe(true);
    expect(placementAllows(both, "device")).toBe(false);
    expect(placementAllows(both, "server")).toBe(false);
  });

  it("starts every job on this machine, which is where every job has always run", () => {
    expect(DEFAULT_JOB_RUNS_ON).toBe("device");
    expect(runsOnLabel("device")).toBe("this machine");
    expect(runsOnLabel("server")).toBe("organisation server");
  });
});

describe("what a reason says", () => {
  it("names the step, the subject and the fix", () => {
    expect(PERSONAL_LOGIN.line).toContain('"Write it"');
    expect(PERSONAL_LOGIN.line).toContain("Implementer");
    expect(PERSONAL_LOGIN.line).toContain("Codex");
    expect(PERSONAL_LOGIN.line).toContain("personal login");
    // The acceptance criterion's own fix: bind the agent to a key
    // instead, and the greying clears.
    expect(PERSONAL_LOGIN.fix).toContain("API key");
  });

  it("ends in 'ask your admin' exactly where the fix is not the person's", () => {
    // A secret the organisation set, and an MCP server only it
    // publishes, are both somebody else's to move. A folder on this
    // disk and an agent's own backend are not.
    for (const kind of ["personal-secret", "local-mcp-server", "organisation-secret", "organisation-mcp-server"] as const) {
      expect(placementReason({ kind, subject: "X", stepName: "S" }).fix, kind).toContain(ASK_YOUR_ADMIN);
    }
    for (const kind of ["personal-login", "local-workspace"] as const) {
      expect(placementReason({ kind, subject: "X", stepName: "S" }).fix, kind).not.toContain(ASK_YOUR_ADMIN);
    }
  });

  it("says 'this job' rather than a blank where no step raised it", () => {
    const reason = placementReason({ kind: "personal-secret", subject: "TOKEN", stepName: null });

    expect(reason.line).toMatch(/^This job reads TOKEN/);
  });

  it("carries a path where a workspace has one, and reads without one where it does not", () => {
    const withPath = placementReason({ kind: "local-workspace", subject: "eo", stepName: "Build", detail: "/home/anna/eo" });
    const without = placementReason({ kind: "local-workspace", subject: "eo", stepName: "Build" });

    expect(withPath.line).toContain("(/home/anna/eo)");
    expect(without.line).not.toContain("(");
    expect(without.line).toContain('"eo"');
  });
});

describe("the refusal and the copyable summary", () => {
  it("refuses the place that is greyed, naming every reason and its fix", () => {
    const refusal = placementRefusal(placement({ machineBound: [PERSONAL_LOGIN] }), "server");

    expect(refusal).toContain("organisation server");
    expect(refusal).toContain("nothing was saved");
    expect(refusal).toContain(PERSONAL_LOGIN.line);
    expect(refusal).toContain(PERSONAL_LOGIN.fix);
  });

  it("has nothing to refuse where the place is allowed", () => {
    expect(placementRefusal(placement({ machineBound: [PERSONAL_LOGIN] }), "device")).toBe("");
  });

  it("gives an admin one line per reason to answer", () => {
    const second: PlacementReason = placementReason({ kind: "local-mcp-server", subject: "reports", stepName: "Collect" });
    const summary = placementSummary({
      jobName: "Monday report",
      placement: placement({ machineBound: [PERSONAL_LOGIN, second] }),
      where: "server",
    });

    const lines = summary.split("\n");
    expect(lines[0]).toBe('"Monday report" cannot run on organisation server.');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe(`• ${PERSONAL_LOGIN.line} ${PERSONAL_LOGIN.fix}`);
    expect(lines[2]).toContain("reports");
  });

  it("says so plainly where there is nothing in the way", () => {
    expect(placementSummary({ jobName: "Monday report", placement: ANYWHERE, where: "server" })).toBe(
      '"Monday report" can run on organisation server.',
    );
  });
});

describe("naming the machine a device job runs on", () => {
  const NOW = Date.UTC(2026, 5, 1, 12, 0);

  it("is §4.4's own sentence", () => {
    expect(jobMachineLine({ name: "Anna's MacBook", lastSeenAt: NOW - 3 * 60 * 60 * 1000 }, NOW)).toBe(
      "Runs while EO is open on Anna's MacBook · last online 3h ago",
    );
  });

  it("reads 'online now' rather than counting seconds", () => {
    expect(jobMachineLine({ name: "Anna's MacBook", lastSeenAt: NOW - 40_000 }, NOW)).toContain("online now");
  });

  it("rounds down, so it never claims a machine was seen more recently than it was", () => {
    // 119 minutes is one hour ago as far as this sentence is concerned,
    // and never two.
    expect(jobMachineLine({ name: "M", lastSeenAt: NOW - 119 * 60_000 }, NOW)).toContain("1h ago");
    expect(jobMachineLine({ name: "M", lastSeenAt: NOW - 47 * 60 * 60_000 }, NOW)).toContain("1d ago");
  });

  it("says a machine has never been online rather than inventing a time", () => {
    expect(jobMachineLine({ name: "A new laptop", lastSeenAt: null }, NOW)).toContain("never online");
  });

  it("does not run time backwards for a clock that disagrees with the record's", () => {
    expect(jobMachineLine({ name: "M", lastSeenAt: NOW + 60_000 }, NOW)).toContain("online now");
  });
});
