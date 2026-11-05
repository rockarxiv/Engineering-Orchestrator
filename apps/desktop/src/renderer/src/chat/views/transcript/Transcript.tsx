import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown } from "lucide-react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { liveMessageOf, type IpcRequest } from "@eo/core";
import { cn } from "@eo/ui";
import { useNow } from "../../../hooks/useNow";
import { ipcQuery } from "../../../query/client";
import { agentsKey, itemsKey } from "../../../query/hooks";
import { groupTranscriptEvents } from "../../../shared/transcript/activity";
import { groupElapsedMs, groupModelTurns, groupRatio, groupSum, isRunActive, liveRunOf, type RunGroup } from "../../../shared/transcript/grouping";
import { useTranscript, type TranscriptEventView } from "../../../shared/transcript/useTranscript";
import { useLiveDrafts } from "../../../shared/assist/liveDeltas";
import { Button, Chip, Facts, GroupLabel, Notice, type Tone } from "../../kit";
import { RefText } from "../items/ItemReference";
import { RunComposer } from "../item/RunComposer";
import { TranscriptActivity } from "./TranscriptActivity";
import { TranscriptEvent } from "./TranscriptEvent";
import { cachedShare, compactTokens, formatDuration, turnLabel } from "../../../shared/transcript/transcript";

/** A run's status, in the state colours: working, waiting on somebody, failed, or still. */
export function runTone(status: string): Exclude<Tone, "accent"> {
  switch (status) {
    case "running":
    case "queued":
      return "running";
    case "awaiting_input":
      return "paused";
    case "failed":
    case "orphaned":
      return "danger";
    default:
      return "neutral";
  }
}

export function spokenStatus(status: string): string {
  return status.replace(/_/g, " ");
}

/**
 * What a run is and what it has spent: its action, where it stands, the
 * attempt, who ran it, the working clock (ticking while it is live, and
 * summed over turns so a question's wait is not counted as thinking),
 * tokens with the cached share and model turns, cost only when known
 * (A-04), and the engine's verdict — and Cancel while it is working.
 */
export function RunHeader({ group, onCancel, cancelling }: { group: RunGroup; onCancel?: () => void; cancelling?: boolean }) {
  const { latest } = group;
  const now = useNow(isRunActive(latest.status));
  const tokensIn = groupSum(group, (run) => run.tokensIn);
  const tokensOut = groupSum(group, (run) => run.tokensOut);
  const modelTurns = groupModelTurns(group);
  const costCents = groupSum(group, (run) => run.costCents);
  const cache = groupRatio(group, (run) => run.cacheReadTokens, (run) => run.tokensIn);
  const cached = cachedShare(cache.whole, cache.part);
  const turns = turnLabel(group);

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[12px] text-ink-subtle">
      <span className="text-[13px] font-medium text-ink">{latest.actionName}</span>
      <Chip tone={runTone(latest.status)}>{spokenStatus(latest.status)}</Chip>
      <span className="font-mono text-[11px]">attempt {latest.attempt}</span>
      {turns ? <span>{turns}</span> : null}
      <span>{latest.agentName}</span>
      <span className="font-mono text-[11px] tabular-nums">{formatDuration(groupElapsedMs(group, now))}</span>
      {tokensIn !== null ? (
        <span className="font-mono text-[11px] tabular-nums">
          {compactTokens(tokensIn)} in / {compactTokens(tokensOut ?? 0)} out{cached ? ` · ${cached}` : ""}
          {modelTurns !== null && modelTurns > 0 ? ` · ${modelTurns} model turns` : ""}
        </span>
      ) : null}
      {costCents !== null ? <span className="font-mono text-[11px] tabular-nums">{(costCents / 100).toFixed(2)} USD</span> : null}
      {latest.verificationOk !== null ? (
        <Chip tone={latest.verificationOk ? "running" : "danger"}>{latest.verificationOk ? "verified" : "verification failed"}</Chip>
      ) : null}
      {isRunActive(latest.status) && onCancel ? (
        <Button size="sm" variant="danger" className="ml-auto" disabled={cancelling} onClick={onCancel}>
          Cancel
        </Button>
      ) : null}
    </div>
  );
}

/**
 * Why a run stopped, where the run is (EO-77). The tone follows the
 * status: a parked run is a question EO is asking, a failure is one, and
 * a succeeded run's note is an aside.
 */
export function RunError({ status, error }: { status: string; error: string }) {
  const tone = status === "failed" || status === "orphaned" ? "danger" : status === "awaiting_input" ? "paused" : "info";
  return (
    <Notice tone={tone} role="status">
      <span data-tone={tone} className="whitespace-pre-wrap break-words">
        <RefText>{error}</RefText>
      </span>
    </Notice>
  );
}

/**
 * A run's events, drawn: what the agent said down the spine, what it did
 * folded behind one line (`activity.ts`).
 *
 * Virtualised, and following the tail only while the reader is already
 * at the bottom — scrolling up to read something and being yanked back by
 * the next event is the worst thing a log can do.
 *
 * Its own component because the debug window (EO-392) draws the same log
 * for a run it pages itself, leaving rows out; a second rendering there
 * would be a second opinion about what a transcript looks like. Takes the
 * events rather than the runs for that reason.
 */
export function TranscriptLog({ events, className }: { events: readonly TranscriptEventView[]; className?: string }) {
  const virtuoso = useRef<VirtuosoHandle>(null);
  const [atBottom, setAtBottom] = useState(true);
  const items = useMemo(() => groupTranscriptEvents(events), [events]);

  // Which folded blocks are open, held here rather than in the rows: the
  // list is virtualised, so a row that scrolls out of view unmounts and
  // would lose its own state.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = useCallback((key: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, []);

  // Appending to an already-folded trailing block grows one row rather
  // than adding one, which Virtuoso cannot see — so nudge it.
  const previous = useRef({ events: 0, items: 0 });
  useEffect(() => {
    const grewInPlace = events.length !== previous.current.events && items.length === previous.current.items;
    previous.current = { events: events.length, items: items.length };
    if (grewInPlace && atBottom && items.length > 0) virtuoso.current?.scrollToIndex({ index: items.length - 1, align: "end" });
  }, [events.length, items.length, atBottom]);

  return (
    <div className={cn("relative min-w-0 flex-1", className)}>
      <Virtuoso
        ref={virtuoso}
        data={items}
        className="h-full"
        followOutput={atBottom ? "auto" : false}
        atBottomStateChange={setAtBottom}
        computeItemKey={(_index, item) => item.key}
        itemContent={(_index, item) =>
          item.kind === "activity" ? (
            <TranscriptActivity item={item} expanded={expanded.has(item.key)} onToggle={() => toggle(item.key)} />
          ) : (
            <TranscriptEvent event={item.event} />
          )
        }
      />
      {!atBottom && items.length > 0 ? (
        <Button
          size="sm"
          icon={<ArrowDown size={12} />}
          className={cn("absolute bottom-2 left-1/2 -translate-x-1/2 shadow-panel")}
          onClick={() => virtuoso.current?.scrollToIndex({ index: items.length - 1, behavior: "smooth" })}
        >
          Jump to latest
        </Button>
      ) : null}
    </div>
  );
}

/**
 * One conversation's transcript: what the agent said as the spine, what
 * it did folded behind one line (`activity.ts`), live as the run goes.
 *
 * Virtualised, and following the tail only while the reader is already
 * at the bottom — scrolling up to read something and being yanked back by
 * the next event is the worst thing a log can do. While the run is
 * working there is a box to say something to it (EO-176) beside Cancel:
 * saying something is not throwing the turn away.
 */
export function Transcript({ group, itemId }: { group: RunGroup; itemId?: string }) {
  const queryClient = useQueryClient();
  const runIds = useMemo(() => group.runs.map((run) => run.id), [group]);
  const { events, loading, error } = useTranscript(runIds);

  // Only the newest turn can be in flight.
  const cancel = useMutation({
    mutationFn: () => ipcQuery("runs:cancel", { runId: group.latest.id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: itemsKey }),
  });

  const live = liveRunOf(group.latest);
  const agents = useQuery({ queryKey: agentsKey, queryFn: () => ipcQuery("agents:list", undefined) });
  const mentionables = useMemo(
    () => ["user", ...(agents.data?.agents ?? []).filter((agent) => agent.archivedAt === null).map((agent) => agent.role)],
    [agents.data],
  );
  const say = useMutation({
    mutationFn: (input: IpcRequest<"comments:post">) => ipcQuery("comments:post", input),
    onSuccess: () => {
      // A message is a comment on the item, so its thread changed too.
      void queryClient.invalidateQueries({ queryKey: ["item", itemId] });
      void queryClient.invalidateQueries({ queryKey: itemsKey });
    },
  });

  return (
    <section aria-label="Transcript" className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 rounded-[14px] bg-canvas px-[18px] py-4">
      <RunHeader group={group} onCancel={() => cancel.mutate()} cancelling={cancel.isPending} />
      {group.latest.error ? <RunError status={group.latest.status} error={group.latest.error} /> : null}
      {error ? (
        <p role="alert" className="text-[12.5px] text-danger">
          <RefText>{error.message}</RefText>
        </p>
      ) : null}
      {loading && events.length === 0 ? <p className="text-[12.5px] text-ink-subtle">Loading transcript…</p> : null}
      {!loading && events.length === 0 ? <p className="text-[12.5px] text-ink-subtle">No events recorded for this run.</p> : null}

      <TranscriptLog events={events} className="min-h-[14rem]" />

      {isRunActive(group.latest.status) && itemId ? <LiveOutput runId={group.latest.id} itemId={itemId} storedEvents={events.length} /> : null}

      {/* Only while something runs, and only with an item to post on: a
          finished run has a thread to reply in, on the item. */}
      {live && itemId ? (
        <RunComposer
          live={live}
          mentionables={mentionables}
          busy={say.isPending}
          submitLabel="Send"
          placeholder="Say something to the agent working on this…"
          onSubmit={async (body, mentions, attachmentIds, delivery) => {
            const result = await say.mutateAsync({
              itemId,
              body,
              mentions,
              attachmentIds,
              pinned: false,
              parentId: null,
              ...(delivery === undefined ? {} : { delivery }),
            });
            return result.delivery;
          }}
        />
      ) : null}
    </section>
  );
}

/** How much of what is being written the transcript shows at the foot: its end, which is what is new. */
const LIVE_TAIL_CHARS = 600;

/**
 * What the agent is writing right now, below what it has already done —
 * the words of a step's run as they are written, as the conversation
 * draws them.
 *
 * The same drafts a conversation draws (`useLiveDrafts`), read off the
 * run's live turn (`runs:live`). Re-read whenever the transcript gains an
 * event, because that is when a draft has become a stored block and must
 * stop being drawn twice. A structured answer being written is not drawn:
 * its words are a result's fields, and the result is shown when it lands.
 */
function LiveOutput({ runId, itemId, storedEvents }: { runId: string; itemId: string; storedEvents: number }) {
  const queryClient = useQueryClient();
  const key = useMemo(() => ["runs:live", runId] as const, [runId]);
  const live = useQuery({ queryKey: key, queryFn: () => ipcQuery("runs:live", { runId }) });
  const reread = useCallback(() => void queryClient.invalidateQueries({ queryKey: key }), [queryClient, key]);
  // Not on mount — the query has just been read — only when an event
  // arrives after it.
  const firstCount = useRef(storedEvents);
  useEffect(() => {
    if (storedEvents !== firstCount.current) reread();
  }, [storedEvents, reread]);
  const drafts = useLiveDrafts(live.data?.turn ?? null, itemId, reread);
  const writing = drafts
    .filter((draft) => draft.stream === "text")
    .map((draft) => liveMessageOf([draft.text]))
    .filter((text) => text.trim() !== "")
    .at(-1);
  if (!writing) return null;
  // The newest words, in a box that does not grow past a few lines: the
  // log above is what scrolls, and a long paragraph being written must
  // not push it off the view.
  const tail = writing.length > LIVE_TAIL_CHARS ? `…${writing.slice(-LIVE_TAIL_CHARS)}` : writing;
  return (
    <article aria-label="Live agent output" className="max-h-32 shrink-0 overflow-hidden whitespace-pre-wrap break-words border-l-2 border-line pl-3 text-[13px] leading-relaxed text-ink">
      {tail}
    </article>
  );
}

/**
 * What else there is to know about a run: where it ran and when, the
 * files it changed (read off the log rather than fetched — the same
 * events are already streaming past), the engine's verdict rather than
 * the agent's claim (ARCHITECTURE.md, "Verification, review and the pull request"), and every
 * provider session the conversation
 * spans — the visible face of resume.
 */
export function RunDetails({ group }: { group: RunGroup }) {
  const run = group.latest;
  const { events } = useTranscript(group.runs.map((turn) => turn.id));
  const changed = useMemo(() => {
    const paths = new Set<string>();
    for (const event of events) {
      if (event.type !== "file_edit") continue;
      const payload = event.payload as { path?: unknown } | null;
      if (payload && typeof payload.path === "string") paths.add(payload.path);
    }
    return [...paths];
  }, [events]);
  const sessions = group.runs.filter((turn) => turn.threadId);

  return (
    <aside aria-label="Run details" className="flex min-w-0 flex-col gap-4 rounded-[14px] bg-canvas px-[18px] py-4">
      <Facts
        items={[
          { term: "Step", value: run.actionName },
          { term: "Agent", value: run.agentName },
          { term: "Status", value: spokenStatus(run.status) },
          { term: "Attempt", value: run.attempt },
          ...(run.threadId ? [{ term: "Session", value: <span className="break-all font-mono text-[11.5px]">{run.threadId}</span> }] : []),
          ...(run.startedAt ? [{ term: "Started", value: new Date(run.startedAt).toLocaleTimeString() }] : []),
        ]}
      />
      <section aria-label={`Changes (${changed.length})`} className="flex min-w-0 flex-col gap-1.5">
        <GroupLabel>Changes ({changed.length})</GroupLabel>
        {changed.length === 0 ? (
          <p className="text-[12.5px] text-ink-subtle">Nothing edited yet.</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {changed.map((path) => (
              <li key={path} className="truncate font-mono text-[11.5px] text-ink-muted" title={path}>
                {path}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-label="Tests" className="flex min-w-0 flex-col gap-1.5">
        <GroupLabel>Tests</GroupLabel>
        {run.verificationOk === null ? (
          <p className="text-[12.5px] text-ink-subtle">Not verified.</p>
        ) : (
          <span>
            <Chip tone={run.verificationOk ? "running" : "danger"}>{run.verificationOk ? "Checks passed" : "Checks failed"}</Chip>
          </span>
        )}
      </section>
      <section aria-label="Sessions" className="flex min-w-0 flex-col gap-1.5">
        <GroupLabel>Sessions</GroupLabel>
        <ul className="flex flex-col gap-0.5">
          {sessions.map((turn) => (
            <li key={turn.id} className="truncate font-mono text-[11.5px] text-ink-muted" title={turn.threadId ?? ""}>
              {turn.threadId}
            </li>
          ))}
          {sessions.length === 0 ? <li className="text-[12.5px] text-ink-subtle">No session yet.</li> : null}
        </ul>
      </section>
    </aside>
  );
}
