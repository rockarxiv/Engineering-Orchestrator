import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { StepTeamSchema, type Item, type StepTeam, type Uuid } from "@eo/core";
import type { DbHandle } from "../client.js";
import { createTestItem, openMigratedTestDb } from "../testHelpers.js";
import { createAgent, deleteAgent, updateAgent } from "./agentsRepo.js";
import { createRun, sumCostCentsForItem, sumCostCentsSince, updateRun } from "./runsRepo.js";
import { listCommentsForItem } from "./commentsRepo.js";
import { deleteItem, setItemArchived } from "./itemsRepo.js";
import { transitionItem } from "./transitionsRepo.js";
import { onTeamSessionWritten } from "../teamSessionEvents.js";
import {
  acceptTeamReport,
  beginTeamAttempt,
  currentTeamSession,
  endTeamAttempt,
  endTeamSession,
  getTeamSessionRecord,
  listTeamSessionsForItem,
  openTeamSession,
  startTeamAttempt,
  teamSessionTotals,
} from "./teamSessionsRepo.js";

/**
 * Team sessions, attempts and reports, kept (EO-844). An in-memory
 * database, as everything touching SQLite is tested.
 */

const TEAM: StepTeam = StepTeamSchema.parse({
  coordination: "independent",
  participants: [
    { key: "security", role: "reviewer", instructions: "Look for ways in." },
    { key: "clarity", role: "reviewer", instructions: "Read it as a newcomer.", required: false },
  ],
  outcomes: [
    { key: "clear", label: "Nothing found" },
    { key: "blocking", label: "Blocking issue" },
  ],
  completion: { rules: [{ when: "any", outcomes: ["blocking"], result: "rejected" }], fallback: "approved" },
});

let handle: DbHandle;
let item: Item;
let reviewer: Uuid;

beforeEach(() => {
  handle = openMigratedTestDb();
  item = createTestItem(handle.db, { type: "story", title: "Review the change", stepId: "todo" });
  reviewer = createAgent(handle.db, { name: "Rita", role: "reviewer", provider: "fake", model: null, instructions: "Review." }).id as Uuid;
});

afterEach(() => handle.close());

/** A participant's attempt with a run behind it, as an orchestrator starts one. */
function attemptWithRun(sessionId: string, key: string, extra: { supersedes?: string; round?: number } = {}) {
  const run = createRun(handle.db, { itemId: item.id, agentId: reviewer, action: "review", stepId: "todo", status: "running" });
  const started = startTeamAttempt(handle.db, {
    sessionId,
    assignmentKey: key,
    role: "reviewer",
    agentId: reviewer,
    instructions: `Attempt at ${key}.`,
    runId: run.id,
    evidenceBaseline: { kind: "git-worktree", ref: `tree-${key}` },
    ...extra,
  });
  if (!started.ok) throw new Error(started.problem);
  return { attempt: started.attempt, run };
}

describe("a team session", () => {
  it("keeps failed, completed and superseded attempts with their relationships", () => {
    const parent = createRun(handle.db, { itemId: item.id, agentId: null, action: "review", stepId: "todo", status: "running" });
    const session = openTeamSession(handle.db, { itemId: item.id, stepId: "todo", team: TEAM, runId: parent.id });

    const failed = attemptWithRun(session.id, "security");
    expect(endTeamAttempt(handle.db, failed.attempt.id, { status: "failed", error: "The run timed out." }).ok).toBe(true);
    const retry = attemptWithRun(session.id, "security", { supersedes: failed.attempt.id });
    const accepted = acceptTeamReport(handle.db, { attemptId: retry.attempt.id, outcome: "blocking", report: "The token is logged in clear." });
    expect(accepted.ok).toBe(true);
    const clarity = attemptWithRun(session.id, "clarity");
    expect(acceptTeamReport(handle.db, { attemptId: clarity.attempt.id, outcome: "clear", report: "Reads well." }).ok).toBe(true);
    expect(endTeamSession(handle.db, { sessionId: session.id, status: "finalized", result: "rejected" }).ok).toBe(true);

    const read = getTeamSessionRecord(handle.db, session.id)!;
    expect(read.session).toMatchObject({ itemId: item.id, stepId: "todo", runId: parent.id, status: "finalized", result: "rejected", team: TEAM });
    expect(read.session.pipelineVersionId).toBe(item.pipelineVersionId);
    expect(read.attempts.map((one) => [one.assignmentKey, one.attempt, one.status, one.outcome, one.supersededBy])).toEqual([
      ["security", 1, "failed", null, retry.attempt.id],
      ["security", 2, "completed", "blocking", null],
      ["clarity", 1, "completed", "clear", null],
    ]);
    // The failed attempt keeps what went wrong; nothing about it was rewritten when it was replaced.
    expect(read.attempts[0]).toMatchObject({ error: "The run timed out.", runId: failed.run.id, reportCommentId: null, evidenceBaseline: { kind: "git-worktree", ref: "tree-security" } });
    expect(read.attempts[1]).toMatchObject({ runId: retry.run.id, agentId: reviewer, agentName: "Rita", round: 1 });

    // The report is a comment on the item's thread, attributed to the agent and the attempt's run.
    const report = listCommentsForItem(handle.db, item.id).find((comment) => comment.id === read.attempts[1]!.reportCommentId)!;
    expect(report).toMatchObject({ authorType: "agent", authorId: reviewer, runId: retry.run.id, kind: "note" });
    expect(report.body).toContain("**security** — Blocking issue");
    expect(report.body).toContain("The token is logged in clear.");
  });

  it("starts a session that is open apart from whether any provider is running", () => {
    const session = openTeamSession(handle.db, { itemId: item.id, stepId: "todo", team: TEAM });
    const queued = startTeamAttempt(handle.db, { sessionId: session.id, assignmentKey: "security", role: "reviewer", agentId: reviewer, instructions: "Go." });
    expect(queued.ok && queued.attempt.status).toBe("queued");
    expect(currentTeamSession(handle.db, item.id)?.status).toBe("open");

    const run = createRun(handle.db, { itemId: item.id, agentId: reviewer, action: "review", stepId: "todo" });
    const begun = beginTeamAttempt(handle.db, queued.ok ? queued.attempt.id : "", run.id);
    expect(begun.ok && begun.attempt).toMatchObject({ status: "running", runId: run.id });
    // A started attempt is not given a second run: another run is another attempt.
    const other = createRun(handle.db, { itemId: item.id, agentId: reviewer, action: "review", stepId: "todo" });
    expect(beginTeamAttempt(handle.db, queued.ok ? queued.attempt.id : "", other.id).ok).toBe(false);
  });

  it("refuses an attempt at a key the independent team does not have", () => {
    const session = openTeamSession(handle.db, { itemId: item.id, stepId: "todo", team: TEAM });
    const answer = startTeamAttempt(handle.db, { sessionId: session.id, assignmentKey: "performance", role: "reviewer", agentId: reviewer, instructions: "Go." });
    expect(answer).toEqual({ ok: false, problem: 'This team has no participant "performance".' });
  });
});

describe("a delivered result", () => {
  it("delivered twice posts one report and accepts one contribution", () => {
    const session = openTeamSession(handle.db, { itemId: item.id, stepId: "todo", team: TEAM });
    const { attempt } = attemptWithRun(session.id, "security");
    const announced: string[] = [];
    const stop = onTeamSessionWritten(handle.db, (written) => announced.push(written.sessionId));

    const first = acceptTeamReport(handle.db, { attemptId: attempt.id, outcome: "clear", report: "Nothing to see." });
    const second = acceptTeamReport(handle.db, { attemptId: attempt.id, outcome: "blocking", report: "Nothing to see." });
    stop();

    expect(first.ok && first.duplicate).toBe(false);
    expect(second.ok && second.duplicate).toBe(true);
    expect(second.ok && first.ok && second.comment.id).toBe(first.ok ? first.comment.id : "");
    expect(listCommentsForItem(handle.db, item.id).filter((comment) => comment.body.includes("Nothing to see."))).toHaveLength(1);
    const attempts = getTeamSessionRecord(handle.db, session.id)!.attempts;
    expect(attempts.filter((one) => one.reportCommentId !== null)).toHaveLength(1);
    // The second delivery changed nothing, so it told nobody anything.
    expect(attempts[0]!.outcome).toBe("clear");
    expect(announced).toEqual([session.id]);
  });

  it("is refused with an outcome the team does not declare, and writes nothing", () => {
    const session = openTeamSession(handle.db, { itemId: item.id, stepId: "todo", team: TEAM });
    const { attempt } = attemptWithRun(session.id, "security");
    const before = listCommentsForItem(handle.db, item.id).length;

    expect(acceptTeamReport(handle.db, { attemptId: attempt.id, outcome: "maybe", report: "Hm." })).toEqual({ ok: false, problem: '"maybe" is not an outcome this team declares.' });
    expect(listCommentsForItem(handle.db, item.id)).toHaveLength(before);
  });
});

describe("what a team spent", () => {
  it("is its runs, each counted once in the item's and the day's totals", () => {
    const since = Date.now() - 60_000;
    const parent = createRun(handle.db, { itemId: item.id, agentId: null, action: "review", stepId: "todo", status: "running" });
    updateRun(handle.db, parent.id, { startedAt: Date.now(), costCents: 3, tokensIn: 100, tokensOut: 10 });
    const session = openTeamSession(handle.db, { itemId: item.id, stepId: "todo", team: TEAM, runId: parent.id });
    const spent = [
      [attemptWithRun(session.id, "security"), 40],
      [attemptWithRun(session.id, "clarity"), 25],
    ] as const;
    for (const [{ run }, cents] of spent) updateRun(handle.db, run.id, { startedAt: Date.now(), costCents: cents, tokensIn: 1_000, tokensOut: 50 });
    // A replaced attempt's spending happened, and is counted.
    const replaced = attemptWithRun(session.id, "security", { supersedes: spent[0][0].attempt.id });
    updateRun(handle.db, replaced.run.id, { startedAt: Date.now(), costCents: 7, tokensIn: 200, tokensOut: 5 });

    const totals = teamSessionTotals(handle.db, session.id);
    expect(totals).toEqual({ runs: 4, tokensIn: 2_300, tokensOut: 115, costCents: 3 + 40 + 25 + 7 });
    // The parent's own figure is its own: the children's are not folded into it.
    expect(sumCostCentsForItem(handle.db, item.id)).toBe(totals.costCents);
    expect(sumCostCentsSince(handle.db, since)).toBe(totals.costCents);
  });
});

describe("a stale session", () => {
  it("superseded by a newer one cannot accept a contribution or be finalised", () => {
    const old = openTeamSession(handle.db, { itemId: item.id, stepId: "todo", team: TEAM });
    const { attempt } = attemptWithRun(old.id, "security");
    const fresh = openTeamSession(handle.db, { itemId: item.id, stepId: "todo", team: TEAM });

    expect(getTeamSessionRecord(handle.db, old.id)!.session).toMatchObject({ status: "superseded", supersededBy: fresh.id });
    expect(currentTeamSession(handle.db, item.id)?.id).toBe(fresh.id);
    const late = acceptTeamReport(handle.db, { attemptId: attempt.id, outcome: "clear", report: "Late." });
    expect(late.ok).toBe(false);
    expect(endTeamSession(handle.db, { sessionId: old.id, status: "finalized", result: "approved" }).ok).toBe(false);
    expect(startTeamAttempt(handle.db, { sessionId: old.id, assignmentKey: "clarity", role: "reviewer", agentId: reviewer, instructions: "Go." }).ok).toBe(false);
    expect(listCommentsForItem(handle.db, item.id).some((comment) => comment.body.includes("Late."))).toBe(false);
  });

  it("whose item has left its step cannot accept a contribution or be finalised, and can still be cancelled", () => {
    const session = openTeamSession(handle.db, { itemId: item.id, stepId: "todo", team: TEAM });
    const { attempt } = attemptWithRun(session.id, "security");
    transitionItem(handle.db, { itemId: item.id, toStepId: "review", actor: "human" });

    expect(acceptTeamReport(handle.db, { attemptId: attempt.id, outcome: "clear", report: "Too late." }).ok).toBe(false);
    expect(endTeamAttempt(handle.db, attempt.id, { status: "cancelled", error: "The item moved on." }).ok).toBe(true);
    expect(endTeamSession(handle.db, { sessionId: session.id, status: "finalized", result: "approved" }).ok).toBe(false);
    expect(endTeamSession(handle.db, { sessionId: session.id, status: "cancelled" }).ok).toBe(true);
  });

  it("cannot be finalised while an attempt is still at work, nor accept a report on a replaced attempt", () => {
    const session = openTeamSession(handle.db, { itemId: item.id, stepId: "todo", team: TEAM });
    const first = attemptWithRun(session.id, "security");
    const second = attemptWithRun(session.id, "security", { supersedes: first.attempt.id });

    expect(endTeamSession(handle.db, { sessionId: session.id, status: "finalized", result: "approved" })).toEqual({ ok: false, problem: "Still at work: security." });
    expect(acceptTeamReport(handle.db, { attemptId: first.attempt.id, outcome: "clear", report: "Old." }).ok).toBe(false);
    expect(acceptTeamReport(handle.db, { attemptId: second.attempt.id, outcome: "clear", report: "New." }).ok).toBe(true);
    expect(endTeamSession(handle.db, { sessionId: session.id, status: "finalized", result: "approved" }).ok).toBe(true);
    // Finalising again with the same result is not an error, and a different one is refused.
    expect(endTeamSession(handle.db, { sessionId: session.id, status: "finalized", result: "approved" }).ok).toBe(true);
    expect(endTeamSession(handle.db, { sessionId: session.id, status: "finalized", result: "rejected" }).ok).toBe(false);
  });
});

describe("team data kept or removed with the item", () => {
  function sessionWithReport() {
    const session = openTeamSession(handle.db, { itemId: item.id, stepId: "todo", team: TEAM });
    const { attempt } = attemptWithRun(session.id, "security");
    acceptTeamReport(handle.db, { attemptId: attempt.id, outcome: "clear", report: "Fine." });
    return session;
  }

  it("survives archiving untouched", () => {
    const session = sessionWithReport();
    const before = getTeamSessionRecord(handle.db, session.id);
    setItemArchived(handle.db, item.id, Date.now());
    expect(getTeamSessionRecord(handle.db, session.id)).toEqual(before);
  });

  it("goes with an item deleted on purpose, leaving nothing dangling", () => {
    sessionWithReport();
    deleteItem(handle.db, item.id);
    expect(listTeamSessionsForItem(handle.db, item.id)).toEqual([]);
    expect(handle.db.all(sql`select id from team_attempts`)).toEqual([]);
    expect(handle.db.all(sql`PRAGMA foreign_key_check`)).toEqual([]);
  });

  it("still reads as it was after its agent is renamed and retired, and its step's team is edited", () => {
    const session = sessionWithReport();
    updateAgent(handle.db, reviewer, { name: "Renamed" });
    expect(deleteAgent(handle.db, reviewer)).toBe(true);

    const read = getTeamSessionRecord(handle.db, session.id)!;
    expect(read.attempts[0]).toMatchObject({ agentId: reviewer, agentName: "Rita", status: "completed", outcome: "clear" });
    // The team is the session's own copy, not the step's.
    expect(read.session.team).toEqual(TEAM);
  });
});
