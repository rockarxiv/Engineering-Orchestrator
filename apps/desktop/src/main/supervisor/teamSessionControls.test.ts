import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  StepTeamSchema,
  TEAM_PARTICIPANT_ACTION,
  TEAM_RETRY_REQUESTED,
  uuidv7,
  type Agent,
  type AgentEvent,
  type AgentProvider,
  type AgentProviderStartOptions,
  type IndependentTeam,
  type Item,
  type StepTeam,
  type TeamAttemptRow,
  type TeamSessionRow,
  type Uuid,
} from "@eo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../db/client.js";
import { saveActionDefinition } from "../db/repos/actionDefinitionsRepo.js";
import { createAgent, listAgents } from "../db/repos/agentsRepo.js";
import { listCommentsForItem, postComment } from "../db/repos/commentsRepo.js";
import { createRoute } from "../db/repos/index.js";
import { getItem, heldByCancelOf } from "../db/repos/itemsRepo.js";
import { createStep } from "../db/repos/pipelineStepsRepo.js";
import { createRun, getRun, listRunsForItem, updateRun } from "../db/repos/runsRepo.js";
import { listTeamSessionsForItem, mirrorTeamSession, openTeamSession } from "../db/repos/teamSessionsRepo.js";
import { listTransitionsForItem } from "../db/repos/transitionsRepo.js";
import { createTestItem, openMigratedTestDb, agentOfKind, setStepTeam } from "../db/testHelpers.js";
import { moveItem, postCommentCommand, resumeHeldItem, type EngineHandle } from "../ipc/domainCommands.js";
import { cancelTeamSessionCommand, retryTeamSessionCommand } from "../ipc/teamCommands.js";
import { createRunSupervisor, type RunSupervisor } from "./runSupervisor.js";
import { TEAM_RETRY_WORDS, type ReportOnlyProviderAnswer } from "./teamSupervisor.js";
import { itemTeamSessions } from "./teamSessionView.js";

/**
 * A person's controls on a team session (EO-849), end to end through the
 * supervisor: retrying what failed without redoing what was accepted,
 * cancelling the whole session, and a stop or a move that takes every
 * participant with it, never the visible one alone.
 */

const ROOMY = { globalConcurrency: 1, perAgentConcurrency: 1, perRepositoryConcurrency: 1 };

function team(overrides: Record<string, unknown> = {}): IndependentTeam {
  const parsed = StepTeamSchema.parse({
    coordination: "independent",
    participants: [
      { key: "security", role: "sec", instructions: "Look for ways in." },
      { key: "tests", role: "tester", instructions: "Check the tests." },
    ],
    outcomes: [
      { key: "clear", label: "Nothing found" },
      { key: "blocking", label: "Blocking issue", meaning: "Something must change first." },
    ],
    completion: { rules: [{ when: "any", outcomes: ["blocking"], result: "gaps_found" }], fallback: "aligned" },
    ...overrides,
  });
  if (parsed.coordination !== "independent") throw new Error("independent");
  return parsed;
}

/** The step's owner is never asked anything: the team answers for it. */
const ownerProvider: AgentProvider = {
  start: () => {
    throw new Error("The owner's own provider was started.");
  },
  resume: () => {
    throw new Error("The owner's own provider was resumed.");
  },
};

type Script = (call: { agent: Agent; attemptId: string; opts: AgentProviderStartOptions; nth: number }) => AsyncIterable<AgentEvent>;

interface Started {
  agent: string;
  attemptId: string;
  opts: AgentProviderStartOptions;
}

let handle: DbHandle;
let item: Item;
let scratch: string;
let quinn: Agent;
let started: Started[];
let script: Script;
const supervisors: RunSupervisor[] = [];

function reportOnlyProvider(agent: Agent, attemptId: string): ReportOnlyProviderAnswer {
  return {
    ok: true,
    cwd: join(scratch, attemptId),
    provider: {
      start: (opts) => {
        started.push({ agent: agent.name, attemptId, opts });
        return script({ agent, attemptId, opts, nth: started.length })[Symbol.asyncIterator]() as unknown as ReturnType<AgentProvider["start"]>;
      },
    },
  };
}

function supervisor(extra: Partial<Parameters<typeof createRunSupervisor>[0]> = {}): RunSupervisor {
  const made = createRunSupervisor({ db: handle.db, provider: ownerProvider, limits: ROOMY, reportOnlyProvider, teamPollMs: 5, ...extra });
  supervisors.push(made);
  return made;
}

function stepWithTeam(value: IndependentTeam): void {
  createStep(handle.db, { id: "check", pipelineId: "default" as never, position: -3, name: "Alignment", type: "agent", agentId: agentOfKind(handle.db, "qa"), entryAction: "alignment", team: value });
}

beforeEach(() => {
  handle = openMigratedTestDb();
  scratch = mkdtempSync(join(tmpdir(), "eo-team-controls-"));
  started = [];
  quinn = createAgent(handle.db, { name: "Quinn", role: "qa", provider: "claude", instructions: "You check work." });
  createAgent(handle.db, { name: "Sasha", role: "sec", provider: "claude", instructions: "You find ways in." });
  // On another backend: a team mixes them, and each turn is attributed to its own (EO-849).
  createAgent(handle.db, { name: "Tess", role: "tester", provider: "codex", model: "gpt-5", instructions: "You read tests." });
  stepWithTeam(team());
  createStep(handle.db, { id: "rework", pipelineId: "default" as never, position: -2, name: "Rework", type: "user", agentId: null, entryAction: null });
  createStep(handle.db, { id: "accepted", pipelineId: "default" as never, position: -1, name: "Accepted", type: "user", agentId: null, entryAction: null });
  createRoute(handle.db, { pipelineId: "default" as never, fromStepId: "check", resultKey: "aligned", label: "Aligned", target: "accepted", position: 0 });
  createRoute(handle.db, { pipelineId: "default" as never, fromStepId: "check", resultKey: "gaps_found", label: "Gaps found", target: "rework", position: 1 });
  const saved = saveActionDefinition(handle.db, {
    role: "qa",
    action: "alignment",
    description: "Check the work against what was asked for.",
    results: [
      { key: "aligned", label: "Aligned", meaning: "Everything asked for is there." },
      { key: "gaps_found", label: "Gaps found", meaning: "Something asked for is missing." },
    ],
  });
  if (!saved.ok) throw new Error("action");
  item = createTestItem(handle.db, { type: "story", title: "Check the export", stepId: "check" });
});

afterEach(async () => {
  for (const made of supervisors.splice(0)) await made.shutdown();
  handle.close();
  rmSync(scratch, { recursive: true, force: true });
});

// ── Scripted participants ────────────────────────────────────────────

async function* answer(outcome: string, report: string, cents = 0): AsyncGenerator<AgentEvent> {
  yield { type: "thread_started", threadId: `thread-${uuidv7()}` };
  if (cents > 0) yield { type: "usage", scope: "turn", tokensIn: 100, tokensOut: 50, costCents: cents };
  yield { type: "result", data: { outcome, report } };
}

/**
 * A turn that says it started, spends what it is told, and then works
 * until it is stopped — reporting, as a backend winding down does, what it
 * spent after the stop, and even an answer EO must not take.
 */
async function* until(signal: AbortSignal, cents = 0, afterStop = 0): AsyncGenerator<AgentEvent> {
  yield { type: "thread_started", threadId: `thread-${uuidv7()}` };
  if (cents > 0) yield { type: "usage", scope: "turn", tokensIn: 100, tokensOut: 50, costCents: cents };
  await new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
  if (afterStop === 0) throw Object.assign(new Error("stopped"), { name: "AbortError" });
  yield { type: "usage", scope: "turn", tokensIn: 10, tokensOut: 5, costCents: afterStop };
  yield { type: "result", data: { outcome: "clear", report: "Answered after it was stopped." } };
}

/** The participants' reports: agents' comments other than the summary the step's owner is credited with. */
const reportsOn = (id: string) => listCommentsForItem(handle.db, id as Uuid).filter((comment) => comment.authorType === "agent" && comment.authorId !== quinn.id);
const participantRuns = () => listRunsForItem(handle.db, item.id).filter((run) => run.action === TEAM_PARTICIPANT_ACTION);
const teamRun = () => listRunsForItem(handle.db, item.id).filter((run) => run.action === "alignment");


/** A turn that starts and ends with no answer at all: a failed contribution. */
async function* silent(): AsyncGenerator<AgentEvent> {
  yield { type: "thread_started", threadId: `t-${uuidv7()}` };
}

const asks = (question: string) => ({ outcome: { status: "clarification_required", questions: [{ id: "q1", question, why: "It decides what to read." }] } });

const engineOf = (made: RunSupervisor) => made as unknown as EngineHandle;
const session = () => listTeamSessionsForItem(handle.db, item.id).at(-1)!;
const shown = () => itemTeamSessions(handle.db, item.id, supervisors.at(-1)?.teamControlSite() ?? null)[0]!;

describe("a person's controls on a team session (EO-849)", () => {
  it("retries what failed without restarting the accepted sibling, and a settled session never runs again", async () => {
    let tessWorks = false;
    script = ({ agent }) => (agent.name === "Sasha" ? answer("clear", "Nothing to see.", 5) : tessWorks ? answer("clear", "Tests pass.", 7) : silent());
    const engine = supervisor();
    await engine.runOnce();

    // Parked on a failed contribution, and said so.
    expect(teamRun()[0]?.status).toBe("awaiting_input");
    let view = shown();
    expect(view.state).toBe("waiting");
    expect(view.waiting.map((wait) => wait.kind)).toEqual(["limits"]);
    expect(view.retry).toEqual({ allowed: true, reason: null, keys: ["tests"] });
    expect(view.assignments.map((one) => [one.key, one.attempts.at(-1)?.state])).toEqual([
      ["security", "completed"],
      ["tests", "failed"],
    ]);
    // Mixed backends, each attempt attributed to its own.
    expect(view.assignments.map((one) => one.attempts[0]?.provider)).toEqual(["claude", "codex"]);

    tessWorks = true;
    const answered = retryTeamSessionCommand(handle.db, engineOf(engine), { sessionId: view.id });
    expect(answered).toEqual({ retried: true, keys: ["tests"], problem: null });
    await vi.waitFor(() => expect(getItem(handle.db, item.id)?.stepId).toBe("accepted"));

    // Sasha's accepted report was kept, not done again; Tess was tried once more.
    expect(started.filter((one) => one.agent === "Sasha")).toHaveLength(1);
    expect(reportsOn(item.id).filter((comment) => comment.body.startsWith("**security**"))).toHaveLength(1);
    const tests = session().attempts.filter((attempt) => attempt.assignmentKey === "tests");
    expect(tests.map((attempt) => attempt.status)).toEqual(["failed", "failed", "cancelled", "completed"]);
    expect(tests[2]?.error).toBe(TEAM_RETRY_REQUESTED);
    expect(listTeamSessionsForItem(handle.db, item.id)).toHaveLength(1);

    view = shown();
    expect(view.state).toBe("finalized");
    expect(view.final).toMatchObject({ by: "rule", ruleIndex: null, rule: "Otherwise → aligned" });
    expect(view.final?.contributions).toHaveLength(2);
    // Every participant run counted once: 5¢ and 7¢; the team's runs spent nothing.
    expect(view.totals.costCents).toBe(12);
    expect(view.totals.teamRunCents).toBe(0);

    // A settled session is history: no retry, no second route.
    const again = retryTeamSessionCommand(handle.db, engineOf(engine), { sessionId: view.id });
    expect(again.retried).toBe(false);
    expect(again.problem).toContain("never runs again");
    expect(cancelTeamSessionCommand(handle.db, engineOf(engine), { sessionId: view.id }).cancelled).toBe(false);
    await engine.runOnce();
    expect(listTransitionsForItem(handle.db, item.id)).toHaveLength(1);
  });

  it("cancels the whole session: every participant stopped, nothing late taken, the item left where it is", async () => {
    // Each answers after the stop, as a backend winding down may: EO must not take it.
    script = ({ opts }) => until(opts.signal, 4, 1);
    const engine = supervisor();
    const done = engine.runOnce();
    await vi.waitFor(() => expect(participantRuns().filter((run) => run.status === "running")).toHaveLength(2));
    expect(shown().state).toBe("running");

    expect(cancelTeamSessionCommand(handle.db, engineOf(engine), { sessionId: shown().id })).toEqual({ cancelled: true, problem: null });
    await done;

    expect(session().session.status).toBe("cancelled");
    expect(participantRuns().map((run) => run.status)).toEqual(["cancelled", "cancelled"]);
    expect(teamRun()[0]?.status).toBe("cancelled");
    expect(reportsOn(item.id)).toEqual([]);
    expect(getItem(handle.db, item.id)?.stepId).toBe("check");
    const view = shown();
    expect(view.state).toBe("cancelled");
    expect(view.assignments.flatMap((one) => one.attempts.map((attempt) => attempt.state)).every((state) => state === "cancelled" || state === "stopped")).toBe(true);
    // What it spent while it ran is still the item's, once.
    expect(view.totals.costCents).toBe(10);
    expect(listCommentsForItem(handle.db, item.id).some((comment) => comment.authorType === "human" && comment.body.startsWith("Cancelled the team session"))).toBe(true);
    // And the step is not offered again behind the person's back: the
    // item is held, by this cancel, and the thread says what resuming does.
    expect(getItem(handle.db, item.id)?.heldAt).not.toBeNull();
    expect(heldByCancelOf(handle.db, item.id)).toBe(teamRun()[0]!.id);
    const held = listCommentsForItem(handle.db, item.id).filter((comment) => comment.authorType === "engine" && comment.body.startsWith("Run cancelled"));
    expect(held.map((comment) => comment.body)).toEqual(['Run cancelled, so this ticket is on hold at "Alignment". Resume it to start the team again from the beginning.']);
    await engine.runOnce();
    expect(teamRun()).toHaveLength(1);
  });

  it("starts the team again from the beginning when the item a cancel held is resumed", async () => {
    let stopping = true;
    script = ({ agent, opts }) => (stopping ? until(opts.signal) : answer("clear", `${agent.name} found nothing.`));
    const engine = supervisor();
    const done = engine.runOnce();
    await vi.waitFor(() => expect(participantRuns().filter((run) => run.status === "running")).toHaveLength(2));
    expect(cancelTeamSessionCommand(handle.db, engineOf(engine), { sessionId: shown().id }).cancelled).toBe(true);
    await done;
    const first = session().session.id;

    stopping = false;
    resumeHeldItem(handle.db, engineOf(engine), { itemId: item.id, cancelActiveRun: false });
    await engine.runOnce();
    await vi.waitFor(() => expect(getItem(handle.db, item.id)?.stepId).toBe("accepted"));

    // A new session, every participant run afresh: nothing of the cancelled one adopted.
    const sessions = listTeamSessionsForItem(handle.db, item.id);
    expect(sessions.map((one) => one.session.status)).toEqual(["cancelled", "finalized"]);
    expect(sessions[1]!.session.id).not.toBe(first);
    expect(sessions[1]!.attempts.map((attempt) => [attempt.assignmentKey, attempt.status]).sort()).toEqual([
      ["security", "completed"],
      ["tests", "completed"],
    ]);
  });

  it("holds the item when a session parked on a failed contribution is cancelled, and says so in the parked words", async () => {
    script = ({ agent }) => (agent.name === "Sasha" ? answer("clear", "Nothing to see.") : silent());
    const engine = supervisor();
    await engine.runOnce();
    expect(teamRun()[0]?.status).toBe("awaiting_input");
    // What the parked team says about cancelling: it holds, and resuming starts over.
    expect(teamRun()[0]?.error ?? "").not.toContain("afresh");
    expect(TEAM_RETRY_WORDS).toContain("Cancelling the session holds the ticket, and resuming it then starts the team again from the beginning.");
    expect(TEAM_RETRY_WORDS).not.toContain("afresh");

    expect(cancelTeamSessionCommand(handle.db, engineOf(engine), { sessionId: shown().id }).cancelled).toBe(true);

    expect(teamRun()[0]?.status).toBe("cancelled");
    expect(getItem(handle.db, item.id)).toMatchObject({ stepId: "check", heldAt: expect.any(Number) });
    expect(heldByCancelOf(handle.db, item.id)).toBe(teamRun()[0]!.id);
    await engine.runOnce();
    expect(teamRun()).toHaveLength(1);
  });

  it("stops the team, not one participant, when a participant's run is cancelled", async () => {
    script = ({ opts }) => until(opts.signal);
    const engine = supervisor();
    const done = engine.runOnce();
    await vi.waitFor(() => expect(participantRuns().filter((run) => run.status === "running")).toHaveLength(2));
    engine.cancelRun(participantRuns()[0]!.id);
    await done;
    expect(teamRun()[0]?.status).toBe("cancelled");
    expect(participantRuns().map((run) => run.status)).toEqual(["cancelled", "cancelled"]);
    expect(session().session.status).toBe("cancelled");
  });

  it("fences the whole session when the item is moved while the team works", async () => {
    script = ({ opts }) => until(opts.signal, 0, 1);
    const engine = supervisor();
    const done = engine.runOnce();
    await vi.waitFor(() => expect(participantRuns().filter((run) => run.status === "running")).toHaveLength(2));
    const moved = moveItem(handle.db, engineOf(engine), { itemId: item.id, toStepId: "rework", cancelActiveRun: true, comment: "" });
    await done;
    // The run holding the item was the one stopped — the team's — and every participant with it.
    expect(moved).toMatchObject({ moved: true, cancelledRunId: teamRun()[0]!.id });
    expect(participantRuns().map((run) => run.status)).toEqual(["cancelled", "cancelled"]);
    expect(session().session.status).toBe("cancelled");
    expect(reportsOn(item.id)).toEqual([]);
    expect(shown().state).toBe("cancelled");
  });

  it("refuses a move while the team works unless it is asked to stop it, whichever participant is visible", async () => {
    script = ({ opts }) => until(opts.signal);
    const engine = supervisor();
    const done = engine.runOnce();
    await vi.waitFor(() => expect(participantRuns().filter((run) => run.status === "running")).toHaveLength(2));
    expect(moveItem(handle.db, engineOf(engine), { itemId: item.id, toStepId: "rework", cancelActiveRun: false, comment: "" })).toMatchObject({ moved: false, blockedByActiveRun: true });
    engine.cancelRun(teamRun()[0]!.id);
    await done;
  });

  it("sends a reply to the assignment that asked, and keeps the sibling's report", async () => {
    let asked = false;
    script = ({ agent }) => {
      if (agent.name === "Sasha") return answer("clear", "Nothing to see.");
      if (!asked) {
        asked = true;
        return (async function* () {
          yield { type: "thread_started", threadId: `t-${uuidv7()}` } as AgentEvent;
          yield { type: "result", data: asks("Which test suite counts?") } as AgentEvent;
        })();
      }
      return answer("blocking", "The unit suite fails.");
    };
    const engine = supervisor();
    await engine.runOnce();
    let view = shown();
    expect(view.waiting[0]).toMatchObject({ kind: "human", keys: ["tests"] });
    const question = view.assignments[1]!.attempts[0]!.questions[0]!;
    expect(question.body).toContain("Which test suite counts?");
    expect(view.retry.allowed).toBe(false);

    await postCommentCommand(handle.db, engineOf(engine), { itemId: item.id, body: "The unit suite.", parentId: question.commentId, pinned: false, mentions: [] });
    await vi.waitFor(() => expect(getItem(handle.db, item.id)?.stepId).toBe("rework"));
    // The asking assignment ran again with the answer; the sibling did not.
    expect(started.filter((one) => one.agent === "Sasha")).toHaveLength(1);
    expect(started.filter((one) => one.agent === "Tess").at(-1)?.opts.context).toContain("The unit suite.");
    view = shown();
    expect(view.final).toMatchObject({ by: "rule", ruleIndex: 0 });
  });

  it("ends a session parked on a question when the item is moved away, so it can never route the item again", async () => {
    script = ({ agent }) =>
      agent.name === "Sasha"
        ? answer("clear", "Fine.")
        : (async function* () {
            yield { type: "thread_started", threadId: `t-${uuidv7()}` } as AgentEvent;
            yield { type: "result", data: asks("Which suite?") } as AgentEvent;
          })();
    const engine = supervisor();
    await engine.runOnce();
    expect(session().session.status).toBe("open");
    expect(moveItem(handle.db, engineOf(engine), { itemId: item.id, toStepId: "rework", cancelActiveRun: false, comment: "" }).moved).toBe(true);
    expect(session().session.status).toBe("cancelled");
    const view = shown();
    expect(view.retry.allowed).toBe(false);
    expect(view.cancel.allowed).toBe(false);
  });

  it("refuses to cancel or retry a session another desktop runs, and keeps drawing what that desktop reports", async () => {
    const engine = supervisor();
    // The executing desktop's session, as the organisation's record mirrors it here.
    const sashaId = listAgents(handle.db).find((agent) => agent.name === "Sasha")!.id as Uuid;
    const parent = createRun(handle.db, { itemId: item.id, agentId: quinn.id, action: "alignment", stepId: "check", status: "running" });
    updateRun(handle.db, parent.id, { startedAt: 1 });
    const run = createRun(handle.db, { itemId: item.id, agentId: sashaId, action: TEAM_PARTICIPANT_ACTION, stepId: "check", status: "running", provider: "claude" });
    updateRun(handle.db, run.id, { startedAt: 2, costCents: 3 });
    const at = Date.now();
    const remote: TeamSessionRow = {
      id: uuidv7(), itemId: item.id, stepId: "check", entryTransitionId: null, pipelineVersionId: null, runId: parent.id, team: team(),
      status: "open", result: null, finalCommentId: null, supersededBy: null, deviceId: "laptop-2", createdAt: at, updatedAt: at, endedAt: null,
    };
    const working: TeamAttemptRow = {
      id: uuidv7(), sessionId: remote.id, itemId: item.id, assignmentKey: "security", role: "sec", agentId: sashaId, agentName: "Sasha", instructions: "Look for ways in.",
      round: 1, attempt: 1, runId: run.id, status: "running", outcome: null, error: null, evidenceBaseline: null, reportCommentId: null, acceptedAt: null,
      supersededBy: null, createdAt: at, updatedAt: at, endedAt: null,
    };
    expect(mirrorTeamSession(handle.db, { session: remote, attempts: [working] })).toEqual({ placed: true });

    let view = shown();
    expect(view.state).toBe("running");
    expect(view.cancel).toEqual({ allowed: false, reason: "This team session is running on another desktop, and only that desktop can stop or retry its participants." });
    expect(view.retry.allowed).toBe(false);
    expect(view.retry.reason).toContain("another desktop");

    // Pressed anyway, from a screen drawn before: refused, and nothing here changed.
    const answer = cancelTeamSessionCommand(handle.db, engineOf(engine), { sessionId: remote.id });
    expect(answer.cancelled).toBe(false);
    expect(answer.problem).toContain("another desktop");
    expect(engine.cancelTeamSession(remote.id)).toEqual({ ok: false, problem: "This team session is running on another desktop, and only that desktop can stop or retry its participants." });
    expect(session().session.status).toBe("open");
    expect(getRun(handle.db, run.id)?.status).toBe("running");
    expect(listCommentsForItem(handle.db, item.id).some((comment) => comment.body.startsWith("Cancelled the team session"))).toBe(false);
    expect(retryTeamSessionCommand(handle.db, engineOf(engine), { sessionId: remote.id }).retried).toBe(false);

    // Its report arrives later from the record: drawn as reported, never as cancelled.
    const report = postComment(handle.db, { itemId: item.id, runId: run.id, author: { type: "agent", agentId: sashaId }, body: "**security** — Nothing found\n\nFine." });
    updateRun(handle.db, run.id, { status: "succeeded", endedAt: 5 });
    mirrorTeamSession(handle.db, { session: { ...remote, updatedAt: at + 1 }, attempts: [{ ...working, status: "completed", outcome: "clear", reportCommentId: report.id, acceptedAt: at + 1, updatedAt: at + 1, endedAt: at + 1 }] });
    view = shown();
    expect(view.assignments[0]?.attempts[0]).toMatchObject({ state: "completed", reportCommentId: report.id });
    expect(view.state).toBe("running");
    expect(view.cancel.allowed).toBe(false);

    // And its end.
    updateRun(handle.db, parent.id, { status: "succeeded", endedAt: 6 });
    mirrorTeamSession(handle.db, { session: { ...remote, status: "finalized", result: "aligned", updatedAt: at + 2, endedAt: at + 2 }, attempts: [{ ...working, status: "completed", outcome: "clear", reportCommentId: report.id, acceptedAt: at + 1, updatedAt: at + 1, endedAt: at + 1 }] });
    view = shown();
    expect(view.state).toBe("finalized");
    expect(view.cancel.reason).toContain("already ended (finalized)");
  });

  it("refuses to cancel a team whose runs are working in no process of this desktop, rather than claim to have stopped them", () => {
    const engine = supervisor();
    const parent = createRun(handle.db, { itemId: item.id, agentId: quinn.id, action: "alignment", stepId: "check", status: "running" });
    const opened = openTeamSession(handle.db, { itemId: item.id, stepId: "check", team: team(), runId: parent.id });
    expect(shown().cancel.reason).toContain("not in EO on this desktop");
    expect(cancelTeamSessionCommand(handle.db, engineOf(engine), { sessionId: opened.id }).cancelled).toBe(false);
    expect(session().session.status).toBe("open");
  });
});

// ── A leader-led team (EO-847), under the same controls ─────────────

describe("a person's controls on a leader-led team (EO-849)", () => {
  /** The leader's turns, in order; one is taken per turn. */
  let leaderTurns: (() => AsyncIterable<AgentEvent>)[];
  let sashaTurns: number;

  const leaderTeam = (): StepTeam =>
    StepTeamSchema.parse({ coordination: "leader", leader: { role: "lead", instructions: "Find out whether the export does what was asked." }, roles: ["sec"], limits: { maxRetries: 1 } });
  const says = (data: unknown) => () =>
    (async function* () {
      yield { type: "thread_started", threadId: `t-${uuidv7()}` } as AgentEvent;
      yield { type: "result", data } as AgentEvent;
    })();
  /** The current accepted report at an assignment, by comment id, as the leader would cite it. */
  const reportOf = (key: string) => session().attempts.find((attempt) => attempt.assignmentKey === key && attempt.status === "completed" && attempt.supersededBy === null)?.reportCommentId ?? "missing";
  const final = (result: string, contributions: () => string[]) => () =>
    (async function* () {
      yield { type: "thread_started", threadId: `t-${uuidv7()}` } as AgentEvent;
      yield { type: "result", data: { outcome: { decision: "final", answer: { result, summary: `The team says ${result}.` }, contributions: contributions(), disagreements: "None.", limitations: "Only read." } } } as AgentEvent;
    })();

  beforeEach(() => {
    createAgent(handle.db, { name: "Lee", role: "lead", provider: "codex", model: "gpt-5", instructions: "You lead." });
    setStepTeam(handle.db, "check", leaderTeam());
    leaderTurns = [];
    sashaTurns = 0;
    script = ({ agent }) => {
      if (agent.name === "Sasha") {
        sashaTurns += 1;
        return answerReport("The login is fine.");
      }
      const turn = leaderTurns.shift();
      if (turn === undefined) throw new Error("Nothing scripted for the leader.");
      return turn();
    };
  });

  /** A contributor's report on a leader's team, which declares no outcomes. */
  async function* answerReport(text: string): AsyncGenerator<AgentEvent> {
    yield { type: "thread_started", threadId: `t-${uuidv7()}` };
    yield { type: "result", data: { outcome: { report: text } } };
  }

  it("parks a leader whose turns failed and were refused past its retries, retries the leader alone, accepts the corrected answer once, and never again", async () => {
    leaderTurns = [
      says({ outcome: { decision: "assign", assignments: [{ key: "auth", member: "Sasha", scope: "the whole change", instructions: "Check the login.", required: true }], note: "One thing to check." } }),
      // A turn that crashes, then an answer EO refuses: two corrections past the one retry.
      () =>
        (async function* () {
          yield { type: "thread_started", threadId: `t-${uuidv7()}` } as AgentEvent;
        })(),
      final("shipped", () => [reportOf("auth")]),
    ];
    const engine = supervisor();
    await engine.runOnce();

    expect(teamRun()[0]?.status).toBe("awaiting_input");
    expect(session().session.status).toBe("open");
    let view = shown();
    expect(view.coordination).toBe("leader");
    expect(view.state).toBe("waiting");
    expect(view.waiting.map((wait) => wait.kind)).toEqual(["limits"]);
    expect(view.retry).toEqual({ allowed: true, reason: null, keys: ["leader"] });
    expect(view.assignments.find((one) => one.key === "auth")?.attempts.at(-1)?.state).toBe("completed");
    // Each leader turn replaces the one before; what each ended as is kept.
    expect(view.assignments.find((one) => one.key === "leader")?.attempts.map((attempt) => [attempt.state, attempt.status])).toEqual([
      ["superseded", "completed"],
      ["superseded", "failed"],
      ["completed", "completed"],
    ]);
    // Leader and contributor on different backends, each attributed to its own.
    expect(view.assignments.find((one) => one.key === "leader")?.attempts[0]?.provider).toBe("codex");
    expect(view.assignments.find((one) => one.key === "auth")?.attempts[0]?.provider).toBe("claude");

    leaderTurns.push(final("aligned", () => [reportOf("auth")]));
    expect(retryTeamSessionCommand(handle.db, engineOf(engine), { sessionId: view.id })).toEqual({ retried: true, keys: ["leader"], problem: null });
    await vi.waitFor(() => expect(getItem(handle.db, item.id)?.stepId).toBe("accepted"));

    // The accepted report was kept: the contributor ran once.
    expect(sashaTurns).toBe(1);
    const leader = session().attempts.filter((attempt) => attempt.assignmentKey === "leader");
    expect(leader.map((attempt) => attempt.status)).toEqual(["completed", "failed", "completed", "cancelled", "completed"]);
    expect(leader[3]?.error).toBe(TEAM_RETRY_REQUESTED);
    view = shown();
    expect(view.state).toBe("finalized");
    expect(view.final).toMatchObject({ by: "leader", attemptId: leader[4]!.id, limitations: "Only read." });
    expect(view.final?.contributions).toEqual([session().attempts.find((attempt) => attempt.assignmentKey === "auth")!.id]);
    expect(listTransitionsForItem(handle.db, item.id)).toHaveLength(1);

    // Settled: no retry, no second route.
    const again = retryTeamSessionCommand(handle.db, engineOf(engine), { sessionId: view.id });
    expect(again.retried).toBe(false);
    expect(again.problem).toContain("never runs again");
    await engine.runOnce();
    expect(listTransitionsForItem(handle.db, item.id)).toHaveLength(1);
    expect(leaderTurns).toEqual([]);
  });
});

