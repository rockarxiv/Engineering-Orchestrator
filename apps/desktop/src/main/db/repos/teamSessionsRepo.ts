import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  storedTeam,
  TeamEvidenceBaselineSchema,
  uuidv7,
  type Comment,
  type RecordCursor,
  type RecordTeamSessionCommand,
  type StepTeam,
  type TeamAttemptRow,
  type TeamAttemptStatus,
  type TeamEvidenceBaseline,
  type TeamSessionRecord,
  type TeamSessionRow,
  type TeamSessionStatus,
  type Uuid,
} from "@eo/core";
import type { Db } from "../client.js";
import { agents, comments, items, runs, teamAttempts, teamSessions, transitions } from "../schema.js";
import { notifyTeamSessionWritten } from "../teamSessionEvents.js";
import { getComment, postComment } from "./commentsRepo.js";
import { leaseFor } from "./leasesRepo.js";
import { onProject } from "./projectScope.js";

/**
 * Team sessions, their participants' attempts and the reports they made
 * (EO-844, ARCHITECTURE.md, "A team on an agent step").
 *
 * Everything that writes `team_sessions` or `team_attempts` is here. A
 * session opens on one item's step entry and closes once; an attempt is
 * started, accepted or failed once, and replaced by a new attempt rather
 * than rewritten. What only grows — an accepted report, a supersession, an
 * ended session — is never taken back by anything here, on this machine,
 * on the record or on a replica (`mergeAttempt`, `mergeSession`): that is
 * what makes a result delivered twice, or a page pulled twice, harmless.
 *
 * Spending is not stored here. An attempt's run is a `runs` row like any
 * other, so it is counted once wherever runs are summed, and the session's
 * own run carries only its own spending (`teamSessionTotals`).
 */

/** An answer that may be no. */
export type TeamWrite<T> = ({ ok: true } & T) | { ok: false; problem: string };

const ENDED_ATTEMPT: ReadonlySet<TeamAttemptStatus> = new Set(["completed", "failed", "cancelled"]);

function sessionOf(row: typeof teamSessions.$inferSelect): TeamSessionRow {
  return {
    id: row.id,
    itemId: row.itemId,
    stepId: row.stepId,
    entryTransitionId: row.entryTransitionId,
    pipelineVersionId: row.pipelineVersionId,
    runId: row.runId,
    // Written only from a parsed team; a row this build cannot read is a
    // programmer's error, not something to show as an empty team.
    team: storedTeam(row.team) ?? (() => {
      throw new Error(`Team session ${row.id} holds a team this version of EO cannot read.`);
    })(),
    status: row.status as TeamSessionStatus,
    result: row.result,
    finalCommentId: row.finalCommentId,
    supersededBy: row.supersededBy,
    deviceId: row.deviceId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    endedAt: row.endedAt,
  };
}

function attemptOf(row: typeof teamAttempts.$inferSelect): TeamAttemptRow {
  const baseline = TeamEvidenceBaselineSchema.safeParse(row.evidenceBaseline);
  return {
    id: row.id,
    sessionId: row.sessionId,
    itemId: row.itemId,
    assignmentKey: row.assignmentKey,
    role: row.role,
    agentId: row.agentId,
    agentName: row.agentName,
    instructions: row.instructions,
    round: row.round,
    attempt: row.attempt,
    runId: row.runId,
    status: row.status as TeamAttemptStatus,
    outcome: row.outcome,
    error: row.error,
    evidenceBaseline: baseline.success ? baseline.data : null,
    reportCommentId: row.reportCommentId,
    acceptedAt: row.acceptedAt,
    supersededBy: row.supersededBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    endedAt: row.endedAt,
  };
}

export function getTeamSession(db: Db, id: string): TeamSessionRow | undefined {
  const row = db.select().from(teamSessions).where(eq(teamSessions.id, id)).get();
  return row === undefined ? undefined : sessionOf(row);
}

export function getTeamAttempt(db: Db, id: string): TeamAttemptRow | undefined {
  const row = db.select().from(teamAttempts).where(eq(teamAttempts.id, id)).get();
  return row === undefined ? undefined : attemptOf(row);
}

/** Every attempt under a session, oldest first — creation order, which UUIDv7 ids are. */
export function listTeamAttempts(db: Db, sessionId: string): TeamAttemptRow[] {
  return db.select().from(teamAttempts).where(eq(teamAttempts.sessionId, sessionId)).orderBy(asc(teamAttempts.createdAt), asc(teamAttempts.id)).all().map(attemptOf);
}

/** A session with every attempt made under it. */
export function getTeamSessionRecord(db: Db, id: string): TeamSessionRecord | undefined {
  const session = getTeamSession(db, id);
  return session === undefined ? undefined : { session, attempts: listTeamAttempts(db, id) };
}

/** Every session an item has had, oldest first, superseded and ended ones included. */
export function listTeamSessionsForItem(db: Db, itemId: string): TeamSessionRecord[] {
  return db
    .select()
    .from(teamSessions)
    .where(eq(teamSessions.itemId, itemId))
    .orderBy(asc(teamSessions.createdAt), asc(teamSessions.id))
    .all()
    .map((row) => ({ session: sessionOf(row), attempts: listTeamAttempts(db, row.id) }));
}

/** The item's open session, if it has one. There is never more than one. */
export function currentTeamSession(db: Db, itemId: string): TeamSessionRow | undefined {
  const row = db.select().from(teamSessions).where(and(eq(teamSessions.itemId, itemId), eq(teamSessions.status, "open"))).get();
  return row === undefined ? undefined : sessionOf(row);
}

/** The transition that last moved the item, or undefined for an item no move has touched. */
function lastMove(db: Db, itemId: string): { id: string; toStepId: string } | undefined {
  return db
    .select({ id: transitions.id, toStepId: transitions.toStepId })
    .from(transitions)
    .where(eq(transitions.itemId, itemId))
    .orderBy(desc(transitions.ts), desc(transitions.id))
    .limit(1)
    .get();
}

/**
 * Whether the item still stands on the step entry this session was opened
 * on: on its step, and not moved since. A session whose item has left —
 * moved on, or moved away and back, which is a new entry — is stale, and
 * accepts nothing.
 */
function onSessionEntry(db: Db, session: TeamSessionRow): boolean {
  const item = db.select({ stepId: items.stepId }).from(items).where(eq(items.id, session.itemId)).get();
  if (item === undefined || item.stepId !== session.stepId) return false;
  if (session.entryTransitionId === null) return true;
  return lastMove(db, session.itemId)?.id === session.entryTransitionId;
}

function touchSession(db: Db, sessionId: string, at: number): void {
  db.update(teamSessions).set({ updatedAt: at }).where(eq(teamSessions.id, sessionId)).run();
}

function staleProblem(session: TeamSessionRow): string | null {
  if (session.status === "superseded") return "This team session was superseded by a newer one, so it takes no more contributions.";
  if (session.status !== "open") return `This team session has already ended (${session.status}), so it takes no more contributions.`;
  return null;
}

// ── Writing a session on the machine that runs it ──────────────────

export interface OpenTeamSessionInput {
  itemId: Uuid;
  stepId: string;
  /** The team as configured now. Copied, so a later edit does not rewrite the session. */
  team: StepTeam;
  /** The orchestration's own run, where there is one. */
  runId?: Uuid | null;
  /** The move that put the item on the step. Defaults to the item's latest move, where that move was onto this step. */
  entryTransitionId?: string | null;
  /** Defaults to the version the item is pinned to. */
  pipelineVersionId?: string | null;
  now?: number;
}

/**
 * Opens a session on an item's step entry. Any session still open on the
 * item is superseded by it — kept, ended `superseded`, naming this one —
 * so an item never has two open sessions and a stale one can never
 * finalise.
 */
export function openTeamSession(db: Db, input: OpenTeamSessionInput): TeamSessionRow {
  const now = input.now ?? Date.now();
  const id = uuidv7();
  const superseded: string[] = [];
  const session = db.transaction((tx) => {
    const item = tx.select({ pipelineVersionId: items.pipelineVersionId }).from(items).where(eq(items.id, input.itemId)).get();
    if (item === undefined) throw new Error(`No item ${input.itemId} to open a team session on.`);
    const move = lastMove(tx as unknown as Db, input.itemId);
    const entryTransitionId = "entryTransitionId" in input ? (input.entryTransitionId ?? null) : move !== undefined && move.toStepId === input.stepId ? move.id : null;
    for (const open of tx.select({ id: teamSessions.id }).from(teamSessions).where(and(eq(teamSessions.itemId, input.itemId), eq(teamSessions.status, "open"))).all()) {
      tx.update(teamSessions).set({ status: "superseded", supersededBy: id, endedAt: now, updatedAt: now }).where(eq(teamSessions.id, open.id)).run();
      superseded.push(open.id);
    }
    const row = tx
      .insert(teamSessions)
      .values({
        id,
        itemId: input.itemId,
        stepId: input.stepId,
        entryTransitionId,
        pipelineVersionId: "pipelineVersionId" in input ? (input.pipelineVersionId ?? null) : item.pipelineVersionId,
        runId: input.runId ?? null,
        team: input.team,
        status: "open",
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    return sessionOf(row);
  });
  // The superseded ones first, so a record told in this order never holds two open sessions.
  for (const sessionId of superseded) notifyTeamSessionWritten(db, { sessionId: sessionId as Uuid, itemId: input.itemId });
  notifyTeamSessionWritten(db, { sessionId: session.id as Uuid, itemId: input.itemId });
  return session;
}

export interface StartTeamAttemptInput {
  sessionId: string;
  assignmentKey: string;
  role: string;
  agentId: Uuid | null;
  instructions: string;
  round?: number;
  /** The provider run behind it, where it has one yet. */
  runId?: Uuid | null;
  evidenceBaseline?: TeamEvidenceBaseline | null;
  /** The attempt this one replaces: same session, same assignment, not already replaced. */
  supersedes?: string;
  now?: number;
}

/**
 * Starts an attempt at an assignment, numbered after every attempt at the
 * same assignment and round. Refused on a session that is not open, on an
 * independent team's key it does not have, and on a supersession of an
 * attempt that is not this assignment's or was already replaced.
 */
export function startTeamAttempt(db: Db, input: StartTeamAttemptInput): TeamWrite<{ attempt: TeamAttemptRow }> {
  const now = input.now ?? Date.now();
  const round = input.round ?? 1;
  const answer = db.transaction((tx): TeamWrite<{ attempt: TeamAttemptRow }> => {
    const session = getTeamSession(tx as unknown as Db, input.sessionId);
    if (session === undefined) return { ok: false, problem: "There is no such team session." };
    const stale = staleProblem(session);
    if (stale !== null) return { ok: false, problem: stale };
    if (session.team.coordination === "independent" && !session.team.participants.some((participant) => participant.key === input.assignmentKey)) {
      return { ok: false, problem: `This team has no participant "${input.assignmentKey}".` };
    }
    if (input.supersedes !== undefined) {
      const replaced = getTeamAttempt(tx as unknown as Db, input.supersedes);
      if (replaced === undefined || replaced.sessionId !== session.id || replaced.assignmentKey !== input.assignmentKey) {
        return { ok: false, problem: "An attempt can only replace an earlier attempt at the same assignment in the same session." };
      }
      if (replaced.supersededBy !== null) return { ok: false, problem: "That attempt was already replaced." };
    }
    const highest = tx
      .select({ n: sql<number | null>`max(${teamAttempts.attempt})` })
      .from(teamAttempts)
      .where(and(eq(teamAttempts.sessionId, session.id), eq(teamAttempts.assignmentKey, input.assignmentKey), eq(teamAttempts.round, round)))
      .get();
    const agentName = input.agentId === null ? "" : (tx.select({ name: agents.name }).from(agents).where(eq(agents.id, input.agentId)).get()?.name ?? "");
    const id = uuidv7();
    const row = tx
      .insert(teamAttempts)
      .values({
        id,
        sessionId: session.id,
        itemId: session.itemId,
        assignmentKey: input.assignmentKey,
        role: input.role,
        agentId: input.agentId,
        agentName,
        instructions: input.instructions,
        round,
        attempt: (highest?.n ?? 0) + 1,
        runId: input.runId ?? null,
        status: input.runId === undefined || input.runId === null ? "queued" : "running",
        evidenceBaseline: input.evidenceBaseline ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    if (input.supersedes !== undefined) {
      tx.update(teamAttempts).set({ supersededBy: id, updatedAt: now }).where(eq(teamAttempts.id, input.supersedes)).run();
    }
    touchSession(tx as unknown as Db, session.id, now);
    return { ok: true, attempt: attemptOf(row) };
  });
  if (answer.ok) notifyTeamSessionWritten(db, { sessionId: answer.attempt.sessionId as Uuid, itemId: answer.attempt.itemId as Uuid });
  return answer;
}

/** Gives a queued attempt its provider run. A run once given is never replaced: a new run is a new attempt. */
export function beginTeamAttempt(db: Db, attemptId: string, runId: Uuid, now: number = Date.now()): TeamWrite<{ attempt: TeamAttemptRow }> {
  const attempt = getTeamAttempt(db, attemptId);
  if (attempt === undefined) return { ok: false, problem: "There is no such team attempt." };
  if (attempt.runId === runId) return { ok: true, attempt };
  if (attempt.runId !== null || attempt.status !== "queued") return { ok: false, problem: "That attempt has already started; another run is another attempt." };
  db.update(teamAttempts).set({ runId, status: "running", updatedAt: now }).where(eq(teamAttempts.id, attemptId)).run();
  touchSession(db, attempt.sessionId, now);
  notifyTeamSessionWritten(db, { sessionId: attempt.sessionId as Uuid, itemId: attempt.itemId as Uuid });
  return { ok: true, attempt: getTeamAttempt(db, attemptId)! };
}

/**
 * Ends an attempt that could not contribute — `failed` with what went
 * wrong, or `cancelled`. Kept apart from any conclusion: it carries no
 * outcome. An attempt that already ended keeps how it ended; the same end
 * reported again is not an error.
 */
export function endTeamAttempt(
  db: Db,
  attemptId: string,
  end: { status: "failed" | "cancelled"; error: string },
  now: number = Date.now(),
): TeamWrite<{ attempt: TeamAttemptRow }> {
  const attempt = getTeamAttempt(db, attemptId);
  if (attempt === undefined) return { ok: false, problem: "There is no such team attempt." };
  if (attempt.status === end.status) return { ok: true, attempt };
  if (ENDED_ATTEMPT.has(attempt.status)) return { ok: false, problem: `That attempt has already ended (${attempt.status}).` };
  db.update(teamAttempts).set({ status: end.status, error: end.error, endedAt: now, updatedAt: now }).where(eq(teamAttempts.id, attemptId)).run();
  touchSession(db, attempt.sessionId, now);
  notifyTeamSessionWritten(db, { sessionId: attempt.sessionId as Uuid, itemId: attempt.itemId as Uuid });
  return { ok: true, attempt: getTeamAttempt(db, attemptId)! };
}

export interface AcceptTeamReportInput {
  attemptId: string;
  /** One of the team's declared outcomes; null only for a leader's team that declares none. */
  outcome: string | null;
  report: string;
  now?: number;
}

/**
 * Accepts an attempt's report: posts it on the item's thread, attributed
 * to the attempt's agent and run, and names that comment on the attempt —
 * in one transaction, so neither exists without the other.
 *
 * Idempotent. An attempt that already has its report answers with that
 * comment and writes nothing, so recovery that delivers the same result
 * again posts no second comment and counts no second contribution.
 *
 * Refused for a session that is not open, an item that has left the
 * session's step entry, a replaced or ended attempt, and an outcome the
 * team does not declare.
 */
export function acceptTeamReport(db: Db, input: AcceptTeamReportInput): TeamWrite<{ attempt: TeamAttemptRow; comment: Comment; duplicate: boolean }> {
  const now = input.now ?? Date.now();
  const answer = db.transaction((tx): TeamWrite<{ attempt: TeamAttemptRow; comment: Comment; duplicate: boolean }> => {
    const txDb = tx as unknown as Db;
    const attempt = getTeamAttempt(txDb, input.attemptId);
    if (attempt === undefined) return { ok: false, problem: "There is no such team attempt." };
    if (attempt.reportCommentId !== null) {
      const already = getComment(txDb, attempt.reportCommentId as Uuid);
      if (already !== undefined) return { ok: true, attempt, comment: already, duplicate: true };
    }
    const session = getTeamSession(txDb, attempt.sessionId)!;
    const stale = staleProblem(session);
    if (stale !== null) return { ok: false, problem: stale };
    if (!onSessionEntry(txDb, session)) return { ok: false, problem: "The item has left the step this team session was working on, so it takes no more contributions." };
    if (attempt.supersededBy !== null) return { ok: false, problem: "That attempt was replaced by a newer one, so its report is not taken." };
    if (ENDED_ATTEMPT.has(attempt.status)) return { ok: false, problem: `That attempt has already ended (${attempt.status}).` };
    const declared = session.team.outcomes;
    const outcome = declared.find((one) => one.key === input.outcome);
    if (declared.length > 0 && outcome === undefined) return { ok: false, problem: `"${input.outcome ?? ""}" is not an outcome this team declares.` };
    if (declared.length === 0 && input.outcome !== null) return { ok: false, problem: "This team declares no outcomes, so a report carries none." };

    const heading = outcome === undefined ? `**${attempt.assignmentKey}**` : `**${attempt.assignmentKey}** — ${outcome.label}`;
    // On `db`, not the transaction's handle: what was posted is announced
    // to the listeners keyed on `db` — the record's outbound queue among
    // them — and better-sqlite3 nests this into the open transaction.
    const comment = postComment(db, {
      itemId: attempt.itemId as Uuid,
      author: attempt.agentId === null ? { type: "engine" } : { type: "agent", agentId: attempt.agentId as Uuid },
      runId: (attempt.runId as Uuid | null) ?? null,
      body: `${heading}\n\n${input.report.trim()}`,
      // A report is a document, not an address: an `@name` in it summons nobody.
      parseBodyMentions: false,
      createdAt: now,
    });
    tx.update(teamAttempts)
      .set({ status: "completed", outcome: input.outcome, reportCommentId: comment.id, acceptedAt: now, endedAt: now, updatedAt: now })
      .where(eq(teamAttempts.id, attempt.id))
      .run();
    touchSession(txDb, session.id, now);
    return { ok: true, attempt: getTeamAttempt(txDb, attempt.id)!, comment, duplicate: false };
  });
  if (answer.ok && !answer.duplicate) notifyTeamSessionWritten(db, { sessionId: answer.attempt.sessionId as Uuid, itemId: answer.attempt.itemId as Uuid });
  return answer;
}

export interface EndTeamSessionInput {
  sessionId: string;
  /** `finalized` with the step's result; `failed` when the team could not decide; `cancelled` when stopped. */
  status: "finalized" | "failed" | "cancelled";
  result?: string | null;
  /** The output comment the final answer was posted as. */
  finalCommentId?: Uuid | null;
  now?: number;
}

/**
 * Ends a session — once. Refused for a session already superseded or
 * ended otherwise, and, to finalise, for an item that has left the
 * session's step entry or an attempt still at work. The same end reported
 * again is not an error and writes nothing.
 */
export function endTeamSession(db: Db, input: EndTeamSessionInput): TeamWrite<{ session: TeamSessionRow }> {
  const now = input.now ?? Date.now();
  const answer = db.transaction((tx): TeamWrite<{ session: TeamSessionRow; changed: boolean }> => {
    const txDb = tx as unknown as Db;
    const session = getTeamSession(txDb, input.sessionId);
    if (session === undefined) return { ok: false, problem: "There is no such team session." };
    if (session.status === input.status && session.result === (input.result ?? null)) return { ok: true, session, changed: false };
    if (session.status === "superseded") return { ok: false, problem: "This team session was superseded by a newer one, so it cannot be finalised." };
    if (session.status !== "open") return { ok: false, problem: `This team session has already ended (${session.status}).` };
    if (input.status !== "cancelled") {
      if (!onSessionEntry(txDb, session)) return { ok: false, problem: "The item has left the step this team session was working on, so the session cannot be finalised." };
      const working = listTeamAttempts(txDb, session.id).filter((attempt) => attempt.supersededBy === null && !ENDED_ATTEMPT.has(attempt.status));
      if (working.length > 0) return { ok: false, problem: `Still at work: ${working.map((attempt) => attempt.assignmentKey).join(", ")}.` };
    }
    if (input.status === "finalized" && (input.result ?? null) === null) return { ok: false, problem: "A finalised session needs the step's result." };
    tx.update(teamSessions)
      .set({ status: input.status, result: input.result ?? null, finalCommentId: input.finalCommentId ?? null, endedAt: now, updatedAt: now })
      .where(eq(teamSessions.id, session.id))
      .run();
    return { ok: true, session: getTeamSession(txDb, session.id)!, changed: true };
  });
  if (!answer.ok) return answer;
  if (answer.changed) notifyTeamSessionWritten(db, { sessionId: answer.session.id as Uuid, itemId: answer.session.itemId as Uuid });
  return { ok: true, session: answer.session };
}

// ── Spending ────────────────────────────────────────────────────────

export interface TeamTotals {
  /** Distinct runs counted: the session's own and every attempt's, superseded ones included. */
  runs: number;
  tokensIn: number;
  tokensOut: number;
  costCents: number;
}

/**
 * What a session spent: the session's own run and every attempt's run,
 * each once — superseded and failed attempts included, because their
 * spending happened. The orchestration's run carries only its own, never
 * its children's, so this is the same money the item's and the day's
 * totals count, and counts it once.
 */
export function teamSessionTotals(db: Db, sessionId: string): TeamTotals {
  const session = getTeamSession(db, sessionId);
  if (session === undefined) return { runs: 0, tokensIn: 0, tokensOut: 0, costCents: 0 };
  const runIds = new Set<string>();
  if (session.runId !== null) runIds.add(session.runId);
  for (const attempt of listTeamAttempts(db, sessionId)) if (attempt.runId !== null) runIds.add(attempt.runId);
  if (runIds.size === 0) return { runs: 0, tokensIn: 0, tokensOut: 0, costCents: 0 };
  const row = db
    .select({
      tokensIn: sql<number | null>`sum(${runs.tokensIn})`,
      tokensOut: sql<number | null>`sum(${runs.tokensOut})`,
      costCents: sql<number | null>`sum(${runs.costCents})`,
    })
    .from(runs)
    .where(inArray(runs.id, [...runIds]))
    .get();
  return { runs: runIds.size, tokensIn: row?.tokensIn ?? 0, tokensOut: row?.tokensOut ?? 0, costCents: row?.costCents ?? 0 };
}

// ── Between machines ────────────────────────────────────────────────

/** Sessions changed since the cursor, each with its attempts, for the record's feed. */
export function listTeamSessionsUpdatedSince(db: Db, cursor: RecordCursor, limit: number, within?: string): TeamSessionRecord[] {
  return db
    .select()
    .from(teamSessions)
    .where(
      and(
        sql`(${teamSessions.updatedAt} > ${cursor.ts} or (${teamSessions.updatedAt} = ${cursor.ts} and ${teamSessions.id} > ${cursor.id}))`,
        within === undefined ? undefined : onProject(teamSessions.itemId, within),
      ),
    )
    .orderBy(asc(teamSessions.updatedAt), asc(teamSessions.id))
    .limit(limit)
    .all()
    .map((row) => ({ session: sessionOf(row), attempts: listTeamAttempts(db, row.id) }));
}

/** A session as the command that reports it. */
export function teamSessionCommand(db: Db, sessionId: string): RecordTeamSessionCommand | undefined {
  const record = getTeamSessionRecord(db, sessionId);
  if (record === undefined) return undefined;
  return { kind: "teamSession", id: uuidv7(), itemId: record.session.itemId, ...record };
}

/** Every run a session names — its own and its attempts' — which the far side must hold first. */
export function runsOfTeamSession(record: TeamSessionRecord): string[] {
  const ids = new Set<string>();
  if (record.session.runId !== null) ids.add(record.session.runId);
  for (const attempt of record.attempts) if (attempt.runId !== null) ids.add(attempt.runId);
  return [...ids];
}

/** Every comment a session names — its reports and its final answer. */
function commentsOfTeamSession(record: TeamSessionRecord): string[] {
  const ids = new Set<string>();
  if (record.session.finalCommentId !== null) ids.add(record.session.finalCommentId);
  for (const attempt of record.attempts) if (attempt.reportCommentId !== null) ids.add(attempt.reportCommentId);
  return [...ids];
}

/** What a session names that this database does not hold yet, in words, or null when it holds all of it. */
export function teamSessionWaitingFor(db: Db, record: TeamSessionRecord): string | null {
  if (db.select({ id: items.id }).from(items).where(eq(items.id, record.session.itemId)).get() === undefined) return `item ${record.session.itemId}`;
  for (const runId of runsOfTeamSession(record)) {
    if (db.select({ id: runs.id }).from(runs).where(eq(runs.id, runId)).get() === undefined) return `run ${runId}`;
  }
  for (const commentId of commentsOfTeamSession(record)) {
    if (db.select({ id: comments.id }).from(comments).where(eq(comments.id, commentId)).get() === undefined) return `comment ${commentId}`;
  }
  return null;
}

/**
 * Merges an incoming copy of a session into what is held: what only grows
 * is never taken back. An ended session stays ended as it ended; the
 * device that owns it, once known, stays known.
 */
function mergeSession(held: TeamSessionRow | undefined, incoming: TeamSessionRow): TeamSessionRow {
  if (held === undefined) return incoming;
  const ended = held.status !== "open";
  return {
    ...incoming,
    status: ended ? held.status : incoming.status,
    result: ended ? held.result : incoming.result,
    finalCommentId: held.finalCommentId ?? incoming.finalCommentId,
    supersededBy: held.supersededBy ?? incoming.supersededBy,
    endedAt: held.endedAt ?? incoming.endedAt,
    deviceId: held.deviceId ?? incoming.deviceId,
    createdAt: held.createdAt,
  };
}

/**
 * The same for one attempt: an accepted report, its outcome, an end and a
 * supersession are each written once and kept, so a copy that arrives
 * late or twice cannot accept a second contribution or undo the first.
 */
function mergeAttempt(held: TeamAttemptRow | undefined, incoming: TeamAttemptRow): TeamAttemptRow {
  if (held === undefined) return incoming;
  const accepted = held.reportCommentId !== null;
  const ended = ENDED_ATTEMPT.has(held.status);
  return {
    ...incoming,
    status: ended ? held.status : incoming.status,
    outcome: accepted ? held.outcome : incoming.outcome,
    reportCommentId: held.reportCommentId ?? incoming.reportCommentId,
    acceptedAt: held.acceptedAt ?? incoming.acceptedAt,
    error: ended ? held.error : incoming.error,
    endedAt: held.endedAt ?? incoming.endedAt,
    runId: held.runId ?? incoming.runId,
    supersededBy: held.supersededBy ?? incoming.supersededBy,
    createdAt: held.createdAt,
  };
}

/** An agent this database knows, or null: the attempt keeps the name either way. */
function knownAgentId(db: Db, agentId: string | null): string | null {
  if (agentId === null) return null;
  return db.select({ id: agents.id }).from(agents).where(eq(agents.id, agentId)).get() === undefined ? null : agentId;
}

/**
 * Writes a session and its attempts as merged, stamping both with `stamp`
 * where given — the record's clock, which its replicas page on — or
 * keeping the copy's own. Announces nothing: what arrived from elsewhere
 * is not sent on again.
 */
function writeMerged(db: Db, record: TeamSessionRecord, stamp: number | null): void {
  db.transaction((tx) => {
    const txDb = tx as unknown as Db;
    const session = mergeSession(getTeamSession(txDb, record.session.id), record.session);
    const sessionRow = { ...session, updatedAt: stamp ?? session.updatedAt, team: session.team };
    tx.insert(teamSessions)
      .values(sessionRow)
      .onConflictDoUpdate({ target: teamSessions.id, set: { ...sessionRow, id: undefined } })
      .run();
    for (const incoming of record.attempts) {
      const attempt = mergeAttempt(getTeamAttempt(txDb, incoming.id), incoming);
      const attemptRow = { ...attempt, agentId: knownAgentId(txDb, attempt.agentId), updatedAt: stamp ?? attempt.updatedAt };
      tx.insert(teamAttempts)
        .values(attemptRow)
        .onConflictDoUpdate({ target: teamAttempts.id, set: { ...attemptRow, id: undefined } })
        .run();
    }
  });
}

/**
 * A session arriving with a project moved onto this record (EO-844):
 * written as the mover had it, stamped with this record's clock, and
 * owned by the device that moved it where the session names none. Answers
 * why it could not be, or null once it is.
 */
export function writeAdoptedTeamSession(db: Db, record: TeamSessionRecord, deviceId: string, stamp: number): string | null {
  const waiting = teamSessionWaitingFor(db, record);
  if (waiting !== null) return `team session ${record.session.id} names ${waiting}, which did not arrive`;
  writeMerged(db, { session: { ...record.session, deviceId: record.session.deviceId ?? deviceId }, attempts: record.attempts }, stamp);
  return null;
}

/**
 * A replica writing down the record's copy of a session (EO-844). Held,
 * with what it waits for, when the item, a run or a comment it names is
 * not here yet; otherwise merged, never taking back what only grows.
 */
export function mirrorTeamSession(db: Db, record: TeamSessionRecord): { placed: true } | { placed: false; waitingFor: string } {
  const waiting = teamSessionWaitingFor(db, record);
  if (waiting !== null) return { placed: false, waitingFor: waiting };
  const held = getTeamSession(db, record.session.id);
  if (held !== undefined && held.updatedAt >= record.session.updatedAt) return { placed: true };
  writeMerged(db, record, null);
  return { placed: true };
}

/**
 * Whether a copy of a session says nothing the held one does not: no
 * attempt the held one lacks, no report, supersession or end it has not
 * got, and the session's own state no further on.
 */
function addsNothing(db: Db, held: TeamSessionRow, command: RecordTeamSessionCommand): boolean {
  if (held.status === "open" && command.session.status !== "open") return false;
  if (held.status === "open" && (held.result !== command.session.result || held.supersededBy !== command.session.supersededBy)) return false;
  for (const incoming of command.attempts) {
    const attempt = getTeamAttempt(db, incoming.id);
    if (attempt === undefined) return false;
    if (attempt.reportCommentId === null && incoming.reportCommentId !== null) return false;
    if (attempt.supersededBy === null && incoming.supersededBy !== null) return false;
    if (attempt.runId === null && incoming.runId !== null) return false;
    if (!ENDED_ATTEMPT.has(attempt.status) && attempt.status !== incoming.status) return false;
  }
  return true;
}

/**
 * The record applying a device's report of a session (EO-844).
 *
 * A device may report only a session that is its own and current:
 *
 * - **Stale device.** Refused while another device holds the item's lease,
 *   or when the session belongs to another device. The one exception is
 *   the current lease holder ending somebody else's session as
 *   `superseded`, which is how a session left behind by a device that lost
 *   the item is closed so the new one can open.
 * - **Superseded or ended session.** Takes nothing more, and a copy
 *   carrying more is refused.
 *
 * A copy that adds nothing to what is held — a replay — is acknowledged
 * first, whoever sent it, and writes nothing.
 * - **Moved item.** A session whose item the record has on another step
 *   cannot accept a report or finalise.
 * - **A second open session.** Refused: the item's open session has to be
 *   superseded first, which the device reports first.
 *
 * What is applied is merged: a report accepted here, an end and a
 * supersession are never taken back by a later or repeated copy.
 */
export function applyReportedTeamSession(db: Db, deviceId: string, command: RecordTeamSessionCommand, now: number = Date.now()): TeamWrite<{ changed: boolean }> {
  const incoming = command.session;
  if (incoming.itemId !== command.itemId || command.attempts.some((attempt) => attempt.sessionId !== incoming.id || attempt.itemId !== incoming.itemId)) {
    return { ok: false, problem: "That team session's attempts do not belong to it." };
  }
  const held = getTeamSession(db, incoming.id);
  // A copy that adds nothing to what is held — a replay after a lost
  // acknowledgement, an older copy arriving behind a newer one — is
  // acknowledged and writes nothing, whoever sent it.
  if (held !== undefined && addsNothing(db, held, command)) return { ok: true, changed: false };

  const lease = leaseFor(db, incoming.itemId as Uuid);
  const holdsLease = lease !== null && lease.deviceId === deviceId && lease.expiresAt > now;
  const heldElsewhere = lease !== null && lease.deviceId !== deviceId && lease.expiresAt > now;

  if (held !== undefined && held.deviceId !== null && held.deviceId !== deviceId) {
    if (incoming.status === "superseded" && holdsLease && held.status === "open") {
      db.update(teamSessions).set({ status: "superseded", supersededBy: incoming.supersededBy, endedAt: incoming.endedAt ?? now, updatedAt: now }).where(eq(teamSessions.id, held.id)).run();
      return { ok: true, changed: true };
    }
    return { ok: false, problem: "That team session belongs to another device, so this one cannot report it." };
  }
  if (heldElsewhere) return { ok: false, problem: "Another device holds this item now, so a team session reported from here is stale." };

  if (held !== undefined && held.status !== "open") {
    return {
      ok: false,
      problem: held.status === "superseded" ? "That team session was superseded, so it takes no more contributions." : `That team session has already ended (${held.status}).`,
    };
  }

  const waiting = teamSessionWaitingFor(db, command);
  if (waiting !== null) return { ok: false, problem: `This record has no ${waiting} yet — send it before the team session that names it.` };

  const ending = incoming.status === "cancelled" || incoming.status === "superseded";
  const item = db.select({ stepId: items.stepId }).from(items).where(eq(items.id, incoming.itemId)).get();
  if (!ending && item?.stepId !== incoming.stepId) {
    return { ok: false, problem: "This record has the item on another step now, so that team session can neither take a contribution nor finalise." };
  }
  for (const attempt of command.attempts) {
    const heldAttempt = held === undefined ? undefined : getTeamAttempt(db, attempt.id);
    if (heldAttempt?.supersededBy != null && heldAttempt.reportCommentId === null && attempt.reportCommentId !== null) {
      return { ok: false, problem: `The attempt at "${attempt.assignmentKey}" was replaced, so its report is not taken.` };
    }
  }
  if (held === undefined) {
    const other = currentTeamSession(db, incoming.itemId);
    if (other !== undefined && other.id !== incoming.id && incoming.status === "open") {
      return { ok: false, problem: "This record has another team session open on this item, so that one is not current." };
    }
  }

  writeMerged(db, { session: { ...incoming, deviceId: held?.deviceId ?? deviceId }, attempts: command.attempts }, now);
  return { ok: true, changed: true };
}
