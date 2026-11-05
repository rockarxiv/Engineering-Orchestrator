import { useEffect, useRef, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Columns3, GitFork } from "lucide-react";
import { cn } from "@eo/ui";
import { TERMINAL_TARGET, USER_ATTENTION_TARGET, type PipelineStepView } from "@eo/core";
import { useChromeVocabulary, usePipelines, useProjectItems } from "../../query/hooks";
import { useProjects } from "../../query/useRepositories";

/** Small lookups more than one chat view needs. */

export function usePipelineName(pipelineId: string): string {
  const { active } = useProjects();
  const { pipelines } = usePipelines(active?.id ?? null);
  return pipelines.find((pipeline) => pipeline.id === pipelineId)?.name ?? "Pipeline";
}

export function useItemKey(itemId: string): string {
  const { items } = useProjectItems();
  const vocabulary = useChromeVocabulary();
  return items.find((item) => item.id === itemId)?.key ?? vocabulary.item;
}

/**
 * An item can be opened from a notification or the inbox while another
 * project is active. Following it switches to its project, as the classic
 * item page does (U-07), rather than drawing it beside the wrong rail.
 *
 * Once per item, not on every change of project: the rail's switcher sits
 * beside this view, and a person who picks another project there means
 * it — a follow that re-ran would put them straight back.
 */
export function useFollowItemProject(itemId: string, projectId: string | null) {
  const { activeProjectId, setActive } = useProjects();
  const followed = useRef<string | null>(null);
  useEffect(() => {
    if (projectId === null || activeProjectId === null || followed.current === itemId) return;
    followed.current = itemId;
    if (projectId !== activeProjectId) setActive(projectId);
  }, [itemId, projectId, activeProjectId, setActive]);
}

/**
 * Where a route goes, said the way a person would: a step's name, "you",
 * the end, or a step on the pipeline it hands work to.
 */
export function targetName(target: string, steps: PipelineStepView[], elsewhere: { pipelineName: string; steps: PipelineStepView[] }[] = []): string {
  if (target === USER_ATTENTION_TARGET) return "you";
  if (target === TERMINAL_TARGET) return "the end";
  const here = steps.find((step) => step.id === target);
  if (here) return here.name;
  for (const pipeline of elsewhere) {
    const there = pipeline.steps.find((step) => step.id === target);
    if (there) return `${pipeline.pipelineName} · ${there.name}`;
  }
  // A step this pipeline no longer has, or a hand-off this view was not
  // told the names for: said as unknown rather than guessed as a hand-off.
  return "a step not shown here";
}

/** Which of a pipeline's views is open. `changes` (EO-524) is reached from the board and the graph rather than switched to, so it adds no entry of its own. */
export type PipelineViewKind = "board" | "graph" | "changes";

/**
 * Board and graph: one pipeline seen two ways, and the way between them.
 * Links to the classic addresses, which the canvas keeps in one tab.
 *
 * There is no configure screen to switch to (EO-518, EO-525): a pipeline
 * is changed through the assistant.
 */
export function PipelineViews({ pipelineId, current }: { pipelineId: string; current: PipelineViewKind }) {
  const id = encodeURIComponent(pipelineId);
  const entries: { kind: PipelineViewKind; to: string; label: string; icon: ReactNode }[] = [
    { kind: "board", to: `/pipelines/${id}`, label: "Board", icon: <Columns3 size={13} /> },
    { kind: "graph", to: `/pipelines/${id}?view=graph`, label: "Graph", icon: <GitFork size={13} /> },
  ];
  return (
    <nav aria-label="Pipeline views" className="inline-flex shrink-0 gap-0.5 rounded-[10px] bg-canvas-raised p-0.5">
      {entries.map((entry) => (
        <Link
          key={entry.kind}
          to={entry.to}
          {...(entry.kind === current ? { "aria-current": "page" as const } : {})}
          className={cn(
            "inline-flex h-7 items-center gap-1.5 rounded-[8px] px-2.5 text-[12.5px]",
            entry.kind === current ? "bg-canvas-active text-ink" : "text-ink-subtle hover:text-ink",
          )}
        >
          {entry.icon}
          {entry.label}
        </Link>
      ))}
    </nav>
  );
}
