import { useState } from "react";
import { useDroppable } from "@dnd-kit/core";
import { watchLine, type ChromeVocabulary, type ItemSummary, type ModuleView, type PipelineStepView } from "@eo/core";
import { cn } from "@eo/ui";
import { Button, Select, StepKindChip, stepLane } from "../../kit";
import { ownerOf } from "../../parts";
import { NotFullyTested } from "../../modules/NotFullyTested";
import { BoardCard } from "./BoardCard";
import { descriptionFor } from "../../../shared/pipeline/dashboard";
import { WORK_STATE_FILL, WORK_STATE_WORDS, workLoad, workStateOf, type WorkStep } from "../../../shared/items/workState";

/**
 * A column of the board: one step, who owns it, what it does, what can
 * be believed about it, and the work standing on it.
 *
 * A raised panel on the canvas's darker ground, on a hairline, with the
 * cards raised one step further on it (ARCHITECTURE.md, "Depth and
 * motion"). Its head says the step's kind with the chip the pipeline
 * drawing uses (EO-680), and a step an agent, a person or a script owns
 * is a lane in that kind's colour (EO-685): a 3px cap on the neutral
 * raised surface (EO-694). EO's own columns and the ends stay grey.
 *
 * Under its head, a load strip and a line of counts say how the work on
 * it is going (EO-687): failed, waiting, in review, running, idle — the
 * same states its cards are tinted by. Owner on structure, state on work.
 */

/** Who a human step waits on, as the picker's own vocabulary (EO-323): a person and a group are different promises. */
export type StepOwner = { kind: "person" | "group"; id: string };

/**
 * What every card on the board is told, whichever column it is in.
 *
 * The board memoises it (EO-565), and each card is handed only its own
 * share — a boolean where this holds a set — so a claim or a move on one
 * card leaves every other card's props as they were.
 */
export interface CardHandlers {
  /** Whether the project's work goes by more than one word (EO-309), read once by the board. */
  mixed: boolean;
  queued: ReadonlySet<string>;
  canHandOff: boolean;
  onHandOff: (item: ItemSummary) => void;
  /** The cards with a claim in flight (EO-562): their Claim is disabled and says so. */
  claiming: ReadonlyMap<string, true>;
  /** The card drawn where it was dropped while its move is confirmed and applied (EO-564), or null. */
  moving: string | null;
  /**
   * The card the last confirmed move on this board applied to, or null.
   * Shown in its column however far down it sorts (EO-634), so a card
   * moved into a long column does not land past "Show more" and vanish.
   */
  moved: string | null;
  onClaim: (item: ItemSummary) => void;
  onOpen: (itemId: string) => void;
}

/** "3 tickets", "1 item": a column's count in the project's own word. */
function countLabel(count: number, vocabulary: ChromeVocabulary): string {
  return `${count} ${(count === 1 ? vocabulary.item : vocabulary.items).toLowerCase()}`;
}

/**
 * What is on a column, by work state (EO-687): a 4px strip in segments
 * sized by count, and under it "● 1 failed ● 2 waiting", one entry per
 * state there is. An empty column has one bar in the line colour and no
 * counts. Counts every item on the step, not only the cards shown.
 */
function Load({ items, step }: { items: ItemSummary[]; step: WorkStep | null }) {
  const load = workLoad(items.map((item) => workStateOf(item, step)));
  return (
    <>
      <div aria-hidden data-load-strip className="mt-1.5 flex h-[4px] gap-[2px] overflow-hidden rounded-[3px]">
        {load.length === 0 ? (
          <span data-state="empty" className="h-full flex-1 bg-line" />
        ) : (
          load.map(({ state, count }) => (
            <span
              key={state}
              data-state={state}
              title={`${count} ${WORK_STATE_WORDS[state]}`}
              style={{ flexGrow: count, flexBasis: 0 }}
              className={cn("h-full min-w-[6px] rounded-[2px]", WORK_STATE_FILL[state])}
            />
          ))
        )}
      </div>
      {load.length === 0 ? null : (
        <p aria-label="By state" className="flex flex-wrap gap-x-2.5 gap-y-0.5 text-[11px] tabular-nums text-ink-muted">
          {load.map(({ state, count }) => (
            <span key={state} className="inline-flex items-center gap-[5px]">
              <span aria-hidden className={cn("size-[6px] shrink-0 rounded-full", WORK_STATE_FILL[state])} />
              {count} {WORK_STATE_WORDS[state]}
            </span>
          ))}
        </p>
      )}
    </>
  );
}

/** How many cards a column shows at first, and how many more each "Show more" adds (EO-634). */
export const CARDS_PER_STEP = 4;

/**
 * A column's cards, newest first, a few at a time (EO-634): the first
 * four, then four more for each press of "Show more". A card just moved
 * here is shown wherever it sorts. How far a column is opened is this
 * column's own, and goes when the board does.
 */
function Cards({ items, step, handlers }: { items: ItemSummary[]; step: WorkStep | null; handlers: CardHandlers }) {
  const [limit, setLimit] = useState(CARDS_PER_STEP);
  const shown: ItemSummary[] = [];
  let counted = 0;
  for (const item of items) {
    const pinned = item.id === handlers.moving || item.id === handlers.moved;
    if (pinned || counted < limit) shown.push(item);
    if (!pinned) counted += 1;
  }
  const more = Math.min(CARDS_PER_STEP, items.length - shown.length);
  return (
    <>
      {shown.map((item) => (
        <BoardCard
          key={item.id}
          item={item}
          state={workStateOf(item, step)}
          mixed={handlers.mixed}
          queued={handlers.queued.has(item.id)}
          canHandOff={handlers.canHandOff}
          onHandOff={handlers.onHandOff}
          claiming={handlers.claiming.has(item.id)}
          moving={handlers.moving === item.id}
          onClaim={handlers.onClaim}
          onOpen={handlers.onOpen}
        />
      ))}
      {more > 0 ? (
        <Button variant="ghost" size="sm" className="w-full" onClick={() => setLimit((current) => current + CARDS_PER_STEP)}>
          Show {more} more
        </Button>
      ) : null}
    </>
  );
}

export function StepColumn({
  step,
  module,
  items,
  verifies,
  ownerId,
  people,
  groups,
  onSetOwner,
  handlers,
  vocabulary,
}: {
  step: PipelineStepView;
  /** The module a module step runs (EO-354), read for whether it is fully tested. */
  module: ModuleView | undefined;
  items: ItemSummary[];
  /** What is checked here or who approves here (EO-312), or null where this board says nothing. */
  verifies: string | null;
  /** Who this step waits on, as an id, or "" for nobody in particular. */
  ownerId: string;
  people: readonly { id: string; name: string }[];
  groups: readonly { id: string; name: string }[];
  onSetOwner: (owner: StepOwner | null) => void;
  handlers: CardHandlers;
  /** The project's words, read once by the board (EO-565). */
  vocabulary: ChromeVocabulary;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: step.id });
  const count = countLabel(items.length, vocabulary);
  const summary = step.instructionsSummary ?? descriptionFor(step);
  const lane = stepLane(step);
  return (
    <section
      ref={setNodeRef}
      aria-label={`${step.name} — ${count}`}
      className={cn(
        "flex min-w-0 flex-col gap-2 rounded-[14px] border px-2.5 py-3",
        lane.surface,
        lane.cap,
        isOver && "bg-accent-subtle/40 shadow-[inset_0_0_0_1.5px_var(--color-accent)]",
      )}
    >
      <header className="flex min-w-0 flex-col gap-1 px-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="min-w-0 truncate text-[15px] font-semibold text-ink">{step.name}</h2>
          {items.length > 0 ? (
            <span aria-hidden className="text-[12.5px] tabular-nums text-ink-subtle">
              {items.length}
            </span>
          ) : null}
          {step.isTerminal ? null : <StepKindChip step={step} className="ml-auto" />}
        </div>
        {step.isTerminal ? (
          <span className="text-[11px] text-ink-subtle">end</span>
        ) : (
          // What runs here, as the machine names it: the role, the action, or "you".
          // A step nobody owns is where the engine hands off to you (ARCHITECTURE.md, "A step").
          <span
            className={cn("min-w-0 truncate font-mono text-[11.5px]", lane.ownerInk)}
            {...(step.type === "user" ? { title: "Human-owned — the engine won't act here" } : {})}
          >
            {ownerOf(step).label}
          </span>
        )}
        <NotFullyTested module={module} />
        {summary ? <p className="truncate text-[11.5px] text-ink-subtle">{summary}</p> : null}
        {/* Not truncated: cutting "EO checks: commits, tests ran" short
            would claim less than is true (EO-312, ARCHITECTURE.md, "What 'EO checks' means on a step"). */}
        {verifies === null ? null : <p className="text-[11px] leading-snug text-ink-subtle">{verifies}</p>}
        {/* How often a step that keeps checking looks, and when it gives up (EO-456). */}
        {watchLine(step) === null ? null : <p className="text-[11px] leading-snug text-ink-subtle">{watchLine(step)}</p>}
        {/* Who waits here, changeable from the board (EO-323). Only on a
            human step: nothing waits at an agent step. */}
        {step.type === "user" ? (
          <Select
            aria-label={`Who waits at ${step.name}`}
            className="mt-1"
            value={ownerId}
            onChange={(event) => {
              const id = event.target.value;
              if (id === "") return onSetOwner(null);
              onSetOwner({
                kind: groups.some((group) => group.id === id) ? "group" : "person",
                id,
              });
            }}
          >
            <option value="">Nobody in particular</option>
            {people.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
            {groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </Select>
        ) : null}
        <Load items={items} step={step} />
      </header>

      <div className="flex min-w-0 flex-col gap-2">
        <Cards items={items} step={step} handlers={handlers} />
        {items.length === 0 ? (
          // Drawn, so a drag can see where it may land.
          <p
            aria-hidden
            className={cn(
              "rounded-[10px] border border-dashed px-2 py-5 text-center text-[11.5px]",
              isOver ? "border-accent text-accent-soft" : "border-line text-ink-subtle",
            )}
          >
            {isOver ? "Drop to move here" : "Empty"}
          </p>
        ) : null}
      </div>
    </section>
  );
}

/**
 * A step this pipeline has removed, still finishing work (EO-327, the original design):
 * "Review (v6) · 2 finishing". Cards can be dragged out; nothing can be
 * dropped in, so it registers no drop target, and it offers no owner and
 * says nothing about what is checked.
 */
export function GhostColumn({ label, items, handlers }: { label: string; items: ItemSummary[]; handlers: CardHandlers }) {
  return (
    <section aria-label={label} className="flex min-w-0 flex-col gap-2 rounded-[14px] border border-dashed border-line px-2.5 py-3 opacity-90">
      <header className="flex min-w-0 flex-col gap-1 px-0.5">
        <h2 className="truncate text-[15px] font-semibold text-ink-muted">{label}</h2>
        <p className="text-[11.5px] text-ink-subtle">Removed from the pipeline. These finish here.</p>
        {/* Its step is gone from the pipeline, so nothing here reads as in review. */}
        <Load items={items} step={null} />
      </header>
      <div className="flex min-w-0 flex-col gap-2">
        <Cards items={items} step={null} handlers={handlers} />
      </div>
    </section>
  );
}
