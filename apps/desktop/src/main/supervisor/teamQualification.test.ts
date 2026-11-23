import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decideIndependentTeam,
  LEADER_ASSIGNMENT_KEY,
  storedTeam,
  TEAM_PARTICIPANT_ACTION,
  uuidv7,
  type Agent,
  type AgentEvent,
  type AgentProvider,
  type AgentProviderStartOptions,
  type IndependentTeam,
  type Item,
  type TeamAttemptRow,
  type TeamContribution,
  type Uuid,
} from "@eo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../db/client.js";
import { listAgents, updateAgent } from "../db/repos/agentsRepo.js";
import { insertAttachments } from "../db/repos/attachmentsRepo.js";
import { listCommentsForItem, postComment } from "../db/repos/commentsRepo.js";
import { getItem } from "../db/repos/itemsRepo.js";
import { grantLease, leaseFor, releaseLease } from "../db/repos/leasesRepo.js";
import { getPipeline, getStep, listPipelineSteps, listRoutesForPipeline, listStepsForPipeline } from "../db/repos/pipelineStepsRepo.js";
import { createRun, getRun, listRunsForItem, sumCostCentsForItem, updateRun } from "../db/repos/runsRepo.js";
import { acceptTeamReport, endTeamSession, listTeamSessionsForItem, openTeamSession, startTeamAttempt } from "../db/repos/teamSessionsRepo.js";
import { listTransitionsForItem } from "../db/repos/transitionsRepo.js";
import { createTestItem, openMigratedTestDb, stepSessionTeam } from "../db/testHelpers.js";
import { storedGraphProblems } from "../ipc/configCommands.js";
import { importPipeline, parseExport } from "../modules/pipelineTransfer.js";
import { createRunSupervisor, type RunSupervisor } from "./runSupervisor.js";
import { captureTeamEvidence } from "./teamEvidence.js";
import { evidenceContentKey, type ReportOnlyProviderAnswer } from "./teamSupervisor.js";

/**
 * Report-only teams qualified end to end (EO-850).
 *
 * The two example pipelines in `docs/examples/teams/` are imported here as
 * a person would import them — they are files, opt-in, and nothing seeds
 * them — and run through the supervisor with every participant on a
 * scripted report-only provider. Neither example has a repository: their
 * evidence is the item's own text and its attachments, so nothing here
 * leans on the developer pack.
 *
 * Every scenario ends in `qualifies`, which checks the same five things of
 * whatever happened: execution stayed inside the team's declared limits;
 * every cent a turn reported is on its run and counted once for the item;
 * no report was accepted twice; nothing the session settled on was made
 * against evidence that has since moved; and the item moved at most once
 * per settled session, to the step its result routes to.
 *
 * Mocked here: the backends. What the real Claude and Codex CLIs refuse is
 * proved separately, by `providerParity.test.ts` against both adapters and
 * by the opt-in live probes `reportOnlyClaude.live.test.ts` and
 * `reportOnlyCodex.live.test.ts` (docs/teams.md, "What has been proved").
 */

const EXAMPLES = new URL("../../../../../docs/examples/teams/", import.meta.url);
const ROOMY = { globalConcurrency: 1, perAgentConcurrency: 2, perRepositoryConcurrency: 1 };

type Backend = "claude" | "codex";
/** Which backend each role's agent runs on: the same rules must hold on either, and on a team mixing them. */
interface Roster {
  name: string;
  backendOf: (role: string) => Backend;
}
const ROSTERS: Roster[] = [
  { name: "every member on Claude", backendOf: () => "claude" },
  { name: "every member on Codex", backendOf: () => "codex" },
  { name: "members on both backends", backendOf: (role) => (["fact_checker", "copy_editor", "incident_lead", "customer_liaison"].includes(role) ? "codex" : "claude") },
];

/** The step's owner is never asked anything: the team answers for it. */
const ownerProvider: AgentProvider = {
  start: () => {
    throw new Error("The owner's own provider was started.");
  },
  resume: () => {
    throw new Error("The owner's own provider was resumed.");
  },
};

type Turn = (call: { agent: Agent; attemptId: string; opts: AgentProviderStartOptions; nth: number }) => AsyncIterable<AgentEvent>;

interface Started {
  role: string;
  provider: string;
  attemptId: string;
  opts: AgentProviderStartOptions;
}

let handle: DbHandle;
let scratch: string;
let started: Started[];
/** What each role answers; a function of how many turns that role has had. */
let turns: Record<string, Turn>;
/** Turns between their first event and their end, now and at most. */
let inFlight: number;
let peak: number;
/** Every cent each turn reported, by attempt, stopped turns included. */
let reported: Map<string, number>;
const supervisors: RunSupervisor[] = [];

function reportOnlyProvider(agent: Agent, attemptId: string): ReportOnlyProviderAnswer {
  return {
    ok: true,
    cwd: join(scratch, attemptId),
    provider: {
      start: (opts) => {
        started.push({ role: agent.role, provider: agent.provider, attemptId, opts });
        const turn = turns[agent.role];
        if (turn === undefined) throw new Error(`Nothing scripted for ${agent.role}.`);
        const nth = started.filter((one) => one.role === agent.role).length;
        return counted(attemptId, turn({ agent, attemptId, opts, nth }))[Symbol.asyncIterator]() as unknown as ReturnType<AgentProvider["start"]>;
      },
    },
  };
}

/** A turn, counted while it runs and for what it reports spending. */
async function* counted(attemptId: string, events: AsyncIterable<AgentEvent>): AsyncGenerator<AgentEvent> {
  inFlight += 1;
  peak = Math.max(peak, inFlight);
  try {
    for await (const event of events) {
      if (event.type === "usage") reported.set(attemptId, (reported.get(attemptId) ?? 0) + (event.costCents ?? 0));
      yield event;
    }
  } finally {
    inFlight -= 1;
  }
}

function supervisor(extra: Partial<Parameters<typeof createRunSupervisor>[0]> = {}): RunSupervisor {
  const made = createRunSupervisor({ db: handle.db, provider: ownerProvider, limits: ROOMY, reportOnlyProvider, teamPollMs: 5, ...extra });
  supervisors.push(made);
  return made;
}

/** Imports an example as a person would, and staffs its roles on the roster's backends. */
function importExample(name: string, roster: Roster): Record<string, string> {
  const parsed = parseExport(readFileSync(new URL(`${name}.json`, EXAMPLES), "utf8"));
  if (!parsed.ok) throw new Error(parsed.reason);
  const imported = importPipeline(handle.db, { document: parsed.document, signedInBackends: ["claude", "codex"] });
  if (!imported.ok) throw new Error(imported.reason);
  for (const agent of listAgents(handle.db)) {
    if (agent.provider !== "claude") continue;
    const backend = roster.backendOf(agent.role);
    if (backend === "codex") updateAgent(handle.db, agent.id, { provider: "codex", model: "gpt-participant" });
  }
  return imported.stepIds;
}

function setup(): void {
  handle = openMigratedTestDb();
  scratch = mkdtempSync(join(tmpdir(), "eo-team-qualification-"));
  started = [];
  turns = {};
  inFlight = 0;
  peak = 0;
  reported = new Map();
}

afterEach(async () => {
  for (const made of supervisors.splice(0)) await made.shutdown();
  handle.close();
  rmSync(scratch, { recursive: true, force: true });
});

// ── Scripted turns ───────────────────────────────────────────────────

function says(data: unknown, cents = 1): AsyncGenerator<AgentEvent> {
  return (async function* () {
    yield { type: "thread_started", threadId: `thread-${uuidv7()}` } as AgentEvent;
    if (cents > 0) yield { type: "usage", scope: "turn", tokensIn: 100, tokensOut: 50, costCents: cents } as AgentEvent;
    yield { type: "result", data } as AgentEvent;
  })();
}

/** A turn that spends, then works until it is stopped, and reports a little more on its way out. */
function untilStopped(signal: AbortSignal, cents: number, afterStop = 0): AsyncGenerator<AgentEvent> {
  return (async function* () {
    yield { type: "thread_started", threadId: `thread-${uuidv7()}` } as AgentEvent;
    yield { type: "usage", scope: "turn", tokensIn: 100, tokensOut: 50, costCents: cents } as AgentEvent;
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
    if (afterStop > 0) yield { type: "usage", scope: "turn", tokensIn: 10, tokensOut: 5, costCents: afterStop } as AgentEvent;
    // An answer EO must not take: the turn was stopped.
    yield { type: "result", data: { outcome: "ready", report: "Answered after it was stopped." } } as AgentEvent;
  })();
}

const verdict = (outcome: "ready" | "blocking", report: string) => ({ outcome, report });
const report = (text: string) => ({ outcome: { report: text } });
/**
 * A round of work as a leader asks for it: each assignment to the team
 * member by name (EO-882) — here the one agent of each kind the example's
 * import made, which is the member its declared team names.
 */
const assign = (assignments: { key: string; role: string; instructions: string; required?: boolean }[], note: string) => ({
  outcome: {
    decision: "assign",
    assignments: assignments.map(({ role, ...one }) => ({ required: true, scope: "the whole change", ...one, member: listAgents(handle.db).find((agent) => agent.role === role)!.name })),
    note,
  },
});
const final = (answer: { result: string; summary: string }, contributions: string[], disagreements = "None.", limitations = "Only the item and its attachments were read.") => ({
  outcome: { decision: "final", answer, contributions, disagreements, limitations },
});
const asks = (question: string) => ({ outcome: { status: "clarification_required", questions: [{ id: "q1", question, why: "It decides what to read." }] } });

// ── The item's material ──────────────────────────────────────────────

/** A file a person put on the item: the evidence a team reads in place of a repository. */
function attach(item: Item, name: string, content: string): void {
  const path = join(scratch, `${uuidv7()}-${name}`);
  writeFileSync(path, content);
  insertAttachments(handle.db, [{ id: uuidv7() as Uuid, itemId: item.id, commentId: null, storagePath: path, name, mimeType: "text/plain", size: content.length }]);
}

function draft(stepId: string, title = "Spring newsletter"): Item {
  const item = createTestItem(handle.db, { type: "draft", title, body: "Review the attached draft for the spring newsletter. House style: plain words, no exclamation marks.", stepId });
  attach(item, "draft.md", "# Spring newsletter\n\nMembership grew by 12% this quarter (source: membership report, March).");
  return item;
}

function incident(stepId: string): Item {
  const item = createTestItem(handle.db, { type: "incident", title: "Checkout errors on 3 March", body: "Customers reported failed payments between 14:00 and 14:40. Find out what happened and whether anything still needs doing.", stepId });
  attach(item, "timeline.log", "14:02 payment provider latency rises\n14:05 retries exhausted\n14:38 provider recovers");
  attach(item, "support-notes.txt", "41 customers wrote in. Three were charged twice.");
  return item;
}

/** The name of the step the item is on now. */
function stepNameOf(item: Item): string | undefined {
  const stepId = getItem(handle.db, item.id)?.stepId;
  return stepId ? getStep(handle.db, stepId)?.name : undefined;
}

// ── What every scenario must leave true ──────────────────────────────

const attemptsOf = (item: Item): TeamAttemptRow[] => listTeamSessionsForItem(handle.db, item.id).flatMap((record) => record.attempts);
const participantRunsOf = (item: Item) => listRunsForItem(handle.db, item.id).filter((run) => run.action === TEAM_PARTICIPANT_ACTION);
/** The current accepted report at an assignment of the item's newest session, by comment id. */
function currentReport(item: Item, key: string): string {
  const found = listTeamSessionsForItem(handle.db, item.id)
    .at(-1)
    ?.attempts.find((attempt) => attempt.assignmentKey === key && attempt.status === "completed" && attempt.supersededBy === null)?.reportCommentId;
  if (found === undefined || found === null) throw new Error(`No current report at ${key}.`);
  return found;
}

/** The item's evidence as it stands now, as the supervisor would capture it again. */
async function evidenceNow(item: Item): Promise<string> {
  const captured = await captureTeamEvidence({ db: handle.db, item: getItem(handle.db, item.id)!, workspace: null });
  if (!captured.ok) throw new Error(captured.problem);
  return evidenceContentKey(captured.evidence.baseline)!;
}

/** The contributions an independent session's current attempts make, as `decideIndependentTeam` takes them. */
function contributionsOf(attempts: readonly TeamAttemptRow[]): TeamContribution[] {
  return attempts
    .filter((attempt) => attempt.supersededBy === null && (attempt.status === "completed" || attempt.status === "failed"))
    .map((attempt): TeamContribution =>
      attempt.status === "completed"
        ? { key: attempt.assignmentKey, status: "completed", outcome: attempt.outcome!, report: listCommentsForItem(handle.db, attempt.itemId as Uuid).find((comment) => comment.id === attempt.reportCommentId)!.body }
        : { key: attempt.assignmentKey, status: "failed", error: attempt.error ?? "failed" },
    );
}

/**
 * The five things every scenario must leave true (EO-850): bounded
 * execution, spending and history kept, no report accepted twice, no
 * stale verdict, and at most one move per settled session — to where its
 * result routes.
 */
async function qualifies(item: Item): Promise<void> {
  const sessions = listTeamSessionsForItem(handle.db, item.id);
  const runs = participantRunsOf(item);
  const attempts = attemptsOf(item);
  const mine = started.filter((one) => attempts.some((attempt) => attempt.id === one.attemptId));
  const spent = mine.reduce((sum, one) => sum + (reported.get(one.attemptId) ?? 0), 0);

  // Bounded: never more turns at once than the team allows, and no
  // assignment retried past its limit (a turn EO stopped is replaced
  // without counting; one a person asked to retry is a marker).
  for (const { session, attempts } of sessions) {
    const team = session.team;
    expect(peak).toBeLessThanOrEqual(team.limits.maxParallel);
    const keys = new Set(attempts.filter((attempt) => attempt.assignmentKey !== LEADER_ASSIGNMENT_KEY).map((attempt) => attempt.assignmentKey));
    expect(keys.size).toBeLessThanOrEqual(team.coordination === "independent" ? team.participants.length : team.limits.maxParticipants);
    const rounds = new Map<string, number>();
    for (const attempt of attempts) {
      if (attempt.status === "cancelled" || attempt.supersededBy !== null) continue;
      const at = `${attempt.assignmentKey}#${attempt.round}`;
      rounds.set(at, (rounds.get(at) ?? 0) + 1);
    }
    const failedAt = new Map<string, number>();
    for (const attempt of attempts.filter((one) => one.status === "failed")) {
      const at = `${attempt.assignmentKey}#${attempt.round}`;
      failedAt.set(at, (failedAt.get(at) ?? 0) + 1);
    }
    for (const failures of failedAt.values()) expect(failures).toBeLessThanOrEqual(team.limits.maxRetries + 1);
    if (team.coordination === "leader") expect(Math.max(0, ...attempts.map((attempt) => attempt.round))).toBeLessThanOrEqual(team.limits.maxRounds + 1);
  }

  // Spending and history: every turn started has its attempt and its run,
  // and every cent any turn reported is on a run, counted once.
  expect(runs).toHaveLength(mine.length);
  for (const one of mine) expect(attempts.some((attempt) => attempt.id === one.attemptId && attempt.runId !== null)).toBe(true);
  expect(runs.reduce((sum, run) => sum + (run.costCents ?? 0), 0)).toBe(spent);
  expect(sumCostCentsForItem(handle.db, item.id)).toBe(spent);
  for (const run of listRunsForItem(handle.db, item.id).filter((one) => one.action !== TEAM_PARTICIPANT_ACTION)) expect(run.costCents ?? 0).toBe(0);

  // No report accepted twice: each accepted attempt names its own comment, and the thread holds it once.
  const reportIds = attemptsOf(item).flatMap((attempt) => (attempt.reportCommentId === null ? [] : [attempt.reportCommentId]));
  expect(new Set(reportIds).size).toBe(reportIds.length);
  const thread = listCommentsForItem(handle.db, item.id);
  for (const id of reportIds) expect(thread.filter((comment) => comment.id === id)).toHaveLength(1);
  const accepted = attemptsOf(item).filter((attempt) => attempt.reportCommentId !== null);
  for (const attempt of accepted) {
    const comment = thread.find((one) => one.id === attempt.reportCommentId)!;
    expect(comment.authorId).toBe(attempt.agentId);
    expect(comment.runId).toBe(attempt.runId);
  }

  // At most one move per settled session, and only a settled session moves the item.
  const moves = listTransitionsForItem(handle.db, item.id);
  const settled = sessions.filter(({ session }) => session.status === "finalized");
  expect(moves.length).toBeLessThanOrEqual(settled.length);
  if (moves.length === 0) return;

  // The move went where the settled result routes, and that result is what the accepted reports decide.
  const last = settled.at(-1)!;
  const move = moves.at(-1)!;
  const route = listRoutesForPipeline(handle.db, getStep(handle.db, last.session.stepId)!.pipelineId).find((one) => one.fromStepId === last.session.stepId && one.resultKey === last.session.result);
  expect(route?.target).toBe(move.toStepId);
  const current = last.attempts.filter((attempt) => attempt.supersededBy === null);
  const now = await evidenceNow(item);
  if (last.session.team.coordination === "independent") {
    const decided = decideIndependentTeam(last.session.team as IndependentTeam, contributionsOf(current));
    expect(decided).toMatchObject({ status: "decided", result: last.session.result });
    // No stale verdict: every report it was decided from was made on the evidence as it stands.
    for (const attempt of current.filter((one) => one.status === "completed")) expect(evidenceContentKey(attempt.evidenceBaseline)).toBe(now);
  } else {
    const leaderTurn = last.attempts.filter((attempt) => attempt.assignmentKey === LEADER_ASSIGNMENT_KEY && attempt.status === "completed").at(-1)!;
    const result = getRun(handle.db, leaderTurn.runId as Uuid)?.result as { answer: { outcome?: { answer: { result: string }; contributions: string[] } }; verdict: { contributions: string[] } } | undefined;
    const answer = result!.answer.outcome!;
    expect(answer.answer.result).toBe(last.session.result);
    // It relied only on reports that are current, and on every one a required assignment owes.
    const currentReports = new Set(current.flatMap((attempt) => (attempt.status === "completed" && attempt.reportCommentId !== null && attempt.assignmentKey !== LEADER_ASSIGNMENT_KEY ? [attempt.reportCommentId] : [])));
    for (const id of answer.contributions) expect(currentReports.has(id)).toBe(true);
    expect(evidenceContentKey(leaderTurn.evidenceBaseline)).toBe(now);
    for (const attempt of current.filter((one) => one.reportCommentId !== null && answer.contributions.includes(one.reportCommentId))) expect(evidenceContentKey(attempt.evidenceBaseline)).toBe(now);
  }
}

// ── The examples, end to end, on either backend and on both ──────────

describe.each(ROSTERS)("the publication review example, an independent specialist assessment, with $name", (roster) => {
  let review: string;
  beforeEach(() => {
    setup();
    review = importExample("publication-review", roster).review!;
  });

  it("publishes when every specialist finds the draft ready, routed from their accepted reports", async () => {
    turns = {
      fact_checker: () => says(verdict("ready", "The 12% figure matches the March membership report.")),
      counsel: () => says(verdict("ready", "Nothing defamatory, confidential or unlicensed.")),
      copy_editor: () => says(verdict("ready", "Plain words throughout.")),
    };
    const item = draft(review);
    await supervisor().runOnce();

    expect(stepNameOf(item)).toBe("Ready to publish");
    expect(new Set(started.map((one) => `${one.role}:${one.provider}`))).toEqual(new Set(["fact_checker", "counsel", "copy_editor"].map((role) => `${role}:${roster.backendOf(role)}`)));
    expect(listTeamSessionsForItem(handle.db, item.id).map((record) => [record.session.status, record.session.result])).toEqual([["finalized", "ready_to_publish"]]);
    await qualifies(item);
  });

  it("must send the draft back when one specialist finds something that must change, whatever the others say", async () => {
    turns = {
      fact_checker: () => says(verdict("blocking", "The 12% figure is 9% in the March membership report.")),
      counsel: () => says(verdict("ready", "Nothing defamatory, confidential or unlicensed.")),
      copy_editor: () => says(verdict("ready", "Plain words throughout.")),
    };
    const item = draft(review);
    await supervisor().runOnce();

    expect(stepNameOf(item)).toBe("Revise");
    expect(listTeamSessionsForItem(handle.db, item.id)[0]?.session.result).toBe("needs_revision");
    const summary = listCommentsForItem(handle.db, item.id).find((comment) => comment.kind === "output" || comment.body.startsWith("The team's result"));
    expect(summary?.body).toContain("The 12% figure is 9%");
    await qualifies(item);
  });
});

describe.each(ROSTERS)("the incident investigation example, a leader-led team, with $name", (roster) => {
  let investigate: string;
  beforeEach(() => {
    setup();
    investigate = importExample("incident-investigation", roster).investigate!;
  });

  it("adapts its assignments, follows up where a report falls short, and routes the answer it can support from current reports", async () => {
    const item = incident(investigate);
    let earlierTimeline = "";
    const leader: Turn = ({ opts, nth }) => {
      if (nth === 1) {
        return says(
          assign(
            [
              { key: "timeline", role: "log_analyst", instructions: "Read timeline.log and say when the failures began and ended, and why." },
              { key: "customers", role: "customer_liaison", instructions: "Read support-notes.txt and say who was affected and how." },
            ],
            "Two questions to start with.",
          ),
        );
      }
      if (nth === 2) {
        expect(opts.context).toContain("Three were charged twice.");
        earlierTimeline = currentReport(item, "timeline");
        // Adaptive follow-up: the timeline report does not say whether the double charges were refunded.
        return says(assign([{ key: "timeline", role: "log_analyst", instructions: "You did not say whether the retries charged anyone twice. Look again at 14:05." }], "Follow-up on the retries."));
      }
      expect(opts.context).toContain("The 14:05 retries charged three customers twice; no refund is logged.");
      return says(
        final({ result: "action_needed", summary: "The provider's latency exhausted retries; three customers were charged twice and need refunds." }, [currentReport(item, "timeline"), currentReport(item, "customers")], "None: the log and the support notes agree."),
      );
    };
    turns = {
      incident_lead: leader,
      log_analyst: ({ nth, opts }) => {
        if (nth === 2) {
          expect(opts.context).toContain("You did not say whether the retries charged anyone twice.");
          return says(report("The 14:05 retries charged three customers twice; no refund is logged."));
        }
        return says(report("Failures ran 14:02–14:38: provider latency exhausted retries at 14:05."));
      },
      customer_liaison: () => says(report("41 customers wrote in. Three were charged twice.")),
    };
    await supervisor().runOnce();

    expect(stepNameOf(item)).toBe("Act on findings");
    const record = listTeamSessionsForItem(handle.db, item.id)[0]!;
    expect(record.session.result).toBe("action_needed");
    const timeline = record.attempts.filter((attempt) => attempt.assignmentKey === "timeline");
    expect(timeline.map((attempt) => [attempt.round, attempt.supersededBy !== null])).toEqual([
      [1, true],
      [2, false],
    ]);
    // The superseded report is kept on the thread, and was not what the answer relied on.
    expect(listCommentsForItem(handle.db, item.id).some((comment) => comment.id === earlierTimeline)).toBe(true);
    expect(new Set(started.map((one) => `${one.role}:${one.provider}`))).toEqual(new Set(["incident_lead", "log_analyst", "customer_liaison"].map((role) => `${role}:${roster.backendOf(role)}`)));
    await qualifies(item);
  });

  it("can find nothing left to do, and routes that too", async () => {
    const item = incident(investigate);
    turns = {
      incident_lead: ({ nth }) =>
        nth === 1
          ? says(assign([{ key: "timeline", role: "log_analyst", instructions: "Read timeline.log." }], "One question."))
          : says(final({ result: "explained", summary: "A provider outage; it recovered on its own." }, [currentReport(item, "timeline")])),
      log_analyst: () => says(report("A provider outage from 14:02 to 14:38; nothing else.")),
    };
    await supervisor().runOnce();
    expect(stepNameOf(item)).toBe("Closed");
    await qualifies(item);
  });
});

// ── The failure matrix ───────────────────────────────────────────────

/**
 * Each way a team's work can go wrong, on the examples with members on
 * both backends, each ending in the same five checks. What a scenario
 * adds is what is particular to it: that a failure was not read as a
 * finding, that what was accepted survived, that nothing moved.
 */
describe("the integrated failure matrix (EO-850)", () => {
  const MIXED = ROSTERS[2]!;
  let review: string;
  let investigate: string;
  beforeEach(() => {
    setup();
    review = importExample("publication-review", MIXED).review!;
    investigate = importExample("incident-investigation", MIXED).investigate!;
  });

  const reviewRun = (item: Item) => listRunsForItem(handle.db, item.id).find((run) => run.action === "assess");
  const attemptsAt = (item: Item, key: string) => attemptsOf(item).filter((attempt) => attempt.assignmentKey === key);
  const allReady = (): Record<string, Turn> => ({
    fact_checker: () => says(verdict("ready", "Every figure is sourced.")),
    counsel: () => says(verdict("ready", "No legal risk.")),
    copy_editor: () => says(verdict("ready", "In house style.")),
  });

  it("disagreement: a leader's answer accounts for contributors who disagree, and EO routes it only from current reports", async () => {
    const item = incident(investigate);
    turns = {
      incident_lead: ({ nth }) =>
        nth === 1
          ? says(assign([
              { key: "timeline", role: "log_analyst", instructions: "What caused the failures?" },
              { key: "customers", role: "customer_liaison", instructions: "What caused the failures, from what customers saw?" },
            ], "Ask both."))
          : says(final({ result: "action_needed", summary: "The cause is disputed; three double charges need refunds either way." }, [currentReport(item, "timeline"), currentReport(item, "customers")], "The log blames the provider; the support notes blame a deploy at 14:00.")),
      log_analyst: () => says(report("The payment provider's latency caused it.")),
      customer_liaison: () => says(report("Customers saw it start right after our 14:00 deploy.")),
    };
    await supervisor().runOnce();
    expect(stepNameOf(item)).toBe("Act on findings");
    expect(listCommentsForItem(handle.db, item.id).some((comment) => comment.body.includes("**Disagreements:** The log blames the provider"))).toBe(true);
    await qualifies(item);
  });

  it("malformed report: an answer EO cannot take is an execution failure, retried, and never read as a finding", async () => {
    const turnsFor = allReady();
    turns = { ...turnsFor, fact_checker: (call) => (call.nth === 1 ? says({ outcome: "probably fine", report: "" }) : says(verdict("blocking", "The 12% is unsourced."))) };
    const item = draft(review);
    await supervisor().runOnce();
    const accuracy = attemptsAt(item, "accuracy");
    expect(accuracy.map((attempt) => attempt.status)).toEqual(["failed", "completed"]);
    expect(accuracy[0]).toMatchObject({ outcome: null, reportCommentId: null });
    expect(accuracy[0]?.error).toContain("not a report EO could take");
    expect(stepNameOf(item)).toBe("Revise");
    await qualifies(item);
  });

  it("participant crash: a crash is retried within its limit; past it the team parks, keeps its accepted reports, and moves nothing", async () => {
    turns = {
      ...allReady(),
      counsel: () =>
        (async function* () {
          yield { type: "thread_started", threadId: `thread-${uuidv7()}` } as AgentEvent;
          yield { type: "usage", scope: "turn", tokensIn: 10, tokensOut: 5, costCents: 2 } as AgentEvent;
          throw new Error("The backend exited with code 1.");
        })(),
    };
    const item = draft(review);
    await supervisor().runOnce();
    expect(attemptsAt(item, "legal").map((attempt) => attempt.status)).toEqual(["failed", "failed"]);
    expect(reviewRun(item)?.status).toBe("awaiting_input");
    expect(listTeamSessionsForItem(handle.db, item.id)[0]?.session.status).toBe("open");
    expect(stepNameOf(item)).toBe("Specialist review");
    expect(listTransitionsForItem(handle.db, item.id)).toEqual([]);
    // Neither a finding nor a pass: the failure is said as one.
    expect(listCommentsForItem(handle.db, item.id).at(-1)?.body).toContain("could not decide");
    expect(attemptsAt(item, "accuracy")[0]?.reportCommentId).not.toBeNull();
    await qualifies(item);
  });

  it("lost provider thread: a turn whose backend lost its conversation is retried on a fresh thread of its own, never resumed", async () => {
    turns = {
      ...allReady(),
      copy_editor: ({ nth }) =>
        nth === 1
          ? (async function* () {
              yield { type: "thread_started", threadId: "thread-lost" } as AgentEvent;
              yield { type: "error", message: "No conversation found with session ID: thread-lost", retryable: true } as AgentEvent;
            })()
          : says(verdict("ready", "In house style.")),
    };
    const item = draft(review);
    await supervisor().runOnce();
    const style = attemptsAt(item, "style");
    expect(style.map((attempt) => attempt.status)).toEqual(["failed", "completed"]);
    const threads = style.map((attempt) => getRun(handle.db, attempt.runId as Uuid)?.threadId);
    expect(threads[0]).toBe("thread-lost");
    expect(threads[1]).not.toBe("thread-lost");
    expect(started.filter((one) => one.role === "copy_editor").every((one) => one.opts.cwd === join(scratch, one.attemptId))).toBe(true);
    expect(stepNameOf(item)).toBe("Ready to publish");
    await qualifies(item);
  });

  it("restart during finalization: a session settled before EO stopped answers again without running anyone, and moves the item once", async () => {
    const item = draft(review);
    const owner = listAgents(handle.db).find((agent) => agent.role === "editor")!;
    const parent = createRun(handle.db, { itemId: item.id, agentId: owner.id, action: "assess", stepId: review, status: "running", initiationId: `entered:${item.id}` }).id;
    const session = openTeamSession(handle.db, { itemId: item.id, stepId: review, team: stepSessionTeam(handle.db, review), runId: parent });
    const captured = await captureTeamEvidence({ db: handle.db, item, workspace: null });
    if (!captured.ok) throw new Error(captured.problem);
    for (const [key, role, outcome] of [
      ["accuracy", "fact_checker", "blocking"],
      ["legal", "counsel", "ready"],
      ["style", "copy_editor", "ready"],
    ] as const) {
      const agent = listAgents(handle.db).find((one) => one.role === role)!;
      const run = createRun(handle.db, { itemId: item.id, agentId: agent.id, action: TEAM_PARTICIPANT_ACTION, stepId: review, status: "succeeded", provider: agent.provider });
      updateRun(handle.db, run.id, { costCents: 7 });
      const made = startTeamAttempt(handle.db, { sessionId: session.id, assignmentKey: key, role, agentId: agent.id, instructions: "…", runId: run.id, evidenceBaseline: captured.evidence.baseline });
      if (!made.ok) throw new Error(made.problem);
      expect(acceptTeamReport(handle.db, { attemptId: made.attempt.id, outcome, report: `${key}: ${outcome}.` }).ok).toBe(true);
      // The turns from before the restart, with what they spent.
      started.push({ role, provider: agent.provider, attemptId: made.attempt.id, opts: {} as AgentProviderStartOptions });
      reported.set(made.attempt.id, 7);
    }
    expect(endTeamSession(handle.db, { sessionId: session.id, status: "finalized", result: "needs_revision" }).ok).toBe(true);
    const before = started.length;

    const engine = supervisor();
    await engine.reconcile();
    await engine.runOnce();
    await engine.runOnce();

    expect(started).toHaveLength(before);
    expect(stepNameOf(item)).toBe("Revise");
    expect(listTransitionsForItem(handle.db, item.id)).toHaveLength(1);
    await qualifies(item);
  });

  it("duplicate delivery: a result delivered twice, by the backend or on the way back up, is one accepted report", async () => {
    turns = {
      ...allReady(),
      counsel: () =>
        (async function* () {
          yield { type: "thread_started", threadId: `thread-${uuidv7()}` } as AgentEvent;
          yield { type: "result", data: verdict("ready", "No legal risk.") } as AgentEvent;
          yield { type: "result", data: verdict("ready", "No legal risk.") } as AgentEvent;
        })(),
    };
    const item = draft(review);
    await supervisor().runOnce();
    const legal = attemptsAt(item, "legal")[0]!;
    const again = acceptTeamReport(handle.db, { attemptId: legal.id, outcome: "ready", report: "No legal risk." });
    expect(again).toMatchObject({ ok: true, duplicate: true });
    expect(listCommentsForItem(handle.db, item.id).filter((comment) => comment.body.startsWith("**legal**"))).toHaveLength(1);
    expect(stepNameOf(item)).toBe("Ready to publish");
    await qualifies(item);
  });

  it("capacity pressure: the team runs to its own limit, says why its third waits, and its session holds the one slot another item's team waits for", async () => {
    turns = allReady();
    const first = draft(review, "Spring newsletter");
    const second = draft(review, "Summer newsletter");
    const engine = supervisor();
    await engine.runOnce();
    expect(peak).toBe(2);
    // One item's team ran; the other waited on the global cap of one, as any item would.
    const ran = [first, second].filter((one) => listRunsForItem(handle.db, one.id).length > 0);
    expect(ran).toHaveLength(1);
    expect(listCommentsForItem(handle.db, ran[0]!.id).some((comment) => comment.body.includes("is waiting for room to start"))).toBe(true);
    await engine.runOnce();
    for (const one of [first, second]) {
      expect(stepNameOf(one)).toBe("Ready to publish");
      await qualifies(one);
    }
  });

  it("shared-budget exhaustion: turns share what is left rather than each taking it, and a spent budget stops the team with every cent kept and nothing moved", async () => {
    turns = {
      fact_checker: ({ opts }) => untilStopped(opts.signal, 20, 1),
      counsel: ({ opts }) => untilStopped(opts.signal, 20, 1),
      copy_editor: ({ opts }) => untilStopped(opts.signal, 20, 1),
    };
    const item = draft(review);
    await supervisor({ guards: { perItemBudgetCents: 30 } }).runOnce();
    const shares = started.slice(0, 2).map((one) => one.opts.budgetCents ?? Number.POSITIVE_INFINITY);
    expect(shares.reduce((sum, share) => sum + share, 0)).toBeLessThanOrEqual(30);
    expect(stepNameOf(item)).toBe("Specialist review");
    expect(listTransitionsForItem(handle.db, item.id)).toEqual([]);
    expect(attemptsOf(item).every((attempt) => attempt.reportCommentId === null)).toBe(true);
    expect(attemptsOf(item).filter((attempt) => attempt.status === "failed").every((attempt) => attempt.outcome === null)).toBe(true);
    expect(listCommentsForItem(handle.db, item.id).some((comment) => /budget/.test(comment.body))).toBe(true);
    await qualifies(item);
  });

  it("cancellation: stopping the team's run stops every participant, keeps what each spent, takes no late answer and moves nothing", async () => {
    turns = {
      fact_checker: ({ opts }) => untilStopped(opts.signal, 5, 2),
      counsel: ({ opts }) => untilStopped(opts.signal, 5, 2),
      copy_editor: ({ opts }) => untilStopped(opts.signal, 5, 2),
    };
    const item = draft(review);
    const engine = supervisor();
    const done = engine.runOnce();
    await vi.waitFor(() => expect(started).toHaveLength(2));
    engine.cancelRun(reviewRun(item)!.id);
    await done;
    expect(participantRunsOf(item).map((run) => run.status)).toEqual(["cancelled", "cancelled"]);
    expect(participantRunsOf(item).map((run) => run.costCents)).toEqual([7, 7]);
    expect(attemptsOf(item).every((attempt) => attempt.reportCommentId === null)).toBe(true);
    expect(listTransitionsForItem(handle.db, item.id)).toEqual([]);
    expect(engine.activeRunCount()).toBe(0);
    await qualifies(item);
  });

  it("human question: the asking turn ends, the team parks with no process waiting, and the reply reruns only the assignment that asked", async () => {
    turns = {
      ...allReady(),
      counsel: ({ nth, opts }) => {
        if (nth === 1) return says(asks("Is the membership figure confidential until the AGM?"));
        expect(opts.context).toContain("**Answer:** No, it was announced in March.");
        return says(verdict("ready", "Announced already; no confidentiality issue."));
      },
    };
    const item = draft(review);
    const engine = supervisor();
    await engine.runOnce();
    expect(reviewRun(item)?.status).toBe("awaiting_input");
    expect(engine.activeRunCount()).toBe(0);
    const question = listCommentsForItem(handle.db, item.id).find((comment) => comment.kind === "question")!;
    expect(question.authorId).toBe(attemptsAt(item, "legal")[0]?.agentId);
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, parentId: question.id, body: "No, it was announced in March." });
    await engine.resumeItem(item.id);
    expect(stepNameOf(item)).toBe("Ready to publish");
    expect(started.filter((one) => one.role === "fact_checker")).toHaveLength(1);
    expect(started.filter((one) => one.role === "copy_editor")).toHaveLength(1);
    expect(started.filter((one) => one.role === "counsel")).toHaveLength(2);
    await qualifies(item);
  });

  it("source change: reports made on a draft a person replaced are superseded and done again, and the result is decided from the new ones", async () => {
    const item = draft(review);
    let replaced = false;
    turns = {
      fact_checker: () =>
        (async function* () {
          // Replaced while its turn runs, before its answer: a turn ends on its answer.
          const answer = verdict(replaced ? "ready" : "blocking", replaced ? "The corrected figure is sourced." : "The 12% is wrong.");
          if (!replaced) {
            replaced = true;
            attach(item, "draft-v2.md", "# Spring newsletter\n\nMembership grew by 9% this quarter.");
          }
          yield* says(answer);
        })(),
      counsel: () => says(verdict("ready", "No legal risk.")),
      copy_editor: () => says(verdict("ready", "In house style.")),
    };
    await supervisor().runOnce();
    expect(attemptsOf(item).some((attempt) => attempt.supersededBy !== null)).toBe(true);
    expect(stepNameOf(item)).toBe("Ready to publish");
    await qualifies(item);
  });

  it("organisation lease handoff: once another device holds the item, this one stops its team, keeps what was spent and moves nothing", async () => {
    turns = {
      fact_checker: ({ opts }) => untilStopped(opts.signal, 3),
      counsel: ({ opts }) => untilStopped(opts.signal, 3),
      copy_editor: ({ opts }) => untilStopped(opts.signal, 3),
    };
    const item = draft(review);
    const engine = supervisor();
    const done = engine.runOnce();
    await vi.waitFor(() => expect(started).toHaveLength(2));
    const held = leaseFor(handle.db, item.id);
    expect(held).not.toBeNull();
    // The record hands the item to another desktop of the organisation…
    releaseLease(handle.db, item.id, held!.deviceId);
    grantLease(handle.db, { itemId: item.id, deviceId: "another-desktop", now: Date.now(), ttlMs: 10 * 60_000 });
    // …and this desktop learns it at its next renewal.
    await engine.runOnce();
    await done;
    expect(participantRunsOf(item).every((run) => run.status === "cancelled")).toBe(true);
    expect(listTeamSessionsForItem(handle.db, item.id)[0]?.session.status).toBe("cancelled");
    expect(listCommentsForItem(handle.db, item.id).some((comment) => comment.body.includes("no longer holds the item"))).toBe(true);
    expect(attemptsOf(item).every((attempt) => attempt.reportCommentId === null)).toBe(true);
    expect(listTransitionsForItem(handle.db, item.id)).toEqual([]);
    await qualifies(item);
  });
});

// ── Opt-in ───────────────────────────────────────────────────────────

/** A bundled template document, as far as which of its steps have a team. */
interface Shipped {
  steps: { id: string; team?: unknown }[];
  boards?: { steps: { id: string; team?: unknown }[] }[];
}

describe("the team examples (EO-850)", () => {
  beforeEach(() => setup());

  it("are opt-in: no seed or migration gives a step a team, the software template's Review is the only bundled step with one, and nothing but importing an example adds another", () => {
    expect(listPipelineSteps(handle.db).filter((step) => step.team !== null)).toEqual([]);
    // Every bundled template, every version that ships, every board: the
    // one team is Review's in the software template (EO-868), from 1.5.
    const gallery = new URL("../../../resources/gallery/", import.meta.url);
    const withTeams: string[] = [];
    const documents = [
      ...readdirSync(gallery)
        .filter((file) => file.endsWith(".json"))
        .map((name) => ({ name, document: JSON.parse(readFileSync(new URL(name, gallery), "utf8")) as Shipped })),
      ...readdirSync(new URL("history/", gallery)).flatMap((slug) =>
        readdirSync(new URL(`history/${slug}/`, gallery)).map((name) => ({ name: `history/${slug}/${name}`, document: (JSON.parse(readFileSync(new URL(`history/${slug}/${name}`, gallery), "utf8")) as { pack: Shipped }).pack })),
      ),
    ];
    for (const { name, document } of documents) {
      for (const step of [...document.steps, ...(document.boards ?? []).flatMap((board) => board.steps)]) if (step.team !== undefined) withTeams.push(`${name}:${step.id}`);
    }
    expect(withTeams.sort()).toEqual(["history/software-feature-to-merge/1.5.json:review", "history/software-feature-to-merge/1.6.json:review", "history/software-feature-to-merge/1.7.json:review", "software-feature-to-merge.json:review"]);
    importExample("publication-review", ROSTERS[0]!);
    expect(listPipelineSteps(handle.db).filter((step) => step.team !== null).map((step) => step.name)).toEqual(["Specialist review"]);
  });

  it.each(["publication-review", "incident-investigation"])("%s imports as Publish would accept it, with no developer-pack type, role or workspace", (name) => {
    const stepIds = importExample(name, ROSTERS[0]!);
    const pipelineId = getStep(handle.db, Object.values(stepIds)[0]!)!.pipelineId;
    const steps = listStepsForPipeline(handle.db, pipelineId);
    const problems = storedGraphProblems(handle.db, pipelineId, steps, listRoutesForPipeline(handle.db, pipelineId), getPipeline(handle.db, pipelineId)!.entryStepId);
    expect(problems.filter((problem) => problem.severity === "error")).toEqual([]);
    const team = storedTeam(steps.find((step) => step.team !== null)?.team);
    expect(team).not.toBeNull();
    const text = readFileSync(new URL(`${name}.json`, EXAMPLES), "utf8");
    for (const developer of ["implementer", "reviewer", "story", "feature", "worktree", "repository", "branch"]) expect(text).not.toContain(`"${developer}"`);
    expect(steps.every((step) => step.workspaceId === null)).toBe(true);
  });
});
