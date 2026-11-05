import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@eo/ui";
import { ipcQuery } from "../../../query/client";
import { useChromeVocabulary } from "../../../query/hooks";
import { namesItemOrNone, useInvalidateOnPush } from "../../../query/useInvalidateOnPush";
import { groupRuns } from "../../../shared/transcript/grouping";
import { useViewParameters } from "../../../shared/view/ViewPublisher";
import { EmptyState, ErrorLine, Loading, Segmented, StatusDot } from "../../kit";
import { RefText } from "../items/ItemReference";
import { turnLabel } from "../../../shared/transcript/transcript";
import { RunDetails, Transcript, runTone, spokenStatus } from "../transcript/Transcript";
import { useFollowItemProject } from "../shared";
import { ItemHeader } from "./ItemHeader";

/**
 * `/items/:itemId/runs`: an item's runs, one conversation per row, and
 * the selected one's transcript and details (the classic `RunList`).
 *
 * One row per conversation, not per `runs` row: answering a parked
 * question resumes the same intake, and the group keeps its first turn's
 * id so the selection does not move out from under the person. Selecting
 * nothing shows the newest, and *that* is what is published as selected
 * (EO-192) — "why did this fail?" has to land on the run on screen.
 *
 * The details sit beside the transcript where the canvas is wide, and a
 * switch away where it is not.
 */
export function RunsView({ itemId }: { itemId: string }) {
  const vocabulary = useChromeVocabulary();
  const detailKey = ["item", itemId] as const;
  const detail = useQuery({ queryKey: detailKey, queryFn: () => ipcQuery("items:get", { itemId }) });
  // Reached straight from the board or an inbox row, with the item view
  // never mounted: without these a finished run stays "running" here.
  // This item's pushes only, or ones naming none (EO-560).
  const ours = namesItemOrNone(itemId);
  useInvalidateOnPush("items:changed", detailKey, { filter: ours });
  useInvalidateOnPush("runs:changed", detailKey, { filter: ours });
  useFollowItemProject(itemId, detail.data?.item.projectId ?? null);

  const groups = useMemo(() => groupRuns(detail.data?.runs ?? []), [detail.data]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = groups.find((group) => group.id === selectedId) ?? groups[0];
  useViewParameters({ selection: selected === undefined ? [] : [selected.id] });
  const [pane, setPane] = useState<"transcript" | "details">("transcript");

  const item = detail.data?.item;
  const header = (
    <ItemHeader
      itemId={itemId}
      current="runs"
      runCount={groups.length}
      title={item?.title ?? vocabulary.item}
      meta={item ? <span className="font-mono">{item.key}</span> : undefined}
    />
  );

  if (detail.isLoading)
    return (
      <div className="flex min-w-0 flex-col">
        {header}
        <Loading />
      </div>
    );
  if (detail.error)
    return (
      <div className="flex min-w-0 flex-col">
        {header}
        <ErrorLine>
          <RefText>{detail.error.message}</RefText>
        </ErrorLine>
      </div>
    );
  if (groups.length === 0 || !selected)
    return (
      <div className="flex min-w-0 flex-col">
        {header}
        <EmptyState title={`No runs yet for this ${vocabulary.item.toLowerCase()}.`}>A run starts when the step it is on hands it to an agent or to EO.</EmptyState>
      </div>
    );

  return (
    <div className="@container flex h-full min-h-0 min-w-0 flex-col">
      {header}
      <nav aria-label="Runs" className="mb-3 flex min-w-0 flex-wrap gap-1.5">
        {groups.map((group) => {
          const on = group.id === selected.id;
          return (
            <button
              key={group.id}
              type="button"
              aria-current={on}
              onClick={() => setSelectedId(group.id)}
              className={cn(
                "flex min-w-0 max-w-full flex-col items-start gap-0.5 rounded-[10px] px-3 py-1.5 text-left",
                on ? "bg-canvas-raised text-ink" : "text-ink-muted hover:bg-canvas-subtle",
              )}
            >
              <span className="flex min-w-0 items-center gap-1.5 text-[12.5px]">
                <StatusDot tone={runTone(group.latest.status)} />
                <span className="truncate font-medium">{group.latest.actionName}</span>
                <span className="text-[11.5px] text-ink-subtle">{spokenStatus(group.latest.status)}</span>
              </span>
              <span className="text-[11px] text-ink-subtle">{turnLabel(group) ?? `attempt ${group.latest.attempt}`}</span>
            </button>
          );
        })}
      </nav>

      <div className="mb-3 @4xl:hidden">
        <Segmented
          label="Show"
          size="sm"
          value={pane}
          onChange={setPane}
          options={[
            { value: "transcript", label: "Transcript" },
            { value: "details", label: "Details" },
          ]}
        />
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 gap-3">
        <div className={cn("min-h-0 min-w-0 flex-1 flex-col", pane === "details" ? "hidden @4xl:flex" : "flex")}>
          <Transcript key={selected.id} group={selected} itemId={itemId} />
        </div>
        <div className={cn("min-h-0 min-w-0 flex-col overflow-y-auto relative @4xl:w-[16rem] @4xl:shrink-0", pane === "details" ? "flex flex-1 @4xl:flex-none" : "hidden @4xl:flex")}>
          <RunDetails group={selected} />
        </div>
      </div>
    </div>
  );
}
