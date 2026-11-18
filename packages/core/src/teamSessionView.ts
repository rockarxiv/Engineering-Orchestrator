import { z } from "zod";
import { TeamAttemptStatusSchema, TeamSessionStatusSchema } from "./teamSession.js";

/**
 * A team session as a person reads it (EO-849, ARCHITECTURE.md, "A team on
 * an agent step"): one session with its participants underneath, rather
 * than several runs that look like competing owners of the step.
 *
 * Everything here is derived, on every read, from what is stored — the
 * session and its attempts, their runs, the thread — so a window opened,
 * reloaded or reconnected later draws the same thing, reports finished
 * while it was closed included. Nothing here is written back (invariant 6).
 */

/**
 * Where one attempt stands, as shown. The stored status, sharpened by what
 * is around it: `waiting` is an attempt that asked the person and has an
 * unanswered question; `superseded` was replaced (by a retry, a follow-up or
 * evidence that moved) and is history, whatever it ended as; `stopped` is
 * one still stored as queued or running whose session is no longer at work
 * — ended, or its item moved — so a late or interrupted turn never reads as
 * running or as a finding.
 */
export const TEAM_ATTEMPT_STATES = ["queued", "running", "waiting", "completed", "failed", "cancelled", "superseded", "stopped"] as const;
export const TeamAttemptShownSchema = z.enum(TEAM_ATTEMPT_STATES);
export type TeamAttemptShown = z.infer<typeof TeamAttemptShownSchema>;

/**
 * Why a team is not moving. `capacity`: an assignment waits for room — the
 * team's own parallel limit, the machine's participant slots, its agent's
 * concurrency, or budget held by turns still working. `contribution`: the
 * team waits on participants still at work. `human`: a member asked the
 * person something. `enforcement`: EO could not hold an agent to report-only
 * on this machine, so it was never started. `limits`: retries, rounds, time
 * or budget ran out. `restricted`: EO is paused or closing, the item is on
 * hold, or a backend cannot run here now.
 */
export const TEAM_WAIT_KINDS = ["capacity", "contribution", "human", "enforcement", "limits", "restricted"] as const;
export const TeamWaitKindSchema = z.enum(TEAM_WAIT_KINDS);
export type TeamWaitKind = z.infer<typeof TeamWaitKindSchema>;

export const TeamWaitViewSchema = z.object({
  kind: TeamWaitKindSchema,
  /** The assignments it holds back, by key; empty where it is about the whole team. */
  keys: z.array(z.string()),
  text: z.string(),
});
export type TeamWaitView = z.infer<typeof TeamWaitViewSchema>;

/** A control a person may press, or why not — never an inert button. */
export const TeamControlSchema = z.object({ allowed: z.boolean(), reason: z.string().nullable() });
export type TeamControl = z.infer<typeof TeamControlSchema>;

export const TeamQuestionViewSchema = z.object({
  commentId: z.string(),
  body: z.string(),
  answered: z.boolean(),
});
export type TeamQuestionView = z.infer<typeof TeamQuestionViewSchema>;

export const TeamAttemptViewSchema = z.object({
  id: z.string(),
  assignmentKey: z.string(),
  /** The leader's own turn, on a leader-led team. */
  leader: z.boolean(),
  role: z.string(),
  agentId: z.string().nullable(),
  /** As it was when the attempt was made, so a renamed or retired agent still reads as who it was. */
  agentName: z.string(),
  /** The backend its run spoke to (`claude`, `codex`), null where it never started one. */
  provider: z.string().nullable(),
  instructions: z.string(),
  round: z.number().int().positive(),
  attempt: z.number().int().positive(),
  state: TeamAttemptShownSchema,
  status: TeamAttemptStatusSchema,
  /** The declared outcome its accepted report concluded, and its label. */
  outcome: z.string().nullable(),
  outcomeLabel: z.string().nullable(),
  error: z.string().nullable(),
  /** EO could not hold its agent to report-only, so it never started. */
  enforcementUnavailable: z.boolean(),
  /** What it was given to read, by reference; null where nothing was captured. */
  baseline: z.object({ kind: z.string(), ref: z.string(), capturedAt: z.number().nullable() }).nullable(),
  /** Whether that baseline is the one the session's latest work was given. */
  baselineCurrent: z.boolean().nullable(),
  reportCommentId: z.string().nullable(),
  acceptedAt: z.number().nullable(),
  /** Its own run: the transcript, the timing and the spending. */
  runId: z.string().nullable(),
  startedAt: z.number().nullable(),
  endedAt: z.number().nullable(),
  costCents: z.number().nullable(),
  tokensIn: z.number().nullable(),
  tokensOut: z.number().nullable(),
  supersedes: z.string().nullable(),
  supersededBy: z.string().nullable(),
  questions: z.array(TeamQuestionViewSchema),
});
export type TeamAttemptView = z.infer<typeof TeamAttemptViewSchema>;

/** One assignment and every attempt made at it, oldest first; `current` is the one nothing replaced. */
export const TeamAssignmentViewSchema = z.object({
  key: z.string(),
  role: z.string(),
  leader: z.boolean(),
  /** On an independent team, as declared; on a leader's, as the leader asked; null where unknown. */
  required: z.boolean().nullable(),
  current: z.string().nullable(),
  attempts: z.array(TeamAttemptViewSchema),
});
export type TeamAssignmentView = z.infer<typeof TeamAssignmentViewSchema>;

/**
 * What produced the session's result: on an independent team, the
 * completion rule (or the fallback) and the contributions it read; on a
 * leader's, the leader's accepted answer and the reports it relied on.
 */
export const TeamFinalViewSchema = z.discriminatedUnion("by", [
  z.object({
    by: z.literal("rule"),
    /** The rule as the step details word it; null where the fallback applied. */
    rule: z.string().nullable(),
    ruleIndex: z.number().int().nonnegative().nullable(),
    /** The attempts whose reports were read, in the team's order. */
    contributions: z.array(z.string()),
    /** The answer the step was given, posted by the ordinary path. */
    outputCommentId: z.string().nullable(),
  }),
  z.object({
    by: z.literal("leader"),
    attemptId: z.string(),
    /** The leader's final answer as posted. */
    outputCommentId: z.string().nullable(),
    contributions: z.array(z.string()),
    disagreements: z.string().nullable(),
    limitations: z.string().nullable(),
  }),
]);
export type TeamFinalView = z.infer<typeof TeamFinalViewSchema>;

/**
 * The state the session is shown in. `running` and `waiting` are an open
 * session with or without a turn at work; `stopped` an open session whose
 * item has left the step entry it worked, so it takes nothing more; the
 * others are its stored ends.
 */
export const TEAM_SESSION_STATES = ["running", "waiting", "finalized", "failed", "cancelled", "superseded", "stopped"] as const;
export const TeamSessionStateSchema = z.enum(TEAM_SESSION_STATES);
export type TeamSessionState = z.infer<typeof TeamSessionStateSchema>;

export const TeamSessionViewSchema = z.object({
  id: z.string(),
  itemId: z.string(),
  stepId: z.string(),
  stepName: z.string(),
  coordination: z.enum(["independent", "leader"]),
  status: TeamSessionStatusSchema,
  state: TeamSessionStateSchema,
  /** The item's one session that can still take work: open, on its step entry. */
  current: z.boolean(),
  result: z.string().nullable(),
  final: TeamFinalViewSchema.nullable(),
  /** The team's own runs — its step's runs — in order: each holds the item while the team works and spends nothing itself. */
  teamRunIds: z.array(z.string()),
  createdAt: z.number(),
  endedAt: z.number().nullable(),
  /**
   * Spending, each run once: the participants' and the team's own runs,
   * superseded and failed ones included. `teamRunCents` is the team's own
   * share of it, which is nothing unless a backend charged it.
   */
  totals: z.object({ runs: z.number().int().nonnegative(), costCents: z.number().nullable(), tokensIn: z.number(), tokensOut: z.number(), teamRunCents: z.number() }),
  waiting: z.array(TeamWaitViewSchema),
  /** Why an ended or stopped session did not finalise, in EO's words; null where it finalised or is still the item's. */
  endReason: z.string().nullable(),
  assignments: z.array(TeamAssignmentViewSchema),
  cancel: TeamControlSchema,
  /** Retrying what failed, keeping every accepted report; `keys` are the assignments it would try again. */
  retry: TeamControlSchema.extend({ keys: z.array(z.string()) }),
});
export type TeamSessionView = z.infer<typeof TeamSessionViewSchema>;

// ── Words that are also records ─────────────────────────────────────

/**
 * How EO says on the thread that an assignment is waiting to start, so the
 * note a person reads is also what a later read of the session takes the
 * reason from — durable, and never a second store beside the thread.
 * Capacity and restriction are kept apart by their words.
 */
export function teamWaitNote(key: string, kind: "capacity" | "restricted", reason: string): string {
  return kind === "capacity" ? `**${key}** is waiting for room to start: ${reason}` : `**${key}** is waiting to start: ${reason}`;
}

/** A note `teamWaitNote` wrote, read back; null for any other comment. */
export function readTeamWaitNote(body: string): { key: string; kind: "capacity" | "restricted"; reason: string } | null {
  const match = /^\*\*([^*\n]+)\*\* is waiting (for room )?to start: ([\s\S]+)$/.exec(body);
  if (match === null) return null;
  return { key: match[1]!, kind: match[2] === undefined ? "restricted" : "capacity", reason: match[3]!.trim() };
}

/** What a failed attempt's error begins with when EO could not hold its agent to report-only, so it never started. */
export const TEAM_ENFORCEMENT_UNAVAILABLE = "EO cannot hold this agent to report-only here, so it was not started: ";

/** The end of the attempt a person's retry writes: a marker, never run, that the next turn replaces. */
export const TEAM_RETRY_REQUESTED = "A person asked for this to be tried again; EO starts it afresh and keeps every report already accepted.";
