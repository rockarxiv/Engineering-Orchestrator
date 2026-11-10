import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { LoaderCircle } from "lucide-react";
import type { DiscussionView, InboxItem, PipelineStepView, StepDecision } from "@eo/core";
import { cn } from "@eo/ui";
import { ActAsAdmin } from "./admin/ActAsAdmin";
import { ReadOnlyFence } from "./admin/ReadOnlyFence";
import { useItemAuthority } from "../shared/admin/authority";
import { assistRoomKey } from "../shared/assist/useAssistRoom";
import { ipcQuery } from "../query/client";
import { inboxKey, useDecideItem } from "../query/hooks";
import { useInvalidateOnPush } from "../query/useInvalidateOnPush";
import { HolderGate } from "./HolderGate";

/**
 * Pieces every column of the chat layout draws the same way.
 *
 * The layout is the one in ARCHITECTURE.md, "The chat-centric layout".
 * It is built from the design system's tokens, so that it is that
 * layout as drawn rather than the classic screens rearranged (those went
 * with EO-529).
 */

/**
 * The darker ground the rails and the canvas sit on, one step below the
 * window's canvas so the conversation reads as the lit middle.
 *
 * The theme's `--chat-deep` — each preset's own sidebar colour — and,
 * without one, mixed from `--color-canvas`. A variable of this layout's
 * rather than a design-system token, because it was made while the layout
 * was a preview, when a token would have changed the design system ahead
 * of the layout being kept.
 */
export const DEEP = "bg-[color:var(--chat-deep,color-mix(in_oklab,var(--color-canvas),black_22%))]";

export { GroupLabel } from "./kit";

/** A count that is waiting on somebody: the paused scale, never the accent. Read out as its label. */
export function WaitingCount({ count, label }: { count: number; label: string }) {
  return (
    <span className="grid h-4 min-w-4 place-items-center rounded-[5px] bg-paused px-1 text-[10.5px] font-bold tabular-nums text-canvas">
      <span aria-hidden>{count}</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

/**
 * What is waiting on you, as the inbox says — less the assistant's own
 * thread.
 *
 * The assistant's room is an item like any other, so a turn of it that
 * stops asks for a reply in the inbox. In the chat layout that thread is
 * the conversation on screen, and listing it as something waiting on you
 * is telling somebody to answer the box they are looking at. The room is
 * read from the cache the conversation column fills (`assistRoomKey`),
 * never fetched here: opening the room creates it, and only the column
 * decides to.
 */
export function useWaitingOnYou(): { rows: InboxItem[]; blocking: number; messages: number } {
  const inbox = useQuery({ queryKey: inboxKey, queryFn: () => ipcQuery("inbox:list", undefined) });
  // Shared with the inbox's own listener (EO-560): however many of these
  // are on screen, a push asks `inbox:list` once.
  useInvalidateOnPush("items:changed", inboxKey);
  useInvalidateOnPush("messages:changed", inboxKey);
  const room = useQuery<{ conversation: DiscussionView }>({ queryKey: assistRoomKey, enabled: false });
  const threadId = room.data?.conversation.id ?? null;
  return useMemo(() => {
    const rows = (inbox.data?.items ?? []).filter((row) => row.itemId !== threadId);
    // EO's open messages to you (EO-725): each one is waiting on you to
    // answer or act, as a parked run is.
    return { rows, blocking: rows.filter((row) => row.blocking).length, messages: inbox.data?.messages?.length ?? 0 };
  }, [inbox.data, threadId]);
}

/** "an item", "an invoice", "a report": the word a project uses, with the article English gives it. */
export function withArticle(word: string): string {
  return `${/^[aeiou]/i.test(word) ? "an" : "a"} ${word}`;
}

/** The same at the start of a sentence: "An invoice", "A report". */
export function withArticleCapital(word: string): string {
  return `${/^[aeiou]/i.test(word) ? "An" : "A"} ${word}`;
}

/**
 * Who holds a step: an agent role, you, a module, or EO itself.
 *
 * Read off the step's own `type` and `ownerRole`, which is the whole of
 * what makes a step whose it is — so a step on a pipeline somebody drew
 * yesterday is labelled exactly as one from a template.
 */
export function ownerOf(step: Pick<PipelineStepView, "type" | "ownerRole" | "entryAction">): { kind: PipelineStepView["type"]; label: string } {
  switch (step.type) {
    case "agent":
      return { kind: "agent", label: step.ownerRole ?? "agent" };
    case "user":
      return { kind: "user", label: "you" };
    case "module":
      return { kind: "module", label: step.entryAction ?? "module" };
    default:
      return { kind: "builtin", label: step.entryAction ?? "EO" };
  }
}

/**
 * The step's results, as buttons, wherever an item asks for a decision.
 *
 * The same `items:decide` the item page's bar calls, with the labels the
 * main process resolved ("Approve → Filed"), so a button can never promise
 * a column the decision does not land in. A result that needs a reason
 * opens a box for it first, because that reason is how "the Q3 number is
 * wrong" reaches the step the item is sent back to.
 *
 * `adminControl={false}` where the view around the buttons already draws
 * the "Act as admin" control for the same item — the item page — so an
 * admin is offered it once, not twice.
 *
 * A pressed result says it is on its way (EO-562): every button waits and
 * the one pressed spins, until the decision has landed and — where
 * `onDecided` returns one — the page has been read again. The reason box
 * stays open with what was typed until the decision is taken, so a
 * refusal is said beside the words it refused rather than after them.
 */
export function DecisionButtons({
  itemId,
  decision,
  onDecided,
  adminControl = true,
}: {
  itemId: string;
  decision: StepDecision[];
  adminControl?: boolean;
  /** Awaited, so the buttons stay pending until what it reads again has landed. */
  onDecided?: () => unknown;
}) {
  const decide = useDecideItem();
  // Read-only until an admin looking into another team's work says
  // otherwise (EO-326, ARCHITECTURE.md, "Identity"), exactly as on the item page: the same fence
  // and the same "Act as admin" control, so no surface decides on work the
  // person has not taken on.
  const { readOnly } = useItemAuthority(itemId);
  const [asking, setAsking] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  // The result on its way. The ref is the guard: TanStack draws `isPending`
  // a macrotask late, and a double press lands inside that gap.
  const [deciding, setDeciding] = useState<string | null>(null);
  const inFlight = useRef(false);
  if (decision.length === 0) return null;
  const open = decision.find((result) => result.key === asking) ?? null;
  const pending = deciding !== null;

  const run = async (resultKey: string, comment: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setDeciding(resultKey);
    setProblem(null);
    try {
      const result = await decide.mutateAsync({ itemId, resultKey, comment });
      if (!result.decided) {
        // Refused: the box and what was typed in it stay where they are.
        setProblem(result.problem ?? "That could not be decided.");
        return;
      }
      setAsking(null);
      setReason("");
      await onDecided?.();
    } catch (error: unknown) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      inFlight.current = false;
      setDeciding(null);
    }
  };

  const spinner = (resultKey: string) => (deciding === resultKey ? <LoaderCircle size={12} aria-hidden className="mr-1.5 animate-spin" /> : null);

  const label = (result: StepDecision) => (result.targetName === null ? result.label : `${result.label} → ${result.targetName}`);

  return (
    <div className="flex flex-col gap-2">
      {adminControl ? <ActAsAdmin itemId={itemId} /> : null}
      {/* On a step that waits on a group, the holder's alone (EO-368). */}
      <HolderGate itemId={itemId}>
      <ReadOnlyFence readOnly={readOnly}>
      <div className="flex flex-wrap items-center gap-2">
        {decision.map((result, index) => (
          <button
            key={result.key}
            type="button"
            disabled={pending}
            aria-busy={deciding === result.key && open === null}
            onClick={() => {
              if (result.requiresComment) {
                setAsking(result.key === asking ? null : result.key);
                setReason("");
                return;
              }
              setAsking(null);
              void run(result.key, "");
            }}
            className={cn(
              "inline-flex h-[26px] items-center rounded-[10px] px-2.5 text-xs font-medium disabled:opacity-50",
              index === 0 && result.tone === "success"
                ? "bg-accent text-accent-ink hover:bg-accent-hover"
                : result.tone === "danger"
                  ? "bg-danger/15 text-danger hover:bg-danger/25"
                  : "bg-canvas-raised text-ink hover:bg-canvas-hover",
            )}
          >
            {open === null ? spinner(result.key) : null}
            {label(result)}
          </button>
        ))}
      </div>
      {open ? (
        <div className="flex flex-col gap-2">
          <textarea
            aria-label={`Why ${open.label}`}
            placeholder="Why — this goes on the thread, in front of whoever picks it up next."
            value={reason}
            readOnly={pending}
            onChange={(event) => setReason(event.target.value)}
            className="min-h-16 rounded-[10px] bg-canvas p-2 text-sm text-ink placeholder:text-ink-subtle"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={pending || reason.trim() === ""}
              aria-busy={deciding === open.key}
              onClick={() => void run(open.key, reason)}
              className={cn(
                "inline-flex h-[26px] items-center rounded-[10px] px-2.5 text-xs font-medium disabled:opacity-50",
                // Confirming a dangerous result looks like the danger it is, as the item page's bar drew it.
                open.tone === "danger" ? "bg-danger/15 text-danger hover:bg-danger/25" : "bg-accent text-accent-ink hover:bg-accent-hover",
              )}
            >
              {spinner(open.key)}
              {label(open)}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => setAsking(null)}
              className="h-[26px] rounded-[10px] px-2 text-xs text-ink-muted hover:bg-canvas-raised disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      </ReadOnlyFence>
      </HolderGate>
      {problem ? <p className="text-xs text-danger">{problem}</p> : null}
    </div>
  );
}
