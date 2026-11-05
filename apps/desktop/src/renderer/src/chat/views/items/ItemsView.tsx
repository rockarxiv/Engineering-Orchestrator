import { useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowDown, ArrowUp, Download, Layers, ListChecks, RotateCcw, Sparkles } from "lucide-react";
import { containerLabel, NO_VALUE_FACET, sortItems, type ItemSortKey, type ItemSummary } from "@eo/core";
import { cn } from "@eo/ui";
import { itemViewFilter, matchesFilters } from "../../../shared/items/itemList";
import { RUN_STATUSES, runStatusOf } from "../../../shared/items/status";
import { Elapsed } from "../../../shared/items/Elapsed";
import { priorityLabel, priorityTone, showsPriorityBadge } from "../../../shared/pipeline/priority";
import { useChromeVocabulary, usePipelines, useProjectItems, useRegistry } from "../../../query/hooks";
import { useFeatureJiraProject, useProjects } from "../../../query/useRepositories";
import { useViewParameters } from "../../../shared/view/ViewPublisher";
import { PickFromJira } from "../../dialogs/PickFromJira";
import {
  Button,
  Card,
  Chip,
  EmptyState,
  ErrorLine,
  IconButton,
  Loading,
  Row,
  VirtualRows,
  SearchInput,
  Select,
  StatusDot,
  ViewHeader,
  type Tone,
} from "../../kit";
import { RefText } from "./ItemReference";
import { useAskAssistant } from "../../askAssistant";

/**
 * `/items`: every item on the project, across pipelines (the classic
 * `ItemList`, drawn in the chat layout).
 *
 * The board shows one pipeline's columns; this answers the other
 * question — what work exists here, and where has it got to — including
 * the containers, which are on no pipeline at all (ARCHITECTURE.md, "One work entity").
 *
 * The filter is the classic screen's to the letter, because it is what
 * the assistant is told the person can see (EO-192): the same facets,
 * published through the same `itemViewFilter`, matched by the same
 * predicate the main process asks. Only the drawing differs: rows rather
 * than a nine-column table, so it reads beside the conversation, and a
 * sort picker where the table had clickable headings.
 *
 * Read-only, as the classic list is: moving an item is a transition, and
 * a transition carries the board's confirmation and comment.
 */

interface Filters {
  type: string;
  parent: string;
  pipeline: string;
  step: string;
  repository: string;
  status: string;
  attention: boolean;
}

const NO_FILTERS: Filters = { type: "all", parent: "all", pipeline: "all", step: "all", repository: "all", status: "all", attention: false };

/** Every ordering the classic table's headings offered, in their order. */
const SORTS: { key: ItemSortKey; label: string }[] = [
  { key: "key", label: "Key" },
  { key: "title", label: "Title" },
  { key: "type", label: "Type" },
  { key: "step", label: "Step" },
  { key: "pipeline", label: "Pipeline" },
  { key: "repository", label: "Repository" },
  { key: "assignee", label: "Assignee" },
  { key: "status", label: "Status" },
  { key: "updated", label: "Updated" },
];

/** Time reads newest-first and everything else reads A–Z: what choosing an ordering once means. */
function naturalDirection(key: ItemSortKey): "asc" | "desc" {
  return key === "updated" || key === "priority" ? "desc" : "asc";
}

const DOT: Record<string, Exclude<Tone, "accent">> = { running: "running", paused: "paused", failed: "danger", done: "neutral", idle: "neutral" };

export function ItemsView() {
  const navigate = useNavigate();
  const askAssistant = useAskAssistant();
  const { items, isLoading, error } = useProjectItems();
  const { active } = useProjects();
  const { pipelines } = usePipelines(active?.id ?? null);
  const vocabulary = useChromeVocabulary();
  const { registry } = useRegistry();
  const container = useMemo(() => containerLabel(registry), [registry]);
  const jira = useFeatureJiraProject();
  const canImport = Boolean(jira?.jira.credentialsConfigured && jira.jira.projectKey);

  const [query, setQuery] = useState("");
  const [picking, setPicking] = useState(false);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [sort, setSort] = useState<{ key: ItemSortKey; direction: "asc" | "desc" }>({ key: "updated", direction: "desc" });

  const pipelineName = useMemo(() => {
    const names = new Map(pipelines.map((pipeline) => [pipeline.id, pipeline.name]));
    return (id: string | null) => (id === null ? "—" : (names.get(id) ?? "Unknown pipeline"));
  }, [pipelines]);

  // The options come from the items themselves: a filter offering a
  // repository with nothing in it is a filter that returns nothing.
  const options = useMemo(() => {
    const types = new Set<string>();
    const parents = new Map<string, string>();
    const steps = new Set<string>();
    const repositories = new Map<string, string>();
    const used = new Set<string | null>();
    let parentless = false;
    let repositoryless = false;
    for (const item of items) {
      types.add(item.type);
      if (item.parentId === null) parentless = true;
      else parents.set(item.parentId, item.parentTitle ?? item.parentKey ?? item.parentId);
      if (item.stepId !== null) steps.add(item.stepName);
      if (item.repositoryId === null) repositoryless = true;
      else repositories.set(item.repositoryId, item.repositoryName ?? item.repositoryId);
      used.add(item.pipelineId);
    }
    return {
      types: [...types].sort(),
      parents: [...parents].sort((a, b) => a[1].localeCompare(b[1])),
      parentless,
      steps: [...steps].sort(),
      repositories: [...repositories].sort((a, b) => a[1].localeCompare(b[1])),
      repositoryless,
      pipelines: pipelines.filter((pipeline) => used.has(pipeline.id)),
      unpipelined: used.has(null),
    };
  }, [items, pipelines]);

  const needle = query.trim().toLowerCase();
  const visible = useMemo(
    () => sortItems(items.filter((item) => matchesFilters(item, filters, needle)), sort.key, sort.direction, pipelineName),
    [items, filters, needle, sort, pipelineName],
  );

  // What this view is showing, for the assistant (EO-192): the filter and
  // the ordering, exactly as the classic list publishes them.
  useViewParameters({ filter: itemViewFilter(filters, query), sort: `${sort.key}:${sort.direction}` });

  const filtered = JSON.stringify(filters) !== JSON.stringify(NO_FILTERS) || needle !== "";
  const set = (patch: Partial<Filters>) => setFilters((current) => ({ ...current, ...patch }));

  return (
    <div className="flex min-w-0 flex-col">
      <ViewHeader
        icon={<ListChecks size={15} />}
        title={vocabulary.items}
        meta={active?.name ?? "No project"}
        actions={
          <>
            {canImport ? (
              <Button size="sm" variant="ghost" icon={<Download size={13} />} onClick={() => setPicking(true)}>
                Import from Jira
              </Button>
            ) : null}
            <Button size="sm" variant="primary" icon={<Sparkles size={13} />} title="Talk it through with the assistant" onClick={() => (askAssistant ? askAssistant() : void navigate("/chat"))}>
              Plan
            </Button>
          </>
        }
      >
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <SearchInput label="Search" placeholder={`Search ${vocabulary.items.toLowerCase()}`} value={query} onChange={setQuery} className="min-w-[12rem] flex-1" />
          <Chip>{visible.length === items.length ? `${items.length}` : `${visible.length} of ${items.length}`}</Chip>
        </div>
        <div className="grid min-w-0 grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-2">
          <Filter label="Type" value={filters.type} onChange={(type) => set({ type })}>
            {options.types.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </Filter>
          {/* ARCHITECTURE.md, "One work entity": a container is a tag on the work it owns. The facet is
              `parent` (KAN-146); the label is the container type's own. */}
          <Filter label={container} value={filters.parent} onChange={(parent) => set({ parent })}>
            {options.parents.map(([id, title]) => (
              <option key={id} value={id}>
                {title}
              </option>
            ))}
            {options.parentless ? <option value={NO_VALUE_FACET}>No {container.toLowerCase()}</option> : null}
          </Filter>
          <Filter label="Pipeline" value={filters.pipeline} onChange={(pipeline) => set({ pipeline })}>
            {options.pipelines.map((pipeline) => (
              <option key={pipeline.id} value={pipeline.id}>
                {pipeline.name}
              </option>
            ))}
            {options.unpipelined ? <option value={NO_VALUE_FACET}>Not on a pipeline</option> : null}
          </Filter>
          <Filter label="Step" value={filters.step} onChange={(step) => set({ step })}>
            {options.steps.map((step) => (
              <option key={step} value={step}>
                {step}
              </option>
            ))}
          </Filter>
          <Filter label="Repository" value={filters.repository} onChange={(repository) => set({ repository })}>
            {options.repositories.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
            {options.repositoryless ? <option value={NO_VALUE_FACET}>No repository</option> : null}
          </Filter>
          {/* Where the work is (Step) and whether anything is happening to
              it (Status) are different questions; both are offered. */}
          <Filter label="Status" value={filters.status} onChange={(status) => set({ status })}>
            {RUN_STATUSES.map((status) => (
              <option key={status.key} value={status.key}>
                {status.label}
              </option>
            ))}
          </Filter>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Button size="sm" variant={filters.attention ? "primary" : "secondary"} aria-pressed={filters.attention} onClick={() => set({ attention: !filters.attention })}>
            Waiting on you
          </Button>
          {filtered ? (
            <Button size="sm" variant="ghost" icon={<RotateCcw size={12} />} onClick={() => setFilters(NO_FILTERS)}>
              Clear filters
            </Button>
          ) : null}
          <span className="flex-1" />
          <span className="flex items-center gap-1">
            <Select
              aria-label="Sort by"
              value={sort.key}
              onChange={(event) => {
                const key = event.target.value as ItemSortKey;
                setSort({ key, direction: naturalDirection(key) });
              }}
              className="w-[9rem]"
            >
              {SORTS.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </Select>
            <IconButton
              label={sort.direction === "asc" ? "Ascending — reverse the order" : "Descending — reverse the order"}
              icon={sort.direction === "asc" ? <ArrowUp size={14} /> : <ArrowDown size={14} />}
              onClick={() => setSort((current) => ({ ...current, direction: current.direction === "asc" ? "desc" : "asc" }))}
            />
          </span>
        </div>
      </ViewHeader>

      <PickFromJira open={picking} onOpenChange={setPicking} onImported={(itemId) => void navigate(`/items/${itemId}`)} />

      {isLoading ? (
        <Loading />
      ) : error ? (
        <ErrorLine>
          <RefText>{error.message}</RefText>
        </ErrorLine>
      ) : items.length === 0 ? (
        <EmptyState title={`No ${vocabulary.items.toLowerCase()} on this project yet.`}>
          Work enters through the conversation — describe {/^[aeiou]/i.test(container) ? "an" : "a"} {container.toLowerCase()} to the assistant and approve
          the work it proposes.
        </EmptyState>
      ) : visible.length === 0 ? (
        <EmptyState title="Nothing matches these filters." />
      ) : (
        <Card className="px-1.5 py-1.5">
          {/* A screenful at a time (EO-565): a project can hold thousands. */}
          <VirtualRows label={`Every ${vocabulary.item.toLowerCase()} on ${active?.name ?? "this project"}`} data={visible} rowKey={(item) => item.id}>
            {(item) => <ItemRow item={item} pipelineName={pipelineName(item.pipelineId)} mixed={vocabulary.mixed} />}
          </VirtualRows>
        </Card>
      )}
    </div>
  );
}

/** One labelled select with "All" first. */
function Filter({ label, value, onChange, children }: { label: string; value: string; onChange: (value: string) => void; children: ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-ink-subtle">{label}</span>
      <Select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="all">All</option>
        {children}
      </Select>
    </label>
  );
}

const PRIORITY_TONE: Record<ReturnType<typeof priorityTone>, Tone> = { neutral: "neutral", warning: "paused", danger: "danger" };

function ItemRow({ item, pipelineName, mixed }: { item: ItemSummary; pipelineName: string; mixed: boolean }) {
  const status = runStatusOf(item.latestRunStatus);
  return (
    <Row
      to={`/items/${item.id}`}
      leading={<StatusDot tone={DOT[status.key] ?? "neutral"} label={status.label} />}
      title={
        <span className="flex min-w-0 items-baseline gap-2">
          <span data-testid="item-key" className="flex shrink-0 items-baseline gap-1.5">
            <span className="font-mono text-[11.5px] text-ink-subtle">{item.key}</span>
            {/* Beside the key, where the design puts it, on a project whose
                work goes by more than one name. */}
            {mixed ? <span className="text-[11px] text-ink-subtle">{item.typeLabel}</span> : null}
          </span>
          <span className="truncate">{item.title}</span>
        </span>
      }
      meta={
        <span className="flex min-w-0 flex-wrap items-center gap-x-2">
          <span>{item.stepName}</span>
          <span aria-hidden>·</span>
          <span>{pipelineName}</span>
          <span aria-hidden>·</span>
          <span>{item.type}</span>
          {item.repositoryName ? (
            <>
              <span aria-hidden>·</span>
              <span>{item.repositoryName}</span>
            </>
          ) : null}
          <span aria-hidden>·</span>
          <span>{item.assigneeName ?? "Unassigned"}</span>
          <span aria-hidden>·</span>
          <span>{status.label}</span>
          {item.parentTitle ? (
            <span title={`Part of ${item.parentTitle}`} className="inline-flex min-w-0 items-center gap-1">
              <Layers size={10} className="shrink-0" />
              <span className="truncate">{item.parentTitle}</span>
            </span>
          ) : null}
        </span>
      }
      trailing={
        <>
          {item.openDependencyCount > 0 ? (
            <span className="text-[11px] text-ink-subtle" title={`Blocked by ${item.openDependencyCount} unfinished dependency(ies)`}>
              blocked ×{item.openDependencyCount}
            </span>
          ) : null}
          {showsPriorityBadge(item.priority) ? <Chip tone={PRIORITY_TONE[priorityTone(item.priority)]}>{priorityLabel(item.priority)}</Chip> : null}
          {/* Derived from an open human mention, never stored (invariant 6). */}
          {item.needsAttention ? (
            <Chip tone="paused" className={cn("px-1.5")}>
              <span aria-hidden>!</span>
              <span className="sr-only">Waiting on you</span>
            </Chip>
          ) : null}
          <span className="w-8 text-right text-[11px] tabular-nums text-ink-subtle">
            <Elapsed since={item.updatedAt} />
          </span>
        </>
      }
    />
  );
}
