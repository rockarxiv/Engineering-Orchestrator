import { describe, expect, it } from "vitest";
import { IndependentTeamSchema, type IndependentTeam } from "@eo/core";
import { allocateParticipantBudget, planIndependentTeam, type TeamAttemptState, type TeamCapacity } from "./teamSupervision.js";

const TEAM: IndependentTeam = IndependentTeamSchema.parse({
  coordination: "independent",
  participants: [
    { key: "security", role: "reviewer", instructions: "Look for ways in." },
    { key: "tests", role: "tester", instructions: "Check the tests." },
    { key: "style", role: "reviewer", instructions: "Read it for style.", required: false },
  ],
  outcomes: [
    { key: "clear", label: "Nothing found" },
    { key: "blocking", label: "Blocking issue" },
  ],
  completion: { rules: [{ when: "any", outcomes: ["blocking"], result: "rejected" }], fallback: "approved" },
  limits: { maxParticipants: 3, maxParallel: 2, maxRetries: 1 },
});

const ROOMY: TeamCapacity = {
  machineFree: 4,
  agentOf: new Map([
    ["security", "rita"],
    ["tests", "tom"],
    ["style", "sam"],
  ]),
  agentFree: new Map([
    ["rita", 1],
    ["tom", 1],
    ["sam", 1],
  ]),
};

let counter = 0;
function attempt(key: string, status: TeamAttemptState["status"], extra: Partial<TeamAttemptState> = {}): TeamAttemptState {
  counter += 1;
  return { id: `a${counter}`, key, status, supersededBy: null, outcome: null, report: null, error: null, baseline: "B1", live: false, ...extra };
}
const done = (key: string, outcome: string, extra: Partial<TeamAttemptState> = {}) => attempt(key, "completed", { outcome, report: `${key} says ${outcome}.`, ...extra });
const plan = (attempts: TeamAttemptState[], capacity: TeamCapacity = ROOMY, baseline = "B1") => planIndependentTeam({ team: TEAM, attempts, baseline, capacity });

describe("planIndependentTeam (EO-846)", () => {
  it("starts the first assignments in the team's order, no more at once than the team allows", () => {
    const next = plan([]);
    expect(next.start).toEqual([
      { key: "security", supersedes: null, why: "first" },
      { key: "tests", supersedes: null, why: "first" },
    ]);
    expect(next.waiting).toEqual([{ key: "style", reason: "team" }]);
    expect(next.decision.status).toBe("pending");
  });

  it("holds turns to the machine's free slots and to each agent's own limit, saying which", () => {
    expect(plan([], { ...ROOMY, machineFree: 1 }).waiting).toEqual([
      { key: "tests", reason: "machine" },
      { key: "style", reason: "machine" },
    ]);
    const busyRita = plan([], { ...ROOMY, agentFree: new Map([["tom", 1], ["sam", 1]]) });
    expect(busyRita.start.map((one) => one.key)).toEqual(["tests", "style"]);
    expect(busyRita.waiting).toEqual([{ key: "security", reason: "agent" }]);
    // One agent staffing two assignments runs them one after the other at a limit of one.
    const oneAgent = plan([], { machineFree: 4, agentOf: new Map([["security", "rita"], ["tests", "rita"], ["style", "rita"]]), agentFree: new Map([["rita", 1]]) });
    expect(oneAgent.start.map((one) => one.key)).toEqual(["security"]);
  });

  it("counts a turn still working against the team's parallel limit", () => {
    const next = plan([attempt("security", "running", { live: true })]);
    expect(next.working).toHaveLength(1);
    expect(next.start).toEqual([{ key: "tests", supersedes: null, why: "first" }]);
    expect(next.waiting).toEqual([{ key: "style", reason: "team" }]);
  });

  it("decides a completed negative finding by the table, the same whatever order the reports arrived in", () => {
    const reports = [done("security", "blocking"), done("tests", "clear"), done("style", "clear")];
    const one = plan(reports);
    const other = plan([...reports].reverse());
    expect(one.decision).toMatchObject({ status: "decided", result: "rejected", rule: 0 });
    expect(other.decision).toEqual(one.decision);
    expect(plan([done("security", "clear"), done("tests", "clear"), done("style", "clear")]).decision).toMatchObject({ status: "decided", result: "approved", rule: null });
  });

  it("retries a failed contribution within the limit and keeps the completed ones", () => {
    const failed = attempt("tests", "failed", { error: "The backend crashed." });
    const next = plan([done("security", "clear"), failed, done("style", "clear")]);
    expect(next.start).toEqual([{ key: "tests", supersedes: failed.id, why: "retry" }]);
    expect(next.decision.status).toBe("pending");
  });

  it("fails a required participant past its retries rather than reaching the fallback", () => {
    const first = attempt("tests", "failed", { error: "crashed", supersededBy: "x" });
    const second = attempt("tests", "failed", { error: "crashed again" });
    const next = plan([done("security", "clear"), first, second, done("style", "clear")]);
    expect(next.exhausted).toEqual(["tests"]);
    expect(next.start).toEqual([]);
    expect(next.decision).toMatchObject({ status: "failed", failed: ["tests"] });
  });

  it("leaves out an optional participant past its retries and decides on the rest", () => {
    const next = plan([done("security", "clear"), done("tests", "clear"), attempt("style", "failed", { supersededBy: "x" }), attempt("style", "failed")]);
    expect(next.decision).toMatchObject({ status: "decided", result: "approved" });
  });

  it("replaces an attempt nobody is running — EO stopped while it ran — without counting it as a failure or a finding", () => {
    const orphan = attempt("security", "running");
    const next = plan([orphan, done("tests", "clear"), done("style", "clear")]);
    expect(next.fence).toEqual([{ attemptId: orphan.id, why: "orphaned" }]);
    expect(next.start).toEqual([{ key: "security", supersedes: orphan.id, why: "interrupted" }]);
    expect(next.decision.status).toBe("pending");
    // Cancelled attempts are not counted against the retries.
    const stopped = [attempt("security", "cancelled", { supersededBy: "y" }), attempt("security", "cancelled", { supersededBy: "z" }), attempt("security", "cancelled")];
    expect(plan([...stopped, done("tests", "clear"), done("style", "clear")]).start).toEqual([{ key: "security", supersedes: stopped[2]!.id, why: "interrupted" }]);
  });

  it("supersedes work done on evidence that has since changed and never decides on it", () => {
    const stale = done("security", "clear", { baseline: "B0" });
    const running = attempt("tests", "running", { live: true, baseline: "B0" });
    const next = plan([stale, running, done("style", "clear")]);
    expect(next.fence).toEqual([{ attemptId: running.id, why: "stale" }]);
    expect(next.start).toEqual([{ key: "security", supersedes: stale.id, why: "stale" }]);
    expect(next.decision.status).toBe("pending");
    // Once the stale turn has stopped, it too is replaced.
    const stopped = { ...running, status: "cancelled" as const, live: false };
    expect(plan([stale, stopped, done("style", "clear")]).start).toContainEqual({ key: "tests", supersedes: stopped.id, why: "stale" });
  });

  it("keeps an unchanged completed report across a sibling's retry", () => {
    const kept = done("security", "blocking");
    const next = plan([kept, attempt("tests", "failed"), done("style", "clear")]);
    expect(next.start.map((one) => one.key)).toEqual(["tests"]);
    const after = plan([kept, attempt("tests", "failed", { supersededBy: "r" }), done("tests", "clear"), done("style", "clear")]);
    expect(after.decision).toMatchObject({ status: "decided", result: "rejected" });
  });
});

describe("allocateParticipantBudget (EO-846)", () => {
  it("caps nothing where no budget is set", () => {
    expect(allocateParticipantBudget({ remainingCents: null, heldCents: 0, outstanding: 3 })).toBeNull();
  });

  it("divides what is left between every assignment still owed a turn, so concurrent turns never each get the whole", () => {
    const shares = [3, 2, 1].map((outstanding, index) => allocateParticipantBudget({ remainingCents: 100, heldCents: index === 0 ? 0 : index === 1 ? 33 : 66, outstanding }));
    expect(shares).toEqual([33, 33, 34]);
    expect(shares.reduce((sum, share) => sum! + share!, 0)).toBeLessThanOrEqual(100);
  });

  it("gives nothing when what running turns hold already takes all that is left", () => {
    expect(allocateParticipantBudget({ remainingCents: 40, heldCents: 50, outstanding: 1 })).toBe(0);
  });
});
