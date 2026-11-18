import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  StepTeamSchema,
  TEAM_ENFORCEMENT_UNAVAILABLE,
  TEAM_PARTICIPANT_ACTION,
  TeamSessionViewSchema,
  teamWaitNote,
  type Item,
  type StepTeam,
  type Uuid,
} from "@eo/core";
import type { DbHandle } from "../db/client.js";
import { createAgent } from "../db/repos/agentsRepo.js";
import { postComment } from "../db/repos/commentsRepo.js";
import { createRun, updateRun } from "../db/repos/runsRepo.js";
import { acceptTeamReport, endTeamAttempt, endTeamSession, openTeamSession, startTeamAttempt } from "../db/repos/teamSessionsRepo.js";
import { transitionItem } from "../db/repos/transitionsRepo.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { itemTeamSessions } from "./teamSessionView.js";

/**
 * An item's team sessions as a person reads them (EO-849), built from what
 * is stored alone: every case here writes rows the way the supervisor does
 * and reads the view back, as a window opened afterwards would.
 */

const TEAM: StepTeam = StepTeamSchema.parse({
  coordination: "independent",
  participants: [
    { key: "security", role: "reviewer", instructions: "Look for ways in." },
    { key: "clarity", role: "writer", instructions: "Read it as a newcomer.", required: false },
  ],
  outcomes: [
    { key: "clear", label: "Nothing found" },
    { key: "blocking", label: "Blocking issue" },
  ],
  completion: { rules: [{ when: "any", outcomes: ["blocking"], result: "rejected" }], fallback: "approved" },
});

const LEADER: StepTeam = StepTeamSchema.parse({
  coordination: "leader",
  leader: { role: "lead", instructions: "Decide whether it is ready." },
  roles: ["reviewer"],
});

let handle: DbHandle;
let item: Item;
let rita: Uuid;
let cody: Uuid;
let lena: Uuid;

beforeEach(() => {
  handle = openMigratedTestDb();
  item = createTestItem(handle.db, { type: "story", title: "Review the change", stepId: "todo" });
  rita = createAgent(handle.db, { name: "Rita", role: "reviewer", provider: "claude", model: null, instructions: "Review." }).id as Uuid;
  cody = createAgent(handle.db, { name: "Cody", role: "writer", provider: "codex", model: "gpt-5", instructions: "Write." }).id as Uuid;
  lena = createAgent(handle.db, { name: "Lena", role: "lead", provider: "codex", model: "gpt-5", instructions: "Lead." }).id as Uuid;
});

afterEach(() => handle.close());

function teamRun(status: "running" | "awaiting_input" | "succeeded" = "running", error: string | null = null) {
  const run = createRun(handle.db, { itemId: item.id, agentId: null, action: "review", stepId: "todo", status });
  updateRun(handle.db, run.id, { startedAt: 1, ...(error === null ? {} : { error }) });
  return run;
}

/** A participant's turn: its own run on its own backend, and the attempt naming it. */
function participant(sessionId: string, key: string, agentId: Uuid, provider: string, cents: number, extra: { supersedes?: string; round?: number; baseline?: string } = {}) {
  const run = createRun(handle.db, { itemId: item.id, agentId, action: TEAM_PARTICIPANT_ACTION, stepId: "todo", status: "running", provider });
  updateRun(handle.db, run.id, { startedAt: 2, costCents: cents, tokensIn: 100, tokensOut: 10 });
  const started = startTeamAttempt(handle.db, {
    sessionId,
    assignmentKey: key,
    role: key === "leader" ? "lead" : key === "clarity" ? "writer" : "reviewer",
    agentId,
    instructions: `Work on ${key}.`,
    runId: run.id,
    evidenceBaseline: { kind: "none", ref: extra.baseline ?? "nothing" },
    ...(extra.supersedes === undefined ? {} : { supersedes: extra.supersedes }),
    ...(extra.round === undefined ? {} : { round: extra.round }),
  });
  if (!started.ok) throw new Error(started.problem);
  return { attempt: started.attempt, run };
}

function report(attemptId: string, runId: Uuid, outcome: string | null, text: string) {
  const accepted = acceptTeamReport(handle.db, { attemptId, outcome, report: text });
  if (!accepted.ok) throw new Error(accepted.problem);
  updateRun(handle.db, runId, { status: "succeeded", endedAt: 3 });
  return accepted.comment;
}

function fail(attemptId: string, runId: Uuid, error: string) {
  endTeamAttempt(handle.db, attemptId, { status: "failed", error });
  updateRun(handle.db, runId, { status: "failed", error, endedAt: 3 });
}

/** This desktop, driving whatever team run is working: the solo desktop's case. */
const here = { deviceId: "local", drives: () => true };
const view = () => itemTeamSessions(handle.db, item.id, here);

describe("an item's team sessions, as a person reads them (EO-849)", () => {
  it("is empty for an item no team has worked", () => {
    expect(view()).toEqual([]);
  });

  it("shows one session with its participants underneath, attributed across backends, and counts each run's spending once", () => {
    const parent = teamRun();
    const session = openTeamSession(handle.db, { itemId: item.id, stepId: "todo", team: TEAM, runId: parent.id });
    const security = participant(session.id, "security", rita, "claude", 30);
    const comment = report(security.attempt.id, security.run.id, "clear", "Nothing to see.");
    participant(session.id, "clarity", cody, "codex", 12);

    const [shown] = view();
    expect(TeamSessionViewSchema.parse(shown)).toEqual(shown);
    expect(shown?.state).toBe("running");
    expect(shown?.current).toBe(true);
    expect(shown?.assignments.map((one) => [one.key, one.attempts.map((attempt) => [attempt.agentName, attempt.provider, attempt.state])])).toEqual([
      ["security", [["Rita", "claude", "completed"]]],
      ["clarity", [["Cody", "codex", "running"]]],
    ]);
    const done = shown!.assignments[0]!.attempts[0]!;
    expect(done.reportCommentId).toBe(comment.id);
    expect(done.outcomeLabel).toBe("Nothing found");
    expect(done.baseline).toEqual({ kind: "none", ref: "nothing", capturedAt: null });
    expect(shown?.assignments[1]?.required).toBe(false);
    // 30¢ and 12¢, each once; the team's own run spent nothing and is no second copy of them.
    expect(shown?.totals).toEqual({ runs: 3, costCents: 42, tokensIn: 200, tokensOut: 20, teamRunCents: 0 });
    expect(shown?.waiting).toEqual([{ kind: "contribution", keys: ["clarity"], text: "Waiting on **clarity** to report." }]);
    expect(shown?.cancel).toEqual({ allowed: true, reason: null });
    expect(shown?.retry.allowed).toBe(false);
    expect(shown?.retry.reason).toContain("still at work");
    // The same stored records read again are the same session.
    expect(view()).toEqual([shown]);
  });

  it("says an assignment is waiting for room, from the note EO left on the thread, until it starts", () => {
    const parent = teamRun();
    const session = openTeamSession(handle.db, { itemId: item.id, stepId: "todo", team: TEAM, runId: parent.id });
    participant(session.id, "security", rita, "claude", 0);
    postComment(handle.db, { itemId: item.id, runId: parent.id, author: { type: "engine" }, kind: "note", body: teamWaitNote("clarity", "capacity", "the team runs 1 participant at a time.") });
    postComment(handle.db, { itemId: item.id, runId: parent.id, author: { type: "engine" }, kind: "note", body: teamWaitNote("clarity", "restricted", "EO is paused.") });
    expect(view()[0]?.waiting.map((wait) => [wait.kind, wait.keys, wait.text])).toEqual([
      ["restricted", ["clarity"], "EO is paused."],
      ["contribution", ["security"], "Waiting on **security** to report."],
    ]);
    participant(session.id, "clarity", cody, "codex", 0);
    expect(view()[0]?.waiting.map((wait) => wait.kind)).toEqual(["contribution"]);
  });

  it("keeps a superseded attempt and a superseded session as history, never as current work", () => {
    const parent = teamRun();
    const old = openTeamSession(handle.db, { itemId: item.id, stepId: "todo", team: TEAM, runId: parent.id });
    const first = participant(old.id, "security", rita, "claude", 5, { baseline: "v1" });
    report(first.attempt.id, first.run.id, "blocking", "The old version leaks.");
    const again = participant(old.id, "security", rita, "claude", 7, { supersedes: first.attempt.id, baseline: "v2" });
    const second = teamRun();
    openTeamSession(handle.db, { itemId: item.id, stepId: "todo", team: TEAM, runId: second.id });

    const [current, earlier] = view();
    expect(current?.current).toBe(true);
    expect(earlier?.state).toBe("superseded");
    expect(earlier?.current).toBe(false);
    const attempts = earlier!.assignments[0]!.attempts;
    expect(attempts.map((attempt) => [attempt.state, attempt.outcome])).toEqual([
      ["superseded", "blocking"],
      ["stopped", null],
    ]);
    expect(attempts[1]?.supersedes).toBe(first.attempt.id);
    expect(earlier?.assignments[0]?.current).toBe(again.attempt.id);
    expect(earlier?.totals.costCents).toBe(12);
    expect(earlier?.cancel.allowed).toBe(false);
    expect(earlier?.retry).toMatchObject({ allowed: false });
    expect(earlier?.retry.reason).toContain("never runs again");
  });

  it("tells a failed contribution apart from a negative finding, and offers to retry only what failed once the team is parked", () => {
    const parent = teamRun("awaiting_input", "The team could not decide: **security** could not contribute after 1 retry.");
    const session = openTeamSession(handle.db, { itemId: item.id, stepId: "todo", team: TEAM, runId: parent.id });
    const security = participant(session.id, "security", rita, "claude", 4);
    fail(security.attempt.id, security.run.id, "The backend crashed.");
    const clarity = participant(session.id, "clarity", cody, "codex", 6);
    report(clarity.attempt.id, clarity.run.id, "blocking", "The intro is unreadable.");

    const [shown] = view();
    expect(shown?.state).toBe("waiting");
    const states = shown!.assignments.map((one) => [one.key, one.attempts.at(-1)?.state, one.attempts.at(-1)?.outcome]);
    expect(states).toEqual([
      ["security", "failed", null],
      ["clarity", "completed", "blocking"],
    ]);
    expect(shown?.waiting).toEqual([{ kind: "limits", keys: ["security"], text: "The team could not decide: **security** could not contribute after 1 retry." }]);
    expect(shown?.retry).toEqual({ allowed: true, reason: null, keys: ["security"] });
  });

  it("names the assignment a question came from, and holds the retry until it is answered", () => {
    const parent = teamRun("awaiting_input");
    const session = openTeamSession(handle.db, { itemId: item.id, stepId: "todo", team: TEAM, runId: parent.id });
    const clarity = participant(session.id, "clarity", cody, "codex", 2);
    const question = postComment(handle.db, { itemId: item.id, runId: clarity.run.id, author: { type: "agent", agentId: cody }, kind: "question", body: "Who is the reader?" });
    endTeamAttempt(handle.db, clarity.attempt.id, { status: "cancelled", error: "It asked the person a question." });
    updateRun(handle.db, clarity.run.id, { status: "succeeded", endedAt: 3 });

    let [shown] = view();
    const asked = shown!.assignments[1]!.attempts[0]!;
    expect(asked.state).toBe("waiting");
    expect(asked.questions).toEqual([{ commentId: question.id, body: "Who is the reader?", answered: false }]);
    expect(shown?.waiting[0]).toMatchObject({ kind: "human", keys: ["clarity"] });
    expect(shown?.retry.reason).toContain("question is still open");

    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "A new hire.", parentId: question.id });
    [shown] = view();
    expect(shown!.assignments[1]!.attempts[0]!.questions[0]?.answered).toBe(true);
    expect(shown!.assignments[1]!.attempts[0]!.state).toBe("cancelled");
  });

  it("says when EO could not hold an agent to report-only, apart from a participant that tried and failed", () => {
    const parent = teamRun("awaiting_input", "could not decide");
    const session = openTeamSession(handle.db, { itemId: item.id, stepId: "todo", team: TEAM, runId: parent.id });
    const made = startTeamAttempt(handle.db, { sessionId: session.id, assignmentKey: "security", role: "reviewer", agentId: rita, instructions: "Look." });
    if (!made.ok) throw new Error(made.problem);
    endTeamAttempt(handle.db, made.attempt.id, { status: "failed", error: `${TEAM_ENFORCEMENT_UNAVAILABLE}a Codex sign-in in the keyring cannot be held.` });

    const [shown] = view();
    expect(shown!.assignments[0]!.attempts[0]!.enforcementUnavailable).toBe(true);
    expect(shown?.waiting.find((wait) => wait.kind === "enforcement")).toMatchObject({ keys: ["security"] });
    expect(shown?.waiting.find((wait) => wait.kind === "enforcement")?.text).toContain("a Codex sign-in in the keyring cannot be held.");
  });

  it("never shows a session whose item moved, or one that ended, as running, whatever a late attempt says", () => {
    const parent = teamRun();
    const session = openTeamSession(handle.db, { itemId: item.id, stepId: "todo", team: TEAM, runId: parent.id });
    participant(session.id, "security", rita, "claude", 3);
    transitionItem(handle.db, { itemId: item.id, toStepId: "review", actor: "human" });

    let [shown] = view();
    expect(shown?.state).toBe("stopped");
    expect(shown?.current).toBe(false);
    expect(shown?.assignments[0]?.attempts[0]?.state).toBe("stopped");
    expect(shown?.waiting).toEqual([]);
    expect(shown?.retry.allowed).toBe(false);

    endTeamSession(handle.db, { sessionId: session.id, status: "cancelled" });
    [shown] = view();
    expect(shown?.state).toBe("cancelled");
    expect(shown?.assignments[0]?.attempts[0]?.state).toBe("stopped");
    expect(shown?.cancel.allowed).toBe(false);
    // A late report is refused, so the attempt cannot read as a finding either.
    expect(acceptTeamReport(handle.db, { attemptId: shown!.assignments[0]!.attempts[0]!.id, outcome: "clear", report: "Late." }).ok).toBe(false);
  });

  it("links an independent team's result to the completion rule and the reports it read", () => {
    const parent = teamRun("succeeded");
    const session = openTeamSession(handle.db, { itemId: item.id, stepId: "todo", team: TEAM, runId: parent.id });
    const security = participant(session.id, "security", rita, "claude", 1);
    report(security.attempt.id, security.run.id, "clear", "Fine.");
    const clarity = participant(session.id, "clarity", cody, "codex", 1);
    report(clarity.attempt.id, clarity.run.id, "blocking", "Confusing.");
    endTeamSession(handle.db, { sessionId: session.id, status: "finalized", result: "rejected" });
    const output = postComment(handle.db, { itemId: item.id, runId: parent.id, author: { type: "agent", agentId: rita }, body: "rejected: Confusing." });

    const [shown] = view();
    expect(shown?.state).toBe("finalized");
    expect(shown?.final).toEqual({
      by: "rule",
      rule: "If any report concludes Blocking issue → rejected",
      ruleIndex: 0,
      contributions: [security.attempt.id, clarity.attempt.id],
      outputCommentId: output.id,
    });
  });

  it("links a leader's result to its answer, the reports it relied on and what it could not establish", () => {
    const parent = teamRun("succeeded");
    const session = openTeamSession(handle.db, { itemId: item.id, stepId: "todo", team: LEADER, runId: parent.id });
    const assign = participant(session.id, "leader", lena, "codex", 2);
    updateRun(handle.db, assign.run.id, { result: { leader: true, answer: { decision: "assign" }, verdict: { decision: "assign", accepted: [{ key: "auth", role: "reviewer", instructions: "Check login.", required: true }], refused: [] } } });
    report(assign.attempt.id, assign.run.id, null, "Assigns round 1.");
    const auth = participant(session.id, "auth", rita, "claude", 3);
    const authReport = report(auth.attempt.id, auth.run.id, null, "Login is fine.");
    const finalTurn = participant(session.id, "leader", lena, "codex", 2, { supersedes: assign.attempt.id, round: 2 });
    const answer = { decision: "final", answer: { result: "aligned" }, contributions: [authReport.id], disagreements: "none", limitations: "Did not test on Windows." };
    updateRun(handle.db, finalTurn.run.id, { result: { leader: true, answer, verdict: { decision: "final", accepted: true, problems: [], contributions: [authReport.id] }, value: { result: "aligned" } } });
    const finalComment = report(finalTurn.attempt.id, finalTurn.run.id, null, "Aligned.");
    endTeamSession(handle.db, { sessionId: session.id, status: "finalized", result: "aligned", finalCommentId: finalComment.id });

    const [shown] = view();
    expect(shown?.coordination).toBe("leader");
    expect(shown?.assignments.map((one) => [one.key, one.leader, one.required, one.attempts.map((attempt) => attempt.state)])).toEqual([
      ["leader", true, true, ["superseded", "completed"]],
      ["auth", false, true, ["completed"]],
    ]);
    expect(shown?.final).toEqual({
      by: "leader",
      attemptId: finalTurn.attempt.id,
      outputCommentId: finalComment.id,
      contributions: [auth.attempt.id],
      disagreements: "none",
      limitations: "Did not test on Windows.",
    });
    expect(shown?.totals.costCents).toBe(7);
  });
});
