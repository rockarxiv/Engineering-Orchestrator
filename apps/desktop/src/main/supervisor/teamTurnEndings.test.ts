import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { LEADER_ASSIGNMENT_KEY, StepTeamSchema, TEAM_PARTICIPANT_ACTION, TEAM_RETRY_REQUESTED, uuidv7, type Agent, type AgentProvider, type AgentProviderStartOptions, type Item, type StepTeam, type TeamAttemptRow } from "@eo/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../db/client.js";
import { saveActionDefinition } from "../db/repos/actionDefinitionsRepo.js";
import { createAgent, listAgents, updateAgent } from "../db/repos/agentsRepo.js";
import { listCommentsForItem } from "../db/repos/commentsRepo.js";
import { createRoute } from "../db/repos/index.js";
import { getItem } from "../db/repos/itemsRepo.js";
import { createStep } from "../db/repos/pipelineStepsRepo.js";
import { listRunsForItem } from "../db/repos/runsRepo.js";
import { listTeamSessionsForItem } from "../db/repos/teamSessionsRepo.js";
import { createTestItem, messagesFrom, openMigratedTestDb, REVIEWABLE_SPEC, agentOfKind } from "../db/testHelpers.js";
import type { EngineHandle } from "../ipc/domainCommands.js";
import { retryTeamSessionCommand } from "../ipc/teamCommands.js";
import { createClaudeProvider } from "../providers/claude.js";
import { createCodexProvider } from "../providers/codex.js";
import { CodexClient, dropWarmCodexThread } from "../providers/codexClient.js";
import { onRuntimeSignedIn, runtimeSignedIn } from "../runtimes/signedIn.js";
import { CLAUDE_AUTH_ERRORS, CODEX_AUTH_ERRORS } from "../testing/authErrorFixtures.js";
import { fakeAppServer, note } from "../testing/fakeCodexAppServer.js";
import { createRunSupervisor, type RunSupervisor } from "./runSupervisor.js";
import { RUNTIME_LIMIT_SOURCE, RUNTIME_SIGN_IN_SOURCE, runtimeLimitHoldPrefix } from "./runtimeBlocks.js";
import { itemTeamSessions } from "./teamSessionView.js";
import type { ReportOnlyProviderAnswer } from "./teamSupervisor.js";

/**
 * A team's turn is driven and ended by the code that drives an ordinary
 * run's (EO-886): a plan limit, a sign-in that is no good, an answer said
 * only as the turn's last message and a runtime already on hold are read
 * as an ordinary run's are, and a session that stops says why.
 *
 * Mocked: what each backend answers, scripted per turn. Real: the adapter
 * each agent's backend is reached through — the Claude provider over a
 * stubbed SDK `query`, the Codex provider and client over a stubbed
 * `codex app-server` — so a refusal, a sign-in failure and a final message
 * arrive as each backend's own parsing reports them (invariant 12). Every
 * turn is a report-only one, the leader's included.
 */

type Backend = "claude" | "codex";
const BACKENDS: Backend[] = ["claude", "codex"];
const CODEX_EXECUTABLE = "/opt/eo/runtimes/codex/bin/codex";
const ROOMY = { globalConcurrency: 1, perAgentConcurrency: 2, perRepositoryConcurrency: 1 };
const HOUR = 3_600_000;
/**
 * A Codex team takes about a second here, each turn a client brought up
 * and shut down over the stubbed app-server, so `waitFor`'s one-second
 * default is too short on a slower CI runner (macOS, Windows).
 */
const SLOW_RUNNER = { timeout: 15_000 };
/** Fixed, so a reset is arithmetic. */
const START = Date.UTC(2026, 10, 21, 9, 0);
/** When a window refused `hours` after the start comes back, as both backends say it: seconds. */
const resetsAt = (hours: number): number => (START + hours * HOUR) / 1000;
/** The same reset, in the local wall-clock words the Codex CLI says it in. */
const codexResetWords = (hours: number): string =>
  new Date(START + hours * HOUR).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).replace(",", "").replace("\u202f", " ");

/** What one scripted turn does on its backend. */
type Plan =
  /** Answers, through the backend's own answer. */
  | { kind: "answer"; data: () => unknown }
  /** Refused by the five-hour window before it said anything usable; it comes back `back` hours after the start. */
  | { kind: "limit"; back: number }
  /** Writes half an answer, then the window refuses it until `back` hours after the start. */
  | { kind: "partial"; back: number }
  /** Refused because its sign-in is no good, as the pinned CLI says it. */
  | { kind: "signedOut" }
  /** Says its answer as its last message, and no result follows it. */
  | { kind: "finalOnly"; data: () => unknown }
  /** Fails, with these words. */
  | { kind: "fails"; message: string };

const HALF_AN_ANSWER = '{"outcome":{"report":"Tess read the CSV te';

function claudeMessages(plan: Plan): SDKMessage[] {
  const session = `sess-${uuidv7()}`;
  const init = { type: "system", subtype: "init", session_id: session } as unknown as SDKMessage;
  const says = (text: string) => ({ type: "assistant", message: { content: [{ type: "text", text }] }, session_id: session }) as unknown as SDKMessage;
  const refused = (back: number) =>
    ({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour", utilization: 100, resetsAt: resetsAt(back) }, uuid: "u-1", session_id: session }) as unknown as SDKMessage;
  const result = (extra: Record<string, unknown>) =>
    ({ type: "result", subtype: "success", total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 10 }, session_id: session, ...extra }) as unknown as SDKMessage;
  switch (plan.kind) {
    case "answer": {
      const data = plan.data();
      return [init, result({ result: JSON.stringify(data), structured_output: data })];
    }
    case "limit":
      return [init, refused(plan.back), result({ is_error: true, result: "You've hit your limit · resets 10am" })];
    case "partial":
      return [init, says(HALF_AN_ANSWER), refused(plan.back), result({ result: HALF_AN_ANSWER })];
    case "signedOut":
      return [init, ...CLAUDE_AUTH_ERRORS.signIn[0]!.turn];
    case "finalOnly":
      return [init, says(JSON.stringify(plan.data()))];
    case "fails":
      return [init, result({ is_error: true, result: plan.message })];
  }
}

function codexNotifications(plan: Plan): unknown[] {
  const refused = (back: number) => note.rateLimits({ usedPercent: 100, resetsAt: resetsAt(back) });
  switch (plan.kind) {
    case "answer":
      return [note.turnStarted(), note.agentMessage(JSON.stringify(plan.data())), note.tokenUsage({ input: 10, output: 10 }), note.turnCompleted()];
    case "limit":
      return [note.turnStarted(), refused(plan.back), note.turnCompleted("failed", `You've hit your usage limit. Upgrade to Pro, or try again at ${codexResetWords(plan.back)}.`)];
    case "partial":
      return [note.turnStarted(), note.agentMessage(HALF_AN_ANSWER), refused(plan.back), note.turnCompleted()];
    case "signedOut":
      return [note.turnStarted(), ...CODEX_AUTH_ERRORS.signIn[0]!.turn];
    // A turn handed a schema names its answer from its final message on
    // Codex itself: the same scenario, the answer taken either way.
    case "finalOnly":
      return [note.turnStarted(), note.agentMessage(JSON.stringify(plan.data())), note.turnCompleted()];
    case "fails":
      return [note.turnStarted(), note.turnCompleted("failed", plan.message)];
  }
}

/** One turn through its backend's real adapter, playing `plan`. */
function turnOn(backend: Backend, plan: Plan, opts: AgentProviderStartOptions): ReturnType<AgentProvider["start"]> {
  if (backend === "claude") {
    const messages = claudeMessages(plan);
    const runQuery = (() =>
      (async function* () {
        yield* messages;
      })()) as never;
    return createClaudeProvider({ runQuery, enableCommentTool: false }).start(opts);
  }
  const fake = fakeAppServer({ after: { "turn/start": codexNotifications(plan) as never } });
  return createCodexProvider({ executablePath: CODEX_EXECUTABLE, createCodex: () => new CodexClient({ executablePath: CODEX_EXECUTABLE, spawn: fake.spawn, shutdownGraceMs: 200 }) }).start(opts);
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

let handle: DbHandle;
let item: Item;
let scratch: string;
let clock: number;
/** Each agent's turns, by name, in order: one taken per turn. */
let plans: Record<string, Plan[]>;
/** Every turn started: whose, and on which backend. */
let started: { agent: string; backend: string }[];
const supervisors: RunSupervisor[] = [];

function reportOnlyProvider(agent: Agent, attemptId: string): ReportOnlyProviderAnswer {
  return {
    ok: true,
    cwd: join(scratch, attemptId),
    provider: {
      start: (opts) => {
        started.push({ agent: agent.name, backend: agent.provider });
        const plan = plans[agent.name]?.shift();
        if (plan === undefined) throw new Error(`Nothing scripted for ${agent.name}'s turn.`);
        return turnOn(agent.provider as Backend, plan, opts);
      },
    },
  };
}

function supervisor(extra: Partial<Parameters<typeof createRunSupervisor>[0]> = {}): RunSupervisor {
  const made = createRunSupervisor({ db: handle.db, provider: ownerProvider, limits: ROOMY, reportOnlyProvider, teamPollMs: 5, now: () => clock, ...extra });
  supervisors.push(made);
  return made;
}

/** A supervisor ticking on its own, so a hold lifts at its reset while the team waits. */
function ticking(extra: Partial<Parameters<typeof createRunSupervisor>[0]> = {}): RunSupervisor {
  const made = supervisor({ tickIntervalMs: 10, watchdogIntervalMs: 3_600_000, onRuntimeSignedIn, ...extra });
  made.start();
  return made;
}

function leaderTeam(limits: Record<string, unknown> = {}): StepTeam {
  return StepTeamSchema.parse({
    coordination: "leader",
    leader: { role: "lead", instructions: "Find out whether the export does what was asked." },
    roles: ["sec", "tester"],
    limits: { maxParticipants: 2, maxParallel: 2, maxRounds: 2, maxRetries: 1, ...limits },
  });
}

function setup(backend: Backend, team: StepTeam = leaderTeam()): void {
  handle = openMigratedTestDb();
  scratch = mkdtempSync(join(tmpdir(), "eo-team-turn-endings-"));
  clock = START;
  plans = {};
  started = [];
  createAgent(handle.db, { name: "Quinn", role: "qa", provider: backend, instructions: "You check work." });
  createAgent(handle.db, { name: "Lee", role: "lead", provider: backend, instructions: "You lead reviews." });
  createAgent(handle.db, { name: "Sasha", role: "sec", provider: backend, instructions: "You find ways in." });
  createAgent(handle.db, { name: "Tess", role: "tester", provider: backend, instructions: "You read tests." });
  createStep(handle.db, { id: "check", pipelineId: "default" as never, position: -3, name: "Alignment", type: "agent", agentId: agentOfKind(handle.db, "qa"), entryAction: "alignment", team });
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
}

afterEach(async () => {
  for (const made of supervisors.splice(0)) {
    made.stop();
    await made.shutdown();
  }
  dropWarmCodexThread();
  handle.close();
  rmSync(scratch, { recursive: true, force: true });
});

const assign = () => ({
  outcome: {
    decision: "assign",
    assignments: [
      { key: "auth", member: "Sasha", scope: "the whole change", instructions: "Look only at how the export authenticates.", required: true },
      { key: "suite", member: "Tess", scope: "the whole change", instructions: "Check the export's tests cover the CSV path.", required: true },
    ],
    note: "Split it up.",
  },
});
const final = (contributions: string[]) => ({
  outcome: { decision: "final", answer: { result: "aligned", summary: "The export does what was asked." }, contributions, disagreements: "None: they agree.", limitations: "Nothing was run, only read." },
});
const report = (text: string) => ({ outcome: { report: text } });

const attempts = (): TeamAttemptRow[] => listTeamSessionsForItem(handle.db, item.id).at(-1)?.attempts ?? [];
const reportId = (key: string): string => {
  const found = attempts().find((attempt) => attempt.assignmentKey === key && attempt.status === "completed" && attempt.supersededBy === null)?.reportCommentId;
  if (found === undefined || found === null) throw new Error(`No current report at ${key}.`);
  return found;
};
const finalOnReports = () => final([reportId("auth"), reportId("suite")]);
const participantRuns = () => listRunsForItem(handle.db, item.id).filter((run) => run.action === TEAM_PARTICIPANT_ACTION);
const notes = () => listCommentsForItem(handle.db, item.id).filter((comment) => comment.authorType === "engine").map((comment) => comment.body);
const stepNow = () => getItem(handle.db, item.id)?.stepId;
/** What the team session panel says it waits on. */
const waitingSaid = () => itemTeamSessions(handle.db, item.id).flatMap((view) => view.waiting.map((wait) => wait.text));

describe.each(BACKENDS)("a team on %s whose runtime refuses a turn (EO-886)", (backend) => {
  it("stops the leader and a member at a plan limit without a retry, holds the runtime, and carries on with the same assignments once the window is back, keeping the report already accepted", async () => {
    setup(backend);
    plans = {
      // The leader's first turn is refused outright; its next assigns.
      Lee: [{ kind: "limit", back: 1 }, { kind: "answer", data: assign }, { kind: "answer", data: finalOnReports }],
      Sasha: [{ kind: "answer", data: () => report("Sasha checked the tokens.") }],
      // Tess writes half her report before the window refuses her.
      Tess: [{ kind: "partial", back: 2 }, { kind: "answer", data: () => report("Tess read the CSV tests.") }],
    };

    // Past the leader's limit: one stop, no failure, and the runtime held.
    ticking();
    await vi.waitFor(() => expect(attempts().filter((attempt) => attempt.assignmentKey === LEADER_ASSIGNMENT_KEY && attempt.status === "cancelled")).toHaveLength(1), SLOW_RUNNER);
    const limited = attempts()[0]!;
    expect(limited.error).toContain(`The "${backend}" backend refused this run`);
    expect(attempts().filter((attempt) => attempt.status === "failed")).toEqual([]);
    expect(messagesFrom(handle.db, RUNTIME_LIMIT_SOURCE)).toHaveLength(1);
    expect(notes().filter((body) => body.startsWith(runtimeLimitHoldPrefix(backend)))).toHaveLength(1);
    expect(participantRuns()[0]).toMatchObject({ status: "cancelled", error: limited.error });
    // Nothing more starts on the held runtime, and the panel says why.
    await vi.waitFor(() => expect(waitingSaid().some((text) => text.includes("Lee's backend cannot run here right now"))).toBe(true), SLOW_RUNNER);
    expect(started).toEqual([{ agent: "Lee", backend }]);
    expect(stepNow()).toBe("check");

    // The window comes back: the leader assigns, Sasha reports, and Tess is refused mid-answer.
    clock = START + HOUR + 1;
    await vi.waitFor(() => expect(attempts().filter((attempt) => attempt.assignmentKey === "suite" && attempt.status === "cancelled")).toHaveLength(1), SLOW_RUNNER);
    await vi.waitFor(() => expect(attempts().filter((attempt) => attempt.assignmentKey === "auth" && attempt.status === "completed")).toHaveLength(1), SLOW_RUNNER);
    expect(attempts().filter((attempt) => attempt.status === "failed")).toEqual([]);
    expect(messagesFrom(handle.db, RUNTIME_LIMIT_SOURCE).filter((message) => message.handledAt === null)).toHaveLength(1);

    // Back again: only Tess runs again, and the leader settles on both reports.
    clock = START + 2 * HOUR + 1;
    await vi.waitFor(() => expect(stepNow()).toBe("accepted"), SLOW_RUNNER);
    expect(started.filter((one) => one.agent === "Sasha")).toHaveLength(1);
    expect(started.every((one) => one.backend === backend)).toBe(true);
    expect(attempts().filter((attempt) => attempt.status === "failed")).toEqual([]);
    expect(attempts().filter((attempt) => attempt.status === "cancelled").map((attempt) => attempt.assignmentKey)).toEqual([LEADER_ASSIGNMENT_KEY, "suite"]);
  });

  it(`holds a signed-out runtime through ${backend === "claude" ? "Claude" : "Codex"}'s own words, tells the person once, spends no retry and carries on once it is signed in`, async () => {
    setup(backend);
    plans = {
      Lee: [{ kind: "answer", data: assign }, { kind: "answer", data: finalOnReports }],
      Sasha: [{ kind: "signedOut" }, { kind: "answer", data: () => report("Sasha checked the tokens.") }],
      Tess: [{ kind: "answer", data: () => report("Tess read the CSV tests.") }],
    };
    ticking();
    await vi.waitFor(() => expect(attempts().filter((attempt) => attempt.assignmentKey === "auth" && attempt.status === "cancelled")).toHaveLength(1), SLOW_RUNNER);
    const stopped = attempts().find((attempt) => attempt.assignmentKey === "auth")!;
    expect(stopped.error).toContain("Stopped for a sign-in");
    const signIns = messagesFrom(handle.db, RUNTIME_SIGN_IN_SOURCE);
    expect(signIns).toHaveLength(1);
    expect(signIns[0]?.options).toContainEqual({ kind: "open", label: "Sign in", opens: { type: "runtimeSignIn", runtime: backend } });
    expect(notes().some((body) => body.includes("Its sign-in stopped working while the run was going"))).toBe(true);
    await vi.waitFor(() => expect(attempts().some((attempt) => attempt.assignmentKey === "suite" && attempt.status === "completed")).toBe(true), SLOW_RUNNER);
    await vi.waitFor(() => expect(waitingSaid().some((text) => text.includes("Sasha's backend cannot run here right now"))).toBe(true), SLOW_RUNNER);
    expect(attempts().filter((attempt) => attempt.status === "failed")).toEqual([]);

    runtimeSignedIn(backend);
    await vi.waitFor(() => expect(stepNow()).toBe("accepted"), SLOW_RUNNER);
    expect(started.filter((one) => one.agent === "Sasha")).toHaveLength(2);
    expect(started.filter((one) => one.agent === "Tess")).toHaveLength(1);
    expect(messagesFrom(handle.db, RUNTIME_SIGN_IN_SOURCE).map((message) => message.handledHow)).toEqual(["resolved"]);
    expect(attempts().filter((attempt) => attempt.status === "failed")).toEqual([]);
  });

  it("stops a leader whose turns failed past its retries with a message that ends on the last turn's error", async () => {
    setup(backend);
    plans = { Lee: [{ kind: "fails", message: "The API is overloaded." }, { kind: "fails", message: "The request was malformed: tools.3 is not valid." }] };
    await supervisor().runOnce();
    const parked = listRunsForItem(handle.db, item.id).find((run) => run.action === "alignment")!;
    expect(parked.status).toBe("awaiting_input");
    expect(parked.error).toMatch(/could not finish\. Retry the team[^]*failed or were refused 2 times[^]*The last of them: [^\n]*The request was malformed: tools\.3 is not valid\.$/);
    expect(stepNow()).toBe("check");
  });

  it("takes an answer said only as the turn's last message, valid against its schema, as an ordinary run's is", async () => {
    setup(backend);
    plans = {
      Lee: [{ kind: "finalOnly", data: assign }, { kind: "finalOnly", data: finalOnReports }],
      Sasha: [{ kind: "finalOnly", data: () => report("Sasha checked the tokens.") }],
      Tess: [{ kind: "answer", data: () => report("Tess read the CSV tests.") }],
    };
    await supervisor().runOnce();
    expect(stepNow()).toBe("accepted");
    expect(attempts().map((attempt) => attempt.status)).toEqual(["completed", "completed", "completed", "completed"]);
    expect(listCommentsForItem(handle.db, item.id).some((comment) => comment.body.includes("Sasha checked the tokens."))).toBe(true);
  });
});

describe.each(BACKENDS)("a person's Retry on a leader-led team on %s (EO-886)", (backend) => {
  it("runs again every member pass that failed for good before the leader answers again, and the leader answers from their reports", async () => {
    setup(backend);
    // As EO-877's passes did, before a limit was told apart from a failure:
    // each member's turn failed on the window — the attempt recorded as
    // failed, its retry spent against the same refusal — and the leader,
    // with no reports, was refused past its retries.
    const refused = "The turn was refused: 429 Too Many Requests.";
    plans = {
      Lee: [{ kind: "answer", data: assign }, { kind: "answer", data: () => final([]) }, { kind: "answer", data: () => final([]) }],
      Sasha: [{ kind: "fails", message: refused }, { kind: "fails", message: refused }],
      Tess: [{ kind: "fails", message: refused }, { kind: "fails", message: refused }],
    };
    const engine = supervisor();
    await engine.runOnce();
    const parked = listRunsForItem(handle.db, item.id).find((run) => run.action === "alignment")!;
    expect(parked.status).toBe("awaiting_input");
    expect(parked.error).toMatch(/- \*\*auth\*\*: [^\n]*The turn was refused: 429 Too Many Requests\./);
    expect(parked.error).toMatch(/- \*\*suite\*\*: [^\n]*The turn was refused: 429 Too Many Requests\.$/);
    expect(attempts().filter((attempt) => attempt.assignmentKey !== LEADER_ASSIGNMENT_KEY).every((attempt) => attempt.status === "failed")).toBe(true);
    const view = itemTeamSessions(handle.db, item.id, engine.teamControlSite())[0]!;
    expect(view.retry).toEqual({ allowed: true, reason: null, keys: expect.arrayContaining([LEADER_ASSIGNMENT_KEY, "auth", "suite"]) as unknown as string[] });
    expect(view.retry.keys).toHaveLength(3);

    // The window is back; the person retries.
    plans.Sasha = [{ kind: "answer", data: () => report("Sasha checked the tokens.") }];
    plans.Tess = [{ kind: "answer", data: () => report("Tess read the CSV tests.") }];
    plans.Lee = [{ kind: "answer", data: finalOnReports }];
    const roundsBefore = new Set(attempts().map((attempt) => attempt.round));
    expect(retryTeamSessionCommand(handle.db, engine as unknown as EngineHandle, { sessionId: view.id }).retried).toBe(true);
    await vi.waitFor(() => expect(stepNow()).toBe("accepted"), SLOW_RUNNER);

    // The members ran again, both before the leader's answer, which rests on their reports.
    const turns = started.slice(-3).map((one) => one.agent);
    expect(turns.slice(0, 2).sort()).toEqual(["Sasha", "Tess"]);
    expect(turns[2]).toBe("Lee");
    expect(plans.Lee).toEqual([]);
    // Same-round markers: no round and no retry spent.
    const markers = attempts().filter((attempt) => attempt.error === TEAM_RETRY_REQUESTED);
    expect(markers.map((attempt) => attempt.assignmentKey).sort()).toEqual([LEADER_ASSIGNMENT_KEY, "auth", "suite"].sort());
    expect(new Set(attempts().map((attempt) => attempt.round))).toEqual(roundsBefore);
    const leaderFinal = attempts().filter((attempt) => attempt.assignmentKey === LEADER_ASSIGNMENT_KEY).at(-1)!;
    expect(leaderFinal.status).toBe("completed");
    expect(listTeamSessionsForItem(handle.db, item.id).at(-1)!.session.status).toBe("finalized");
  });
});

describe.each(BACKENDS)("a team on %s and a runtime already on hold (EO-886)", (backend) => {
  it("starts no turn on a runtime an ordinary run put on hold, waits with the reason shown, and starts once it lifts", async () => {
    setup(backend);
    // The step's owner on no runtime, so the team's own run is dispatched
    // and only the team supervisor stands between its turns and the hold.
    updateAgent(handle.db, listAgents(handle.db).find((agent) => agent.name === "Quinn")!.id, { provider: "fake" });
    const ivy = updateAgent(handle.db, listAgents(handle.db).find((agent) => agent.role === "implementer")!.id, { provider: backend })!;
    const other = createTestItem(handle.db, { type: "story", title: "Something else", stepId: "todo", priority: 10, spec: REVIEWABLE_SPEC });
    plans = {
      Lee: [{ kind: "answer", data: assign }, { kind: "answer", data: finalOnReports }],
      Sasha: [{ kind: "answer", data: () => report("Sasha checked the tokens.") }],
      Tess: [{ kind: "answer", data: () => report("Tess read the CSV tests.") }],
    };
    // The ordinary run on the other item is refused by the window, and holds the runtime.
    const limited: AgentProvider = {
      start: (opts) => turnOn(backend, { kind: "limit", back: 1 }, opts),
      // Carried on once the hold lifts, and refused again: it holds nothing this test reads.
      resume: (_threadId, _message, opts) => turnOn(backend, { kind: "limit", back: 1 }, { instructions: "", context: "", cwd: scratch, ...opts } as AgentProviderStartOptions),
    };
    ticking({ provider: (agent: Agent) => (agent.id === ivy.id ? limited : ownerProvider) });
    await vi.waitFor(() => expect(listRunsForItem(handle.db, other.id).some((run) => run.interruption === "limit")).toBe(true), SLOW_RUNNER);
    await vi.waitFor(() => expect(waitingSaid().some((text) => text.includes("Lee's backend cannot run here right now"))).toBe(true), SLOW_RUNNER);
    expect(started).toEqual([]);
    expect(notes().some((body) => body.startsWith(runtimeLimitHoldPrefix(backend)))).toBe(true);
    expect(messagesFrom(handle.db, RUNTIME_LIMIT_SOURCE)).toHaveLength(1);
    expect(stepNow()).toBe("check");

    clock = START + HOUR + 1;
    await vi.waitFor(() => expect(stepNow()).toBe("accepted"), SLOW_RUNNER);
    expect(started.map((one) => one.agent)).toEqual(["Lee", "Sasha", "Tess", "Lee"]);
    expect(attempts().every((attempt) => attempt.status === "completed")).toBe(true);
  });
});
