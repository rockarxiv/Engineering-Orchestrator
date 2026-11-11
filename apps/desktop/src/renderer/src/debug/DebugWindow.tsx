import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Copy } from "lucide-react";
import { DEBUG_SENT_EVENT, DebugSentSchema, learningReviewActivityKind, type DebugAgent, type DebugRun, type DebugSent, type DebugSession } from "@eo/core";
import { cn } from "@eo/ui";
import { ipcQuery } from "../query/client";
import { useInvalidateOnPush } from "../query/useInvalidateOnPush";
import { groupRuns, isRunActive } from "../shared/transcript/grouping";
import { Button, Chip } from "../chat/kit";
import { useChatTheme } from "../chat/theme";
import { RunHeader, TranscriptLog, runTone, spokenStatus } from "../chat/views/transcript/Transcript";
import { TranscriptEvent } from "../chat/views/transcript/TranscriptEvent";
import { useTranscript, type TranscriptEventView } from "../shared/transcript/useTranscript";
import { useDebugMode } from "./debugMode";

/**
 * The debug window (EO-392): for each agent, what EO handed its backend
 * and what the agent is doing with it.
 *
 * What `index.html?window=debug` renders, and the only thing in that
 * window — no router, no sidebar, no assistant. One tab per agent with a
 * recorded run in the project, agents with one in flight first; each tab
 * lists that agent's recorded runs newest first, and the selected run is
 * drawn in two columns: what was sent, and the live activity.
 *
 * ## Read-only, all of it
 *
 * There is no control here that changes a run, an agent or a thread
 * (invariants #1 and #11). Not a cancel button, not a composer, not a
 * "send again": `RunHeader` is given no `onCancel`, and the transcript's
 * log is drawn without the box a run's view puts under it. The buttons
 * that exist select what is shown and copy text.
 *
 * ## Where the two columns come from
 *
 * One log. Both are `run_events` rows of the selected run, paged by the
 * transcript's own `useTranscript` and kept live by the same
 * `runs:progress` push — so the activity updates as the run goes without
 * the window being reloaded, exactly as a run screen's does. The rows of
 * type `debug_sent` are what was sent; everything else is the activity,
 * drawn by the transcript's own `TranscriptLog`.
 *
 * ## Recorded runs only
 *
 * A run with no `debug_sent` row was dispatched with debug mode off, and
 * main does not list it (EO-394): it has nothing to show in the first
 * column, and on an installation where debug mode is usually off such
 * runs buried the ones that do. It is still on the runs screen of the
 * work it belongs to. So every run drawn here has a recorded send, and
 * the only way its first column can be empty is a record that does not
 * parse — which is what that column then says.
 *
 * A run dispatched with debug mode on is listed once its first send is
 * written: the supervisor says `runs:progress` as it writes it, and that
 * push asks main for the tabs again.
 *
 * ## The learning review, apart
 *
 * The review after a run (EO-717) is a turn on a fork of the run's
 * thread, and debug mode records it on the run's log (EO-734): one
 * `debug_sent` row with purpose `learning_review`, then the fork's tool
 * calls, results and words under types of their own
 * (`LEARNING_REVIEW_ACTIVITY_EVENTS`). None of it is the run's, so none
 * of it is in either column: it is drawn in a section of its own under
 * them, labelled as the review, what was sent first and then what the
 * fork did, in the order it happened.
 */

const agentsKey = ["debug", "agents"] as const;

/** One recorded send, and what the backend then said about the model. */
export interface SentTurnView {
  send: DebugSent;
  /**
   * The model the backend reported for the thread this send opened or
   * resumed — `thread_started`'s, which is the backend's own word rather
   * than EO's request. Null until it says, and where it never does.
   */
  reportedModel: string | null;
  /**
   * The model the backend said the turn *ended* on — the latest `usage`
   * reading after this send that names one. It differs from
   * `reportedModel` when the backend moved the turn mid-way (Codex's
   * reroute), and is then the model that actually answered. Null while
   * the turn is running and on a backend that names no single model.
   */
  finalModel: string | null;
}

/** A string field of a persisted payload, or null. */
function named(payload: unknown, key: string): string | null {
  const value = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>)[key] : undefined;
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * The `debug_sent` rows of a log, parsed, each with the models the
 * backend reported after it.
 *
 * A send opens or resumes a thread, and what the backend says about
 * that turn follows it in the same log, up to the next send: the first
 * `thread_started` is the model the thread opened on, and the last
 * `usage` that names one is the model the turn ended on. A row that does
 * not parse is left out rather than half-drawn.
 */
export function sentOf(events: readonly TranscriptEventView[]): SentTurnView[] {
  const turns: SentTurnView[] = [];
  for (const event of events) {
    if (event.type === DEBUG_SENT_EVENT) {
      const parsed = DebugSentSchema.safeParse(event.payload);
      // The learning review's send is not the run's: `learningReviewOf` has it.
      if (parsed.success && parsed.data.purpose !== "learning_review") turns.push({ send: parsed.data, reportedModel: null, finalModel: null });
      continue;
    }
    const latest = turns.at(-1);
    if (!latest) continue;
    if (event.type === "thread_started") latest.reportedModel ??= named(event.payload, "model");
    // The latest reading wins: a turn's usage is reported as it ends.
    else if (event.type === "usage") latest.finalModel = named(event.payload, "model") ?? latest.finalModel;
  }
  return turns;
}

/** What debug mode recorded of a run's learning review (EO-734): what the fork was sent, and what it did. */
export interface LearningReviewView {
  /** The review's sends, in order — one per review. */
  sent: DebugSent[];
  /**
   * The fork's tool calls, results and words, in the order they were
   * written, each under the fork's own event type again so the
   * transcript's components draw it — which nothing outside this
   * section ever sees.
   */
  activity: TranscriptEventView[];
}

/** A log's learning review, or null where it has none recorded. */
export function learningReviewOf(events: readonly TranscriptEventView[]): LearningReviewView | null {
  const review: LearningReviewView = { sent: [], activity: [] };
  for (const event of events) {
    if (event.type === DEBUG_SENT_EVENT) {
      const parsed = DebugSentSchema.safeParse(event.payload);
      if (parsed.success && parsed.data.purpose === "learning_review") review.sent.push(parsed.data);
      continue;
    }
    const kind = learningReviewActivityKind(event.type);
    if (kind !== null) review.activity.push({ ...event, type: kind });
  }
  return review.sent.length === 0 && review.activity.length === 0 ? null : review;
}

/** Whether a row is the run's own activity: not a record of a send, and not what its learning review did. */
function isRunActivity(event: TranscriptEventView): boolean {
  return event.type !== DEBUG_SENT_EVENT && learningReviewActivityKind(event.type) === null;
}

/**
 * The model line: what actually ran, and how EO knows.
 *
 * The backend's word wins, because it is the model that answered — and
 * of its two words the later one, since a turn can be moved to another
 * model after its thread opened. What EO named is said beside it when
 * the two differ or when there is no report yet; when EO named none,
 * the report is the only way the backend's default has a name at all.
 */
export function modelLine(named: string | null, reported: string | null, final: string | null = null): string {
  // Moved mid-turn: the model that answered, and the one it started on.
  if (final !== null && reported !== null && final !== reported) {
    return `${final} — the backend moved the turn here; the thread opened on ${reported}${named === null ? ", and EO named none" : named === reported ? "" : `, and EO named ${named}`}`;
  }
  const ran = final ?? reported;
  if (ran !== null) {
    if (named === null) return `${ran} — the backend's default; EO named none`;
    return named === ran ? ran : `${ran} — reported by the backend; EO named ${named}`;
  }
  return named === null ? "not reported by the backend yet — EO named none" : `${named} — named by EO; the backend has not reported its own`;
}

export function DebugWindow() {
  // The window's colours are the chat layout's, chosen in Settings like
  // every other window's: it is drawn with the same kit and transcript.
  useChatTheme();
  const enabled = useDebugMode();
  const agents = useQuery({ queryKey: agentsKey, queryFn: () => ipcQuery("debug:runs", undefined) });
  // A run starting or ending moves a tab and changes a badge; progress
  // moves the token counts on the run row — and is what says a run's
  // first send was just recorded, which is the moment it (and its
  // agent's tab, if that had none) starts being listed at all. All three
  // are "ask again".
  useInvalidateOnPush("runs:changed", agentsKey);
  useInvalidateOnPush("runs:progress", agentsKey);
  useInvalidateOnPush("items:changed", agentsKey);
  // And the board being switched to another project, which is all
  // `projects:setActive` says: the tabs are the *current* project's, so
  // a window left open across the switch has to ask again or it goes on
  // showing the project that was left.
  useInvalidateOnPush("config:changed", agentsKey);

  const [agentId, setAgentId] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);

  const tabs = agents.data?.agents ?? [];
  // The effective selection: nothing chosen shows the first tab, which
  // is the agent working right now when there is one.
  const agent = tabs.find((candidate) => candidate.agentId === agentId) ?? tabs[0];
  const run = agent?.runs.find((candidate) => candidate.id === runId) ?? agent?.runs[0];

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-canvas text-ink">
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-line px-3 py-2">
        <h1 className="font-display text-lg">Debug</h1>
        <span className="text-sm text-ink-subtle">What each agent was sent, and what it is doing. Read-only.</span>
        {enabled === false && (
          <span role="status" className="ml-auto rounded-md border border-warning/40 bg-warning/5 px-2 py-0.5 text-sm text-warning">
            Debug mode is off — new runs are not being recorded.
          </span>
        )}
      </header>

      {agents.isError ? (
        <p className="p-4 text-base text-danger">EO could not read the runs.</p>
      ) : agents.isLoading ? (
        <p className="p-4 text-base text-ink-subtle">Loading…</p>
      ) : !agent ? (
        <p className="p-4 text-base text-ink-subtle">
          No run in this project has been recorded. Runs started while debug mode is on appear here.
        </p>
      ) : (
        <>
          <AgentTabs
            agents={tabs}
            selected={agent.agentId}
            onSelect={(id) => {
              setAgentId(id);
              setRunId(null);
            }}
          />
          <div className="flex min-h-0 flex-1">
            <RunPicker runs={agent.runs} older={Math.max(0, agent.totalRuns - agent.runs.length)} selected={run?.id ?? null} onSelect={setRunId} />
            {run ? <RunDebug key={run.id} run={run} /> : null}
          </div>
        </>
      )}
    </div>
  );
}

function AgentTabs({ agents, selected, onSelect }: { agents: readonly DebugAgent[]; selected: string; onSelect: (agentId: string) => void }) {
  return (
    <div role="tablist" aria-label="Agents" className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-line px-2 py-1.5">
      {agents.map((agent) => (
        <button
          key={agent.agentId}
          type="button"
          role="tab"
          aria-selected={agent.agentId === selected}
          onClick={() => onSelect(agent.agentId)}
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-sm",
            agent.agentId === selected ? "bg-canvas-active text-ink" : "text-ink-muted hover:bg-canvas-hover hover:text-ink",
          )}
        >
          {agent.name}
          {agent.live ? <Chip tone="running">running</Chip> : null}
          <span className="tabular-nums text-ink-subtle">{agent.totalRuns}</span>
        </button>
      ))}
    </div>
  );
}

function RunPicker({ runs, older, selected, onSelect }: { runs: readonly DebugRun[]; older: number; selected: string | null; onSelect: (runId: string) => void }) {
  return (
    <nav aria-label="Runs" className="flex w-60 shrink-0 flex-col gap-1 overflow-y-auto border-r border-line p-2">
      {runs.map((run) => (
        <button
          key={run.id}
          type="button"
          aria-current={run.id === selected}
          onClick={() => onSelect(run.id)}
          className={cn(
            "flex flex-col gap-0.5 rounded-md border border-line p-2 text-left text-sm",
            run.id === selected ? "bg-canvas-active text-ink" : "text-ink-muted hover:bg-canvas-hover",
          )}
        >
          <span className="flex items-center gap-1.5">
            <span className="font-medium">{run.action}</span>
            <Chip tone={runTone(run.status)}>{spokenStatus(run.status)}</Chip>
          </span>
          <span className="truncate text-ink-subtle">
            <span className="font-mono">{run.itemKey}</span> {run.itemTitle}
          </span>
          <span className="text-2xs text-ink-subtle">{run.startedAt === null ? "not started" : new Date(run.startedAt).toLocaleString()}</span>
        </button>
      ))}
      {/* Said rather than left to be wondered about: the tab is bounded,
          and what is past the bound is still on each item's runs screen. */}
      {older > 0 && (
        <p className="px-1 pt-1 text-2xs text-ink-subtle">
          {older.toLocaleString()} older {older === 1 ? "run is" : "runs are"} not listed here. Each is still on the runs screen of the work it belongs to.
        </p>
      )}
    </nav>
  );
}

function RunDebug({ run }: { run: DebugRun }) {
  const runIds = useMemo(() => [run.id], [run.id]);
  const { events, loading, error } = useTranscript(runIds);
  const sent = useMemo(() => sentOf(events), [events]);
  // The activity is every row that is not a record of a send — those are
  // drawn in full in the column beside it, not as a line in the log —
  // and not the learning review's, which has a section of its own.
  const activity = useMemo(() => events.filter(isRunActivity), [events]);
  const review = useMemo(() => learningReviewOf(events), [events]);
  // The run as a one-turn group, which is the shape `RunHeader` reads
  // tokens, turns and cost from — the same arithmetic as a run screen.
  const group = useMemo(() => groupRuns([run])[0]!, [run]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* No `onCancel`: this window changes nothing. */}
      <div className="border-b border-line px-3 py-2">
        <RunHeader group={group} />
      </div>
      {error && <p className="px-3 py-1 text-sm text-danger">{error.message}</p>}
      <div className="grid min-h-0 flex-1 grid-cols-2">
        <section aria-label="What was sent" className="flex min-h-0 select-text flex-col gap-3 overflow-y-auto border-r border-line p-3">
          <h2 className="font-display text-base text-ink">What was sent</h2>
          {sent.length === 0 ? (
            loading ? (
              <p className="text-sm text-ink-subtle">Loading…</p>
            ) : (
              // Every listed run has a recorded send (main lists no
              // other), so nothing to draw means the record is there and
              // did not parse — `sentOf` leaves such a row out.
              <p role="status" className="rounded-md border border-line bg-canvas-subtle p-2 text-sm text-ink-muted">
                The record of what was sent to this run could not be read.
              </p>
            )
          ) : (
            sent.map((turn, index) => <SentTurn key={index} turn={turn} run={run} ordinal={index + 1} of={sent.length} />)
          )}
        </section>

        <section aria-label="What the agent is doing" className="flex min-h-0 select-text flex-col">
          <h2 className="px-3 pt-3 font-display text-base text-ink">
            What the agent is doing{isRunActive(run.status) ? <span className="pl-2 text-sm font-normal text-accent">live</span> : null}
          </h2>
          {!loading && activity.length === 0 && <p className="px-3 py-1 text-sm text-ink-subtle">No events recorded for this run.</p>}
          <TranscriptLog events={activity} />
        </section>
      </div>
      {review && <LearningReview review={review} run={run} />}
    </div>
  );
}

/**
 * The run's learning review (EO-734), under the run and apart from it:
 * what the fork was sent, then what it did, in order. Drawn row by row
 * rather than folded, since a review is a handful of calls and the
 * calls are what a person opens this to read.
 */
function LearningReview({ review, run }: { review: LearningReviewView; run: DebugRun }) {
  // The copy's own id, which every row of what it did carries.
  const forkThreadId = review.activity.map((event) => named(event.payload, "forkThreadId")).find((id) => id !== null) ?? null;
  return (
    <section aria-label="Learning review" className="flex max-h-[45vh] shrink-0 select-text flex-col gap-3 overflow-y-auto border-t border-line p-3">
      <div className="flex flex-col gap-0.5">
        <h2 className="font-display text-base text-ink">Learning review</h2>
        <p className="text-sm text-ink-subtle">
          Not the run. After the run ended, EO reviewed it on a fork of its thread, which the run never sees. What the review did is not counted in the run&apos;s
          tool calls, skills, memory, turns or cost.
        </p>
      </div>
      {review.sent.map((send, index) => (
        <SentTurn key={index} turn={{ send, reportedModel: null, finalModel: null }} run={run} ordinal={index + 1} of={review.sent.length} />
      ))}
      <div aria-label="What the review did" className="flex flex-col">
        <h3 className="text-sm font-medium text-ink">What the review did</h3>
        {forkThreadId !== null && (
          <p className="text-2xs text-ink-subtle">
            On the fork&apos;s own thread, <span className="font-mono">{forkThreadId}</span>.
          </p>
        )}
        {review.activity.length === 0 ? (
          <p className="text-sm text-ink-subtle">No tool calls or words recorded for the review.</p>
        ) : (
          review.activity.map((event) => <TranscriptEvent key={`${event.runId}:${event.seq}`} event={event} />)
        )}
      </div>
    </section>
  );
}

const PURPOSE: Record<DebugSent["purpose"], string> = {
  dispatch: "Dispatch",
  reply: "A person's reply, continuing a parked run",
  recovery: "Recovery after a restart",
  correction: "Correction, inside the run",
  learning_review: "The learning review, on a fork of the run's thread",
};

/**
 * One send, in the order the backend received it: the instructions, the
 * prompt, then the session it was opened with.
 */
function SentTurn({ turn, run, ordinal, of }: { turn: SentTurnView; run: DebugRun; ordinal: number; of: number }) {
  const { send, reportedModel, finalModel } = turn;
  // A new thread's id is issued by the backend after the send, so the
  // record has none; the run row learns it when the backend says.
  const threadId = send.thread.threadId ?? (ordinal === 1 ? run.threadId : null);
  return (
    <article aria-label={`Send ${ordinal}`} className="flex flex-col gap-2 rounded-md border border-line p-2">
      <header className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium text-ink">{of > 1 ? `Send ${ordinal} of ${of}` : "Send"}</span>
        <span className="text-ink-subtle">{PURPOSE[send.purpose]}</span>
      </header>

      <div role="status" className="flex flex-col gap-0.5 text-sm">
        <span className="text-ink">
          {send.thread.mode === "forked"
            ? "Forked the run's provider thread: a copy, so nothing said here reaches the run's own thread."
            : send.thread.mode === "resumed"
              ? "Resumed an existing provider thread."
              : "Started a new provider thread."}{" "}
          <span className="text-ink-muted">
            {send.thread.mode === "forked" ? "Forked from" : "Thread id"}: <span className="font-mono">{threadId ?? "not issued yet"}</span>
          </span>
        </span>
        {send.thread.refusal !== null && (
          <span className="text-warning">
            An earlier thread was not reused: <span className="whitespace-pre-wrap">{send.thread.refusal}</span>
          </span>
        )}
      </div>

      {send.instructions.sent ? (
        <SentBlock title="Instructions" note={`Sent as the thread's instructions${send.session.instructionsSlot === null ? "" : ` (${send.session.instructionsSlot})`}.`} text={send.instructions.text ?? ""} />
      ) : send.instructions.text !== null ? (
        <SentBlock
          title="Instructions"
          note={`Not sent on this turn. A ${send.thread.mode === "forked" ? "forked" : "resumed"} thread keeps the instructions it was started with, which are these.`}
          text={send.instructions.text}
        />
      ) : (
        <p className="rounded-md border border-line bg-canvas-subtle p-2 text-sm text-ink-muted">
          <span className="font-medium text-ink">Instructions.</span> Not sent on this turn: a {send.thread.mode === "forked" ? "forked" : "resumed"} thread keeps the instructions it was started with. EO
          can no longer show those — the agent&apos;s instructions have been edited since the thread started, and the originals were not recorded.
        </p>
      )}

      <SentBlock
        title="Prompt"
        note={send.thread.mode === "new" ? "The full assembled context." : "The follow-up only: the thread already holds everything before it."}
        text={send.prompt}
      />

      <SessionFacts session={send.session} reportedModel={reportedModel} finalModel={finalModel} />
    </article>
  );
}

/** A block of sent text, verbatim, with the button that copies it. */
function SentBlock({ title, note, text }: { title: string; note: string; text: string }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-medium text-ink">{title}</h3>
        <span className="text-2xs tabular-nums text-ink-subtle">{text.length.toLocaleString()} characters</span>
        <CopyButton label={`Copy ${title.toLowerCase()}`} text={text} />
      </div>
      <p className="text-2xs text-ink-subtle">{note}</p>
      <pre className="max-h-[28rem] select-text overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-canvas-subtle p-2 font-mono text-xs text-ink">
        {text}
      </pre>
    </div>
  );
}

function CopyButton({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  // The "Copied" mark goes after a moment; a button gone before then
  // takes its timer with it rather than setting state on nothing.
  const reset = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (reset.current !== null) window.clearTimeout(reset.current);
    },
    [],
  );
  return (
    <Button
      size="sm"
      variant="ghost"
      className="ml-auto"
      aria-label={label}
      icon={copied ? <Check size={12} /> : <Copy size={12} />}
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setCopied(true);
        if (reset.current !== null) window.clearTimeout(reset.current);
        reset.current = window.setTimeout(() => {
          reset.current = null;
          setCopied(false);
        }, 1500);
      }}
    >
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

function SessionFacts({ session, reportedModel, finalModel }: { session: DebugSession; reportedModel: string | null; finalModel: string | null }) {
  const facts: [string, string][] = [
    ["Backend", session.backend],
    ["Model", modelLine(session.model, reportedModel, finalModel)],
    ["Reasoning effort", session.reasoningEffort ?? (session.described ? "the backend's default — EO named none" : "not named")],
    ["Working directory", session.cwd ?? "none"],
    ...session.policy.map((entry): [string, string] => [entry.name, entry.value]),
    ["Output schema", session.outputSchema ?? "none"],
    ["MCP servers", names(session.mcpServers)],
    ["Tool allowlist", session.allowedTools === null ? "none — every advertised tool" : names(session.allowedTools)],
    ["Skills", names(session.skills)],
    ...(session.attachments.length > 0 ? ([["Attachments", names(session.attachments)]] as [string, string][]) : []),
  ];
  const copyable = facts.map(([name, value]) => `${name}: ${value}`).join("\n");

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-medium text-ink">Session</h3>
        <CopyButton label="Copy session" text={copyable} />
      </div>
      <p className="text-2xs text-ink-subtle">Names only. Server commands, environment values, headers and tokens are never recorded.</p>
      <dl className="grid grid-cols-[10rem_1fr] gap-x-3 gap-y-0.5 rounded-md border border-line bg-canvas-subtle p-2 text-xs">
        {facts.map(([name, value]) => (
          <div key={name} className="contents">
            <dt className="text-ink-subtle">{name}</dt>
            <dd className="select-text break-words font-mono text-ink">{value}</dd>
          </div>
        ))}
      </dl>
      {!session.described && <p className="text-2xs text-ink-subtle">The {session.backend} backend does not describe its session, so only what EO passed is shown.</p>}
      {session.inheritsAmbientConfig && (
        <p className="text-2xs text-ink-subtle">This agent also runs on your own {session.backend} setup, whose servers and skills EO does not list.</p>
      )}
    </div>
  );
}

function names(values: readonly string[]): string {
  return values.length === 0 ? "none" : values.join(", ");
}
