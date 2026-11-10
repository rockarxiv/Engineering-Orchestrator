import { useState, type ReactNode } from "react";
import { AlertTriangle, BookOpen, ChevronRight, Coins, CornerDownLeft, CornerDownRight, FileDiff, Gauge, MessageSquare, Signpost, Terminal } from "lucide-react";
import { outcomeProse, type RunEventView } from "@eo/core";
import { cn } from "@eo/ui";
import { RefText } from "../items/ItemReference";
import { asText, field } from "../../../shared/transcript/transcriptEvent";

const LINE = "flex min-w-0 items-start gap-2 py-0.5 text-[12.5px]";
const ICON = "mt-[3px] shrink-0";
const BLOCK = "mt-1 max-h-96 overflow-auto relative whitespace-pre-wrap break-words rounded-[10px] bg-canvas-raised px-2.5 py-2 font-mono text-[11.5px] text-ink-muted";

/** A line that opens to show more: a tool's arguments, its answer, EO's suggestion. */
function Folding({ head, children, className }: { head: ReactNode; children: ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="min-w-0 py-0.5">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
        className={cn("flex w-full min-w-0 items-center gap-1.5 rounded-[7px] text-left text-[12px] hover:text-ink", className ?? "text-ink-muted")}
      >
        <ChevronRight aria-hidden size={12} className={cn("shrink-0 transition-transform", open && "rotate-90")} />
        {head}
      </button>
      {open ? children : null}
    </div>
  );
}

/**
 * One persisted run event, in the chat layout's transcript.
 *
 * What the agent said is prose, as a turn in the conversation is; what
 * it did is set in mono and folded. `type` is an open string (D-02), so
 * an unrecognised event shows its payload rather than disappearing — a
 * transcript that drops what it does not know is worst exactly when you
 * are debugging what produced it. Nothing is rewritten: `run_events`
 * keeps every byte (invariant 3).
 */
export function TranscriptEvent({ event }: { event: RunEventView }) {
  switch (event.type) {
    // An agent's progress in its action's own outcome shape (#144) is
    // drawn as the words in it, not as a finished hand-off's braces.
    case "output": {
      const text = asText(field(event.payload, "text"));
      return <p className="whitespace-pre-wrap break-words py-1 text-[13px] leading-relaxed text-ink">{outcomeProse(text) ?? text}</p>;
    }

    // The model's summary of its reasoning (`ReasoningEvent`): read like
    // narration, set apart as thought rather than something it said.
    case "reasoning":
      return (
        <p className="whitespace-pre-wrap break-words py-1 text-[13px] leading-relaxed text-ink-muted">
          <span className="font-medium text-ink-subtle">Thought · </span>
          {asText(field(event.payload, "text"))}
        </p>
      );

    case "file_edit":
      return (
        <div className={cn(LINE, "text-ink-muted")}>
          <FileDiff aria-hidden size={12} className={cn(ICON, "text-accent-soft")} />
          <span className="min-w-0 break-all font-mono text-[12px]">{asText(field(event.payload, "path"))}</span>
        </div>
      );

    case "usage":
      return (
        <div className={cn(LINE, "text-ink-subtle")}>
          <Coins aria-hidden size={12} className={ICON} />
          <span>
            {String(field(event.payload, "tokensIn") ?? 0)} in / {String(field(event.payload, "tokensOut") ?? 0)} out
          </span>
        </div>
      );

    case "error":
      return (
        <div className={cn(LINE, "text-danger")}>
          <AlertTriangle aria-hidden size={12} className={ICON} />
          <span className="min-w-0 whitespace-pre-wrap break-words">
            <RefText>{asText(field(event.payload, "message"))}</RefText>
          </span>
        </div>
      );

    // A backend wound up after an escalation (KAN-26): it arrives as an
    // error, but the run did what it was asked, so it reads as an aside.
    case "wind_down":
      return (
        <div className={cn(LINE, "text-ink-subtle")}>
          <CornerDownLeft aria-hidden size={12} className={ICON} />
          <span className="min-w-0 whitespace-pre-wrap break-words">
            Ended here to wait for a reply.{" "}
            <span className="opacity-75">
              <RefText>{asText(field(event.payload, "message"))}</RefText>
            </span>
          </span>
        </div>
      );

    // Collapsed: arguments are long, and not what a transcript is scanned for.
    case "tool_call":
      return (
        <Folding
          head={
            <>
              <Terminal aria-hidden size={12} className="shrink-0 text-accent-soft" />
              <span className="min-w-0 truncate font-mono">{asText(field(event.payload, "name"))}</span>
            </>
          }
        >
          <pre className={BLOCK}>{asText(field(event.payload, "args"))}</pre>
        </Folding>
      );

    // What that call returned (EO-169): the call's sibling, one indent in.
    case "tool_result": {
      const name = asText(field(event.payload, "name"));
      const ok = field(event.payload, "ok") !== false;
      const exitCode = field(event.payload, "exitCode");
      const output = asText(field(event.payload, "output"));
      return (
        <Folding
          className={cn("pl-3", ok ? "text-ink-muted" : "text-danger")}
          head={
            <>
              <CornerDownRight aria-hidden size={12} className="shrink-0" />
              <span className="min-w-0 truncate font-mono">{name === "" ? "returned" : `${name} returned`}</span>
              {/* Only when it says something "ok" has not. */}
              {typeof exitCode === "number" && exitCode !== 0 ? <span className="font-mono text-ink-subtle">exit {exitCode}</span> : null}
            </>
          }
        >
          <pre className={BLOCK}>{output === "" ? "(no output)" : output}</pre>
        </Folding>
      );
    }

    // EO redirected one of the agent's searches mid-run (EO-168). Shown,
    // never folded into the tool calls: it happened to somebody's work.
    case "search_interception": {
      const kind = asText(field(event.payload, "kind"));
      return (
        <Folding
          head={
            <>
              <Signpost aria-hidden size={12} className="shrink-0 text-accent-soft" />
              <span className="min-w-0">
                Suggested the index instead of {kind === "layout" ? "a walk of the tree" : <span className="font-mono">{asText(field(event.payload, "needle"))}</span>}
              </span>
            </>
          }
        >
          <p className={cn(BLOCK, "font-sans text-[12px]")}>{asText(field(event.payload, "suggestion"))}</p>
        </Folding>
      );
    }

    // What the backend's allowance has left — already a percentage.
    case "quota": {
      const utilization = field(event.payload, "utilization");
      const share = typeof utilization === "number" ? `${Math.round(utilization)}%` : "an unknown share";
      const status = asText(field(event.payload, "status"));
      return (
        <div className={cn(LINE, status === "allowed" ? "text-ink-subtle" : "text-paused")}>
          <Gauge aria-hidden size={12} className={ICON} />
          <span>
            {asText(field(event.payload, "provider"))} {asText(field(event.payload, "window"))}: {share} used
          </span>
        </div>
      );
    }

    // A person spoke into the run (EO-176). Never folded, and the two
    // outcomes are drawn apart: only one of them reached this agent.
    case "human_message": {
      const delivered = field(event.payload, "delivered") === true;
      return (
        <div className={cn("my-1 flex min-w-0 items-start gap-2 rounded-[10px] px-2.5 py-1.5 text-[12.5px]", delivered ? "bg-accent-subtle text-ink" : "bg-canvas-raised text-ink-muted")}>
          <MessageSquare aria-hidden size={12} className={cn(ICON, delivered && "text-accent-soft")} />
          <span className="min-w-0 whitespace-pre-wrap break-words">
            <span className="font-medium">{delivered ? "You said, mid-turn:" : "You said, queued for the next turn:"}</span>{" "}
            <RefText>{asText(field(event.payload, "body"))}</RefText>
          </span>
        </div>
      );
    }

    // Which of EO's skills the run was given, and each one it loaded
    // (EO-715) — what a skill's usage is counted from.
    case "skills_delivered": {
      const slugs = field(event.payload, "slugs");
      const names = Array.isArray(slugs) ? slugs.map((slug) => asText(slug)) : [];
      return (
        <div className={cn(LINE, "text-ink-subtle")}>
          <BookOpen aria-hidden size={12} className={ICON} />
          <span className="min-w-0">
            Given {names.length === 1 ? "the skill" : "the skills"} <span className="font-mono">{names.join(", ")}</span>
          </span>
        </div>
      );
    }

    case "skill_loaded":
      return (
        <div className={cn(LINE, "text-ink-muted")}>
          <BookOpen aria-hidden size={12} className={cn(ICON, "text-accent-soft")} />
          <span className="min-w-0">
            Loaded the skill <span className="font-mono">{asText(field(event.payload, "slug"))}</span>
          </span>
        </div>
      );

    case "thread_started":
      return <div className="py-0.5 font-mono text-[11.5px] text-ink-subtle">thread {asText(field(event.payload, "threadId"))}</div>;

    case "result":
      return <pre className={BLOCK}>{asText(field(event.payload, "data"))}</pre>;

    default:
      return (
        <div className="whitespace-pre-wrap break-words py-0.5 font-mono text-[11.5px] text-ink-subtle">
          {event.type}: {asText(event.payload)}
        </div>
      );
  }
}
