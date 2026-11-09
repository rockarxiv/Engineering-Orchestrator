import type { PipelineStepView } from "@eo/core";
import { cn } from "@eo/ui";

/**
 * What kind of step a step is, as a chip (EO-680): who does the work
 * there — an agent, a person, a script or EO itself.
 *
 * One chip for every place a step is drawn — the pipeline drawing on the
 * Graph view and the assistant's draft card, the board's column heads,
 * and the step details, the design card and the version diff — so the
 * four kinds are told apart the same way wherever a step is seen. The
 * kind is a machine word, so it is mono (ARCHITECTURE.md, "Genre:
 * utilitarian", rule 2). The pill itself is neutral, in the muted ink on
 * the strong line (EO-685); its one colour is a dot before the word in
 * the step-kind scale (ARCHITECTURE.md, "Colour"): never the accent, and
 * no status colour but `paused`, which is already how a person's step is
 * coloured. EO's own steps are the neutral case, a hollow ring. Its title
 * is the whole owner line, so the role or the action the chip leaves out
 * is one hover away.
 */

type StepOwnerFields = Pick<PipelineStepView, "type" | "ownerRole" | "entryAction">;

const KIND: Record<PipelineStepView["type"], { label: string; dot: string }> = {
  agent: { label: "agent", dot: "bg-kind-agent" },
  user: { label: "person", dot: "bg-paused" },
  module: { label: "script", dot: "bg-kind-script" },
  builtin: { label: "EO", dot: "border-[1.5px] border-ink-subtle" },
};

/**
 * The structure a step is drawn as, in its owner's colour (EO-685): a
 * board column, or a step in the pipeline drawing. Owner on structure,
 * state on work — an item's run state colours its card, never this.
 *
 * - `surface`: the raised surface mixed 14% toward the kind, on a line mixed 22% toward it.
 * - `cap`: a board column's 3px top border in the kind.
 * - `ownerInk`: a board column's mono owner line, the subtle ink mixed 35% toward the kind.
 * - `edge`: a graph step's 4px left edge, as `--lane-edge` for the step's own shadow to draw.
 *
 * Written out whole, kind by kind, so Tailwind finds every class.
 */
export interface StepLane {
  surface: string;
  cap: string;
  ownerInk: string;
  edge: string;
}

/** EO's own steps and the ends: today's neutral surface, and a strong-line edge on the graph. */
const NEUTRAL_LANE: StepLane = {
  surface: "border-line bg-canvas-raised",
  cap: "",
  ownerInk: "text-ink-subtle",
  edge: "[--lane-edge:var(--color-line-strong)]",
};

const LANE: Record<PipelineStepView["type"], StepLane> = {
  agent: {
    surface:
      "border-[color:color-mix(in_oklab,var(--color-line),var(--color-kind-agent)_22%)] bg-[color:color-mix(in_oklab,var(--color-canvas-raised),var(--color-kind-agent)_14%)]",
    cap: "border-t-[3px] border-t-kind-agent",
    ownerInk: "text-[color:color-mix(in_oklab,var(--color-ink-subtle),var(--color-kind-agent)_35%)]",
    edge: "[--lane-edge:var(--color-kind-agent)]",
  },
  user: {
    surface:
      "border-[color:color-mix(in_oklab,var(--color-line),var(--color-paused)_22%)] bg-[color:color-mix(in_oklab,var(--color-canvas-raised),var(--color-paused)_14%)]",
    cap: "border-t-[3px] border-t-paused",
    ownerInk: "text-[color:color-mix(in_oklab,var(--color-ink-subtle),var(--color-paused)_35%)]",
    edge: "[--lane-edge:var(--color-paused)]",
  },
  module: {
    surface:
      "border-[color:color-mix(in_oklab,var(--color-line),var(--color-kind-script)_22%)] bg-[color:color-mix(in_oklab,var(--color-canvas-raised),var(--color-kind-script)_14%)]",
    cap: "border-t-[3px] border-t-kind-script",
    ownerInk: "text-[color:color-mix(in_oklab,var(--color-ink-subtle),var(--color-kind-script)_35%)]",
    edge: "[--lane-edge:var(--color-kind-script)]",
  },
  builtin: NEUTRAL_LANE,
};

/** The lane a step is drawn in: its owner's, or the neutral one for EO's own steps and for an end, which is not a kind of work. */
export function stepLane(step: StepOwnerFields & Pick<PipelineStepView, "isTerminal">): StepLane {
  return step.isTerminal ? NEUTRAL_LANE : LANE[step.type];
}

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

/** The kind's dot alone, as the chip draws it: also the Graph view's legend's key to the owners (EO-686). */
export function StepKindDot({ type }: { type: PipelineStepView["type"] }) {
  return <span aria-hidden data-step-kind-dot className={cn("size-[7px] shrink-0 rounded-full", KIND[type].dot)} />;
}

/** The word the chip says for a kind: "agent", "person", "script", "EO". */
export function stepKindLabel(type: PipelineStepView["type"]): string {
  return KIND[type].label;
}

/** The kind chip. A terminal step is an end, not a kind of work, so it is given none by its caller. */
export function StepKindChip({ step, className }: { step: StepOwnerFields; className?: string }) {
  const kind = KIND[step.type];
  return (
    <span
      data-step-kind={kind.label}
      title={ownerLine(step)}
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full border border-line-strong px-[9px] font-mono text-[12px] leading-none text-ink-muted",
        className,
      )}
    >
      <StepKindDot type={step.type} />
      {kind.label}
    </span>
  );
}
