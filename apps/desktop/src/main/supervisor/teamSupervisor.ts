import {
  participantAnswerJsonSchema,
  readEvidenceBaseline,
  staffingAgents,
  TEAM_PARTICIPANT_ACTION,
  TeamParticipantAnswerSchema,
  type Agent,
  type AgentEvent,
  type AgentProvider,
  type IndependentTeam,
  type Item,
  type PipelineStep,
  type TeamAttemptRow,
  type TeamEvidenceBaseline,
  type TeamParticipant,
  type TeamSessionRow,
  type Uuid,
} from "@eo/core";
import { allocateParticipantBudget, planIndependentTeam, type BudgetCeiling, type TeamAttemptState, type TeamWaitReason } from "@eo/engine";
import type { Db } from "../db/client.js";
import { listAgents } from "../db/repos/agentsRepo.js";
import { getComment, postComment } from "../db/repos/commentsRepo.js";
import { getItem } from "../db/repos/itemsRepo.js";
import { createRunEventBuffer } from "../db/repos/runEventBuffer.js";
import { createRun, getRun, listActiveParticipantRuns, updateRun } from "../db/repos/runsRepo.js";
import {
  acceptTeamReport,
  beginTeamAttempt,
  currentTeamSession,
  endTeamAttempt,
  endTeamSession,
  getTeamSession,
  listTeamAttempts,
  listOpenTeamSessions,
  listTeamSessionsForItem,
  openTeamSession,
  startTeamAttempt,
  teamSessionOnEntry,
  teamSessionTotals,
} from "../db/repos/teamSessionsRepo.js";
import type { AgentWriteBridge } from "../mcp/writeBridge.js";
import { captureTeamEvidence, type TeamEvidence } from "./teamEvidence.js";
import { reportOnlyCredential, type TeamParticipantScopes, type ThreadBoundary } from "./teamParticipants.js";
import { createUsageTally } from "./usageTally.js";
import type { PreparedWorkspace, WorkspaceKind } from "./workspaceKind.js";

/**
 * Running an independent team (EO-846, ARCHITECTURE.md, "A team on an agent
 * step").
 *
 * **The team is its step's run.** The scheduler dispatches a team step as
 * it dispatches any agent step: one item, one lease, one item lock, one
 * `runs` row — the team's own, the *parent* — and every guard a dispatch
 * passes. What would have been that run's provider turn is this: a stream
 * that supervises the participants and ends on the one answer the step
 * returns, `{ result, summary }`, which the ordinary machinery validates
 * and routes through `transitionItem` (invariant 1). No participant can
 * route anything; nothing here writes a step.
 *
 * **Participants are authorised work inside that run**, not dispatches of
 * their own. Each attempt has a `runs` row of its own, recorded under
 * `TEAM_PARTICIPANT_ACTION` so nothing that reads an item's runs as its
 * step's mistakes it for one, with its thread, timing and spending — so a
 * team's spending is its runs summed once, and the parent's is its own,
 * which is nothing. Each turn is report-only (EO-845): a provider built for
 * its attempt alone, the four evidence tools answered from its registered
 * scope, and its answer posted by EO as an attributed report.
 *
 * **Capacity is counted in provider turns.** The parent waits and runs no
 * turn, so it holds its item's slot and nothing a participant needs. A
 * participant's turn counts against the team's `maxParallel`, the
 * machine's participant limit across every team, and its agent's own
 * limit beside that agent's ordinary runs. What cannot start waits and
 * the item is told why, once.
 *
 * **Restrictions are the participant's own.** Before each turn: EO
 * pausing or closing, the item held, the agent's runtime blocked, the
 * agent retired or no longer serving the item's project, its backend not
 * allowed by the organisation — none inherited from the parent, which
 * never held an exemption a participant could use.
 *
 * **Money is shared, not copied.** What the item's, the day's and the
 * team's budgets have left is divided between the assignments still owed
 * a turn, less what running turns still hold (`allocateParticipantBudget`);
 * each turn is capped at its share by its backend and stopped by EO when
 * its persisted spending reaches it. Spending is written to the turn's
 * row on every reading, so an interruption keeps all of it.
 *
 * **Recovery reconciles before it replaces.** A restart leaves the session
 * open and its item on the same step entry. The next dispatch adopts the
 * session: an attempt no turn of this process is working is ended as
 * cancelled — not a failure, not a finding — and replaced; an accepted
 * report is kept as it was and never posted twice; a session already
 * settled answers with its result again rather than running anything.
 *
 * **Evidence that moves supersedes the work done on it.** Before the team
 * settles, the evidence is captured again; if what it holds has changed,
 * the work done on the old evidence is superseded and done again on the
 * new, and nothing is settled on a stale report. What the team itself
 * posts — reports, notes — carries no attachment and changes no file, so
 * it never moves the evidence.
 */

/** The machine's participant turns at once, across every team, unless a host says otherwise: the most any one team may run. */
export const MACHINE_PARTICIPANT_LIMIT = 4;

/** Why a participant may not start now: wait for it to pass, or refuse the attempt outright. */
export type ParticipantRestriction = { kind: "wait"; reason: string } | { kind: "refuse"; reason: string };

/** A report-only provider for one attempt and its working directory, or why there is none (`reportOnlyProviderForAgent`). */
export type ReportOnlyProviderAnswer = { ok: true; provider: Pick<AgentProvider, "start">; cwd: string } | { ok: false; problem: string };

export interface TeamSupervisorDeps {
  db: Db;
  now: () => number;
  /** A report-only provider built for one attempt (`reportOnlyProviderForAgent`), or why there is none. */
  reportOnlyProvider: (agent: Agent, attemptId: string) => ReportOnlyProviderAnswer;
  scopes: TeamParticipantScopes;
  writeBridge: () => Pick<AgentWriteBridge, "tokenFor"> | null;
  /** How many participant turns this machine runs at once, across every team. */
  machineLimit: () => number;
  /** The per-agent concurrency cap, as the scheduler holds an agent to it. */
  perAgentLimit: () => number;
  /** How many provider turns this agent is running outside any team: its ordinary runs, a team's waiting parent not among them. */
  ordinaryTurnsOf: (agentId: string) => number;
  /** What stands between this agent and a turn on this item now, or null. */
  restriction: (agent: Agent, item: Item) => ParticipantRestriction | null;
  /**
   * What the item's budget and the day's have left, each on its own, in
   * cents from persisted spending; null for one that is not set. Apart,
   * because a turn running on another item holds the day's budget and
   * not this item's.
   */
  budgetLeft: (itemId: Uuid) => { itemCents: number | null; dayCents: number | null };
  /** Whether this process still holds the item's lease, where it held one when the team began. */
  holdsLease: (itemId: Uuid) => boolean;
  /** Keeps a promise in the supervisor's in-flight set, so idling and quitting wait for it. */
  track: (promise: Promise<unknown>) => void;
  /** The board may have changed. */
  onChange: () => void;
  /** How often a waiting team looks again at what may have changed — a pause lifted, a slot freed. */
  pollMs?: number;
  /** How long a stopped participant's backend is read for what it still reports before it is let go. */
  stopGraceMs?: number;
}

export interface TeamTurnInput {
  item: Item;
  step: PipelineStep;
  team: IndependentTeam;
  /** The team's own run: its step's run. */
  parentRunId: Uuid;
  /** Where the step works, for the evidence; null for an item with no disk. */
  workspace: { kind: WorkspaceKind; prepared: PreparedWorkspace } | null;
  signal: AbortSignal;
}

interface LiveParticipant {
  attemptId: string;
  itemId: string;
  sessionId: string;
  agentId: string;
  controller: AbortController;
  /** Why EO stopped it, once it has. */
  stoppedBecause: string | null;
  /** Its run, once it has one. */
  runId: string | null;
  allocation: number | null;
  spent: number;
  done: Promise<void>;
}

export interface TeamSupervisor {
  /** The team's turn, as the parent run's stream: heartbeats while it works, then its one answer or why it has none. */
  run(input: TeamTurnInput): AsyncGenerator<AgentEvent>;
  /** Whether this run is a team's waiting parent: holding its item, running no provider turn. */
  isWaitingParent(runId: string): boolean;
  /** The agents of the participant turns running now, one entry per turn. */
  participantAgentIds(): string[];
  /** How many participant turns are running now. */
  liveCount(): number;
  /**
   * Whether an item's run a restart interrupted is a team's own (EO-846):
   * one whose item is still on the step entry of a session on its step
   * that is open, or that settled and has not yet moved the item. Such a
   * run has nothing to resume and nothing to orphan — the next dispatch
   * adopts its session, or answers with what it settled on.
   */
  ownsInterruptedRun(run: { itemId: string; stepId: string | null }): boolean;
  /**
   * Ends every participant run and attempt no turn of this process is
   * working — what a restart left `running` — as cancelled, before
   * anything is dispatched to replace them. Answers how many.
   */
  reconcileOrphans(): number;
}

/** What an attempt's evidence holds, as a key two captures of the same content share and nothing else does. */
export function evidenceContentKey(baseline: TeamEvidenceBaseline | null): string | null {
  if (baseline === null) return null;
  const ref = readEvidenceBaseline(baseline);
  if (ref === null) return `unreadable:${baseline.kind}:${baseline.ref}`;
  return JSON.stringify({ kind: ref.workspaceKind, source: ref.source, attachments: ref.attachments.map((attachment) => [attachment.id, attachment.sha256]) });
}

/** The report an accepted attempt posted, without the heading EO put over it. */
function reportText(db: Db, attempt: TeamAttemptRow): string | null {
  if (attempt.reportCommentId === null) return null;
  const body = getComment(db, attempt.reportCommentId as Uuid)?.body;
  if (body === undefined) return null;
  const split = body.indexOf("\n\n");
  return split === -1 ? body : body.slice(split + 2);
}

function participantInstructions(agent: Agent, step: PipelineStep, team: IndependentTeam): string {
  return [
    `You are ${agent.name}, one participant of a team EO runs on the step "${step.name}". ${team.participants.length} participants each look at the work from their own angle, independently, and EO decides the step's result from what each concludes.`,
    "",
    "You are report-only. You read the evidence EO captured for you with `evidence_list`, `evidence_read` and `evidence_search`, and the item and its thread as far as you may see them with `item_context`. You cannot change any file, run any command, post a comment or reach anything else; EO posts your report, attributed to you, once you have answered.",
    "",
    "Answer with one of the outcomes your assignment declares and your report: what you looked at, what you found, and why it supports that outcome. If you could not establish something, say so in the report rather than guessing.",
    ...(agent.instructions.trim() === "" ? [] : ["", "## Your standing instructions", "", agent.instructions.trim()]),
  ].join("\n");
}

function participantContext(item: Item, team: IndependentTeam, participant: TeamParticipant): string {
  const outcomes = team.outcomes.map((outcome) => `- \`${outcome.key}\` — ${outcome.label}${outcome.meaning === "" ? "" : `: ${outcome.meaning}`}`);
  return [
    `# ${item.key} — ${item.title}`,
    "",
    item.body ?? "",
    "",
    `## Your assignment: ${participant.key}`,
    "",
    participant.instructions,
    "",
    "## The outcomes you may report",
    "",
    ...outcomes,
    "",
    "The item's thread, as far as it was when your assignment began, is what `item_context` answers. Other participants' reports are not part of it.",
  ].join("\n");
}

function abortError(): Error {
  const error = new Error("The team's run was stopped.");
  error.name = "AbortError";
  return error;
}

export function createTeamSupervisor(deps: TeamSupervisorDeps): TeamSupervisor {
  const { db } = deps;
  const live = new Map<string, LiveParticipant>();
  /** Team parents in this process, by run. */
  const parents = new Set<string>();
  const pollMs = deps.pollMs ?? 2000;
  const stopGraceMs = deps.stopGraceMs ?? 5000;

  function liveOn(agentId: string): number {
    let count = 0;
    for (const one of live.values()) if (one.agentId === agentId) count += 1;
    return count;
  }

  function note(item: Item, runId: Uuid, body: string): void {
    postComment(db, { itemId: item.id, runId, author: { type: "engine" }, kind: "note", body });
    deps.onChange();
  }

  /** The agent an assignment runs as now: the first of its role's staff with room, else the first of them. */
  function staffFor(item: Item, role: string): Agent | null {
    const staff = staffingAgents(listAgents(db), role, item);
    return staff.find((agent) => deps.perAgentLimit() - deps.ordinaryTurnsOf(agent.id) - liveOn(agent.id) > 0) ?? staff[0] ?? null;
  }

  /** Ends what a participant's run left running, as EO stopping it — not a failure and not a finding. */
  function closeStopped(attempt: TeamAttemptRow, why: string): void {
    if (attempt.runId !== null) {
      const run = getRun(db, attempt.runId as Uuid);
      if (run !== undefined && (run.status === "queued" || run.status === "running")) {
        updateRun(db, run.id, { status: "cancelled", error: why, interruption: "restart", endedAt: deps.now() });
      }
    }
    endTeamAttempt(db, attempt.id, { status: "cancelled", error: why }, deps.now());
  }

  /**
   * Ends what a restart left at work: a participant run and an attempt no
   * turn of this process is working, each as cancelled — EO stopped it,
   * the participant did nothing wrong and concluded nothing.
   */
  function reconcileOrphans(): number {
    let count = 0;
    // A session whose item has left its step entry while nobody ran it
    // takes nothing more: ended, so it is not left open for ever.
    for (const session of listOpenTeamSessions(db)) {
      if (session.runId !== null && parents.has(session.runId)) continue;
      if (!teamSessionOnEntry(db, session)) endTeamSession(db, { sessionId: session.id, status: "cancelled", now: deps.now() });
    }
    const working = new Set([...live.values()].map((one) => one.runId));
    // Runs first: one whose attempt was never begun still has a row.
    for (const run of listActiveParticipantRuns(db)) {
      if (working.has(run.id)) continue;
      updateRun(db, run.id, { status: "cancelled", error: "EO stopped while this participant worked, so its turn ended here.", interruption: "restart", endedAt: deps.now() });
      count += 1;
    }
    for (const session of listOpenTeamSessions(db)) {
      for (const attempt of listTeamAttempts(db, session.id)) {
        if ((attempt.status !== "queued" && attempt.status !== "running") || live.has(attempt.id)) continue;
        closeStopped(attempt, "EO stopped while this participant worked, so it is started again rather than counted.");
        count += 1;
      }
    }
    return count;
  }

  /**
   * One participant's turn on one attempt, to its end: a report accepted,
   * a failure, or EO stopping it. Never throws.
   */
  async function runParticipant(input: {
    item: Item;
    step: PipelineStep;
    team: IndependentTeam;
    participant: TeamParticipant;
    attempt: TeamAttemptRow;
    agent: Agent;
    evidence: TeamEvidence;
    boundary: ThreadBoundary;
    entry: LiveParticipant;
  }): Promise<void> {
    const { item, attempt, agent, entry } = input;
    const built = deps.reportOnlyProvider(agent, attempt.id);
    if (!built.ok) {
      endTeamAttempt(db, attempt.id, { status: "failed", error: built.problem }, deps.now());
      return;
    }
    const run = createRun(db, {
      itemId: item.id,
      agentId: agent.id as Uuid,
      action: TEAM_PARTICIPANT_ACTION,
      stepId: input.step.id,
      status: "running",
      provider: agent.provider,
      cwd: built.cwd,
    });
    entry.runId = run.id;
    updateRun(db, run.id, { startedAt: deps.now() });
    const begun = beginTeamAttempt(db, attempt.id, run.id, deps.now());
    if (!begun.ok) {
      updateRun(db, run.id, { status: "cancelled", error: begun.problem, endedAt: deps.now() });
      return;
    }
    deps.onChange();
    const release = deps.scopes.register({ attemptId: attempt.id, itemId: item.id, evidence: input.evidence, thread: input.boundary });
    const buffer = createRunEventBuffer(db);
    const tally = createUsageTally();
    let answer: unknown = undefined;
    let failure: string | null = null;
    try {
      const bridge = deps.writeBridge();
      const stream = built.provider.start({
        instructions: participantInstructions(agent, input.step, input.team),
        context: participantContext(item, input.team, input.participant),
        cwd: built.cwd,
        outputSchema: participantAnswerJsonSchema(input.team),
        ...(entry.allocation === null ? {} : { budgetCents: entry.allocation }),
        ...(bridge === null ? {} : { writeBridge: reportOnlyCredential(bridge, item.id, attempt.id) }),
        signal: entry.controller.signal,
      });
      // Read to its end even once stopped: a backend reports what it spent
      // as it winds down, and every cent reported is kept. A stopped turn's
      // answer is never taken, and a backend that does not end its turn
      // within the grace after the stop is let go.
      const iterator = stream[Symbol.asyncIterator]();
      const givenUp = new Promise<"gave_up">((resolve) => {
        const arm = () => {
          const timer = setTimeout(() => resolve("gave_up"), stopGraceMs);
          timer.unref?.();
        };
        if (entry.controller.signal.aborted) arm();
        else entry.controller.signal.addEventListener("abort", arm, { once: true });
      });
      for (;;) {
        const step = await Promise.race([iterator.next(), givenUp]);
        if (step === "gave_up") {
          void Promise.resolve(iterator.return?.(undefined)).catch(() => undefined);
          break;
        }
        if (step.done === true) break;
        const event = step.value;
        const stopped = entry.controller.signal.aborted;
        if (event.type !== "output_delta" && event.type !== "heartbeat") buffer.append(run.id, event.type, event);
        if (event.type === "thread_started") updateRun(db, run.id, { threadId: event.threadId });
        else if (event.type === "usage") {
          if (tally.record(event)) {
            const totals = tally.totals();
            // Every reading, a stopped turn's included, so an interruption keeps all of it.
            updateRun(db, run.id, totals);
            entry.spent = totals.costCents;
            if (entry.allocation !== null && entry.spent >= entry.allocation && entry.stoppedBecause === null && failure === null) {
              failure = `It reached its share of the budget (${entry.allocation}¢) before it answered.`;
              entry.controller.abort();
            }
          }
        } else if (stopped) continue;
        else if (event.type === "result") answer = event.data;
        else if (event.type === "error" && event.fatal !== false) {
          failure = event.budget === true ? `It reached its share of the budget (${entry.allocation ?? 0}¢) before it answered.` : event.message;
        }
      }
    } catch (error) {
      if (entry.stoppedBecause === null && failure === null) failure = error instanceof Error ? error.message : String(error);
    } finally {
      release();
      buffer.dispose();
    }

    const at = deps.now();
    if (entry.stoppedBecause !== null) {
      updateRun(db, run.id, { status: "cancelled", error: entry.stoppedBecause, endedAt: at });
      endTeamAttempt(db, attempt.id, { status: "cancelled", error: entry.stoppedBecause }, at);
      return;
    }
    const parsed = answer === undefined ? null : TeamParticipantAnswerSchema.safeParse(answer);
    if (failure === null && parsed?.success === true) {
      const accepted = acceptTeamReport(db, { attemptId: attempt.id, outcome: parsed.data.outcome, report: parsed.data.report, now: at });
      if (accepted.ok) {
        updateRun(db, run.id, { status: "succeeded", result: parsed.data, endedAt: at });
        return;
      }
      // A late answer for a session that has ended, or an item that has
      // moved on: kept out of every decision, and said on the run.
      updateRun(db, run.id, { status: "cancelled", error: accepted.problem, endedAt: at });
      endTeamAttempt(db, attempt.id, { status: "cancelled", error: accepted.problem }, at);
      return;
    }
    const error =
      failure ??
      (answer === undefined
        ? "Its turn ended without an answer."
        : `Its answer was not a report EO could take: ${parsed?.success === false ? (parsed.error.issues[0]?.message ?? "wrong shape") : "wrong shape"}.`);
    updateRun(db, run.id, { status: "failed", error, endedAt: at });
    endTeamAttempt(db, attempt.id, { status: "failed", error }, at);
  }

  async function* run(input: TeamTurnInput): AsyncGenerator<AgentEvent> {
    const { item, step, team, parentRunId, signal } = input;
    parents.add(parentRunId);
    const mine = new Set<string>();
    try {
      // Held open for the whole team, so the inactivity guard does not
      // read a team waiting on its participants as a backend gone quiet.
      yield { type: "heartbeat", callStarted: `team:${parentRunId}` };

      // ── The evidence as it stands, before anything is decided on ──
      // Captured first, so that not even a session that already settled
      // answers again from reports about a version that has since gone.
      const evidence = await capture();

      // ── The session: this entry's, adopted; or a new one ─────────
      let session = currentTeamSession(db, item.id);
      if (session !== undefined && (session.stepId !== step.id || !teamSessionOnEntry(db, session))) session = undefined;
      if (session === undefined) {
        // Settled on this entry already, and the move it asked for never
        // happened: the same answer again, nothing run twice.
        const settled = listTeamSessionsForItem(db, item.id)
          .map((record) => record.session)
          .filter((one) => one.stepId === step.id && one.status === "finalized" && teamSessionOnEntry(db, one))
          .at(-1);
        if (settled !== undefined && evidence.ok) {
          const again = settledAnswer(settled, evidenceContentKey(evidence.evidence.baseline)!);
          if (again.kind === "replay") {
            yield { type: "result", data: again.answer };
            return;
          }
          // Settled on evidence that has changed since, before the move:
          // its result is stale, so the team is done again on what is
          // there now, and the settled session is kept as it was.
          if (again.kind === "stale") {
            note(item, parentRunId, `What the team on "${step.name}" read changed after it settled and before this item moved on, so its result is not used: the team runs again on what is there now.`);
          }
        }
        session = openTeamSession(db, { itemId: item.id, stepId: step.id, team, runId: parentRunId, now: deps.now() });
        note(
          item,
          parentRunId,
          `EO is running "${step.name}" as a team of ${team.participants.length}: ${team.participants.map((participant) => `**${participant.key}** (${participant.role})`).join(", ")}, ${team.limits.maxParallel} at a time. Each reports here; EO decides the step's result from what they conclude.`,
        );
      }
      const sessionId = session.id;
      const sessionTeam = session.team.coordination === "independent" ? session.team : team;

      if (!evidence.ok) {
        endTeamSession(db, { sessionId, status: "failed", now: deps.now() });
        yield { type: "error", message: `EO could not capture what the team would read, so no participant was started: ${evidence.problem}`, retryable: false };
        return;
      }
      let current = evidence.evidence;
      let currentKey = evidenceContentKey(current.baseline)!;
      // The thread a first pass sees: as far as when this session's
      // evidence was first captured, and none of its own reports.
      const firstCapture = listTeamAttempts(db, sessionId)
        .map((attempt) => (attempt.evidenceBaseline === null ? null : readEvidenceBaseline(attempt.evidenceBaseline)?.capturedAt ?? null))
        .find((at): at is number => at !== null);
      let visibleThrough = firstCapture ?? current.ref.capturedAt;

      const leased = deps.holdsLease(item.id);
      const deadline = team.limits.timeoutMs === undefined ? null : deps.now() + team.limits.timeoutMs;
      const told = new Set<string>();
      // How often the evidence has moved under this turn: bounded like a
      // participant's retries, so a source that never holds still cannot
      // have the team done again for ever.
      let moves = 0;
      let wake: (() => void) | null = null;
      // Stopped the moment the run is: whoever is reading this stream may
      // stop reading it, and no participant outlives the run it works for.
      const nudge = () => {
        if (signal.aborted) {
          for (const attemptId of mine) {
            const one = live.get(attemptId);
            if (one === undefined || one.stoppedBecause !== null) continue;
            one.stoppedBecause = "The team's run was stopped, so EO stopped this participant with it.";
            one.controller.abort();
          }
        }
        wake?.();
      };
      signal.addEventListener("abort", nudge);

      const stopAll = async (why: string): Promise<void> => {
        for (const attemptId of mine) {
          const one = live.get(attemptId);
          if (one === undefined) continue;
          if (one.stoppedBecause === null) one.stoppedBecause = why;
          one.controller.abort();
        }
        await Promise.allSettled([...mine].flatMap((attemptId) => { const one = live.get(attemptId); return one === undefined ? [] : [one.done]; }));
      };

      try {
        for (;;) {
          if (signal.aborted) {
            await stopAll("The team's run was stopped, so EO stopped this participant with it.");
            throw abortError();
          }
          const now = getTeamSession(db, sessionId);
          const stale = staleSession(now);
          if (stale !== null || (leased && !deps.holdsLease(item.id))) {
            const why = stale ?? "This device no longer holds the item, so its team stopped here.";
            await stopAll(why);
            if (now?.status === "open") endTeamSession(db, { sessionId, status: "cancelled", now: deps.now() });
            yield { type: "error", message: why, retryable: true };
            return;
          }
          if (deadline !== null && deps.now() >= deadline) {
            await stopAll(`The team's time limit of ${team.limits.timeoutMs} ms ran out.`);
            endTeamSession(db, { sessionId, status: "failed", now: deps.now() });
            yield { type: "error", message: `The team on "${step.name}" ran out of its time limit (${team.limits.timeoutMs} ms) before every participant had reported, so EO decided nothing.`, retryable: false };
            return;
          }

          const attempts = listTeamAttempts(db, sessionId);
          const states: TeamAttemptState[] = attempts.map((attempt) => ({
            id: attempt.id,
            key: attempt.assignmentKey,
            status: attempt.status,
            supersededBy: attempt.supersededBy,
            outcome: attempt.outcome,
            report: attempt.status === "completed" ? reportText(db, attempt) : null,
            error: attempt.error,
            baseline: evidenceContentKey(attempt.evidenceBaseline),
            live: live.has(attempt.id),
          }));
          const agentOf = new Map<string, string | null>();
          const agents = new Map<string, Agent | null>();
          for (const participant of sessionTeam.participants) {
            const agent = staffFor(item, participant.role);
            agents.set(participant.key, agent);
            agentOf.set(participant.key, agent?.id ?? null);
          }
          const agentFree = new Map<string, number>();
          for (const agent of agents.values()) {
            if (agent !== null) agentFree.set(agent.id, Math.max(0, deps.perAgentLimit() - deps.ordinaryTurnsOf(agent.id) - liveOn(agent.id)));
          }
          const plan = planIndependentTeam({
            team: sessionTeam,
            attempts: states,
            baseline: currentKey,
            capacity: { machineFree: Math.max(0, deps.machineLimit() - live.size), agentOf, agentFree },
          });

          // Reconciled before anything replaces them.
          let fenced = false;
          for (const { attemptId, why } of plan.fence) {
            const one = live.get(attemptId);
            if (one !== undefined) {
              if (one.stoppedBecause === null) {
                one.stoppedBecause = "What this participant was reading changed, so its work was superseded.";
                one.controller.abort();
              }
              continue;
            }
            const attempt = attempts.find((each) => each.id === attemptId);
            if (attempt === undefined) continue;
            closeStopped(attempt, why === "orphaned" ? "EO stopped while this participant worked, so it is started again rather than counted." : "What this participant was reading changed before it began.");
            fenced = true;
          }
          if (fenced) continue;

          if (plan.decision.status !== "pending" && plan.working.length === 0) {
            // Nothing is settled on evidence that has moved.
            const again = await capture();
            if (again.ok && evidenceContentKey(again.evidence.baseline) !== currentKey) {
              moves += 1;
              if (moves > team.limits.maxRetries) {
                endTeamSession(db, { sessionId, status: "failed", now: deps.now() });
                yield {
                  type: "error",
                  message: `What the team on "${step.name}" was reading changed every time it was about to settle (${moves} times), so EO settled nothing rather than decide on reports about a version that is already gone.`,
                  retryable: false,
                };
                return;
              }
              current = again.evidence;
              currentKey = evidenceContentKey(current.baseline)!;
              visibleThrough = current.ref.capturedAt;
              note(item, parentRunId, `What the team was reading changed before it settled, so the reports made on the old version are superseded and done again on the new one.`);
              continue;
            }
            if (!again.ok) {
              endTeamSession(db, { sessionId, status: "failed", now: deps.now() });
              yield { type: "error", message: `EO could not check that what the team read is still current, so it settled nothing: ${again.problem}`, retryable: false };
              return;
            }
            if (plan.decision.status === "decided") {
              const ended = endTeamSession(db, { sessionId, status: "finalized", result: plan.decision.result, now: deps.now() });
              if (!ended.ok) {
                yield { type: "error", message: ended.problem, retryable: true };
                return;
              }
              yield { type: "result", data: { result: plan.decision.result, summary: plan.decision.summary } };
              return;
            }
            endTeamSession(db, { sessionId, status: "failed", now: deps.now() });
            yield {
              type: "error",
              message: `The team on "${step.name}" could not decide: ${plan.decision.failed.map((key) => `**${key}**`).join(", ")} could not contribute after ${team.limits.maxRetries} ${team.limits.maxRetries === 1 ? "retry" : "retries"}, and a required participant that did not contribute is never read as a finding.\n\n${plan.decision.summary}`,
              retryable: false,
            };
            return;
          }

          // Turns, within every bound and every restriction.
          const outstanding = plan.start.length + plan.waiting.length;
          let started = 0;
          for (const start of plan.start) {
            const participant = sessionTeam.participants.find((one) => one.key === start.key)!;
            const agent = agents.get(start.key) ?? null;
            const tell = (reason: string) => {
              const key = `${start.key}:${reason}`;
              if (told.has(key)) return;
              told.add(key);
              note(item, parentRunId, `**${start.key}** is waiting to start: ${reason}`);
            };
            const supersedes = start.supersedes === null ? {} : { supersedes: start.supersedes };
            if (agent === null) {
              const made = startTeamAttempt(db, { sessionId, assignmentKey: start.key, role: participant.role, agentId: null, instructions: participant.instructions, evidenceBaseline: current.baseline, now: deps.now(), ...supersedes });
              if (made.ok) endTeamAttempt(db, made.attempt.id, { status: "failed", error: `No enabled "${participant.role}" agent serves this item's project.` }, deps.now());
              continue;
            }
            const restricted = deps.restriction(agent, getItem(db, item.id) ?? item);
            if (restricted?.kind === "wait") {
              tell(restricted.reason);
              continue;
            }
            if (restricted?.kind === "refuse") {
              const made = startTeamAttempt(db, { sessionId, assignmentKey: start.key, role: participant.role, agentId: agent.id as Uuid, instructions: participant.instructions, evidenceBaseline: current.baseline, now: deps.now(), ...supersedes });
              if (made.ok) endTeamAttempt(db, made.attempt.id, { status: "failed", error: restricted.reason }, deps.now());
              continue;
            }
            const share = shareFor(item, sessionId, outstanding - started);
            const allocation = share.cents;
            if (allocation === 0) {
              // Held by turns still working, under a budget this one is
              // under too: given back as they finish, so it waits.
              if (share.held) {
                tell("the budget left is held by participants still working, and is shared out again as they finish.");
                continue;
              }
              await stopAll("The budget ran out.");
              endTeamSession(db, { sessionId, status: "failed", now: deps.now() });
              yield { type: "error", message: `The team on "${step.name}" has no budget left to start **${start.key}** — the item's, the day's or the team's own is spent — so EO decided nothing. Raise the budget to let it go on.`, retryable: false };
              return;
            }
            const made = startTeamAttempt(db, {
              sessionId,
              assignmentKey: start.key,
              role: participant.role,
              agentId: agent.id as Uuid,
              instructions: participant.instructions,
              evidenceBaseline: current.baseline,
              now: deps.now(),
              ...supersedes,
            });
            if (!made.ok) {
              // The session ended under it: the next pass says so.
              continue;
            }
            started += 1;
            const controller = new AbortController();
            const entry: LiveParticipant = {
              attemptId: made.attempt.id,
              itemId: item.id,
              sessionId,
              agentId: agent.id,
              controller,
              stoppedBecause: null,
              runId: null,
              allocation,
              spent: 0,
              done: Promise.resolve(),
            };
            live.set(made.attempt.id, entry);
            mine.add(made.attempt.id);
            const boundary: ThreadBoundary = { visibleThrough, exposedCommentIds: [], hiddenCommentIds: sessionReportIds(sessionId) };
            entry.done = runParticipant({ item, step, team: sessionTeam, participant, attempt: made.attempt, agent, evidence: current, boundary, entry })
              // Whatever went wrong is the attempt's failure, counted
              // against its retries: an attempt left queued would be read
              // as EO stopping it, and replaced for ever.
              .catch((error: unknown) => {
                const why = `EO could not run it: ${error instanceof Error ? error.message : String(error)}`;
                if (entry.runId !== null) updateRun(db, entry.runId as Uuid, { status: "failed", error: why, endedAt: deps.now() });
                endTeamAttempt(db, made.attempt.id, { status: "failed", error: why }, deps.now());
              })
              .finally(() => {
                live.delete(made.attempt.id);
                mine.delete(made.attempt.id);
                deps.onChange();
                nudge();
              });
            deps.track(entry.done);
          }
          for (const waiting of plan.waiting) {
            const key = `${waiting.key}:${waiting.reason}`;
            if (told.has(key)) continue;
            told.add(key);
            note(item, parentRunId, `**${waiting.key}** is waiting to start: ${waitWords(waiting.reason, team)}`);
          }

          // Something to wait for: a participant ending, a slot freeing, a
          // pause lifting, the run being stopped.
          yield { type: "heartbeat" };
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, pollMs);
            timer.unref?.();
            wake = () => {
              clearTimeout(timer);
              resolve();
            };
          });
          wake = null;
        }
      } finally {
        signal.removeEventListener("abort", nudge);
        // However the turn ends, none of its participants outlives it.
        await stopAll("The team's run ended, so EO stopped this participant with it.");
      }
    } finally {
      parents.delete(parentRunId);
    }

    async function capture() {
      return captureTeamEvidence({ db, item: getItem(db, item.id) ?? item, workspace: input.workspace, now: deps.now(), signal });
    }

    function staleSession(session: TeamSessionRow | undefined): string | null {
      if (session === undefined) return "The team's session is gone.";
      if (session.status === "superseded") return "A newer team session replaced this one, so EO stopped its participants.";
      if (session.status !== "open") return `The team's session has already ended (${session.status}).`;
      if (!teamSessionOnEntry(db, session)) return "The item has left the step its team was working on, so EO stopped the team's participants.";
      return null;
    }
  }

  /**
   * What a finalised session settled on, rebuilt from its accepted reports
   * — deterministic, so the same as when it settled — provided every one of
   * them was made on the evidence as it is now (`currentKey`); `stale`
   * where any was not, and the team must run again.
   */
  function settledAnswer(session: TeamSessionRow, currentKey: string): { kind: "replay"; answer: { result: string; summary: string } } | { kind: "stale" } | { kind: "none" } {
    if (session.team.coordination !== "independent" || session.result === null) return { kind: "none" };
    const attempts = listTeamAttempts(db, session.id);
    const states: TeamAttemptState[] = attempts.map((attempt) => ({
      id: attempt.id,
      key: attempt.assignmentKey,
      status: attempt.status,
      supersededBy: attempt.supersededBy,
      outcome: attempt.outcome,
      report: reportText(db, attempt),
      error: attempt.error,
      baseline: evidenceContentKey(attempt.evidenceBaseline),
      live: false,
    }));
    const latestCompleted = states.filter((state) => state.supersededBy === null && state.status === "completed");
    if (latestCompleted.some((state) => state.baseline !== currentKey)) return { kind: "stale" };
    const plan = planIndependentTeam({ team: session.team, attempts: states, baseline: currentKey, capacity: { machineFree: 0, agentOf: new Map(), agentFree: new Map() } });
    if (plan.decision.status !== "decided" || plan.decision.result !== session.result) return { kind: "none" };
    return { kind: "replay", answer: { result: plan.decision.result, summary: plan.decision.summary } };
  }

  function sessionReportIds(sessionId: string): string[] {
    return listTeamAttempts(db, sessionId).flatMap((attempt) => (attempt.reportCommentId === null ? [] : [attempt.reportCommentId]));
  }

  /**
   * This turn's share of every budget it is under (EO-846), each reckoned
   * with only the running turns that budget covers: the item's with this
   * item's, the team's own with this session's, the day's with every turn
   * running today. And whether any of that is held by a turn still
   * working, which a share of nothing waits for rather than fails on.
   */
  function shareFor(item: Item, sessionId: string, outstanding: number): { cents: number | null; held: boolean } {
    const heldBy = (covers: (one: LiveParticipant) => boolean): number => {
      let held = 0;
      for (const one of live.values()) if (one.allocation !== null && covers(one)) held += Math.max(0, one.allocation - one.spent);
      return held;
    };
    const ceilings: BudgetCeiling[] = [];
    const left = deps.budgetLeft(item.id as Uuid);
    if (left.itemCents !== null) ceilings.push({ remainingCents: left.itemCents, heldCents: heldBy((one) => one.itemId === item.id) });
    if (left.dayCents !== null) ceilings.push({ remainingCents: left.dayCents, heldCents: heldBy(() => true) });
    const own = getTeamSession(db, sessionId)?.team.limits.budgetCents;
    if (own !== undefined) ceilings.push({ remainingCents: Math.max(0, own - teamSessionTotals(db, sessionId).costCents), heldCents: heldBy((one) => one.sessionId === sessionId) });
    return { cents: allocateParticipantBudget({ ceilings, outstanding }), held: ceilings.some((ceiling) => ceiling.heldCents > 0) };
  }

  return {
    run,
    isWaitingParent: (runId) => parents.has(runId),
    participantAgentIds: () => [...live.values()].map((one) => one.agentId),
    liveCount: () => live.size,
    reconcileOrphans,
    ownsInterruptedRun: (run) => {
      if (run.stepId === null) return false;
      const latest = listTeamSessionsForItem(db, run.itemId).at(-1)?.session;
      return latest !== undefined && latest.stepId === run.stepId && (latest.status === "open" || latest.status === "finalized") && teamSessionOnEntry(db, latest);
    },
  };
}

function waitWords(reason: TeamWaitReason, team: IndependentTeam): string {
  switch (reason) {
    case "team":
      return `the team runs ${team.limits.maxParallel} participant${team.limits.maxParallel === 1 ? "" : "s"} at a time, and that many are working. It starts as one finishes.`;
    case "machine":
      return "every participant slot on this machine is in use by a team. It starts as one frees.";
    case "agent":
      return "the agent it runs as is already working as much as its concurrency limit allows. It starts as that agent frees up.";
  }
}
