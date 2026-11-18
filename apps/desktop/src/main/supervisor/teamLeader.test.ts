import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  evidenceBaselineOf,
  LEADER_ASSIGNMENT_KEY,
  StepTeamSchema,
  TEAM_EVIDENCE_TOOLS,
  TEAM_PARTICIPANT_ACTION,
  uuidv7,
  type Agent,
  type AgentEvent,
  type AgentProvider,
  type AgentProviderStartOptions,
  type Item,
  type StepTeam,
  type TeamAttemptRow,
  type Uuid,
} from "@eo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../db/client.js";
import { saveActionDefinition } from "../db/repos/actionDefinitionsRepo.js";
import { createAgent, getAgent } from "../db/repos/agentsRepo.js";
import { insertAttachments } from "../db/repos/attachmentsRepo.js";
import { listCommentsForItem, postComment } from "../db/repos/commentsRepo.js";
import { createRoute } from "../db/repos/index.js";
import { getItem } from "../db/repos/itemsRepo.js";
import { createStep } from "../db/repos/pipelineStepsRepo.js";
import { createRun, getRun, listRunsForItem, updateRun } from "../db/repos/runsRepo.js";
import { acceptTeamReport, endTeamSession, listTeamSessionsForItem, openTeamSession, startTeamAttempt, teamSessionTotals } from "../db/repos/teamSessionsRepo.js";
import { listTransitionsForItem } from "../db/repos/transitionsRepo.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { createRunSupervisor, type RunSupervisor } from "./runSupervisor.js";
import { taskContextOf } from "./teamEvidence.js";
import type { ReportOnlyProviderAnswer } from "./teamSupervisor.js";

/**
 * A leader-led team, and a member of either kind of team asking the person
 * (EO-847), end to end through the supervisor: every turn on a report-only
 * provider scripted here, the step owner's own provider never started, and
 * the one answer routed by the ordinary path.
 */

const ROOMY = { globalConcurrency: 1, perAgentConcurrency: 2, perRepositoryConcurrency: 1 };

function leaderTeam(overrides: Record<string, unknown> = {}): StepTeam {
  return StepTeamSchema.parse({
    coordination: "leader",
    leader: { role: "lead", instructions: "Find out whether the export does what was asked." },
    roles: ["sec", "tester"],
    ...overrides,
  });
}

function independentTeam(): StepTeam {
  return StepTeamSchema.parse({
    coordination: "independent",
    participants: [
      { key: "security", role: "sec", instructions: "Look for ways in." },
      { key: "tests", role: "tester", instructions: "Check the tests." },
    ],
    outcomes: [
      { key: "clear", label: "Nothing found" },
      { key: "blocking", label: "Blocking issue" },
    ],
    completion: { rules: [{ when: "any", outcomes: ["blocking"], result: "gaps_found" }], fallback: "aligned" },
  });
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

interface Started {
  agent: string;
  provider: string;
  attemptId: string;
  opts: AgentProviderStartOptions;
}

type Turn = (call: { agent: Agent; attemptId: string; opts: AgentProviderStartOptions }) => AsyncIterable<AgentEvent>;

let handle: DbHandle;
let item: Item;
let scratch: string;
let quinn: Agent;
let lee: Agent;
let started: Started[];
/** The leader's turns, in order; one is taken per turn. */
let leaderTurns: Turn[];
/** What each participant role answers, by agent name. */
let participants: Record<string, Turn>;
const supervisors: RunSupervisor[] = [];

function reportOnlyProvider(agent: Agent, attemptId: string): ReportOnlyProviderAnswer {
  return {
    ok: true,
    cwd: join(scratch, attemptId),
    provider: {
      start: (opts) => {
        started.push({ agent: agent.name, provider: agent.provider, attemptId, opts });
        const turn = agent.name === lee.name ? leaderTurns.shift() : participants[agent.name];
        if (turn === undefined) throw new Error(`Nothing scripted for ${agent.name}'s turn.`);
        return turn({ agent, attemptId, opts })[Symbol.asyncIterator]() as unknown as ReturnType<AgentProvider["start"]>;
      },
    },
  };
}

function supervisor(extra: Partial<Parameters<typeof createRunSupervisor>[0]> = {}): RunSupervisor {
  const made = createRunSupervisor({ db: handle.db, provider: ownerProvider, limits: ROOMY, reportOnlyProvider, teamPollMs: 5, ...extra });
  supervisors.push(made);
  return made;
}

function setTeam(value: StepTeam): void {
  (handle.db as unknown as { $client: { prepare(source: string): { run(...args: unknown[]): unknown } } }).$client
    .prepare("update pipeline_steps set team = ? where id = 'check'")
    .run(JSON.stringify(value));
}

function setup(leaderProvider: "claude" | "codex" = "claude", participantProviders: { sec: "claude" | "codex"; tester: "claude" | "codex" } = { sec: "claude", tester: "claude" }): void {
  handle = openMigratedTestDb();
  scratch = mkdtempSync(join(tmpdir(), "eo-team-leader-"));
  started = [];
  leaderTurns = [];
  participants = {};
  quinn = createAgent(handle.db, { name: "Quinn", role: "qa", provider: "claude", instructions: "You check work." });
  lee = createAgent(handle.db, { name: "Lee", role: "lead", provider: leaderProvider, instructions: "You lead reviews." });
  createAgent(handle.db, { name: "Sasha", role: "sec", provider: participantProviders.sec, instructions: "You find ways in." });
  createAgent(handle.db, { name: "Tess", role: "tester", provider: participantProviders.tester, instructions: "You read tests." });
  createStep(handle.db, { id: "check", pipelineId: "default" as never, position: -3, name: "Alignment", type: "agent", ownerRole: "qa", entryAction: "alignment", team: leaderTeam() });
  createStep(handle.db, { id: "rework", pipelineId: "default" as never, position: -2, name: "Rework", type: "user", ownerRole: null, entryAction: null });
  createStep(handle.db, { id: "accepted", pipelineId: "default" as never, position: -1, name: "Accepted", type: "user", ownerRole: null, entryAction: null });
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
}

afterEach(async () => {
  for (const made of supervisors.splice(0)) await made.shutdown();
  handle.close();
  rmSync(scratch, { recursive: true, force: true });
});

// ── Scripted turns ───────────────────────────────────────────────────

function gate(): { wait: Promise<void>; open: () => void } {
  let open = (): void => undefined;
  const wait = new Promise<void>((resolve) => (open = resolve));
  return { wait, open };
}

function says(data: unknown, cents = 0): Turn {
  return () =>
    (async function* () {
      yield { type: "thread_started", threadId: `thread-${uuidv7()}` } as AgentEvent;
      if (cents > 0) yield { type: "usage", scope: "turn", tokensIn: 100, tokensOut: 50, costCents: cents } as AgentEvent;
      yield { type: "result", data } as AgentEvent;
    })();
}

/** A turn whose answer is worked out when it runs: from the session as it then stands. */
function sayingThen(make: (call: { opts: AgentProviderStartOptions; attemptId: string }) => unknown, cents = 0): Turn {
  return (call) =>
    (async function* () {
      yield { type: "thread_started", threadId: `thread-${uuidv7()}` } as AgentEvent;
      if (cents > 0) yield { type: "usage", scope: "turn", tokensIn: 100, tokensOut: 50, costCents: cents } as AgentEvent;
      yield { type: "result", data: make(call) } as AgentEvent;
    })();
}

const assign = (assignments: { key: string; role: string; instructions: string; required?: boolean }[], note = "Split it up.") => ({
  outcome: { decision: "assign", assignments: assignments.map((one) => ({ required: true, ...one })), note },
});
const final = (answer: unknown, contributions: string[]) => ({
  outcome: { decision: "final", answer, contributions, disagreements: "None: they agree.", limitations: "Nothing was run, only read." },
});
const report = (text: string) => ({ outcome: { report: text } });
const asks = (question: string) => ({ outcome: { status: "clarification_required", questions: [{ id: "q1", question, why: "It decides what to look at." }] } });

const attempts = (): TeamAttemptRow[] => listTeamSessionsForItem(handle.db, item.id).at(-1)?.attempts ?? [];
/** The current accepted report at an assignment, by comment id. */
const reportId = (key: string): string => {
  const found = attempts().find((attempt) => attempt.assignmentKey === key && attempt.status === "completed" && attempt.supersededBy === null)?.reportCommentId;
  if (found === undefined || found === null) throw new Error(`No current report at ${key}.`);
  return found;
};
/** The baseline the supervisor captures for this item, with no disk and no attachments, as its task now reads. */
const nothingCaptured = () => evidenceBaselineOf({ version: 1, capturedAt: 1, workspaceKind: "none", source: { kind: "none" }, attachments: [], task: taskContextOf(getItem(handle.db, item.id)!) });
const teamRuns = () => listRunsForItem(handle.db, item.id).filter((run) => run.action === "alignment");
const participantRuns = () => listRunsForItem(handle.db, item.id).filter((run) => run.action === TEAM_PARTICIPANT_ACTION);
const notes = () => listCommentsForItem(handle.db, item.id).map((comment) => comment.body);
const turnsOf = (name: string) => started.filter((one) => one.agent === name);

const agentNamed = (name: string): Uuid =>
  ((handle.db as unknown as { $client: { prepare(source: string): { get(...args: unknown[]): unknown } } }).$client.prepare("select id from agents where name = ?").get(name) as { id: Uuid }).id;

/** A file put on the item: evidence every member reads. */
function attach(name: string, content: string): void {
  const path = join(scratch, `${uuidv7()}-${name}`);
  writeFileSync(path, content);
  insertAttachments(handle.db, [{ id: uuidv7() as Uuid, itemId: item.id, commentId: null, storagePath: path, name, mimeType: "text/plain", size: content.length }]);
}

/** A person edits what the item asks for. */
function editBody(body: string): void {
  (handle.db as unknown as { $client: { prepare(source: string): { run(...args: unknown[]): unknown } } }).$client.prepare("update items set body = ? where id = ?").run(body, item.id);
}

/** The person answers the question an agent asked, under it, as the item view files a reply. */
function reply(questionAuthor: string, body: string): void {
  const question = listCommentsForItem(handle.db, item.id).find((comment) => comment.kind === "question" && comment.authorId === agentNamed(questionAuthor));
  if (question === undefined) throw new Error(`No question from ${questionAuthor}.`);
  postComment(handle.db, { itemId: item.id, author: { type: "human" }, parentId: question.id, body });
}

// ── Leader-led ───────────────────────────────────────────────────────

describe("a leader-led team (EO-847)", () => {
  beforeEach(() => setup());

  it("assigns focused work, has no process while its participants run, and gets their reports in its next turn with its session and spending kept", async () => {
    const release = gate();
    leaderTurns = [
      says(assign([
        { key: "auth", role: "sec", instructions: "Look only at how the export authenticates." },
        { key: "suite", role: "tester", instructions: "Check the export's tests cover the CSV path.", required: false },
      ]), 3),
      sayingThen(({ opts }) => {
        // The reports are in this turn's context, each by its comment id.
        expect(opts.context).toContain("Sasha checked the tokens.");
        expect(opts.context).toContain("Tess read the CSV tests.");
        expect(opts.context).toContain(`comment ${reportId("auth")}`);
        return final({ result: "aligned", summary: "The export does what was asked." }, [reportId("auth"), reportId("suite")]);
      }, 4),
    ];
    const held = (text: string): Turn => () =>
      (async function* () {
        yield { type: "thread_started", threadId: `thread-${uuidv7()}` } as AgentEvent;
        yield { type: "usage", scope: "turn", tokensIn: 10, tokensOut: 5, costCents: 2 } as AgentEvent;
        await release.wait;
        yield { type: "result", data: report(text) } as AgentEvent;
      })();
    participants = { Sasha: held("Sasha checked the tokens."), Tess: held("Tess read the CSV tests.") };
    const engine = supervisor();
    const done = engine.runOnce();

    await vi.waitFor(() => expect(turnsOf("Sasha")).toHaveLength(1));
    await vi.waitFor(() => expect(turnsOf("Tess")).toHaveLength(1));
    // The leader's first turn is over: its run ended, and only the two participants are provider turns.
    const leaderRun = getRun(handle.db, attempts().find((attempt) => attempt.assignmentKey === LEADER_ASSIGNMENT_KEY)!.runId as Uuid);
    expect(leaderRun?.status).toBe("succeeded");
    expect(engine.activeRunCount()).toBe(2);
    expect(turnsOf("Lee")).toHaveLength(1);
    // Assignment text is the leader's, adapted to the work, not the team's configuration.
    expect(turnsOf("Sasha")[0]?.opts.context).toContain("Look only at how the export authenticates.");
    expect(turnsOf("Sasha")[0]?.opts.instructions).toContain("A leader assigned you this piece of the work");

    release.open();
    await done;

    expect(getItem(handle.db, item.id)?.stepId).toBe("accepted");
    expect(turnsOf("Lee")).toHaveLength(2);
    const record = listTeamSessionsForItem(handle.db, item.id)[0]!;
    expect(record.session.status).toBe("finalized");
    expect(record.session.result).toBe("aligned");
    // Both leader turns and both participants are in the one session, each spend on its own run, counted once.
    const leaderAttempts = record.attempts.filter((attempt) => attempt.assignmentKey === LEADER_ASSIGNMENT_KEY);
    expect(leaderAttempts.map((attempt) => getRun(handle.db, attempt.runId as Uuid)?.costCents)).toEqual([3, 4]);
    expect(leaderAttempts.map((attempt) => getRun(handle.db, attempt.runId as Uuid)?.agentId)).toEqual([lee.id, lee.id]);
    expect(teamSessionTotals(handle.db, record.session.id).costCents).toBe(3 + 4 + 2 + 2);
    expect(teamRuns()[0]?.costCents ?? 0).toBe(0);
    // Assignments and the final account are on the thread, attributed to the leader.
    const leaderComments = listCommentsForItem(handle.db, item.id).filter((comment) => comment.authorId === lee.id);
    expect(leaderComments[0]?.body).toContain("Assigns round 1:");
    expect(leaderComments[0]?.body).toContain("**suite** (tester, optional)");
    expect(leaderComments[1]?.body).toContain("**Disagreements:** None: they agree.");
    expect(record.session.finalCommentId).toBe(leaderComments[1]?.id);
    // The answer routed is the leader's, posted as the owner's summary by the ordinary path.
    expect(listCommentsForItem(handle.db, item.id).find((comment) => comment.authorId === quinn.id)?.body).toBe("The export does what was asked.");
    expect(listTransitionsForItem(handle.db, item.id)).toHaveLength(1);
  });

  it("holds the leader to report-only: its turn has the four evidence tools alone, under its own attempt", async () => {
    leaderTurns = [says(final({ result: "aligned", summary: "Nothing to assign." }, []))];
    const engine = supervisor({
      agentWriteBridge: () => ({ tokenFor: (itemId, writes, scope) => ({ url: "http://bridge.invalid", token: `${itemId}:${scope ?? ""}`, ...(writes ? { writes: [...writes] } : {}) }) }),
    });
    await engine.runOnce();
    expect(started).toHaveLength(1);
    expect(started[0]?.opts.writeBridge).toMatchObject({ reportOnly: true, token: `${item.id}:${started[0]!.attemptId}`, writes: [...TEAM_EVIDENCE_TOOLS] });
    expect(started[0]?.opts.instructions).toContain("cannot change any file, run any command, post a comment, create or reconfigure an agent, grant anything, or hand work to your backend's own subagents");
    expect(getItem(handle.db, item.id)?.stepId).toBe("accepted");
  });

  it("follows up on an assignment, superseding its earlier report, and refuses a final answer that relies on the superseded one", async () => {
    let first = "";
    leaderTurns = [
      says(assign([{ key: "auth", role: "sec", instructions: "Look at the login." }])),
      sayingThen(() => {
        first = reportId("auth");
        return assign([{ key: "auth", role: "sec", instructions: "You missed the token refresh: look at it." }], "Feedback: the refresh path matters most.");
      }),
      sayingThen(() => final({ result: "aligned", summary: "Fine." }, [first])),
      sayingThen(({ opts }) => {
        expect(opts.context).toContain("no longer current");
        return final({ result: "gaps_found", summary: "The refresh leaks." }, [reportId("auth")]);
      }),
    ];
    let sashaTurns = 0;
    participants = {
      Sasha: (call) => {
        sashaTurns += 1;
        if (sashaTurns === 2) {
          expect(call.opts.context).toContain("You missed the token refresh: look at it.");
          expect(call.opts.context).toContain("## Your earlier report on this assignment");
          expect(call.opts.context).toContain("The login is fine.");
        }
        return says(report(sashaTurns === 1 ? "The login is fine." : "The refresh leaks the token."))(call);
      },
    };
    await supervisor().runOnce();

    expect(getItem(handle.db, item.id)?.stepId).toBe("rework");
    const auth = attempts().filter((attempt) => attempt.assignmentKey === "auth");
    expect(auth.map((attempt) => [attempt.round, attempt.status, attempt.supersededBy !== null])).toEqual([
      [1, "completed", true],
      [2, "completed", false],
    ]);
    expect(notes().some((body) => body.includes("EO did not accept the leader's final answer") && body.includes("no longer current"))).toBe(true);
    expect(notes().some((body) => body.includes("Feedback: the refresh path matters most."))).toBe(true);
  });

  it("refuses undeclared roles, the leader's own key and assignments past its participant and round limits, saying why", async () => {
    setTeam(leaderTeam({ limits: { maxParticipants: 2, maxRounds: 1, maxRetries: 1 } }));
    leaderTurns = [
      says(assign([
        { key: "auth", role: "sec", instructions: "Look at the login." },
        { key: "infra", role: "admin", instructions: "Reconfigure the server." },
        { key: LEADER_ASSIGNMENT_KEY, role: "sec", instructions: "Lead instead." },
        { key: "suite", role: "tester", instructions: "Read the tests." },
        { key: "more", role: "tester", instructions: "And more tests." },
      ])),
      // A second round, past the one allowed.
      says(assign([{ key: "auth", role: "sec", instructions: "Again." }])),
      sayingThen(() => final({ result: "aligned", summary: "Fine." }, [reportId("auth"), reportId("suite")])),
    ];
    participants = { Sasha: says(report("Login fine.")), Tess: says(report("Tests fine.")) };
    await supervisor().runOnce();

    expect(getItem(handle.db, item.id)?.stepId).toBe("accepted");
    expect(new Set(attempts().map((attempt) => attempt.assignmentKey))).toEqual(new Set([LEADER_ASSIGNMENT_KEY, "auth", "suite"]));
    const refusals = notes().filter((body) => body.startsWith("EO refused"));
    expect(refusals[0]).toContain('**infra**: The role "admin" is not one this team permits');
    expect(refusals[0]).toContain(`**${LEADER_ASSIGNMENT_KEY}**: "${LEADER_ASSIGNMENT_KEY}" is the key the leader's own turns are kept under`);
    expect(refusals[0]).toContain("**more**: The team allows 2 participants in all");
    expect(refusals[1]).toContain("1 round of assignments and all of them are used");
    // The leader's next turn is told what was refused.
    expect(turnsOf("Lee")[2]?.opts.context).toContain("Assignments EO refused:");
    expect(turnsOf("Sasha")).toHaveLength(1);
  });

  it("does not let a contributor delegate: its answer is refused with the reason recorded, and retried within its limit", async () => {
    leaderTurns = [
      says(assign([{ key: "auth", role: "sec", instructions: "Look at the login." }])),
      sayingThen(() => final({ result: "aligned", summary: "Fine." }, [reportId("auth")])),
    ];
    let sashaTurns = 0;
    participants = {
      Sasha: (call) => {
        sashaTurns += 1;
        return sashaTurns === 1 ? says({ outcome: { assignments: [{ key: "deeper", role: "tester", instructions: "Do it for me." }] } })(call) : says(report("Login fine."))(call);
      },
    };
    await supervisor().runOnce();
    const auth = attempts().filter((attempt) => attempt.assignmentKey === "auth");
    expect(auth.map((attempt) => attempt.status)).toEqual(["failed", "completed"]);
    expect(auth[0]?.error).toContain("A contributor cannot hand work on");
    expect(notes().some((body) => body.includes("**auth** tried to assign work, which only the leader may do"))).toBe(true);
    expect(attempts().some((attempt) => attempt.assignmentKey === "deeper")).toBe(false);
    expect(turnsOf("Tess")).toHaveLength(0);
    expect(getItem(handle.db, item.id)?.stepId).toBe("accepted");
  });

  it("rejects a final answer with a missing required report, an invalid answer or an undeclared result, however the leader words it, and fails past its retries", async () => {
    setTeam(leaderTeam({ limits: { maxRetries: 2 } }));
    leaderTurns = [
      says(assign([{ key: "auth", role: "sec", instructions: "Look at the login." }])),
      // The required report is missing, and the leader says it is all done anyway.
      says(final({ result: "aligned", summary: "Everything was checked and is done." }, [])),
      says(final({ result: "shipped", summary: "Shipped." }, [])),
      says(final({ verdict: "fine" }, [])),
    ];
    participants = {
      Sasha: () =>
        (async function* () {
          yield { type: "thread_started", threadId: `thread-${uuidv7()}` } as AgentEvent;
          // Ends with no answer, every time.
        })(),
    };
    await supervisor().runOnce();

    expect(getItem(handle.db, item.id)?.stepId).toBe("check");
    expect(listTransitionsForItem(handle.db, item.id)).toEqual([]);
    const refusals = notes().filter((body) => body.startsWith("EO did not accept the leader's final answer"));
    expect(refusals).toHaveLength(3);
    for (const refusal of refusals) expect(refusal).toContain("The required assignment **auth** has no accepted report");
    expect(refusals[1]).toContain('Its result "shipped" is not one "alignment" declares (aligned, gaps_found).');
    expect(refusals[2]).toContain('not a valid "alignment" answer');
    expect(teamRuns()[0]?.status).toBe("awaiting_input");
    expect(listTeamSessionsForItem(handle.db, item.id)[0]?.session.status).toBe("failed");
    expect(notes().at(-1)).toContain("could not finish");
  });

  it("carries on after a restart from what was persisted: neither the leader's turn nor the report is done again, and the leader's next turn gets the report", async () => {
    const nothing = nothingCaptured();
    const parent = createRun(handle.db, { itemId: item.id, agentId: quinn.id, action: "alignment", stepId: "check", status: "running", initiationId: `entered:${item.id}` }).id;
    const session = openTeamSession(handle.db, { itemId: item.id, stepId: "check", team: leaderTeam(), runId: parent });
    const verdict = { decision: "assign", accepted: [{ key: "auth", role: "sec", instructions: "Look at the login.", required: true }], refused: [] };
    const leaderRun = createRun(handle.db, { itemId: item.id, agentId: lee.id, action: TEAM_PARTICIPANT_ACTION, stepId: "check", status: "succeeded" }).id;
    updateRun(handle.db, leaderRun, { result: { leader: true, answer: {}, verdict }, costCents: 5 });
    const leaderAttempt = startTeamAttempt(handle.db, { sessionId: session.id, assignmentKey: LEADER_ASSIGNMENT_KEY, role: "lead", agentId: lee.id, instructions: "Lead.", runId: leaderRun, evidenceBaseline: nothing });
    if (!leaderAttempt.ok) throw new Error(leaderAttempt.problem);
    expect(acceptTeamReport(handle.db, { attemptId: leaderAttempt.attempt.id, outcome: null, report: "Assigns round 1." }).ok).toBe(true);
    const sasha = agentNamed("Sasha");
    const authRun = createRun(handle.db, { itemId: item.id, agentId: sasha, action: TEAM_PARTICIPANT_ACTION, stepId: "check", status: "running" }).id;
    const auth = startTeamAttempt(handle.db, { sessionId: session.id, assignmentKey: "auth", role: "sec", agentId: sasha, instructions: "Look at the login.", runId: authRun, evidenceBaseline: nothing });
    if (!auth.ok) throw new Error(auth.problem);
    expect(acceptTeamReport(handle.db, { attemptId: auth.attempt.id, outcome: null, report: "The login is fine." }).ok).toBe(true);
    updateRun(handle.db, authRun, { status: "succeeded" });

    leaderTurns = [
      sayingThen(({ opts }) => {
        expect(opts.context).toContain("The login is fine.");
        return final({ result: "aligned", summary: "Fine." }, [reportId("auth")]);
      }),
    ];
    const engine = supervisor();
    await engine.reconcile();
    await engine.runOnce();

    expect(getItem(handle.db, item.id)?.stepId).toBe("accepted");
    expect(turnsOf("Sasha")).toHaveLength(0);
    expect(turnsOf("Lee")).toHaveLength(1);
    expect(listTeamSessionsForItem(handle.db, item.id)).toHaveLength(1);
    expect(listTransitionsForItem(handle.db, item.id)).toHaveLength(1);
    expect(teamSessionTotals(handle.db, session.id).costCents).toBe(5);
  });

  it("does not finalise a leader's answer, given with no reports, on evidence that moved while it answered: the leader answers again", async () => {
    leaderTurns = [
      sayingThen(() => {
        // The evidence moves while the leader is answering from its own reading.
        attach("spec.txt", "The export must be signed.");
        return final({ result: "aligned", summary: "Read it myself; fine." }, []);
      }),
      sayingThen(({ opts }) => {
        expect(opts.context).toContain("changed after your last answer");
        return final({ result: "gaps_found", summary: "The spec now asks for signing, which is missing." }, []);
      }),
    ];
    await supervisor().runOnce();

    expect(turnsOf("Lee")).toHaveLength(2);
    expect(getItem(handle.db, item.id)?.stepId).toBe("rework");
    expect(listTeamSessionsForItem(handle.db, item.id)[0]?.session.result).toBe("gaps_found");
    expect(listTransitionsForItem(handle.db, item.id)).toHaveLength(1);
  });

  describe("a leader's session that settled before the item moved", () => {
    /** As a restart leaves it: the team's run interrupted, the session finalised on the leader's answer from its own reading. */
    function settledByLeader(): void {
      const parent = createRun(handle.db, { itemId: item.id, agentId: quinn.id, action: "alignment", stepId: "check", status: "running", initiationId: `entered:${item.id}` }).id;
      const session = openTeamSession(handle.db, { itemId: item.id, stepId: "check", team: leaderTeam(), runId: parent });
      const leaderRun = createRun(handle.db, { itemId: item.id, agentId: lee.id, action: TEAM_PARTICIPANT_ACTION, stepId: "check", status: "succeeded" }).id;
      const value = { result: "aligned", summary: "Read it myself; fine." };
      updateRun(handle.db, leaderRun, { result: { leader: true, answer: {}, verdict: { decision: "final", accepted: true, problems: [], contributions: [] }, value } });
      const turn = startTeamAttempt(handle.db, { sessionId: session.id, assignmentKey: LEADER_ASSIGNMENT_KEY, role: "lead", agentId: lee.id, instructions: "Lead.", runId: leaderRun, evidenceBaseline: nothingCaptured() });
      if (!turn.ok) throw new Error(turn.problem);
      expect(acceptTeamReport(handle.db, { attemptId: turn.attempt.id, outcome: null, report: "Answers the step." }).ok).toBe(true);
      expect(endTeamSession(handle.db, { sessionId: session.id, status: "finalized", result: "aligned" }).ok).toBe(true);
    }

    it("answers with the settled result again, running nobody, while nothing it read has changed", async () => {
      settledByLeader();
      const engine = supervisor();
      await engine.reconcile();
      await engine.runOnce();
      expect(started).toEqual([]);
      expect(getItem(handle.db, item.id)?.stepId).toBe("accepted");
      expect(listTransitionsForItem(handle.db, item.id)).toHaveLength(1);
    });

    it("does not replay it once what is asked has changed, though it relied on no report: the leader runs again", async () => {
      settledByLeader();
      editBody("The export must also be signed.");
      leaderTurns = [says(final({ result: "gaps_found", summary: "Signing is missing." }, []))];
      const engine = supervisor();
      await engine.reconcile();
      await engine.runOnce();
      expect(turnsOf("Lee")).toHaveLength(1);
      expect(getItem(handle.db, item.id)?.stepId).toBe("rework");
      expect(listTeamSessionsForItem(handle.db, item.id).map((record) => record.session.status)).toEqual(["finalized", "finalized"]);
    });
  });

  it("runs a leader and its contributors on different backends under the same rules", async () => {
    handle.close();
    rmSync(scratch, { recursive: true, force: true });
    setup("codex", { sec: "claude", tester: "codex" });
    leaderTurns = [
      says(assign([
        { key: "auth", role: "sec", instructions: "Look at the login." },
        { key: "suite", role: "tester", instructions: "Read the tests." },
      ])),
      sayingThen(() => final({ result: "aligned", summary: "Both agree." }, [reportId("auth"), reportId("suite")])),
    ];
    let tessTurns = 0;
    participants = {
      Sasha: says(report("Login fine.")),
      // The Codex contributor tries to delegate first, and is held to the same rule as a Claude one.
      Tess: (call) => {
        tessTurns += 1;
        return tessTurns === 1 ? says({ outcome: { decision: "assign", assignments: [] } })(call) : says(report("Tests fine."))(call);
      },
    };
    await supervisor().runOnce();

    expect(getItem(handle.db, item.id)?.stepId).toBe("accepted");
    expect(new Set(started.map((one) => `${one.agent}:${one.provider}`))).toEqual(new Set(["Lee:codex", "Sasha:claude", "Tess:codex"]));
    expect(participantRuns().map((run) => run.provider).sort()).toEqual(["claude", "codex", "codex", "codex", "codex"]);
    expect(attempts().find((attempt) => attempt.assignmentKey === "suite" && attempt.status === "failed")?.error).toContain("A contributor cannot hand work on");
    // Every turn, whichever backend, is constrained to an answer schema and is report-only.
    for (const one of started) expect(one.opts.outputSchema).toBeDefined();
  });
});

// ── Leaderless ───────────────────────────────────────────────────────

describe("a leaderless team (EO-847)", () => {
  beforeEach(() => {
    setup();
    setTeam(independentTeam());
  });

  it("starts no hidden coordinating or synthesizing agent: every turn is a declared participant's", async () => {
    participants = { Sasha: says({ outcome: { outcome: "clear", report: "Nothing." } }), Tess: says({ outcome: { outcome: "clear", report: "Fine." } }) };
    await supervisor().runOnce();
    expect(getItem(handle.db, item.id)?.stepId).toBe("accepted");
    expect(started.map((one) => one.agent).sort()).toEqual(["Sasha", "Tess"]);
    expect(started.every((one) => !one.opts.instructions.includes("leader"))).toBe(true);
    expect(attempts().map((attempt) => attempt.assignmentKey).sort()).toEqual(["security", "tests"]);
    expect(participantRuns()).toHaveLength(2);
    expect(teamRuns()).toHaveLength(1);
  });
});

// ── Asking the person ────────────────────────────────────────────────

describe("a team member asking the person (EO-847)", () => {

  describe("on a leaderless team", () => {
    beforeEach(() => {
      setup();
      setTeam(independentTeam());
    });

    it("ends the asking turn, parks with the question attributed to its asker, and resumes only that assignment from the reply", async () => {
      let sashaTurns = 0;
      participants = {
        Sasha: (call) => {
          sashaTurns += 1;
          if (sashaTurns === 1) return says(asks("Which environment should I look at?"))(call);
          expect(call.opts.context).toContain("**Asked:** Which environment should I look at?");
          expect(call.opts.context).toContain("**Answer:** Production only.");
          return says({ outcome: { outcome: "blocking", report: "Production leaks a token." } })(call);
        },
        Tess: says({ outcome: { outcome: "clear", report: "Tests are fine." } }),
      };
      const engine = supervisor();
      await engine.runOnce();

      // Parked: the team's run awaits the person, the session stays open, nothing moved.
      expect(teamRuns()[0]?.status).toBe("awaiting_input");
      expect(listTeamSessionsForItem(handle.db, item.id)[0]?.session.status).toBe("open");
      expect(getItem(handle.db, item.id)?.stepId).toBe("check");
      const question = listCommentsForItem(handle.db, item.id).find((comment) => comment.kind === "question");
      const sashaAttempt = attempts().find((attempt) => attempt.assignmentKey === "security")!;
      expect(question?.authorId).toBe(sashaAttempt.agentId);
      expect(question?.runId).toBe(sashaAttempt.runId);
      expect(sashaAttempt.status).toBe("cancelled");
      expect(listCommentsForItem(handle.db, item.id).filter((comment) => comment.kind === "question")).toHaveLength(1);
      // No process waits on the person.
      expect(engine.activeRunCount()).toBe(0);

      reply("Sasha", "Production only.");
      await engine.resumeItem(item.id);

      expect(getItem(handle.db, item.id)?.stepId).toBe("rework");
      expect(sashaTurns).toBe(2);
      // The sibling's valid report was kept, not run again.
      expect(turnsOf("Tess")).toHaveLength(1);
      expect(listTeamSessionsForItem(handle.db, item.id)).toHaveLength(1);
      expect(listTeamSessionsForItem(handle.db, item.id)[0]?.session.status).toBe("finalized");
    });

    it("does not reuse a sibling's verdict on evidence that changed while it waited", async () => {
      let sashaTurns = 0;
      participants = {
        Sasha: (call) => {
          sashaTurns += 1;
          return says(sashaTurns === 1 ? asks("Which environment?") : { outcome: { outcome: "clear", report: "Production is fine." } })(call);
        },
        Tess: says({ outcome: { outcome: "clear", report: "Tests are fine." } }),
      };
      const engine = supervisor();
      await engine.runOnce();
      expect(teamRuns()[0]?.status).toBe("awaiting_input");

      attach("spec.txt", "The export must be signed.");
      reply("Sasha", "Production.");
      await engine.resumeItem(item.id);

      expect(getItem(handle.db, item.id)?.stepId).toBe("accepted");
      expect(turnsOf("Tess")).toHaveLength(2);
      const tests = attempts().filter((attempt) => attempt.assignmentKey === "tests");
      expect(tests[0]?.supersededBy).toBe(tests[1]?.id);
      // Restarted because the evidence moved, not only because it was answered: the answer still reaches it.
      expect(turnsOf("Sasha")[1]?.opts.context).toContain("**Answer:** Production.");
    });

    it("keeps the person's answer through a failed turn after it, and the retry that replaces that", async () => {
      let sashaTurns = 0;
      participants = {
        Sasha: (call) => {
          sashaTurns += 1;
          if (sashaTurns === 1) return says(asks("Which environment?"))(call);
          if (sashaTurns === 2)
            return (async function* () {
              yield { type: "error", message: "The backend crashed.", retryable: true } as AgentEvent;
            })();
          expect(call.opts.context).toContain("**Asked:** Which environment?");
          expect(call.opts.context).toContain("**Answer:** Staging.");
          return says({ outcome: { outcome: "clear", report: "Staging is fine." } })(call);
        },
        Tess: says({ outcome: { outcome: "clear", report: "Tests are fine." } }),
      };
      const engine = supervisor();
      await engine.runOnce();
      reply("Sasha", "Staging.");
      await engine.resumeItem(item.id);

      expect(sashaTurns).toBe(3);
      expect(getItem(handle.db, item.id)?.stepId).toBe("accepted");
      expect(attempts().filter((attempt) => attempt.assignmentKey === "security").map((attempt) => attempt.status)).toEqual(["cancelled", "failed", "completed"]);
    });

    it("does not keep a verdict made against requirements a person edited while it waited, on an item with no disk", async () => {
      let sashaTurns = 0;
      participants = {
        Sasha: (call) => {
          sashaTurns += 1;
          return says(sashaTurns === 1 ? asks("Which environment?") : { outcome: { outcome: "clear", report: "Production is fine." } })(call);
        },
        Tess: (call) => says({ outcome: { outcome: call.opts.context.includes("must also export JSON") ? "blocking" : "clear", report: "Read the requirements." } })(call),
      };
      const engine = supervisor();
      await engine.runOnce();
      expect(teamRuns()[0]?.status).toBe("awaiting_input");

      editBody("The export must also export JSON.");
      reply("Sasha", "Production.");
      await engine.resumeItem(item.id);

      // The sibling's verdict on the old requirements was not kept: it read the new ones and found the gap.
      expect(turnsOf("Tess")).toHaveLength(2);
      expect(turnsOf("Tess")[1]?.opts.context).toContain("The export must also export JSON.");
      expect(getItem(handle.db, item.id)?.stepId).toBe("rework");
      expect(turnsOf("Sasha")[1]?.opts.context).toContain("**Answer:** Production.");
    });

    it("keeps a sibling's verdict across a clarification when nothing it read changed", async () => {
      let sashaTurns = 0;
      participants = {
        Sasha: (call) => {
          sashaTurns += 1;
          return says(sashaTurns === 1 ? asks("Which environment?") : { outcome: { outcome: "clear", report: "Fine." } })(call);
        },
        Tess: says({ outcome: { outcome: "clear", report: "Tests are fine." } }),
      };
      const engine = supervisor();
      await engine.runOnce();
      // A person's reply, and the team's own comments, are not a change to what is asked.
      postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Thanks, looking." });
      reply("Sasha", "Production.");
      await engine.resumeItem(item.id);
      expect(turnsOf("Tess")).toHaveLength(1);
      expect(getItem(handle.db, item.id)?.stepId).toBe("accepted");
    });
  });

  describe("on a leader-led team", () => {
    beforeEach(() => setup());

    it("parks on the leader's question, grants nothing it asked for, and gives its next turn the answer", async () => {
      const before = getAgent(handle.db, lee.id);
      leaderTurns = [
        says(asks("May I have shell access to run the export?")),
        sayingThen(({ opts }) => {
          expect(opts.context).toContain("**Answer:** No. Read the code instead.");
          return final({ result: "aligned", summary: "Read it; fine." }, []);
        }),
      ];
      const engine = supervisor();
      await engine.runOnce();

      expect(teamRuns()[0]?.status).toBe("awaiting_input");
      const question = listCommentsForItem(handle.db, item.id).find((comment) => comment.kind === "question");
      expect(question?.authorId).toBe(lee.id);
      expect(question?.runId).toBe(attempts()[0]?.runId);

      reply("Lee", "No. Read the code instead.");
      await engine.resumeItem(item.id);

      expect(getItem(handle.db, item.id)?.stepId).toBe("accepted");
      // Asking for a permission changed nothing about what the leader is dispatched with.
      expect(getAgent(handle.db, lee.id)).toEqual(before);
      expect(turnsOf("Lee")).toHaveLength(2);
    });

    it("keeps a contributor's answer, and the leader's, when the evidence changed while they waited", async () => {
      leaderTurns = [
        says(asks("Which release should the team check?")),
        sayingThen(({ opts }) => {
          expect(opts.context).toContain("**Answer:** Release 2.");
          return assign([{ key: "auth", role: "sec", instructions: "Look at the login in release 2." }]);
        }),
        sayingThen(({ opts }) => {
          // Its own earlier question and answer are still in front of it on a later turn.
          expect(opts.context).toContain("**Answer:** Release 2.");
          return final({ result: "aligned", summary: "Fine." }, [reportId("auth")]);
        }),
      ];
      let sashaTurns = 0;
      participants = {
        Sasha: (call) => {
          sashaTurns += 1;
          if (sashaTurns === 1) return says(asks("Staging or production?"))(call);
          expect(call.opts.context).toContain("**Answer:** Staging.");
          return says(report("Staging is fine."))(call);
        },
      };
      const engine = supervisor();
      await engine.runOnce();
      attach("notes.txt", "Release 2 notes.");
      reply("Lee", "Release 2.");
      await engine.resumeItem(item.id);
      expect(teamRuns().at(-1)?.status).toBe("awaiting_input");

      attach("more.txt", "More notes.");
      reply("Sasha", "Staging.");
      await engine.resumeItem(item.id);

      expect(getItem(handle.db, item.id)?.stepId).toBe("accepted");
      expect(sashaTurns).toBe(2);
      expect(turnsOf("Lee")).toHaveLength(3);
    });

    it("resumes the assignment that asked, keeps its sibling's report, and hands the leader both", async () => {
      leaderTurns = [
        says(assign([
          { key: "auth", role: "sec", instructions: "Look at the login." },
          { key: "suite", role: "tester", instructions: "Read the tests." },
        ])),
        sayingThen(({ opts }) => {
          expect(opts.context).toContain("Staging token leaks.");
          expect(opts.context).toContain("Tests fine.");
          return final({ result: "gaps_found", summary: "Staging leaks." }, [reportId("auth"), reportId("suite")]);
        }),
      ];
      let sashaTurns = 0;
      participants = {
        Sasha: (call) => {
          sashaTurns += 1;
          return says(sashaTurns === 1 ? asks("Staging or production?") : report("Staging token leaks."))(call);
        },
        Tess: says(report("Tests fine.")),
      };
      const engine = supervisor();
      await engine.runOnce();
      expect(teamRuns()[0]?.status).toBe("awaiting_input");
      expect(turnsOf("Lee")).toHaveLength(1);

      reply("Sasha", "Staging.");
      await engine.resumeItem(item.id);

      expect(getItem(handle.db, item.id)?.stepId).toBe("rework");
      expect(turnsOf("Tess")).toHaveLength(1);
      expect(sashaTurns).toBe(2);
      expect(turnsOf("Lee")).toHaveLength(2);
      const auth = attempts().filter((attempt) => attempt.assignmentKey === "auth");
      expect(auth.map((attempt) => attempt.status)).toEqual(["cancelled", "completed"]);
    });
  });
});
