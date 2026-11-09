import { useId, useMemo } from "react";
import { Link } from "react-router-dom";
import { USER_ATTENTION_TARGET, type HandOffTargets, type PipelineStepView, type StepRouteView } from "@eo/core";
import { cn } from "@eo/ui";
import { StepKindChip, stepLane } from "../kit";
import { BOX_PAD_X, layoutPipeline, type LaidArrow, type Rect } from "./layout";
import { WORK_STATE_FILL, WORK_STATE_WORDS, WORK_STATES } from "../../shared/items/workState";
import { loadTotal, type StepLoad } from "./load";

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
 * A step is one raised row (EO-680): its name, then the kind chip at the
 * far end, whose title is the owner line the box used to spell out. A
 * step an agent, a person or a script owns has a 4px edge on its left in
 * that kind's colour on the neutral surface, the same lane as its board
 * column (EO-685, EO-694); EO's own steps have an edge
 * in the strong line, and an end is outlined as before. On a
 * draft for an existing pipeline, a step that pipeline has not got yet is
 * outlined dashed in the neutral ink and tagged "new" — never the accent,
 * since a new step is not something to press. A step that holds work has
 * a load strip along its bottom edge, in the state colours of what is on
 * it (EO-686): owner on the step, state on the work.
 *
 * The drawing is as wide as its boxes, labels and lanes need and no
 * narrower. In a column too narrow for it, it scrolls sideways inside
 * its own frame rather than squeezing a box below its text.
 */

const px = (rect: Rect) => ({ left: rect.x, top: rect.y, width: rect.width, height: rect.height });

/**
 * What a route's colour says (EO-686). Amber means only "this lands with
 * you": a route out to a person is amber, its end marker solid on a light
 * amber fill. A failure is red. A send-back is ordinary rework, so it is
 * neutral — the subtle ink, fainter still on its line — and its dashes
 * already say which way it runs. Everything else, the route on to the
 * next step included, is the plain line and the muted ink.
 *
 * The legend above the Graph view draws its samples from these, so the
 * key and the drawing cannot disagree.
 */
export const ROUTE_TONE = {
  next: { line: "text-line-strong", text: "text-ink-muted", marker: "border-dashed" },
  back: { line: "text-ink-subtle/70", text: "text-ink-subtle", marker: "border-dashed" },
  person: { line: "text-paused", text: "text-paused", marker: "border-solid bg-[color:color-mix(in_oklab,var(--color-canvas),var(--color-paused)_16%)]" },
  failed: { line: "text-danger", text: "text-danger", marker: "border-dashed" },
} as const;

type RouteTone = (typeof ROUTE_TONE)[keyof typeof ROUTE_TONE];

/** A route to a person is amber even when it is a failure: what matters to whoever looks is that it is theirs now. */
function toneOf(arrow: LaidArrow): RouteTone {
  if (arrow.route.target === USER_ATTENTION_TARGET) return ROUTE_TONE.person;
  if (arrow.route.tone === "danger") return ROUTE_TONE.failed;
  if (arrow.back) return ROUTE_TONE.back;
  return ROUTE_TONE.next;
}

/**
 * What stands on a step, by state (EO-686): a 3px bar along the bottom of
 * its box, 12px in from each side, one segment per state as wide as its
 * share of the count. Inside the box's bottom padding, so the layout has
 * nothing to make room for.
 */
function LoadStrip({ load }: { load: StepLoad }) {
  const present = WORK_STATES.filter((state) => (load[state] ?? 0) > 0);
  const said = present.map((state) => `${load[state]} ${WORK_STATE_WORDS[state]}`).join(", ");
  return (
    <span data-load-strip role="img" aria-label={said} className="absolute bottom-1.5 left-3 right-3 flex h-[3px] gap-[2px]">
      {present.map((state) => (
        <span
          key={state}
          data-load={state}
          title={`${load[state]} ${WORK_STATE_WORDS[state]}`}
          style={{ flexGrow: load[state] }}
          className={cn("h-full basis-0 rounded-full", WORK_STATE_FILL[state])}
        />
      ))}
    </span>
  );
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
  loads,
  stepHref,
  selectedStepId = null,
  onSelectStep,
  newStepIds,
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
  /** What stands on each step now and in what state, by step id: "N here" and the load strip. Absent where nothing can stand on one yet: a draft. */
  loads?: ReadonlyMap<string, StepLoad>;
  /** Where "N here" goes: the board narrowed to that step. */
  stepHref?: (stepId: string) => string;
  /** The step whose details are open beside the drawing (EO-524), drawn as chosen. */
  selectedStepId?: string | null;
  /** Makes each step's name a button that opens its details. Absent on a draft, whose steps are read on the card itself. */
  onSelectStep?: (stepId: string) => void;
  /**
   * The steps a draft adds to the pipeline it changes, drawn as new.
   * Only the draft card passes it, and only for a pipeline that exists:
   * on a new one every step would be new, which says nothing.
   */
  newStepIds?: ReadonlySet<string>;
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
            <g key={arrow.route.id} data-route={arrow.route.id} className={toneOf(arrow).line}>
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
            const load = loads?.get(step.id);
            const here = loadTotal(load);
            const noted = step.id === entryStepId && entryNote !== null;
            const added = newStepIds?.has(step.id) ?? false;
            const chosen = step.id === selectedStepId;
            const lane = stepLane(step);
            return (
              <li
                key={step.id}
                data-step={step.id}
                {...(added ? { "data-new-step": "" } : {})}
                style={{ ...px(box), paddingLeft: BOX_PAD_X, paddingRight: BOX_PAD_X }}
                className={cn(
                  "absolute flex flex-col justify-center gap-0.5 rounded-[10px] border",
                  // Two lines leave little room below: keep the load strip clear of the note, whether or not one is drawn yet.
                  noted && "pb-[7px]",
                  // A terminal step is an end: outlined, not filled. Every other step is raised on a hairline, in its owner's lane.
                  step.isTerminal ? "border-line-strong" : cn(lane.surface, lane.edge),
                  // New in this draft: dashed, in the neutral ink rather than the accent (ARCHITECTURE.md, "Genre: utilitarian", rule 6).
                  added && "border-[1.5px] border-dashed border-ink-muted",
                  // The owner's edge down the left, and the step whose details are open outlined in the accent,
                  // the way the layout marks what is chosen. One shadow, so the two can be drawn together.
                  step.isTerminal
                    ? chosen && "shadow-[inset_0_0_0_1.5px_var(--color-accent)]"
                    : chosen
                      ? "shadow-[inset_4px_0_0_var(--lane-edge),inset_0_0_0_1.5px_var(--color-accent)]"
                      : "shadow-[inset_4px_0_0_var(--lane-edge)]",
                )}
              >
                {added ? (
                  // Astride the top edge: the layout leaves at least 6px above every box, and no route's label comes that close.
                  <span className="absolute right-3 top-[-6px] rounded-full bg-canvas-raised px-1.5 text-[10.5px] leading-[12px] text-ink-muted">new</span>
                ) : null}
                <span className="flex min-w-0 items-center gap-2">
                  {onSelectStep ? (
                    // The name, not the whole box: "N here" beside it is a link of its own.
                    <button
                      type="button"
                      title={step.name}
                      aria-pressed={chosen}
                      onClick={() => onSelectStep(step.id)}
                      className={cn("truncate text-left text-[15px] font-semibold hover:underline", step.isTerminal ? "text-ink-muted" : "text-ink")}
                    >
                      {step.name}
                    </button>
                  ) : (
                    <b title={step.name} className={cn("truncate text-[15px] font-semibold", step.isTerminal ? "text-ink-muted" : "text-ink")}>
                      {step.name}
                    </b>
                  )}
                  {step.id === entryStepId ? <span className="shrink-0 rounded-[5px] bg-canvas-active px-1.5 text-[11.5px] text-ink-muted">start</span> : null}
                  <span className="ml-auto flex shrink-0 items-center gap-2">
                    {here > 0 && stepHref ? (
                      // What stands here now, and the board narrowed to it: a small pill in the ink.
                      <Link
                        to={stepHref(step.id)}
                        className="rounded-full border border-line-strong bg-canvas px-2 text-[12px] leading-[18px] tabular-nums text-ink hover:underline"
                      >
                        {here} here
                      </Link>
                    ) : null}
                    {/* An end is not a kind of work: no chip, and the outline says it. Said aloud, since the outline is not. */}
                    {step.isTerminal ? <span className="sr-only">end</span> : <StepKindChip step={step} />}
                  </span>
                </span>
                {noted ? (
                  <span title={entryNote ?? undefined} className="truncate text-[11px] leading-[13px] text-ink-subtle">
                    {entryNote}
                  </span>
                ) : null}
                {load !== undefined && here > 0 ? <LoadStrip load={load} /> : null}
              </li>
            );
          })}
        </ol>

        <ul aria-label="Routes">
          {layout.arrows.map((arrow) => {
            const tone = toneOf(arrow);
            return (
              <li key={arrow.route.id} className="contents">
                <span
                  title={arrow.label.text}
                  style={px(arrow.label.rect)}
                  className={cn("absolute truncate font-mono text-[11.5px] leading-[14px]", arrow.kind === "side" ? "text-right" : "text-left", tone.text)}
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
                    className={cn("absolute truncate rounded-full border border-current px-[7px] text-[11px] leading-[16px]", tone.marker, tone.text)}
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
