import { describe, expect, it } from "vitest";
import { IndependentTeamSchema, LEADER_ASSIGNMENT_KEY, LeaderTeamSchema, type LeaderAssignment, type LeaderTeam } from "@eo/core";
import {
  checkLeaderAssignments,
  finalStands,
  leaderFinalProblems,
  leaderLedger,
  planIndependentTeam,
  planLeaderTeam,
  ruledOutProblems,
  type AcceptedAssignment,
  type LeaderAttemptState,
  type LeaderTeamMember,
  type LeaderVerdict,
} from "./teamSupervision.js";

/** A leader-led team's pure half (EO-847), and a member of either kind asking the person. */

const TEAM: LeaderTeam = LeaderTeamSchema.parse({
  coordination: "leader",
  leader: { role: "lead", instructions: "Lead the review." },
  roles: ["reviewer", "tester"],
  limits: { maxParticipants: 2, maxParallel: 2, maxRounds: 2, maxRetries: 1 },
});


let counter = 0;
function attempt(key: string, status: LeaderAttemptState["status"], extra: Partial<LeaderAttemptState> = {}): LeaderAttemptState {
  counter += 1;
  return { id: `a${counter}`, key, status, supersededBy: null, outcome: null, report: null, error: null, baseline: "B1", live: false, round: 1, reportId: null, ...extra };
}
/** The team's members, by name (EO-882): what an assignment names. */
const MEMBERS: LeaderTeamMember[] = [
  { agentId: "agent-rita", name: "Rita", role: "reviewer" },
  { agentId: "agent-tom", name: "Tom", role: "tester" },
];
const ask = (key: string, member = "Rita", required = true): LeaderAssignment => ({ key, member, scope: `src/${key}/`, instructions: `Look at ${key}.`, required });
/** An assignment EO accepted, with the member's agent. */
const want = (key: string, member = "Rita", required = true): AcceptedAssignment => {
  const one = MEMBERS.find((each) => each.name === member)!;
  return { ...ask(key, member, required), agentId: one.agentId, role: one.role };
};
const assigned = (assignments: AcceptedAssignment[], extra: Partial<LeaderAttemptState> = {}): LeaderAttemptState =>
  attempt(LEADER_ASSIGNMENT_KEY, "completed", { verdict: { decision: "assign", accepted: assignments, refused: [] }, ...extra });
const reported = (key: string, extra: Partial<LeaderAttemptState> = {}) => attempt(key, "completed", { report: `${key} is fine.`, reportId: `c-${key}-${counter + 1}`, ...extra });
const finalTurn = (verdict: Extract<LeaderVerdict, { decision: "final" }>, extra: Partial<LeaderAttemptState> = {}) => attempt(LEADER_ASSIGNMENT_KEY, "completed", { verdict, ...extra });
/** Chains attempts as the supervisor does: each new leader turn supersedes the last. */
function chain(...attempts: LeaderAttemptState[]): LeaderAttemptState[] {
  let previous: LeaderAttemptState | null = null;
  for (const one of attempts) {
    if (one.key !== LEADER_ASSIGNMENT_KEY) continue;
    if (previous !== null) previous.supersededBy = one.id;
    previous = one;
  }
  return attempts;
}
const plan = (attempts: LeaderAttemptState[], baseline = "B1") => planLeaderTeam({ team: TEAM, attempts, baseline });

describe("planLeaderTeam (EO-847)", () => {
  it("starts the leader alone first, and nobody else", () => {
    const next = plan([]);
    expect(next.start).toEqual([{ key: LEADER_ASSIGNMENT_KEY, supersedes: null, why: "first", round: 1 }]);
    expect(next.next).toEqual({ kind: "continue" });
  });

  it("runs what the leader assigned with no leader turn alongside, then gives the leader its next turn once the round settles", () => {
    const lead = assigned([want("auth"), want("suite", "Tom", false)]);
    const first = plan([lead]);
    expect(first.start).toEqual([
      { key: "auth", supersedes: null, why: "first", round: 1 },
      { key: "suite", supersedes: null, why: "first", round: 1 },
    ]);
    const halfway = plan([lead, reported("auth"), attempt("suite", "running", { live: true })]);
    expect(halfway.start).toEqual([]);
    expect(halfway.working).toHaveLength(1);
    const settled = plan([lead, reported("auth"), reported("suite")]);
    expect(settled.start).toEqual([{ key: LEADER_ASSIGNMENT_KEY, supersedes: lead.id, why: "reports", round: 2 }]);
  });

  it("supersedes an earlier round's report when the leader follows up on its key", () => {
    const first = assigned([want("auth")]);
    const old = reported("auth");
    const again = assigned([{ ...want("auth"), instructions: "Look at the refresh." }], { round: 2 });
    const next = plan(chain(first, old, again));
    expect(next.start).toEqual([{ key: "auth", supersedes: old.id, why: "followup", round: 2 }]);
    expect(next.ledger.assignments).toEqual([{ ...want("auth"), instructions: "Look at the refresh.", round: 2 }]);
    expect(next.ledger.contributions).toEqual([]);
  });

  it("finalises only on an accepted answer whose reports are still current", () => {
    const lead = assigned([want("auth")]);
    const auth = reported("auth");
    const answer = finalTurn({ decision: "final", accepted: true, problems: [], contributions: [auth.reportId!] }, { round: 2 });
    expect(plan(chain(lead, auth, answer)).next).toEqual({ kind: "finalize", attemptId: answer.id });
    // On evidence that has moved, the report is done again first, and then the leader answers again.
    const moved = plan(chain(lead, auth, answer), "B2");
    expect(moved.start).toEqual([{ key: "auth", supersedes: auth.id, why: "stale", round: 1 }]);
    const redone = reported("auth", { baseline: "B2" });
    auth.supersededBy = redone.id;
    expect(plan(chain(lead, auth, answer, redone), "B2").start).toEqual([{ key: LEADER_ASSIGNMENT_KEY, supersedes: answer.id, why: "stale", round: 2 }]);
  });

  it("does not finalise an answer the leader gave on evidence that has since moved, even one relying on no report", () => {
    const answer = finalTurn({ decision: "final", accepted: true, problems: [], contributions: [] }, { baseline: "B1" });
    expect(plan([answer], "B1").next).toEqual({ kind: "finalize", attemptId: answer.id });
    expect(finalStands(leaderLedger([answer], "B2"), [answer], answer, "B2")).toBe(false);
    expect(plan([answer], "B2").start).toEqual([{ key: LEADER_ASSIGNMENT_KEY, supersedes: answer.id, why: "stale", round: 1 }]);
  });

  it("corrects a refused answer within the team's retries, and fails past them", () => {
    const refused = (round: number) => finalTurn({ decision: "final", accepted: false, problems: ["No."], contributions: [] }, { round });
    const once = refused(1);
    expect(plan(chain(once)).start).toEqual([{ key: LEADER_ASSIGNMENT_KEY, supersedes: once.id, why: "correction", round: 1 }]);
    const twice = chain(refused(1), refused(1));
    expect(plan(twice).next).toMatchObject({ kind: "failed", reason: expect.stringContaining("refused 2 times") });
    const crashed = chain(attempt(LEADER_ASSIGNMENT_KEY, "failed", { error: "Crashed." }), attempt(LEADER_ASSIGNMENT_KEY, "failed", { error: "Crashed." }));
    expect(plan(crashed).next).toMatchObject({ kind: "failed" });
  });

  it("stops with the reason for the last failure: a failed turn's error, or what EO refused (EO-886)", () => {
    const limited = chain(
      attempt(LEADER_ASSIGNMENT_KEY, "failed", { error: "Crashed." }),
      attempt(LEADER_ASSIGNMENT_KEY, "failed", { error: "You've hit your usage limit." }),
    );
    const failed = plan(limited).next;
    if (failed.kind !== "failed") throw new Error("failed");
    expect(failed.reason).toMatch(/failed or were refused 2 times[^]*\n\nThe last of them: You've hit your usage limit\.$/);

    const refused = (problems: string[]) => finalTurn({ decision: "final", accepted: false, problems, contributions: [] });
    const twice = plan(chain(refused(["No."]), refused(["It relies on no report."]))).next;
    if (twice.kind !== "failed") throw new Error("failed");
    expect(twice.reason).toContain("The last of them: EO refused its final answer — It relies on no report.");
    expect(twice.reason).not.toContain("ran out of retries");
  });

  it("names each member that ran out of retries with its last error when the leader stops (EO-886)", () => {
    const lead = assigned([want("auth"), want("suite", "Tom")]);
    const auth = [attempt("auth", "failed", { error: "Crashed." }), attempt("auth", "failed", { error: "The backend refused: rate limited." })];
    const suite = [attempt("suite", "failed", { error: "Timed out." }), attempt("suite", "failed", { error: "Its turn ended without an answer." })];
    // Each retry supersedes the attempt before it, as the supervisor writes them.
    auth[0]!.supersededBy = auth[1]!.id;
    suite[0]!.supersededBy = suite[1]!.id;
    const after = [attempt(LEADER_ASSIGNMENT_KEY, "failed", { error: "Crashed.", round: 2 }), attempt(LEADER_ASSIGNMENT_KEY, "failed", { error: "Signed out.", round: 2 })];
    const next = plan(chain(lead, ...auth, ...suite, ...after)).next;
    if (next.kind !== "failed") throw new Error("failed");
    expect(next.reason).toContain("The last of them: Signed out.");
    expect(next.reason).toContain("These members ran out of retries too:\n- **auth**: The backend refused: rate limited.\n- **suite**: Its turn ended without an answer.");
  });

  it("parks on a question nobody has answered, and carries the asker on once it is answered — participant or leader", () => {
    const lead = assigned([want("auth"), want("suite", "Tom")]);
    const asking = attempt("auth", "cancelled", { question: "open" });
    const parked = plan([lead, asking, reported("suite")]);
    expect(parked.next).toEqual({ kind: "park" });
    expect(parked.asking).toEqual(["auth"]);
    expect(parked.start).toEqual([]);
    asking.question = "answered";
    expect(plan([lead, asking, reported("suite")]).start).toEqual([{ key: "auth", supersedes: asking.id, why: "answered", round: 1 }]);

    const leaderAsks = attempt(LEADER_ASSIGNMENT_KEY, "cancelled", { question: "open" });
    expect(plan([leaderAsks]).next).toEqual({ kind: "park" });
    leaderAsks.question = "answered";
    expect(plan([leaderAsks]).start).toEqual([{ key: LEADER_ASSIGNMENT_KEY, supersedes: leaderAsks.id, why: "answered", round: 1 }]);
  });

  it("replaces a turn EO stopped without counting it, fencing one a restart orphaned", () => {
    const lead = assigned([want("auth")]);
    const orphan = attempt("auth", "running");
    const next = plan([lead, orphan]);
    expect(next.fence).toEqual([{ attemptId: orphan.id, why: "orphaned" }]);
    const stopped = attempt(LEADER_ASSIGNMENT_KEY, "cancelled");
    expect(plan([stopped]).start).toEqual([{ key: LEADER_ASSIGNMENT_KEY, supersedes: stopped.id, why: "interrupted", round: 1 }]);
  });
});

describe("checkLeaderAssignments (EO-847)", () => {
  const ledger = { roundsUsed: 0, keys: [] as string[] };

  it("accepts members by name within the limits, each as its agent, and refuses the rest with a reason each", () => {
    const verdict = checkLeaderAssignments(TEAM, ledger, [ask("auth"), ask("ops", "Ada"), ask(LEADER_ASSIGNMENT_KEY), ask("auth"), ask("suite", "Tom"), ask("more", "Tom")], MEMBERS);
    expect(verdict.accepted).toEqual([want("auth"), want("suite", "Tom")]);
    expect(verdict.refused).toEqual([
      { key: "ops", reason: '"Ada" is not a member of this team ("Rita", "Tom"), and a leader cannot widen who it may assign.' },
      { key: LEADER_ASSIGNMENT_KEY, reason: expect.stringContaining("the leader's own turns") },
      { key: "auth", reason: "The same key is named twice in one request." },
      { key: "more", reason: expect.stringContaining("2 participants in all") },
    ]);
  });

  it("takes a follow-up on a key in force as no new participant, and refuses every assignment past the last round", () => {
    expect(checkLeaderAssignments(TEAM, { roundsUsed: 1, keys: ["auth", "suite"] }, [ask("auth")], MEMBERS).accepted).toHaveLength(1);
    const past = checkLeaderAssignments(TEAM, { roundsUsed: 2, keys: ["auth"] }, [ask("auth"), ask("suite", "Tom")], MEMBERS);
    expect(past.accepted).toEqual([]);
    expect(past.refused.every((one) => one.reason.includes("2 rounds of assignments and all of them are used"))).toBe(true);
  });
});

describe("leaderFinalProblems (EO-847)", () => {
  it("refuses a missing required report, a superseded or unknown reliance, and naming none, whatever the answer claims", () => {
    const lead = assigned([want("auth"), want("suite", "Tom", false)]);
    const old = reported("auth");
    const follow = assigned([want("auth")], { round: 2 });
    const fresh = reported("auth", { round: 2 });
    old.supersededBy = fresh.id;
    const attempts = chain(lead, old, follow, fresh);
    const ledger = leaderLedger(attempts, "B1");
    expect(leaderFinalProblems(ledger, attempts, [fresh.reportId!])).toEqual([]);
    expect(leaderFinalProblems(ledger, attempts, [old.reportId!])).toEqual([expect.stringContaining("**auth**'s report, which is no longer current")]);
    expect(leaderFinalProblems(ledger, attempts, ["c-nobody"])).toEqual([expect.stringContaining("which is no accepted report of this team")]);
    expect(leaderFinalProblems(ledger, attempts, [])).toEqual(["It names none of the reports it relied on."]);

    const missing = chain(lead, attempt("auth", "failed", { error: "Crashed." }), attempt("auth", "failed", { error: "Crashed." }));
    expect(leaderFinalProblems(leaderLedger(missing, "B1"), missing, [])).toEqual([expect.stringContaining("The required assignment **auth** has no accepted report")]);
  });
});

describe("ruledOutProblems (EO-873)", () => {
  const outcomes = [
    { key: "clear", label: "Nothing blocks" },
    { key: "blocking", label: "Blocking issues", rulesOut: ["approved"] },
    { key: "needs_decision", label: "Needs a decision", rulesOut: ["approved"] },
  ];
  const contributions = [
    { key: "criteria", reportId: "c-criteria", outcome: "blocking" },
    { key: "tests", reportId: "c-tests", outcome: "clear" },
  ];

  it("refuses a result an accepted report's outcome rules out, naming the report, when the disagreements do not name it", () => {
    expect(ruledOutProblems(outcomes, contributions, "approved", "None.")).toEqual([
      'Its result "approved" is one **criteria**\'s report (comment c-criteria) rules out: it concluded "Blocking issues" (blocking). Answer with a result that report allows, or overrule it on a line of your disagreements of its own: `Overruled criteria: <why>`.',
    ]);
    // Every report that rules it out, each said once.
    const two = [...contributions, { key: "rules", reportId: "c-rules", outcome: "needs_decision" }];
    expect(ruledOutProblems(outcomes, two, "approved", "Overruled criteria: the case it names cannot happen.")).toEqual([expect.stringContaining("**rules**'s report")]);
  });

  it("accepts the result where the disagreements overrule the report, by key or comment id, and say why", () => {
    expect(ruledOutProblems(outcomes, contributions, "approved", "Overruled criteria: the off-by-one it reports is the documented behaviour.")).toEqual([]);
    expect(ruledOutProblems(outcomes, contributions, "approved", "Overruled comment c-criteria: checked, and it is not a bug.")).toEqual([]);
    // On a line of its own among others, as a list item, with markdown around the key, or after a dash.
    expect(ruledOutProblems(outcomes, contributions, "approved", "The passes agreed otherwise.\n- Overruled **criteria**: the case it names cannot happen.")).toEqual([]);
    expect(ruledOutProblems(outcomes, contributions, "approved", "Overruled `criteria` — the fixture it names never ships.")).toEqual([]);
  });

  it("refuses where the disagreements only mention the report, or overrule it without a reason", () => {
    // A bare identifier is not an override.
    expect(ruledOutProblems(outcomes, contributions, "approved", "criteria")).toHaveLength(1);
    expect(ruledOutProblems(outcomes, contributions, "approved", "c-criteria")).toHaveLength(1);
    // Nor is an incidental mention, even one that says it disagreed.
    expect(ruledOutProblems(outcomes, contributions, "approved", "No disagreements with criteria.")).toHaveLength(1);
    expect(ruledOutProblems(outcomes, contributions, "approved", "I disagreed with criteria and overruled it.")).toHaveLength(1);
    // An override with nothing after the colon, or only punctuation, gives no reason.
    expect(ruledOutProblems(outcomes, contributions, "approved", "Overruled criteria:")).toHaveLength(1);
    expect(ruledOutProblems(outcomes, contributions, "approved", "Overruled criteria: ...")).toHaveLength(1);
    // An override of another report is not one of this.
    expect(ruledOutProblems(outcomes, contributions, "approved", "Overruled tests: it ran nothing.")).toHaveLength(1);
    // A key inside another word is not the report named.
    expect(ruledOutProblems(outcomes, contributions, "approved", "Overruled criteria_coverage: the table is complete.")).toHaveLength(1);
  });

  it("accepts any result no current report's outcome rules out", () => {
    expect(ruledOutProblems(outcomes, contributions, "changes_requested", "None.")).toEqual([]);
    expect(ruledOutProblems(outcomes, [{ key: "tests", reportId: "c-tests", outcome: "clear" }], "approved", "None.")).toEqual([]);
    expect(ruledOutProblems([{ key: "blocking", label: "Blocking" }], contributions, "approved", "None.")).toEqual([]);
    // A report with no outcome — a team that declares none — rules out nothing.
    expect(ruledOutProblems(outcomes, [{ key: "criteria", reportId: "c-criteria", outcome: null }], "approved", "None.")).toEqual([]);
  });
});

describe("planIndependentTeam with a participant asking (EO-847)", () => {
  const team = IndependentTeamSchema.parse({
    coordination: "independent",
    participants: [
      { key: "security", role: "reviewer", instructions: "Look for ways in." },
      { key: "tests", role: "tester", instructions: "Check the tests." },
    ],
    outcomes: [{ key: "clear", label: "Nothing found" }],
    completion: { rules: [], fallback: "approved" },
  });

  it("decides nothing while a question is open, and restarts only the asker on the answer, keeping its sibling's report", () => {
    const asking = attempt("security", "cancelled", { question: "open" });
    const tests = attempt("tests", "completed", { outcome: "clear", report: "Fine." });
    const open = planIndependentTeam({ team, attempts: [asking, tests], baseline: "B1" });
    expect(open.asking).toEqual(["security"]);
    expect(open.start).toEqual([]);
    expect(open.decision.status).toBe("pending");
    asking.question = "answered";
    const answered = planIndependentTeam({ team, attempts: [asking, tests], baseline: "B1" });
    expect(answered.start).toEqual([{ key: "security", supersedes: asking.id, why: "answered" }]);
    // A question answered after the evidence moved is started on the new evidence, and the sibling's old verdict is not kept.
    const moved = planIndependentTeam({ team, attempts: [asking, tests], baseline: "B2" });
    expect(moved.start).toEqual([
      { key: "security", supersedes: asking.id, why: "stale" },
      { key: "tests", supersedes: tests.id, why: "stale" },
    ]);
  });
});
