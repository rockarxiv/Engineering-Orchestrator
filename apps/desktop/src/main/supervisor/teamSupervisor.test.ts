import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  evidenceBaselineOf,
  isMockedOutput,
  MOCKED_TEAM_NOTE,
  StepTeamSchema,
  TEAM_EVIDENCE_TOOLS,
  TEAM_PARTICIPANT_ACTION,
  uuidv7,
  type Agent,
  type AgentEvent,
  type AgentProvider,
  type AgentProviderStartOptions,
  type IndependentTeam,
  type Item,
  type Uuid,
} from "@eo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../db/client.js";
import { saveActionDefinition } from "../db/repos/actionDefinitionsRepo.js";
import { createAgent } from "../db/repos/agentsRepo.js";
import { insertAttachments } from "../db/repos/attachmentsRepo.js";
import { listCommentsForItem } from "../db/repos/commentsRepo.js";
import { createRoute } from "../db/repos/index.js";
import { getItem } from "../db/repos/itemsRepo.js";
import { createStep } from "../db/repos/pipelineStepsRepo.js";
import { createRun, getRun, listRunsForItem, sumCostCentsForItem } from "../db/repos/runsRepo.js";
import {
  acceptTeamReport,
  currentTeamSession,
  endTeamSession,
  listTeamSessionsForItem,
  openTeamSession,
  startTeamAttempt,
} from "../db/repos/teamSessionsRepo.js";
import { listTransitionsForItem } from "../db/repos/transitionsRepo.js";
import { trialSpendCentsSince } from "../db/repos/trialLoopsRepo.js";
import { writeTrialPlan } from "../db/repos/trialsRepo.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { createRunSupervisor, type RunSupervisor } from "./runSupervisor.js";
import { taskContextOf } from "./teamEvidence.js";
import type { ReportOnlyProviderAnswer } from "./teamSupervisor.js";

/**
 * An independent team run as its step's run (EO-846), end to end through
 * the supervisor: participants on report-only providers scripted here,
 * the owner's own provider never started, and the one answer routed by
 * the ordinary path.
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
  createStep(handle.db, { id: "check", pipelineId: "default" as never, position: -3, name: "Alignment", type: "agent", ownerRole: "qa", entryAction: "alignment", team: value });
}

/** The raw connection, for writing a state a crash leaves behind. */
function client(): { prepare(source: string): { run(...args: unknown[]): unknown; get(...args: unknown[]): unknown } } {
  return (handle.db as unknown as { $client: ReturnType<typeof client> }).$client;
}

function setTeam(value: IndependentTeam): void {
  client().prepare("update pipeline_steps set team = ? where id = 'check'").run(JSON.stringify(value));
}

beforeEach(() => {
  handle = openMigratedTestDb();
  scratch = mkdtempSync(join(tmpdir(), "eo-team-supervisor-"));
  started = [];
  quinn = createAgent(handle.db, { name: "Quinn", role: "qa", provider: "claude", instructions: "You check work." });
  createAgent(handle.db, { name: "Sasha", role: "sec", provider: "claude", instructions: "You find ways in." });
  createAgent(handle.db, { name: "Tess", role: "tester", provider: "claude", instructions: "You read tests." });
  stepWithTeam(team());
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
});

afterEach(async () => {
  for (const made of supervisors.splice(0)) await made.shutdown();
  handle.close();
  rmSync(scratch, { recursive: true, force: true });
});

// ── Scripted participants ────────────────────────────────────────────

function gate(): { wait: Promise<void>; open: () => void } {
  let open = (): void => undefined;
  const wait = new Promise<void>((resolve) => (open = resolve));
  return { wait, open };
}

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

function attach(name: string, content: string, onItem: Item = item): void {
  const path = join(scratch, `${uuidv7()}-${name}`);
  writeFileSync(path, content);
  insertAttachments(handle.db, [{ id: uuidv7() as Uuid, itemId: onItem.id, commentId: null, storagePath: path, name, mimeType: "text/plain", size: content.length }]);
}

/** The baseline the supervisor captures for an item with no disk and no attachments. */
const nothingCaptured = () => evidenceBaselineOf({ version: 1, capturedAt: 1, workspaceKind: "none", source: { kind: "none" }, attachments: [], task: taskContextOf(getItem(handle.db, item.id)!) });

/** The participants' reports: agents' comments other than the summary the step's owner is credited with. */
const reportsOn = (id: string) => listCommentsForItem(handle.db, id as Uuid).filter((comment) => comment.authorType === "agent" && comment.authorId !== quinn.id);
/** The team's answer, posted as the step owner's own summary by the ordinary path. */
const summary = () => listCommentsForItem(handle.db, item.id).find((comment) => comment.authorType === "agent" && comment.authorId === quinn.id);
const participantRuns = () => listRunsForItem(handle.db, item.id).filter((run) => run.action === TEAM_PARTICIPANT_ACTION);
const teamRun = () => listRunsForItem(handle.db, item.id).filter((run) => run.action === "alignment");

describe("an independent team on an agent step (EO-846)", () => {
  it("runs two participants at once inside the item's one slot, and leaves other items to the ordinary caps", async () => {
    const other = createTestItem(handle.db, { type: "story", title: "Another check", stepId: "check" });
    const release = gate();
    script = ({ agent }) =>
      (async function* () {
        yield { type: "thread_started", threadId: `t-${agent.name}` } as AgentEvent;
        await release.wait;
        yield { type: "result", data: { outcome: "clear", report: `${agent.name} found nothing.` } } as AgentEvent;
      })();
    const engine = supervisor();
    const done = engine.runOnce();

    await vi.waitFor(() => expect(started.map((one) => one.agent).sort()).toEqual(["Sasha", "Tess"]));
    // Two provider turns: the team's own run is waiting, and is not one.
    expect(engine.activeRunCount()).toBe(2);
    // One item's run in flight, the team's; the other item waits on the global cap of one.
    expect(listRunsForItem(handle.db, other.id)).toEqual([]);
    expect(teamRun()).toHaveLength(1);
    expect(participantRuns().every((run) => run.status === "running")).toBe(true);

    release.open();
    await done;

    expect(getItem(handle.db, item.id)?.stepId).toBe("accepted");
    expect(teamRun()[0]?.status).toBe("succeeded");
    expect(teamRun()[0]?.costCents ?? 0).toBe(0);
    expect(reportsOn(item.id).map((comment) => comment.body.split("\n")[0])).toEqual(expect.arrayContaining(["**security** — Nothing found", "**tests** — Nothing found"]));
    expect(listTeamSessionsForItem(handle.db, item.id).map((record) => record.session.status)).toEqual(["finalized"]);
    // Each participant ran once: the team's own notes and reports moved no evidence.
    expect(started).toHaveLength(2);
  });

  it("waits for a machine slot rather than deadlocking, and says why", async () => {
    script = ({ agent }) => answer("clear", `${agent.name} found nothing.`);
    await supervisor({ teamParticipantLimit: 1 }).runOnce();
    expect(getItem(handle.db, item.id)?.stepId).toBe("accepted");
    expect(listCommentsForItem(handle.db, item.id).some((comment) => comment.body.includes("**tests** is waiting to start: every participant slot on this machine is in use"))).toBe(true);
    expect(started.map((one) => one.agent)).toEqual(["Sasha", "Tess"]);
  });

  it("does not let its waiting run hold the slot a participant of the same agent needs", async () => {
    // The owner's role staffs a participant too: the same agent, at a per-agent cap of one.
    setTeam(team({ participants: [{ key: "self", role: "qa", instructions: "Check it yourself." }] }));
    script = () => answer("clear", "Quinn found nothing.");
    await supervisor().runOnce();
    expect(started.map((one) => one.agent)).toEqual(["Quinn"]);
    expect(getItem(handle.db, item.id)?.stepId).toBe("accepted");
    void quinn;
  });

  it("selects the configured result for a completed negative finding, and hands each turn the team's schema and a directory of its own", async () => {
    script = ({ agent }) => (agent.name === "Sasha" ? answer("blocking", "The export leaks tokens.") : answer("clear", "Tests are fine."));
    await supervisor().runOnce();
    expect(getItem(handle.db, item.id)?.stepId).toBe("rework");
    const output = summary();
    expect(output?.body).toContain('The team\'s result is "gaps_found", by completion rule 1.');
    expect(output?.body).toContain("The export leaks tokens.");
    // The report, or questions for the person, offered under `outcome` as every agent's answer is (EO-847).
    const schema = started[0]?.opts.outputSchema as { properties: { outcome: { anyOf: { properties?: { outcome?: { enum: string[] }; status?: unknown }; required?: string[] }[] } } };
    const report = schema.properties.outcome.anyOf.find((branch) => branch.properties?.outcome !== undefined);
    expect(report?.properties?.outcome?.enum).toEqual(["clear", "blocking"]);
    expect(report?.required).toEqual(["outcome", "report"]);
    expect(schema.properties.outcome.anyOf.some((branch) => branch.properties?.status !== undefined)).toBe(true);
    expect(started[0]?.opts.cwd).toBe(join(scratch, started[0]!.attemptId));
    expect(started[0]?.opts.context).toContain("## Your assignment: security");
  });

  it("hands each turn a report-only credential for its own attempt, answered from that attempt's scope alone and only while it runs", async () => {
    const seen: string[] = [];
    let engine: RunSupervisor | null = null;
    script = ({ attemptId }) =>
      (async function* () {
        yield { type: "thread_started", threadId: `t-${attemptId}` } as AgentEvent;
        const own = await engine!.handleAgentWrite(item.id, { tool: "item_context", args: {} }, [...TEAM_EVIDENCE_TOOLS], attemptId);
        seen.push(own.ok ? own.text : own.problem);
        yield { type: "result", data: { outcome: "clear", report: "Read it." } } as AgentEvent;
      })();
    engine = supervisor({
      agentWriteBridge: () => ({ tokenFor: (itemId, writes, scope) => ({ url: "http://bridge.invalid", token: `${itemId}:${scope ?? ""}`, ...(writes ? { writes: [...writes] } : {}) }) }),
    });
    await engine.runOnce();

    expect(started).toHaveLength(2);
    for (const one of started) {
      expect(one.opts.writeBridge).toMatchObject({ reportOnly: true, token: `${item.id}:${one.attemptId}`, writes: [...TEAM_EVIDENCE_TOOLS] });
    }
    expect(seen).toHaveLength(2);
    for (const text of seen) expect(text).toContain("# EO-1 — Check the export");
    const after = await engine.handleAgentWrite(item.id, { tool: "item_context", args: {} }, [...TEAM_EVIDENCE_TOOLS], started[0]!.attemptId);
    expect(after).toMatchObject({ ok: false, code: "NO_RUN" });
  });

  it("retries a crashed participant within its limit, keeping the report that completed", async () => {
    let testsTurns = 0;
    script = ({ agent }) => {
      if (agent.name === "Sasha") return answer("clear", "Nothing to see.");
      testsTurns += 1;
      return testsTurns === 1
        ? (async function* () {
            yield { type: "error", message: "The backend crashed.", retryable: true } as AgentEvent;
          })()
        : answer("clear", "Tests pass.");
    };
    await supervisor().runOnce();
    expect(getItem(handle.db, item.id)?.stepId).toBe("accepted");
    expect(started.filter((one) => one.agent === "Sasha")).toHaveLength(1);
    expect(testsTurns).toBe(2);
    expect(reportsOn(item.id).filter((comment) => comment.body.startsWith("**security**"))).toHaveLength(1);
    const attempts = listTeamSessionsForItem(handle.db, item.id)[0]!.attempts;
    expect(attempts.filter((attempt) => attempt.assignmentKey === "tests").map((attempt) => attempt.status)).toEqual(["failed", "completed"]);
  });

  it("parks rather than reading a required participant that keeps crashing as a finding or a success", async () => {
    script = ({ agent }) =>
      agent.name === "Sasha"
        ? answer("clear", "Nothing to see.")
        : (async function* () {
            yield { type: "thread_started", threadId: `t-${uuidv7()}` } as AgentEvent;
            // Ends with no answer at all.
          })();
    await supervisor().runOnce();
    expect(getItem(handle.db, item.id)?.stepId).toBe("check");
    expect(started.filter((one) => one.agent === "Tess")).toHaveLength(2); // the first and its one retry
    expect(teamRun()[0]?.status).toBe("awaiting_input");
    const escalation = listCommentsForItem(handle.db, item.id).at(-1);
    expect(escalation?.body).toContain("could not decide");
    expect(escalation?.body).toContain("**tests**");
    expect(listTeamSessionsForItem(handle.db, item.id)[0]?.session.status).toBe("failed");
    expect(listTransitionsForItem(handle.db, item.id)).toEqual([]);
  });

  it("shares the budget between turns running at once and keeps every cent spent when it is stopped", async () => {
    const engine = supervisor({ guards: { perItemBudgetCents: 100 } });
    // Each reports 10¢ more as it winds down after the stop, and an answer EO must not take.
    script = ({ opts }) => until(opts.signal, 30, 10);
    const done = engine.runOnce();
    await vi.waitFor(() => expect(participantRuns().filter((run) => (run.costCents ?? 0) === 30)).toHaveLength(2));
    const shares = started.map((one) => one.opts.budgetCents ?? Number.POSITIVE_INFINITY);
    expect(shares).toEqual([50, 50]);
    expect(shares.reduce((sum, share) => sum + share, 0)).toBeLessThanOrEqual(100);

    engine.cancelRun(teamRun()[0]!.id);
    await done;
    expect(participantRuns().map((run) => run.status)).toEqual(["cancelled", "cancelled"]);
    expect(participantRuns().map((run) => run.costCents)).toEqual([40, 40]);
    expect(sumCostCentsForItem(handle.db, item.id)).toBe(80);
    expect(reportsOn(item.id)).toEqual([]);
    expect(getItem(handle.db, item.id)?.stepId).toBe("check");
  });

  it("stops a participant at its share, not at what the item has left", async () => {
    const engine = supervisor({ guards: { perItemBudgetCents: 40 } });
    // Stopped by EO at its share, it still reports 3¢ more on the way out.
    script = ({ agent, opts }) => (agent.name === "Sasha" ? until(opts.signal, 25, 3) : answer("clear", "Fine.", 5));
    await engine.runOnce();
    const sasha = listTeamSessionsForItem(handle.db, item.id)[0]!.attempts.filter((attempt) => attempt.assignmentKey === "security");
    expect(sasha[0]?.status).toBe("failed");
    expect(sasha[0]?.error).toContain("share of the budget (20¢)");
    expect(getRun(handle.db, sasha[0]!.runId as Uuid)?.costCents).toBe(28);
    expect(sasha[0]?.outcome).toBeNull();
  });

  it("holds each item's budget only against its own team's turns, and the day's against every team's", async () => {
    const second = createTestItem(handle.db, { type: "story", title: "Check the import", stepId: "check" });
    const wide = { globalConcurrency: 2, perAgentConcurrency: 4, perRepositoryConcurrency: 2 };
    script = ({ opts }) => until(opts.signal, 1);

    // Separate item budgets and no daily one: neither team's turns shrink the other's.
    const apart = supervisor({ limits: wide, guards: { perItemBudgetCents: 100 } });
    const both = apart.runOnce();
    await vi.waitFor(() => expect(started).toHaveLength(4));
    expect(started.map((one) => one.opts.budgetCents)).toEqual([50, 50, 50, 50]);
    for (const run of [...teamRun(), ...listRunsForItem(handle.db, second.id).filter((one) => one.action === "alignment")]) apart.cancelRun(run.id);
    await both;
    expect(listCommentsForItem(handle.db, second.id).some((comment) => comment.body.includes("no budget left"))).toBe(false);
  });

  it("shares a daily budget across teams, so the second waits for what the first holds rather than failing", async () => {
    const second = createTestItem(handle.db, { type: "story", title: "Check the import", stepId: "check" });
    const wide = { globalConcurrency: 2, perAgentConcurrency: 4, perRepositoryConcurrency: 2 };
    const release = gate();
    script = ({ agent, opts }) =>
      (async function* () {
        yield { type: "thread_started", threadId: `t-${uuidv7()}` } as AgentEvent;
        yield { type: "usage", scope: "turn", tokensIn: 10, tokensOut: 5, costCents: 10 } as AgentEvent;
        await release.wait;
        void opts;
        yield { type: "result", data: { outcome: "clear", report: `${agent.name} found nothing.` } } as AgentEvent;
      })();
    const engine = supervisor({ limits: wide, guards: { perItemBudgetCents: 100, dailyBudgetCents: 100 } });
    const done = engine.runOnce();
    await vi.waitFor(() => expect(started).toHaveLength(2));
    await vi.waitFor(() =>
      expect([item, second].some((one) => listCommentsForItem(handle.db, one.id).some((comment) => comment.body.includes("the budget left is held by participants still working")))).toBe(true),
    );
    // The first team's two turns hold the whole day between them; nothing else was started.
    expect(started.map((one) => one.opts.budgetCents)).toEqual([50, 50]);
    release.open();
    await done;
    // Once they finished, what they did not spend was shared out again: 100 - 20 spent, over two.
    expect(started.slice(2).map((one) => one.opts.budgetCents)).toEqual([40, 40]);
    expect(getItem(handle.db, item.id)?.stepId).toBe("accepted");
    expect(getItem(handle.db, second.id)?.stepId).toBe("accepted");
  });
});

describe("an independent team across a restart (EO-846)", () => {
  /** The team's own run, as a crash left it: running, no live process. */
  function crashedTeamRun(): Uuid {
    return createRun(handle.db, { itemId: item.id, agentId: quinn.id, action: "alignment", stepId: "check", status: "running", initiationId: `entered:${item.id}` }).id;
  }
  function participantRun(agentName: string): Uuid {
    return createRun(handle.db, { itemId: item.id, agentId: agentId(agentName), action: TEAM_PARTICIPANT_ACTION, stepId: "check", status: "running" }).id;
  }
  const agentId = (name: string) => (client().prepare("select id from agents where name = ?").get(name) as { id: Uuid }).id;

  beforeEach(() => {
    script = ({ agent }) => answer("clear", `${agent.name} looked again.`);
  });

  it("at assignment creation: begins the assignment afresh, once, and routes once", async () => {
    const parent = crashedTeamRun();
    const session = openTeamSession(handle.db, { itemId: item.id, stepId: "check", team: team(), runId: parent });
    const queued = startTeamAttempt(handle.db, { sessionId: session.id, assignmentKey: "security", role: "sec", agentId: agentId("Sasha"), instructions: "Look for ways in." });
    if (!queued.ok) throw new Error(queued.problem);

    const engine = supervisor();
    await engine.reconcile();
    await engine.runOnce();

    expect(getRun(handle.db, parent)?.status).toBe("cancelled");
    expect(listTransitionsForItem(handle.db, item.id)).toHaveLength(1);
    expect(getItem(handle.db, item.id)?.stepId).toBe("accepted");
    const attempts = listTeamSessionsForItem(handle.db, item.id)[0]!.attempts;
    expect(attempts.filter((attempt) => attempt.assignmentKey === "security").map((attempt) => attempt.status)).toEqual(["cancelled", "completed"]);
    expect(reportsOn(item.id)).toHaveLength(2);
  });

  it("at process startup: ends the turn nobody runs as EO stopping it, keeps the session and its entry, and replaces it", async () => {
    const parent = crashedTeamRun();
    const session = openTeamSession(handle.db, { itemId: item.id, stepId: "check", team: team(), runId: parent });
    const run = participantRun("Sasha");
    const attempt = startTeamAttempt(handle.db, { sessionId: session.id, assignmentKey: "security", role: "sec", agentId: agentId("Sasha"), instructions: "Look for ways in.", runId: run });
    if (!attempt.ok) throw new Error(attempt.problem);

    const engine = supervisor();
    await engine.reconcile();
    expect(getRun(handle.db, run)?.status).toBe("cancelled");
    expect(currentTeamSession(handle.db, item.id)?.id).toBe(session.id);
    await engine.runOnce();

    expect(listTransitionsForItem(handle.db, item.id)).toHaveLength(1);
    expect(getItem(handle.db, item.id)?.stepId).toBe("accepted");
    expect(listTeamSessionsForItem(handle.db, item.id)).toHaveLength(1);
    expect(started.map((one) => one.agent).sort()).toEqual(["Sasha", "Tess"]);
  });

  it("at report persistence: keeps the accepted report, posts it once, and runs only the assignment still missing", async () => {
    const parent = crashedTeamRun();
    const session = openTeamSession(handle.db, { itemId: item.id, stepId: "check", team: team(), runId: parent });
    // Captured from what this item holds — no disk, no attachments — as the supervisor would capture it again.
    const baseline = nothingCaptured();
    const reported = startTeamAttempt(handle.db, { sessionId: session.id, assignmentKey: "security", role: "sec", agentId: agentId("Sasha"), instructions: "Look for ways in.", runId: participantRun("Sasha"), evidenceBaseline: baseline });
    const working = startTeamAttempt(handle.db, { sessionId: session.id, assignmentKey: "tests", role: "tester", agentId: agentId("Tess"), instructions: "Check the tests.", runId: participantRun("Tess"), evidenceBaseline: baseline });
    if (!reported.ok || !working.ok) throw new Error("attempts");
    expect(acceptTeamReport(handle.db, { attemptId: reported.attempt.id, outcome: "blocking", report: "It leaks." }).ok).toBe(true);
    // Delivered again on the way back up: nothing posted twice.
    expect(acceptTeamReport(handle.db, { attemptId: reported.attempt.id, outcome: "blocking", report: "It leaks." })).toMatchObject({ ok: true, duplicate: true });

    const engine = supervisor();
    await engine.reconcile();
    await engine.runOnce();

    expect(started.map((one) => one.agent)).toEqual(["Tess"]);
    expect(reportsOn(item.id).filter((comment) => comment.body.startsWith("**security**"))).toHaveLength(1);
    expect(getItem(handle.db, item.id)?.stepId).toBe("rework");
    expect(listTransitionsForItem(handle.db, item.id)).toHaveLength(1);
  });

  /** A team that settled on "gaps_found", on the evidence as it stood, and EO stopped before the move. */
  function settledBeforeTheMove(): string {
    const parent = crashedTeamRun();
    const session = openTeamSession(handle.db, { itemId: item.id, stepId: "check", team: team(), runId: parent });
    for (const [key, role, name, outcome] of [
      ["security", "sec", "Sasha", "blocking"],
      ["tests", "tester", "Tess", "clear"],
    ] as const) {
      const made = startTeamAttempt(handle.db, { sessionId: session.id, assignmentKey: key, role, agentId: agentId(name), instructions: "…", runId: participantRun(name), evidenceBaseline: nothingCaptured() });
      if (!made.ok) throw new Error(made.problem);
      expect(acceptTeamReport(handle.db, { attemptId: made.attempt.id, outcome, report: `${name}: ${outcome}.` }).ok).toBe(true);
    }
    client().prepare("update runs set status = 'succeeded' where action = ?").run(TEAM_PARTICIPANT_ACTION);
    expect(endTeamSession(handle.db, { sessionId: session.id, status: "finalized", result: "gaps_found" }).ok).toBe(true);
    return session.id;
  }

  it("at final settlement: answers with the settled result again without running anyone, and moves the item once", async () => {
    settledBeforeTheMove();

    const engine = supervisor();
    await engine.reconcile();
    await engine.runOnce();
    await engine.runOnce();

    expect(started).toEqual([]);
    expect(getItem(handle.db, item.id)?.stepId).toBe("rework");
    expect(listTransitionsForItem(handle.db, item.id)).toHaveLength(1);
    expect(reportsOn(item.id)).toHaveLength(2);
  });

  it("at final settlement, on evidence that changed before the restart: does not route the stale result, and runs the team again on what is there", async () => {
    const settled = settledBeforeTheMove();
    attach("addendum.txt", "a person added this while EO was closed");

    const engine = supervisor();
    await engine.reconcile();
    await engine.runOnce();

    // The settled "gaps_found" was about a version that is gone; the new reports say clear.
    expect(started.map((one) => one.agent).sort()).toEqual(["Sasha", "Tess"]);
    expect(getItem(handle.db, item.id)?.stepId).toBe("accepted");
    expect(listTransitionsForItem(handle.db, item.id)).toHaveLength(1);
    expect(listCommentsForItem(handle.db, item.id).some((comment) => comment.body.includes("its result is not used"))).toBe(true);
    const sessions = listTeamSessionsForItem(handle.db, item.id).map((record) => record.session);
    expect(sessions.map((one) => [one.id === settled, one.status])).toEqual([
      [true, "finalized"],
      [false, "finalized"],
    ]);
  });
});

describe("stopping an independent team (EO-846)", () => {
  it("fences every participant when its run is cancelled, keeping the session to carry on", async () => {
    script = ({ opts }) => until(opts.signal);
    const engine = supervisor();
    const done = engine.runOnce();
    await vi.waitFor(() => expect(started).toHaveLength(2));
    engine.cancelRun(teamRun()[0]!.id);
    await done;
    expect(participantRuns().map((run) => run.status)).toEqual(["cancelled", "cancelled"]);
    const record = listTeamSessionsForItem(handle.db, item.id)[0]!;
    expect(record.attempts.map((attempt) => attempt.status)).toEqual(["cancelled", "cancelled"]);
    expect(engine.activeRunCount()).toBe(0);
    expect(listTransitionsForItem(handle.db, item.id)).toEqual([]);
  });

  it("stops every participant when EO shuts down", async () => {
    script = ({ opts }) => until(opts.signal);
    const engine = supervisor();
    void engine.runOnce();
    await vi.waitFor(() => expect(started).toHaveLength(2));
    await engine.shutdown();
    expect(participantRuns().map((run) => run.status)).toEqual(["cancelled", "cancelled"]);
    expect(listTransitionsForItem(handle.db, item.id)).toEqual([]);
  });

  it("starts no new participant while paused, and carries on when resumed", async () => {
    setTeam(team({ limits: { maxParallel: 1 } }));
    const first = gate();
    script = ({ agent }) =>
      agent.name === "Sasha"
        ? (async function* () {
            yield { type: "thread_started", threadId: "t-sasha" } as AgentEvent;
            await first.wait;
            yield { type: "result", data: { outcome: "clear", report: "Fine." } } as AgentEvent;
          })()
        : answer("clear", "Tests fine.");
    const engine = supervisor();
    const done = engine.runOnce();
    await vi.waitFor(() => expect(started).toHaveLength(1));
    engine.pause();
    first.open();
    await vi.waitFor(() => expect(listCommentsForItem(handle.db, item.id).some((comment) => comment.body.includes("EO is paused"))).toBe(true));
    expect(started).toHaveLength(1);
    engine.resume();
    await done;
    expect(started.map((one) => one.agent)).toEqual(["Sasha", "Tess"]);
    expect(getItem(handle.db, item.id)?.stepId).toBe("accepted");
  });

  it("lets no late answer complete a session that a newer one superseded", async () => {
    const release = gate();
    script = ({ agent }) =>
      (async function* () {
        yield { type: "thread_started", threadId: `t-${agent.name}` } as AgentEvent;
        await release.wait;
        yield { type: "result", data: { outcome: "clear", report: "Late." } } as AgentEvent;
      })();
    const engine = supervisor();
    const done = engine.runOnce();
    await vi.waitFor(() => expect(started).toHaveLength(2));
    const old = currentTeamSession(handle.db, item.id)!;
    openTeamSession(handle.db, { itemId: item.id, stepId: "check", team: team() });
    release.open();
    await done;
    expect(listTeamSessionsForItem(handle.db, item.id).find((record) => record.session.id === old.id)?.session.status).toBe("superseded");
    expect(reportsOn(item.id)).toEqual([]);
    expect(listTransitionsForItem(handle.db, item.id)).toEqual([]);
    expect(getItem(handle.db, item.id)?.stepId).toBe("check");
  });
});

describe("an independent team's evidence (EO-846)", () => {

  it("supersedes the work done on evidence that changed before it settled, and settles only on the new", async () => {
    attach("brief.txt", "first version");
    let changed = false;
    script = ({ agent }) =>
      (async function* () {
        yield* answer(changed ? "clear" : "blocking", `${agent.name} on the ${changed ? "new" : "old"} brief.`);
        if (!changed && agent.name === "Tess") {
          changed = true;
          attach("addendum.txt", "a person added this");
        }
      })();
    await supervisor().runOnce();
    expect(started).toHaveLength(4);
    expect(getItem(handle.db, item.id)?.stepId).toBe("accepted");
    const attempts = listTeamSessionsForItem(handle.db, item.id)[0]!.attempts;
    expect(attempts.filter((attempt) => attempt.supersededBy !== null)).toHaveLength(2);
    expect(summary()?.body).toContain("on the new brief");
  });

  it("settles nothing on evidence that will not hold still, past the team's retries", async () => {
    attach("brief.txt", "v0");
    let versions = 0;
    script = ({ agent }) =>
      (async function* () {
        yield* answer("clear", `${agent.name} read it.`);
        if (agent.name === "Tess") {
          versions += 1;
          attach(`brief-v${versions}.txt`, `v${versions}`);
        }
      })();
    await supervisor().runOnce();
    expect(getItem(handle.db, item.id)?.stepId).toBe("check");
    expect(teamRun()[0]?.status).toBe("awaiting_input");
    expect(listCommentsForItem(handle.db, item.id).at(-1)?.body).toContain("changed every time it was about to settle");
    expect(listTeamSessionsForItem(handle.db, item.id)[0]?.session.status).toBe("failed");
  });

  it("does not let its own reports and notes move the evidence", async () => {
    attach("brief.txt", "the only version");
    script = ({ agent }) => answer("clear", `${agent.name} read the brief.`);
    await supervisor().runOnce();
    expect(started).toHaveLength(2);
    expect(listTeamSessionsForItem(handle.db, item.id)[0]!.attempts.every((attempt) => attempt.supersededBy === null)).toBe(true);
  });
});

/**
 * A team on a trial (EO-848): planned real, its participants run on the
 * trial's own test item — every run, report and cent under the trial —
 * and planned mocked, nobody on it runs and the output says the team was
 * not tested, so a mocked team is never read as an exercised one.
 */
describe("a team on a trial item (EO-848)", () => {
  /** The board made a trial, and the item one of its test items. */
  function onTrial(): Item {
    client().prepare("update pipelines set trial_at = ?, trial_conversation_id = ? where id = 'default'").run(Date.now(), uuidv7());
    client().prepare("update items set trial_at = ? where id = ?").run(Date.now(), item.id);
    return getItem(handle.db, item.id)!;
  }

  it("runs a team planned real on the test item itself: its participants, reports and spending are the trial's", async () => {
    const trialItem = onTrial();
    const live = createTestItem(handle.db, { type: "story", title: "Live work", stepId: "accepted" });
    script = ({ agent }) => answer("clear", `${agent.name} found nothing.`, agent.name === "Sasha" ? 30 : 20);
    await supervisor().runOnce();

    expect(getItem(handle.db, trialItem.id)?.stepId).toBe("accepted");
    expect(started.map((one) => one.agent).sort()).toEqual(["Sasha", "Tess"]);
    // Every participant run is a row on the trial's test item, and nothing ran on live work.
    expect(participantRuns()).toHaveLength(2);
    expect(participantRuns().every((run) => run.itemId === trialItem.id)).toBe(true);
    expect(listRunsForItem(handle.db, live.id)).toEqual([]);
    // Reports are on the test item's own thread.
    expect(reportsOn(trialItem.id)).toHaveLength(2);
    // What they spent is what the trial's budget counts.
    expect(trialSpendCentsSince(handle.db, "default", 0)).toBe(50);
    expect(listTeamSessionsForItem(handle.db, trialItem.id).map((record) => record.session.status)).toEqual(["finalized"]);
  });

  it("runs nobody for a team planned mocked, and marks its output as a mocked team that was not tested", async () => {
    const trialItem = onTrial();
    writeTrialPlan(handle.db, "default", { steps: [{ stepId: "check", mode: "mocked", mocks: [{ itemId: trialItem.id, resultKey: "aligned", output: "Looks aligned." }] }], expected: [] });
    script = () => {
      throw new Error("a mocked team must start no participant");
    };
    await supervisor().runOnce();

    expect(started).toEqual([]);
    expect(listRunsForItem(handle.db, trialItem.id)).toEqual([]);
    expect(listTeamSessionsForItem(handle.db, trialItem.id)).toEqual([]);
    const output = listCommentsForItem(handle.db, trialItem.id).find((comment) => comment.kind === "output");
    expect(output !== undefined && isMockedOutput(output)).toBe(true);
    expect(output?.body).toContain(MOCKED_TEAM_NOTE);
    expect(output?.body).toContain("Looks aligned.");
    expect(getItem(handle.db, trialItem.id)?.stepId).toBe("accepted");
  });
});
