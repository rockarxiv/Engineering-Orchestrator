import { LoaderCircle } from "lucide-react";
import { formatDuration, useNow } from "../../hooks/useNow";

/**
 * The live turn, and how long it has been going: the "worked" line
 * (ARCHITECTURE.md, "The chat-centric layout").
 *
 * The clock ticks on its own (`useNow`), because a turn that thinks
 * quietly for two minutes pushes nothing that would redraw it. The spinner
 * is `--color-running`, never the accent: an agent working is state, and
 * the accent is kept for what a person can act on.
 *
 * Stopping is the composer's (its Stop button and Escape), not this
 * line's: the line says what is happening, the box is where a person acts.
 * `label` says which phase: "Working" while a turn runs, "Starting" for a
 * message that has been sent and is waiting for its turn to begin.
 */
export function WorkingLine({ since, label = "Working" }: { since: number | null; label?: string }) {
  const now = useNow(true);
  return (
    <div
      role="status"
      aria-live="polite"
      className="inline-flex items-center gap-2 self-start rounded-[10px] bg-canvas-subtle px-2.5 py-1.5 text-[12.5px] text-ink-subtle"
    >
      <LoaderCircle aria-hidden size={13} className="animate-spin text-running motion-reduce:animate-none" />
      {/* Hidden from the announcement, not the eye: the status says
          "Working" once, and a clock inside it would be read out every
          second it ticked. */}
      <span aria-hidden className="font-mono text-[11.5px] tabular-nums text-ink-muted">
        {since === null ? "…" : formatDuration(now - since)}
      </span>
      <span>{label}</span>
    </div>
  );
}
