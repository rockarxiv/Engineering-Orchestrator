import type { ReactNode, Ref } from "react";
import { AlertTriangle } from "lucide-react";
import type { StepDecision } from "@eo/core";
import { cn } from "@eo/ui";
import { DEEP, DecisionButtons } from "../../parts";

/**
 * The decision an item's `user` step asks for, pinned to the bottom of the
 * item page (EO-826, replacing EO-310's in-flow "Decide" box).
 *
 * People missed the box: a faint tint between a long output and a long
 * thread. So the bar is styled as an escalation is — the warning colour as
 * a clear border and an icon — and sticks to the bottom of the page's
 * scroll container while the page scrolls under it. It is the page's one
 * set of decision buttons, and they are `DecisionButtons`, so pressing one
 * decides exactly as the box did, with the same holder rules on a step
 * that waits on a group (EO-368).
 *
 * `details` is the "Show details" brief (`DecisionBrief`, EO-827): what
 * the decision is about, opened on demand so the bar stays one line.
 */
export function DecisionBar({
  ref,
  itemId,
  stepName,
  summary,
  waitsOnGroup,
  decision,
  onDecided,
  details,
}: {
  ref?: Ref<HTMLElement>;
  itemId: string;
  stepName: string;
  /** The step's instructions summary, or null where it has none. */
  summary: string | null;
  /** The group a step waits on when the viewer does not hold it; null when the step is the viewer's. */
  waitsOnGroup: string | null;
  decision: StepDecision[];
  onDecided: () => unknown;
  details?: ReactNode;
}) {
  const line = firstLine(summary) ?? `${stepName} waits on ${waitsOnGroup ?? "you"}`;
  return (
    // Pinned to the very bottom of the canvas's scroll container: past the
    // container's own 1rem of padding, which it fills with the canvas's
    // ground so nothing scrolls by underneath it.
    <div className={cn("sticky -bottom-4 z-[var(--z-raised)] -mb-4 pb-4", DEEP)}>
    <section
      ref={ref}
      aria-label="Decide"
      // Reached from the "Waiting on you" banner, which moves focus here.
      tabIndex={-1}
      className="flex min-w-0 flex-col gap-2 rounded-[14px] border-2 border-warning bg-canvas px-[18px] py-3 shadow-panel focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-focus"
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <AlertTriangle aria-hidden size={16} className="mt-0.5 shrink-0 text-warning" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-[12px] text-warning">
            {waitsOnGroup === null ? "This step is yours" : `This step waits on ${waitsOnGroup}`} · <span className="font-semibold">{stepName}</span>
          </span>
          <p className="truncate text-[13px] text-ink" title={summary ?? undefined}>
            {line}
          </p>
        </div>
      </div>
      <DecisionButtons itemId={itemId} decision={decision} adminControl={false} onDecided={onDecided} />
      {details}
    </section>
    </div>
  );
}

/** The one line a summary written over several gives the bar; the whole of it is the bar's title. */
function firstLine(text: string | null): string | null {
  const line = text
    ?.split("\n")
    .map((part) => part.trim())
    .find((part) => part !== "");
  return line ?? null;
}

/**
 * "Waiting on you: <step>", under the item header while the bar waits on
 * the viewer. Pressing it brings the bar into view and focuses it.
 */
export function WaitingOnYouBanner({ stepName, onActivate }: { stepName: string; onActivate: () => void }) {
  return (
    <button
      type="button"
      onClick={onActivate}
      className="flex min-w-0 items-center gap-2 self-start rounded-[10px] border border-warning bg-canvas-subtle px-3 py-1.5 text-left text-[12.5px] text-ink hover:bg-canvas-raised"
    >
      <AlertTriangle aria-hidden size={13} className="shrink-0 text-warning" />
      <span className="min-w-0 truncate">Waiting on you: {stepName}</span>
    </button>
  );
}
