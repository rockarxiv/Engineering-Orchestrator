import type { PipelineStepView } from "@eo/core";
import { cn } from "@eo/ui";

/**
 * What kind of step a step is, as a chip (EO-680): who does the work
 * there — an agent, a person, a script or EO itself.
 *
 * One chip for every place a step is drawn — the pipeline drawing on the
 * Graph view and the assistant's draft card, and the board's column
 * heads — so the four kinds are told apart the same way wherever a step
 * is seen. The kind is a machine word, so it is mono (ARCHITECTURE.md,
 * "Genre: utilitarian", rule 2), and its colours are the fixed step-kind
 * scale (ARCHITECTURE.md, "Colour"): never the accent, and no status
 * colour but `paused`, which is already how a person's step is coloured.
 * Its title is the whole owner line, so the role or the action the chip
 * leaves out is one hover away.
 */

type StepOwnerFields = Pick<PipelineStepView, "type" | "ownerRole" | "entryAction">;

const KIND: Record<PipelineStepView["type"], { label: string; tone: string }> = {
  agent: { label: "agent", tone: "border-kind-agent/55 bg-kind-agent/15 text-kind-agent" },
  user: { label: "person", tone: "border-paused/55 bg-paused/15 text-paused" },
  module: { label: "script", tone: "border-kind-script/55 bg-kind-script/15 text-kind-script" },
  builtin: { label: "EO", tone: "border-ink-subtle/55 bg-ink-subtle/15 text-ink-subtle" },
};

/** "agent · reporter", "you", "module · match_po", "built in · merge": who a step belongs to. */
export function ownerLine(step: StepOwnerFields): string {
  switch (step.type) {
    case "agent":
      return `agent · ${step.ownerRole ?? "agent"}`;
    case "user":
      return "you";
    case "module":
      return `module · ${step.entryAction ?? "module"}`;
    default:
      return `built in · ${step.entryAction ?? "EO"}`;
  }
}

/** The kind chip. A terminal step is an end, not a kind of work, so it is given none by its caller. */
export function StepKindChip({ step, className }: { step: StepOwnerFields; className?: string }) {
  const kind = KIND[step.type];
  return (
    <span
      data-step-kind={kind.label}
      title={ownerLine(step)}
      className={cn("inline-flex h-5 shrink-0 items-center rounded-full border px-[9px] font-mono text-[12px] leading-none", kind.tone, className)}
    >
      {kind.label}
    </span>
  );
}
