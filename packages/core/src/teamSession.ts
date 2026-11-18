import { z } from "zod";
import { StepTeamSchema } from "./team.js";

/**
 * A team session and its participants' attempts, as they are kept and as
 * they travel (EO-844, ARCHITECTURE.md, "A team on an agent step").
 *
 * A **session** is one team's work on one item: on one step, entered by
 * one transition, under one pinned pipeline version, with the team as it
 * was configured when the session opened — so a later edit to the step or
 * to an agent does not rewrite what this session was. Its `status` is the
 * orchestration's state, which says nothing about whether any provider
 * process is running: that is each attempt's run.
 *
 * An **attempt** is one participant's go at one assignment: its key, the
 * role and the agent it resolved to (by name too, so a retired agent still
 * reads as who it was), the round and the attempt number, the evidence
 * baseline it was given, and the run behind it — the provider thread, the
 * timing and the spending are that run's, so a team's spending is the sum
 * of its attempts' runs and nothing is counted twice. A retry or a
 * replacement is a new attempt that names the one it supersedes; the old
 * one keeps what it said.
 *
 * An accepted report is a comment on the item's thread, attributed to the
 * attempt's agent and run, and the attempt names it — once: a delivered
 * result that arrives again finds the comment already named and writes
 * nothing.
 */

/**
 * Where a session's orchestration stands. `open` while it gathers
 * contributions; the four others are ends, and only `open` accepts a
 * contribution or a finalisation.
 */
/**
 * The action a participant's own run is recorded under (EO-846).
 *
 * A participant's turn is a `runs` row, so its thread, timing and spending
 * are counted where every run's are; but it is not the item's run at its
 * step, and nothing that reads an item's runs as its step's — the
 * scheduler's active runs, the retry backoff, the attempt count, thread
 * reuse — may mistake it for one. The colon keeps it out of any action a
 * role could define (`ACTION_KEY_PATTERN`).
 */
export const TEAM_PARTICIPANT_ACTION = "team:participant";

export const TEAM_SESSION_STATUSES = ["open", "finalized", "failed", "cancelled", "superseded"] as const;
export const TeamSessionStatusSchema = z.enum(TEAM_SESSION_STATUSES);
export type TeamSessionStatus = z.infer<typeof TeamSessionStatusSchema>;

/**
 * Where one attempt stands. `completed` is a report accepted; `failed` is
 * an attempt that could not contribute (kept apart from any conclusion,
 * as `TeamExecutionFailureSchema` keeps it); `cancelled` was stopped.
 * Supersession is not a status: a superseded attempt keeps the status it
 * ended with and names its successor.
 */
export const TEAM_ATTEMPT_STATUSES = ["queued", "running", "completed", "failed", "cancelled"] as const;
export const TeamAttemptStatusSchema = z.enum(TEAM_ATTEMPT_STATUSES);
export type TeamAttemptStatus = z.infer<typeof TeamAttemptStatusSchema>;

/**
 * What an attempt was given to look at, as a reference rather than a copy:
 * the kind of source (a workspace kind's word, `attachments`, `none`) and
 * the identifier of what was captured in it. Opaque here — capturing it is
 * the workspace kind's business — and kept so a report can always be read
 * against what its author saw.
 */
export const TeamEvidenceBaselineSchema = z.object({
  kind: z.string().trim().min(1),
  ref: z.string().trim().min(1),
});
export type TeamEvidenceBaseline = z.infer<typeof TeamEvidenceBaselineSchema>;

export const TeamSessionRowSchema = z.object({
  id: z.string(),
  itemId: z.string(),
  stepId: z.string(),
  /** The transition that put the item on the step this session works — its step entry. Null where the item was created on the step. */
  entryTransitionId: z.string().nullable(),
  /** The pipeline version the item was pinned to when the session opened. Null for a pipeline nobody has saved a version of. */
  pipelineVersionId: z.string().nullable(),
  /** The orchestration's own run — the step's run — whose spending is its own and never its children's. */
  runId: z.string().nullable(),
  /** The team as configured when the session opened. */
  team: StepTeamSchema,
  status: TeamSessionStatusSchema,
  /** The step's result key the session settled on, once it has. */
  result: z.string().nullable(),
  /** The output comment the session's final answer was posted as. */
  finalCommentId: z.string().nullable(),
  /** The session that replaced this one. */
  supersededBy: z.string().nullable(),
  /** The device whose session it is — the one that may report it. Null on a solo desktop. */
  deviceId: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  endedAt: z.number().nullable(),
});
export type TeamSessionRow = z.infer<typeof TeamSessionRowSchema>;

export const TeamAttemptRowSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  itemId: z.string(),
  /** The participant's stable assignment key. */
  assignmentKey: z.string(),
  role: z.string(),
  /** The agent the role resolved to. Kept by id and by name, so a retired or renamed agent still reads as who it was. */
  agentId: z.string().nullable(),
  agentName: z.string(),
  /** The focused instructions this attempt was given. */
  instructions: z.string(),
  round: z.number().int().positive(),
  attempt: z.number().int().positive(),
  /** The provider run: thread, timing and spending are its. */
  runId: z.string().nullable(),
  status: TeamAttemptStatusSchema,
  /** The declared outcome its accepted report concluded. */
  outcome: z.string().nullable(),
  /** Why it could not contribute, on a failed or cancelled attempt. */
  error: z.string().nullable(),
  evidenceBaseline: TeamEvidenceBaselineSchema.nullable(),
  /** The comment its accepted report was posted as. Set once. */
  reportCommentId: z.string().nullable(),
  acceptedAt: z.number().nullable(),
  /** The attempt that replaced this one. Set once. */
  supersededBy: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  endedAt: z.number().nullable(),
});
export type TeamAttemptRow = z.infer<typeof TeamAttemptRowSchema>;

/** A session with every attempt made under it, oldest first. */
export const TeamSessionRecordSchema = z.object({
  session: TeamSessionRowSchema,
  attempts: z.array(TeamAttemptRowSchema).max(200),
});
export type TeamSessionRecord = z.infer<typeof TeamSessionRecordSchema>;

/**
 * A session as a device reports it to its record, whole (EO-844).
 *
 * Whole rather than a change at a time, so that a replay is harmless and
 * the order commands arrive in cannot leave the record holding half a
 * session. The record applies it only from the device whose session it
 * is, while that device is not stale, and never rewrites what it already
 * holds of an accepted report or a supersession.
 */
export const RecordTeamSessionCommandSchema = TeamSessionRecordSchema.extend({
  kind: z.literal("teamSession"),
  id: z.string(),
  itemId: z.string(),
});
export type RecordTeamSessionCommand = z.infer<typeof RecordTeamSessionCommandSchema>;
