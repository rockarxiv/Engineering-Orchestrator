import { useId, useMemo } from "react";
import { Link } from "react-router-dom";
import { USER_ATTENTION_TARGET, type HandOffTargets, type PipelineStepView, type StepRouteView } from "@eo/core";
import { cn } from "@eo/ui";
import { BOX_PAD_X, layoutPipeline, ownerLine, type LaidArrow, type Rect } from "./layout";

/**
 * A pipeline, drawn as the graph it is (EO-400): its steps as boxes from
 * top to bottom, and every route as an arrow labelled with the result
 * that takes it — straight down to the next step, around the side to any
 * other, and out to a marker when it leaves for you, the end or another
 * pipeline.
 *
 * The one picture of a pipeline the chat layout has: the assistant's
 * draft card and the pipeline's Graph view both render this, so a draft
 * looks before Publish exactly as the pipeline will after it. Where
 * everything goes is `layoutPipeline`'s answer and nothing here moves
 * it; this file only draws the rectangles and paths it is given.
 *
 * The drawing is as wide as its boxes, labels and lanes need and no
 * narrower. In a column too narrow for it, it scrolls sideways inside
 * its own frame rather than squeezing a box below its text.
 */

const px = (rect: Rect) => ({ left: rect.x, top: rect.y, width: rect.width, height: rect.height });

/** The state colours, only where a route is about a state: waiting on you, or failure. */
function toneOf(route: StepRouteView): { line: string; text: string } {
  if (route.target === USER_ATTENTION_TARGET || route.tone === "warning") return { line: "text-paused", text: "text-paused" };
  if (route.tone === "danger") return { line: "text-danger", text: "text-danger" };
  return { line: "text-line-strong", text: "text-ink-muted" };
}

/** The graph in one sentence, for anyone not looking at it. */
function describe(ordered: PipelineStepView[], arrows: LaidArrow[]): string {
  const order = ordered.map((step) => step.name).join(" → ");
  const deviations = ordered.flatMap((step) =>
    arrows.filter((arrow) => arrow.from.id === step.id && arrow.kind !== "next").map((arrow) => `${step.name} on ${arrow.label.text} goes to ${arrow.to}`),
  );
  return deviations.length === 0 ? `Pipeline: ${order}.` : `Pipeline: ${order}. Other routes: ${deviations.join("; ")}.`;
}

export function PipelineDrawing({
  steps,
  routes,
  elsewhere,
  entryStepId,
  entryNote = null,
  counts,
  stepHref,
  selectedStepId = null,
  onSelectStep,
  className,
}: {
  steps: PipelineStepView[];
  routes: StepRouteView[];
  /** The other pipelines a route may hand work to. Without it a hand-off cannot be told from a broken target, and is not drawn. */
  elsewhere?: HandOffTargets[];
  /** Where work enters, as the pipeline says — not merely the first step drawn. */
  entryStepId: string | null;
  /** What work must have to enter (EO-610), in the words a refusal would use, drawn on the entry step. */
  entryNote?: string | null;
  /** How much stands on each step now, by step id. Absent where nothing can stand on one yet: a draft. */
  counts?: ReadonlyMap<string, number>;
  /** Where "N here" goes: the board narrowed to that step. */
  stepHref?: (stepId: string) => string;
  /** The step whose details are open beside the drawing (EO-524), drawn as chosen. */
  selectedStepId?: string | null;
  /** Makes each step's name a button that opens its details. Absent on a draft, whose steps are read on the card itself. */
  onSelectStep?: (stepId: string) => void;
  className?: string;
}) {
  const layout = useMemo(() => layoutPipeline(steps, routes, elsewhere), [steps, routes, elsewhere]);
  const describedBy = useId();
  if (layout.steps.length === 0) return null;

  return (
    <div data-pipeline-drawing className={cn("max-w-full min-w-0 overflow-x-auto", className)}>
      <p id={describedBy} className="sr-only">
        {describe(
          layout.steps.map((laid) => laid.step),
          layout.arrows,
        )}
      </p>
      <div className="relative shrink-0" style={{ width: layout.width, height: layout.height }}>
        <svg aria-hidden width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} className="pointer-events-none absolute left-0 top-0">
          {layout.arrows.map((arrow) => (
            <g key={arrow.route.id} data-route={arrow.route.id} className={toneOf(arrow.route).line}>
              <path
                d={arrow.path}
                fill="none"
                stroke="currentColor"
                strokeWidth={1.25}
                // Dashed when it runs against the direction everything else moves.
                strokeDasharray={arrow.back ? "4 3" : undefined}
              />
              <path d={arrow.head} fill="currentColor" />
            </g>
          ))}
        </svg>

        <ol aria-label="Pipeline graph" aria-describedby={describedBy}>
          {layout.steps.map(({ step, box }) => {
            const here = counts?.get(step.id) ?? 0;
            return (
              <li
                key={step.id}
                data-step={step.id}
                style={{ ...px(box), paddingLeft: BOX_PAD_X, paddingRight: BOX_PAD_X }}
                className={cn(
                  "absolute flex flex-col justify-center gap-0.5 rounded-[12px]",
                  // A terminal step is an end: outlined, not filled.
                  step.isTerminal ? "shadow-[inset_0_0_0_1px_var(--color-line-strong)]" : "bg-canvas",
                  // The step whose details are open: outlined in the accent, the way the layout marks what is chosen.
                  step.id === selectedStepId && "shadow-[inset_0_0_0_1.5px_var(--color-accent)]",
                )}
              >
                <span className="flex min-w-0 items-center gap-2">
                  {onSelectStep ? (
                    // The name, not the whole box: "N here" beside it is a link of its own.
                    <button
                      type="button"
                      title={step.name}
                      aria-pressed={step.id === selectedStepId}
                      onClick={() => onSelectStep(step.id)}
                      className={cn("truncate text-left text-[13px] font-medium hover:underline", step.isTerminal ? "text-ink-muted" : "text-ink")}
                    >
                      {step.name}
                    </button>
                  ) : (
                    <b title={step.name} className={cn("truncate text-[13px] font-medium", step.isTerminal ? "text-ink-muted" : "text-ink")}>
                      {step.name}
                    </b>
                  )}
                  {step.id === entryStepId ? <span className="shrink-0 rounded-[5px] bg-canvas-active px-1.5 text-[10.5px] text-ink-muted">start</span> : null}
                </span>
                <span className="flex min-w-0 items-center gap-2">
                  <span className={cn("truncate font-mono text-[11px]", !step.isTerminal && step.type === "user" ? "text-paused" : "text-ink-subtle")}>
                    {step.isTerminal ? "end" : ownerLine(step)}
                  </span>
                  {here > 0 && stepHref ? (
                    // What stands here now, and the board narrowed to it.
                    <Link to={stepHref(step.id)} className="ml-auto shrink-0 text-[11px] text-ink-subtle hover:text-ink hover:underline">
                      {here} here
                    </Link>
                  ) : null}
                </span>
                {step.id === entryStepId && entryNote !== null ? (
                  <span title={entryNote} className="truncate text-[11px] text-ink-subtle">
                    {entryNote}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ol>

        <ul aria-label="Routes">
          {layout.arrows.map((arrow) => {
            const tone = toneOf(arrow.route);
            return (
              <li key={arrow.route.id} className="contents">
                <span
                  title={arrow.label.text}
                  style={px(arrow.label.rect)}
                  className={cn("absolute truncate font-mono text-[10.5px] leading-[14px]", arrow.kind === "side" ? "text-right" : "text-left", tone.text)}
                >
                  {arrow.label.text}
                </span>
                <span className="sr-only">
                  : {arrow.from.name} → {arrow.to}
                </span>
                {arrow.marker ? (
                  // Where a route out of the pipeline ends. The sentence beside its label has already said so.
                  <span
                    aria-hidden
                    title={arrow.marker.text}
                    style={px(arrow.marker.rect)}
                    className={cn("absolute truncate rounded-full border border-dashed border-current px-[7px] text-[11px] leading-[16px]", tone.text)}
                  >
                    {arrow.marker.text}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
