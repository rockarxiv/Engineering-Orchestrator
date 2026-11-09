import type { ReactNode } from "react";
import { useDroppable } from "@dnd-kit/core";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ArrowRight, Hand, Pause, Play, UserRound, X } from "lucide-react";
import type { ItemSummary } from "@eo/core";
import { cn } from "@eo/ui";
import { HAND_OFF_DROPPABLE_ID, PAUSED_RAIL_DROPPABLE_ID } from "../../../shared/pipeline/dashboard";
import { ipcQuery } from "../../../query/client";
import { inboxKey, useChromeVocabulary } from "../../../query/hooks";
import { Elapsed } from "../../../shared/items/Elapsed";
import { Button, IconButton } from "../../kit";
import { KeyLink, ReferenceText } from "./references";

/**
 * What has stopped on this board: work an agent paused to ask about, and
 * work a person parked by hand (EO-44). Also where a card is dropped to
 * hold it (EO-46) and, while a drag is in flight and there is somewhere
 * to send it, beside that the target that hands it to another pipeline
 * (EO-71).
 */
export function PausedRail({
  paused,
  notes,
  resumeBlockedId,
  resumingId,
  handOff,
  onResume,
  onClose,
  onOpen,
}: {
  paused: ItemSummary[];
  /** Notes left on the way in, by item id — only for holds made on this board. */
  notes: Record<string, string>;
  /** The item whose last resume was refused because a run was in flight. */
  resumeBlockedId: string | null;
  resumingId: string | null;
  /** Offer the hand-off target: a drag is in flight and there is somewhere to send it. */
  handOff: boolean;
  onResume: (itemId: string) => void;
  onClose: () => void;
  onOpen: (itemId: string) => void;
}) {
  // Why each one stopped comes from the inbox, so the rail and the inbox
  // cannot disagree about it.
  const inbox = useQuery({
    queryKey: inboxKey,
    queryFn: () => ipcQuery("inbox:list", undefined),
  });
  const reasonFor = (itemId: string) => inbox.data?.items.find((row) => row.itemId === itemId && row.blocking);
  const { setNodeRef, isOver } = useDroppable({ id: PAUSED_RAIL_DROPPABLE_ID });
  const handOffTarget = useDroppable({ id: HAND_OFF_DROPPABLE_ID });
  const vocabulary = useChromeVocabulary();
  const anyHeld = paused.some((item) => item.heldAt !== null);

  return (
    <aside aria-label="Paused tasks" className="flex min-w-0 flex-col gap-2">
      {/* Two targets side by side rather than nested: a hold and a
          hand-off are not near-misses of each other. */}
      <div
        ref={setNodeRef}
        className={cn(
          // A board column's raised, hairline-outlined panel (BoardColumn.tsx), so the rail reads as one of them.
          "flex min-w-0 flex-col gap-2.5 rounded-[14px] border border-line bg-canvas-raised px-3.5 py-3",
          isOver && "bg-accent-subtle/40 shadow-[inset_0_0_0_1.5px_var(--color-accent)]",
        )}
      >
        <div className="flex items-center gap-2">
          <Pause size={13} className="shrink-0 text-paused" aria-hidden />
          <h2 className="text-[15px] font-semibold text-ink">Paused</h2>
          <span className="text-[12.5px] tabular-nums text-ink-subtle">{paused.length}</span>
          <IconButton label="Hide paused tasks" icon={<X size={14} />} onClick={onClose} className="-my-1 ml-auto h-7 w-7" />
        </div>
        <p className="-mt-1 text-[12px] text-ink-subtle">{anyHeld ? "Waiting for input, or held by you." : "Waiting for input."}</p>

        {paused.length > 0 ? (
          <div className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(14rem,1fr))] @4xl:grid-cols-1">
            {paused.map((item) =>
              item.heldAt === null ? (
                <RailCard key={item.id} item={item} onOpen={onOpen}>
                  <span className="block text-paused">Paused <Elapsed since={item.updatedAt} /> ago</span>
                  {(() => {
                    const reason = reasonFor(item.id);
                    if (!reason) return null;
                    return (
                      <>
                        <span className="block pt-1.5 text-ink-subtle">Reason</span>
                        {/* No display utility beside line-clamp-3: it needs its own display:-webkit-box, and `block` would win and lift the clamp (EO-692). */}
                        <span className="line-clamp-3 text-ink">
                          <ReferenceText>{reason.body}</ReferenceText>
                        </span>
                        <span className="block pt-1.5 text-ink-subtle">Blocked on</span>
                        <span className="flex items-center gap-1.5">
                          <span aria-hidden className="grid h-4 w-4 place-items-center rounded-full bg-paused/20 text-paused">
                            <UserRound size={10} />
                          </span>
                          <span className="text-ink">you — {reason.authorName} is waiting</span>
                        </span>
                      </>
                    );
                  })()}
                  {/* No Resume: a run that stopped to ask is resumed by answering, in the inbox. */}
                </RailCard>
              ) : (
                <RailCard key={item.id} item={item} held onOpen={onOpen}>
                  <span className="block text-paused">Held by you <Elapsed since={item.heldAt} /> ago</span>
                  <span className="block text-ink-muted">Staying on {item.stepName} until you resume it.</span>
                  {notes[item.id] ? (
                    <>
                      <span className="block pt-1.5 text-ink-subtle">Your note</span>
                      <span className="line-clamp-3 text-ink">
                        <ReferenceText>{notes[item.id] ?? ""}</ReferenceText>
                      </span>
                    </>
                  ) : null}
                  {resumeBlockedId === item.id ? (
                    <span role="status" className="block pt-1.5 text-paused">
                      A run is in flight on this {vocabulary.item.toLowerCase()}, so the hold stayed. Try again once it has stopped.
                    </span>
                  ) : null}
                  <span className="flex pt-2">
                    <Button
                      size="sm"
                      icon={<Play size={11} />}
                      aria-label={`Resume ${item.key}`}
                      onClick={() => onResume(item.id)}
                      disabled={resumingId === item.id}
                      className="pointer-events-auto"
                    >
                      {resumingId === item.id ? "Resuming…" : "Resume"}
                    </Button>
                  </span>
                </RailCard>
              ),
            )}
          </div>
        ) : (
          // Only ever seen mid-drag: it has to read as somewhere a card can land.
          <p
            className={cn(
              "rounded-[10px] border border-dashed px-2 py-5 text-center text-[12px]",
              isOver ? "border-accent text-accent-soft" : "border-line text-ink-subtle",
            )}
          >
            Drop a task here to hold it
          </p>
        )}

        <Link to="/inbox" className="flex items-center gap-1.5 self-start rounded-[8px] text-[12px] text-ink-muted hover:text-ink">
          View all paused tasks
          <ArrowRight size={12} aria-hidden />
        </Link>
      </div>

      {handOff ? (
        <section ref={handOffTarget.setNodeRef} aria-label="Send to another pipeline" className="rounded-[14px] border border-line bg-canvas-raised p-2.5">
          <p
            className={cn(
              "rounded-[10px] border border-dashed px-2 py-5 text-center text-[12px]",
              handOffTarget.isOver ? "border-accent text-accent-soft" : "border-line text-ink-subtle",
            )}
          >
            Drop a task here to send it to another pipeline
          </p>
        </section>
      ) : null}
    </aside>
  );
}

/**
 * One card in the rail. The card opens its item; everything inside it is
 * inert except what asks not to be — the key and, on a held card, Resume.
 */
function RailCard({ item, held = false, onOpen, children }: { item: ItemSummary; held?: boolean; onOpen: (itemId: string) => void; children: ReactNode }) {
  const { branch } = item.git;
  return (
    <article
      className={cn(
        // A board card's surface (BoardCard.tsx), one step up from the raised panel.
        "relative rounded-[10px] border border-line bg-canvas-hover px-[9px] py-2 text-[11.5px] hover:bg-canvas-active",
        // A hold is yours, an agent's pause is not: the leading rule says which at a glance.
        held && "border-l-2 border-l-paused",
      )}
    >
      <button
        type="button"
        aria-label={`Open ${item.key}: ${item.title}`}
        onClick={() => onOpen(item.id)}
        className="absolute inset-0 rounded-[10px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
      />
      <div className="pointer-events-none relative z-10 flex min-w-0 flex-col gap-0.5">
        <span className="flex items-center gap-2 text-[11px] text-ink-subtle">
          <KeyLink itemKey={item.key} itemId={item.id} />
          {held ? (
            <span className="ml-auto flex items-center gap-1 text-paused">
              <Hand size={10} aria-hidden />
              Held
            </span>
          ) : (
            <Pause size={11} className="ml-auto text-paused" aria-hidden />
          )}
        </span>
        <h3 className="text-[13.5px] font-medium leading-snug text-ink">{item.title}</h3>
        {branch ? <span className="block truncate font-mono text-[10.5px] text-ink-subtle">{branch}</span> : null}
        <div className="pt-1">{children}</div>
      </div>
    </article>
  );
}
