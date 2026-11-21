import { decideIndependentTeam, LEADER_ASSIGNMENT_KEY } from "@eo/core";
import type { IndependentTeam, LeaderAssignment, LeaderTeam, TeamContribution, TeamDecision, TeamOutcome } from "@eo/core";

/**
 * What an independent team's supervisor does next (EO-846, ARCHITECTURE.md,
 * "A team on an agent step").
 *
 * Pure (invariant 2): the host reads the session's attempts and the
 * evidence it holds now, and hands them here as data; this
 * says which assignments to start, which attempts to let go, who waits and
 * why, and what the settled contributions come to. It writes nothing,
 * starts nothing and reads no clock. The host does what it says, through
 * the session's repository and the item's one routing decision.
 *
 * Opaque on purpose. An attempt's evidence is a `baseline` string the host
 * derived from what was captured — the content, not where it was or when —
 * so two captures of the same content compare equal and a changed source
 * compares different, and nothing here knows what a source is.
 */

/** One attempt as the planner reads it. */
export interface TeamAttemptState {
  id: string;
  key: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  /** The attempt that replaced it, or null for the latest at its assignment. */
  supersededBy: string | null;
  /** On a completed attempt: the declared outcome its accepted report concluded. */
  outcome: string | null;
  /** On a completed attempt: the accepted report's text, for the summary. */
  report: string | null;
  /** On a failed or cancelled attempt: what went wrong. */
  error: string | null;
  /** The content of the evidence it was given, as the host keys it; null where it was given none. */
  baseline: string | null;
  /** A provider turn of this process is working it now. */
  live: boolean;
  /** The round it works (a leader's teams, EO-847); 1 where left out. */
  round?: number;
  /** On a completed attempt: the comment its accepted report was posted as. */
  reportId?: string | null;
  /**
   * On an attempt that ended asking the person (EO-847): whether every
   * question it asked has a reply yet. Derived by the host from the
   * thread, never stored. Null or left out where it asked nothing.
   */
  question?: "open" | "answered" | null;
}

/**
 * Why an assignment that needs a turn has not been given one yet: the team
 * already runs as many participants at once as it allows. Nothing else
 * bounds a team's turns (EO-871) — no agent's cap and no machine-wide
 * limit: the session is one run against EO's caps, and the turns inside
 * it are held back only by its own `maxParallel`.
 */
export type TeamWaitReason = "team";

export interface PlanIndependentTeamInput {
  team: IndependentTeam;
  /** Every attempt the session has made, any order. */
  attempts: readonly TeamAttemptState[];
  /** The evidence as it stands now, keyed as the attempts' are. */
  baseline: string;
}

/** A turn to start: a new attempt at `key`, replacing `supersedes` where there was one. */
export interface TeamStart {
  key: string;
  supersedes: string | null;
  /**
   * Why a turn is needed: the assignment's first, a retry of a failure, a
   * replacement for one EO stopped, work done on evidence that has since
   * changed, a person's reply to what it asked (EO-847), or — on a
   * leader's team — a follow-up the leader asked for, and the leader's own
   * next turn with the reports, or to correct an answer EO refused.
   */
  why: "first" | "retry" | "interrupted" | "stale" | "answered" | "followup" | "reports" | "correction";
  /** The round the turn works: always 1 on an independent team. */
  round?: number;
}

export interface TeamPlan {
  /**
   * Attempts the host must stop or end before anything replaces them:
   * running or queued but worked by no turn of this process (EO stopped
   * while they ran), or worked on evidence that has since changed. A live
   * one is stopped; one nobody works is ended as cancelled.
   */
  fence: { attemptId: string; why: "orphaned" | "stale" }[];
  /** Assignments to give a turn now, in the team's order, within every limit. */
  start: TeamStart[];
  /** Assignments that need a turn and cannot have one yet, with why. */
  waiting: { key: string; reason: TeamWaitReason }[];
  /** Assignments whose failures used up their retries: each is a failed contribution. */
  exhausted: string[];
  /** Turns still being worked, by attempt. */
  working: string[];
  /**
   * Assignments waiting on a person's reply to what they asked (EO-847):
   * neither replaced nor counted as a failure, and nothing is decided
   * until they are answered.
   */
  asking: string[];
  /** What the settled contributions come to; `pending` until every assignment has settled on the current evidence. */
  decision: TeamDecision;
}

const ENDED = new Set(["completed", "failed", "cancelled"]);

/**
 * Plans an independent team's next step from its attempts (EO-846).
 *
 * Per assignment, the latest attempt (the one nothing replaced) decides:
 *
 * - none yet: the assignment needs its first turn;
 * - completed on the evidence as it stands: a contribution, kept — a
 *   sibling's retry does not touch it;
 * - completed, running or queued on evidence that has changed: stale.
 *   It is fenced (a live turn stopped) and the assignment needs a turn on
 *   the evidence as it is; a stale report is never decided on;
 * - running or queued with no live turn: EO stopped while it ran. It is
 *   ended as cancelled — never read as a failure or a finding — and
 *   replaced;
 * - cancelled: replaced, and not counted against the retries, since the
 *   participant did nothing wrong;
 * - failed: retried while the assignment has failed no more than the
 *   team's `maxRetries` times; past that it is a failed contribution,
 *   which `decideIndependentTeam` keeps apart from any conclusion.
 *
 * Turns are handed out in the team's order and only within the team's own
 * `maxParallel` (EO-871). What cannot start waits, with why, so a person
 * can be told rather than left looking at nothing moving.
 *
 * Nothing is decided while any assignment is unsettled on the current
 * evidence, so a crash, a missing contribution or a stale report can
 * never reach the fallback.
 */
export function planIndependentTeam(input: PlanIndependentTeamInput): TeamPlan {
  const { team, baseline } = input;
  const byKey = new Map<string, TeamAttemptState[]>();
  for (const attempt of input.attempts) {
    const list = byKey.get(attempt.key) ?? [];
    list.push(attempt);
    byKey.set(attempt.key, list);
  }

  const fence: TeamPlan["fence"] = [];
  const needs: TeamStart[] = [];
  const exhausted: string[] = [];
  const working: string[] = [];
  const asking: string[] = [];
  const contributions: TeamContribution[] = [];

  for (const participant of team.participants) {
    const attempts = byKey.get(participant.key) ?? [];
    const state = assignmentState(participant.key, attempts, null, baseline, team.limits.maxRetries);
    fence.push(...state.fence);
    needs.push(...state.needs);
    working.push(...state.working);
    if (state.asking) asking.push(participant.key);
    if (state.settled?.status === "completed") {
      contributions.push({ key: participant.key, status: "completed", outcome: state.settled.attempt.outcome ?? "", report: state.settled.attempt.report ?? "" });
    } else if (state.settled?.status === "failed") {
      exhausted.push(participant.key);
      contributions.push({ key: participant.key, status: "failed", error: state.settled.attempt.error ?? "It could not contribute." });
    }
  }

  const { start, waiting } = allot(needs, working.length, team.limits.maxParallel);
  const settled = needs.length === 0 && working.length === 0 && fence.length === 0 && asking.length === 0;
  const decision: TeamDecision = settled
    ? decideIndependentTeam(team, contributions)
    : { status: "pending", waitingOn: team.participants.filter((participant) => !contributions.some((one) => one.key === participant.key)).map((participant) => participant.key) };
  return { fence, start, waiting, exhausted, working, asking, decision };
}

/** Where one assignment stands, from its attempts: what to fence, what it needs, what is working, and what it settled on. */
interface AssignmentState {
  fence: TeamPlan["fence"];
  needs: TeamStart[];
  working: string[];
  asking: boolean;
  settled: { status: "completed" | "failed"; attempt: TeamAttemptState } | null;
}

/**
 * One assignment's next step from its attempts (EO-846), the latest — the
 * one nothing replaced — deciding. `round` narrows the attempts to one
 * round of a leader's team, where an earlier round's latest attempt is the
 * one a follow-up supersedes; null reads them all, as an independent team
 * has one round.
 */
function assignmentState(key: string, all: readonly TeamAttemptState[], round: number | null, baseline: string, maxRetries: number): AssignmentState {
  const state: AssignmentState = { fence: [], needs: [], working: [], asking: false, settled: null };
  const attempts = round === null ? all : all.filter((attempt) => (attempt.round ?? 1) === round);
  const at = round === null ? {} : { round };
  const latest = attempts.find((attempt) => attempt.supersededBy === null) ?? null;
  if (latest === null) {
    // A follow-up replaces what the earlier round's attempt said, once that has stopped.
    const earlier = round === null ? null : (all.find((attempt) => attempt.supersededBy === null) ?? null);
    if (earlier !== null && !ENDED.has(earlier.status)) {
      if (earlier.live) state.working.push(earlier.id);
      else state.fence.push({ attemptId: earlier.id, why: "orphaned" });
      return state;
    }
    state.needs.push({ key, supersedes: earlier?.id ?? null, why: earlier === null ? "first" : "followup", ...at });
    return state;
  }
  const current = latest.baseline === baseline;
  if (!ENDED.has(latest.status)) {
    if (!latest.live) {
      state.fence.push({ attemptId: latest.id, why: "orphaned" });
      state.needs.push({ key, supersedes: latest.id, why: current ? "interrupted" : "stale", ...at });
    } else {
      // A stale live turn is replaced once its turn has stopped: until then it is still live.
      if (!current) state.fence.push({ attemptId: latest.id, why: "stale" });
      state.working.push(latest.id);
    }
    return state;
  }
  if (latest.status === "completed") {
    if (current) state.settled = { status: "completed", attempt: latest };
    else state.needs.push({ key, supersedes: latest.id, why: "stale", ...at });
    return state;
  }
  if (latest.status === "cancelled") {
    // It asked the person, who has not answered every question yet: it
    // waits for them, neither replaced nor counted (EO-847).
    if (latest.question === "open") {
      state.asking = true;
      return state;
    }
    // Answered, it is started again with the answer — on the evidence as
    // it is now, which is checked like any other turn's.
    const why = !current ? "stale" : latest.question === "answered" ? "answered" : "interrupted";
    state.needs.push({ key, supersedes: latest.id, why, ...at });
    return state;
  }
  // Failed. Only failures are counted: an attempt EO stopped, one that
  // asked, or one superseded because the evidence moved, is not the
  // participant's.
  const failures = attempts.filter((attempt) => attempt.status === "failed").length;
  if (failures <= maxRetries) {
    state.needs.push({ key, supersedes: latest.id, why: "retry", ...at });
    return state;
  }
  state.settled = { status: "failed", attempt: latest };
  return state;
}

/**
 * Turns, within the one bound there is: the team's `maxParallel` less what
 * is working. A stale turn still being stopped holds its slot until it has.
 */
function allot(needs: readonly TeamStart[], workingCount: number, maxParallel: number): { start: TeamStart[]; waiting: TeamPlan["waiting"] } {
  let teamFree = Math.max(0, maxParallel - workingCount);
  const start: TeamStart[] = [];
  const waiting: TeamPlan["waiting"] = [];
  for (const need of needs) {
    // A replacement for a live stale turn waits for it to stop.
    if (teamFree <= 0) {
      waiting.push({ key: need.key, reason: "team" });
      continue;
    }
    teamFree -= 1;
    start.push(need);
  }
  return { start, waiting };
}

/** One spending ceiling a participant's turn is under: what it has left, and what turns under it already hold. */
export interface BudgetCeiling {
  /** What may still be spent under this ceiling, in cents, from spending already persisted. */
  remainingCents: number;
  /**
   * What turns running under this same ceiling were allocated and have not
   * yet spent: held for them, not handed out again. Only turns the ceiling
   * covers — an item's budget is not held by another item's turns, and a
   * team's own is not held by another team's — while the day's is held by
   * every turn running today.
   */
  heldCents: number;
}

export interface ParticipantBudgetInput {
  /** Every ceiling the turn is under — the item's, the day's, the team's own — each with its own holdings. None is no cap. */
  ceilings: readonly BudgetCeiling[];
  /** How many assignments of this team still need a turn, this one included: the share each is owed. */
  outstanding: number;
}

/**
 * What one participant's turn may spend (EO-846), or null where nothing
 * is capped.
 *
 * Shared, not copied. Every turn running at once would otherwise be handed
 * the whole of what the item or the day has left, and together spend it
 * several times over before any of them reported. So under each ceiling,
 * what is left less what running turns under that ceiling still hold is
 * divided between every assignment of this team that still needs a turn,
 * and the turn takes the smallest of those shares; a turn that finishes
 * under its share gives the rest back, because its share is no longer held
 * and its spending is.
 *
 * Each ceiling is reckoned with only the turns it covers, so one item's
 * team holding its own item's budget never shrinks another item's, and
 * only a ceiling they share — the day's — is held across them.
 *
 * Whole cents, rounded down, so the shares never add up to more than is
 * left. Zero means there is nothing to give it, and the host does not
 * start it.
 */
export function allocateParticipantBudget(input: ParticipantBudgetInput): number | null {
  if (input.ceilings.length === 0) return null;
  const shares = input.ceilings.map((ceiling) => Math.floor(Math.max(0, ceiling.remainingCents - Math.max(0, ceiling.heldCents)) / Math.max(1, input.outstanding)));
  return Math.min(...shares);
}

// ── A leader's team (EO-847) ────────────────────────────────────────

/**
 * What EO made of one of a leader's answers, kept with it so the session
 * reads the same after a restart as before: the assignments it accepted
 * and those it refused, each refusal with its reason; or, for a final
 * answer, whether it was accepted and why not.
 */
export type LeaderVerdict =
  | { decision: "assign"; accepted: LeaderAssignment[]; refused: { key: string; reason: string }[] }
  | { decision: "final"; accepted: boolean; problems: string[]; contributions: string[] };

/** One attempt on a leader's team as the planner reads it; the leader's own turns carry what EO made of their answers. */
export interface LeaderAttemptState extends TeamAttemptState {
  round: number;
  /** On a leader's completed turn: what EO made of its answer. */
  verdict?: LeaderVerdict | null;
}

/** An assignment the leader asked for and EO accepted, as it stands: the latest round naming its key. */
export interface AssignmentInForce extends LeaderAssignment {
  round: number;
}

/** A contribution the leader may rely on: the latest attempt at an assignment in force, completed on the evidence as it is. */
export interface CurrentContribution {
  key: string;
  attemptId: string;
  reportId: string | null;
  outcome: string | null;
  report: string | null;
}

/** What a leader's session holds: the assignments in force, the rounds used, and the contributions current now. */
export interface LeaderLedger {
  assignments: AssignmentInForce[];
  /** Rounds with at least one accepted assignment. */
  roundsUsed: number;
  /** Every assignment key ever accepted: the team's participants, counted against `maxParticipants`. */
  keys: string[];
  contributions: CurrentContribution[];
  /** The leader's turns in order, oldest first. */
  leaderTurns: LeaderAttemptState[];
  /** The leader's answers EO could not act on, and turns that failed: counted against `maxRetries`. */
  corrections: number;
}

function leaderTurnsOf(attempts: readonly LeaderAttemptState[]): LeaderAttemptState[] {
  return attempts.filter((attempt) => attempt.key === LEADER_ASSIGNMENT_KEY);
}

function refusedAnswer(verdict: LeaderVerdict | null | undefined): boolean {
  if (verdict === null || verdict === undefined) return false;
  return verdict.decision === "assign" ? verdict.accepted.length === 0 : !verdict.accepted;
}

/** Reads a leader's session from its attempts (EO-847). Pure: the order given is the order they were made. */
export function leaderLedger(attempts: readonly LeaderAttemptState[], baseline: string): LeaderLedger {
  const leaderTurns = leaderTurnsOf(attempts);
  const inForce = new Map<string, AssignmentInForce>();
  const rounds = new Set<number>();
  const keys: string[] = [];
  for (const turn of leaderTurns) {
    if (turn.status !== "completed" || turn.verdict?.decision !== "assign") continue;
    for (const assignment of turn.verdict.accepted) {
      inForce.set(assignment.key, { ...assignment, round: turn.round });
      rounds.add(turn.round);
      if (!keys.includes(assignment.key)) keys.push(assignment.key);
    }
  }
  const contributions: CurrentContribution[] = [];
  for (const assignment of inForce.values()) {
    const latest = attempts.find((attempt) => attempt.key === assignment.key && attempt.round === assignment.round && attempt.supersededBy === null);
    if (latest?.status === "completed" && latest.baseline === baseline) {
      contributions.push({ key: assignment.key, attemptId: latest.id, reportId: latest.reportId ?? null, outcome: latest.outcome, report: latest.report });
    }
  }
  const corrections = leaderTurns.filter((turn) => turn.status === "failed" || (turn.status === "completed" && refusedAnswer(turn.verdict))).length;
  return { assignments: [...inForce.values()], roundsUsed: rounds.size, keys, contributions, leaderTurns, corrections };
}

/**
 * What EO accepts of a leader's request for work (EO-847), each refusal
 * with its reason. Refused: a key the leader's own turns are kept under, a
 * key named twice in one request, a role the team does not permit, a new
 * participant past `maxParticipants`, and any round past `maxRounds`.
 * A key already in force is a follow-up: it supersedes what that
 * assignment said and counts as no new participant.
 */
export function checkLeaderAssignments(team: LeaderTeam, ledger: Pick<LeaderLedger, "roundsUsed" | "keys">, assignments: readonly LeaderAssignment[]): Extract<LeaderVerdict, { decision: "assign" }> {
  const accepted: LeaderAssignment[] = [];
  const refused: { key: string; reason: string }[] = [];
  if (ledger.roundsUsed >= team.limits.maxRounds) {
    const reason = `The team allows ${team.limits.maxRounds} round${team.limits.maxRounds === 1 ? "" : "s"} of assignments and all of them are used, so no more work can be assigned: answer from the reports there are.`;
    return { decision: "assign", accepted, refused: assignments.map((assignment) => ({ key: assignment.key, reason })) };
  }
  const permitted = new Set(team.roles);
  const keys = new Set(ledger.keys);
  const seen = new Set<string>();
  for (const assignment of assignments) {
    if (assignment.key === LEADER_ASSIGNMENT_KEY) {
      refused.push({ key: assignment.key, reason: `"${LEADER_ASSIGNMENT_KEY}" is the key the leader's own turns are kept under; use another.` });
      continue;
    }
    if (seen.has(assignment.key)) {
      refused.push({ key: assignment.key, reason: "The same key is named twice in one request." });
      continue;
    }
    seen.add(assignment.key);
    if (!permitted.has(assignment.role)) {
      refused.push({ key: assignment.key, reason: `The role "${assignment.role}" is not one this team permits (${team.roles.join(", ")}), and a leader cannot widen who it may assign.` });
      continue;
    }
    if (!keys.has(assignment.key) && keys.size >= team.limits.maxParticipants) {
      refused.push({ key: assignment.key, reason: `The team allows ${team.limits.maxParticipants} participant${team.limits.maxParticipants === 1 ? "" : "s"} in all and has them; a follow-up on an existing key is still possible.` });
      continue;
    }
    keys.add(assignment.key);
    accepted.push(assignment);
  }
  return { decision: "assign", accepted, refused };
}

/**
 * Why EO will not finalise on a leader's answer, from the session alone
 * (EO-847): a required assignment with no current accepted report, a
 * reliance on a report that was superseded or never accepted, or no
 * reliance named at all where reports exist. The answer's own validity
 * against the step's action is the host's to add. A leader saying the
 * work is done is not evidence that it is.
 */
export function leaderFinalProblems(ledger: Pick<LeaderLedger, "assignments" | "contributions">, attempts: readonly LeaderAttemptState[], contributions: readonly string[]): string[] {
  const problems: string[] = [];
  const current = new Map(ledger.contributions.flatMap((one) => (one.reportId === null ? [] : [[one.reportId, one] as const])));
  for (const assignment of ledger.assignments) {
    if (assignment.required && !ledger.contributions.some((one) => one.key === assignment.key)) {
      problems.push(`The required assignment **${assignment.key}** has no accepted report on the evidence as it is now.`);
    }
  }
  for (const id of new Set(contributions)) {
    if (current.has(id)) continue;
    const old = attempts.find((attempt) => attempt.reportId === id);
    if (old !== undefined) problems.push(`It relies on comment ${id}, **${old.key}**'s report, which is no longer current: it was superseded or made on evidence that has since changed.`);
    else problems.push(`It relies on comment ${id}, which is no accepted report of this team.`);
  }
  if (contributions.length === 0 && ledger.contributions.length > 0) problems.push("It names none of the reports it relied on.");
  return problems;
}

/**
 * Why EO will not take a leader's result over its own team's reports
 * (EO-873): an accepted, current report whose outcome rules that result
 * out, which the leader's `disagreements` does not overrule — a line of
 * its own, `Overruled <assignment key or comment id>: <why>`, with a
 * reason after the colon. Mentioning the report is not overruling it:
 * "criteria" alone, or "No disagreements with criteria", is refused.
 *
 * Data in, data out, and no outcome or result named here: what rules out
 * what is the team's declaration (`TeamOutcome.rulesOut`), so the same
 * check holds a review team's "blocking" against "approved" and any other
 * team's contradiction alike. EO checks that an override names the report
 * and gives a reason; whether the reason persuades is for the person who
 * reads it on the thread with the answer.
 */
export function ruledOutProblems(
  outcomes: readonly Pick<TeamOutcome, "key" | "label" | "rulesOut">[],
  contributions: readonly Pick<CurrentContribution, "key" | "reportId" | "outcome">[],
  result: string,
  disagreements: string,
): string[] {
  const ruling = new Map(outcomes.filter((outcome) => (outcome.rulesOut ?? []).includes(result)).map((outcome) => [outcome.key, outcome]));
  const problems: string[] = [];
  for (const contribution of contributions) {
    const outcome = contribution.outcome === null ? undefined : ruling.get(contribution.outcome);
    if (outcome === undefined) continue;
    if (overrules(disagreements, contribution)) continue;
    const report = contribution.reportId === null ? `**${contribution.key}**'s report` : `**${contribution.key}**'s report (comment ${contribution.reportId})`;
    problems.push(
      `Its result "${result}" is one ${report} rules out: it concluded "${outcome.label}" (${outcome.key}). Answer with a result that report allows, or overrule it on a line of your disagreements of its own: \`Overruled ${contribution.key}: <why>\`.`,
    );
  }
  return problems;
}

/**
 * One override line: `Overruled <report>: <why>`, a list marker before it
 * allowed, the report its assignment key or comment id (with "comment"
 * before it, or markdown around it, if the leader writes so), the reason
 * after a colon or a dash of its own.
 */
const OVERRIDE_LINE = /^\s*(?:[-*+]\s+|\d+[.)]\s+)?\**overruled\**\s+(.+?)\s*(?::|\s[\u2013\u2014]\s)\s*(.*)$/i;

/** Whether `text` overrules a report: an override line naming it, whose reason says something. */
function overrules(text: string, contribution: Pick<CurrentContribution, "key" | "reportId">): boolean {
  return text.split(/\r?\n/).some((line) => {
    const match = OVERRIDE_LINE.exec(line);
    if (match === null) return false;
    return namesReport(match[1]!.replace(/[`*"']/g, " "), contribution) && /[\p{L}\p{N}]/u.test(match[2]!);
  });
}

/** Whether `text` names a report: its assignment key as a word of its own, or its comment id. */
function namesReport(text: string, contribution: Pick<CurrentContribution, "key" | "reportId">): boolean {
  if (contribution.reportId !== null && text.includes(contribution.reportId)) return true;
  return new RegExp(`(^|[^a-z0-9_])${escapeRegExp(contribution.key)}($|[^a-z0-9_])`, "i").test(text);
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether a leader's accepted final answer still stands on the evidence as
 * it is now (EO-847): the turn that gave it was itself given this evidence,
 * and every report it relied on, and every required one, is current. The
 * first half is what holds a leader that answered from its own reading,
 * relying on no report, to evidence that has since moved.
 */
export function finalStands(ledger: Pick<LeaderLedger, "assignments" | "contributions">, attempts: readonly LeaderAttemptState[], final: LeaderAttemptState, baseline: string): boolean {
  if (final.verdict?.decision !== "final" || !final.verdict.accepted) return false;
  if (final.baseline !== baseline) return false;
  return leaderFinalProblems(ledger, attempts, final.verdict.contributions).length === 0;
}

export interface PlanLeaderTeamInput {
  team: LeaderTeam;
  /** Every attempt the session made, the leader's included, in the order they were made. */
  attempts: readonly LeaderAttemptState[];
  baseline: string;
}

export interface LeaderPlan {
  ledger: LeaderLedger;
  fence: TeamPlan["fence"];
  /** Turns to start now: participants' by their key, the leader's under `LEADER_ASSIGNMENT_KEY`. */
  start: TeamStart[];
  waiting: TeamPlan["waiting"];
  working: string[];
  /** Assignments, or the leader, waiting on a person's reply. */
  asking: string[];
  /** Assignments whose failures used up their retries. */
  exhausted: string[];
  /**
   * `finalize`: the leader's accepted final answer stands on current
   * reports, and nothing is at work. `failed`: the leader cannot go on.
   * `park`: only a person's answer can move the team. `continue`: turns
   * are working, starting or waiting for room.
   */
  next: { kind: "finalize"; attemptId: string } | { kind: "failed"; reason: string } | { kind: "park" } | { kind: "continue" };
}

/**
 * A leader's team's next step from its attempts (EO-847), in bounded
 * turns. The leader's turn ends with what it asked for; the assignments
 * accepted from it run as participants do on an independent team (retried,
 * replaced, superseded on moved evidence, waiting on a person); and only
 * once that round has settled — every assignment in force reported, failed
 * past its retries — does the leader get its next turn, with the reports.
 * A leader's answer EO refused, or a turn that failed, is corrected in
 * another turn while `maxRetries` allows, and past that the team fails
 * rather than finalising on nothing.
 */
export function planLeaderTeam(input: PlanLeaderTeamInput): LeaderPlan {
  const { team, attempts, baseline } = input;
  const ledger = leaderLedger(attempts, baseline);
  const fence: TeamPlan["fence"] = [];
  const needs: TeamStart[] = [];
  const working: string[] = [];
  const asking: string[] = [];
  const exhausted: string[] = [];

  for (const assignment of ledger.assignments) {
    const all = attempts.filter((attempt) => attempt.key === assignment.key);
    const state = assignmentState(assignment.key, all, assignment.round, baseline, team.limits.maxRetries);
    fence.push(...state.fence);
    needs.push(...state.needs);
    working.push(...state.working);
    if (state.asking) asking.push(assignment.key);
    if (state.settled?.status === "failed") exhausted.push(assignment.key);
  }

  const done = (next: LeaderPlan["next"], extra: { start?: TeamStart[]; waiting?: TeamPlan["waiting"] } = {}): LeaderPlan => ({
    ledger,
    fence,
    start: extra.start ?? [],
    waiting: extra.waiting ?? [],
    working,
    asking,
    exhausted,
    next,
  });

  // The round is still at work: its participants, and nothing of the leader's.
  if (fence.length > 0 || needs.length > 0 || working.length > 0) {
    const { start, waiting } = allot(needs, working.length, team.limits.maxParallel);
    return done({ kind: "continue" }, { start, waiting });
  }
  if (asking.length > 0) return done({ kind: "park" });

  // The round has settled: the leader's move.
  const latest = ledger.leaderTurns.find((turn) => turn.supersededBy === null) ?? null;
  const leaderNeed = (why: TeamStart["why"], round: number): LeaderPlan => {
    const { start, waiting } = allot([{ key: LEADER_ASSIGNMENT_KEY, supersedes: latest?.id ?? null, why, round }], 0, team.limits.maxParallel);
    return done({ kind: "continue" }, { start, waiting });
  };
  const tooMany = (): LeaderPlan | null =>
    ledger.corrections > team.limits.maxRetries
      ? done({
          kind: "failed",
          reason: `The leader's turns failed or were refused ${ledger.corrections} time${ledger.corrections === 1 ? "" : "s"}, more than the team's ${team.limits.maxRetries} ${team.limits.maxRetries === 1 ? "retry" : "retries"} allow, so EO stopped rather than finalise on an answer it could not accept.`,
        })
      : null;

  if (latest === null) return leaderNeed("first", 1);
  if (!ENDED.has(latest.status)) {
    if (latest.live) {
      working.push(latest.id);
      return done({ kind: "continue" });
    }
    fence.push({ attemptId: latest.id, why: "orphaned" });
    return done({ kind: "continue" });
  }
  if (latest.status === "cancelled") {
    if (latest.question === "open") {
      asking.push(LEADER_ASSIGNMENT_KEY);
      return done({ kind: "park" });
    }
    return leaderNeed(latest.question === "answered" ? "answered" : "interrupted", latest.round);
  }
  if (latest.status === "failed") return tooMany() ?? leaderNeed("retry", latest.round);

  const verdict = latest.verdict ?? null;
  if (verdict === null) return tooMany() ?? leaderNeed("correction", latest.round);
  if (verdict.decision === "final") {
    if (!verdict.accepted) return tooMany() ?? leaderNeed("correction", latest.round);
    // Accepted, and still standing only while it is itself current — the
    // leader read the evidence too, and may answer with no reports at all —
    // and every report it relied on, and every required one, is current:
    // evidence that moved since supersedes them, and the leader answers
    // again on what is there now.
    if (finalStands(ledger, attempts, latest, baseline)) return done({ kind: "finalize", attemptId: latest.id });
    return leaderNeed("stale", latest.round);
  }
  if (verdict.accepted.length === 0) return tooMany() ?? leaderNeed("correction", latest.round);
  return leaderNeed("reports", latest.round + 1);
}
