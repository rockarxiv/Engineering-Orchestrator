import { MODULE_COVERAGE_BAR, type ModuleTestRun } from "@eo/core";
import { cn } from "@eo/ui";
import { Chip } from "../kit";

/**
 * How much of a module's code its tests reach (EO-354), as the chat
 * layout draws it.
 *
 * Line coverage is the figure, in the colour the rule gives it: green at
 * the bar and above, amber from 60%, red below. Branch coverage sits
 * beside it uncoloured — the rule is about lines, and two coloured chips
 * would read as two verdicts. A module with no tests is red 0%, said
 * rather than left blank; cases that exist and have not run are the one
 * state with no figure, and it says so.
 */

/** Where amber starts. Under it is red. */
const COVERAGE_WARNING_FLOOR = 60;

export type CoverageTone = "success" | "warning" | "danger";

export function coverageTone(percent: number): CoverageTone {
  if (percent >= MODULE_COVERAGE_BAR) return "success";
  if (percent >= COVERAGE_WARNING_FLOOR) return "warning";
  return "danger";
}

/**
 * The rule's verdict on the layout's status scale — the kit `Chip`'s
 * shape, drawn here so the figure itself carries `data-tone`.
 */
const CHIP_TONE: Record<CoverageTone, string> = {
  success: "bg-running/15 text-running",
  warning: "bg-paused/15 text-paused",
  danger: "bg-danger/15 text-danger",
};

export function CoverageBadge({ run, testCount }: { run: ModuleTestRun | null; testCount: number }) {
  const figures = testCount === 0 ? { lines: 0, branches: 0 } : run === null ? null : { lines: run.coverage.lines.percent, branches: run.coverage.branches.percent };

  if (figures === null)
    return (
      <span className="inline-flex items-center gap-1.5" aria-label="Coverage not measured yet">
        <Chip>Coverage not measured yet</Chip>
      </span>
    );

  const tone = coverageTone(figures.lines);
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5" aria-label={`Line coverage ${figures.lines}%, branch coverage ${figures.branches}%`}>
      <span data-tone={tone} className={cn("inline-flex h-[22px] shrink-0 items-center rounded-[7px] px-2 text-[11.5px] tabular-nums whitespace-nowrap", CHIP_TONE[tone])}>
        {figures.lines}% lines
      </span>
      <span className="text-[11.5px] tabular-nums text-ink-subtle">{figures.branches}% branches</span>
    </span>
  );
}
