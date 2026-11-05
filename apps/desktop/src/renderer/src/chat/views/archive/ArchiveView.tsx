import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { Archive, ArchiveRestore } from "lucide-react";
import { JOB_ID_FACET, STEP_ID_FACET, matchesArchiveFilter, type IpcRequest, type ViewFilter } from "@eo/core";
import { archivedKey } from "../../../shared/pipeline/archive";
import { ipcQuery } from "../../../query/client";
import { itemsKey, useChromeVocabulary } from "../../../query/hooks";
import { useInFlight } from "../../../query/useInFlight";
import { useProjects } from "../../../query/useRepositories";
import { useInvalidateOnPush } from "../../../query/useInvalidateOnPush";
import { useViewParameters } from "../../../shared/view/ViewPublisher";
import { Button, Card, Chip, EmptyState, ErrorLine, Loading, Notice, RowList, Tabs, ViewHeader, VirtualRows } from "../../kit";
import { ItemKeyLink, ItemText } from "../inbox/references";

function when(ts: number): string {
  return new Date(ts).toLocaleDateString();
}

type Tab = "items" | "pipelines";

const META = "Put away, never deleted: every row still opens, and Restore puts it back on its board.";

/**
 * `/archive`: what the project has put away (KAN-33), and the pipelines
 * somebody deleted (KAN-59).
 *
 * Archiving is only honestly reversible if there is somewhere to reverse
 * it from, so every row links to its item — nothing was deleted — and
 * carries Restore. The address can narrow the list to one step
 * (`?step=`, EO-230, from the configure screen's refusal) or one job
 * (`?job=`, EO-308, from the Job page); the narrowing is said out loud
 * and undone in one press.
 */
export function ArchiveView() {
  const queryClient = useQueryClient();
  const archived = useQuery({ queryKey: archivedKey, queryFn: () => ipcQuery("items:listArchived", undefined) });
  useInvalidateOnPush("items:changed", archivedKey);
  const vocabulary = useChromeVocabulary();

  const [tab, setTab] = useState<Tab>("items");
  const [searchParams, setSearchParams] = useSearchParams();
  const stepFilter = searchParams.get(STEP_ID_FACET);
  const jobFilter = searchParams.get(JOB_ID_FACET);
  const filter: ViewFilter = {
    text: "",
    facets: {
      tab,
      ...(stepFilter === null || stepFilter === "" ? {} : { [STEP_ID_FACET]: stepFilter }),
      ...(jobFilter === null || jobFilter === "" ? {} : { [JOB_ID_FACET]: jobFilter }),
    },
  };
  // Which tab is open, and what it is narrowed to (EO-192): the two tabs
  // hold different kinds of thing.
  useViewParameters({ filter });

  const { active } = useProjects();
  // Deleting a pipeline archives it rather than dropping the row, so this
  // is the only place a deleted one remains visible.
  const archivedPipelines = useQuery({
    queryKey: ["pipelines", "archived", active?.id ?? null],
    queryFn: () => ipcQuery("pipelines:list", { projectId: active?.id ?? null, includeArchived: true }),
  });

  const restore = useMutation({
    mutationFn: (input: IpcRequest<"items:setArchived">) => ipcQuery("items:setArchived", input),
    // Settles once the archive has been read again, so a restored row
    // leaves the list rather than offering Restore a second time.
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: itemsKey });
      return queryClient.invalidateQueries({ queryKey: archivedKey });
    },
  });
  // Per row (EO-562): one Restore on its way holds that row's button, not every row's.
  const restoring = useInFlight<string>();
  const [restoreProblem, setRestoreProblem] = useState<string | null>(null);
  const restoreItem = (itemId: string) => {
    setRestoreProblem(null);
    void restoring
      .run(itemId, true, () => restore.mutateAsync({ itemId, archived: false }))
      .catch((error: unknown) => setRestoreProblem(error instanceof Error ? error.message : String(error)));
  };

  // The same predicate the main process applies when asked what this
  // view is showing — one question, asked on both sides.
  const items = (archived.data?.items ?? []).filter((item) => matchesArchiveFilter(item, filter));
  // Named off the rows themselves, so a step or job nothing here has a
  // row for is still said rather than mistaken for an empty archive.
  const narrowedTo = stepFilter === null ? null : (items[0]?.stepName ?? "a step that is no longer here");
  const narrowedToJob = jobFilter === null ? null : (items[0]?.origin?.jobName ?? "a job with nothing in the archive");
  const deletedPipelines = (archivedPipelines.data?.pipelines ?? []).filter((pipeline) => pipeline.archivedAt !== null);

  const header = <ViewHeader icon={<Archive size={15} />} title="Archive" meta={META} />;

  if (archived.isLoading) {
    return (
      <>
        {header}
        <Loading />
      </>
    );
  }
  if (archived.error) {
    return (
      <>
        {header}
        <ErrorLine>
          <ItemText>{archived.error.message}</ItemText>
        </ErrorLine>
      </>
    );
  }

  const widen = () =>
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.delete(STEP_ID_FACET);
      next.delete(JOB_ID_FACET);
      return next;
    });

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <ViewHeader icon={<Archive size={15} />} title="Archive" meta={META}>
        <Tabs
          label="Archive"
          value={tab}
          onChange={setTab}
          tabs={[
            { value: "items", label: vocabulary.items, count: items.length },
            { value: "pipelines", label: "Pipelines", count: deletedPipelines.length },
          ]}
        />
      </ViewHeader>

      {tab === "pipelines" ? (
        deletedPipelines.length === 0 ? (
          <EmptyState title="No pipeline has been deleted.">Deleting one archives it and its work, rather than dropping either.</EmptyState>
        ) : (
          <Card className="px-2 py-2">
            <RowList label="Archived pipelines">
              {deletedPipelines.map((pipeline) => (
                <li key={pipeline.id} className="flex min-h-11 min-w-0 items-center gap-3 px-3 py-2">
                  <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{pipeline.name}</span>
                  <span className="shrink-0 text-[11.5px] text-ink-subtle">deleted {pipeline.archivedAt ? when(pipeline.archivedAt) : "—"}</span>
                </li>
              ))}
            </RowList>
          </Card>
        )
      ) : null}

      {/* Said whenever the list is narrowed, in the tone of somewhere a
          person was sent to fix something rather than of a problem. */}
      {tab === "items" && (narrowedTo !== null || narrowedToJob !== null) ? (
        <Notice
          role="status"
          action={
            <Button size="sm" variant="ghost" onClick={widen}>
              Show the whole archive
            </Button>
          }
        >
          {narrowedToJob === null ? `Showing only what ${narrowedTo} holds` : `Showing only what "${narrowedToJob}" filed`} —{" "}
          {items.length === 1 ? "1 archived item" : `${items.length} archived items`}. Restore{items.length === 1 ? " it" : " them"} to move{" "}
          {items.length === 1 ? "it" : "them"} on the board.
        </Notice>
      ) : null}

      {tab === "items" && restoreProblem !== null ? (
        <ErrorLine>
          <ItemText>{restoreProblem}</ItemText>
        </ErrorLine>
      ) : null}

      {tab === "items" ? (
        items.length === 0 ? (
          narrowedTo !== null ? (
            <EmptyState title="Nothing on that step is in the archive." />
          ) : (
            <EmptyState title="Nothing archived yet.">
              Finished {vocabulary.items.toLowerCase()} move here on their own once they have been done long enough — the delay is in{" "}
              <Link to="/settings?section=archive" className="text-ink-muted underline underline-offset-2 hover:text-ink">
                Settings
              </Link>
              .
            </EmptyState>
          )
        ) : (
          <Card className="px-2 py-2">
            {/* A screenful at a time (EO-565): an archive only grows. */}
            <VirtualRows label={`Archived ${vocabulary.items.toLowerCase()}`} data={items} rowKey={(item) => item.id}>
              {(item) => (
                <div className="flex min-h-11 min-w-0 items-center gap-3 px-3 py-2.5">
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-2 text-[11.5px] text-ink-subtle">
                      <ItemKeyLink itemKey={item.key} itemId={item.id} />
                      {/* The type beside the key, only where the project has more than one pack's word (ARCHITECTURE.md, "What a pack labels"). */}
                      {vocabulary.mixed ? <span>{item.typeLabel}</span> : null}
                      <Chip>{item.stepName}</Chip>
                      {item.repositoryName ? <span className="font-mono">{item.repositoryName}</span> : null}
                    </div>
                    {/* Still a real item with its whole thread, so the title goes somewhere. */}
                    <Link to={`/items/${item.id}`} className="truncate text-[13px] text-ink hover:underline">
                      {item.title}
                    </Link>
                    <span className="text-[11px] text-ink-subtle">last touched {when(item.updatedAt)}</span>
                  </div>
                  <Button
                    size="sm"
                    icon={<ArchiveRestore size={12} />}
                    disabled={restoring.pending.has(item.id)}
                    aria-busy={restoring.pending.has(item.id)}
                    onClick={() => restoreItem(item.id)}
                  >
                    {restoring.pending.has(item.id) ? "Restoring…" : "Restore"}
                  </Button>
                </div>
              )}
            </VirtualRows>
          </Card>
        )
      ) : null}
    </div>
  );
}
