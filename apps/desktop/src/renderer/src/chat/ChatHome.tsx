import { useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Columns3 } from "lucide-react";
import { runStatusKeyOf } from "@eo/core";
import { cn } from "@eo/ui";
import { pipelineIcon } from "../shared/layout/sidebar";
import { useMe, usePipelines, useProjectItems } from "../query/hooks";
import { useProjects } from "../query/useRepositories";
import { Button } from "./kit";
import { DEEP, GroupLabel, useWaitingOnYou } from "./parts";

/** How many rows each list shows before pointing at the full screen. */
const LIMIT = 6;

const DROW = "grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-[9px] gap-y-1 rounded-[10px] bg-canvas px-2.5 py-2 text-[12.5px] hover:bg-canvas-subtle";

/**
 * The home's right column, beside the conversation at `/chat` (ARCHITECTURE.md, "The chat-centric layout"):
 * what is waiting on you, what is working, and what is waiting on
 * somebody else — across every pipeline.
 *
 * Read from what the main process already decided — the inbox's blocking
 * flag, each item's latest run and its assignee — and none of it looks at
 * which pipeline, step or item type a row belongs to beyond printing their
 * names. A report waiting for approval and a message waiting for an
 * answer are the same row, which is how a window holding five unrelated
 * pipelines stays one list long.
 */
export function ChatDrawer() {
  const navigate = useNavigate();
  const { rows } = useWaitingOnYou();
  const { items } = useProjectItems();
  const { active } = useProjects();
  const { pipelines } = usePipelines(active?.id ?? null);
  const { person: me } = useMe();

  const byId = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const pipelineOf = (pipelineId: string | null) => {
    const index = pipelines.findIndex((pipeline) => pipeline.id === pipelineId);
    return index < 0 ? null : { pipeline: pipelines[index]!, Icon: pipelineIcon(pipelines[index]!.icon, index) };
  };

  const waiting = useMemo(() => {
    // Blocking first: an item a run is stopped on outranks a mention that
    // is merely unread.
    return [...rows].sort((a, b) => Number(b.blocking) - Number(a.blocking) || b.createdAt - a.createdAt);
  }, [rows]);
  const working = useMemo(() => items.filter((item) => runStatusKeyOf(item.latestRunStatus) === "running"), [items]);
  const others = useMemo(
    () =>
      items.filter(
        (item) => item.assigneePerson !== null && item.assigneePerson.id !== me?.id && runStatusKeyOf(item.latestRunStatus) !== "running",
      ),
    [items, me],
  );

  return (
    <section aria-label="Overview" className={cn("flex min-h-0 flex-1 flex-col gap-[18px] overflow-y-auto p-4 relative", DEEP)}>
      <div>
        <div className="mb-2">
          <GroupLabel trailing={waiting.length}>Waiting on you</GroupLabel>
        </div>
        {waiting.length === 0 ? <p className="text-[12.5px] text-ink-subtle">Nothing needs you right now.</p> : null}
        <ul className="flex flex-col gap-1.5">
          {waiting.slice(0, LIMIT).map((row) => {
            const item = byId.get(row.itemId);
            const where = pipelineOf(item?.pipelineId ?? null);
            const Icon = where?.Icon;
            return (
              <li key={row.commentId}>
                <Link to={`/items/${row.itemId}`} className={DROW}>
                  {Icon ? <Icon size={14} className="text-ink-subtle" /> : <span className="h-3.5 w-3.5" />}
                  <span className="truncate text-ink">{row.itemTitle}</span>
                  <span className="font-mono text-[11.5px] text-ink-subtle">{row.itemKey}</span>
                  <span className="col-start-2 col-end-4 truncate text-[11.5px] text-ink-subtle">
                    {where ? `${where.pipeline.name} · ` : ""}
                    {item?.stepName ?? row.itemTypeLabel}
                    {row.blocking ? "" : " · mention"}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
        {waiting.length > LIMIT ? (
          <Link to="/inbox" className="mt-1.5 inline-block text-[11.5px] text-ink-muted hover:text-ink hover:underline">
            All {waiting.length} in the inbox
          </Link>
        ) : null}
      </div>

      <div>
        <div className="mb-2">
          <GroupLabel trailing={`${working.length} running`}>Working now</GroupLabel>
        </div>
        {working.length === 0 ? <p className="text-[12.5px] text-ink-subtle">No agent is working.</p> : null}
        <ul className="flex flex-col gap-1.5">
          {working.slice(0, LIMIT).map((item) => (
            <li key={item.id}>
              <Link to={`/items/${item.id}`} className={DROW}>
                {/* Running is state, so it wears the run colour and not the accent. */}
                <span aria-hidden className="h-[7px] w-[7px] animate-pulse rounded-full bg-running motion-reduce:animate-none" />
                <span className="truncate text-ink">
                  {item.stepName} · {item.title}
                </span>
                <span className="font-mono text-[11.5px] text-ink-subtle">{item.key}</span>
              </Link>
            </li>
          ))}
        </ul>
      </div>

      {others.length > 0 ? (
        <div>
          <div className="mb-2">
            <GroupLabel>Waiting on others</GroupLabel>
          </div>
          <ul className="flex flex-col gap-1.5">
            {others.slice(0, LIMIT).map((item) => (
              <li key={item.id}>
                <Link to={`/items/${item.id}`} className={DROW}>
                  <span aria-hidden className="grid h-5 w-5 place-items-center rounded-full bg-canvas-active text-[10px] font-semibold text-ink">
                    {item.assigneePerson!.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="truncate text-ink">
                    {item.assigneePerson!.name} · {item.stepName}
                  </span>
                  <span className="font-mono text-[11.5px] text-ink-subtle">{item.key}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex-1" />
      {pipelines.length > 0 ? (
        <Button icon={<Columns3 size={14} />} onClick={() => void navigate(`/pipelines/${pipelines[0]!.id}`)}>
          Open boards
        </Button>
      ) : null}
    </section>
  );
}
