import {
  LEADER_ASSIGNMENT_KEY,
  leaderTurnSchema,
  participantTurnSchema,
  readEvidenceBaseline,
  readLeaderAnswer,
  readParticipantAnswer,
  staffingAgents,
  TEAM_ENFORCEMENT_UNAVAILABLE,
  TEAM_PARTICIPANT_ACTION,
  teamMemberMode,
  teamWaitNote,
  type Agent,
  type AgentEvent,
  type AgentProvider,
  type AgentProviderStartOptions,
  type ClarificationRequired,
  type Comment,
  type IndependentTeam,
  type Item,
  type JsonSchema,
  type JsonSchemaDocument,
  type LeaderTeam,
  type PipelineStep,
  type Run,
  type StepTeam,
  type TeamAttemptRow,
  type TeamEvidenceBaseline,
  type TeamOutcome,
  type TeamSessionRow,
  type Uuid,
} from "@eo/core";
import {
  allocateParticipantBudget,
  checkLeaderAssignments,
  finalStands,
  leaderFinalProblems,
  leaderLedger,
  planIndependentTeam,
  ruledOutProblems,
  planLeaderTeam,
  type BudgetCeiling,
  type LeaderAttemptState,
  type LeaderLedger,
  type LeaderVerdict,
  type TeamAttemptState,
  type TeamStart,
  type TeamWaitReason,
} from "@eo/engine";
import type { Db } from "../db/client.js";
import { getAgent, listAgents } from "../db/repos/agentsRepo.js";
import { getComment, listCommentsForItem, postComment } from "../db/repos/commentsRepo.js";
import { getItem } from "../db/repos/itemsRepo.js";
import { createRunEventBuffer, type RunEventBuffer } from "../db/repos/runEventBuffer.js";
import { createRun, getRun, listActiveParticipantRuns, listRunsForItem, updateRun } from "../db/repos/runsRepo.js";
import {
  acceptTeamReport,
  beginTeamAttempt,
  currentTeamSession,
  endTeamAttempt,
  endTeamSession,
  getTeamAttempt,
  getTeamSession,
  getTeamSessionRecord,
  listTeamAttempts,
  listOpenTeamSessions,
  listTeamSessionsForItem,
  openTeamSession,
  requestTeamRetry,
  startTeamAttempt,
  teamRetryTargets,
  teamSessionOnEntry,
  teamSessionTotals,
} from "../db/repos/teamSessionsRepo.js";
import type { AgentWriteBridge } from "../mcp/writeBridge.js";
import { postClarificationQuestions, unansweredQuestions } from "../roles/clarificationQuestions.js";
import { captureTeamEvidence, type MemberCopy, type TeamEvidence } from "./teamEvidence.js";
import { reportOnlyCredential, type TeamParticipantScopes, type ThreadBoundary } from "./teamParticipants.js";
import { createUsageTally } from "./usageTally.js";
import type { PreparedWorkspace, WorkspaceKind } from "./workspaceKind.js";

/**
 * Running a team (EO-846, EO-847, ARCHITECTURE.md, "A team on an agent
 * step").
 *
 * **The team is its step's run.** The scheduler dispatches a team step as
 * it dispatches any agent step: one item, one lease, one item lock, one
 * `runs` row — the team's own, the *parent* — and every guard a dispatch
 * passes. What would have been that run's provider turn is this: a stream
 * that supervises the participants and ends on the one answer the step
 * returns, which the ordinary machinery validates and routes through
 * `transitionItem` (invariant 1). No participant can route anything;
 * nothing here writes a step.
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
 * **A leader works in bounded turns** (EO-847). It is a report-only turn
 * like any participant's, recorded under the reserved key
 * `LEADER_ASSIGNMENT_KEY`, and it acts only through its answer: a round of
 * assignments, a final answer, or questions for the person. A turn that
 * asks for work ends there — its process is gone, what it asked for is on
 * its run and its comment — and EO runs the assignments it accepted as
 * participants; once that round has settled, the leader's next turn is
 * started with the reports. Nothing waits in a process for anybody. What
 * the leader asks for is held to the team's roles and limits and refused,
 * with the reason recorded, past them; its final answer is held to every
 * required assignment having reported, to relying only on current reports,
 * and to the step's action's own schema and results, whatever it says.
 *
 * **Asking a person parks the session, in either mode** (EO-847). A turn
 * that asks posts its questions on the thread, attributed to its agent and
 * run, and ends; what is working finishes, nothing new starts, and the
 * team's run ends awaiting input with the session left open. The person's
 * reply dispatches the step again, which adopts the session: the asking
 * assignment — or the leader — is started again with the question and the
 * answer, and every report that is still current is kept, not run again.
 *
 * **A session is one run against EO's caps** (EO-871). The parent is the
 * step's run, and holds the slot a single run of the step would — the
 * global one, its item's capacity key and its agent's — for as long as the
 * session is active: it ends when the session settles, parks or is
 * cancelled. The turns inside it, a leader's and its members', count
 * against none of those caps, and against no machine-wide limit: only the
 * team's own `maxParallel` holds them back. Each is
 * still a run of its own, for the budgets, and each is held to the
 * wall-clock and inactivity guards as an ordinary run is (`guardTurn`);
 * the parent is held to neither, and to the team's own `timeoutMs` where
 * one is declared. What cannot start waits and the item is told why, once.
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
 * posts — reports, notes, questions — carries no attachment and changes no
 * file, so it never moves the evidence.
 */

/** What a parked team tells the person it can do (EO-849). */
export const TEAM_RETRY_WORDS = "Retry the team, or reply, to try again what failed: every report already accepted is kept. Cancel the session to run the whole team afresh.";

/** Why a participant may not start now: wait for it to pass, or refuse the attempt outright. */
export type ParticipantRestriction = { kind: "wait"; reason: string } | { kind: "refuse"; reason: string };

/** A report-only provider for one attempt and its working directory, or why there is none (`reportOnlyProviderForAgent`). */
export type ReportOnlyProviderAnswer = { ok: true; provider: Pick<AgentProvider, "start">; cwd: string } | { ok: false; problem: string };

/**
 * What an isolated member's turn is built from (EO-867): everything an
 * ordinary dispatch of its step would know, and where it stands instead.
 */
export interface IsolatedTurnRequest {
  item: Item;
  step: PipelineStep;
  agent: Agent;
  attemptId: string;
  /** The member's own run, already written. */
  run: Run;
  /** Its own copy of the item's workspace, where it works. */
  cwd: string;
  /** The item's own workspace, for what an ordinary dispatch is lent from it — the repository index. Null for an item with no disk. */
  workspace: PreparedWorkspace | null;
  /** The team framing: what is added after the agent's own instructions, and after the ordinary context. */
  framing: { instructions: string; context: string };
  /** Where the member's view of the thread ends: its team's other reports are not part of it. */
  boundary: ThreadBoundary;
}

/**
 * An isolated member's turn as an ordinary dispatch of its step would open
 * it, standing in its copy (EO-867): the agent's ordinary provider and the
 * options an ordinary dispatch starts it with — but its own working
 * directory, its team framing, a thread its team's reports are kept out
 * of, and an `eo` credential that posts nothing on the item. `observe` is
 * handed each event, for what the host records of any run's turn, and
 * answers true for one it recorded itself.
 */
export type IsolatedTurnAnswer =
  | { ok: true; provider: Pick<AgentProvider, "start">; options: Omit<AgentProviderStartOptions, "signal" | "outputSchema">; observe?: (event: AgentEvent, buffer: RunEventBuffer) => boolean; done?: () => void }
  | { ok: false; problem: string };

export interface TeamSupervisorDeps {
  db: Db;
  now: () => number;
  /** A report-only provider built for one attempt (`reportOnlyProviderForAgent`), or why there is none. */
  reportOnlyProvider: (agent: Agent, attemptId: string) => ReportOnlyProviderAnswer;
  /**
   * An isolated member's turn, built by the host through the ordinary
   * dispatch path (EO-867), or why there is none. Absent, an isolated
   * team's members are refused, saying so.
   */
  isolatedTurn?: (request: IsolatedTurnRequest) => Promise<IsolatedTurnAnswer>;
  scopes: TeamParticipantScopes;
  writeBridge: () => Pick<AgentWriteBridge, "tokenFor"> | null;
  /**
   * Holds one turn to the guards an ordinary run is held to (EO-871): the
   * wall clock and the inactivity guard, which call `stop` with why. Each
   * event the turn's backend says is handed to `observe`; `release` is
   * called once the turn is over. Absent, a turn answers to no such guard.
   */
  guardTurn?: (turn: { runId: string; agent: Agent; stop: (reason: string) => void }) => { observe: (event: AgentEvent) => void; release: () => void };
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

/**
 * The step's action as a leader's final answer is held to it (EO-847):
 * its answer document, which the leader's turn is constrained to; the
 * check the ordinary path makes of any agent's answer; and the result keys
 * it declares. The host's, because only the host has the registry.
 */
export interface TeamAnswerContract {
  /** The action's answer document, or null where nothing defines one. */
  document: JsonSchemaDocument | null;
  validate: (raw: unknown) => { ok: true; value: unknown } | { ok: false; error: string };
  results: readonly string[];
  /**
   * The result key a valid answer routes on, read as the step's own run's
   * answer is read (EO-868): a pack's action may name its result some
   * other way than `result` — a review's `verdict` — and the pack says
   * which key that is. Null where it names none. Left out, the answer's
   * own `result`.
   */
  resultOf?: (value: unknown) => string | null;
}

/** An answer's own `result`, where it names one. */
function reportedResult(answer: unknown): string | null {
  const result = (answer as { result?: unknown } | null)?.result;
  return typeof result === "string" ? result : null;
}

export interface TeamTurnInput {
  item: Item;
  step: PipelineStep;
  team: StepTeam;
  /** The team's own run: its step's run. */
  parentRunId: Uuid;
  /** Where the step works, for the evidence; null for an item with no disk. */
  workspace: { kind: WorkspaceKind; prepared: PreparedWorkspace } | null;
  /** What a leader's final answer is held to. Needed by a leader's team only. */
  answer?: TeamAnswerContract;
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
  /** Whether it is an isolated member (EO-867), whose `eo` writes are answered for its run. */
  isolated: boolean;
  done: Promise<void>;
}

/** What EO makes of a turn's answer once the turn has ended. */
type TakeResult =
  /** Taken: the run keeps `result`. */
  | { kind: "accepted"; result: unknown }
  /** It asked the person: the questions are posted, attributed to it, and the attempt waits for the answer. */
  | { kind: "asked"; asked: ClarificationRequired }
  /** An answer EO could not take: a failed contribution, counted against the retries. */
  | { kind: "failed"; error: string }
  /** An answer for a session that has ended or an item that has moved on: kept out of every decision. */
  | { kind: "late"; problem: string };

/** One turn, as its provider is started and its answer taken. */
interface TurnSpec {
  instructions: string;
  context: string;
  outputSchema: JsonSchema;
  /** `appendix`: the line an isolated member's report carries about its copy, or null. */
  take: (answer: unknown, runId: Uuid, at: number, appendix: string | null) => TakeResult;
}

export interface TeamSupervisor {
  /** The team's turn, as the parent run's stream: heartbeats while it works, then its one answer or why it has none. */
  run(input: TeamTurnInput): AsyncGenerator<AgentEvent>;
  /** Whether this run is a team's waiting parent: holding its item, running no provider turn. */
  isWaitingParent(runId: string): boolean;
  /** How many participant turns are running now. */
  liveCount(): number;
  /** The isolated member's turn running now on this attempt (EO-867) — its run, agent and item — or null. */
  liveMember(attemptId: string): { runId: string; agentId: string; itemId: string } | null;
  /** Whether a turn of this process is working this attempt now. */
  isLive(attemptId: string): boolean;
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

/**
 * What an attempt's evidence holds, as a key two captures of the same
 * content share and nothing else does: the workspace, the attachments and,
 * since EO-847, the item's own task — so an edit to what is asked makes
 * every report made against the old ask stale, as a changed file does.
 */
export function evidenceContentKey(baseline: TeamEvidenceBaseline | null): string | null {
  if (baseline === null) return null;
  const ref = readEvidenceBaseline(baseline);
  if (ref === null) return `unreadable:${baseline.kind}:${baseline.ref}`;
  return JSON.stringify({ kind: ref.workspaceKind, source: ref.source, attachments: ref.attachments.map((attachment) => [attachment.id, attachment.sha256]), task: ref.task?.sha256 ?? null });
}

/** The report an accepted attempt posted, without the heading EO put over it. */
function reportText(db: Db, attempt: TeamAttemptRow): string | null {
  if (attempt.reportCommentId === null) return null;
  const body = getComment(db, attempt.reportCommentId as Uuid)?.body;
  if (body === undefined) return null;
  const split = body.indexOf("\n\n");
  return split === -1 ? body : body.slice(split + 2);
}

/** What EO kept of a leader's turn on its run (EO-847): the answer as it said it, and what EO made of it. */
interface LeaderTurnRecord {
  leader: true;
  answer: unknown;
  verdict: LeaderVerdict;
  /** On an accepted final answer: the step's answer, as the action's check returned it. */
  value?: unknown;
  /** On an accepted final answer: the declared result it is (EO-868), which a pack's action may name otherwise than `result`. */
  resultKey?: string;
}

function leaderRecordOf(db: Db, attempt: TeamAttemptRow): LeaderTurnRecord | null {
  if (attempt.runId === null) return null;
  const result = getRun(db, attempt.runId as Uuid)?.result;
  if (typeof result !== "object" || result === null || (result as { leader?: unknown }).leader !== true) return null;
  return result as unknown as LeaderTurnRecord;
}

function outcomeLines(outcomes: readonly TeamOutcome[]): string[] {
  return outcomes.map((outcome) => `- \`${outcome.key}\` — ${outcome.label}${outcome.meaning === "" ? "" : `: ${outcome.meaning}`}`);
}

/**
 * What the leader is told its reports rule out (EO-873): each outcome
 * that rules out a result, and what EO does about an answer naming one.
 * Empty where the team declares none.
 */
function rulesOutLines(outcomes: readonly TeamOutcome[]): string[] {
  const ruling = outcomes.filter((outcome) => (outcome.rulesOut ?? []).length > 0);
  if (ruling.length === 0) return [];
  return [
    "",
    "What a report rules out: EO refuses a final answer whose result an accepted report's outcome rules out, unless your disagreements overrule that report on a line of its own — `Overruled <assignment key>: <why you overruled it>`. Mentioning the report anywhere else is not overruling it, and an override with no reason is refused.",
    "",
    ...ruling.map((outcome) => `- \`${outcome.key}\` rules out ${(outcome.rulesOut ?? []).map((key) => `\`${key}\``).join(", ")}`),
  ];
}

const REPORT_ONLY =
  "You are report-only. You read the evidence EO captured for you with `evidence_list`, `evidence_read` and `evidence_search`, and the item and its thread as far as you may see them with `item_context`. You cannot change any file, run any command, post a comment, create or reconfigure an agent, grant anything, or hand work to your backend's own subagents; EO posts what you answer, attributed to you.";

const ASKING =
  "If only the person can settle something you need, ask them instead of answering: your turn ends, EO posts your questions, and you are started again with their answer. A permission or tool you do not have is something to ask for, never something you can give yourself.";

/**
 * What an isolated member is told of where it stands (EO-867): the
 * sentence that replaces `REPORT_ONLY` for a member that works as its
 * role's agent does.
 */
const ISOLATED =
  "You work as you would on this step alone, with everything you are given for it, in a working directory that is a copy of the item's workspace EO made for you alone. Change, build and test whatever you need there. Nothing you do in it reaches the item's work, its branch or another member's copy, and EO removes it when your turn ends, saying on your report what you changed; do not push from it. Where you have the repository index, it describes the same files as they stand in the item's own workspace: read and change them in your copy. You post nothing on the item yourself — EO posts your answer as your report, attributed to you — and you are not shown the other members' reports.";

/** Whether a team's members are isolated (EO-867). */
function isolatedTeam(team: StepTeam): boolean {
  return teamMemberMode(team) === "isolated";
}

function participantInstructions(agent: Agent, step: PipelineStep, team: StepTeam): string {
  const how =
    team.coordination === "independent"
      ? `${team.participants.length} participants each look at the work from their own angle, independently, and EO decides the step's result from what each concludes.`
      : "A leader assigned you this piece of the work, and reads your report with the others' before it answers the step.";
  const answer =
    team.outcomes.length === 0
      ? "Answer with your report: what you looked at, what you found, and why. If you could not establish something, say so in the report rather than guessing."
      : "Answer with one of the outcomes your assignment declares and your report: what you looked at, what you found, and why it supports that outcome. If you could not establish something, say so in the report rather than guessing.";
  // An isolated member's own instructions come first, as on any dispatch
  // of its agent; this is the team framing after them (EO-867).
  if (isolatedTeam(team)) {
    return ["## Your part in a team", "", `You are ${agent.name}, one member of a team EO runs on the step "${step.name}". ${how}`, "", ISOLATED, "", answer, "", ASKING].join("\n");
  }
  return [
    `You are ${agent.name}, one participant of a team EO runs on the step "${step.name}". ${how}`,
    "",
    REPORT_ONLY,
    "",
    answer,
    "",
    ASKING,
    ...(agent.instructions.trim() === "" ? [] : ["", "## Your standing instructions", "", agent.instructions.trim()]),
  ].join("\n");
}

function participantContext(item: Item, outcomes: readonly TeamOutcome[], key: string, instructions: string, extra: readonly string[], isolated = false): string {
  // An isolated member's context is its step's ordinary one, the item
  // included, with this after it (EO-867).
  const head = isolated ? [] : [`# ${item.key} — ${item.title}`, "", item.body ?? "", ""];
  return [
    ...head,
    `## Your assignment: ${key}`,
    "",
    instructions,
    ...(outcomes.length === 0 ? [] : ["", "## The outcomes you may report", "", ...outcomeLines(outcomes)]),
    ...(extra.length === 0 ? [] : ["", ...extra]),
    "",
    isolated
      ? "The item's thread is shown to you as far as it was when your team began. Other members' reports are not part of it, here or through EO's tools."
      : "The item's thread, as far as it was when your assignment began, is what `item_context` answers. Other participants' reports are not part of it.",
  ].join("\n");
}

/**
 * Why an isolated team cannot run where its step works (EO-867): the
 * workspace kind makes no copy for a member, and EO never runs one in the
 * item's own workspace in its place.
 */
export function isolatedCopyRefusal(slug: string | null): string {
  return slug === null
    ? "This team's members are isolated, and the step has no workspace EO can copy for each of them, so EO started nobody."
    : `This team's members are isolated, and its step works in a "${slug}" workspace, which cannot give each member a copy of its own, so EO started nobody rather than run a member in the item's own workspace. Make the team's members report-only, or have the step work in a Git repository or on no disk.`;
}

/** What EO says of a member's changed copy where the member left no report to carry it (EO-867). */
export function memberCopyNote(key: string, agentName: string, changed: readonly string[]): string {
  return `**${key}** (${agentName}) changed its own copy of the workspace, which EO has removed and none of which reached the item's work: ${changed.join("; ")}.`;
}

/**
 * Says on its item what a member had changed in a copy a sweep is about to
 * remove (EO-867) — one its turn did not remove itself, after a crash or
 * a stop. Never throws: a copy whose attempt is gone has nobody to tell,
 * and that goes to the log.
 */
export function reportMemberCopy(db: Db, attemptId: string, changed: readonly string[]): void {
  try {
    const attempt = getTeamAttempt(db, attemptId);
    const session = attempt === undefined ? undefined : getTeamSession(db, attempt.sessionId);
    if (attempt === undefined || session === undefined || getItem(db, session.itemId as Uuid) === undefined) {
      console.log(`[eo] a team member's copy for attempt ${attemptId} was changed before EO removed it: ${changed.join("; ")}`);
      return;
    }
    const agentName = attempt.agentId === null ? attempt.role : (getAgent(db, attempt.agentId as Uuid)?.name ?? attempt.role);
    postComment(db, { itemId: session.itemId as Uuid, ...(attempt.runId === null ? {} : { runId: attempt.runId as Uuid }), author: { type: "engine" }, kind: "note", body: memberCopyNote(attempt.assignmentKey, agentName, changed) });
  } catch (error) {
    console.error(`[eo] could not say what a team member changed in its copy (attempt ${attemptId}): ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The line a member's report carries where it changed its copy (EO-867), as a reference checkout's removal says it. */
function copyChangedLine(changed: readonly string[]): string {
  return `**In its own copy of the workspace**, which EO has removed and none of which reached the item's work: ${changed.join("; ")}.`;
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

  function note(item: Item, runId: Uuid, body: string): void {
    postComment(db, { itemId: item.id, runId, author: { type: "engine" }, kind: "note", body });
    deps.onChange();
  }

  /**
   * The agent an assignment runs as, asked as its turn starts: of its
   * role's staff, the one running fewest turns now, the first in staffing
   * order among equals — so a role staffed by several agents shares the
   * work between them. No agent's concurrency cap decides it (EO-871): the
   * session holds its one slot, and the turns inside it count against no cap.
   */
  function staffFor(item: Item, role: string): Agent | null {
    const turnsOf = (agentId: string): number => [...live.values()].filter((one) => one.agentId === agentId).length;
    let chosen: Agent | null = null;
    for (const agent of staffingAgents(listAgents(db), role, item)) if (chosen === null || turnsOf(agent.id) < turnsOf(chosen.id)) chosen = agent;
    return chosen;
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

  // ── Questions (EO-847) ─────────────────────────────────────────────

  /** The questions an attempt's run asked, oldest first. */
  function questionsOf(attempt: Pick<TeamAttemptRow, "runId">, comments: readonly Comment[]): Comment[] {
    if (attempt.runId === null) return [];
    return comments.filter((comment) => comment.kind === "question" && comment.authorType === "agent" && comment.runId === attempt.runId);
  }

  /**
   * Whether an attempt that ended asking the person has every answer yet:
   * derived from the thread — the questions its run posted, and the replies
   * filed under them — and never stored.
   */
  function questionStateOf(itemId: string): (attempt: TeamAttemptRow) => "open" | "answered" | null {
    const comments = listCommentsForItem(db, itemId as Uuid);
    const open = new Set<string>(unansweredQuestions(db, itemId as Uuid));
    return (attempt) => {
      if (attempt.status !== "cancelled") return null;
      const asked = questionsOf(attempt, comments);
      if (asked.length === 0) return null;
      return asked.some((question) => open.has(question.id)) ? "open" : "answered";
    };
  }

  /**
   * What an assignment asked the person and what it was told, for the turn
   * that carries it on: the comments to show it, and the words. Read along
   * the whole chain of attempts the new one replaces — not only the one it
   * replaces directly — so an answer is not lost when the turn after it
   * failed and was retried, was stopped and replaced, or was superseded
   * because the evidence moved.
   */
  function exchangeOf(itemId: string, attempts: readonly TeamAttemptRow[], replaced: TeamAttemptRow | undefined): { ids: string[]; lines: string[] } {
    if (replaced === undefined) return { ids: [], lines: [] };
    const chain: TeamAttemptRow[] = [];
    const seen = new Set<string>();
    for (let one: TeamAttemptRow | undefined = replaced; one !== undefined && !seen.has(one.id); one = attempts.find((each) => each.supersededBy === one!.id)) {
      seen.add(one.id);
      chain.unshift(one);
    }
    const comments = listCommentsForItem(db, itemId as Uuid);
    const asked = chain.flatMap((attempt) => questionsOf(attempt, comments));
    if (asked.length === 0) return { ids: [], lines: [] };
    const ids: string[] = [];
    const lines = ["## What was asked, and the answer", ""];
    for (const question of asked) {
      ids.push(question.id);
      lines.push(`**Asked:** ${question.body}`);
      for (const reply of comments.filter((comment) => comment.parentId === question.id && comment.authorType !== "agent")) {
        ids.push(reply.id);
        lines.push(`**Answer:** ${reply.body}`);
      }
      lines.push("");
    }
    lines.push("Use the answer as given. Where it does not settle something, say so rather than assume.");
    return { ids, lines };
  }

  /** The open questions a team waits on, as the ordinary path reads an answer that asks: never posted again, since each is on the thread already, attributed to whoever asked. */
  function openQuestions(itemId: string, attempts: readonly TeamAttemptRow[]): ClarificationRequired {
    const comments = listCommentsForItem(db, itemId as Uuid);
    const open = new Set<string>(unansweredQuestions(db, itemId as Uuid));
    const asked = attempts.flatMap((attempt) => questionsOf(attempt, comments)).filter((question) => open.has(question.id));
    return {
      status: "clarification_required",
      questions: asked.map((question) => ({
        id: question.id,
        question: question.body,
        why: "A member of the team asked this, and its work waits on the answer.",
        options: (question.options ?? []).filter((option): option is string => typeof option === "string"),
        allow_free_text: true,
      })),
    };
  }

  /**
   * One turn on one attempt, to its end: an answer taken, a question
   * asked, a failure, or EO stopping it. Never throws.
   */
  async function runTurn(input: {
    item: Item;
    step: PipelineStep;
    attempt: TeamAttemptRow;
    agent: Agent;
    evidence: TeamEvidence;
    boundary: ThreadBoundary;
    entry: LiveParticipant;
    turn: TurnSpec;
    /** Where the step works, for an isolated member's copy; null for an item with no disk. */
    workspace: TeamTurnInput["workspace"];
  }): Promise<void> {
    const { item, attempt, agent, entry } = input;
    // An isolated member works in a copy of its own (EO-867), made before
    // its run and removed however its turn ends; never the item's own
    // workspace in its place.
    let copy: MemberCopy | null = null;
    let cwd: string;
    let reportOnly: Pick<AgentProvider, "start"> | null = null;
    if (entry.isolated) {
      const made = await memberCopyFor(input.workspace, item, input.evidence, attempt.id);
      if (!made.ok) {
        endTeamAttempt(db, attempt.id, { status: "failed", error: made.problem }, deps.now());
        return;
      }
      copy = made.copy;
      cwd = copy.cwd;
    } else {
      const built = deps.reportOnlyProvider(agent, attempt.id);
      if (!built.ok) {
        // Kept recognisable (EO-849): a person is told the agent could not be
        // held to report-only here, not that it tried and failed.
        endTeamAttempt(db, attempt.id, { status: "failed", error: `${TEAM_ENFORCEMENT_UNAVAILABLE}${built.problem}` }, deps.now());
        return;
      }
      reportOnly = built.provider;
      cwd = built.cwd;
    }
    try {
      await turnIn(input, cwd, reportOnly, copy);
    } finally {
      await copy?.remove();
    }
  }

  /** An isolated member's copy of the captured workspace, or why EO cannot make one — never the item's own workspace instead. */
  async function memberCopyFor(workspace: TeamTurnInput["workspace"], item: Item, evidence: TeamEvidence, attemptId: string): Promise<{ ok: true; copy: MemberCopy } | { ok: false; problem: string }> {
    const capability = workspace?.kind.evidence?.copy;
    if (workspace === null || capability === undefined) return { ok: false, problem: isolatedCopyRefusal(workspace?.kind.slug ?? null) };
    try {
      const made = await capability.call(workspace.kind.evidence, item, workspace.prepared, evidence.ref.source, { attemptId });
      return made.ok ? made : { ok: false, problem: `EO could not give it a copy of the item's workspace to work in, so it did not start: ${made.problem}` };
    } catch (error) {
      return { ok: false, problem: `EO could not give it a copy of the item's workspace to work in, so it did not start: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async function turnIn(
    input: Parameters<typeof runTurn>[0],
    cwd: string,
    reportOnly: Pick<AgentProvider, "start"> | null,
    copy: MemberCopy | null,
  ): Promise<void> {
    const { item, attempt, agent, entry } = input;
    const run = createRun(db, {
      itemId: item.id,
      agentId: agent.id as Uuid,
      action: TEAM_PARTICIPANT_ACTION,
      stepId: input.step.id,
      status: "running",
      provider: agent.provider,
      cwd,
    });
    entry.runId = run.id;
    updateRun(db, run.id, { startedAt: deps.now() });
    const begun = beginTeamAttempt(db, attempt.id, run.id, deps.now());
    if (!begun.ok) {
      updateRun(db, run.id, { status: "cancelled", error: begun.problem, endedAt: deps.now() });
      endTeamAttempt(db, attempt.id, { status: "cancelled", error: begun.problem }, deps.now());
      return;
    }
    deps.onChange();
    // An isolated member's turn is the host's to build, as an ordinary
    // dispatch of the step builds one (EO-867).
    let isolated: Extract<IsolatedTurnAnswer, { ok: true }> | null = null;
    if (copy !== null) {
      let built: IsolatedTurnAnswer;
      try {
        built =
          deps.isolatedTurn === undefined
            ? { ok: false, problem: `EO did not start ${agent.name} as an isolated team member, because this desktop has no way to build its turn.` }
            : await deps.isolatedTurn({ item, step: input.step, agent, attemptId: attempt.id, run: getRun(db, run.id) ?? run, cwd, workspace: input.workspace?.prepared ?? null, framing: { instructions: input.turn.instructions, context: input.turn.context }, boundary: input.boundary });
      } catch (error) {
        built = { ok: false, problem: `EO could not build its turn: ${error instanceof Error ? error.message : String(error)}` };
      }
      if (!built.ok) {
        updateRun(db, run.id, { status: "failed", error: built.problem, endedAt: deps.now() });
        endTeamAttempt(db, attempt.id, { status: "failed", error: built.problem }, deps.now());
        // Said on the item (invariant 8, EO-870): a failure counted
        // against the retries like any other, and nobody left to guess why.
        if (getItem(db, item.id) !== undefined) note(item, run.id, `**${attempt.assignmentKey}** (${agent.name}) did not start: ${built.problem}`);
        return;
      }
      isolated = built;
    }
    const release = reportOnly === null ? () => undefined : deps.scopes.register({ attemptId: attempt.id, itemId: item.id, evidence: input.evidence, thread: input.boundary });
    const buffer = createRunEventBuffer(db);
    const tally = createUsageTally();
    let answer: unknown = undefined;
    let failure: string | null = null;
    // The wall clock and the inactivity guard, as on an ordinary run
    // (EO-871): what trips one is this turn's failure, counted against its
    // retries as any other — never EO stopping it, which would replace it
    // for ever.
    const guard = deps.guardTurn?.({
      runId: run.id,
      agent,
      stop: (reason) => {
        if (entry.stoppedBecause !== null || failure !== null) return;
        failure = reason;
        entry.controller.abort();
      },
    });
    try {
      // Stopped while its turn was being built: nothing is started.
      if (entry.controller.signal.aborted && entry.stoppedBecause !== null) throw abortError();
      const bridge = deps.writeBridge();
      const budget = entry.allocation === null ? {} : { budgetCents: entry.allocation };
      const stream =
        isolated !== null
          ? isolated.provider.start({ ...isolated.options, outputSchema: input.turn.outputSchema, ...budget, signal: entry.controller.signal })
          : reportOnly!.start({
              instructions: input.turn.instructions,
              context: input.turn.context,
              cwd,
              outputSchema: input.turn.outputSchema,
              ...budget,
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
        guard?.observe(event);
        const stopped = entry.controller.signal.aborted;
        // What the host records of an isolated member's event as it would
        // of any run's — skill usage — is not recorded again as it came.
        if (isolated?.observe?.(event, buffer) === true) continue;
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
      guard?.release();
      release();
      isolated?.done?.();
      buffer.dispose();
    }

    // What an isolated member did in its copy, said before the copy goes
    // (EO-867): on its report where it has one, else as a note.
    const changed = copy === null ? [] : await copy.changes().catch((error: unknown) => [`what was done in it could not be read (${error instanceof Error ? error.message : String(error)})`]);
    const appendix = changed.length === 0 ? null : copyChangedLine(changed);
    const noteCopy = () => {
      if (appendix !== null && getItem(db, item.id) !== undefined) {
        postComment(db, { itemId: item.id, runId: run.id, author: { type: "engine" }, kind: "note", body: memberCopyNote(attempt.assignmentKey, agent.name, changed) });
        deps.onChange();
      }
    };

    const at = deps.now();
    if (entry.stoppedBecause !== null) {
      updateRun(db, run.id, { status: "cancelled", error: entry.stoppedBecause, endedAt: at });
      endTeamAttempt(db, attempt.id, { status: "cancelled", error: entry.stoppedBecause }, at);
      noteCopy();
      return;
    }
    const taken: TakeResult =
      failure !== null ? { kind: "failed", error: failure } : answer === undefined ? { kind: "failed", error: "Its turn ended without an answer." } : input.turn.take(answer, run.id, at, appendix);
    switch (taken.kind) {
      case "accepted":
        updateRun(db, run.id, { status: "succeeded", result: taken.result as Record<string, unknown>, endedAt: at });
        return;
      case "asked": {
        noteCopy();
        // Only while its session can still take anything: a late question
        // is no more the team's than a late report.
        const session = getTeamSession(db, attempt.sessionId);
        if (session === undefined || session.status !== "open" || !teamSessionOnEntry(db, session)) {
          const problem = "Its session had ended by the time it asked, so its questions were not posted.";
          updateRun(db, run.id, { status: "cancelled", error: problem, endedAt: at });
          endTeamAttempt(db, attempt.id, { status: "cancelled", error: problem }, at);
          return;
        }
        // On the thread, attributed to the agent and the run that asked:
        // the attempt is then known to be asking by its run's questions.
        postClarificationQuestions(db, getItem(db, item.id) ?? item, agent.id as Uuid, run.id, taken.asked);
        updateRun(db, run.id, { status: "succeeded", result: taken.asked as unknown as Record<string, unknown>, endedAt: at });
        endTeamAttempt(db, attempt.id, { status: "cancelled", error: `It asked the person ${taken.asked.questions.length === 1 ? "a question" : `${taken.asked.questions.length} questions`}, and is started again with the answer.` }, at);
        deps.onChange();
        return;
      }
      case "failed":
        updateRun(db, run.id, { status: "failed", error: taken.error, endedAt: at });
        endTeamAttempt(db, attempt.id, { status: "failed", error: taken.error }, at);
        noteCopy();
        return;
      case "late":
        updateRun(db, run.id, { status: "cancelled", error: taken.problem, endedAt: at });
        endTeamAttempt(db, attempt.id, { status: "cancelled", error: taken.problem }, at);
        noteCopy();
        return;
    }
  }

  /** A participant's answer taken as its report: posted, attributed, once — or its question, or why it is neither. */
  function takeReport(attemptId: string, outcomes: readonly TeamOutcome[], onDelegation?: (error: string) => void): TurnSpec["take"] {
    return (answer, _runId, at, appendix) => {
      const read = readParticipantAnswer(outcomes, answer);
      if (read.kind === "asked") return { kind: "asked", asked: read.asked };
      if (read.kind === "invalid") {
        if (read.delegation) onDelegation?.(read.error);
        return { kind: "failed", error: read.error };
      }
      const report = appendix === null ? read.report : `${read.report}\n\n${appendix}`;
      const accepted = acceptTeamReport(db, { attemptId, outcome: read.outcome, report, now: at });
      return accepted.ok ? { kind: "accepted", result: { outcome: read.outcome, report: read.report } } : { kind: "late", problem: accepted.problem };
    };
  }

  async function* run(input: TeamTurnInput): AsyncGenerator<AgentEvent> {
    const { item, step, team, parentRunId, signal } = input;
    parents.add(parentRunId);
    const mine = new Set<string>();
    try {
      // Held open for the whole team, so the inactivity guard does not
      // read a team waiting on its participants as a backend gone quiet.
      yield { type: "heartbeat", callStarted: `team:${parentRunId}` };

      if (team.coordination === "leader" && (input.answer === undefined || input.answer.document === null)) {
        yield { type: "error", message: `The leader of the team on "${step.name}" answers "${step.entryAction ?? ""}", and nothing defines that action's answer, so EO started nobody.`, retryable: false };
        return;
      }

      // An isolated team needs a copy for each member (EO-867): refused,
      // with the kind named, where the step's workspace makes none.
      if (isolatedTeam(team) && (input.workspace === null || input.workspace.kind.evidence?.copy === undefined)) {
        yield { type: "error", message: isolatedCopyRefusal(input.workspace?.kind.slug ?? null), retryable: false };
        return;
      }

      // ── The evidence as it stands, before anything is decided on ──
      // Captured first, so that not even a session that already settled
      // answers again from reports about a version that has since gone.
      const evidence = await capture();

      // ── The session: this entry's, adopted; or a new one ─────────
      let session = currentTeamSession(db, item.id);
      if (session !== undefined && (session.stepId !== step.id || session.team.coordination !== team.coordination || !teamSessionOnEntry(db, session))) session = undefined;
      const adopted = session !== undefined;
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
          team.coordination === "independent"
            ? `EO is running "${step.name}" as a team of ${team.participants.length}: ${team.participants.map((participant) => `**${participant.key}** (${participant.role})`).join(", ")}, ${team.limits.maxParallel} at a time. Each reports here; EO decides the step's result from what they conclude.`
            : `EO is running "${step.name}" as a team led by a ${team.leader.role} agent, who may assign work to ${team.roles.join(", ")} — at most ${team.limits.maxParticipants} participants over ${team.limits.maxRounds} round${team.limits.maxRounds === 1 ? "" : "s"}, ${team.limits.maxParallel} at a time. Each assignment and report is posted here; the leader answers the step, and EO checks that answer before it is used.`,
        );
      }
      const sessionId = session.id;
      const sessionTeam = session.team;

      // A team parked on what failed, carried on by a person — their reply
      // or their Retry (EO-849): what failed is tried once more, and every
      // report already accepted is kept rather than done again. Only after
      // a park, so a restart that adopts the session grants nothing.
      if (adopted) {
        const before = listRunsForItem(db, item.id).filter((one) => one.id !== parentRunId && one.stepId === step.id && one.action !== TEAM_PARTICIPANT_ACTION).at(-1);
        const record = getTeamSessionRecord(db, sessionId);
        if (before?.status === "awaiting_input" && record !== undefined) {
          const targets = teamRetryTargets(db, record);
          for (const target of targets) requestTeamRetry(db, target.id, deps.now());
          if (targets.length > 0) note(item, parentRunId, `Trying again what failed — ${targets.map((target) => `**${target.assignmentKey}**`).join(", ")} — and keeping every report already accepted.`);
        }
      }

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

      // Said once per reason, in words a later read of the session takes
      // the reason back from (`readTeamWaitNote`, EO-849).
      const tell = (key: string, reason: string, kind: "capacity" | "restricted" = "restricted") => {
        const told1 = `${key}:${reason}`;
        if (told.has(told1)) return;
        told.add(told1);
        note(item, parentRunId, teamWaitNote(key, kind, reason));
      };

      /** Reconciles what the plan fences; answers whether anything not live was ended, so the pass is made again. */
      const fenceAll = (fence: readonly { attemptId: string; why: "orphaned" | "stale" }[], attempts: readonly TeamAttemptRow[]): boolean => {
        let fenced = false;
        for (const { attemptId, why } of fence) {
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
        return fenced;
      };

      /**
       * Nothing is settled on evidence that has moved. Captured again; the
       * answer says whether to settle, go round again on the new evidence,
       * or stop with why.
       */
      const stillCurrent = async (): Promise<{ kind: "settle" } | { kind: "moved" } | { kind: "stop"; message: string }> => {
        const again = await capture();
        if (!again.ok) return { kind: "stop", message: `EO could not check that what the team read is still current, so it settled nothing: ${again.problem}` };
        if (evidenceContentKey(again.evidence.baseline) === currentKey) return { kind: "settle" };
        moves += 1;
        if (moves > team.limits.maxRetries) {
          return {
            kind: "stop",
            message: `What the team on "${step.name}" was reading changed every time it was about to settle (${moves} times), so EO settled nothing rather than decide on reports about a version that is already gone.`,
          };
        }
        current = again.evidence;
        currentKey = evidenceContentKey(current.baseline)!;
        visibleThrough = current.ref.capturedAt;
        note(item, parentRunId, `What the team was reading changed before it settled, so the reports made on the old version are superseded and done again on the new one.`);
        return { kind: "moved" };
      };

      /**
       * Gives one assignment a turn, within every restriction and budget:
       * `started`, `skipped` (it waits, or its attempt was refused and ended
       * with why), or `broke` (no budget is left for anyone: the team stops).
       */
      const startTurn = (launch: {
        key: string;
        role: string;
        instructions: string;
        round: number;
        supersedes: string | null;
        outstanding: number;
        boundary: (attempt: TeamAttemptRow) => ThreadBoundary;
        turn: (attempt: TeamAttemptRow, agent: Agent) => TurnSpec;
      }): "started" | "skipped" | "broke" => {
        const { key, role } = launch;
        const agent = staffFor(item, role);
        const base = { sessionId, assignmentKey: key, role, instructions: launch.instructions, round: launch.round, evidenceBaseline: current.baseline, ...(launch.supersedes === null ? {} : { supersedes: launch.supersedes }) };
        if (agent === null) {
          const made = startTeamAttempt(db, { ...base, agentId: null, now: deps.now() });
          if (made.ok) endTeamAttempt(db, made.attempt.id, { status: "failed", error: `No enabled "${role}" agent serves this item's project.` }, deps.now());
          return "skipped";
        }
        const restricted = deps.restriction(agent, getItem(db, item.id) ?? item);
        if (restricted?.kind === "wait") {
          tell(key, restricted.reason);
          return "skipped";
        }
        if (restricted?.kind === "refuse") {
          const made = startTeamAttempt(db, { ...base, agentId: agent.id as Uuid, now: deps.now() });
          if (made.ok) endTeamAttempt(db, made.attempt.id, { status: "failed", error: restricted.reason }, deps.now());
          return "skipped";
        }
        const share = shareFor(item, sessionId, launch.outstanding);
        const allocation = share.cents;
        if (allocation === 0) {
          // Held by turns still working, under a budget this one is
          // under too: given back as they finish, so it waits.
          if (share.held) {
            tell(key, "the budget left is held by participants still working, and is shared out again as they finish.", "capacity");
            return "skipped";
          }
          return "broke";
        }
        const made = startTeamAttempt(db, { ...base, agentId: agent.id as Uuid, now: deps.now() });
        // The session ended under it: the next pass says so.
        if (!made.ok) return "skipped";
        const controller = new AbortController();
        const entry: LiveParticipant = { attemptId: made.attempt.id, itemId: item.id, sessionId, agentId: agent.id, controller, stoppedBecause: null, runId: null, allocation, spent: 0, isolated: isolatedTeam(sessionTeam), done: Promise.resolve() };
        live.set(made.attempt.id, entry);
        mine.add(made.attempt.id);
        entry.done = runTurn({ item, step, attempt: made.attempt, agent, evidence: current, boundary: launch.boundary(made.attempt), entry, turn: launch.turn(made.attempt, agent), workspace: input.workspace })
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
        return "started";
      };

      const noBudget = (key: string): AgentEvent => ({
        type: "error",
        message: `The team on "${step.name}" has no budget left to start **${key}** — the item's, the day's or the team's own is spent — so EO decided nothing. Raise the budget to let it go on.`,
        retryable: false,
      });

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
          const questionOf = questionStateOf(item.id);
          const baseState = (attempt: TeamAttemptRow): TeamAttemptState => ({
            id: attempt.id,
            key: attempt.assignmentKey,
            status: attempt.status,
            supersededBy: attempt.supersededBy,
            outcome: attempt.outcome,
            report: attempt.status === "completed" ? reportText(db, attempt) : null,
            error: attempt.error,
            baseline: evidenceContentKey(attempt.evidenceBaseline),
            live: live.has(attempt.id),
            round: attempt.round,
            reportId: attempt.reportCommentId,
            question: questionOf(attempt),
          });

          // ── One pass of the team's own kind ─────────────────────
          const pass = sessionTeam.coordination === "independent" ? independentPass(sessionTeam, attempts, baseState) : leaderPass(sessionTeam, attempts, baseState);
          if (pass.kind === "again") continue;
          if (pass.kind === "end") {
            yield pass.event;
            return;
          }
          if (pass.kind === "settle" || pass.kind === "undecided") {
            const checked = await stillCurrent();
            if (checked.kind === "moved") continue;
            if (checked.kind === "stop") {
              endTeamSession(db, { sessionId, status: "failed", now: deps.now() });
              yield { type: "error", message: checked.message, retryable: false };
              return;
            }
            // Parked rather than ended (EO-849): the session stays the item's,
            // so a person can retry what failed without the accepted reports
            // being done again, or cancel it to start afresh.
            if (pass.kind === "undecided") {
              yield pass.event;
              return;
            }
            const ended = endTeamSession(db, { sessionId, status: "finalized", result: pass.result, ...(pass.finalCommentId === null ? {} : { finalCommentId: pass.finalCommentId as Uuid }), now: deps.now() });
            if (!ended.ok) {
              yield { type: "error", message: ended.problem, retryable: true };
              return;
            }
            yield { type: "result", data: pass.answer };
            return;
          }
          if (pass.kind === "broke") {
            await stopAll("The budget ran out.");
            endTeamSession(db, { sessionId, status: "failed", now: deps.now() });
            yield noBudget(pass.key);
            return;
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

      type Pass =
        | { kind: "again" }
        | { kind: "wait" }
        | { kind: "end"; event: AgentEvent }
        | { kind: "settle"; result: string; answer: unknown; finalCommentId: string | null }
        /** Settled without a result: said once the evidence is known to be current, as a result would be. */
        | { kind: "undecided"; event: AgentEvent }
        | { kind: "broke"; key: string };

      /** The team waits on a person: its run ends awaiting input, the session left open for the reply. */
      function parkOn(attempts: readonly TeamAttemptRow[]): Pass {
        return { kind: "end", event: { type: "result", data: openQuestions(item.id, attempts) } };
      }

      function supersededAttempt(attempts: readonly TeamAttemptRow[], id: string | null): TeamAttemptRow | undefined {
        return id === null ? undefined : attempts.find((attempt) => attempt.id === id);
      }

      // ── An independent team (EO-846) ───────────────────────────
      function independentPass(teamNow: IndependentTeam, attempts: readonly TeamAttemptRow[], stateOf: (attempt: TeamAttemptRow) => TeamAttemptState): Pass {
        const plan = planIndependentTeam({ team: teamNow, attempts: attempts.map(stateOf), baseline: currentKey });
        // Reconciled before anything replaces them.
        if (fenceAll(plan.fence, attempts)) return { kind: "again" };

        if (plan.decision.status !== "pending" && plan.working.length === 0) {
          if (plan.decision.status === "decided") return { kind: "settle", result: plan.decision.result, answer: { result: plan.decision.result, summary: plan.decision.summary }, finalCommentId: null };
          return {
            kind: "undecided",
            event: {
              type: "error",
              message: `The team on "${step.name}" could not decide: ${plan.decision.failed.map((key) => `**${key}**`).join(", ")} could not contribute after ${team.limits.maxRetries} ${team.limits.maxRetries === 1 ? "retry" : "retries"}, and a required participant that did not contribute is never read as a finding.\n\n${plan.decision.summary}\n\n${TEAM_RETRY_WORDS}`,
              retryable: false,
            },
          };
        }
        // Waiting on a person and on nothing else: the session parks.
        if (plan.asking.length > 0 && plan.working.length === 0 && plan.start.length === 0 && plan.waiting.length === 0) return parkOn(attempts);

        const outstanding = plan.start.length + plan.waiting.length;
        let started = 0;
        for (const start of plan.start) {
          const participant = teamNow.participants.find((one) => one.key === start.key)!;
          const exchange = exchangeOf(item.id, attempts, supersededAttempt(attempts, start.supersedes));
          const outcome = startTurn({
            key: start.key,
            role: participant.role,
            instructions: participant.instructions,
            round: 1,
            supersedes: start.supersedes,
            outstanding: outstanding - started,
            boundary: () => ({ visibleThrough, exposedCommentIds: exchange.ids, hiddenCommentIds: sessionReportIds(sessionId) }),
            turn: (attempt, agent) => ({
              instructions: participantInstructions(agent, step, teamNow),
              context: participantContext(itemNow(), teamNow.outcomes, participant.key, participant.instructions, exchange.lines, isolatedTeam(teamNow)),
              outputSchema: participantTurnSchema(teamNow.outcomes),
              take: takeReport(attempt.id, teamNow.outcomes),
            }),
          });
          if (outcome === "broke") return { kind: "broke", key: start.key };
          if (outcome === "started") started += 1;
        }
        for (const waiting of plan.waiting) tell(waiting.key, waitWords(waiting.reason, team), "capacity");
        return { kind: "wait" };
      }

      // ── A leader's team (EO-847) ───────────────────────────────
      function leaderPass(teamNow: LeaderTeam, attempts: readonly TeamAttemptRow[], stateOf: (attempt: TeamAttemptRow) => TeamAttemptState): Pass {
        const states: LeaderAttemptState[] = attempts.map((attempt) => ({
          ...stateOf(attempt),
          round: attempt.round,
          verdict: attempt.assignmentKey === LEADER_ASSIGNMENT_KEY && attempt.status === "completed" ? (leaderRecordOf(db, attempt)?.verdict ?? null) : null,
        }));
        const ledger = leaderLedger(states, currentKey);
        const plan = planLeaderTeam({ team: teamNow, attempts: states, baseline: currentKey });
        if (fenceAll(plan.fence, attempts)) return { kind: "again" };

        if (plan.next.kind === "finalize") {
          const attemptId = plan.next.attemptId;
          const leaderAttempt = attempts.find((attempt) => attempt.id === attemptId)!;
          const record = leaderRecordOf(db, leaderAttempt);
          // The key the answer was checked as, else its own `result`, for a record written before keys were kept.
          const result = record?.resultKey ?? reportedResult(record?.value);
          if (record === null || result === null) {
            endTeamSession(db, { sessionId, status: "failed", now: deps.now() });
            return { kind: "end", event: { type: "error", message: `EO could not read back the leader's accepted answer on "${step.name}", so it settled nothing.`, retryable: false } };
          }
          return { kind: "settle", result, answer: record.value, finalCommentId: leaderAttempt.reportCommentId };
        }
        // Parked rather than ended (EO-849), for the independent team's reason.
        if (plan.next.kind === "failed") {
          return { kind: "end", event: { type: "error", message: `The team on "${step.name}" could not finish: ${plan.next.reason}\n\n${TEAM_RETRY_WORDS}`, retryable: false } };
        }
        if (plan.next.kind === "park") return parkOn(attempts);

        const outstanding = plan.start.length + plan.waiting.length;
        let started = 0;
        for (const start of plan.start) {
          const previous = supersededAttempt(attempts, start.supersedes);
          const launched = start.key === LEADER_ASSIGNMENT_KEY ? startLeader(teamNow, start, previous, attempts, states, ledger, outstanding - started) : startAssignment(teamNow, start, previous, attempts, ledger, outstanding - started);
          if (launched === "broke") return { kind: "broke", key: start.key };
          if (launched === "started") started += 1;
        }
        for (const waiting of plan.waiting) tell(waiting.key, waitWords(waiting.reason, team), "capacity");
        return { kind: "wait" };
      }

      function startAssignment(
        teamNow: LeaderTeam,
        start: TeamStart,
        previous: TeamAttemptRow | undefined,
        attempts: readonly TeamAttemptRow[],
        ledger: LeaderLedger,
        outstanding: number,
      ): "started" | "skipped" | "broke" {
        const assignment = ledger.assignments.find((one) => one.key === start.key)!;
        const exchange = exchangeOf(item.id, attempts, previous);
        // A follow-up is shown what it said before, which its new instructions answer.
        const earlier = start.why === "followup" && previous !== undefined && previous.reportCommentId !== null ? previous : undefined;
        const extra = [
          ...(earlier === undefined ? [] : ["## Your earlier report on this assignment", "", reportText(db, earlier) ?? "", "", "The leader has asked you to follow up on it: the instructions above are its follow-up."]),
          ...exchange.lines,
        ];
        return startTurn({
          key: start.key,
          role: assignment.role,
          instructions: assignment.instructions,
          round: start.round ?? assignment.round,
          supersedes: start.supersedes,
          outstanding,
          boundary: () => ({
            visibleThrough,
            exposedCommentIds: [...exchange.ids, ...(earlier === undefined || earlier.reportCommentId === null ? [] : [earlier.reportCommentId])],
            hiddenCommentIds: sessionReportIds(sessionId),
          }),
          turn: (attempt, agent) => ({
            instructions: participantInstructions(agent, step, teamNow),
            context: participantContext(itemNow(), teamNow.outcomes, assignment.key, assignment.instructions, extra, isolatedTeam(teamNow)),
            outputSchema: participantTurnSchema(teamNow.outcomes),
            // A contributor that tries to hand work on is refused, and the
            // refusal is recorded where the person and the leader read it.
            take: takeReport(attempt.id, teamNow.outcomes, (error) => note(item, parentRunId, `**${assignment.key}** tried to assign work, which only the leader may do: ${error}`)),
          }),
        });
      }

      function startLeader(
        teamNow: LeaderTeam,
        start: TeamStart,
        previous: TeamAttemptRow | undefined,
        attempts: readonly TeamAttemptRow[],
        states: readonly LeaderAttemptState[],
        ledger: LeaderLedger,
        outstanding: number,
      ): "started" | "skipped" | "broke" {
        const exchange = exchangeOf(item.id, attempts, previous);
        const reportIds = ledger.contributions.flatMap((one) => (one.reportId === null ? [] : [one.reportId]));
        const leaderIds = attempts.flatMap((attempt) => (attempt.assignmentKey === LEADER_ASSIGNMENT_KEY && attempt.reportCommentId !== null ? [attempt.reportCommentId] : []));
        return startTurn({
          key: LEADER_ASSIGNMENT_KEY,
          role: teamNow.leader.role,
          instructions: teamNow.leader.instructions,
          round: start.round ?? 1,
          supersedes: start.supersedes,
          outstanding,
          // The leader reads every current report, its own earlier turns
          // and what it asked: the reports are why its next turn exists.
          boundary: () => ({ visibleThrough, exposedCommentIds: [...reportIds, ...leaderIds, ...exchange.ids] }),
          turn: (attempt, agent) => ({
            instructions: leaderInstructions(agent, step, teamNow),
            context: leaderContext(teamNow, start, previous, attempts, states, ledger, exchange.lines),
            outputSchema: leaderTurnSchema(teamNow, input.answer!.document!),
            take: takeLeader(teamNow, attempt),
          }),
        });
      }

      /**
       * What EO makes of a leader's answer (EO-847), kept on its run before
       * its comment is posted, so a restart between the two redoes the turn
       * rather than reading half of it. A request for work is held to the
       * team's roles and limits; a final answer to the reports and to the
       * step's action. Either way the leader's words go on the thread, and
       * what EO refused goes with them.
       */
      function takeLeader(teamNow: LeaderTeam, attempt: TeamAttemptRow): TurnSpec["take"] {
        return (answer, runId, at, appendix) => {
          const read = readLeaderAnswer(answer);
          if (read.kind === "invalid") return { kind: "failed", error: read.error };
          if (read.kind === "asked") return { kind: "asked", asked: read.asked };
          const states: LeaderAttemptState[] = listTeamAttempts(db, sessionId).map((one) => ({
            id: one.id,
            key: one.assignmentKey,
            status: one.status,
            supersededBy: one.supersededBy,
            outcome: one.outcome,
            report: null,
            error: one.error,
            baseline: evidenceContentKey(one.evidenceBaseline),
            live: false,
            round: one.round,
            reportId: one.reportCommentId,
            verdict: one.assignmentKey === LEADER_ASSIGNMENT_KEY && one.status === "completed" ? (leaderRecordOf(db, one)?.verdict ?? null) : null,
          }));
          const ledger = leaderLedger(states, currentKey);
          let record: LeaderTurnRecord;
          let words: string;
          let refusal: string | null = null;
          if (read.kind === "assign") {
            const verdict = checkLeaderAssignments(teamNow, ledger, read.request.assignments);
            record = { leader: true, answer, verdict };
            const known = new Set(ledger.keys);
            words = [
              verdict.accepted.length === 0 ? `Asked for round ${attempt.round} of work; EO accepted none of it.` : `Assigns round ${attempt.round}:`,
              ...verdict.accepted.map((one) => `- **${one.key}** (${one.role}${one.required ? "" : ", optional"}${known.has(one.key) ? ", follow-up" : ""}): ${one.instructions}`),
              ...(read.request.note.trim() === "" ? [] : ["", read.request.note.trim()]),
            ].join("\n");
            if (verdict.refused.length > 0) {
              refusal = `EO refused ${verdict.refused.length === 1 ? "an assignment" : `${verdict.refused.length} assignments`} the leader asked for:\n\n${verdict.refused.map((one) => `- **${one.key}**: ${one.reason}`).join("\n")}`;
            }
          } else {
            const problems = leaderFinalProblems(ledger, states, read.final.contributions);
            // The result key first, said as such: a key the action does
            // not declare would route nowhere, whatever else is right.
            const declared = input.answer!.results;
            const resultOf = input.answer!.resultOf ?? reportedResult;
            const undeclared = (result: string | null): string | null => {
              if (result === null) return null;
              return declared.includes(result) ? null : `Its result "${result}" is not one "${step.entryAction ?? ""}" declares (${declared.join(", ")}).`;
            };
            let value: unknown = undefined;
            let resultKey: string | null = null;
            const raw = undeclared(reportedResult(read.final.answer));
            if (raw !== null) problems.push(raw);
            else {
              const checked = input.answer!.validate(read.final.answer);
              const key = checked.ok ? resultOf(checked.value) : null;
              if (!checked.ok) problems.push(`Its answer is not a valid "${step.entryAction ?? ""}" answer: ${checked.error}`);
              else if (key === null) problems.push(`Its answer names no result, and "${step.entryAction ?? ""}" needs one of ${declared.join(", ")}.`);
              else {
                const after = undeclared(key);
                if (after !== null) problems.push(after);
                else {
                  value = checked.value;
                  resultKey = key;
                }
              }
            }
            // A result its own reports rule out (EO-873), by what the
            // team declares, unless the leader says which it overruled.
            if (resultKey !== null) problems.push(...ruledOutProblems(teamNow.outcomes, ledger.contributions, resultKey, read.final.disagreements));
            const verdict: LeaderVerdict = { decision: "final", accepted: problems.length === 0, problems, contributions: read.final.contributions };
            record = { leader: true, answer, verdict, ...(verdict.accepted ? { value, ...(resultKey === null ? {} : { resultKey }) } : {}) };
            const summary = (read.final.answer as { summary?: unknown } | null)?.summary;
            words = [
              `Answers the step${(resultKey ?? reportedResult(read.final.answer)) === null ? "" : ` — ${resultKey ?? reportedResult(read.final.answer)}`}`,
              "",
              typeof summary === "string" ? summary : JSON.stringify(read.final.answer),
              "",
              `**Relies on:** ${read.final.contributions.length === 0 ? "nothing named" : read.final.contributions.join(", ")}`,
              `**Disagreements:** ${read.final.disagreements}`,
              `**Limitations:** ${read.final.limitations}`,
            ].join("\n");
            if (!verdict.accepted) refusal = `EO did not accept the leader's final answer:\n\n${problems.map((problem) => `- ${problem}`).join("\n")}`;
          }
          updateRun(db, runId, { result: record as unknown as Record<string, unknown> });
          const accepted = acceptTeamReport(db, { attemptId: attempt.id, outcome: null, report: appendix === null ? words : `${words}\n\n${appendix}`, now: at });
          if (!accepted.ok) return { kind: "late", problem: accepted.problem };
          if (refusal !== null) note(item, parentRunId, refusal);
          return { kind: "accepted", result: record };
        };
      }
    } finally {
      parents.delete(parentRunId);
    }

    async function capture() {
      return captureTeamEvidence({ db, item: itemNow(), workspace: input.workspace, now: deps.now(), signal });
    }

    /** The item as it is now: what a turn is told is what its baseline's task records, never the item as it was dispatched. */
    function itemNow(): Item {
      return getItem(db, item.id) ?? item;
    }

    function staleSession(session: TeamSessionRow | undefined): string | null {
      if (session === undefined) return "The team's session is gone.";
      if (session.status === "superseded") return "A newer team session replaced this one, so EO stopped its participants.";
      if (session.status !== "open") return `The team's session has already ended (${session.status}).`;
      if (!teamSessionOnEntry(db, session)) return "The item has left the step its team was working on, so EO stopped the team's participants.";
      return null;
    }

    function leaderInstructions(agent: Agent, stepNow: PipelineStep, teamNow: LeaderTeam): string {
      const isolated = isolatedTeam(teamNow);
      return [
        // An isolated leader's own instructions come first, as on any
        // dispatch of its agent; this is the framing after them (EO-867).
        ...(isolated ? ["## Your part in a team", ""] : []),
        `You are ${agent.name}, the leader of a team EO runs on the step "${stepNow.name}". You plan the work, assign focused pieces of it to agents of the roles the team permits, read their reports, and answer the step yourself.`,
        "",
        isolated ? ISOLATED.replace(" and you are not shown the other members' reports.", " and you read the members' reports below, as EO gives them to you.") : REPORT_ONLY,
        "",
        "You act only through your answer, and every answer ends your turn:",
        "- **assign** a round of work: each assignment a key, a permitted role, focused instructions and whether you cannot answer without it. EO runs what it accepts and starts your next turn with the reports. Name an earlier key again to ask that assignment to follow up; its earlier report is then superseded. Participants cannot assign work on.",
        "- **final**: answer the step's action. Name in `contributions` the ids of the reports you relied on — only current ones, never a superseded report — say where they disagreed and how you settled it, and what you could not establish. EO checks that every required assignment has reported and that your answer is a valid answer to the step; saying the work is done does not make it so.",
        `- or ${ASKING.charAt(0).toLowerCase()}${ASKING.slice(1)}`,
        "",
        `Limits: at most ${teamNow.limits.maxRounds} round${teamNow.limits.maxRounds === 1 ? "" : "s"} of assignments, ${teamNow.limits.maxParticipants} participants in all, ${teamNow.limits.maxParallel} at a time. EO refuses what goes past them and tells you why.`,
        ...(isolated || agent.instructions.trim() === "" ? [] : ["", "## Your standing instructions", "", agent.instructions.trim()]),
      ].join("\n");
    }

    function leaderContext(
      teamNow: LeaderTeam,
      start: TeamStart,
      previous: TeamAttemptRow | undefined,
      attempts: readonly TeamAttemptRow[],
      states: readonly LeaderAttemptState[],
      ledger: LeaderLedger,
      exchange: readonly string[],
    ): string {
      const why: Record<TeamStart["why"], string> = {
        first: "This is your first turn: nothing has been assigned yet.",
        reports: "The round you assigned has settled: every assignment has reported or failed. Read the reports below and either assign a follow-up round or answer the step.",
        correction: "EO could not act on your last answer — see why below. Answer again.",
        retry: "Your last turn failed before it answered. Answer again.",
        interrupted: "Your last turn was stopped before it answered. Answer again.",
        stale: "What the team reads — the item's files, attachments or its own description — changed after your last answer, so that answer is not used: any reports were made again on the new version. Read what is there now and answer again.",
        answered: "The person has answered what you asked. Carry on with their answer.",
        followup: "",
      };
      const now = itemNow();
      const lines: string[] = [
        // An isolated leader's context is the step's ordinary one, the item
        // included, with this after it (EO-867).
        ...(isolatedTeam(teamNow) ? [] : [`# ${now.key} — ${now.title}`, "", now.body ?? "", ""]),
        "## What you lead",
        "",
        `You answer the step's action, \`${step.entryAction ?? ""}\`, whose results are ${input.answer!.results.map((key) => `\`${key}\``).join(", ")}.`,
        "",
        teamNow.leader.instructions,
        "",
        `Roles you may assign: ${teamNow.roles.join(", ")}. Rounds used: ${ledger.roundsUsed} of ${teamNow.limits.maxRounds}. Participants: ${ledger.keys.length} of ${teamNow.limits.maxParticipants}.`,
        ...(teamNow.outcomes.length === 0 ? [] : ["", "Each participant reports one of these outcomes:", "", ...outcomeLines(teamNow.outcomes), ...rulesOutLines(teamNow.outcomes)]),
        "",
        "## This turn",
        "",
        why[start.why] || why.reports,
      ];
      const lastRecord = previous === undefined || previous.status !== "completed" ? null : leaderRecordOf(db, previous);
      if (lastRecord?.verdict.decision === "final" && !lastRecord.verdict.accepted) lines.push("", "Why EO refused your final answer:", "", ...lastRecord.verdict.problems.map((problem) => `- ${problem}`));
      if (lastRecord?.verdict.decision === "assign" && lastRecord.verdict.refused.length > 0) {
        lines.push("", "Assignments EO refused:", "", ...lastRecord.verdict.refused.map((one) => `- **${one.key}**: ${one.reason}`));
      }
      if (previous?.status === "failed" && previous.error !== null) lines.push("", `What went wrong: ${previous.error}`);
      lines.push("", "## The assignments and their reports", "");
      if (ledger.assignments.length === 0) lines.push("Nothing has been assigned yet.");
      for (const assignment of ledger.assignments) {
        const latest = states.find((state) => state.key === assignment.key && state.round === assignment.round && state.supersededBy === null);
        const contribution = ledger.contributions.find((one) => one.key === assignment.key);
        const head = `### ${assignment.key} — ${assignment.role}, ${assignment.required ? "required" : "optional"}, round ${assignment.round}`;
        lines.push(head, "", `Asked: ${assignment.instructions}`, "");
        if (contribution !== undefined) {
          const label = teamNow.outcomes.find((outcome) => outcome.key === contribution.outcome)?.label;
          lines.push(`Report (comment ${contribution.reportId ?? "?"})${label === undefined ? "" : ` — ${label}`}:`, "", contribution.report ?? "", "");
        } else if (latest?.status === "failed") lines.push(`It could not contribute: ${latest.error ?? "no reason given"}.`, "");
        else lines.push("No current report.", "");
      }
      const refusedBefore = attempts.filter((attempt) => attempt.assignmentKey !== LEADER_ASSIGNMENT_KEY && attempt.status === "failed" && attempt.supersededBy === null && attempt.error?.startsWith("A contributor cannot hand work on") === true);
      if (refusedBefore.length > 0) lines.push("Contributors that tried to assign work were refused; only you assign.", "");
      lines.push(...exchange);
      return lines.join("\n");
    }
  }

  /**
   * What a finalised session settled on, provided every report it rests on
   * was made on the evidence as it is now (`currentKey`); `stale` where any
   * was not, and the team must run again. An independent team's is rebuilt
   * from its reports, deterministic, so the same as when it settled; a
   * leader's is the accepted answer kept on its turn's run.
   */
  function settledAnswer(session: TeamSessionRow, currentKey: string): { kind: "replay"; answer: unknown } | { kind: "stale" } | { kind: "none" } {
    if (session.result === null) return { kind: "none" };
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
      round: attempt.round,
      reportId: attempt.reportCommentId,
    }));
    if (session.team.coordination === "leader") {
      const leaderStates: LeaderAttemptState[] = states.map((state, index) => ({
        ...state,
        round: attempts[index]!.round,
        verdict: state.key === LEADER_ASSIGNMENT_KEY && state.status === "completed" ? (leaderRecordOf(db, attempts[index]!)?.verdict ?? null) : null,
      }));
      const final = attempts.findIndex((attempt) => attempt.assignmentKey === LEADER_ASSIGNMENT_KEY && attempt.supersededBy === null && attempt.status === "completed");
      const record = final === -1 ? null : leaderRecordOf(db, attempts[final]!);
      if (record === null || record.verdict.decision !== "final" || !record.verdict.accepted) return { kind: "none" };
      // The leader's own reading counts as much as its reports: an answer
      // it gave from evidence that has moved is not replayed, reports or none.
      if (!finalStands(leaderLedger(leaderStates, currentKey), leaderStates, leaderStates[final]!, currentKey)) return { kind: "stale" };
      return { kind: "replay", answer: record.value };
    }
    const latestCompleted = states.filter((state) => state.supersededBy === null && state.status === "completed");
    if (latestCompleted.some((state) => state.baseline !== currentKey)) return { kind: "stale" };
    const plan = planIndependentTeam({ team: session.team, attempts: states, baseline: currentKey });
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
    liveCount: () => live.size,
    liveMember: (attemptId) => {
      const one = live.get(attemptId);
      return one === undefined || !one.isolated || one.runId === null ? null : { runId: one.runId, agentId: one.agentId, itemId: one.itemId };
    },
    isLive: (attemptId) => live.has(attemptId),
    reconcileOrphans,
    ownsInterruptedRun: (run) => {
      if (run.stepId === null) return false;
      const latest = listTeamSessionsForItem(db, run.itemId).at(-1)?.session;
      return latest !== undefined && latest.stepId === run.stepId && (latest.status === "open" || latest.status === "finalized") && teamSessionOnEntry(db, latest);
    },
  };
}

/** Why an assignment waits for room: the team's own limit, the only one its turns answer to (EO-871). */
function waitWords(_reason: TeamWaitReason, team: StepTeam): string {
  return `the team runs ${team.limits.maxParallel} participant${team.limits.maxParallel === 1 ? "" : "s"} at a time, and that many are working. It starts as one finishes.`;
}
