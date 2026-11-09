import type { CSSProperties } from "react";
import { Check } from "lucide-react";
import type { PipelineStepView } from "@eo/core";
import { cn, type StatusTone } from "@eo/ui";

/**
 * The state colour of a run, as a custom property the classes below read:
 * the tint and border are mixes toward it, so one value carries all three.
 */
function stateColour(tone: StatusTone): CSSProperties {
  return { "--step-state": `var(--color-${tone})` } as CSSProperties;
}

/**
 * The run's state as a 7px dot: on the current step, and on the step chip
 * in the item's header. Decorative — the words beside it say what it is.
 */
export function StepStateDot({ tone }: { tone: StatusTone }) {
  return <span aria-hidden data-state={tone} style={stateColour(tone)} className="h-[7px] w-[7px] shrink-0 rounded-full bg-[var(--step-state)]" />;
}

/**
 * Where an item is in its own pipeline: every step in order, the one it
 * is on marked, the earlier ones done. Wraps rather than scrolls, so a
 * long pipeline still reads beside the conversation.
 *
 * The path walked is drawn in success; the current step in its run's
 * state (EO-689) — never the accent, which marks only what can be
 * pressed (ARCHITECTURE.md §22.1, rule 6). `state` is the latest run's
 * tone, idle when there is none, and `stateLabel` its word for a reader
 * that cannot see the dot.
 */
export function Stepper({
  steps,
  currentId,
  state = "idle",
  stateLabel,
}: {
  steps: readonly PipelineStepView[];
  currentId: string | null;
  state?: StatusTone;
  stateLabel?: string;
}) {
  const ordered = [...steps].sort((a, b) => a.position - b.position);
  const current = ordered.find((step) => step.id === currentId);
  if (ordered.length === 0) return null;
  return (
    <ol aria-label="Pipeline steps" style={stateColour(state)} className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-1.5 text-[11.5px]">
      {ordered.map((step, index) => {
        const status = current === undefined ? "pending" : step.id === current.id ? "active" : step.position < current.position ? "complete" : "pending";
        const caption = current === undefined ? null : status === "active" ? "Active" : status === "complete" ? "Complete" : "Pending";
        // The connector into a step is walked when the step is done or is where the item stands.
        const walked = status === "complete" || status === "active";
        return (
          <li key={step.id} {...(status === "active" ? { "aria-current": "step" as const } : {})} className="flex min-w-0 items-center gap-1">
            {index > 0 ? (
              <span
                aria-hidden
                data-walked={walked || undefined}
                className={cn("w-3 shrink-0", walked ? "h-[2px] bg-success/65" : "h-px bg-line-strong")}
              />
            ) : null}
            <span
              className={cn(
                "inline-flex h-[22px] min-w-0 items-center gap-1 rounded-[7px] px-2",
                status === "active"
                  ? "gap-1.5 bg-[color-mix(in_oklab,var(--color-canvas-raised),var(--step-state)_18%)] font-semibold text-ink shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-line),var(--step-state)_55%)]"
                  : status === "complete"
                    ? "text-ink-muted"
                    : "text-ink-subtle",
              )}
            >
              {status === "complete" ? <Check aria-hidden size={11} className="shrink-0 text-success" /> : null}
              {status === "active" ? <StepStateDot tone={state} /> : null}
              <span className="truncate">{step.name}</span>
              {caption ? <span className="sr-only">{status === "active" && stateLabel ? `, ${caption}, ${stateLabel}` : `, ${caption}`}</span> : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
