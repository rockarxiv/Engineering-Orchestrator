import { StepKindDot, stepKindLabel } from "../kit";
import { ROUTE_TONE } from "./PipelineDrawing";

/**
 * What the lines and dots in a pipeline's drawing mean, in one line above
 * it (EO-686): the four kinds of route, then the four owners a step's dot
 * can name. Drawn on the Graph view only — the assistant's draft card is
 * read beside the conversation that explains it, and has no room to
 * spare.
 *
 * Each sample is drawn with the drawing's own classes (`ROUTE_TONE`, the
 * kind chip's dot), so the key says what the drawing shows.
 */

const ROUTES = [
  { word: "next", tone: ROUTE_TONE.next, dashed: false },
  { word: "sends back", tone: ROUTE_TONE.back, dashed: true },
  { word: "lands with you", tone: ROUTE_TONE.person, dashed: false },
  { word: "failed", tone: ROUTE_TONE.failed, dashed: false },
] as const;

const OWNERS = ["agent", "user", "module", "builtin"] as const;

export function GraphLegend() {
  return (
    <ul aria-label="Legend" data-graph-legend className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11.5px] leading-[16px] text-ink-muted">
      {ROUTES.map(({ word, tone, dashed }) => (
        <li key={word} data-legend-route={word} className="flex items-center gap-1.5">
          <svg aria-hidden width={22} height={8} viewBox="0 0 22 8" className={tone.line}>
            <path d="M1 4H21" stroke="currentColor" strokeWidth={1.5} strokeDasharray={dashed ? "4 3" : undefined} />
          </svg>
          {word}
        </li>
      ))}
      <li aria-hidden className="h-3.5 w-px bg-line" />
      <li className="text-ink-subtle">step owner:</li>
      {OWNERS.map((type) => (
        <li key={type} data-legend-owner={stepKindLabel(type)} className="flex items-center gap-1.5">
          <StepKindDot type={type} />
          {stepKindLabel(type)}
        </li>
      ))}
    </ul>
  );
}
