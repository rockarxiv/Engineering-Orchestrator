import { ChevronRight } from "lucide-react";
import { cn } from "@eo/ui";
import { eventKey, type TranscriptItem } from "../../../shared/transcript/activity";
import { TranscriptEvent } from "./TranscriptEvent";

type ActivityItem = Extract<TranscriptItem, { kind: "activity" }>;

/**
 * A folded run of machine activity — "5 tool calls, 2 files edited" —
 * the mockup's "worked" line under what the agent said.
 *
 * Closed by default: what the agent did is worth having, not first.
 * Whether it is open is held by the list, because the list is
 * virtualised and a row scrolled out of view unmounts with its state.
 */
export function TranscriptActivity({ item, expanded, onToggle }: { item: ActivityItem; expanded: boolean; onToggle: () => void }) {
  return (
    <div className="min-w-0 py-0.5">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="inline-flex max-w-full items-center gap-1.5 rounded-[8px] bg-canvas-raised px-2 py-1 text-left text-[11.5px] text-ink-subtle hover:text-ink-muted"
      >
        <ChevronRight aria-hidden size={12} className={cn("shrink-0 transition-transform", expanded && "rotate-90")} />
        <span className="truncate">{item.summary}</span>
      </button>
      {expanded ? (
        <div className="ml-2 mt-1 border-l border-line pl-3">
          {item.events.map((event) => (
            <TranscriptEvent key={eventKey(event)} event={event} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
