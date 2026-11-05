import { useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Check, ChevronRight, CornerDownRight, FileDiff, LoaderCircle, X } from "lucide-react";
import { liveMessageOf, type DiscussionMessage, type LiveDraft, type LiveTurn, type TurnStep } from "@eo/core";
import { Markdown, cn } from "@eo/ui";
import { ipcQuery } from "../../query/client";
import { useRevealed } from "./useRevealed";

/**
 * A turn as Claude Desktop draws one: what the agent said along the way,
 * what it thought, and what it did, between the question and the answer.
 *
 * The doing folds (ARCHITECTURE.md, "The transcript"): consecutive tool
 * calls and edits sit behind one line — "4 tool calls · 1 file" — that
 * opens to the calls, each of which opens to what it was asked and what
 * came back. Narration never folds, an error never folds, and a run of
 * one is shown as itself rather than behind a chevron. Thinking is folded
 * under "Thought" unless it is being written right now, when it is shown
 * as it arrives under "Thinking".
 *
 * Steps are the record (`run_events`, through `turnStepsOf`); drafts are
 * what is being written and is not stored yet (`liveDrafts`). Nothing here
 * decides which is which.
 */

/** The steps of a turn, in order, with the doing folded. */
export function TurnSteps({ steps, live = false }: { steps: readonly TurnStep[]; live?: boolean }) {
  const groups = useMemo(() => groupSteps(steps), [steps]);
  return (
    <div className="flex flex-col gap-2">
      {groups.map((group, index) => {
        const last = index === groups.length - 1;
        if (group.kind === "doing") {
          return group.steps.length === 1 ? (
            <DoingRow key={group.key} step={group.steps[0]!} live={live && last} />
          ) : (
            <DoingGroup key={group.key} steps={group.steps} live={live && last} />
          );
        }
        const step = group.step;
        switch (step.kind) {
          case "text":
            return (
              <div key={group.key} className="text-ink">
                <Markdown>{step.text}</Markdown>
              </div>
            );
          case "reasoning":
            return <Thought key={group.key} text={step.text} />;
          case "error":
            return (
              <div key={group.key} role="alert" className="flex items-start gap-2 text-[13px] text-danger">
                <AlertTriangle aria-hidden size={14} className="mt-0.5 shrink-0" />
                <span className="min-w-0 whitespace-pre-wrap break-words">{step.message}</span>
              </div>
            );
          case "steer":
            return (
              <div key={group.key} className="flex items-start gap-2 text-[13px] text-ink-muted">
                <CornerDownRight aria-hidden size={14} className="mt-0.5 shrink-0 text-ink-subtle" />
                <span className="min-w-0 whitespace-pre-wrap break-words">
                  <span className="text-ink-subtle">You, mid-turn: </span>
                  {step.text}
                </span>
              </div>
            );
          default:
            return null;
        }
      })}
    </div>
  );
}

type Group = { kind: "doing"; key: string; steps: Extract<TurnStep, { kind: "tool" | "edit" }>[] } | { kind: "said"; key: string; step: TurnStep };

/** Consecutive tool calls and edits, folded; everything else stands alone. */
export function groupSteps(steps: readonly TurnStep[]): Group[] {
  const groups: Group[] = [];
  for (const step of steps) {
    if (step.kind === "tool" || step.kind === "edit") {
      const last = groups.at(-1);
      if (last?.kind === "doing") last.steps.push(step);
      else groups.push({ kind: "doing", key: `d${step.seq}`, steps: [step] });
    } else {
      groups.push({ kind: "said", key: `s${step.seq}`, step });
    }
  }
  return groups;
}

/** What a folded run of doing says: the calls, and the files counted once each. */
export function doingSummary(steps: readonly TurnStep[]): string {
  const calls = steps.filter((step) => step.kind === "tool").length;
  const files = new Set(steps.flatMap((step) => (step.kind === "edit" ? [step.path] : [])));
  const parts: string[] = [];
  if (calls > 0) parts.push(`${calls} ${calls === 1 ? "tool call" : "tool calls"}`);
  if (files.size > 0) parts.push(`${files.size} ${files.size === 1 ? "file" : "files"} edited`);
  return parts.join(" · ");
}

function DoingGroup({ steps, live }: { steps: Extract<TurnStep, { kind: "tool" | "edit" }>[]; live: boolean }) {
  const [open, setOpen] = useState(false);
  const running = live && steps.some((step) => step.kind === "tool" && step.ok === null);
  const failed = steps.some((step) => step.kind === "tool" && step.ok === false);
  const current = running ? [...steps].reverse().find((step) => step.kind === "tool" && step.ok === null) : undefined;
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="group inline-flex min-w-0 items-center gap-1.5 self-start rounded-[8px] py-0.5 pr-1.5 text-[12.5px] text-ink-subtle hover:text-ink"
      >
        <ChevronRight aria-hidden size={13} className={cn("shrink-0 transition-transform duration-[var(--dur-short)]", open && "rotate-90")} />
        {running ? <LoaderCircle aria-hidden size={12} className="shrink-0 animate-spin text-running" /> : null}
        <span className="truncate">
          {doingSummary(steps)}
          {current?.kind === "tool" ? <span className="text-ink-muted"> · {current.label}</span> : null}
        </span>
        {failed ? <span className="text-danger">· a call failed</span> : null}
      </button>
      {open ? (
        <div className="ml-[6px] flex flex-col gap-0.5 border-l border-line pl-3">
          {steps.map((step) => (
            <DoingRow key={`${step.kind}${step.seq}`} step={step} live={live} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** One call or edit: what it was, whether it worked, and — opened — what it was asked and what came back. */
function DoingRow({ step, live }: { step: Extract<TurnStep, { kind: "tool" | "edit" }>; live: boolean }) {
  const [open, setOpen] = useState(false);
  if (step.kind === "edit") {
    return (
      <div className="flex min-w-0 items-center gap-1.5 py-0.5 text-[12.5px] text-ink-subtle">
        <FileDiff aria-hidden size={12} className="shrink-0" />
        <span className="truncate font-mono text-[11.5px] text-ink-muted">{step.path}</span>
      </div>
    );
  }
  const detail = step.input !== null || step.output !== null;
  const status =
    step.ok === null ? (
      live ? (
        <LoaderCircle aria-label="Running" size={12} className="shrink-0 animate-spin text-running" />
      ) : (
        <span aria-label="No result" className="h-[6px] w-[6px] shrink-0 rounded-full bg-idle" />
      )
    ) : step.ok ? (
      <Check aria-label="Done" size={12} className="shrink-0 text-ink-subtle" />
    ) : (
      <X aria-label="Failed" size={12} className="shrink-0 text-danger" />
    );
  return (
    <div className="flex min-w-0 flex-col">
      <button
        type="button"
        aria-expanded={detail ? open : undefined}
        disabled={!detail}
        onClick={() => setOpen((value) => !value)}
        className="flex min-w-0 items-center gap-1.5 self-start rounded-[8px] py-0.5 pr-1.5 text-left text-[12.5px] text-ink-muted enabled:hover:text-ink disabled:cursor-default"
      >
        {status}
        <span className="truncate">{step.label}</span>
        {detail ? <ChevronRight aria-hidden size={12} className={cn("shrink-0 text-ink-subtle transition-transform", open && "rotate-90")} /> : null}
      </button>
      {open ? (
        <div className="mb-1 mt-0.5 flex flex-col gap-1.5">
          {step.input !== null ? <Machine label="Input">{step.input}</Machine> : null}
          {step.output !== null ? <Machine label={step.ok === false ? "Error" : "Output"}>{step.output || "(nothing)"}</Machine> : null}
        </div>
      ) : null}
    </div>
  );
}

/** Text a machine wrote: mono, bounded, scrolled rather than stretched (ARCHITECTURE.md, "Mono means machine"). */
function Machine({ label, children }: { label: string; children: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-mono text-[10.5px] uppercase tracking-wide text-ink-subtle">{label}</span>
      <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-[8px] bg-canvas-subtle px-2.5 py-2 font-mono text-[11.5px] leading-relaxed text-ink-muted">
        {children}
      </pre>
    </div>
  );
}

/**
 * The model's reasoning: folded under "Thought" when it is done, shown as
 * it arrives under "Thinking" while it is being written. Never given a
 * title made from its first line (ARCHITECTURE.md, "Interaction").
 */
export function Thought({ text, live = false }: { text: string; live?: boolean }) {
  const [open, setOpen] = useState(false);
  const shown = live || open;
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        aria-expanded={shown}
        disabled={live}
        onClick={() => setOpen((value) => !value)}
        className="inline-flex items-center gap-1.5 self-start rounded-[8px] py-0.5 pr-1.5 text-[12.5px] text-ink-subtle enabled:hover:text-ink"
      >
        {live ? <LoaderCircle aria-hidden size={12} className="animate-spin text-running" /> : <ChevronRight aria-hidden size={13} className={cn("transition-transform", open && "rotate-90")} />}
        <span>{live ? "Thinking" : "Thought"}</span>
      </button>
      {shown ? <p className="ml-[6px] whitespace-pre-wrap break-words border-l border-line pl-3 text-[13px] leading-relaxed text-ink-subtle">{text}</p> : null}
    </div>
  );
}

/**
 * The turn that is running: its steps, then what is being written now.
 *
 * A text draft is read through `liveMessageOf`, because under an output
 * schema the words being written are the answer's JSON and a person is
 * shown its message, never its braces. The answer the structured-output
 * tool has stored is drawn once no draft is writing it any more.
 */
export function LiveTurnBody({ turn, drafts }: { turn: LiveTurn; drafts: readonly LiveDraft[] }) {
  // The drafts on screen when this was first drawn are shown as they are;
  // any that begin after are paced from their first word.
  const firstDrawn = useRef<Set<number> | null>(null);
  if (firstDrawn.current === null) firstDrawn.current = new Set(drafts.map((draft) => draft.id));
  const writing = drafts.filter((draft) => draft.stream === "text").map((draft) => ({ id: draft.id, text: liveMessageOf([draft.text]) }));
  const thinking = drafts.filter((draft) => draft.stream === "reasoning");
  const answerShown = writing.some((draft) => draft.text !== "" && turn.answer.startsWith(draft.text.slice(0, 40)));
  return (
    <div className="flex flex-col gap-2">
      {turn.steps.length > 0 ? <TurnSteps steps={turn.steps} live /> : null}
      {thinking.map((draft) => (
        <Thought key={`r${draft.id}`} text={draft.text} live />
      ))}
      {writing.map((draft) => (draft.text === "" ? null : <Writing key={`t${draft.id}`} text={draft.text} fromStart={!firstDrawn.current!.has(draft.id)} />))}
      {turn.answer !== "" && !answerShown ? (
        <div className="text-ink">
          <Markdown>{turn.answer}</Markdown>
        </div>
      ) : null}
    </div>
  );
}

/** A block being written, revealed at a steady pace (`useRevealed`). */
function Writing({ text, fromStart }: { text: string; fromStart: boolean }) {
  const shown = useRevealed(text, fromStart);
  return (
    <div className="text-ink">
      <Markdown>{shown}</Markdown>
    </div>
  );
}

/** How long a finished turn took, as a person reads it: "45s", "2m 13s". */
export function workedFor(milliseconds: number): string {
  const seconds = Math.max(1, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

/** The line a finished turn's work is folded behind. */
export function turnSummaryLine(turn: NonNullable<DiscussionMessage["turn"]>): string {
  const parts: string[] = [turn.durationMs === null ? "Worked" : `Worked for ${workedFor(turn.durationMs)}`];
  if (turn.toolCalls > 0) parts.push(`${turn.toolCalls} ${turn.toolCalls === 1 ? "tool call" : "tool calls"}`);
  if (turn.filesEdited > 0) parts.push(`${turn.filesEdited} ${turn.filesEdited === 1 ? "file" : "files"} edited`);
  if (turn.toolCalls === 0 && turn.filesEdited === 0 && turn.reasoned) parts.push("thought it through");
  return parts.join(" · ");
}

/**
 * A finished turn's work, folded above what it said — Claude Desktop's
 * "Worked for 2m". Opened, it reads the run's steps (`runs:steps`) once
 * and shows them; until then it costs nothing.
 */
export function TurnFold({ turn, defaultOpen = false, children }: { turn: NonNullable<DiscussionMessage["turn"]>; defaultOpen?: boolean; children?: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  const steps = useQuery({
    queryKey: ["runSteps", turn.runId],
    queryFn: () => ipcQuery("runs:steps", { runId: turn.runId }),
    enabled: open,
    // A finished run cannot do any more, so its steps are read once. One
    // still ending — a stopped turn whose last events are being written —
    // is read again the next time it is opened.
    staleTime: turn.durationMs === null ? 0 : Infinity,
  });
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="inline-flex items-center gap-1.5 self-start rounded-[8px] py-0.5 pr-1.5 text-[12.5px] text-ink-subtle hover:text-ink"
      >
        <ChevronRight aria-hidden size={13} className={cn("transition-transform duration-[var(--dur-short)]", open && "rotate-90")} />
        <span>{turnSummaryLine(turn)}</span>
      </button>
      {open ? (
        <div className="ml-[6px] border-l border-line pl-3">
          {steps.data ? (
            steps.data.steps.length > 0 ? (
              <TurnSteps steps={steps.data.steps} />
            ) : (
              <p className="text-[12.5px] text-ink-subtle">Nothing to show.</p>
            )
          ) : (
            <p className="text-[12.5px] text-ink-subtle">{steps.isError ? "Could not read this turn." : "Reading the turn…"}</p>
          )}
        </div>
      ) : null}
      {children}
    </div>
  );
}
