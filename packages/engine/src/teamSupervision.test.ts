import { describe, expect, it } from "vitest";
import { IndependentTeamSchema, type IndependentTeam } from "@eo/core";
import { allocateParticipantBudget, planIndependentTeam, type TeamAttemptState } from "./teamSupervision.js";

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


let counter = 0;
function attempt(key: string, status: TeamAttemptState["status"], extra: Partial<TeamAttemptState> = {}): TeamAttemptState {
  counter += 1;
  return { id: `a${counter}`, key, status, supersededBy: null, outcome: null, report: null, error: null, baseline: "B1", live: false, ...extra };
}
const done = (key: string, outcome: string, extra: Partial<TeamAttemptState> = {}) => attempt(key, "completed", { outcome, report: `${key} says ${outcome}.`, ...extra });
const plan = (attempts: TeamAttemptState[], baseline = "B1") => planIndependentTeam({ team: TEAM, attempts, baseline });

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

  it("holds turns to the team's own limit and to nothing else: no agent's cap, no machine-wide limit (EO-871)", () => {
    // However the assignments are staffed, and whatever other teams run, only the team's limit holds them back.
    const next = plan([]);
    expect(next.start.map((one) => one.key)).toEqual(["security", "tests"]);
    expect(next.waiting.map((one) => one.reason)).toEqual(["team"]);
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
    expect(allocateParticipantBudget({ ceilings: [], outstanding: 3 })).toBeNull();
  });

  it("divides what is left between every assignment still owed a turn, so concurrent turns never each get the whole", () => {
    const shares = [3, 2, 1].map((outstanding, index) => allocateParticipantBudget({ ceilings: [{ remainingCents: 100, heldCents: index === 0 ? 0 : index === 1 ? 33 : 66 }], outstanding }));
    expect(shares).toEqual([33, 33, 34]);
    expect(shares.reduce((sum, share) => sum! + share!, 0)).toBeLessThanOrEqual(100);
  });

  it("gives nothing when what running turns hold already takes all that is left", () => {
    expect(allocateParticipantBudget({ ceilings: [{ remainingCents: 40, heldCents: 50 }], outstanding: 1 })).toBe(0);
  });

  it("takes the smallest share any of its ceilings leaves, each reckoned with only what it covers", () => {
    // The item's budget is untouched by another item's turns; the day's is held by them.
    expect(allocateParticipantBudget({ ceilings: [{ remainingCents: 100, heldCents: 0 }, { remainingCents: 300, heldCents: 100 }], outstanding: 2 })).toBe(50);
    expect(allocateParticipantBudget({ ceilings: [{ remainingCents: 100, heldCents: 0 }, { remainingCents: 100, heldCents: 100 }], outstanding: 2 })).toBe(0);
  });
});
