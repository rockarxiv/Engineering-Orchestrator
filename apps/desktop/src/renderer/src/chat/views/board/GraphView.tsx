import { useCallback, useMemo, useState } from "react";
import { STEP_ID_FACET } from "@eo/core";
import { usePipelineData, usePipelines } from "../../../query/hooks";
import { useProjects } from "../../../query/useRepositories";
import { useViewParameters } from "../../../shared/view/ViewPublisher";
import { EmptyState, ErrorLine, Loading, ViewHeader } from "../../kit";
import { GraphLegend } from "../../graph/GraphLegend";
import { stepLoads } from "../../graph/load";
import { PipelineDrawing } from "../../graph/PipelineDrawing";
import { usePipelineName } from "../shared";
import { PipelineViews } from "../shared";
import { AskAssistantButton, EMPTY_PIPELINE_TEXT, PipelineTitle } from "./header";
import { PipelineDetails } from "./PipelineDetails";
import { StepDetails } from "./StepDetails";

/**
 * The pipeline as a graph (`?view=graph`): its steps as boxes from top to
 * bottom and every route as an arrow labelled with the result that takes
 * it — a send-back going back up, a hand-off to you, an exit to another
 * pipeline, the end.
 *
 * The picture is `PipelineDrawing`, the one the assistant's draft card
 * draws (EO-400), so a pipeline looks here as its draft looked in the
 * conversation. What this view adds is what only a published pipeline
 * has: where its work stands now, and how it is set up (EO-524) — a
 * step's details when its name is pressed, and the pipeline's history,
 * webhook setting and organisation beside it. All of it read-only: a
 * pipeline is changed through the assistant, which is the one button.
 */

export function GraphView({ pipelineId }: { pipelineId: string }) {
  const name = usePipelineName(pipelineId);
  const { items, states, routes, elsewhere, entrySentence, verification, workspaces, workspaceKind, isLoading, error } = usePipelineData(pipelineId);
  const ordered = useMemo(() => [...states].sort((a, b) => a.position - b.position), [states]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = ordered.find((step) => step.id === selectedId) ?? null;
  // Which step's details are open, for the assistant (`view:current`): an id, resolved there.
  useViewParameters({ selection: selected === null ? [] : [selected.id] });

  // What stands on each step now, and in what state: held work is parked, not in play.
  const loads = useMemo(() => stepLoads(items, pipelineId, states), [items, pipelineId, states]);

  // Where work enters, as the pipeline says — not merely the first step drawn.
  const { active } = useProjects();
  const { pipelines } = usePipelines(active?.id ?? null);
  const entry = pipelines.find((pipeline) => pipeline.id === pipelineId)?.entryStepId ?? null;
  const stepHref = useCallback((stepId: string) => `/pipelines/${pipelineId}?${STEP_ID_FACET}=${encodeURIComponent(stepId)}`, [pipelineId]);

  return (
    <div className="flex min-w-0 flex-col">
      <ViewHeader
        title={<PipelineTitle name={name} pipelineId={pipelineId} />}
        stackActions
        meta="The steps as published, and the result that takes work from each to the next. Press a step's name to see how it is set up."
        actions={
          <>
            <PipelineViews pipelineId={pipelineId} current="graph" />
            <AskAssistantButton />
          </>
        }
      />
      {isLoading ? (
        <Loading />
      ) : error ? (
        <ErrorLine>{error.message}</ErrorLine>
      ) : ordered.length === 0 ? (
        <EmptyState title="No steps yet.">{EMPTY_PIPELINE_TEXT}</EmptyState>
      ) : (
        <div className="flex min-w-0 flex-col gap-4">
          <GraphLegend />
          <PipelineDrawing
            steps={ordered}
            routes={routes}
            elsewhere={elsewhere}
            entryStepId={entry}
            entryNote={entrySentence}
            loads={loads}
            stepHref={stepHref}
            selectedStepId={selected?.id ?? null}
            onSelectStep={(stepId) => setSelectedId((current) => (current === stepId ? null : stepId))}
          />
          {/* The box cuts a long sentence off; here it is whole. */}
          {selected !== null && selected.id === entry && entrySentence !== null ? <p className="text-[12.5px] text-ink-muted">{entrySentence}</p> : null}
          {selected === null ? null : (
            <StepDetails
              key={selected.id}
              step={selected}
              steps={ordered}
              routes={routes}
              elsewhere={elsewhere}
              verification={verification.find((entry) => entry.stepId === selected.id)}
              workspaces={workspaces}
              workspaceKind={workspaceKind}
            />
          )}
        </div>
      )}
      {isLoading || error ? null : (
        <div className="mt-4">
          <PipelineDetails pipelineId={pipelineId} />
        </div>
      )}
    </div>
  );
}
