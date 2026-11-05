import type { Uuid } from "./index.js";

// Unlike role/type in domain.ts, RunStatus is a closed union on purpose:
// the engine branches on these specific values (ARCHITECTURE.md, "A run", "One channel"). A new
// status is
// an engine code change, not a data row — the opposite situation from
// workflow_states/roles.
export type RunStatus = "queued" | "running" | "awaiting_input" | "succeeded" | "failed" | "cancelled" | "orphaned";

/** Which executable selection a provider subprocess was launched with. */
export type RunRuntimeSource = "managed" | "configured";

/**
 * What cut a run short without it failing.
 *
 * `quit`: a person closed EO while it worked and chose to stop it.
 * `restart`: EO went away under it — killed, crashed, the machine lost
 * power — and found it still marked running on the next launch.
 * `sleep`: the computer slept while it worked, and its backend did not
 * pick up again once it woke.
 *
 * Either way the run is continued on its own thread where it can be,
 * and it is not one of the attempts `perItemAttemptLimit` counts: the
 * agent did nothing wrong, and an item that lost its tries to two
 * restarts and a laptop lid would be parked for the machine's sake.
 */
export type RunInterruption = "quit" | "restart" | "sleep";

/**
 * What `runs.result` holds once a run succeeds (A-02).
 *
 * Both halves are kept: `parsed` is what the engine acts on, `raw` is
 * exactly what the agent returned. The original design — "store the raw output
 * alongside the parsed result; when something goes wrong you'll want
 * the original". For an action with no registered schema the two are
 * the same value.
 */
export interface PersistedRunResult {
  raw: unknown;
  parsed: unknown;
}

/** Reads the parsed half of a persisted run result, tolerating rows written before A-02. */
export function parsedResultOf(result: Record<string, unknown> | null): unknown {
  if (result === null) return null;
  return "parsed" in result ? result["parsed"] : result;
}

/**
 * One thing a workspace kind checked about a run, as the row keeps it
 * (EO-312).
 *
 * The readable third of the `Check` the kind returned — its key, how it
 * came out, and the sentence saying what it looked at. What is left
 * behind is what the supervisor needed in the moment and nobody needs
 * afterwards: whether a failure blocked the run (the run's own status
 * already says), the comment posted in the thread (it is in the thread),
 * and the evidence (`verification` holds it).
 */
export interface RunCheck {
  /** Stable across runs and unique within one verify, so a reader can follow one check over time. */
  key: string;
  passed: boolean;
  /** One sentence naming what this checked and how it came out. */
  describes: string;
}

export interface Run {
  id: Uuid;
  itemId: Uuid;
  /**
   * The agent that ran, or null on a `builtin` step — EO running one of
   * its own functions is still a run (it takes time, it can fail, it
   * leaves a record), but there is no agent to point at.
   */
  agentId: Uuid | null;
  action: string;
  /**
   * The step this run was dispatched from.
   *
   * Distinct from `action`, which does not identify a step: two steps in
   * one pipeline may share an entry action, and the manual actions name
   * none. Reading it is how a comment written during this run is placed
   * at a step. Null on runs recorded before it existed — never a match.
   */
  stepId: string | null; // references PipelineStep.id
  status: RunStatus;
  threadId: string | null; // provider session id -> resume
  /** Which backend issued threadId. Null on rows predating A-07, and on runs that never got a thread. */
  provider: string | null;
  /** Immutable for this subprocess. Null on builtins, placeholders, and rows predating EO-41. */
  runtimeSource: RunRuntimeSource | null;
  /**
   * Hash of the instructions this run was handed, recorded at dispatch —
   * what the provider thread it started was born with, since neither
   * backend re-sends instructions on resume.
   *
   * Null on builtin and module runs, which have no agent and so no
   * instructions, and on rows predating EO-87. Null is the absence of an
   * answer: never read it as matching anything.
   */
  instructionsHash: string | null;
  /**
   * Hash of the MCP servers and skills attached to this run's agent,
   * recorded at dispatch alongside `instructionsHash` (EO-106) — the
   * tool surface the provider thread it started was born with, since
   * neither backend re-sends configuration on resume either.
   *
   * Named for the agent rather than for the run: `attachments` in this
   * codebase already means the files on a comment, and a column called
   * `attachmentsHash` on a run would read as a hash of those.
   *
   * Null does *not* mean "no answer" here, which is where it parts
   * company with `instructionsHash` above — see `findReusableThread`,
   * which is the one place that reads it. Nothing could be attached
   * before the column existed, so a row predating it had an empty tool
   * surface, and that is a fact rather than a gap.
   */
  agentAttachmentsHash: string | null;
  /**
   * The backend had no such session when this run tried to resume
   * `threadId` (EO-93).
   *
   * A property of the *thread*, recorded on the run that found it gone:
   * `threadId` is deliberately left in place — the run was handed that
   * session and really did try it — so every run of that agent's on this
   * item carrying the same id is dead with it. False on a run that
   * never resumed anything, which is nearly all of them.
   */
  threadLost: boolean;
  /**
   * What cut this run short without it failing, or null for every run
   * that ended on its own account — see `RunInterruption`.
   */
  interruption: RunInterruption | null;
  /**
   * The directory this run worked in — what `prepare` handed back
   * (EO-295).
   *
   * `worktree_path` until this story, which was the git kind's word for
   * it at a time when there was no other kind: a folder workspace has no
   * worktree and a `none` workspace has no disk at all, and the column
   * is read on the two resume paths to point a respawned backend at the
   * directory its session was opened in. Null for a run EO recorded no
   * directory for.
   */
  cwd: string | null;
  pid: number | null;
  /** Stable id for one dispatch/retry cycle. Attempts reset when a new initiation begins. */
  initiationId: string | null;
  attempt: number;
  result: Record<string, unknown> | null;
  /** G-02's mechanical verification of an implement run, kept for inspection. */
  verification: Record<string, unknown> | null;
  /**
   * What the workspace kind checked when this run ended, and how each
   * check came out (EO-312, ARCHITECTURE.md, "The item").
   *
   * `verification` beside it is the *evidence* one of those checks
   * carried — which step of the branch check failed and what it printed
   * — and has never been the list. Invariant 5 now reads "verify where
   * you can, and say what you checked", and the second half needs the
   * checks themselves kept: the sidebar's step block lists them with a
   * mark each, so a person reading a run knows what was looked at rather
   * than only whether the verdict was yes.
   *
   * Null on a run that predates the column and on one nothing checked.
   * The two are not distinguished, and deliberately: an empty list and
   * no list say the same thing to a reader — there is nothing to show —
   * and a screen that drew them apart would be reporting on EO's
   * bookkeeping rather than on the run.
   */
  checks: RunCheck[] | null;
  error: string | null;
  /**
   * Total input tokens, cache included, summed over every turn.
   *
   * "Every turn" is the part worth reading twice: an agentic loop
   * re-sends its conversation on each one, so this is the dispatch
   * prompt multiplied by `turns` plus whatever the agent read along the
   * way — not the size of what EO assembled.
   *
   * Rows written before migration 0044 hold a narrower Claude reading
   * (no cache, main loop only) and are not comparable with later ones.
   */
  tokensIn: number | null;
  tokensOut: number | null;
  /** The share of `tokensIn` served from the prompt cache. Null where the backend did not say. */
  cacheReadTokens: number | null;
  /**
   * What was written *into* the prompt cache, as the backend reports it.
   *
   * Not known to sit inside `tokensIn` on both backends, unlike
   * `cacheReadTokens` — read it as a figure beside the total rather than
   * a slice of it. Null where the backend did not say.
   */
  cacheWriteTokens: number | null;
  /** Model turns this run took — the multiplier on every token of its prompt. */
  turns: number | null;
  /**
   * Which rule `turns` follows.
   *
   * `"turn"` counts this run's own turns and adds up with its
   * neighbours'. `"session"` is the backend's claim about the whole
   * conversation, which may already include every earlier run on the
   * same thread — so two of those must never be added together. Null
   * where nothing reported a count.
   */
  turnsScope: "turn" | "session" | null;
  costCents: number | null;
  startedAt: number | null;
  endedAt: number | null;
  /**
   * Somebody ran this to watch it work, rather than because an item
   * reached a step (KAN-106).
   *
   * A real run — it took time, it could have failed, it left a
   * transcript — but not work. It moved no item and consulted no
   * route, so anything reading runs as progress has to be able to tell.
   */
  dryRun: boolean;
  /**
   * When this row last changed (EO-324, ARCHITECTURE.md, "Identity").
   *
   * A run is mutated for as long as it lasts, and nothing else on it
   * says *when*: `startedAt` is fixed at the beginning and `endedAt` is
   * null until it is over. A replica pulling "runs that changed since"
   * pages on this, which is what lets a second desktop show that
   * somebody's agent is working rather than drawing an idle board.
   *
   * `0` on every row written before the column, which reads as "before
   * any cursor" and so travels on the first pull.
   */
  updatedAt: number;
}

// Append-only: never UPDATE, never DELETE (ARCHITECTURE.md, "`run_events` is the durability
// substrate"). type is open — stdout |
// tool_call | file_edit | error | result | ... — new event kinds are just
// new payload shapes, not an engine change.
export interface RunEvent {
  runId: Uuid;
  seq: number;
  ts: number;
  type: string;
  payload: unknown;
}

/**
 * When a person's message is meant to reach the agent (EO-176).
 *
 * `"now"` is a push into the turn that is running — the backend is told
 * mid-flight and the agent's next step reflects it. `"next"` is EO's own
 * queue, which is not a queue at all in the usual sense: the message
 * stays a comment on the item and the next dispatch reads it. That
 * distinction is deliberate. A run is one turn and one routing result,
 * so a message held *inside* a CLI that starts a second turn within one
 * run would give that run two candidate results.
 */
export type MessageDelivery = "now" | "next";

/**
 * The `run_events.type` a person's mid-run message is stored under
 * (EO-176).
 *
 * The message is a comment first — invariant #4, and the comment is the
 * record. This row is the *delivery*: it says the message reached this
 * run, at this point in its transcript, which is where somebody watching
 * the agent work will look for it. Written for a queued message too, so
 * a transcript never shows a person shouting into a void.
 *
 * Named here rather than spelled at each call site for the reason
 * `SEARCH_INTERCEPTION_EVENT` is: on the reading side the type is an
 * opaque string, where a typo is an empty transcript rather than an
 * error.
 */
export const HUMAN_MESSAGE_EVENT = "human_message";

/** The payload of a {@link HUMAN_MESSAGE_EVENT} row. */
export interface HumanMessageEvent {
  /** The comment that carries the message — the durable record it was said at all. */
  commentId: string;
  /** What was said, so the transcript reads without a join. */
  body: string;
  /** What was asked for. */
  delivery: MessageDelivery;
  /** Whether it reached this turn. False means the next turn will read it instead. */
  delivered: boolean;
}

/**
 * The `run_events.type` a review's verdict is recorded under (EO-200).
 *
 * The verdict is already in the log twice over — the `result` row holds
 * what the agent said, and `runs.result` holds what the engine parsed —
 * so this row is not the record of the review. It is the record of the
 * *measurement*: the handful of counts that make "how many blocking
 * issues did this rejection carry, and how many criteria did it leave
 * unexamined" a `WHERE type = 'review_verdict'` rather than an
 * archaeology of raw provider payloads whose shape varies by backend.
 *
 * Written for the reason `SEARCH_INTERCEPTION_EVENT` was: a number
 * nothing recomputes is a number that gets restated until it is wrong.
 * `reviewer.md` quoted "83%" from a census nobody could repeat; this is
 * so the next such claim can be checked against the log rather than
 * against memory.
 *
 * Appended after the run's event buffer has been disposed, which is the
 * only reason it is safe to write with `appendRunEvent` — see the
 * warning on that function.
 */
export const REVIEW_VERDICT_EVENT = "review_verdict";

/** The payload of a {@link REVIEW_VERDICT_EVENT} row. Counts only; the prose is in the comment. */
export interface ReviewVerdictEvent {
  verdict: "approve" | "reject" | "needs_user_input";
  /** How many blocking issues the verdict carried. Always 0 outside a rejection. */
  blockingIssues: number;
  /** How many acceptance criteria the item declared when it was reviewed. */
  declaredCriteria: number;
  /** Of those, how many the review reported met. */
  met: number;
  /** Of those, how many it reported not met. */
  notMet: number;
  /** Of those, how many it explicitly declined to assess. */
  notAssessed: number;
  /** Of those, how many it said nothing about at all. */
  notReported: number;
  /** `notAssessed + notReported` — the criteria this review did not settle either way. */
  unexamined: number;
}

export interface Transition {
  id: Uuid;
  itemId: Uuid;
  fromStepId: string | null;
  toStepId: string;
  actor: string; // "human" | agent_id
  runId: Uuid | null;
  reason: string | null;
  ts: number;
}
