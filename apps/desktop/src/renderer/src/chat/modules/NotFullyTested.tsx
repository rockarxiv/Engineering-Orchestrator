import { describeModuleTestShortfall, moduleTestShortfalls, type ModuleView } from "@eo/core";
import { cn } from "@eo/ui";
import { AlertTriangle } from "lucide-react";

/**
 * "Not fully tested", on a step that runs a module short of the bar
 * (EO-354), in the chat layout's terms.
 *
 * Permanent while the module is short — a fact about the code, not a
 * notice somebody has read — and always naming which reason applies.
 * Renders nothing for a fully tested module or a step with none, so a
 * caller can put it wherever a step is drawn.
 */
export function NotFullyTested({ module, className }: { module: Pick<ModuleView, "testCount" | "testRun"> | undefined; className?: string }) {
  if (module === undefined) return null;
  const shortfalls = moduleTestShortfalls(module);
  if (shortfalls.length === 0) return null;
  const reasons = shortfalls.map(describeModuleTestShortfall).join(", ");
  return (
    <span
      role="note"
      aria-label={`Not fully tested: ${reasons}`}
      title={`Not fully tested: ${reasons}`}
      className={cn("inline-flex min-w-0 items-center gap-1 text-[11.5px] text-paused", className)}
    >
      <AlertTriangle aria-hidden size={12} className="shrink-0" />
      <span className="truncate">
        Not fully tested <span className="text-ink-subtle">· {reasons}</span>
      </span>
    </span>
  );
}
