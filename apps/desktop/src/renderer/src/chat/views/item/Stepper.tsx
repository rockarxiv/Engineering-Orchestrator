import { Check } from "lucide-react";
import type { PipelineStepView } from "@eo/core";
import { cn } from "@eo/ui";

/**
 * Where an item is in its own pipeline: every step in order, the one it
 * is on marked, the earlier ones done. Wraps rather than scrolls, so a
 * long pipeline still reads beside the conversation.
 */
export function Stepper({ steps, currentId }: { steps: readonly PipelineStepView[]; currentId: string | null }) {
  const ordered = [...steps].sort((a, b) => a.position - b.position);
  const current = ordered.find((step) => step.id === currentId);
  if (ordered.length === 0) return null;
  return (
    <ol aria-label="Pipeline steps" className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-1.5 text-[11.5px]">
      {ordered.map((step, index) => {
        const status = current === undefined ? "pending" : step.id === current.id ? "active" : step.position < current.position ? "complete" : "pending";
        const caption = current === undefined ? null : status === "active" ? "Active" : status === "complete" ? "Complete" : "Pending";
        return (
          <li key={step.id} {...(status === "active" ? { "aria-current": "step" as const } : {})} className="flex min-w-0 items-center gap-1">
            {index > 0 ? <span aria-hidden className="h-px w-3 shrink-0 bg-line-strong" /> : null}
            <span
              className={cn(
                "inline-flex h-[22px] min-w-0 items-center gap-1 rounded-[7px] px-2",
                status === "active" ? "bg-accent-subtle text-accent-soft" : status === "complete" ? "text-ink-muted" : "text-ink-subtle",
              )}
            >
              {status === "complete" ? <Check aria-hidden size={11} className="shrink-0" /> : null}
              <span className="truncate">{step.name}</span>
              {caption ? <span className="sr-only">{`, ${caption}`}</span> : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
