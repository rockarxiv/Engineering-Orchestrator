import { decideIndependentTeam } from "@eo/core";
import type { IndependentTeam, TeamContribution, TeamDecision } from "@eo/core";

/**
 * What an independent team's supervisor does next (EO-846, ARCHITECTURE.md,
 * "A team on an agent step").
 *
 * Pure (invariant 2): the host reads the session's attempts, the evidence
 * it holds now and its free capacity, and hands them here as data; this
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
}

/** Why an assignment that needs a turn has not been given one yet. */
export type TeamWaitReason =
  /** The team already runs as many participants at once as it allows. */
  | "team"
  /** Every participant slot on this machine is in use, by this team or another. */
  | "machine"
  /** The agent this assignment would run as is at its own concurrency limit. */
  | "agent";

export interface TeamCapacity {
  /** How many more participant turns this machine may start, across every team. */
  machineFree: number;
  /** The agent each assignment would run as, by key; null where nobody could be staffed. */
  agentOf: ReadonlyMap<string, string | null>;
  /** How many more turns each agent may start, by agent id; absent is none. */
  agentFree: ReadonlyMap<string, number>;
}

export interface PlanIndependentTeamInput {
  team: IndependentTeam;
  /** Every attempt the session has made, any order. */
  attempts: readonly TeamAttemptState[];
  /** The evidence as it stands now, keyed as the attempts' are. */
  baseline: string;
  capacity: TeamCapacity;
}

/** A turn to start: a new attempt at `key`, replacing `supersedes` where there was one. */
export interface TeamStart {
  key: string;
  supersedes: string | null;
  /** Why a turn is needed: the assignment's first, a retry of a failure, a replacement for one EO stopped, or work done on evidence that has since changed. */
  why: "first" | "retry" | "interrupted" | "stale";
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
 * Turns are handed out in the team's order and only within every bound
 * at once: the team's own `maxParallel`, the machine's free participant
 * slots, and the agent's own limit. What cannot start waits, with why, so
 * a person can be told rather than left looking at nothing moving.
 *
 * Nothing is decided while any assignment is unsettled on the current
 * evidence, so a crash, a missing contribution or a stale report can
 * never reach the fallback.
 */
export function planIndependentTeam(input: PlanIndependentTeamInput): TeamPlan {
  const { team, baseline, capacity } = input;
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
  const contributions: TeamContribution[] = [];

  for (const participant of team.participants) {
    const attempts = byKey.get(participant.key) ?? [];
    const latest = attempts.find((attempt) => attempt.supersededBy === null) ?? null;
    if (latest === null) {
      needs.push({ key: participant.key, supersedes: null, why: "first" });
      continue;
    }
    const current = latest.baseline === baseline;
    if (!ENDED.has(latest.status)) {
      if (!latest.live) {
        fence.push({ attemptId: latest.id, why: "orphaned" });
        needs.push({ key: participant.key, supersedes: latest.id, why: current ? "interrupted" : "stale" });
      } else if (!current) {
        fence.push({ attemptId: latest.id, why: "stale" });
        // Replaced once its turn has stopped: until then it is still live.
        working.push(latest.id);
      } else {
        working.push(latest.id);
      }
      continue;
    }
    if (latest.status === "completed") {
      if (current) contributions.push({ key: participant.key, status: "completed", outcome: latest.outcome ?? "", report: latest.report ?? "" });
      else needs.push({ key: participant.key, supersedes: latest.id, why: "stale" });
      continue;
    }
    if (latest.status === "cancelled") {
      needs.push({ key: participant.key, supersedes: latest.id, why: current ? "interrupted" : "stale" });
      continue;
    }
    // Failed. Only failures are counted: an attempt EO stopped, or one
    // superseded because the evidence moved, is not the participant's.
    const failures = attempts.filter((attempt) => attempt.status === "failed").length;
    if (failures <= team.limits.maxRetries) {
      needs.push({ key: participant.key, supersedes: latest.id, why: "retry" });
      continue;
    }
    exhausted.push(participant.key);
    contributions.push({ key: participant.key, status: "failed", error: latest.error ?? "It could not contribute." });
  }

  // Turns, within every bound at once. A stale turn still being stopped
  // holds its slot until it has.
  let teamFree = Math.max(0, team.limits.maxParallel - working.length);
  let machineFree = Math.max(0, capacity.machineFree);
  const agentFree = new Map(capacity.agentFree);
  const start: TeamStart[] = [];
  const waiting: TeamPlan["waiting"] = [];
  for (const need of needs) {
    // A replacement for a live stale turn waits for it to stop.
    if (teamFree <= 0) {
      waiting.push({ key: need.key, reason: "team" });
      continue;
    }
    if (machineFree <= 0) {
      waiting.push({ key: need.key, reason: "machine" });
      continue;
    }
    const agent = capacity.agentOf.get(need.key) ?? null;
    // Nobody to staff it is not a wait: the host fails the attempt with
    // the reason, which a retry may get past and an exhausted one reports.
    if (agent !== null) {
      const free = agentFree.get(agent) ?? 0;
      if (free <= 0) {
        waiting.push({ key: need.key, reason: "agent" });
        continue;
      }
      agentFree.set(agent, free - 1);
    }
    teamFree -= 1;
    machineFree -= 1;
    start.push(need);
  }

  const settled = needs.length === 0 && working.length === 0 && fence.length === 0;
  const decision: TeamDecision = settled
    ? decideIndependentTeam(team, contributions)
    : { status: "pending", waitingOn: team.participants.filter((participant) => !contributions.some((one) => one.key === participant.key)).map((participant) => participant.key) };
  return { fence, start, waiting, exhausted, working, decision };
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
