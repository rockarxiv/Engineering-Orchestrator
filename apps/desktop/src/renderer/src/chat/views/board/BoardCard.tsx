import { memo, type ReactNode } from "react";
import { useDraggable } from "@dnd-kit/core";
import { ArrowUp, CircleSlash, Clock, Eye, Forward, GitBranch, Layers } from "lucide-react";
import { NONE_KIND, firstName, versionLabel, type ItemSummary, type WorkspaceBadge } from "@eo/core";
import { cn } from "@eo/ui";
import { useItemAuthority } from "../../../shared/admin/authority";
import { runStatusOf, type RunStatus } from "../../../shared/items/status";
import type { WorkState } from "../../../shared/items/workState";
import { Elapsed } from "../../../shared/items/Elapsed";
import { watchStatusOf } from "../../../shared/items/watchStatus";
import { openDependencyTitle } from "../../../shared/items/openDependencies";
import { useMinuteTick } from "../../../hooks/useMinuteTick";
import { PREVIEW_BANNER } from "../../../shared/items/previewBanner";
import { priorityLabel, showsPriorityBadge } from "../../../shared/pipeline/priority";
import { ReadOnlyFence } from "../../admin/ReadOnlyFence";
import { KeyLink } from "./references";
import { originHover } from "../../../shared/pipeline/dashboard";
import { useMayClaim } from "../../HolderGate";

/**
 * One item on the board, in the chat layout's drawing: a tile raised one
 * step above its column, on a hairline (EO-680), with what it is called, what it is, where its
 * work happens and what is happening to it — the classic card's four
 * lines, at this layout's density.
 */

/** What a drag or the card's button says when an admin is only looking (EO-326, ARCHITECTURE.md, "Identity"). */
const READ_ONLY_MOVE = "Open this item and press “Act as admin” to move it.";
const READ_ONLY_CLAIM = "Open this item and press “Act as admin” to take it.";

const RUN_DOT: Record<RunStatus["tone"], string> = {
  running: "bg-running",
  reviewing: "bg-reviewing",
  paused: "bg-paused",
  warning: "bg-paused",
  danger: "bg-danger",
  success: "bg-success",
  idle: "bg-idle",
};

/**
 * A card's surface in its work state (EO-687): the hover surface mixed
 * 11% toward the state's colour (14% for failed, which has to be seen
 * first), a little more under the pointer, on a hairline mixed 60%
 * toward it. Idle cards keep the plain surface. Written out whole, state
 * by state, so Tailwind finds every class.
 */
const CARD_SURFACE: Record<WorkState, string> = {
  danger:
    "border-[color:color-mix(in_oklab,var(--color-line),var(--color-danger)_60%)] bg-[color:color-mix(in_oklab,var(--color-canvas-hover),var(--color-danger)_14%)] hover:bg-[color:color-mix(in_oklab,var(--color-canvas-hover),var(--color-danger)_20%)]",
  paused:
    "border-[color:color-mix(in_oklab,var(--color-line),var(--color-paused)_60%)] bg-[color:color-mix(in_oklab,var(--color-canvas-hover),var(--color-paused)_11%)] hover:bg-[color:color-mix(in_oklab,var(--color-canvas-hover),var(--color-paused)_17%)]",
  reviewing:
    "border-[color:color-mix(in_oklab,var(--color-line),var(--color-reviewing)_60%)] bg-[color:color-mix(in_oklab,var(--color-canvas-hover),var(--color-reviewing)_11%)] hover:bg-[color:color-mix(in_oklab,var(--color-canvas-hover),var(--color-reviewing)_17%)]",
  running:
    "border-[color:color-mix(in_oklab,var(--color-line),var(--color-running)_60%)] bg-[color:color-mix(in_oklab,var(--color-canvas-hover),var(--color-running)_11%)] hover:bg-[color:color-mix(in_oklab,var(--color-canvas-hover),var(--color-running)_17%)]",
  idle: "border-line bg-canvas-hover hover:bg-canvas-active",
};

/**
 * Memoised (EO-565): every prop is a value or a handler the board keeps
 * stable, so a push that changes one card redraws that card and leaves
 * the rest of the board as it was. A prop added here has to be stable
 * too, or every card redraws on every board render again.
 */
export const BoardCard = memo(function BoardCard({
  item,
  state = "idle",
  mixed,
  queued,
  canHandOff,
  onHandOff,
  claiming = false,
  moving = false,
  onClaim,
  onOpen,
}: {
  item: ItemSummary;
  /** How its work is going (EO-687), worked out by its column, which knows the step it stands on: its tint and its edge. */
  state?: WorkState;
  /** Whether the project's work goes by more than one word, read once by the board rather than by every card (EO-565). */
  mixed: boolean;
  /** This desktop has moved it and the record has not confirmed (EO-324, ARCHITECTURE.md, "The record"): dashed, and says "queued". */
  queued: boolean;
  /** Whether there is another pipeline to send it to at all; false offers nothing. */
  canHandOff: boolean;
  onHandOff: (item: ItemSummary) => void;
  /** A claim on it is in flight (EO-562): Claim is disabled and says "Claiming…". */
  claiming?: boolean;
  /** Drawn in the column it was dropped on while the move is confirmed and applied (EO-564): faded, dashed, and says "moving…". */
  moving?: boolean;
  onClaim: (item: ItemSummary) => void;
  onOpen: (itemId: string) => void;
}) {
  // A card an admin is only looking at does not lift (EO-326, ARCHITECTURE.md, "Identity"): the
  // drag is the same command the item page's Decide buttons send, and it
  // answers to the same catch.
  const { readOnly } = useItemAuthority(item.id);
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: item.id,
    disabled: readOnly,
  });
  return (
    <article
      ref={setNodeRef}
      aria-busy={moving}
      {...(item.origin === null ? {} : { title: originHover(item.origin) })}
      className={cn(
        "relative rounded-[10px] border px-[9px] py-2",
        // Waiting on you is a state, so it is drawn in the paused scale, as the card's tint.
        CARD_SURFACE[state],
        (queued || moving) && "border border-dashed border-line-strong",
        moving && "opacity-70",
        isDragging && "opacity-40",
      )}
    >
      {/* The whole card opens and drags; the key, the parent's key, Claim
          and the hand-off sit above it and answer for themselves. */}
      <button
        type="button"
        aria-label={`Open ${item.key}: ${item.title}`}
        {...attributes}
        {...listeners}
        onClick={() => onOpen(item.id)}
        {...(readOnly ? { title: READ_ONLY_MOVE } : {})}
        className={`absolute inset-0 rounded-[10px] ${readOnly ? "cursor-pointer" : "cursor-grab"} focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus`}
      />
      <div className="pointer-events-none relative z-10">
        {item.needsAttention ? <span aria-label="Waiting on you" className="sr-only" /> : null}
        <ReadOnlyFence readOnly={readOnly}>
          <CardBody
            item={item}
            mixed={mixed}
            queued={queued}
            moving={moving}
            claiming={claiming}
            onClaim={() => onClaim(item)}
            action={
              canHandOff ? (
                <button
                  type="button"
                  aria-label={`Send ${item.key} to another pipeline`}
                  title="Send to another pipeline"
                  onClick={() => onHandOff(item)}
                  className="pointer-events-auto grid h-5 w-5 shrink-0 place-items-center rounded-[6px] text-ink-subtle hover:bg-canvas-active hover:text-ink"
                >
                  <Forward size={12} />
                </button>
              ) : null
            }
          />
        </ReadOnlyFence>
      </div>
    </article>
  );
});

/** The card's lines, shared with the copy that follows the pointer during a drag. */
export function CardBody({
  item,
  mixed,
  action = null,
  onClaim,
  queued = false,
  moving = false,
  claiming = false,
}: {
  item: ItemSummary;
  /** The type is drawn only where the project's work goes by more than one word (EO-309). */
  mixed: boolean;
  action?: ReactNode;
  onClaim?: (() => void) | undefined;
  queued?: boolean;
  moving?: boolean;
  claiming?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-ink-subtle">
        <KeyLink itemKey={item.key} itemId={item.id} className="text-[11.5px]" />
        {mixed ? <span className="truncate">{item.typeLabel}</span> : null}
        <span className="ml-auto flex min-w-0 items-center gap-1.5">
          {item.pipelineVersion === null ? null : (
            <span
              className="shrink-0 rounded-[5px] bg-canvas-active px-1 font-mono text-[10.5px]"
              title={`This item entered on ${versionLabel(item.pipelineVersion)} and finishes on it.`}
            >
              {versionLabel(item.pipelineVersion)}
            </span>
          )}
          {item.repositoryName ? <span className="min-w-0 truncate font-mono">{item.repositoryName}</span> : null}
          {action}
        </span>
      </div>

      <h3 className="text-[13.5px] font-medium leading-snug text-ink">{item.title}</h3>

      {item.preview ? (
        <div role="note" aria-label="Preview" className="rounded-[6px] bg-paused/15 px-1.5 py-0.5 text-[11px] text-paused">
          <span className="block truncate">{PREVIEW_BANNER}</span>
        </div>
      ) : null}

      {item.parentTitle ? (
        <p className="flex min-w-0 items-center gap-1 text-[11px] text-ink-subtle" title={`Part of ${item.parentTitle}`}>
          <Layers size={10} className="shrink-0" aria-hidden />
          {item.parentKey ? <KeyLink itemKey={item.parentKey} itemId={item.parentId} className="shrink-0" /> : null}
          <span className="truncate">{item.parentTitle}</span>
        </p>
      ) : null}

      <WorkspaceLine workspace={item.workspace} />

      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 pt-0.5 text-[11px] text-ink-muted">
        {item.watch == null ? <RunStatusLine status={runStatusOf(item.latestRunStatus)} /> : <WatchStatusLine item={item} />}
        {queued ? (
          <span className="text-ink-subtle" title="This move is waiting to reach your organisation's record.">
            queued
          </span>
        ) : null}
        {moving ? (
          <span className="text-ink-subtle" title="Drawn where you dropped it until the move lands.">
            moving…
          </span>
        ) : null}
        {item.openDependencyCount > 0 ? (
          <span className="tabular-nums text-ink-subtle" title={openDependencyTitle(item)}>
            blocked ×{item.openDependencyCount}
          </span>
        ) : null}
        {/* Not amber (EO-687): amber means only "this lands with a person". */}
        {showsPriorityBadge(item.priority) ? (
          <span className="flex items-center gap-0.5 font-semibold text-ink">
            {item.priority > 0 ? <ArrowUp size={10} className="shrink-0" aria-hidden /> : null}
            {priorityLabel(item.priority)}
          </span>
        ) : null}
        <span className="ml-auto flex min-w-0 items-center gap-2">
          <AssigneeSlot item={item} claiming={claiming} {...(onClaim ? { onClaim } : {})} />
          {/* Time on this step, not since the last edit (EO-570): an
              assignee or workspace change bumps `updatedAt` without
              moving it. */}
          <span className="shrink-0 font-mono text-[10.5px] text-ink-subtle">
            <Elapsed since={item.stepEnteredAt} />
          </span>
        </span>
      </div>
    </div>
  );
}

/** What the item's latest run means: its dot and its word. */
function RunStatusLine({ status }: { status: RunStatus }) {
  return (
    <span className="flex items-center gap-1.5">
      <span aria-hidden className={cn("h-[7px] w-[7px] shrink-0 rounded-full", RUN_DOT[status.tone])} />
      {status.label}
    </span>
  );
}

/**
 * The status line of an item on a step that keeps checking (EO-699): when
 * it checks next and when it last did, instead of the "Done" its last
 * quiet check left — with the full times on hover. A leaf on the shared
 * minute clock, like `Elapsed`, so the countdown moves without redrawing
 * the card; only watching cards subscribe.
 *
 * The second line takes the row's whole width, so it sits under the
 * first and pushes the assignee and the corner time to the line below.
 */
const WatchStatusLine = memo(function WatchStatusLine({ item }: { item: ItemSummary }) {
  useMinuteTick();
  const watch = watchStatusOf(item, Date.now());
  if (watch === null) return <RunStatusLine status={runStatusOf(item.latestRunStatus)} />;
  return (
    <>
      <span className="flex min-w-0 items-center gap-1.5 whitespace-nowrap" title={watch.title}>
        {watch.kind === "waiting" ? (
          <Clock size={11} className="shrink-0 text-ink-subtle" aria-hidden />
        ) : (
          <span aria-hidden className={cn("h-[7px] w-[7px] shrink-0 rounded-full", watch.kind === "checking" ? "bg-running" : "bg-paused")} />
        )}
        <span className="truncate">{watch.label}</span>
      </span>
      <span className="w-full truncate text-ink-subtle" title={watch.detail}>
        {watch.detail}
      </span>
    </>
  );
});

/** The two letters a person's name starts with, on a small disc. */
function Initials({ name }: { name: string }) {
  const letters = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]!.toUpperCase())
    .join("");
  return (
    <span aria-hidden className="grid h-4 w-4 shrink-0 place-items-center rounded-full bg-canvas-active text-[8.5px] font-semibold text-ink-muted">
      {letters}
    </span>
  );
}

/**
 * Who has the card (ARCHITECTURE.md, "The board", EO-305): a person's face and first name, a
 * Claim where a human step waits and nobody has taken it, or the agent
 * that ran — "Unassigned" before anything has. The main process decides
 * which (`assigneePerson`, `claimable`), so solo mode draws no Claim.
 */
function AssigneeSlot({ item, onClaim, claiming }: { item: ItemSummary; onClaim?: (() => void) | undefined; claiming: boolean }) {
  const { readOnly } = useItemAuthority(item.id);
  // Only to somebody the step would let claim it (EO-368): a step that
  // waits on a group takes claims from its members alone.
  const mayClaim = useMayClaim(item.id, item.claimable && onClaim !== undefined);
  if (item.assigneePerson) {
    return (
      <span className="flex min-w-0 items-center gap-1" title={`${item.assigneePerson.name} has this`}>
        <Initials name={item.assigneePerson.name} />
        <span className="truncate text-ink-subtle">{firstName(item.assigneePerson.name)}</span>
      </span>
    );
  }
  if (item.claimable && onClaim && mayClaim) {
    return (
      <button
        type="button"
        aria-label={claiming ? `Claiming ${item.key}` : `Claim ${item.key}`}
        disabled={readOnly || claiming}
        aria-busy={claiming}
        {...(readOnly ? { title: READ_ONLY_CLAIM } : {})}
        onClick={(event) => {
          event.stopPropagation();
          if (claiming) return;
          onClaim();
        }}
        className="pointer-events-auto shrink-0 rounded-[6px] px-1.5 py-0.5 text-[11px] font-medium text-accent-soft hover:bg-canvas-active disabled:text-ink-subtle disabled:hover:bg-transparent"
      >
        {claiming ? "Claiming…" : "Claim"}
      </button>
    );
  }
  return <span className="truncate text-ink-subtle">{item.assigneeName ?? "Unassigned"}</span>;
}

/**
 * Where the work happens (ARCHITECTURE.md, "The board", EO-296): the branch for a step that
 * works on one, the base branch behind an eye for one that only reads,
 * "no disk" for work with no workspace — and nothing for a branch not
 * cut yet, rather than a name that does not exist.
 */
function WorkspaceLine({ workspace }: { workspace: WorkspaceBadge }) {
  if (workspace.kind === NONE_KIND) {
    return (
      <p className="flex items-center gap-1 text-[11px] text-ink-subtle" title="This step works through its tools, not on a disk">
        <CircleSlash size={10} className="shrink-0" aria-hidden />
        no disk
      </p>
    );
  }
  if (workspace.label === null) return null;
  if (workspace.mode === "read") {
    return (
      <p className="flex min-w-0 items-center gap-1 font-mono text-[11px] text-ink-subtle" title="reads the repository, changes nothing">
        <Eye size={10} className="shrink-0" aria-hidden />
        <span className="truncate">{workspace.label}</span>
      </p>
    );
  }
  return (
    // Ink, not the review violet (EO-687): a branch name is machine text, and violet means only "in review".
    <p className="flex min-w-0 items-center gap-1 font-mono text-[11px] text-ink-subtle">
      <GitBranch size={10} className="shrink-0" aria-hidden />
      <span className="truncate">{workspace.label}</span>
    </p>
  );
}
