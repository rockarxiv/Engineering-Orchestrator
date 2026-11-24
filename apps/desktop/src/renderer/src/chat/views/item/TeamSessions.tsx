import { Fragment, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { memberModeWords, type TeamAssignmentView, type TeamAttemptShown, type TeamAttemptView, type TeamSessionState, type TeamSessionView, type TeamWaitKind } from "@eo/core";
import { cn } from "@eo/ui";
import { ipcQuery } from "../../../query/client";
import { namesItemOrNone, useInvalidateOnPush } from "../../../query/useInvalidateOnPush";
import { Button, Card, Chip, ErrorLine, GroupLabel, TextArea } from "../../kit";

/**
 * An item's team sessions (EO-849, ARCHITECTURE.md, "A team on an agent
 * step"): one session with its participants underneath — never several
 * runs that look like competing owners of the step.
 *
 * Everything drawn is `items:teamSessions`, read again on the item's and
 * its runs' pushes, so a reload or a reconnect draws the same session from
 * what is stored, reports finished while the window was closed included.
 * The reports, questions and answer stay comments on the thread
 * (invariant 4): this groups and points at them, and copies none of them.
 * A control a person may not press is not drawn — its reason is.
 */

export const teamSessionsKey = (itemId: string) => ["item", itemId, "teamSessions"] as const;

export function useTeamSessions(itemId: string) {
  const key = teamSessionsKey(itemId);
  const ours = namesItemOrNone(itemId);
  useInvalidateOnPush("items:changed", key, { filter: ours });
  useInvalidateOnPush("runs:changed", key, { filter: ours });
  return useQuery({ queryKey: key, queryFn: () => ipcQuery("items:teamSessions", { itemId }) });
}

/** `**key**` in EO's sentences, drawn bold; nothing else is read as markup. */
function Words({ children }: { children: string }) {
  const parts = children.split(/\*\*([^*]+)\*\*/g);
  return (
    <>
      {parts.map((part, index) => (index % 2 === 1 ? <strong key={index} className="font-medium text-ink">{part}</strong> : <Fragment key={index}>{part}</Fragment>))}
    </>
  );
}

const SESSION_STATE: Record<TeamSessionState, { label: string; tone: "running" | "paused" | "success" | "danger" | "neutral" }> = {
  running: { label: "Working", tone: "running" },
  waiting: { label: "Waiting", tone: "paused" },
  finalized: { label: "Settled", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  superseded: { label: "Superseded", tone: "neutral" },
  stopped: { label: "Stopped — the item moved", tone: "neutral" },
};

/**
 * What each state of an attempt is called. A failed attempt and a negative
 * finding never share a word: "Could not contribute" is an execution
 * failure, while a completed report says what it concluded.
 */
const ATTEMPT_STATE: Record<TeamAttemptShown, { label: string; tone: "running" | "paused" | "success" | "danger" | "neutral" }> = {
  queued: { label: "Queued", tone: "neutral" },
  running: { label: "Running", tone: "running" },
  waiting: { label: "Waiting for an answer", tone: "paused" },
  completed: { label: "Reported", tone: "success" },
  failed: { label: "Could not contribute", tone: "danger" },
  cancelled: { label: "Stopped by EO", tone: "neutral" },
  superseded: { label: "Superseded", tone: "neutral" },
  stopped: { label: "Stopped", tone: "neutral" },
};

const WAIT_LABEL: Record<TeamWaitKind, string> = {
  capacity: "Waiting for room",
  contribution: "Waiting on contributions",
  human: "Waiting for your answer",
  enforcement: "Report-only not available",
  limits: "Limits reached",
  restricted: "Held back",
};

export function money(cents: number | null): string {
  if (cents === null) return "cost unknown";
  if (cents < 100) return `${Number.isInteger(cents) ? cents : cents.toFixed(1)}¢`;
  return `$${(cents / 100).toFixed(2)}`;
}

function duration(startedAt: number | null, endedAt: number | null, now: number): string | null {
  if (startedAt === null) return null;
  const seconds = Math.max(0, Math.round(((endedAt ?? now) - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * Takes a person to a comment on the item's thread: scrolled to where it
 * is drawn, or the item page asked to bring it onto its thread however far
 * back it is (`?comment=`, which `ItemView` reveals and scrolls to) — from
 * the runs page, and from the item page when it is not on screen yet.
 */
function useJumpToComment(itemId: string): (commentId: string) => void {
  const navigate = useNavigate();
  return (commentId) => {
    const shown = document.querySelector(`[data-comment-id="${CSS.escape(commentId)}"]`);
    if (shown !== null) shown.scrollIntoView?.({ block: "center" });
    else void navigate(`/items/${itemId}?comment=${encodeURIComponent(commentId)}`);
  };
}

export function TeamSessions({
  itemId,
  selectedRunId,
  onSelectRun,
  className,
}: {
  itemId: string;
  /** The run whose transcript is on screen, where one is. */
  selectedRunId?: string | null;
  /** Shows a participant's transcript; absent where there is no transcript to show beside the list. */
  onSelectRun?: (runId: string) => void;
  className?: string;
}) {
  const sessions = useTeamSessions(itemId);
  if (sessions.error) return <ErrorLine>{sessions.error.message}</ErrorLine>;
  const all = sessions.data?.sessions ?? [];
  if (all.length === 0) return null;
  const [newest, ...earlier] = all;
  return (
    <section aria-label="Team" className={cn("flex min-w-0 flex-col gap-2", className)}>
      <SessionCard itemId={itemId} session={newest!} selectedRunId={selectedRunId ?? null} onSelectRun={onSelectRun} />
      {earlier.length > 0 ? (
        <details className="text-[12.5px]">
          <summary className="cursor-pointer text-ink-muted">
            Earlier team sessions ({earlier.length})
          </summary>
          <div className="mt-2 flex flex-col gap-2">
            {earlier.map((session) => (
              <SessionCard key={session.id} itemId={itemId} session={session} selectedRunId={selectedRunId ?? null} onSelectRun={onSelectRun} />
            ))}
          </div>
        </details>
      ) : null}
    </section>
  );
}

function SessionCard({
  itemId,
  session,
  selectedRunId,
  onSelectRun,
}: {
  itemId: string;
  session: TeamSessionView;
  selectedRunId: string | null;
  onSelectRun: ((runId: string) => void) | undefined;
}) {
  const queryClient = useQueryClient();
  const jump = useJumpToComment(itemId);
  const [problem, setProblem] = useState<string | null>(null);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["item", itemId] });
  };
  const cancel = useMutation({
    mutationFn: () => ipcQuery("teams:cancel", { sessionId: session.id }),
    onSuccess: (answer) => {
      setProblem(answer.problem);
      refresh();
    },
    onError: (error: Error) => setProblem(error.message),
  });
  const retry = useMutation({
    mutationFn: () => ipcQuery("teams:retry", { sessionId: session.id }),
    onSuccess: (answer) => {
      setProblem(answer.problem);
      refresh();
    },
    onError: (error: Error) => setProblem(error.message),
  });
  const state = SESSION_STATE[session.state];
  const keyOf = new Map(session.assignments.flatMap((assignment) => assignment.attempts.map((attempt) => [attempt.id, attempt] as const)));
  const now = Date.now();

  return (
    <Card label={`Team session on ${session.stepName}`}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <GroupLabel>Team on {session.stepName}</GroupLabel>
        <Chip tone={state.tone}>{state.label}</Chip>
        <span className="text-[12px] text-ink-subtle">{session.coordination === "leader" ? "Leader-led" : "Independent"} · {memberModeWords(session.members)}</span>
        <span className="ml-auto text-[12px] text-ink-muted" title="Every run of this session counted once: its participants' and the team's own.">
          {money(session.totals.costCents)} · {session.totals.runs} run{session.totals.runs === 1 ? "" : "s"}
        </span>
      </div>

      {session.waiting.length > 0 ? (
        <ul aria-label="Why the team is waiting" className="mt-2 flex flex-col gap-1 text-[12.5px] text-ink-muted">
          {session.waiting.map((wait, index) => (
            <li key={index} data-wait-kind={wait.kind}>
              <span className="font-medium text-ink">{WAIT_LABEL[wait.kind]}:</span> <Words>{wait.text}</Words>
            </li>
          ))}
        </ul>
      ) : null}
      {session.endReason !== null ? (
        <p className="mt-2 text-[12.5px] text-ink-muted">
          <Words>{session.endReason}</Words>
        </p>
      ) : null}

      {session.final !== null ? (
        <div aria-label="What produced the result" className="mt-2 flex flex-col gap-1 text-[12.5px] text-ink-muted">
          <span>
            <span className="font-medium text-ink">Result {session.result ?? ""}</span>
            {session.final.by === "rule" ? (
              <> — by the completion rule: {session.final.rule ?? "the fallback"}</>
            ) : (
              <> — the leader's answer, checked by EO</>
            )}
            {session.final.outputCommentId !== null ? (
              <>
                {" "}
                <button type="button" className="text-accent hover:underline" onClick={() => jump(session.final!.outputCommentId!)}>
                  Final output
                </button>
              </>
            ) : null}
          </span>
          <span>
            From:{" "}
            {session.final.contributions.length === 0
              ? "no report"
              : session.final.contributions.map((attemptId, index) => {
                  const attempt = keyOf.get(attemptId);
                  return (
                    <Fragment key={attemptId}>
                      {index > 0 ? ", " : ""}
                      {attempt?.reportCommentId ? (
                        <button type="button" className="text-accent hover:underline" onClick={() => jump(attempt.reportCommentId!)}>
                          {attempt.assignmentKey}
                        </button>
                      ) : (
                        (attempt?.assignmentKey ?? attemptId)
                      )}
                    </Fragment>
                  );
                })}
          </span>
          {session.final.by === "leader" && session.final.disagreements !== null ? <span>Disagreements: {session.final.disagreements}</span> : null}
          {session.final.by === "leader" && session.final.limitations !== null ? <span>Limitations: {session.final.limitations}</span> : null}
        </div>
      ) : null}

      {session.assignments.length === 0 ? (
        <p className="mt-2 text-[12.5px] text-ink-muted">No participant has started yet.</p>
      ) : (
        <ul aria-label="Participants" className="mt-3 flex flex-col gap-2">
          {session.assignments.map((assignment) => (
            <AssignmentRow key={assignment.key} itemId={itemId} assignment={assignment} now={now} selectedRunId={selectedRunId} onSelectRun={onSelectRun} onJump={jump} />
          ))}
        </ul>
      )}

      <div aria-label="Session controls" className="mt-3 flex flex-col gap-1.5 border-t border-line/60 pt-2.5 text-[12px] text-ink-muted">
        <div className="flex flex-wrap items-center gap-2">
          {session.retry.allowed ? (
            <Button size="sm" disabled={retry.isPending} onClick={() => retry.mutate()}>
              Retry {session.retry.keys.join(", ")}
            </Button>
          ) : null}
          {session.cancel.allowed ? (
            <Button size="sm" variant="danger" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
              Cancel session
            </Button>
          ) : null}
        </div>
        {!session.retry.allowed && session.retry.reason !== null ? <span>Retry: {session.retry.reason}</span> : null}
        {!session.cancel.allowed && session.cancel.reason !== null ? <span>Cancel: {session.cancel.reason}</span> : null}
        {problem !== null ? <span role="alert" className="text-danger">{problem}</span> : null}
      </div>
    </Card>
  );
}

function AssignmentRow({
  itemId,
  assignment,
  now,
  selectedRunId,
  onSelectRun,
  onJump,
}: {
  itemId: string;
  assignment: TeamAssignmentView;
  now: number;
  selectedRunId: string | null;
  onSelectRun: ((runId: string) => void) | undefined;
  onJump: (commentId: string) => void;
}) {
  const current = assignment.attempts.find((attempt) => attempt.id === assignment.current) ?? assignment.attempts.at(-1);
  const earlier = assignment.attempts.filter((attempt) => attempt !== current);
  return (
    <li aria-label={`Participant ${assignment.key}`} className="flex min-w-0 flex-col gap-1 rounded-[10px] bg-canvas-subtle px-3 py-2">
      <div className="flex min-w-0 flex-wrap items-center gap-2 text-[12.5px]">
        <span className="font-medium text-ink">{assignment.leader ? "Leader" : assignment.key}</span>
        <span className="text-ink-subtle">
          {assignment.role}
          {assignment.required === false ? " · optional" : ""}
        </span>
      </div>
      {current !== undefined ? <AttemptLine itemId={itemId} attempt={current} now={now} selectedRunId={selectedRunId} onSelectRun={onSelectRun} onJump={onJump} /> : null}
      {earlier.length > 0 ? (
        <details className="text-[12px]">
          <summary className="cursor-pointer text-ink-subtle">
            {earlier.length} earlier attempt{earlier.length === 1 ? "" : "s"}
          </summary>
          <div className="mt-1 flex flex-col gap-1">
            {earlier.map((attempt) => (
              <AttemptLine key={attempt.id} itemId={itemId} attempt={attempt} now={now} selectedRunId={selectedRunId} onSelectRun={onSelectRun} onJump={onJump} />
            ))}
          </div>
        </details>
      ) : null}
    </li>
  );
}

function AttemptLine({
  itemId,
  attempt,
  now,
  selectedRunId,
  onSelectRun,
  onJump,
}: {
  itemId: string;
  attempt: TeamAttemptView;
  now: number;
  selectedRunId: string | null;
  onSelectRun: ((runId: string) => void) | undefined;
  onJump: (commentId: string) => void;
}) {
  const state = ATTEMPT_STATE[attempt.state];
  const took = duration(attempt.startedAt, attempt.endedAt, now);
  const facts: ReactNode[] = [
    <span key="who">
      {attempt.agentName || "No agent"}
      {/* The backend its run spoke to, as the run recorded it: a team may mix them. */}
      {attempt.provider === null ? "" : ` (${attempt.provider})`}
    </span>,
    <span key="n">
      round {attempt.round} · attempt {attempt.attempt}
    </span>,
    ...(took === null ? [] : [<span key="took">{took}</span>]),
    <span key="cost">{money(attempt.costCents)}</span>,
    ...(attempt.baseline === null
      ? []
      : [
          <span key="baseline" title={`${attempt.baseline.kind}: ${attempt.baseline.ref}`}>
            read {attempt.baseline.kind} {attempt.baseline.ref.slice(0, 10)}
            {attempt.baselineCurrent === false ? " (since changed)" : ""}
          </span>,
        ]),
  ];
  return (
    <div data-attempt-id={attempt.id} className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-ink-muted">
        <Chip tone={state.tone}>{state.label}</Chip>
        {attempt.outcomeLabel !== null ? <span className="font-medium text-ink">{attempt.outcomeLabel}</span> : null}
        {facts.map((fact, index) => (
          <Fragment key={index}>
            {index > 0 ? <span aria-hidden>·</span> : null}
            {fact}
          </Fragment>
        ))}
        {attempt.reportCommentId !== null ? (
          <button type="button" className="text-accent hover:underline" onClick={() => onJump(attempt.reportCommentId!)}>
            Report
          </button>
        ) : null}
        {attempt.runId !== null && onSelectRun !== undefined ? (
          <button type="button" aria-pressed={selectedRunId === attempt.runId} className="text-accent hover:underline" onClick={() => onSelectRun(attempt.runId!)}>
            Transcript
          </button>
        ) : null}
      </div>
      {attempt.error !== null && attempt.state !== "completed" ? (
        <p className="m-0 text-[12px] text-ink-subtle">
          <Words>{attempt.error}</Words>
        </p>
      ) : null}
      {attempt.questions.map((question) => (
        <Question key={question.commentId} itemId={itemId} assignmentKey={attempt.assignmentKey} commentId={question.commentId} body={question.body} answered={question.answered} />
      ))}
    </div>
  );
}

/**
 * A question a participant asked, answered here as a reply filed under it —
 * the same comment a reply on the thread would be — so the answer reaches
 * the assignment that asked and nobody else (EO-847).
 */
function Question({ itemId, assignmentKey, commentId, body, answered }: { itemId: string; assignmentKey: string; commentId: string; body: string; answered: boolean }) {
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const reply = useMutation({
    mutationFn: () => ipcQuery("comments:post", { itemId, body: text.trim(), parentId: commentId, mentions: [], pinned: false }),
    onSuccess: (answer) => {
      setProblem(answer.problem);
      if (answer.problem === null) setText("");
      void queryClient.invalidateQueries({ queryKey: ["item", itemId] });
    },
    onError: (error: Error) => setProblem(error.message),
  });
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-[8px] bg-canvas-raised px-2.5 py-1.5 text-[12.5px]">
      <span className="text-ink">
        <span className="text-ink-subtle">Asked:</span> {body}
      </span>
      {answered ? (
        <span className="text-ink-subtle">Answered.</span>
      ) : (
        <form
          className="flex min-w-0 items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (text.trim() !== "") reply.mutate();
          }}
        >
          <TextArea aria-label={`Answer ${assignmentKey}'s question`} rows={2} value={text} onChange={(event) => setText(event.target.value)} className="min-w-0 flex-1" />
          <Button size="sm" type="submit" disabled={reply.isPending || text.trim() === ""}>
            Answer
          </Button>
        </form>
      )}
      {problem !== null ? <span role="alert" className="text-danger">{problem}</span> : null}
    </div>
  );
}
