import {
  decideIndependentTeam,
  LEADER_ASSIGNMENT_KEY,
  readEvidenceBaseline,
  readTeamWaitNote,
  TEAM_ENFORCEMENT_UNAVAILABLE,
  TEAM_PARTICIPANT_ACTION,
  teamFacts,
  type Comment,
  type Run,
  type TeamAssignmentView,
  type TeamAttemptRow,
  type TeamAttemptShown,
  type TeamAttemptView,
  type TeamContribution,
  type TeamControl,
  type TeamFinalView,
  type TeamSessionRecord,
  type TeamSessionState,
  type TeamSessionView,
  type TeamWaitView,
  type Uuid,
} from "@eo/core";
import type { Db } from "../db/client.js";
import { listCommentsForItem } from "../db/repos/commentsRepo.js";
import { getStep } from "../db/repos/pipelineStepsRepo.js";
import { listRunsForItem } from "../db/repos/runsRepo.js";
import { listTeamSessionsForItem, teamRetryTargets, teamSessionOnEntry } from "../db/repos/teamSessionsRepo.js";
import { unansweredQuestions } from "../roles/clarificationQuestions.js";
import { evidenceContentKey } from "./teamSupervisor.js";

/**
 * An item's team sessions as a person reads them (EO-849,
 * `TeamSessionViewSchema`), newest first.
 *
 * Read from what is stored and nothing else — the sessions and attempts,
 * their runs, the thread — so a window opened after the fact, reloaded or
 * reconnected draws the same session, with every report finished while it
 * was closed. What is derived here is never written back (invariant 6):
 * whether an attempt is waiting on a question, whether a stored `running`
 * is really stopped, why the team is waiting, what produced its result,
 * and which controls a person may press.
 */
/**
 * Where a person's controls on a team would act (EO-849): this desktop, by
 * the device id its sessions are reported under, and the team runs EO
 * drives in this process. Null where nothing runs work here.
 */
export interface TeamControlSite {
  deviceId: string;
  drives: (runId: string) => boolean;
}

/**
 * Why a session's controls cannot act from here, or null when they can: a
 * session another desktop runs, or a team whose runs are working in no
 * process of this one. Stopping it here would stop nothing while saying it
 * had, and retrying it here would run it twice.
 */
export function teamNotHereProblem(db: Db, session: TeamSessionRecord["session"], site: TeamControlSite): string | null {
  if (session.deviceId !== null && session.deviceId !== site.deviceId) {
    return "This team session is running on another desktop, and only that desktop can stop or retry its participants.";
  }
  const runs = listRunsForItem(db, session.itemId as Uuid).filter((run) => ACTIVE_RUN.has(run.status));
  const teamRun = runs.find((run) => run.action !== TEAM_PARTICIPANT_ACTION && run.stepId === session.stepId);
  if (teamRun !== undefined) return site.drives(teamRun.id) ? null : NOT_HERE;
  return runs.some((run) => run.action === TEAM_PARTICIPANT_ACTION) ? NOT_HERE : null;
}

const NOT_HERE = "This team's runs are working, but not in EO on this desktop, so they can only be stopped or retried where they run.";
const NO_ENGINE = "EO is not running work on this desktop, so it cannot stop or retry a team here.";

export function itemTeamSessions(db: Db, itemId: string, site: TeamControlSite | null = null): TeamSessionView[] {
  const records = listTeamSessionsForItem(db, itemId);
  if (records.length === 0) return [];
  const runs = listRunsForItem(db, itemId as Uuid);
  const runById = new Map(runs.map((run) => [run.id as string, run]));
  const comments = listCommentsForItem(db, itemId as Uuid);
  const open = new Set<string>(unansweredQuestions(db, itemId as Uuid));
  // A team's own run belongs to the session it opened, and to no other.
  const openedBy = new Set(records.map((record) => record.session.runId).filter((id): id is string => id !== null));
  return records.map((record) => sessionView(db, record, runs, runById, comments, open, openedBy, site)).reverse();
}

const ACTIVE_RUN = new Set(["queued", "running"]);

/**
 * The team's own runs for a session, oldest first: the one that opened it,
 * and those that adopted it after a park or a restart — every run on its
 * step that is not a participant's, from the opening run's start to the
 * session's end, other sessions' opening runs excepted.
 */
function teamRunsOf(record: TeamSessionRecord, runs: readonly Run[], runById: ReadonlyMap<string, Run>, openedBy: ReadonlySet<string>): Run[] {
  const { session } = record;
  const opening = session.runId === null ? undefined : runById.get(session.runId);
  const from = opening?.startedAt ?? session.createdAt;
  const to = session.endedAt ?? Number.POSITIVE_INFINITY;
  return runs.filter((run) => {
    if (run.id === session.runId) return true;
    if (run.action === TEAM_PARTICIPANT_ACTION || run.stepId !== session.stepId || openedBy.has(run.id)) return false;
    return run.startedAt !== null && run.startedAt >= from && run.startedAt <= to;
  });
}

function sum(values: readonly (number | null)[]): number | null {
  let total: number | null = null;
  for (const value of values) if (value !== null) total = (total ?? 0) + value;
  return total;
}

function keysWords(keys: readonly string[]): string {
  return keys.map((key) => `**${key}**`).join(", ");
}

function sessionView(
  db: Db,
  record: TeamSessionRecord,
  runs: readonly Run[],
  runById: ReadonlyMap<string, Run>,
  comments: readonly Comment[],
  open: ReadonlySet<string>,
  openedBy: ReadonlySet<string>,
  site: TeamControlSite | null,
): TeamSessionView {
  const { session, attempts } = record;
  const team = session.team;
  const onEntry = session.status === "open" && teamSessionOnEntry(db, session);
  const teamRuns = teamRunsOf(record, runs, runById, openedBy);
  const latestTeamRun = teamRuns.at(-1);
  const working = teamRuns.some((run) => ACTIVE_RUN.has(run.status));
  const parked = !working && latestTeamRun?.status === "awaiting_input";
  const outcomeLabels = new Map(team.outcomes.map((outcome) => [outcome.key, outcome.label]));

  // The evidence the session's newest work was given: what "current" means for a baseline.
  const newestBaseline = [...attempts].reverse().find((attempt) => attempt.evidenceBaseline !== null)?.evidenceBaseline ?? null;
  const currentKey = evidenceContentKey(newestBaseline);

  const questionsOf = (attempt: TeamAttemptRow) =>
    attempt.runId === null
      ? []
      : comments
          .filter((comment) => comment.kind === "question" && comment.authorType === "agent" && comment.runId === attempt.runId)
          .map((comment) => ({ commentId: comment.id, body: comment.body, answered: !open.has(comment.id) }));

  const attemptView = (attempt: TeamAttemptRow): TeamAttemptView => {
    const run = attempt.runId === null ? undefined : runById.get(attempt.runId);
    const questions = questionsOf(attempt);
    let state: TeamAttemptShown = attempt.status;
    if (attempt.supersededBy !== null) state = "superseded";
    else if (ACTIVE_RUN.has(attempt.status)) {
      // Stored as at work, while nothing is working it: its session ended,
      // its item moved, its run ended, or the team's run is not running.
      const runEnded = run !== undefined && !ACTIVE_RUN.has(run.status);
      if (!onEntry || runEnded || !working) state = "stopped";
    } else if (attempt.status === "cancelled" && questions.some((question) => !question.answered)) state = "waiting";
    const baseline = attempt.evidenceBaseline === null ? null : { ...attempt.evidenceBaseline, capturedAt: readEvidenceBaseline(attempt.evidenceBaseline)?.capturedAt ?? null };
    return {
      id: attempt.id,
      assignmentKey: attempt.assignmentKey,
      leader: team.coordination === "leader" && attempt.assignmentKey === LEADER_ASSIGNMENT_KEY,
      role: attempt.role,
      agentId: attempt.agentId,
      agentName: attempt.agentName,
      provider: run?.provider ?? null,
      instructions: attempt.instructions,
      round: attempt.round,
      attempt: attempt.attempt,
      state,
      status: attempt.status,
      outcome: attempt.outcome,
      outcomeLabel: attempt.outcome === null ? null : (outcomeLabels.get(attempt.outcome) ?? attempt.outcome),
      error: attempt.error,
      enforcementUnavailable: attempt.status === "failed" && (attempt.error ?? "").startsWith(TEAM_ENFORCEMENT_UNAVAILABLE),
      baseline,
      baselineCurrent: baseline === null || currentKey === null ? null : evidenceContentKey(attempt.evidenceBaseline) === currentKey,
      reportCommentId: attempt.reportCommentId,
      acceptedAt: attempt.acceptedAt,
      runId: attempt.runId,
      startedAt: run?.startedAt ?? null,
      endedAt: run?.endedAt ?? attempt.endedAt,
      costCents: run?.costCents ?? null,
      tokensIn: run?.tokensIn ?? null,
      tokensOut: run?.tokensOut ?? null,
      supersedes: attempts.find((one) => one.supersededBy === attempt.id)?.id ?? null,
      supersededBy: attempt.supersededBy,
      questions,
    };
  };
  const views = attempts.map(attemptView);
  const current = views.filter((view) => view.supersededBy === null);

  // ── Assignments, in the team's order ────────────────────────────
  const leaderAssigned = new Map<string, boolean>();
  if (team.coordination === "leader") {
    for (const attempt of attempts) {
      if (attempt.assignmentKey !== LEADER_ASSIGNMENT_KEY || attempt.runId === null) continue;
      const verdict = leaderRecord(runById.get(attempt.runId))?.verdict;
      if (verdict?.decision === "assign" && Array.isArray(verdict.accepted)) {
        for (const one of verdict.accepted as { key?: unknown; required?: unknown }[]) {
          if (typeof one.key === "string") leaderAssigned.set(one.key, one.required !== false);
        }
      }
    }
  }
  const order: string[] =
    team.coordination === "independent" ? team.participants.map((participant) => participant.key) : [LEADER_ASSIGNMENT_KEY];
  for (const attempt of attempts) if (!order.includes(attempt.assignmentKey)) order.push(attempt.assignmentKey);
  const assignments: TeamAssignmentView[] = order.map((key) => {
    const mine = views.filter((view) => view.assignmentKey === key);
    const participant = team.coordination === "independent" ? team.participants.find((one) => one.key === key) : undefined;
    const leader = team.coordination === "leader" && key === LEADER_ASSIGNMENT_KEY;
    return {
      key,
      role: mine.at(-1)?.role ?? participant?.role ?? (leader && team.coordination === "leader" ? team.leader.role : ""),
      leader,
      required: participant !== undefined ? participant.required : leader ? true : (leaderAssigned.get(key) ?? null),
      current: mine.find((view) => view.supersededBy === null)?.id ?? null,
      attempts: mine,
    };
  });

  // ── What produced the result ────────────────────────────────────
  let final: TeamFinalView | null = null;
  if (session.status === "finalized") {
    if (team.coordination === "independent") {
      const settled = current.filter((view) => view.status === "completed" || view.status === "failed");
      const contributions: TeamContribution[] = settled.map((view) =>
        view.status === "completed"
          ? { key: view.assignmentKey, status: "completed", outcome: view.outcome ?? "", report: "" }
          : { key: view.assignmentKey, status: "failed", error: view.error ?? "" },
      );
      const decision = decideIndependentTeam(team, contributions);
      const ruleIndex = decision.status === "decided" ? decision.rule : null;
      const lines = teamFacts(team).completion;
      const teamRunIds = new Set(teamRuns.map((run) => run.id as string));
      const output = [...comments].reverse().find((comment) => comment.runId !== null && teamRunIds.has(comment.runId) && comment.authorType === "agent" && comment.kind !== "question");
      final = {
        by: "rule",
        rule: lines[ruleIndex ?? team.completion.rules.length] ?? null,
        ruleIndex,
        contributions: order.flatMap((key) => settled.filter((view) => view.assignmentKey === key && view.status === "completed").map((view) => view.id)),
        outputCommentId: output?.id ?? null,
      };
    } else {
      const leaderAttempt = attempts.find((attempt) => attempt.reportCommentId !== null && attempt.reportCommentId === session.finalCommentId) ?? attempts.filter((attempt) => attempt.assignmentKey === LEADER_ASSIGNMENT_KEY && attempt.supersededBy === null).at(-1);
      if (leaderAttempt !== undefined) {
        const recorded = leaderRecord(leaderAttempt.runId === null ? undefined : runById.get(leaderAttempt.runId));
        // The leader's answer as its turn gave it: the final answer under `outcome`, or bare.
        const raw = recorded?.answer as { outcome?: unknown } | undefined;
        const answer = (typeof raw?.outcome === "object" && raw.outcome !== null ? raw.outcome : raw) as { contributions?: unknown; disagreements?: unknown; limitations?: unknown } | undefined;
        const reportIds = Array.isArray(recorded?.verdict?.contributions) ? (recorded.verdict.contributions as unknown[]) : Array.isArray(answer?.contributions) ? answer.contributions : [];
        final = {
          by: "leader",
          attemptId: leaderAttempt.id,
          outputCommentId: session.finalCommentId ?? leaderAttempt.reportCommentId,
          contributions: reportIds.flatMap((reportId) => attempts.filter((attempt) => attempt.reportCommentId === reportId).map((attempt) => attempt.id)),
          disagreements: typeof answer?.disagreements === "string" ? answer.disagreements : null,
          limitations: typeof answer?.limitations === "string" ? answer.limitations : null,
        };
      }
    }
  }

  // ── Why it is waiting ───────────────────────────────────────────
  const retryTargets = onEntry ? teamRetryTargets(db, record) : [];
  const waiting: TeamWaitView[] = [];
  if (onEntry) {
    const asking = current.filter((view) => view.state === "waiting");
    if (asking.length > 0) {
      waiting.push({ kind: "human", keys: asking.map((view) => view.assignmentKey), text: `${keysWords(asking.map((view) => view.assignmentKey))} asked a question; the team goes on once every question has an answer.` });
    }
    const unenforced = current.filter((view) => view.enforcementUnavailable);
    if (unenforced.length > 0) {
      waiting.push({
        kind: "enforcement",
        keys: unenforced.map((view) => view.assignmentKey),
        text: `EO could not hold ${unenforced.map((view) => `**${view.assignmentKey}** (${view.agentName || view.role})`).join(", ")} to report-only on this machine, so it was never started: ${(unenforced[0]!.error ?? "").slice(TEAM_ENFORCEMENT_UNAVAILABLE.length)}`,
      });
    }
    if (parked && asking.length === 0 && latestTeamRun?.error) {
      waiting.push({ kind: "limits", keys: retryTargets.map((target) => target.assignmentKey), text: latestTeamRun.error });
    }
    if (working) {
      // Room, and what holds it back: the newest wait note for an
      // assignment nothing has been started for since.
      const teamRunIds = new Set(teamRuns.map((run) => run.id as string));
      const notes = new Map<string, { kind: "capacity" | "restricted"; reason: string }>();
      for (const comment of comments) {
        if (comment.authorType !== "engine" || comment.runId === null || !teamRunIds.has(comment.runId)) continue;
        const read = readTeamWaitNote(comment.body);
        if (read === null) continue;
        const startedSince = attempts.some((attempt) => attempt.assignmentKey === read.key && attempt.createdAt >= comment.createdAt);
        if (startedSince) notes.delete(read.key);
        else notes.set(read.key, { kind: read.kind, reason: read.reason });
      }
      const byReason = new Map<string, TeamWaitView>();
      for (const [key, note] of notes) {
        const settledHere = current.some((view) => view.assignmentKey === key && (view.state === "completed" || view.state === "running"));
        if (settledHere) continue;
        const id = `${note.kind}:${note.reason}`;
        const existing = byReason.get(id);
        if (existing === undefined) byReason.set(id, { kind: note.kind, keys: [key], text: note.reason });
        else existing.keys.push(key);
      }
      waiting.push(...byReason.values());
      const busy = current.filter((view) => view.state === "running" || view.state === "queued");
      if (busy.length > 0) {
        const leaderIdle = team.coordination === "leader" && !busy.some((view) => view.leader);
        waiting.push({
          kind: "contribution",
          keys: busy.map((view) => view.assignmentKey),
          text: leaderIdle
            ? `The leader's next turn waits for ${keysWords(busy.map((view) => view.assignmentKey))} to report.`
            : `Waiting on ${keysWords(busy.map((view) => view.assignmentKey))} to report.`,
        });
      }
    }
    if (!working && !parked && waiting.length === 0) {
      waiting.push({
        kind: "restricted",
        keys: [],
        text:
          latestTeamRun?.error !== null && latestTeamRun?.error !== undefined
            ? `Nothing is working on it now: ${latestTeamRun.error}. EO carries the session on when it next runs the step.`
            : "Nothing is working on it now; EO carries the session on when it next runs the step.",
      });
    }
  }

  // ── What ended it ───────────────────────────────────────────────
  let state: TeamSessionState;
  if (session.status === "open") state = !onEntry ? "stopped" : working ? "running" : "waiting";
  else state = session.status;

  // ── Controls ────────────────────────────────────────────────────
  const endedWords = session.status === "superseded" ? "This session was superseded by a newer one" : `This session has already ended (${session.status})`;
  // Only where a press would act: on this desktop, on a team it runs or nobody runs.
  const notHere = session.status !== "open" ? null : site === null ? NO_ENGINE : teamNotHereProblem(db, session, site);
  const cancel: TeamControl =
    session.status !== "open"
      ? { allowed: false, reason: `${endedWords}, so there is nothing to cancel.` }
      : notHere !== null
        ? { allowed: false, reason: notHere }
        : { allowed: true, reason: null };
  const retryKeys = retryTargets.map((target) => target.assignmentKey);
  const retry: TeamControl & { keys: string[] } = (() => {
    const no = (reason: string) => ({ allowed: false, reason, keys: retryKeys });
    if (session.status !== "open") return no(`${endedWords}; a settled session never runs again. A new session starts when the step runs again.`);
    if (!onEntry) return no("The item has left the step this session worked on, so it takes nothing more.");
    if (notHere !== null) return no(notHere);
    if (working) return no("The team is still at work; EO retries a participant whose turn fails itself, within the team's retries.");
    if (current.some((view) => view.state === "waiting")) return no("A team member's question is still open: answer it, and the reply carries the team on.");
    if (!parked) return no("The team is not parked on this session; EO carries it on when it next runs the step.");
    if (retryKeys.length === 0) return no("Nothing failed that a retry would run again.");
    return { allowed: true, reason: null, keys: retryKeys };
  })();

  const counted = new Set<string>([...teamRuns.map((run) => run.id as string), ...attempts.flatMap((attempt) => (attempt.runId === null ? [] : [attempt.runId]))]);
  const countedRuns = [...counted].map((id) => runById.get(id)).filter((run): run is Run => run !== undefined);

  return {
    id: session.id,
    itemId: session.itemId,
    stepId: session.stepId,
    stepName: getStep(db, session.stepId)?.name ?? session.stepId,
    coordination: team.coordination,
    status: session.status,
    state,
    current: onEntry,
    result: session.result,
    final,
    teamRunIds: teamRuns.map((run) => run.id),
    createdAt: session.createdAt,
    endedAt: session.endedAt,
    totals: {
      runs: counted.size,
      costCents: sum(countedRuns.map((run) => run.costCents)),
      tokensIn: countedRuns.reduce((total, run) => total + (run.tokensIn ?? 0), 0),
      tokensOut: countedRuns.reduce((total, run) => total + (run.tokensOut ?? 0), 0),
      teamRunCents: sum(teamRuns.map((run) => run.costCents)) ?? 0,
    },
    waiting,
    endReason: session.status === "open" ? (onEntry ? null : "The item left the step this session worked on.") : session.status === "finalized" ? null : (latestTeamRun?.error ?? null),
    assignments,
    cancel,
    retry,
  };
}

interface LeaderRecord {
  answer?: unknown;
  verdict?: { decision?: unknown; accepted?: unknown; contributions?: unknown };
}

function leaderRecord(run: Run | undefined): LeaderRecord | null {
  const result = run?.result as { leader?: unknown } | null | undefined;
  return result?.leader === true ? (result as LeaderRecord) : null;
}
